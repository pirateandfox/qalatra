# Future Ideas

Low-priority or speculative ideas that aren't worth building yet but shouldn't be forgotten.

---

## Multi-runtime agent support

The agent system is currently hardwired to Claude Code (`claude` CLI). The right abstraction is a **runtime** field on `agent.config` — each agent knows how it executes, and the task just picks an agent.

**Runtime types:**

| Type | Example agents | Execution |
|---|---|---|
| `claude-code` | Most agents today | `claude -p '{prompt}'` in agent folder |
| `codex` | Code-generation agents | `codex '{prompt}'` in agent folder |
| `api-anthropic` | Lightweight summarizers, classifiers | Direct Anthropic API call, system prompt from `CLAUDE.md` or `agent.config` |
| `api-openai` | GPT-4o agents | OpenAI-compat API call |
| `api-local` | Privacy-sensitive agents | OpenAI-compat at `localhost:PORT` (Ollama, LM Studio) |

**Key design decisions:**
- Runtime belongs to the **agent**, not the task. Assigning an agent implicitly picks the runtime — no per-task runtime selection needed.
- `CLAUDE.md` is the canonical prompt source for all runtimes. Codex agent folders get `AGENTS.md` symlinked to `CLAUDE.md` at agent creation time (no duplicate maintenance). API runtimes read `CLAUDE.md` as the system prompt, or fall back to a `system_prompt` field in `agent.config` for agents with no folder.
- The agent editor UI shows runtime-appropriate setup fields when you pick a runtime.

**`agent.config` additions:**
```json
{ "name": "Code Planner", "runtime": "claude-code" }
{ "name": "Code Writer", "runtime": "codex" }
{ "name": "Summarizer", "runtime": "api-anthropic", "model": "claude-haiku-4-5-20251001" }
{ "name": "Local Analyst", "runtime": "api-local", "baseUrl": "http://localhost:11434/v1", "model": "llama3" }
```

**Credential storage:** API keys go through Electron's `safeStorage` API (OS keychain encryption), not plaintext in SQLite.

**What to build:**
1. `runtime` field on `agent.config` (default: `claude-code` for backwards compat)
2. `runtimes` settings table for named API profiles (URL, model, key ref)
3. Executor module that dispatches based on runtime type (~200 lines)
4. Symlink `AGENTS.md → CLAUDE.md` in agent scaffolding for Codex agents
5. Settings UI for managing API runtime profiles

**When to build:** when there's a concrete agent that needs a different runtime — e.g. a local model for sensitive data, or a Codex agent for a specific coding workflow.

---

## Inbound webhooks

Accept signed webhook payloads from external services (GitHub, Stripe, Missive, Zapier, etc.) and convert them into Qalatra tasks or trigger MCP tool calls.

**Architecture:**
- Add a `/webhook/:source` POST endpoint to the existing MCP HTTP server (port 3457)
- Each source has a stored HMAC secret; payloads are verified before any processing
- Timestamp validation rejects replays older than ~5 minutes
- The endpoint is **write-only** — it never returns task data, so there is nothing to exfiltrate even if the URL is discovered
- A `webhooks` table stores source name, HMAC secret, and action rules (e.g. "GitHub PR opened → create task in context silvermouse")

**Public reachability:**
- Run `cloudflared tunnel` as a launchd service (same mechanism as the MCP server)
- Tunnel proxies inbound HTTPS from a stable `*.cfargotunnel.com` URL to port 3457
- Cloudflare terminates TLS; your machine is never directly internet-exposed
- Tunnel URL surfaced in Settings alongside the MCP server config

**Security model (defense in depth):**
1. Obscure URL (not published anywhere)
2. HMAC-SHA256 signature required per source — `crypto.timingSafeEqual` comparison
3. Timestamp validation (reject payloads > 5 min old)
4. Write-only endpoint — responses are always `{"ok":true}` or 401, never task data
5. Cloudflare TLS termination

**UI:** Settings panel section to add/manage webhook sources (name, secret, action rule).

**When to build:** when there's a specific external trigger worth automating (e.g. "Missive email received → create inbox task", "GitHub PR assigned → create coding task"). The security model is solid; the main question is whether manual creation via MCP chat is already fast enough.

---

## Weekly recurrence day-of-week pinning

`create_task` now accepts full RRULE strings (e.g. `FREQ=WEEKLY;BYDAY=MO`), but the shorthand `weekly` still drifts if completed on a different day. The RRULE path is the fix — document it more prominently in onboarding/PM session context, and consider defaulting `weekly` to anchor on the task's original `due_date` weekday rather than completion date.

