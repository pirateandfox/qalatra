# Agent Memory and Capability Registry Implementation Brief

Date: 2026-05-23

## Goal

Build Qalatra into the agent operating layer for Justin's workspace.

Today, Qalatra is a task manager, MCP server, agent dispatcher, daily note store, and UI. The next step is to make it the system that helps a top-level assistant answer:

- What is this request about?
- Which project, client, person, task, or agent does it touch?
- Which capability should handle it?
- What context files, daily notes, tasks, and prior outputs should be loaded?
- What actions are allowed directly, and what requires confirmation or delegation?
- Where should new memory be written back?

This is bigger than text-file agent instructions. Text files remain useful human-readable memory, but Qalatra should index, type, search, and serve that memory through MCP.

## Product Framing

Qalatra becomes the substrate that makes agents better at their jobs.

```
Model       = reasoning engine
Qalatra     = memory, task state, routing, permissions, context bundles, delegation
Filesystem  = durable human-readable knowledge
MCP         = agent access layer
```

The durable value is not the prompt. It is the accumulated context: tasks, daily notes, project files, contacts, agent instructions, filing rules, client history, and decisions over time.

## Current Relevant State

The repo already has the core pieces this should build on:

- SQLite at `db/tasks.db`
- `db-worker.js` owns the Electron/server-side DB access path
- `mcp/db.js` owns the MCP-side schema and task/note helpers
- `server/agents.js` scans folders for `agent.config`
- `db-worker.js` already has an `agents` table populated by scanner output
- `daily_notes` already exist and are exposed via MCP tools:
  - `get_daily_note`
  - `update_daily_note`
  - `get_week_notes`
- `tasks`, `notes`, `agent_jobs`, `contexts`, `projects`, and `attachments` already provide structured operational state

Current `agent.config` fields are dispatch-oriented: `name`, `description`, `context`, `project`, `command`, `coding`. That is enough to launch agents, but not enough for a top-level VA to reason about capabilities, permissions, owned memory, or writeback targets.

## Core Architecture

Use a hybrid model:

1. Relational database for truth, routing, permissions, and current state.
2. Full-text search for exact/local keyword discovery.
3. Vector embeddings for fuzzy semantic recall.
4. Markdown/text files for durable human-readable memory.
5. MCP tools as the agent-facing interface.

Do not make the capability registry "just a vector database." A vector index can suggest relevance, but it cannot be trusted for permissions or routing.

## Product Flexibility: Scopes, Not Hard-Coded Clients

Do not bake an agency/client worldview into Qalatra's core data model.

Justin's workspace has many clients, so cross-client contamination is an important guardrail. But other Qalatra users may have no clients at all. An ecommerce operator might need stores, brands, suppliers, products, campaigns, channels, or fulfillment workflows. A personal user might need life areas, households, medical providers, insurance policies, or projects. A software team might need repos, products, customers, environments, or incidents.

The core product should use flexible scopes and relationships:

- `context`: the broad operating bucket or life/work area
- `project`: a named initiative, product, repo, engagement, or workstream
- `entity`: a typed thing the user works with, such as client, customer, vendor, supplier, product, store, person, account, policy, venue, repo, system, campaign
- `capability`: an agent/skill/workflow/tool that can be loaded or delegated to
- `source`: where memory came from, such as file, task, daily note, email, Slack thread, CRM record, order, document

"Client" should be one configurable entity type, not a universal column that every user sees.

Recommended model:

```sql
CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  context     TEXT,
  project     TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entity_links (
  id               TEXT PRIMARY KEY,
  entity_id         TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_type       TEXT NOT NULL,
  target_id         TEXT,
  target_path       TEXT,
  relationship      TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, target_type, target_id, target_path, relationship)
);
```

Memory documents/chunks should store flexible scope metadata, not just agency-specific fields:

- `context`
- `project`
- `entity_ids` or link rows
- `source_type`
- `capability_id`
- `active/archived`
- `freshness`
- `visibility/access policy`

Qalatra can ship with templates or presets:

