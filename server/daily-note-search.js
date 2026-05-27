function clampLimit(value, fallback = 20, max = 100) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

function optionalDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

function tokenizeQuery(query) {
  return String(query ?? '')
    .match(/[A-Za-z0-9_]+/g)
    ?.map(token => token.trim())
    .filter(Boolean) ?? []
}

function ftsQuery(query) {
  const terms = tokenizeQuery(query)
  if (!terms.length) return null
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' AND ')
}

function contentPreview(content, query, maxLength = 420) {
  const text = String(content ?? '').trim()
  if (text.length <= maxLength) return text

  const firstTerm = tokenizeQuery(query)[0]
  const lower = text.toLowerCase()
  const idx = firstTerm ? lower.indexOf(firstTerm.toLowerCase()) : -1
  const start = idx >= 0 ? Math.max(0, idx - Math.floor(maxLength / 3)) : 0
  const end = Math.min(text.length, start + maxLength)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  return `${prefix}${text.slice(start, end).trim()}${suffix}`
}

function normalizeResult(row, query, includeContent = false) {
  const result = {
    date: row.date,
    updated_at: row.updated_at,
    excerpt: row.excerpt || contentPreview(row.content, query),
  }
  if (row.rank !== undefined) result.rank = row.rank
  if (includeContent) result.content = row.content
  return result
}

export function ensureDailyNoteSearchSchema(db) {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS daily_notes_fts USING fts5(content);

      CREATE TRIGGER IF NOT EXISTS daily_notes_fts_insert
      AFTER INSERT ON daily_notes
      BEGIN
        INSERT INTO daily_notes_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS daily_notes_fts_delete
      AFTER DELETE ON daily_notes
      BEGIN
        DELETE FROM daily_notes_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS daily_notes_fts_update
      AFTER UPDATE ON daily_notes
      BEGIN
        DELETE FROM daily_notes_fts WHERE rowid = old.rowid;
        INSERT INTO daily_notes_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      INSERT INTO daily_notes_fts(rowid, content)
      SELECT rowid, content FROM daily_notes
      WHERE rowid NOT IN (SELECT rowid FROM daily_notes_fts);
    `)
    return true
  } catch {
    return false
  }
}

function searchDailyNotesLike(db, args = {}) {
  const query = String(args.query ?? '').trim()
  const dateFrom = optionalDate(args.date_from ?? args.from)
  const dateTo = optionalDate(args.date_to ?? args.to)
  const limit = clampLimit(args.limit)
  const includeEmpty = !!args.include_empty
  const includeContent = !!args.include_content

  const where = []
  const params = { limit }

  if (query) {
    where.push('(content LIKE @query OR date LIKE @query)')
    params.query = `%${query}%`
  }
  if (dateFrom) {
    where.push('date >= @dateFrom')
    params.dateFrom = dateFrom
  }
  if (dateTo) {
    where.push('date <= @dateTo')
    params.dateTo = dateTo
  }
  if (!includeEmpty) where.push("content != ''")

  const sql = `
    SELECT date, content, updated_at
    FROM daily_notes
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY date DESC
    LIMIT @limit
  `
  const rows = db.prepare(sql).all(params)
  return {
    query: query || null,
    count: rows.length,
    notes: rows.map(row => normalizeResult(row, query, includeContent)),
    search_mode: 'like',
  }
}

export function searchDailyNotes(db, args = {}) {
  const query = String(args.query ?? '').trim()
  const match = ftsQuery(query)
  const dateFrom = optionalDate(args.date_from ?? args.from)
  const dateTo = optionalDate(args.date_to ?? args.to)
  const limit = clampLimit(args.limit)
  const includeContent = !!args.include_content

  if (!match || !ensureDailyNoteSearchSchema(db)) return searchDailyNotesLike(db, args)

  const where = ['daily_notes_fts MATCH @match']
  const params = { match, limit }

  if (dateFrom) {
    where.push('d.date >= @dateFrom')
    params.dateFrom = dateFrom
  }
  if (dateTo) {
    where.push('d.date <= @dateTo')
    params.dateTo = dateTo
  }

  try {
    const rows = db.prepare(`
      SELECT
        d.date,
        d.content,
        d.updated_at,
        bm25(daily_notes_fts) AS rank,
        snippet(daily_notes_fts, 0, '[', ']', '...', 30) AS excerpt
      FROM daily_notes_fts
      JOIN daily_notes d ON d.rowid = daily_notes_fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY rank ASC, d.date DESC
      LIMIT @limit
    `).all(params)

    return {
      query,
      count: rows.length,
      notes: rows.map(row => normalizeResult(row, query, includeContent)),
      search_mode: 'fts',
    }
  } catch {
    return searchDailyNotesLike(db, args)
  }
}