---

## Sync layer (Asana / Linear / Notion)

Automated two-way state sync: pull tasks in, push completions back. Originally planned but made redundant by having Asana/Linear/Notion MCP connections available in chat. Current workflow (triage in chat → create task with source_url → complete both in same conversation) covers the need without the complexity of webhooks, polling, and token storage. Only worth revisiting if closing tasks in two places becomes consistently annoying in practice.

---

## Bug: Completing a missed recurring task drifts the cadence

**Observed (2026-04-13):** Weekly task due Tue Apr 7 was missed. Auto-skip surfaced it on Mon Apr 13 with `due_date = today` — which is correct behavior (keep it visible until done). But when the user completes it on Apr 13, the next recurrence will land on **Mon Apr 20** (today + 7 days) instead of **Tue Apr 14** (original cadence + 7 days). The weekday alignment drifts permanently.

**Expected behavior:** Auto-skip surfacing a missed task as due-today is correct. The problem is in **completion recurrence**: the next occurrence should be anchored to `original_due_date + recurrence_period`, not `completion_date + recurrence_period`. For tasks missed by multiple periods, advance by the minimum number of periods to land in the future: `original_due_date + ceil((today - original_due_date) / period) * period`.

**Impact:** Any missed weekly task that gets completed on a different weekday permanently shifts its schedule. User has to manually correct due dates to restore Tuesday/Thursday/etc. cadences.

**Fix:** In the completion recurrence handler, use the task's `due_date` (not today) as the base for the next occurrence calculation. Since auto-skip already sets `due_date = today` on the missed instance, the workaround is: before completing a missed task, set `due_date` to the correct next cadence date — then completion recurrence lands correctly.

---

## `defer_context` / bulk triage

A single MCP call to snooze all active tasks in a context by N days (e.g. "Monroe is on hold for 2 weeks"). Currently solvable via chat — just say "snooze all active Monroe tasks until X" and Claude loops through them. Only worth building if the one-by-one approach becomes noticeably burdensome in practice.

---

## Agent job queue

Fire-and-forget automated agent tasks — dispatch a prompt to a folder-agent and let it run without a human in the loop. The folder-as-agent architecture is already built; this is the async execution layer on top of it.

**Schema addition:**
```sql
CREATE TABLE agent_jobs (
  id INTEGER PRIMARY KEY,
  agent_path TEXT,           -- resolved from agent.config scan
  prompt TEXT,               -- the task instruction
  status TEXT,               -- queued | running | done | failed
  result TEXT,               -- stdout summary from agent
  output_path TEXT,          -- where the artifact was written
  priority INTEGER DEFAULT 5,
  created_at DATETIME,
  started_at DATETIME,
  completed_at DATETIME
);
```

**Worker:** polls every 2 seconds, respects a concurrency cap (recommended: 3-4 simultaneous Claude Code instances). Runs `claude -p '{prompt}' --output-format json` in the agent's folder via `exec()`.

**When to build:** when the pattern of "open terminal → navigate to agent folder → run Claude manually" becomes the bottleneck. The terminal is currently sufficient for interactive use.

---

## Agent editor UI

Edit agent definitions (`agent.config` + `CLAUDE.md`) directly inside Qalatra without touching the filesystem manually.

**Scope:** Small — ~3–5 hours. Backend plumbing is almost entirely there already.

**What already exists:**
- `file:read` and `file:write` IPC handlers (restricted to `~/IdeaProjects` — needs one-line broadening to also allow `agentsRoot`)
- `fetchAgents()` returns the absolute `path` for each agent directory
- `agent.config` is plain JSON: `name`, `context`, `project`, `description`, `command`, `coding`
- `CLAUDE.md` is a plain markdown file in the same directory (may not exist yet)

**UI: an `AgentEditor` modal triggered from wherever agents are listed (e.g., `ProjectDashboardView`)**

Fields:
- Config form: name, context dropdown, project combobox, description, command, coding toggle
- Textarea for `CLAUDE.md` content (plain text is fine — no rich editor needed)
- "Create new agent" path: pick a parent directory, enter a folder name → scaffolds dir + writes initial `agent.config`

**On save:** write `agent.config` as JSON, write `CLAUDE.md` as text, call `agents:rescan` so the UI reflects changes immediately.

**Backend changes needed:**
1. Loosen `file:read`/`file:write` path guard to also allow `agentsRoot` setting (or just `HOME` with a list of permitted extensions)
2. Add `agent:create-dir` IPC handler to `mkdir -p` the new agent directory before writing files