- Agency: clients, contacts, SOWs, invoices, retainers
- Ecommerce: stores, suppliers, products, orders, campaigns
- Personal: people, household, insurance, health, finance
- Software: repos, products, environments, incidents, releases

But the substrate should stay generic. Templates configure entity types, labels, default folders, memory sources, and permission defaults. The core search/registry/bundle machinery should not care whether the scope is a client, store, product, or insurance policy.

## Where Agents Live

Keep agent definitions folder-first for now.

An agent/capability should continue to live as a local, human-readable folder with files such as:

- `agent.config`
- `AGENTS.md`
- `CLAUDE.md`
- `SKILL.md`
- `knowledge/`
- `examples/`
- `output/`

Qalatra should scan those folders, register them in the database, enrich them with capability metadata, and expose them through MCP.

This creates three layers:

- **Filesystem source:** durable, versionable instructions and memory a human can inspect and edit.
- **Qalatra registry:** structured indexed metadata, permissions, search fields, owned files, and delegation targets derived from the folder.
- **Runtime session/job:** the actual Claude/Codex/OpenAI/etc. process running with a working directory, prompt, and MCP tools.

Later, Qalatra may support DB-stored prompt blocks or UI-managed capability metadata, but the source of truth for standing instructions should remain readable and portable unless there is a strong reason to move it.

The top-level personal VA can be just another registered local folder, e.g. `~/IdeaProjects/projects/workspace-assistant/`, but Qalatra should make it more powerful by giving it MCP access to capability search, memory search, context bundles, tasks, daily notes, permissions, and delegation.

## Data Sources to Index

Index both filesystem memory and Qalatra-native database memory.

### Filesystem Markdown

Start with markdown/text under configured workspace roots:

- `~/IdeaProjects/projects/**/*.md`
- agent instructions: `AGENTS.md`, `CLAUDE.md`, `SKILL.md`
- project files: `context.md`, `contacts.md`, `project-details.md`
- knowledge bases such as `business-tools/filer/knowledge/*.md`
- output docs, briefs, and implementation notes

Exclude:

- `.git`, `node_modules`, `dist`, build output
- binary files
- secrets and credential-like files
- files over a configurable size limit unless explicitly included

### Qalatra Tables

Index Qalatra DB records as first-class memory sources:

- `tasks`: title, description, ai_context, context, project, status, source_url, links
- `notes`: task notes and agent result notes
- `agent_jobs`: prompt/result summaries, at least when result exists
- `daily_notes`: every date's full markdown content
- `contexts`: names, labels, notes
- `projects`: project metadata
- `agents`: current registered agents/capabilities

Daily notes matter because they contain decisions, carry-forward context, what actually happened, and the soft memory between formal tasks.

## Proposed Schema

Keep the current `agents` table for scanned runtime dispatch metadata, but add first-class capability and memory tables.

### `capabilities`

One row per agent/skill/capability. Most initial rows will come from folders with `agent.config`.

```sql
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
```

`kind` examples:

- `agent`
- `skill`
- `workflow`
- `knowledge`
- `external_tool`

`delegation_mode` examples:

- `none`
- `qalatra_agent`
- `mcp_tool`
- `manual`

### `capability_files`

The files a capability owns, reads, or writes.

```sql
CREATE TABLE IF NOT EXISTS capability_files (
  id                    TEXT PRIMARY KEY,
  capability_id          TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  path                  TEXT NOT NULL,
  role                  TEXT NOT NULL,
  readable              INTEGER NOT NULL DEFAULT 1,
  writable              INTEGER NOT NULL DEFAULT 0,
  index_for_search       INTEGER NOT NULL DEFAULT 1,
  include_in_bundle      INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(capability_id, path, role)
);
```

`role` examples:

- `instructions`
- `adapter_claude`
- `adapter_skill`
- `project_context`
- `contacts`
- `project_details`
- `knowledge`
- `routing_rules`
- `naming_conventions`
- `examples`
- `output`
- `writeback_target`

### `memory_documents`

One row per indexed source document or DB record.

