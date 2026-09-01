# Qalatra - Developer AGENTS.md

Shared source of truth for Codex and Claude agents working in this repository.

Qalatra is Justin's personal task management system: a local SQLite database owned by Qalatra Server, an MCP server for Claude integration, and an Electron/React UI client.

---

## Architecture

```
~/IdeaProjects/qalatra/
├── electron-main.js        ← Electron main process; starts Qalatra Server, terminal pty, updater, app menu
├── server/                 ← Authenticated headless HTTP API; owns /api/v1, DB access, MCP child, workers, backups, tokens, service management
│   └── http.js             ← Shared HTTP response, CORS, body parsing, and file streaming helpers
├── db-worker.js            ← SQLite worker used by Qalatra Server; handles DB calls off the server event loop
├── s3.js                   ← S3/R2 attachment helpers
├── docs/
│   ├── capabilities.md     ← Capability registry guide: agent.config metadata, permissions, delegation, MCP/API usage
│   ├── executive-agent-rollout.md ← Handoff guide for enriching real agents and using Qalatra as an executive-assistant layer
│   └── linux-remote-install.md ← Verified Linux headless install, Cloudflare tunnel, smoke tests, and MCP setup
├── scripts/
│   ├── install-linux-server.sh ← Installs Qalatra Server as a Linux user systemd service
│   └── install-cloudflare-tunnel.sh ← Installs a Qalatra-only cloudflared user service for the API
├── mcp/
│   ├── http-server.js      ← MCP HTTP server, port 3457 (primary, used by Claude Code)
│   ├── http-server-entry.cjs ← CJS shim so `node` can load ESM http-server.js
│   ├── server.js           ← Legacy stdio MCP server (kept as fallback)
│   ├── db.js               ← SQLite helpers, schema migrations, recurrence logic
│   └── tools/              ← MCP tool definitions (tasks, triage, briefing, notes, etc.)
├── ui/                     ← Vite + React + TypeScript frontend, port 5173
│   └── src/
│       ├── components/     ← TaskList, TaskRow, TaskSection, DetailPanel, Settings, etc.
│       ├── lib/            ← constants, utilities
│       ├── mdpdf/          ← Markdown editor/PDF export overlay
│       └── api.ts          ← frontend API client; talks to Qalatra Server by token-authenticated HTTP
├── plan/                   ← Planning docs
│   ├── AGENT_OPERATING_LAYER_ROADMAP.md ← Strategic plan for personal vs agent-node roles, external intake, handoffs, and Qalatra-to-Qalatra messaging
│   ├── EVOLUTION.md        ← Running log of shipped features and known gaps
│   ├── ARCHITECTURE.md     ← v2 vision (Automerge, Tauri, sync relay)
│   ├── EXPO_MOBILE_ROADMAP.md ← Plan to add Expo iOS/iPad/Android apps via a shared @qalatra/shared core (remote-only client; desktop unchanged)
│   ├── WEB_AND_AUTH_ARCHITECTURE.md ← Deferred plan: hosted web app (ui/ at app.qalatra.com), accounts/billing via qalatra.com (NestledJS), paid tier + Apple IAP notes
│   └── FUTURE_IDEAS.md     ← Deferred ideas
├── electron-builder.yml    ← Packaging config (DMG, signing, publish). The `files:` list is **explicit** — any new root-level JS file imported by Electron entry points must be added here or the app will crash on launch. `scripts/check-imports.mjs` enforces this in CI and via `npm run check-imports`.
├── entitlements.mac.plist  ← macOS hardened runtime entitlements
├── scripts/notarize.mjs    ← Apple notarization hook (runs after electron-builder signs)
└── assets/                 ← App icon source files
```

---

## Running Locally

```bash
cd ~/IdeaProjects/qalatra
npm run electron-dev        # kills stale processes, rebuilds native modules, starts Vite + Electron
```

- Frontend: Vite dev server on port 5173 (Electron wraps it)
- API server: port 3456, started by Electron using `process.execPath + ELECTRON_RUN_AS_NODE=1`
- MCP server: port 3457, started by Qalatra Server as a child process
- UI data calls go through authenticated `/api/v1` HTTP endpoints, not Electron data IPC
- Settings → Instances can leave the local server/MCP running after Electron quits or install an OS start-at-login service:
  - macOS: `~/Library/LaunchAgents/com.qalatra.server.plist`
  - Linux: `~/.config/systemd/user/qalatra-server.service`
  - Windows: per-user logon Scheduled Task named `Qalatra Server`
