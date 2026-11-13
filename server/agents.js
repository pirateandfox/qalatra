import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildCapabilityFromAgentConfig } from './capability-registry.js'

// The scan root is the first of these that is set. There is deliberately no fallback: an install
// with none of them used to walk the whole home folder, including ~/Library/CloudStorage, where a
// streaming Google Drive mount downloads every package the walk touches, and the agents request
// never returned. No root means no scan.
const ROOT_SETTINGS = ['agentsRoot', 'workspaceRoot', 'terminalCwd']

export function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return os.homedir()
  return p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p
}

/** `{ root, setting }` for the agent scan, or null when no root setting is configured. */
export function resolveAgentsRoot(settings = {}) {
  for (const setting of ROOT_SETTINGS) {
    const value = typeof settings?.[setting] === 'string' ? settings[setting].trim() : ''
    if (value) return { root: path.resolve(expandHome(value)), setting }
  }
  return null
}

export function agentExcludeFolders(settings = {}) {
  return (settings?.agentExcludeFolders ?? '').split(',').map(f => f.trim()).filter(Boolean)
}

// Agent folders are at most six levels below the workspace on every fleet box and the Mac
// (project/agents/type/... ); ten leaves room without walking unbounded trees.
export const SCAN_LIMITS = Object.freeze({ maxDepth: 10, maxDirs: 50_000, timeBudgetMs: 60_000, readdirTimeoutMs: 10_000 })

// Never entered, whatever the root. Dot-folders are skipped separately: none of the fleet's or the
// Mac's agents live in one, and the ones that hold agent.config files are tool worktrees
// (.claude/worktrees) whose copies must not register as agents.
const SKIP_NAMES = new Set(['node_modules', 'dist', '.qalatra-worktrees', 'CloudStorage', 'Mobile Documents', '$RECYCLE.BIN', 'System Volume Information'])
// Mounts and pseudo-filesystems, skipped when reached from a root above them.
const SKIP_ABSOLUTE = new Set(['/Volumes', '/proc', '/sys', '/dev', '/System', '/private', '/Library', '/net', '/Network', '/mnt', '/media', '/run', '/snap'])
// macOS packages look like folders but are documents or apps; an agent never lives inside one, and
// on a streaming cloud mount reading one downloads all of it.
const PACKAGE_EXT = /\.(app|bundle|framework|plugin|kext|appex|logicx|band|photoslibrary|photolibrary|musiclibrary|tvlibrary|aplibrary|fcpbundle|imovielibrary|rcproject|scriv|scrivx|pages|numbers|key|xcarchive|xcodeproj|xcworkspace|xcassets|lrdata|sparsebundle|bundles)$/i
const HOME_PARENTS = new Set(['/Users', '/home'])

function isHomeFolder(dir) {
  return dir === os.homedir() || HOME_PARENTS.has(path.dirname(dir))
}

/** Whether the scan steps into `name` inside `dir`. Exported for tests. */
export function shouldEnter(dir, name, exclude = new Set()) {
  if (name.startsWith('.')) return false
  if (SKIP_NAMES.has(name) || exclude.has(name)) return false
  if (PACKAGE_EXT.test(name)) return false
  if (name === 'Library' && isHomeFolder(dir)) return false
  if (SKIP_ABSOLUTE.has(path.join(dir, name))) return false
  return true
}

function readdirWithin(dir, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`no answer after ${ms / 1000}s`), { code: 'ETIMEDOUT' })), ms)
  })
  return Promise.race([fs.promises.readdir(dir, { withFileTypes: true }), timeout]).finally(() => clearTimeout(timer))
}

/**
 * Walk `root` for agent.config folders. `truncated` names the limit that stopped the walk early
 * ('dirs', 'time' or 'readdir'); a truncated result must not be used to prune the registry,
 * because folders past the stopping point were never looked at. Symlinked folders are not
 * followed (a Dirent for a symlink is not a directory).
 */