```sql
CREATE TABLE IF NOT EXISTS memory_documents (
  id              TEXT PRIMARY KEY,
  source_type     TEXT NOT NULL,
  source_id       TEXT,
  path            TEXT,
  title           TEXT,
  context         TEXT,
  project         TEXT,
  capability_id   TEXT REFERENCES capabilities(id),
  content_hash    TEXT NOT NULL,
  mtime_ms        INTEGER,
  size_bytes      INTEGER,
  metadata        TEXT NOT NULL DEFAULT '{}',
  indexed_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id, path)
);
```

`source_type` examples:

- `file`
- `daily_note`
- `task`
- `task_note`
- `agent_job`
- `context`
- `project`
- `capability`

For daily notes:

- `source_type = 'daily_note'`
- `source_id = date`
- `title = 'Daily Note YYYY-MM-DD'`
- `metadata = {"date":"YYYY-MM-DD"}`

### `memory_chunks`

Chunk-level search records.

```sql
CREATE TABLE IF NOT EXISTS memory_chunks (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  heading         TEXT,
  text            TEXT NOT NULL,
  token_estimate  INTEGER,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(document_id, chunk_index)
);
```

Add FTS5 over `memory_chunks.text` if the packaged SQLite build supports it:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts
USING fts5(text, heading, content='memory_chunks', content_rowid='rowid');
```

If `rowid` mapping is awkward because chunks use UUID primary keys, use an external-content table or a separate integer key. Do not let FTS complexity block the relational tables.

### `memory_embeddings`

Store embeddings separately so chunks can be re-embedded with new models.

```sql
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id              TEXT PRIMARY KEY,
  chunk_id        TEXT NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  dimensions      INTEGER NOT NULL,
  embedding       BLOB NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chunk_id, provider, model)
);
```

Use a `Float32Array` encoded as a SQLite BLOB.

### `memory_index_queue`

Queue changed sources for indexing/embedding.

```sql
CREATE TABLE IF NOT EXISTS memory_index_queue (
  id              TEXT PRIMARY KEY,
  source_type     TEXT NOT NULL,
  source_id       TEXT,
  path            TEXT,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  completed_at    TEXT
);
```

## Capability Config

Extend `agent.config` with an optional `capability` block. Keep existing configs valid.

Example:

```json
{
  "name": "Filer",
  "description": "Audits Desktop and local folders, recommends where files should go, then files them to Drive or local folders after confirmation",
  "context": "internal",
  "command": "claude --dangerously-skip-permissions",
  "capability": {
    "kind": "agent",
    "aliases": ["filing", "file organization", "desktop cleanup"],
    "triggers": [
      "file this",
      "where should this go",
      "clean up my Desktop",
      "upload this to Drive",
      "organize these files"
    ],
    "provider_support": ["claude", "codex"],
    "delegation": {
      "mode": "qalatra_agent",
      "target": "."
    },
    "permissions": {
      "read_files": "allowed",
      "move_files": "confirm",
      "delete_files": "double_confirm",
      "upload_to_drive": "confirm",
      "send_email": "never"
    },
    "files": [
      {
        "path": "AGENTS.md",
        "role": "instructions",
        "readable": true,
        "writable": false,
        "include_in_bundle": true
      },
      {
        "path": "knowledge/routing-rules.md",
        "role": "routing_rules",
        "readable": true,
        "writable": true,
        "include_in_bundle": true
      },
      {
        "path": "knowledge/naming-conventions.md",
        "role": "naming_conventions",
        "readable": true,
        "writable": true,
        "include_in_bundle": true
      }
    ]
  }
}
```

The scanner should infer reasonable defaults when this block is missing:

- `kind = 'agent'`
- trigger candidates from `name`, `description`, `context`, `project`, and folder path
- delegation target is the scanned agent path
- `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `context.md`, `project-details.md`, `contacts.md`, and `knowledge/*.md` become indexed files when present

## Search Behavior

Provide hybrid search:

1. Structured filters narrow candidates:
   - context
   - project
   - source_type
   - capability_id
   - status for task-derived memory
   - date range for daily notes
2. Keyword/FTS search finds exact matches.
3. Vector search finds semantic matches.
4. Results are merged and reranked.

