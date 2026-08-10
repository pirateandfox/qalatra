import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

const TOKEN_PREFIX = 'qalatra_'
const MAX_TOKEN_TTL_DAYS = 3660

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createSecret() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`
}

function normalizeDateTime(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function tokenExpiry(input = {}) {
  if (input.expiresAt) {
    const expiresAt = new Date(input.expiresAt)
    if (Number.isNaN(expiresAt.getTime())) throw new Error('Invalid token expiration date')
    return normalizeDateTime(expiresAt)
  }

  const rawDays = input.expiresInDays ?? input.expires_in_days
  if (rawDays === undefined || rawDays === null || rawDays === '') return null

  const days = Number(rawDays)
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_TTL_DAYS) {
    throw new Error(`Token expiration must be between 1 and ${MAX_TOKEN_TTL_DAYS} days`)
  }

  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  return normalizeDateTime(expiresAt)
}

function migrateAuth(db) {
  try { db.exec(`ALTER TABLE auth_tokens ADD COLUMN expires_at TEXT`) } catch {}
}

export function initAuth(dbPath) {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id           TEXT PRIMARY KEY,
      label        TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      scopes       TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at   TEXT,
      expires_at   TEXT
    )
  `)
  migrateAuth(db)
  return db
}

export function ensureBootstrapToken(authDb, dataDir, { forceFile = false, token: suppliedToken = '' } = {}) {
  const tokenPath = path.join(dataDir, 'admin-token.txt')
  if (forceFile && fs.existsSync(tokenPath)) return null

  const active = authDb.prepare(`
    SELECT COUNT(*) as c FROM auth_tokens
    WHERE revoked_at IS NULL
      AND scopes LIKE '%full_access%'
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get()
  if (active.c > 0 && !forceFile) return null

  const token = suppliedToken || createSecret()
  if (!/^qalatra_[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error('QALATRA_BOOTSTRAP_TOKEN must be a qalatra_ prefixed URL-safe secret')
  }
  const id = crypto.randomUUID()
  authDb.prepare(`
    INSERT INTO auth_tokens (id, label, token_hash, scopes)
    VALUES (?, ?, ?, ?)
  `).run(id, 'Initial admin token', hashToken(token), 'full_access')

  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
  return { token, tokenPath }
}

export function authenticate(authDb, req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null
  const row = authDb.prepare(`
    SELECT * FROM auth_tokens
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(hashToken(token))
  if (!row) return null
  authDb.prepare(`UPDATE auth_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id)
  return { id: row.id, label: row.label, scopes: row.scopes.split(',').map(s => s.trim()).filter(Boolean) }
}

export function requireScope(user, scope) {
  return !!user?.scopes?.includes('full_access') || !!user?.scopes?.includes(scope)
}

export function listTokens(authDb) {
  return authDb.prepare(`
    SELECT id, label, scopes, created_at, last_used_at, revoked_at, expires_at
    FROM auth_tokens
    ORDER BY created_at DESC
  `).all()
}

export function createToken(authDb, { label, scopes, expiresAt, expiresInDays, expires_in_days }) {
  const normalizedScopes = Array.isArray(scopes) ? scopes.join(',') : String(scopes || 'read_only')
  const token = createSecret()
  const id = crypto.randomUUID()
  const expires_at = tokenExpiry({ expiresAt, expiresInDays, expires_in_days })
  authDb.prepare(`
    INSERT INTO auth_tokens (id, label, token_hash, scopes, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, label || 'Token', hashToken(token), normalizedScopes, expires_at)
  return { id, token, label: label || 'Token', scopes: normalizedScopes, expires_at }
}

export function revokeToken(authDb, id) {
  authDb.prepare(`UPDATE auth_tokens SET revoked_at = datetime('now') WHERE id = ?`).run(id)
  return { ok: true }
}
