import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

const MAX_AUTO_ATTACH_BYTES = 50 * 1024 * 1024

// Never auto-attach secret material. Notes are written by agents and the
// attachments table has bucket/key/url columns, so anything attached here may
// later leave this machine. Denylist beats allowlist: a false positive just
// means the user attaches the file manually.
const DENY_DIR_SEGMENTS = new Set([
  '.aws', '.azure', '.config', '.docker', '.gcloud', '.gnupg', '.kube',
  '.password-store', '.ssh', 'keychains',
])

const DENY_FILENAME_PATTERNS = [
  /(^|[._-])env($|[._-])/i,                       // .env, .env.local, prod.env
  /token/i,
  /secret/i,
  /credential/i,
  /passw(or)?d/i,
  /api[-_]?key/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.?(netrc|npmrc|pypirc|git-credentials|htpasswd|pgpass|authinfo)$/i,
  /_history$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|ppk)$/i,
]

function isSensitivePath(filePath) {
  const segments = filePath.split(path.sep).filter(Boolean)
  const filename = segments[segments.length - 1] ?? ''
  if (segments.slice(0, -1).some(seg => DENY_DIR_SEGMENTS.has(seg.toLowerCase()))) return true
  return DENY_FILENAME_PATTERNS.some(pattern => pattern.test(filename))
}

function looksLikePrivateKey(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(1024)
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0)
      return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/.test(buf.toString('utf8', 0, bytes))
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return true // unreadable → don't attach
  }
}

const MIME_BY_EXT = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
}

function expandHome(filePath) {
  return filePath.startsWith('~/') ? path.join(os.homedir(), filePath.slice(2)) : filePath
}

function cleanCandidate(raw) {
  if (!raw) return null
  let value = String(raw)
    .trim()
    .replace(/^file:\/\/(?:localhost)?/, '')
    .replace(/^["'`<([{]+/, '')
    .replace(/[>"'`\])}]+$/, '')

  try { value = decodeURIComponent(value) } catch {}
  if (!value || /^https?:\/\//i.test(value)) return null
  return value
}

function candidateVariants(candidate) {
  const variants = [candidate]
  const stripped = candidate.replace(/[.,;:]+$/, '')
  if (stripped !== candidate) variants.push(stripped)
  return variants
}

function resolveCandidate(candidate, baseDirs) {
  const cleaned = cleanCandidate(candidate)
  if (!cleaned) return null

  for (const variant of candidateVariants(cleaned)) {
    const expanded = expandHome(variant)
    const paths = path.isAbsolute(expanded)
      ? [expanded]
      : baseDirs.map(base => path.resolve(base, expanded))

    for (const p of paths) {
      try {
        const stat = fs.statSync(p)
        if (!stat.isFile() || stat.size > MAX_AUTO_ATTACH_BYTES) continue
        const realPath = fs.realpathSync(p)
        // Check both the mentioned path and the symlink target
        if (isSensitivePath(p) || isSensitivePath(realPath) || looksLikePrivateKey(realPath)) continue
        return {
          localPath: realPath,
          filename: path.basename(p),
          sizeBytes: stat.size,
          mimeType: MIME_BY_EXT[path.extname(p).toLowerCase()] ?? null,
        }
      } catch {}
    }
  }
  return null
}

export function extractMentionedFiles(text, baseDirs = []) {
  if (!text) return []
  const candidates = new Set()
  const normalizedBases = baseDirs.filter(Boolean).map(dir => path.resolve(expandHome(dir)))

  const patterns = [
    /!?\[[^\]\n]*\]\(([^)\n]+)\)/g,
    /file:\/\/(?:localhost)?[^\s<>"'`]+/g,
    /["'`]((?:~\/|\/|\.\.?\/|[A-Za-z0-9_.-]+\/)[^"'`\n]+)["'`]/g,
    /(?:^|[\s(:])((?:~\/|\/|\.\.?\/|[A-Za-z0-9_.-]+\/)[^\s<>"'`]+)/g,
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(text)) !== null) {
      candidates.add(match[1] ?? match[0])
    }
  }

  const byPath = new Map()
  for (const candidate of candidates) {
    const file = resolveCandidate(candidate, normalizedBases)
    if (file) byPath.set(file.localPath, file)
  }
  return [...byPath.values()]
}

export function autoAttachMentionedFiles(db, { taskId, text, baseDirs = [] }) {
  if (!taskId || !text) return []
  const files = extractMentionedFiles(text, baseDirs)
  const attached = []

  const existing = db.prepare('SELECT id FROM attachments WHERE task_id = ? AND local_path = ? LIMIT 1')
  const insert = db.prepare(`
    INSERT INTO attachments (id, task_id, filename, mimetype, size_bytes, bucket, key, url, local_path, encrypted)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0)
  `)

  for (const file of files) {
    if (existing.get(taskId, file.localPath)) continue
    const id = randomUUID()
    insert.run(id, taskId, file.filename, file.mimeType, file.sizeBytes, file.localPath)
    attached.push({ id, ...file })
  }

  return attached
}