**When to build:** when editing `agent.config` files by hand in the terminal feels like friction.

---

## Terminal improvements (xterm.js / Warp-like experience)

Qalatra already uses xterm.js + node-pty — the same stack as VS Code. Current setup only uses FitAddon (canvas renderer). Three tiers of improvement, each independent:

### Tier 1: WebGL renderer (1–2 hours, high ROI)
Add `@xterm/addon-webgl` and enable it on terminal init. Switches rendering from canvas to GPU-accelerated WebGL — meaningfully faster output, especially for agent runs with heavy stdout. VS Code ships with this enabled. Immediate visible improvement.

```ts
import { WebglAddon } from '@xterm/addon-webgl'
term.loadAddon(new WebglAddon())
```

### Tier 2: Fix React/mount jank (half-day)
Currently the terminal re-mounts or loses focus when the docked/fullscreen state changes. The fix: mount the xterm instance once and keep it alive, just show/hide the container via CSS. Eliminates most of the "janky" feeling that distinguishes it from a native terminal.

### Tier 3: Terminal pane splits / grid (2–3 days)
Multiple independent terminal panes in a resizable grid. Each pane gets its own node-pty process. Needs a split-pane layout manager (e.g. `react-resizable-panels`) and a `pty:create` / `pty:write` / `pty:close` IPC model that supports multiple sessions by ID. Enables Warp-style multi-terminal layouts without leaving Qalatra.

### Tier 4: WebSocket remote terminal (headless mode)

The existing terminal spawns a pty locally via Electron IPC — it can't reach a remote headless backend. A WebSocket pty proxy on the server enables a real shell on the remote machine through the same xterm.js frontend.

- **Server side:** WebSocket endpoint on the headless API server spawns `node-pty`, proxies stdin/stdout. Gated by `full_access` capability token in the handshake.
- **Client side:** xterm.js detects local vs remote mode (`API_BASE` is local or remote) and connects to the appropriate transport — IPC for local, WebSocket for remote.
- **What this covers:** file editing on the remote machine (no vim required once Monaco is in, but raw shell access is still valuable), Claude Code sessions against remote agent folders, any shell work on the headless instance.

This is the enabling piece for headless admin use — without it, the Electron UI connected to a remote backend has no way to run commands on that machine.

**Ceiling:** With all four tiers, the terminal will feel solid for agent monitoring and quick file edits. It won't feel as "native" as a standalone Warp window — Electron has overhead that can't be eliminated. The right mental model is "good enough that you don't need to switch apps," not "replace Warp entirely."

**When to build Tier 1:** basically any time — it's low risk and high payoff.
**When to build Tier 3:** when you find yourself constantly switching to Warp just to have two terminals side by side.
**When to build Tier 4:** when headless instance management becomes a real workflow (i.e. when Step 7 of the ARCHITECTURE.md build order lands).

---

## Embedded file editor (Monaco)

VS Code's editor — Monaco Editor — is fully open source, embeddable via npm, and brings syntax highlighting, search, keybindings, and multi-language support for free. VS Code itself is Electron + TypeScript, same stack as Qalatra. Monaco is the extractable core.

**Goal:** Quick file review without leaving Qalatra. Primary use case: agent finishes a task, links an output file, you want to glance at the diff or read the result without opening an IDE. Light editing (tweak a config, fix a line) is a bonus, not the core. Deep coding work still happens in a real IDE.

**Scope:** 1–2 days for a solid read/edit/save panel.

**Shape:**
- A slide-in panel or full-screen overlay (like the existing MdView overlay)
- Triggered from: file links on tasks, agent output paths, the agent editor, terminal `open` commands
- Reads via `file:read` IPC (local) or `GET /api/files?path=...` (remote), saves via `file:write` IPC or `PUT /api/files?path=...`
- Monaco handles syntax highlighting automatically from file extension
- In remote/headless mode the file API endpoints are gated by `full_access` token — same as the WebSocket terminal

**Dependencies:**
```
npm install @monaco-editor/react
```

**What you get for free from Monaco:** syntax highlighting for JS/TS/Python/JSON/Markdown/etc., find & replace, multi-cursor, minimap, theme integration.

**What you don't get without more work:** LSP (autocomplete, go-to-definition), git diff view, debugger. Those are VS Code features built on top of Monaco, not part of it.

**When to build:** when you find yourself opening a file in another editor just to make a small change and come back. The agent editor (above) is a precursor — if that feels good, Monaco is the natural next step for arbitrary files.

---

## File browser + workspace view

