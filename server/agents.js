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
    } catch {
      return
    }

    if (entries.some(e => e.isFile() && e.name === 'agent.config')) {
      try {
        const configPath = path.join(dir, 'agent.config')
        const configText = await fs.promises.readFile(configPath, 'utf8')
        const cfg = JSON.parse(configText)
        const rel = path.relative(root, dir)
        const agent = {
          path: dir,
          name: cfg.name || path.basename(dir),
          context: cfg.context || null,
          project: cfg.project || null,
          description: cfg.description || null,
          command: cfg.command || null,
          coding: !!cfg.coding,
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
        results.push(agent)
      } catch {}
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      if (exclude.has(entry.name)) continue
      const child = path.join(dir, entry.name)
      await walk(child, topFolder ?? entry.name)
    }
  }

  await walk(root, null)
  return results
}
