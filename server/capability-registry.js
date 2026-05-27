import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const JSON_ARRAY_FIELDS = ['provider_support', 'trigger_phrases', 'aliases']
const JSON_OBJECT_FIELDS = ['permission_profile', 'metadata']
const SECRET_PATH_RE = /(^|[/\\])(\.env|.*\.(pem|key|p8)|.*(password|secret|credential|token).*)$/i

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function stableId(prefix, value) {
  return `${prefix}_${hashText(value).slice(0, 24)}`
}

function arrayValue(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(v => String(v).trim()).filter(Boolean))]
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function boolInt(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue ? 1 : 0
  return value ? 1 : 0
}

function safeJsonParse(value, fallback) {
  try { return JSON.parse(value ?? '') } catch { return fallback }
}

function normalizePath(filePath) {
  return path.normalize(filePath)
}

function fileRoleFor(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized === 'AGENTS.md' || normalized === 'CLAUDE.md') return 'instructions'
  if (normalized === 'SKILL.md') return 'adapter_skill'
  if (normalized === 'context.md') return 'project_context'
  if (normalized === 'project-details.md') return 'project_details'
  if (normalized === 'contacts.md') return 'contacts'
  if (normalized.startsWith('knowledge/')) return 'knowledge'
  return 'knowledge'
}

function defaultCapabilityFiles(agentDir) {
  const files = []
  const candidates = ['AGENTS.md', 'CLAUDE.md', 'SKILL.md', 'context.md', 'project-details.md', 'contacts.md']

  for (const rel of candidates) {
    const abs = path.join(agentDir, rel)
    if (fs.existsSync(abs) && !SECRET_PATH_RE.test(abs)) {
      files.push({
        path: abs,
        role: fileRoleFor(rel),
        readable: true,
        writable: false,
        index_for_search: true,
        include_in_bundle: rel === 'AGENTS.md' || rel === 'CLAUDE.md' || rel === 'SKILL.md',
        metadata: { relative_path: rel, inferred: true },
      })
    }
  }

  const knowledgeDir = path.join(agentDir, 'knowledge')
  try {
    const entries = fs.readdirSync(knowledgeDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!/\.(md|mdx|txt)$/i.test(entry.name)) continue
      const rel = `knowledge/${entry.name}`
      const abs = path.join(agentDir, rel)
      if (SECRET_PATH_RE.test(abs)) continue
      files.push({
        path: abs,
        role: 'knowledge',
        readable: true,
        writable: false,
        index_for_search: true,
        include_in_bundle: true,
        metadata: { relative_path: rel, inferred: true },
      })
    }
  } catch {}

  return files
}

function explicitCapabilityFiles(agentDir, capabilityBlock = {}) {
  const configured = Array.isArray(capabilityBlock.files) ? capabilityBlock.files : []
  return configured
    .filter(f => f && typeof f.path === 'string' && f.path.trim())
    .map(f => {
      const originalPath = f.path.trim()
      const abs = path.isAbsolute(originalPath)
        ? normalizePath(originalPath)
        : normalizePath(path.resolve(agentDir, originalPath))
      return {
        path: abs,
        role: f.role || fileRoleFor(originalPath),
        readable: boolInt(f.readable, true),
        writable: boolInt(f.writable, false),
        index_for_search: boolInt(f.index_for_search, true),
        include_in_bundle: boolInt(f.include_in_bundle, false),
        metadata: {
          relative_path: path.isAbsolute(originalPath) ? null : originalPath,
          configured: true,
        },
      }
    })
}

function mergeCapabilityFiles(explicitFiles, inferredFiles) {
  const byKey = new Map()
  for (const file of inferredFiles) byKey.set(`${file.path}\0${file.role}`, file)
  for (const file of explicitFiles) byKey.set(`${file.path}\0${file.role}`, file)
  return [...byKey.values()]
}

function defaultTriggers({ name, description, context, project, relativePath, folder }) {
  const pathBits = (relativePath || '')
    .split(/[\\/._-]+/)
    .map(s => s.trim())
    .filter(Boolean)
  return arrayValue([
    name,
    description,
    context,
    project,
    folder,
    relativePath,
    ...pathBits,
  ])
}