- In `electron-dev`, service management is disabled by default so dev runs the current checkout's server. Use `QALATRA_DEV_USE_SERVICE=1` only for explicit service testing.

**Native module builds:**

`electron-dev` runs `rebuild:electron` automatically. That's all that's needed for local desktop dev because Qalatra Server, `db-worker.js`, and MCP all use the Electron binary's Node runtime.

Linux server installs use `npm ci --ignore-scripts` and then `npm run rebuild:node` so `better-sqlite3` and `node-pty` are compiled for system Node instead of Electron.

**If the API or MCP server hangs**, kill it and let Electron respawn:

```bash
lsof -ti :3456 | xargs kill -9
lsof -ti :3457 | xargs kill -9
```

**Linux server install:**

```bash
curl -fsSL https://raw.githubusercontent.com/pirateandfox/qalatra/develop/scripts/bootstrap-linux-server.sh | bash
```

Set `QALATRA_TUNNEL_HOSTNAME=qalatra.example.com` on that command to install the Qalatra Cloudflare tunnel during bootstrap. The tunnel script creates a separate `qalatra-cloudflared.service` user service so it does not overwrite an existing server-admin tunnel. It exposes only the Qalatra API origin (`127.0.0.1:3456` by default); never publish MCP port `3457`.

Qalatra servers use two separate Cloudflare trust channels:

- Operator access hostnames for SSH/noVNC belong behind Cloudflare Access, SSH keys, and any VPN/email policies needed for Justin or an ops user.
- The Qalatra API hostname must not be added to that Access application. It should be reachable through Cloudflare Tunnel without an Access login wall, because Qalatra's bearer tokens are the product auth layer used by Electron, web, and mobile clients.

It is fine for `~/.cloudflared/cert.pem` to already exist from the operator setup. `install-cloudflare-tunnel.sh` reuses that account login, creates or reuses the separate `qalatra-api` tunnel, and writes separate Qalatra-only service/config files.

---

## Database

SQLite at `~/IdeaProjects/qalatra/db/tasks.db` in dev. Schema is managed via inline migrations in `db-worker.js` for Qalatra Server and `mcp/db.js` for MCP tools. Migrations use `ALTER TABLE ... ADD COLUMN` wrapped in try/catch so they're idempotent.

**Key fields:** `id`, `title`, `status`, `context`, `due_date`, `surface_after`, `sort_order`, `my_priority`, `energy_required`, `recurrence`, `parent_id`, `task_type`, `source_url`, `links`, `notes`, `project`, `created_at`, `last_touched_human`

**Statuses:** `active`, `done`, `snoozed`, `archived`
**Task types:** `task`, `event`, `reminder`
**Contexts:** stored in the `contexts` table. Use `list_contexts` to see all registered contexts. Use `create_context` to register a new one. Default contexts: `monroe`, `biztobiz`, `pirateandfox`, `silvermouse`, `flightdesk`, `personal`, `internal`.

---

## MCP Server

Runs as an HTTP server on port **3457** (StreamableHTTP transport). Registered in `~/.claude.json` as:
```json
{ "type": "http", "url": "http://localhost:3457/mcp" }
```

The port and `~/.claude.json` entry can be changed in the app's Settings panel (MCP Server section) — it saves the port and rewrites the entry automatically. Restart Claude Code after changing.

The MCP tools are the primary interface for Claude to interact with Qalatra during PM sessions. All task management goes through these tools.

---

## Git & Release Workflow

**Repo:** `github.com/pirateandfox/qalatra`

**Branch strategy:** single `develop` branch — commit directly, tag to release when ready.

**Cutting a release:**
```bash
# 1. Bump version in package.json to match the tag you're about to create
#    (version in package.json = what shows in the app and on the release)
# 2. Commit and push
git add package.json && git commit -m "Bump version to 1.0.x"
git push origin develop
# 3. Tag and push — this triggers the CI build
git tag v1.0.x && git push origin v1.0.x
```

The tag must match `package.json` version or the release will show the wrong version number.

