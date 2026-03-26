# Task OS — Developer CLAUDE.md

Task OS is Justin's personal task management system: a local SQLite database with an MCP server (for Claude integration) and an Electron/React UI.

---

## Architecture

```
~/IdeaProjects/task-os/
├── api.js                  ← HTTP backend (was web.js), port 3456
├── mcp/
│   └── server.js           ← MCP server (connected to Claude Code CLI)
├── ui/                     ← Vite + React + TypeScript frontend, port 5173
│   └── src/
│       ├── components/     ← TaskList, TaskRow, TaskSection, TaskDetail, etc.
│       ├── lib/            ← constants, utilities
│       └── api.ts          ← frontend API client
├── plan/                   ← Planning docs
│   ├── EVOLUTION.md        ← Running log of shipped features and known gaps
│   ├── ARCHITECTURE.md     ← v2 vision (Automerge, Tauri, sync relay)
│   └── FUTURE_IDEAS.md     ← Deferred ideas
└── assets/                 ← App icon source files
```

---

## Running Locally

```bash
cd ~/IdeaProjects/task-os
npm run electron-dev        # starts api.js + Vite + Electron all at once
```

- Backend: `api.js` on port 3456
- Frontend: Vite dev server on port 5173
- Electron: wraps the Vite frontend

---

## Database

SQLite at `~/IdeaProjects/task-os/db/tasks.db`. Schema is managed via inline migrations in `api.js` (`migrate()` function at the top). Migrations use `ALTER TABLE ... ADD COLUMN` wrapped in try/catch so they're idempotent.

**Key fields:** `id`, `title`, `status`, `context`, `due_date`, `surface_after`, `sort_order`, `my_priority`, `energy_required`, `recurrence`, `parent_id`, `task_type`, `source_url`, `links`, `notes`, `project`, `created_at`, `last_touched_human`

**Statuses:** `active`, `done`, `snoozed`, `archived`
**Task types:** `task`, `event`, `reminder`
**Contexts:** stored in the `contexts` table. Use `list_contexts` to see all registered contexts. Use `create_context` to register a new one. Default contexts: `monroe`, `biztobiz`, `pirateandfox`, `silvermouse`, `flightdesk`, `personal`, `internal`.

---

## MCP Server

Registered in `~/.claude.json` under `mcpServers.task-os`. Restart Claude Code to pick up server changes.

The MCP tools are the primary interface for Claude to interact with Task OS during PM sessions. All task management in the project-manager repo goes through these tools.

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