function resolveDelegationTarget(agentDir, target) {
  if (!target || target === '.') return agentDir
  return path.isAbsolute(target) ? normalizePath(target) : normalizePath(path.resolve(agentDir, target))
}

export function buildCapabilityFromAgentConfig({ agentDir, config, configText, root, relativePath, folder }) {
  const capabilityBlock = objectValue(config.capability)
  const hasCapabilityBlock = Object.keys(capabilityBlock).length > 0
  const name = config.name || path.basename(agentDir)
  const description = config.description || null
  const delegation = objectValue(capabilityBlock.delegation)
  const inferredTriggers = defaultTriggers({
    name,
    description,
    context: config.context || null,
    project: config.project || null,
    relativePath,
    folder,
  })
  const explicitTriggers = arrayValue(capabilityBlock.triggers ?? capabilityBlock.trigger_phrases)
  const files = mergeCapabilityFiles(
    explicitCapabilityFiles(agentDir, capabilityBlock),
    defaultCapabilityFiles(agentDir),
  )

  return {
    id: stableId('cap', agentDir),
    path: agentDir,
    name,
    description,
    kind: capabilityBlock.kind || 'agent',
    context: config.context || null,
    project: config.project || null,
    command: config.command || null,
    active: boolInt(capabilityBlock.active, true),
    provider_support: arrayValue(capabilityBlock.provider_support),
    trigger_phrases: hasCapabilityBlock && explicitTriggers.length ? explicitTriggers : inferredTriggers,
    aliases: arrayValue(capabilityBlock.aliases),
    delegation_mode: delegation.mode || 'qalatra_agent',
    delegation_target: resolveDelegationTarget(agentDir, delegation.target),
    permission_profile: objectValue(capabilityBlock.permissions ?? capabilityBlock.permission_profile),
    metadata: {
      source: 'agent.config',
      config_path: path.join(agentDir, 'agent.config'),
      relative_path: relativePath || null,
      folder: folder || null,
      root: root || null,
      coding: !!config.coding,
      has_capability_block: hasCapabilityBlock,
    },
    source_hash: hashText(configText || JSON.stringify(config)),
    files,
  }
}