export async function scanAgentTree(root, excludeFolders = [], limits = {}) {
  const { maxDepth, maxDirs, timeBudgetMs, readdirTimeoutMs } = { ...SCAN_LIMITS, ...limits }
  const results = []
  const exclude = new Set(excludeFolders)
  const deadline = Date.now() + timeBudgetMs
  let visited = 0
  let tooDeep = 0
  let truncated = null

  async function walk(dir, depth, topFolder = null) {
    if (truncated) return
    if (visited >= maxDirs) { truncated = 'dirs'; return }
    if (Date.now() > deadline) { truncated = 'time'; return }
    visited++
    let entries
    try {
      entries = await readdirWithin(dir, readdirTimeoutMs)
    } catch (err) {
      // ENOENT is a directory removed mid-scan (or an agents root that doesn't exist yet); anything
      // else (EACCES, ELOOP, ...) silently dropped every agent beneath it from the registry.
      if (err?.code === 'ETIMEDOUT') truncated = 'readdir'
      if (err?.code !== 'ENOENT') console.error(`[agents] could not read directory ${dir}: ${err.message} — agents under it are skipped`)
      return
    }

    if (entries.some(e => e.isFile() && e.name === 'agent.config')) {
      const agent = await loadAgentFolder(dir, root, topFolder)
      if (agent) results.push(agent)
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!shouldEnter(dir, entry.name, exclude)) continue
      if (depth >= maxDepth) { tooDeep++; continue }
      await walk(path.join(dir, entry.name), depth + 1, topFolder ?? entry.name)
      if (truncated) return
    }
  }

  await walk(root, 0, null)
  if (truncated) {
    const why = { dirs: `visited ${maxDirs} folders`, time: `ran past ${timeBudgetMs / 1000}s`, readdir: 'a folder did not answer' }[truncated]
    console.warn(`[agents] scan of ${root} stopped early (${why}); ${results.length} agent(s) found so far, and nothing was pruned. Set "Agents scan root" to the folder that holds your projects.`)
  }
  if (tooDeep) console.warn(`[agents] scan of ${root} did not enter ${tooDeep} folder(s) more than ${maxDepth} levels deep`)
  return { agents: results, truncated, visited }
}

export async function scanAgents(root, excludeFolders = [], limits = {}) {
  return (await scanAgentTree(root, excludeFolders, limits)).agents
}

// One agent folder's registry entry from its agent.config, or null when it cannot be loaded.
async function loadAgentFolder(dir, root, topFolder) {
  const configPath = path.join(dir, 'agent.config')
  try {
    const configText = await fs.promises.readFile(configPath, 'utf8')
    const cfg = JSON.parse(configText)
    const rel = path.relative(root, dir)
    const agent = {
      path: dir,
      name: cfg.name || path.basename(dir),
      context: cfg.context || null,
      project: cfg.project || null,
      description: cfg.description || null,
      command: Array.isArray(cfg.command) ? JSON.stringify(cfg.command) : (cfg.command || null),
      coding: !!cfg.coding,
      concurrencyKey: typeof cfg.concurrency_key === 'string' && cfg.concurrency_key.trim() ? cfg.concurrency_key.trim() : null,
      worktrees: cfg.worktrees === true,
      relativePath: rel,
      folder: topFolder,
    }
    agent.capability = buildCapabilityFromAgentConfig({
      agentDir: dir,
      config: cfg,
      configText,
      root,
      relativePath: rel,
      folder: topFolder,
    })
    return agent
  } catch (err) {
    // A scan lists the file a moment before reading it, so ENOENT only means it was removed in
    // between (or, for readAgentFolders, that the folder has none). Invalid JSON or an unreadable
    // file used to drop the agent from the registry without a trace.
    if (err?.code !== 'ENOENT') console.error(`[agents] skipping agent at ${dir}: could not load ${configPath}: ${err.message}`)
    return null
  }
}

/**
 * Registry entries for specific folders under `root`, without walking the tree. Job admission uses
 * this to re-read the agent.config of folders with queued jobs, so `worktrees` and
 * `concurrency_key` reflect the file on disk rather than the last full scan. Folders outside `root`
 * are skipped: a full scan would not register them either.
 */
export async function readAgentFolders(root, dirs) {
  const results = []
  for (const dir of new Set(dirs)) {
    const rel = path.relative(root, dir)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    const agent = await loadAgentFolder(dir, root, rel ? rel.split(path.sep)[0] : null)
    if (agent) results.push(agent)
  }
  return results
}