For MVP, it is acceptable to brute-force cosine similarity in JavaScript over local vectors if the chunk count is modest. Avoid adding a native vector SQLite extension until packaging and Electron build implications are understood. A later optimization can add `sqlite-vec` or another SQLite vector extension behind the same search interface.

## MCP Tools

Add two new MCP tool modules:

- `mcp/tools/capabilities.js`
- `mcp/tools/memory.js`

### Capability Tools

#### `list_capabilities`

Filters:

- `context`
- `project`
- `kind`
- `active`

Returns structured capability rows.

#### `get_capability`

Input:

- `id` or `path`

Returns:

- capability metadata
- owned files
- permission profile
- delegation target

#### `search_capabilities`

Input:

- `query`
- optional `context`
- optional `project`
- optional `limit`

Searches capability name, description, aliases, triggers, and optionally semantic memory chunks attached to capability files.

#### `rescan_capabilities`

Runs the existing agent scan plus capability parsing/indexing.

### Memory Tools

#### `memory_search`

Input:

- `query`
- `source_types`
- `context`
- `project`
- `capability_id`
- `date_from`
- `date_to`
- `limit`
- `mode`: `hybrid | keyword | semantic`

Returns chunks with:

- text excerpt
- source type
- source path/id
- title
- score
- context/project
- metadata

#### `get_context_bundle`

This is the main tool for top-level assistants.

Input:

- `query`
- optional `context`
- optional `project`
- optional `max_tokens`
- optional `include_tasks`
- optional `include_daily_notes`
- optional `include_capabilities`

Returns:

- likely intent summary
- relevant capabilities
- required/optional files to read
- relevant tasks
- relevant daily notes
- relevant memory excerpts
- permission warnings
- suggested delegation target, if any
- writeback target suggestions

This tool should not perform actions. It prepares the assistant to act well.

#### `index_workspace_memory`

Input:

- `roots`
- `force`
- `source_types`

Runs or queues indexing for filesystem and DB-backed sources.

#### `get_memory_index_status`

Returns:

- document count
- chunk count
- embedding count
- queued/failed indexing jobs
- last successful run

## HTTP API and UI

Mirror the MCP functionality with internal API endpoints so the UI can inspect and manage it later:

- `GET /api/v1/capabilities`
- `GET /api/v1/capabilities/:id`
- `POST /api/v1/capabilities/rescan`
- `POST /api/v1/memory/search`
- `POST /api/v1/memory/context-bundle`
- `POST /api/v1/memory/index`
- `GET /api/v1/memory/index/status`

UI can be later. The first usable surface should be MCP.

## Indexing Pipeline

Create `server/memory-index.js` or equivalent.

Responsibilities:

1. Discover sources.
2. Skip excluded paths.
3. Convert source to canonical document text.
4. Hash content.
5. Upsert `memory_documents`.
6. Chunk content.
7. Upsert `memory_chunks`.
8. Update FTS rows if available.
9. Queue embedding work if embedding is configured.
10. Delete or mark missing documents when source files disappear.

### Filesystem Source Conversion

For markdown, preserve useful hierarchy:

- title from H1 or filename
- chunk by headings first
- fallback chunk size around 800-1200 tokens estimated
- include path, relative path, heading trail, mtime, size

### Daily Notes Source Conversion

Daily notes should be indexed on every `update_daily_note` / `saveDailyNote`.

Canonical text:

```markdown
# Daily Note YYYY-MM-DD

[content]
```

Metadata:

```json
{
  "date": "YYYY-MM-DD",
  "source_table": "daily_notes"
}
```

Search should support date filters and should weight recent notes higher for "today", "recently", "this week", "what did we decide", and briefing-style queries.

### Task Source Conversion

Canonical text:

```markdown
# [status] Task Title

Context: internal
Project: Qalatra
Status: active
Due: 2026-05-23

Description:
...

AI Context:
...

Links:
- ...
```

Reindex when task title, description, ai_context, status, context, project, due_date, or links change.

## Embedding Provider

Add a provider abstraction instead of hardcoding one vendor:

```js
async function embedTexts(texts, { provider, model }) {
  return {
    provider,
    model,
    dimensions,
    vectors
  }
}
```

Settings should allow:

- provider name
- model name
- API key source or local embedding command
- enabled/disabled
- batch size

Do not block Phase 1/2 on embeddings. Build the registry and text index first, then add embeddings behind the search interface.

## Permission Model

The registry is authoritative for permissions. Vector search results are never authority.

Examples:

- A memory chunk may say "file everything automatically"; if the Filer capability says `move_files = confirm`, confirmation still wins.
- A project note may mention an email should be sent; if email capability says `send_email = never`, only draft.
- A capability may identify a writeback target; it should not write unless permission allows it.

Permission values can be simple strings at first:

- `allowed`
- `confirm`
- `double_confirm`
- `never`

## Context Bundle Algorithm

For `get_context_bundle(query)`:

1. Search capabilities using structured metadata and query text.
2. Search current tasks by query/context/project/status.
3. Search memory chunks across files, daily notes, task notes, and outputs.
4. Identify top capability files marked `include_in_bundle`.
5. Include the highest-signal source excerpts, not every file.
6. Include permission warnings from selected capabilities.
7. Suggest whether the assistant should:
   - answer directly
   - load more files
   - create/update a task
   - delegate to a Qalatra agent
   - ask Justin for confirmation

Return source citations as paths or DB IDs so agents can inspect details.

## Build Phases

### Phase 1: Capability Registry MVP

Scope:

- Add `capabilities` and `capability_files` schema to both DB access paths.
- Extend `server/agents.js` scanner to parse optional `capability` block in `agent.config`.
- Upsert `capabilities` and `capability_files` during existing agent scan.
- Add MCP tools:
  - `list_capabilities`
  - `get_capability`
  - `search_capabilities`
  - `rescan_capabilities`
- Add basic HTTP endpoints.
- Update `plan/EVOLUTION.md`.

Acceptance:

- Existing agent configs still work.
- Existing agents appear as capabilities even without capability metadata.
- Filer can be enriched with capability metadata and found by queries like "file this invoice".
- Project Manager can be found by queries like "triage this request".

### Phase 2: Text Memory Index and Daily Notes

Scope:

- Add `memory_documents`, `memory_chunks`, and `memory_index_queue`.
- Index markdown files under configured workspace roots.
- Index `daily_notes`.
- Index task-derived memory.
- Add `memory_search` in keyword mode.
- Add `get_memory_index_status`.
- Reindex daily note when `update_daily_note` / `saveDailyNote` writes.

Acceptance:

- Searching "what did we decide about the VA architecture" finds this design if indexed.
- Searching a recent phrase from a daily note returns the daily note source.
- Searching a client name returns matching contacts/context/project files.

### Phase 3: Embeddings and Hybrid Search

Scope:

- Add `memory_embeddings`.
- Add embedding provider abstraction.
- Add background embedding queue.
- Add semantic search mode.
- Add hybrid reranking.

Acceptance:

- Fuzzy queries find relevant docs even without exact keyword overlap.
- Semantic search can include daily notes, tasks, task notes, and markdown files.
- Search results include source type and path/DB ID.

### Phase 4: Context Bundle Tool

Scope:

- Implement `get_context_bundle`.
- Combine capability search, task search, daily notes, and memory search.
- Return a compact assistant-ready bundle.
- Include permission warnings and delegation recommendations.

Acceptance:

For a query like:

> Take this invoice, send it to Sarah, and file it.

The bundle should include:

- relevant client/project/contact files if identifiable
- Filer capability and its permission profile
- email/communications capability
- relevant filing rules
- relevant recent tasks or daily notes
- recommendation to draft/send/file/confirm/delegate

### Phase 5: UI and Admin Controls

Scope:

- Capability browser
- Memory index status panel
- Manual reindex button
- Failed index job inspector
- Per-root include/exclude settings
- Per-capability permission editor

Acceptance:

- Justin can see what Qalatra thinks exists.
- Justin can fix bad metadata without editing SQLite manually.
- Agents can still operate through MCP without the UI.