Tagging triggers the GitHub Actions workflow (`.github/workflows/release.yml`) which:
- Builds the macOS DMG + ZIP (arm64 + x64)
- Code-signs with Developer ID certificate
- Notarizes via Apple notarytool
- Publishes to GitHub Releases

The in-app auto-updater (`electron-updater`) checks GitHub Releases on launch and prompts to install when a new version is available.

---

## Development Autonomy

**You have full autonomy to evolve this system** — add fields, add MCP tools, restructure queries, fix edge cases, improve the UI. You do not need to ask permission before making changes. If you spot something that would make the system work better, just do it and tell Justin what you changed and why.

The only exception: **destructive schema changes** (dropping columns, renaming existing fields that have live data) — flag those briefly before running.

**Keep `plan/EVOLUTION.md` updated** as you make changes — it's the running record of what was built, why, and what's next.

---

## Recurrence

Stored as RRULE strings (e.g. `FREQ=MONTHLY;BYMONTHDAY=1`). Legacy shorthands (`daily`, `weekdays`, `weekly`, `monthly`) still work. On complete/skip, next occurrence auto-spawns with `due_date = nextDate`. `nextRecurrenceDate` and `rruleToText` live in `mcp/db.js`.

**Never set `surface_after` on recurring tasks** — use only `due_date`. Setting `surface_after` on a recurring task causes it to appear in "Waking Up" incorrectly.

---

## Building the App Icon

```bash
# Export from Icon Composer → assets/Icon-iOS-Dark-1024x1024@1x.png
node assets/build-icon.mjs
```

---

## Agent Runtimes

Agent jobs run in one of two modes, decided by whether `agent.config`'s `command` contains a
placeholder (`{spec_file}`, `{description}`, `{title}`):

- **Template mode** — the command is run verbatim. Qalatra injects nothing and treats stdout as the
  result. Use this for wrapper scripts and dispatch commands (`flightdesk register ...`).
- **Prompt mode** — Qalatra owns the argv: it appends the prompt, the structured-output flag, and
  `--resume` on follow-ups, then parses the agent's output for the result text and a session id.

Prompt mode is CLI-specific, so it goes through an adapter in `server/agent-runtimes.js`. Pick one
with `"runtime"` in `agent.config`:

| runtime | spawns | resume | notes |
|---|---|---|---|
| `claude` (default) | `claude <flags> -p <prompt> --output-format stream-json --verbose` | `--resume <session_id>` | Every event carries `session_id`. |
| `codex` | `codex exec <flags> --json <prompt>` | `codex exec resume <id> <prompt>` | `--json` is JSONL; session id arrives in the first `thread.started` event. |
| `raw` | the command untouched | none | Explicit opt-in to template-mode semantics in a non-placeholder command. |

Omitting `runtime` means `claude`, so existing configs are unaffected. An unknown value logs a
warning and falls back to `claude`.

### Streaming and why it matters

Output is consumed **incrementally**, not buffered and parsed at exit. That is what makes a killed
job recoverable: `--output-format json` emits only at exit, so a SIGKILLed agent took its session id
to the grave and the work could not be continued. Under stream-json the session id lands within
moments of launch, so a timed-out job stays resumable. Verified end-to-end — a job SIGKILLed 9s in
resumed cleanly and the agent still knew its original task.

Set `"stream": false` in agent.config to fall back to the single-blob form without a code change.
Claude also supports `--include-partial-messages` for token-level events; not enabled, since whole
assistant messages are enough to recover partial work and cost far fewer events.

Streaming also bounds memory. Consumers keep only a session id, the final result, and a 64 KB tail
instead of accumulating every byte of a 60-minute run; stderr is capped at 256 KB, and whole-output
buffering (`raw`, `stream: false`) at 5 MB.

### Timeouts

- `timeout_minutes` — wall-clock, default **60**. A hung job holds one of only
  `MAX_CONCURRENT_JOBS` (3) slots for the full window, so raise it deliberately.
- `idle_timeout_minutes` — **opt-in**, off by default. Kills the job after N minutes with no output
  at all. A wall clock can't tell a productive 50-minute run from one wedged after 90 seconds, but
  streamed output can. Off by default because one long tool call (a full test suite, a big build)
  legitimately emits nothing for a while.

