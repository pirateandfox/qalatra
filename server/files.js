import fs from 'fs'
import os from 'os'
import path from 'path'

function expandHome(p) {
  if (!p) return p
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

export function configuredRoots(settings = {}) {
  const roots = []
  const configured = (settings.fileRoots ?? '').split(',').map(r => r.trim()).filter(Boolean)
  roots.push(...configured)
  if (settings.workspaceRoot) roots.push(settings.workspaceRoot)
  if (settings.agentsRoot) roots.push(settings.agentsRoot)
  if (settings.terminalCwd) roots.push(settings.terminalCwd)
  if (settings.attachmentCacheDir) roots.push(settings.attachmentCacheDir)
  roots.push(path.join(os.homedir(), 'workspaces'))
  roots.push(path.join(os.homedir(), 'IdeaProjects'))
  return [...new Set(roots.map(expandHome).filter(Boolean).map(r => path.resolve(r)))]
}

// A stored link is read on more than one machine: the laptop keeps projects under ~/IdeaProjects,
// a fleet box under ~/workspaces. Links written against either root are translated to this
// install's roots when the path as written does not exist here.
const FOREIGN_ROOT = /^(?:\/Users\/[^/]+|\/home\/[^/]+)\/(?:IdeaProjects|workspaces)\/(.+)$/

// workspaceRoot first, so a relative link resolves against it when the file exists in several roots.
function linkRoots(settings) {
  const primary = settings.workspaceRoot ? [path.resolve(expandHome(settings.workspaceRoot))] : []
  return [...new Set([...primary, ...configuredRoots(settings)])]
}

// Relative links (projects/shi/desk.md) resolve against the workspace roots; an absolute link that
// does not exist here is retried under each root by its path below the other machine's root. The
// first candidate that exists wins; otherwise a relative link lands in the primary root (so a new
// file can be written there) and an absolute one is left as written.
function resolveLinkPath(filePath, settings) {
  const expanded = expandHome(filePath)
  let rest = null
  if (!path.isAbsolute(expanded)) rest = expanded
  else if (!fs.existsSync(expanded)) rest = FOREIGN_ROOT.exec(expanded)?.[1] ?? null
  if (rest === null) return path.resolve(expanded)
  const candidates = linkRoots(settings).map(root => path.resolve(root, rest))
  return candidates.find(candidate => fs.existsSync(candidate))
    ?? (path.isAbsolute(expanded) ? path.resolve(expanded) : candidates[0] ?? path.resolve(expanded))
}

function assertAllowed(filePath, settings = {}) {
  const resolved = resolveLinkPath(filePath, settings)
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

export function listWorkspaceRoots(settings = {}) {
  const roots = configuredRoots(settings).map(root => {
    let stat = null
    try {
      stat = fs.statSync(root)
    } catch {}
    return {
      path: root,
      name: root === os.homedir() ? '~' : path.basename(root) || root,
      exists: !!stat,
      isDirectory: !!stat?.isDirectory(),
    }
  })

  return roots
    .filter(root => root.exists && root.isDirectory)
    .filter((root, index, all) => !all.some((other, otherIndex) => (
      otherIndex !== index &&
      other.exists &&
      other.isDirectory &&
      root.path.startsWith(other.path + path.sep)
    )))
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

export function listDirectory(dirPath, settings = {}) {
  const resolved = assertAllowed(dirPath, settings)
  const stat = fs.statSync(resolved)
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`)

  const entries = fs.readdirSync(resolved, { withFileTypes: true })
    .filter(entry => entry.name !== '.DS_Store')
    .map(entry => {
      const fullPath = path.join(resolved, entry.name)
      let entryStat = null
      try { entryStat = fs.lstatSync(fullPath) } catch {}
      const isSymlink = !!entryStat?.isSymbolicLink()
      const isDirectory = entry.isDirectory() && !isSymlink
      return {
        name: entry.name,
        path: fullPath,
        type: isDirectory ? 'directory' : isSymlink ? 'symlink' : 'file',
        size: entryStat?.isFile() ? entryStat.size : null,
        modifiedAt: entryStat?.mtime ? entryStat.mtime.toISOString() : null,
        extension: isDirectory ? '' : path.extname(entry.name).slice(1).toLowerCase(),
      }
    })

  entries.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1
    if (a.type !== 'directory' && b.type === 'directory') return 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  return { path: resolved, entries }
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
