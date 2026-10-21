import fs from 'fs'
import path from 'path'
import { buildCapabilityFromAgentConfig } from './capability-registry.js'

export async function scanAgents(root, excludeFolders = []) {
  const results = []
  const exclude = new Set(excludeFolders)

  async function walk(dir, topFolder = null) {
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (err) {
      // ENOENT is a directory removed mid-scan (or an agents root that doesn't exist yet); anything
      // else (EACCES, ELOOP, ...) silently dropped every agent beneath it from the registry.
      if (err?.code !== 'ENOENT') console.error(`[agents] could not read directory ${dir}: ${err.message} — agents under it are skipped`)
      return
    }

    if (entries.some(e => e.isFile() && e.name === 'agent.config')) {
      const agent = await loadAgentFolder(dir, root, topFolder)
      if (agent) results.push(agent)
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // .qalatra-worktrees holds per-task checkouts of a repo whose agent folders are already
      // registered from the main tree; scanning them would register every task's copy as an agent.
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.qalatra-worktrees') continue
      if (exclude.has(entry.name)) continue
      const child = path.join(dir, entry.name)
      await walk(child, topFolder ?? entry.name)
    }
  }

  await walk(root, null)
  return results
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