A file tree panel rooted at `agentsRoot`, combined with the Monaco viewer, turns Qalatra into a self-contained workspace. The vision: tasks reference agent folders → you open the folder in the tree → read or edit the CLAUDE.md → the agent runs better next time. Everything is text files. Qalatra already knows where they all live.

**What already exists:**
- `agentsRoot` setting defines the root
- Directory-walking logic exists in `scanAgents()` in `ipc-handlers.js` — can be repurposed
- `file:read` / `file:write` IPC handlers cover opening and saving files
- Monaco (once added) handles the viewing/editing

**What needs building:**
- `directory:list` IPC handler — returns entries (files + subdirs) for a given path, one level deep
- File tree UI component — collapsible folders, file icons by extension, click to open in Monaco panel
- Probably lives as a toggleable left panel or a dedicated sidebar section

**Scope:** 2–3 days once Monaco is in. The IPC side is a morning; the tree UI is the main work.

**Self-editing loop this enables:**
1. Agent finishes a task and links an output file → click to open it in the viewer
2. Notice the agent's CLAUDE.md needs updating → navigate to it in the tree → edit in Monaco → save
3. Task references a project folder → browse it without switching apps
4. Edit an `agent.config`, trigger a rescan, updated agent appears in the task creation dropdown

Everything Qalatra manages (tasks, agents, projects) lives in folders it already knows about. The file browser closes the loop so the system can evolve itself from within.

**When to build:** naturally after Monaco is in — the file browser without a viewer is much less useful. Together they form a coherent feature.

---

## Agent IDE (terminal + editor + file browser as a unit)

The terminal improvements, Monaco editor, file browser, and agent editor are individually useful but together form something more coherent: an Agent IDE panel. Open an agent from the agent list and get:

- **File browser** (left): tree rooted at the agent's directory — `agent.config`, `CLAUDE.md`, scripts, output files
- **Monaco editor** (right): click any file to open it; edit and save without leaving Qalatra
- **Terminal** (bottom, docked): opens directly in the agent's working directory; run Claude Code sessions, inspect output, edit files if needed

Works identically in local mode (IPC + local pty) and remote/headless mode (HTTP file API + WebSocket pty). This is the primary reason to invest in the WebSocket terminal and Monaco together rather than separately — the combination means you never need to leave Qalatra to manage, configure, or converse with an agent.

The terminal in this context also handles long-form Claude Code sessions (strategy agent, PM agent, etc.) — the original reason the embedded terminal was built. The Agent IDE formalizes that into a first-class workflow rather than a bottom panel hack.

**Build order:** agent editor → Monaco viewer → file browser → WebSocket terminal → wire together as Agent IDE. Each step is useful independently.

---

## Agent launcher

Searchable list of all registered agents (scanned from `agentsRoot` via `agent.config` files), ordered by most recently used or most recently active. Solves the friction of remembering which folder an agent lives in as the roster grows.

**Interactions:**
- Search/filter by name, context, project, description
- Click → opens terminal in that agent's directory (local: terminal panel with `cd <path>\r`; remote: WebSocket terminal in that path)
- "New chat" → `claude` in that directory
- "Resume" → shows most recent Claude session for that path, opens with `claude --resume <uuid>`

**When to build:** when the agent roster is large enough that finding an agent by memory becomes friction. Currently the Settings → Agents tab lists them; a launcher adds quick access from anywhere in the app (keyboard shortcut, command palette style).

---

## Task management connector (heartbeat-based delegation)

A pattern for delegating work from external PM tools (Asana, Linear, etc.) to Qalatra agents without building a separate staff UI. Staff create tasks in their existing tool with an "Agent" field; a connector heartbeat routes them to the right agent and writes results back.

**How it works:**
1. A connector heartbeat polls a designated Asana project / Linear team via MCP on a short interval (5–10 min)
2. New tasks with a recognised "Agent" field → create Qalatra task with matching `agent_path`
3. Agent job runs autonomously; on completion, result is written back to the external task
4. The external PM tool is the staff UI; Qalatra is invisible infrastructure

**What already exists:** heartbeat system, Asana/Linear MCP integrations, `source_url`/`source_id` fields, `get_pending_syncs`/`mark_sync_complete` sync infrastructure.

**What formalising this adds:** a `connector.config` convention, standardised field naming, bidirectional status sync primitives, Settings UI for managing connectors.

**Key tradeoff:** 10-min polling latency is fine for async work (tasks that take hours). Not suitable for urgent delegation.

**When to build:** when an actual client needs it. A bespoke heartbeat prompt is good enough as an ad-hoc solution until the pattern recurs across multiple clients.