## Files Likely To Change

- `db-worker.js`
- `mcp/db.js`
- `server/agents.js`
- `server/workers.js`
- `server/v1.js`
- `mcp/http-server.js`
- new `server/memory-index.js`
- new `mcp/tools/capabilities.js`
- new `mcp/tools/memory.js`
- `mcp/tools/notes.js`
- `mcp/tools/tasks.js`
- `package.json` only if adding embedding/vector dependencies
- `plan/EVOLUTION.md`

## Risks and Guardrails

### Secrets

Never index likely secret material:

- `.env`
- `.pem`
- `.key`
- `.p8`
- files with password/secret/credential/token in the path
- Qalatra token files under `db/`

### Native Dependencies

Qalatra packages Electron and also runs headless server installs. Avoid new native dependencies unless packaging is tested across both Electron Node and system Node.

### Context Bloat

The bundle tool must return focused context, not every matching document. Include scores, sources, and a clear cap.

### Stale Memory

Every memory result needs source path/ID, content hash, indexed timestamp, and updated timestamp when available.

### Cross-Client Contamination

Embeddings are fuzzy retrieval, not truth. In a workspace with many clients, semantic search can surface the wrong client's contacts, pricing, contract terms, strategy notes, or filing rules if results are not scoped and verified.

Guardrails:

- Store `context`, `project`, `client`, `source_type`, `capability_id`, and permission metadata on every document and chunk.
- When the user names or implies a client/project, apply structured filters before semantic search.
- If multiple clients/projects match, return an ambiguity warning and ask the assistant to clarify before acting.
- Never use semantic similarity alone for actions involving money, legal terms, contracts, email recipients, credentials, or file moves.
- Prefer structured fields and exact source files for authoritative data such as contacts, legal names, rates, task status, and destinations.
- Always return source citations with search results and context bundles.
- Keep archived/stale sources searchable only when requested or when no active source exists.
- In multi-user mode, enforce access control before search, not after search.

The correct model is: embeddings find candidate memory; structured metadata, exact source reads, and permission rules decide whether the memory is usable.

### Prompt vs System Guardrails

Guardrails should exist in both the agent prompt and Qalatra itself, but they should not rely on the prompt alone.

Prompt-level guardrails tell the model how to behave:

- scope by client/project/context before searching broadly
- cite sources
- ask when ambiguous
- confirm before money, legal, email sending, file movement, deletion, or credentials
- prefer structured data for contacts, legal names, rates, task status, and permissions

Qalatra-level guardrails enforce or shape behavior:

- `get_context_bundle` applies structured filters before semantic search when project/client/context is known
- search results always include source type, path/ID, context, project, dates, and freshness
- capability permissions are returned with search results and bundles
- ambiguous multi-client matches are flagged in the API response
- protected actions check capability permission profiles before execution/delegation
- multi-user access control is applied before search, not after search

The prompt can forget. The system should make the safe path the easiest path and make risky actions explicit.

### Permissions

Registry permissions must override anything found in semantic memory.

## First Build Task Prompt

Use this as the first implementation prompt inside `~/IdeaProjects/qalatra`:

```text
Build Phase 1 of docs/agent-memory-registry-implementation-brief.md.

Implement the capability registry MVP:
- add capabilities and capability_files schema to both db-worker.js and mcp/db.js
- extend server/agents.js so scanAgents parses the optional capability block in agent.config while preserving current behavior
- upsert capabilities and capability_files during the existing agent scan path
- add MCP tools list_capabilities, get_capability, search_capabilities, and rescan_capabilities
- add minimal HTTP API endpoints for listing, fetching, searching, and rescanning capabilities
- infer default capabilities for existing agents without a capability block
- do not add embeddings yet
- update plan/EVOLUTION.md with what changed and what remains next

Acceptance:
- npm run check-imports passes
- existing agent scan behavior still works
- existing agent.config files do not need modification
- Filer, Project Manager, and Code Pipeline appear in list_capabilities
- search_capabilities finds Filer for "file this invoice" based on description/name defaults even before richer metadata is added
```
