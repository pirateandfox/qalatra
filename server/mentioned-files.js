import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

const MAX_AUTO_ATTACH_BYTES = 50 * 1024 * 1024

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
        return {
          localPath: fs.realpathSync(p),
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