export function ensureCapabilitySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capabilities (
      id                 TEXT PRIMARY KEY,
      path               TEXT UNIQUE,
      name               TEXT NOT NULL,
      description        TEXT,
      kind               TEXT NOT NULL DEFAULT 'agent',
      context            TEXT,
      project            TEXT,
      command            TEXT,
      active             INTEGER NOT NULL DEFAULT 1,
      provider_support   TEXT NOT NULL DEFAULT '[]',
      trigger_phrases    TEXT NOT NULL DEFAULT '[]',
      aliases            TEXT NOT NULL DEFAULT '[]',
      delegation_mode    TEXT NOT NULL DEFAULT 'none',
      delegation_target  TEXT,
      permission_profile TEXT NOT NULL DEFAULT '{}',
      metadata           TEXT NOT NULL DEFAULT '{}',
      source_hash        TEXT,
      last_seen          TEXT NOT NULL DEFAULT (datetime('now')),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS capability_files (
      id                    TEXT PRIMARY KEY,
      capability_id          TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
      path                  TEXT NOT NULL,
      role                  TEXT NOT NULL,
      readable              INTEGER NOT NULL DEFAULT 1,
      writable              INTEGER NOT NULL DEFAULT 0,
      index_for_search       INTEGER NOT NULL DEFAULT 1,
      include_in_bundle      INTEGER NOT NULL DEFAULT 0,
      metadata              TEXT NOT NULL DEFAULT '{}',
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(capability_id, path, role)
    );

    CREATE INDEX IF NOT EXISTS idx_capabilities_context ON capabilities(context);
    CREATE INDEX IF NOT EXISTS idx_capabilities_project ON capabilities(project);
    CREATE INDEX IF NOT EXISTS idx_capabilities_kind ON capabilities(kind);
    CREATE INDEX IF NOT EXISTS idx_capabilities_active ON capabilities(active);
    CREATE INDEX IF NOT EXISTS idx_capability_files_capability ON capability_files(capability_id);
  `)
}

export function ensureAgentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      path         TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      context      TEXT,
      project      TEXT,
      description  TEXT,
      command      TEXT,
      coding       INTEGER NOT NULL DEFAULT 0,
      relative_path TEXT,
      folder       TEXT,
      last_seen    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

export function upsertScannedAgents(db, agents) {
  ensureAgentSchema(db)
  const upsert = db.prepare(`
    INSERT INTO agents (path, name, context, project, description, command, coding, relative_path, folder, last_seen)
    VALUES (@path, @name, @context, @project, @description, @command, @coding, @relative_path, @folder, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name, context = excluded.context, project = excluded.project,
      description = excluded.description, command = excluded.command, coding = excluded.coding,
      relative_path = excluded.relative_path, folder = excluded.folder, last_seen = excluded.last_seen
  `)
  for (const agent of agents) {
    upsert.run({
      path: agent.path,
      name: agent.name,
      context: agent.context ?? null,
      project: agent.project ?? null,
      description: agent.description ?? null,
      command: agent.command ?? null,
      coding: agent.coding ? 1 : 0,
      relative_path: agent.relativePath ?? null,
      folder: agent.folder ?? null,
    })
  }
  return { ok: true, count: agents.length }
}

export function upsertScannedCapabilities(db, agents) {
  ensureCapabilitySchema(db)
  const upsertCapability = db.prepare(`
    INSERT INTO capabilities (
      id, path, name, description, kind, context, project, command, active,
      provider_support, trigger_phrases, aliases, delegation_mode, delegation_target,
      permission_profile, metadata, source_hash, last_seen, updated_at
    ) VALUES (
      @id, @path, @name, @description, @kind, @context, @project, @command, @active,
      @provider_support, @trigger_phrases, @aliases, @delegation_mode, @delegation_target,
      @permission_profile, @metadata, @source_hash, datetime('now'), datetime('now')
    )
    ON CONFLICT(path) DO UPDATE SET
      id = excluded.id,
      name = excluded.name,
      description = excluded.description,
      kind = excluded.kind,
      context = excluded.context,
      project = excluded.project,
      command = excluded.command,
      active = excluded.active,
      provider_support = excluded.provider_support,
      trigger_phrases = excluded.trigger_phrases,
      aliases = excluded.aliases,
      delegation_mode = excluded.delegation_mode,
      delegation_target = excluded.delegation_target,
      permission_profile = excluded.permission_profile,
      metadata = excluded.metadata,
      source_hash = excluded.source_hash,
      last_seen = excluded.last_seen,
      updated_at = excluded.updated_at
  `)
  const deleteAllFiles = db.prepare('DELETE FROM capability_files WHERE capability_id = ?')
  const upsertFile = db.prepare(`
    INSERT INTO capability_files (
      id, capability_id, path, role, readable, writable, index_for_search,
      include_in_bundle, metadata, updated_at
    ) VALUES (
      @id, @capability_id, @path, @role, @readable, @writable, @index_for_search,
      @include_in_bundle, @metadata, datetime('now')
    )
    ON CONFLICT(capability_id, path, role) DO UPDATE SET
      readable = excluded.readable,
      writable = excluded.writable,
      index_for_search = excluded.index_for_search,
      include_in_bundle = excluded.include_in_bundle,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `)

  const tx = db.transaction(list => {
    for (const agent of list) {
      const capability = agent.capability
      if (!capability) continue
      upsertCapability.run({
        id: capability.id,
        path: capability.path,
        name: capability.name,
        description: capability.description ?? null,
        kind: capability.kind || 'agent',
        context: capability.context ?? null,
        project: capability.project ?? null,
        command: capability.command ?? null,
        active: capability.active ? 1 : 0,
        provider_support: JSON.stringify(arrayValue(capability.provider_support)),
        trigger_phrases: JSON.stringify(arrayValue(capability.trigger_phrases)),
        aliases: JSON.stringify(arrayValue(capability.aliases)),
        delegation_mode: capability.delegation_mode || 'none',
        delegation_target: capability.delegation_target ?? null,
        permission_profile: JSON.stringify(objectValue(capability.permission_profile)),
        metadata: JSON.stringify(objectValue(capability.metadata)),
        source_hash: capability.source_hash ?? null,
      })

      const files = Array.isArray(capability.files) ? capability.files : []
      deleteAllFiles.run(capability.id)
      for (const file of files) {
        const role = file.role || 'knowledge'
        upsertFile.run({
          id: stableId('capfile', `${capability.id}\0${file.path}\0${role}`),
          capability_id: capability.id,
          path: file.path,
          role,
          readable: boolInt(file.readable, true),
          writable: boolInt(file.writable, false),
          index_for_search: boolInt(file.index_for_search, true),
          include_in_bundle: boolInt(file.include_in_bundle, false),
          metadata: JSON.stringify(objectValue(file.metadata)),
        })
      }
    }
  })
  tx(agents)
  return { ok: true, count: agents.filter(agent => agent.capability).length }
}

export function parseCapabilityRow(row) {
  if (!row) return null
  const parsed = { ...row }
  for (const field of JSON_ARRAY_FIELDS) parsed[field] = safeJsonParse(parsed[field], [])
  for (const field of JSON_OBJECT_FIELDS) parsed[field] = safeJsonParse(parsed[field], {})
  parsed.active = parsed.active === 1
  return parsed
}

export function parseCapabilityFileRow(row) {
  if (!row) return null
  return {
    ...row,
    readable: row.readable === 1,
    writable: row.writable === 1,
    index_for_search: row.index_for_search === 1,
    include_in_bundle: row.include_in_bundle === 1,
    metadata: safeJsonParse(row.metadata, {}),
  }
}

export function listCapabilities(db, filter = {}) {
  ensureCapabilitySchema(db)
  const conds = []
  const params = {}
  if (filter.context !== undefined) { conds.push('context = @context'); params.context = filter.context }
  if (filter.project !== undefined) { conds.push('project = @project'); params.project = filter.project }
  if (filter.kind !== undefined) { conds.push('kind = @kind'); params.kind = filter.kind }
  if (filter.active !== undefined) { conds.push('active = @active'); params.active = filter.active ? 1 : 0 }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return db.prepare(`
    SELECT * FROM capabilities
    ${where}
    ORDER BY context ASC NULLS LAST, project ASC NULLS LAST, name ASC
  `).all(params).map(parseCapabilityRow)
}

export function getCapability(db, selector = {}) {
  ensureCapabilitySchema(db)
  const row = selector.path
    ? db.prepare('SELECT * FROM capabilities WHERE path = ?').get(selector.path)
    : db.prepare('SELECT * FROM capabilities WHERE id = ? OR path = ?').get(selector.id, selector.id)
  const capability = parseCapabilityRow(row)
  if (!capability) return null
  capability.files = db.prepare(`
    SELECT * FROM capability_files
    WHERE capability_id = ?
    ORDER BY include_in_bundle DESC, role ASC, path ASC
  `).all(capability.id).map(parseCapabilityFileRow)
  return capability
}

function textForSearch(capability) {
  return [
    capability.name,
    capability.description,
    capability.kind,
    capability.context,
    capability.project,
    capability.path,
    ...(capability.aliases || []),
    ...(capability.trigger_phrases || []),
  ].filter(Boolean).join(' ').toLowerCase()
}

function scoreCapability(capability, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return 1
  const text = textForSearch(capability)
  const name = String(capability.name || '').toLowerCase()
  const description = String(capability.description || '').toLowerCase()
  const aliases = (capability.aliases || []).join(' ').toLowerCase()
  const triggers = (capability.trigger_phrases || []).join(' ').toLowerCase()
  const terms = q.split(/\s+/).filter(Boolean)
  let score = 0
  if (name.includes(q)) score += 30
  if (triggers.includes(q)) score += 24
  if (aliases.includes(q)) score += 20
  if (description.includes(q)) score += 12
  if (text.includes(q)) score += 8
  for (const term of terms) {
    if (name.includes(term)) score += 10
    if (aliases.includes(term)) score += 8
    if (triggers.includes(term)) score += 7
    if (description.includes(term)) score += 4
    if (text.includes(term)) score += 2
  }
  return score
}

export function searchCapabilities(db, args = {}) {
  const limit = Math.max(1, Math.min(parseInt(args.limit ?? '20', 10) || 20, 100))
  const candidates = listCapabilities(db, {
    context: args.context,
    project: args.project,
    kind: args.kind,
    active: args.active ?? true,
  })
  return candidates
    .map(capability => ({ ...capability, score: scoreCapability(capability, args.query) }))
    .filter(capability => !args.query || capability.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
}