**Agents run detached, in their own process group.** SIGKILL to the tracked pid is not enough: the
login shell `exec`s through to the agent CLI, so that pid *is* the agent — but the agent's own
children (a test run, a build, an MCP server it started) get reparented and keep running. Measured
directly: killing the pid alone left the tool subprocess alive. Timeouts therefore call
`killProcessTree`, which signals the negative pid to take the whole group down (`taskkill /T` on
Windows). Because detaching also escapes the signal the service manager sends to Qalatra's own
group, `shutdown()` in `server/index.js` calls `killRunningAgentProcesses()` — without that, a
service restart would strand live agents holding files, ports, and API quota.

**Agents run in their own cgroup slice (Linux).** Qalatra Server, its MCP child, tmux sessions and
every agent otherwise share one cgroup, and `memory.high` throttles reclaim across the whole group
without distinguishing the hog — so one runaway agent starves `:3457` while the box looks healthy.
Agents are therefore spawned through `systemd-run --user --scope --slice=qalatra-agents.slice`.
Only the spawner can do this: cgroup membership follows process ancestry, so Ansible cannot move an
agent into a slice.

The launcher is *probed*, not platform-detected (following `ensureTmuxServer()` in
`terminal-sessions.js`) — `systemd-run` needs a live user manager and `XDG_RUNTIME_DIR`, not merely
Linux. macOS, non-systemd Linux and no-user-manager all fall back to the previous spawn unchanged.
`killProcessTree` needs no change: verified on a live box that `--scope` execs through, so the
tracked pid stays the agent's own shell and remains its process-group leader — a shell → agent →
tool-subprocess tree showed three cgroup members before the kill and zero after.

**The slice needs limits from the fleet, and the code refuses to run without them.** An unknown
`--slice=` is auto-created with *no* limits, so using the launcher before the fleet has installed the
slice would move agents out of the server's capped cgroup into an uncapped one — protecting the MCP
endpoint but leaving a runaway completely unbounded, which is a worse blast radius than not doing
this at all. `agentLauncher()` therefore checks that the slice has a finite `MemoryMax` and falls
back to the previous spawn when it does not: placement without limits is strictly worse than staying
put. That check is deliberately not cached, so installing the slice takes effect on the next job
without waiting for a server restart, and removing it reverts the same way. The ordering between the
fleet role and the code is therefore a tidiness preference, not a safety requirement. `qalatra-agents.slice` is installed
with per-host `MemoryHigh`/`MemoryMax`/`MemorySwapMax` by `roles/mcp_hygiene` in `qalatra-fleet`.
Verify placement with `cat /proc/<agent-pid>/cgroup` — it should name `qalatra-agents.slice`, not
`qalatra-server.service`. Launch diagnostics report the active launcher, or "none".

Either limit ends the job as status **`timed_out`** with `terminated_by = 'timeout'` — its own
terminal status alongside `orphaned`, so Qalatra's own resource limits don't inflate agent failure
counts. Because the session id survives, `timed_out` jobs are included in the resume lookup
(`db-worker.js` `getQueuedJobs`), so the next message on the task continues where it left off.

**Adding a runtime:** implement `buildArgs({ baseArgs, prompt, resumeMessage, resumeId, stream,
onWarn })` and `createConsumer({ stream }) -> { push(chunk), finish() -> { result, sessionId } }`,
then register it in `RUNTIMES`. Use the shared `createNdjsonConsumer` helper for a JSONL CLI — it
handles cross-chunk line assembly and non-JSON noise. Everything else
in the job pipeline — env, spawn, timeout, output rules, lifecycle — is provider-neutral.

**Gotcha:** `codex exec resume` accepts only a subset of `codex exec`'s flags (no `--sandbox`,
`-C/--cd`, `--profile`) and hard-errors on the rest, so the adapter drops unsupported ones on
resumed turns and logs what it dropped. Dropping degrades toward Codex's *default* sandbox, never
toward more access.

---

## Key Behaviors & Gotchas

- `sort_order` controls priority view ordering — `ORDER BY sort_order ASC NULLS LAST` is the primary sort for active tasks
- Events (`task_type = 'event'`) are permanent dated records — never go overdue, never get status transitions
- `surface_after` is strictly for snoozing existing tasks — never set it when creating a new task
