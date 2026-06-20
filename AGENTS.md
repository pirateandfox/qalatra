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

## Key Behaviors & Gotchas

- `sort_order` controls priority view ordering — `ORDER BY sort_order ASC NULLS LAST` is the primary sort for active tasks
- Events (`task_type = 'event'`) are permanent dated records — never go overdue, never get status transitions
- `surface_after` is strictly for snoozing existing tasks — never set it when creating a new task
