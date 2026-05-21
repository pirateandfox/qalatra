import fs from 'fs'
import os from 'os'
import path from 'path'

function expandHome(p) {
  if (!p) return p
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

function configuredRoots(settings = {}) {
  const roots = []
  const configured = (settings.fileRoots ?? '').split(',').map(r => r.trim()).filter(Boolean)
  roots.push(...configured)
  if (settings.agentsRoot) roots.push(settings.agentsRoot)
  if (settings.terminalCwd) roots.push(settings.terminalCwd)
  if (settings.attachmentCacheDir) roots.push(settings.attachmentCacheDir)
  roots.push(path.join(os.homedir(), 'IdeaProjects'))
  return [...new Set(roots.map(expandHome).filter(Boolean).map(r => path.resolve(r)))]
}

function assertAllowed(filePath, settings = {}) {
  const resolved = path.resolve(expandHome(filePath))
  const roots = configuredRoots(settings)
  const allowed = roots.some(root => resolved === root || resolved.startsWith(root + path.sep))
  if (!allowed) throw new Error(`Forbidden path: ${resolved}`)
  return resolved
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

export function resolveAllowedPath(filePath, settings) {
  return assertAllowed(filePath, settings)
}

export function mimeTypeForPath(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

export function fileExists(filePath, settings) {
  const resolved = assertAllowed(filePath, settings)
  return fs.existsSync(resolved)
}

export function readTextFile(filePath, settings) {
  const resolved = assertAllowed(filePath, settings)
  return fs.readFileSync(resolved, 'utf8')
}

export function writeTextFile(filePath, contents, settings) {
  if (typeof contents !== 'string') throw new Error('contents must be string')
  const resolved = assertAllowed(filePath, settings)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, contents, 'utf8')
  return { ok: true }
}

export function findInheritedStyle(startDir, settings) {
  const home = os.homedir()
  let dir = assertAllowed(startDir, settings)
  while (true) {
    const candidate = path.join(dir, '.md-style.json')
    if (fs.existsSync(candidate)) {
      try {
        assertAllowed(candidate, settings)
        return { foundPath: candidate, content: fs.readFileSync(candidate, 'utf8') }
      } catch {}
    }
    const parent = path.dirname(dir)
    if (parent === dir || dir === home) break
    dir = parent
  }
  const userDefault = path.join(home, '.md-style.json')
  if (fs.existsSync(userDefault)) {
    try { return { foundPath: userDefault, content: fs.readFileSync(userDefault, 'utf8') } } catch {}
  }
  return null
}

export function writeUserStyle(contents) {
  if (typeof contents !== 'string') throw new Error('contents must be string')
  fs.writeFileSync(path.join(os.homedir(), '.md-style.json'), contents, 'utf8')
  return { ok: true }
}

export function writeFolderStyle(dir, contents, settings) {
  if (typeof contents !== 'string') throw new Error('contents must be string')
  const resolved = assertAllowed(dir, settings)
  fs.writeFileSync(path.join(resolved, '.md-style.json'), contents, 'utf8')
  return { ok: true }
}
