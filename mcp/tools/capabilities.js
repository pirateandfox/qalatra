import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb } from '../db.js';
import { scanAgents } from '../../server/agents.js';
import {
  getCapability,
  listCapabilities,
  searchCapabilities,
  syncScannedAgents,
} from '../../server/capability-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = process.env.TASKOS_SETTINGS_FILE
  ?? path.join(__dirname, '../../db/settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

async function scanAndUpsert(args = {}) {
  const settings = loadSettings();
  const excludeFolders = Array.isArray(args.exclude_folders)
    ? args.exclude_folders
    : (settings.agentExcludeFolders ?? '').split(',').map(f => f.trim()).filter(Boolean);
  const root = args.root || settings.agentsRoot || settings.terminalCwd || os.homedir();
  if (!root) return { count: 0, root: null, capabilities: [] };

  const agents = await scanAgents(root, excludeFolders);
  const db = openDb();
  // Same write path as Qalatra Server's scan (db-worker upsertAgents): one transaction, and only
  // rows under `root` are pruned, so a narrow rescan leaves the rest of the registry alone.
  const synced = syncScannedAgents(db, agents, { root });
  return {
    ok: true,
    root,
    count: agents.length,
    removed_agents: synced.removedAgents,
    deactivated_capabilities: synced.deactivatedCapabilities,
    capabilities: agents.map(agent => ({
      id: agent.capability?.id,
      name: agent.name,
      path: agent.path,
      context: agent.context,
      project: agent.project,
    })),
  };
}

export const toolDefs = [
  {
    name: 'list_capabilities',
    description: 'List registered Qalatra capabilities derived from local agent folders and capability metadata. A capability whose folder disappeared is kept with active=false. `active` only controls visibility in search and listing; it does not block queueing or launching a job (a launch fails anyway when the folder is gone).',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Optional context slug filter' },
        project: { type: 'string', description: 'Optional project filter' },
        kind:    { type: 'string', description: 'agent | skill | workflow | knowledge | external_tool' },
        active:  { type: 'boolean', description: 'Filter active/inactive capabilities. Omit to include both. Inactive = agent.config declares active:false, or the folder is gone.' },
      },
    },
  },
  {
    name: 'get_capability',
    description: 'Get one capability by registry id or absolute folder path, including files, permissions, and delegation target.',
    inputSchema: {
      type: 'object',
      properties: {
        id:   { type: 'string', description: 'Capability id' },
        path: { type: 'string', description: 'Absolute path to the capability/agent folder' },
      },
    },
  },
  {
    name: 'search_capabilities',
    description: 'Search capability name, description, aliases, triggers, context, project, and folder path. Returns active capabilities only. `active` only controls visibility in search and listing; it does not block queueing or launching a job (a launch fails anyway when the folder is gone).',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Search text, e.g. "file this invoice" or "triage this request"' },
        context: { type: 'string', description: 'Optional context slug filter' },
        project: { type: 'string', description: 'Optional project filter' },
        kind:    { type: 'string', description: 'Optional capability kind filter' },
        limit:   { type: 'integer', description: 'Default 20, max 100' },
      },
      required: ['query'],
    },
  },
  {
    name: 'rescan_capabilities',
    description: 'Scan the configured agents root for agent.config files and refresh the capability registry. Existing agent.config files remain valid. Folders under the scanned root whose agent.config is gone have their agents row removed and their capability set inactive (reactivated when the folder returns); rows outside the root are untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Optional override root to scan. Defaults to Qalatra agentsRoot/terminalCwd/home. Only rows under this root are pruned.' },
        exclude_folders: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional folder names to skip during scan.',
        },
      },
    },
  },
];

export const handlers = {
  list_capabilities(args) {
    const db = openDb();
    return { capabilities: listCapabilities(db, args ?? {}) };
  },

  get_capability(args) {
    if (!args.id && !args.path) throw new Error('id or path required');
    const db = openDb();
    const capability = getCapability(db, { id: args.id, path: args.path });
    if (!capability) throw new Error('Capability not found');
    return capability;
  },

  search_capabilities(args) {
    const db = openDb();
    return { capabilities: searchCapabilities(db, args ?? {}) };
  },

  async rescan_capabilities(args) {
    return scanAndUpsert(args ?? {});
  },
};
