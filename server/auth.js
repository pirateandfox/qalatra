import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

const TOKEN_PREFIX = 'qalatra_'

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createSecret() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`
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
      revoked_at   TEXT
    )
  `)
  return db
}

export function ensureBootstrapToken(authDb, dataDir, { forceFile = false } = {}) {
  const tokenPath = path.join(dataDir, 'admin-token.txt')
  if (forceFile && fs.existsSync(tokenPath)) return null

  const active = authDb.prepare(`
    SELECT COUNT(*) as c FROM auth_tokens
    WHERE revoked_at IS NULL AND scopes LIKE '%full_access%'
  `).get()
  if (active.c > 0 && !forceFile) return null

  const token = createSecret()
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
    WHERE token_hash = ? AND revoked_at IS NULL
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
    SELECT id, label, scopes, created_at, last_used_at, revoked_at
    FROM auth_tokens
    ORDER BY created_at DESC
  `).all()
}

export function createToken(authDb, { label, scopes }) {
  const normalizedScopes = Array.isArray(scopes) ? scopes.join(',') : String(scopes || 'read_only')
  const token = createSecret()
  const id = crypto.randomUUID()
  authDb.prepare(`
    INSERT INTO auth_tokens (id, label, token_hash, scopes)
    VALUES (?, ?, ?, ?)
  `).run(id, label || 'Token', hashToken(token), normalizedScopes)
  return { id, token, label: label || 'Token', scopes: normalizedScopes }
}

export function revokeToken(authDb, id) {
  authDb.prepare(`UPDATE auth_tokens SET revoked_at = datetime('now') WHERE id = ?`).run(id)
  return { ok: true }
}
