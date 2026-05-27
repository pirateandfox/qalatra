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
  upsertScannedAgents,
  upsertScannedCapabilities,
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
  upsertScannedAgents(db, agents);
  upsertScannedCapabilities(db, agents);
  return {
    ok: true,
    root,
    count: agents.length,
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
    description: 'List registered Qalatra capabilities derived from local agent folders and capability metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Optional context slug filter' },
        project: { type: 'string', description: 'Optional project filter' },
        kind:    { type: 'string', description: 'agent | skill | workflow | knowledge | external_tool' },
        active:  { type: 'boolean', description: 'Filter active/inactive capabilities. Omit to include both.' },
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
    description: 'Search capability name, description, aliases, triggers, context, project, and folder path.',
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
    description: 'Scan the configured agents root for agent.config files and refresh the capability registry. Existing agent.config files remain valid.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Optional override root to scan. Defaults to Qalatra agentsRoot/terminalCwd/home.' },
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
