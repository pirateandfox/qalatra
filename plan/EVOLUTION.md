# Task OS — Evolution Notes

## Unreleased — Light/dark mode + configurable color tokens

- **Architecture**: Color token system in `ui/src/lib/theme.ts` — 9 named tokens (`bg`, `surface`, `surface2`, `border`, `text`, `muted`, `accent`, `panelBg`, `inputBg`) with full dark and light presets.
- **ThemeProvider** (`ui/src/lib/ThemeProvider.tsx`): React context that reads mode + per-token overrides from `localStorage`, merges with the active preset, and applies all tokens as CSS custom properties on `:root` via `style.setProperty`. Applied synchronously in `main.tsx` before first render to prevent flash.
- **Mode selection**: System (follows OS preference, watches `prefers-color-scheme` changes), Light, or Dark. Persisted in `localStorage`. Header has a ◑/☀/☾ cycle button. Settings panel has a 3-way mode selector.
- **Token editor** in Settings → Appearance: color pickers for each of the 9 tokens, live preview, "Reset to Dark" / "Reset to Light" / "Reset to Preset" buttons.
- **CSS updated**: All hardcoded background/text/border colors in component CSS files replaced with `var(--panel-bg)`, `var(--input-bg)`, `var(--text)`, `var(--muted)` etc. Semantic status colors (red/amber/green for error/warning/success) kept hardcoded since they don't vary by theme.

## 1.0.23 — Fix SQLite busy_timeout on openDb (2026-03-28)

- **Root cause**: `openDb()` in `mcp/db.js` called `db.pragma('journal_mode = WAL')` and `initSchema()` with `busy_timeout = 0` (default). When API and MCP processes start simultaneously, the process that loses the WAL write lock race fails instantly with `SQLITE_BUSY` — no retry, silent error. This left `_db = null` in the API, causing every subsequent request to fail.
- **Fix**: Move `db.pragma('busy_timeout = 5000')` to the top of `openDb()`, before `journal_mode` and `initSchema()`, so both processes wait up to 5s per lock acquisition instead of failing immediately.

## 1.0.22 — Definitive production connectivity fix (2026-03-28)

- **Root cause (final)**: `server.listen()` was called AFTER `getDb()` → `migrate()`. On first launch, `migrate()` blocks the Node.js event loop for up to 60s (each of 12+ `ALTER TABLE` statements waits up to `busy_timeout = 5000` ms for WAL write locks held by the simultaneously-starting MCP process). Electron's 15s poll expired before the port was ever bound.
- **Fix 1**: Move `server.listen()` BEFORE `getDb()` in `api.js`. Wrap DB init in `setImmediate()` so the port binds immediately on startup; migrations run in the background.
- **Fix 2**: Switch production Electron window from `win.loadURL('http://127.0.0.1:3456')` to `win.loadFile('ui/dist/index.html')`. UI now loads from disk — zero dependency on the API being ready for initial render. Eliminates the whole retry loop.
- **Fix 3**: Add `Access-Control-Allow-Origin: *` CORS headers to `api.js` request handler so `file://` origin requests from the renderer are accepted.
- **Fix 4**: Expose `apiBase = 'http://127.0.0.1:3456'` via `preload.cjs` contextBridge so the renderer knows the absolute API URL.
- **Fix 5**: Add `API_BASE` constant to `ui/src/api.ts` and prefix every `fetch()` call and WebSocket URL across all UI files (`api.ts`, `DetailPanel`, `HabitInlineRow`, `HabitRow`, `HabitsView`, `TaskList`, `Terminal`, `Settings`, `EmailPreview`, `MdView`) so all requests use absolute URLs in production.

## 1.0.21 — Production connectivity fix (2026-03-27)

- **Root cause**: API server and MCP server both bound to `127.0.0.1` (IPv4 only). On macOS Monterey+, `/etc/hosts` maps `localhost` to both `127.0.0.1` AND `::1`. Electron's Chromium renderer may resolve `localhost` to `::1` first; with nothing listening on IPv6, connections hang. This caused "Loading..." forever on any machine that wasn't Justin's dev box.
- **Fix 1**: Changed `server.listen(PORT, '127.0.0.1')` → `server.listen(PORT)` in both `api.js` and `mcp/http-server.js`. Node.js now listens on `::` (dual-stack), accepting both IPv4 and IPv6 connections.
- **Fix 2**: Changed `win.loadURL('http://localhost:3456')` → `win.loadURL('http://127.0.0.1:3456')` to force IPv4 directly, eliminating the resolution ambiguity.
- **Fix 3**: Added `did-fail-load` retry loop (up to 20 retries × 500ms). If the API isn't ready when the window first opens, the window retries instead of showing a dead error page.
- **Fix 4**: Extended the API ready-check polling from 20 × 200ms (4s) to 75 × 200ms (15s). First launch on a new machine needs time for DB schema init.

## 1.0.20 — SQLite singleton fix (2026-03-28)

- **Root cause**: `api.js` called `openDb()` on every request, which ran `initSchema()` + `migrate()` (15+ SQL writes) on every `/api/tasks` hit. Multiple simultaneous open DB connections in WAL mode caused write-lock contention that could stall the event loop indefinitely, manifesting as "loading..." forever on the remote x64 machine.
- **Fix**: Replaced all per-request `openDb()` calls with a singleton `getDb()` — one connection opened once, migrations run once at startup. Added `busy_timeout = 5000` pragma.
- **Also fixed**: Hardcoded logos path (`/Users/justinhandley/IdeaProjects/project-manager/logos`) now falls back to `settings.logosDir` or that default path (configurable).
- **Added**: Request logging for `/api/tasks` to help diagnose future hangs.

A running list of ideas, rough edges, and improvements to iterate on as we use the system.

---

## Known Gaps (discovered in first real use)

_All resolved. See Shipped section._

---

## Immediate Next (before / during first real use)

_All resolved._

---

## Web UI Improvements

- **Context registration** (2026-03-20) — `contexts` table in SQLite seeds 7 defaults on first run. `GET/POST/PUT/DELETE /api/contexts` endpoints. `create_context` MCP tool. `list_contexts` upgraded to JOIN against table so it returns `label` + `color` alongside task counts. UI reads contexts from API via `ContextsProvider` React context — dropdowns in CreateTask and DetailPanel are now dynamic. All badge rendering (`TaskRow`, `TaskList`, `BacklogView`, `EventCard`, `MeetingView`) uses `useContexts()`. Settings panel has a full Contexts management section: color picker, edit, delete, add new.
- **Full rrule.js recurrence** (2026-03-10) — replaced simple `daily|weekly|monthly` with full RRULE support via `rrule.js`. Stores `FREQ=MONTHLY;BYMONTHDAY=1` style strings. Backward compatible with legacy shorthands. Picker in detail panel: daily, weekdays, weekly (day checkboxes), monthly (day of month). Preview shows human-readable text + next occurrence date. `nextRecurrenceDate` and `rruleToText` in `mcp/db.js`. First task: Cursor invoices on 1st of month.
- **Editable due date in detail view** — clicking a task title opens the detail panel, but there's no way to set/change `due_date` from there. Should be an inline date input (or datetime-local) directly in the detail view so you don't have to ask Claude to update it.

---

## Tool UX Improvements

- **Bulk triage** — `snooze_all_active` or `defer_context` to mass-push a context's tasks when you know a client is on hold. One call instead of N.
- **`get_tasks_by_source`** ✅ (2026-03-15) — look up tasks by source system + optional context/status/source_id. e.g. "all asana tasks in monroe", or dedup check by exact source_id.
- **`list_tasks`** — a simple paginated list with optional filters, separate from `search_tasks`. Search implies keyword; list implies browse.
- **`get_context_summary`** — count of active/backlog/snoozed per context. Good for "what's the Monroe load right now?" questions.

---

## Shipped

- **Events are records, not tasks** (2026-03-13) — Events (`task_type = 'event'`) are treated as permanent dated records, not action items. `task_type != 'event'` is now applied universally across all active task queries: overdue, due_today, active_count, by_context, still_active, get_todays_tasks, get_overdue_tasks, end_of_day_triage. Events stay pinned to their date indefinitely with no status transitions needed. Added `end_time` (HH:MM) field to schema for start/end metadata and future calendar-sync readiness.

- **`delete_task` + `list_contexts` MCP tools** (2026-03-15) — `delete_task` permanently removes a task and its subtasks (mirrors the existing HTTP DELETE endpoint). `list_contexts` returns all contexts with active/snoozed/backlog/done counts — useful at session start and briefings.

- **`create_task` accepts `status`** — already implemented; `status` defaults to `active`.

- **Events excluded from overdue** (2026-03-13) — `morning_briefing` and `afternoon_briefing` overdue queries now filter out `task_type = 'event'`. Past events stay pinned to the day they occurred in the UI; they should never surface as overdue items in briefings.

- **Parent/child task support in briefings** (2026-03-13) — `overdue` and `due_today` now include `parent_id` in results. AI should format child tasks with `--` prefix instead of `-` and not treat them as duplicates of their parent. `update_task` now accepts `parent_id`.

- **`recurrence`** (2026-03-08) — `daily | weekdays | weekly | monthly`. Added to schema, `create_task`, `update_task`. `complete_task` now auto-spawns the next occurrence with `start_date` set to the next recurrence date. Habit tasks created: TryHackMe (weekdays), Vimified (weekdays), Instrument practice x2 (daily).

## Schema Candidates

- **`estimate`** (number, hours) — mirrors Asana's AI-enabled estimation model (1hr = Claude handles it, 2hr = some complexity, 8/16/24 = multi-day). Would make daily load planning much easier.
- **`assigned_to`** (text) — Justin vs. Valentin vs. Dillon. Would enable filtering "what's mine today" vs. "what's waiting on someone else."
- **`blocked_by`** (text, task_id or freeform) — flag tasks that can't move until something else resolves.
- **`linked_url`** — separate from `source_url`. For tasks that are manual but have a related Slack thread, email, or doc.

---

## Daily Rhythm Observations (to be filled in as we use it)

_Add notes here after real sessions — what felt clunky, what was missing, what worked better than expected._

- ...

---

## Bigger Picture Ideas

- **`assigned_to`** — Justin vs. Valentin vs. Dillon. Only relevant once other people's tasks are in the system (via Asana sync or manual entry). Depends on sync layer landing first.
- **Weekly review** — `week_in_review` MCP tool or just a prompt pattern: what was completed, what slipped, what's been in backlog too long. Probably just a good system prompt, not a code change.

_Sync layer, Reflect integration, Slack/Missive intake — moved to FUTURE_IDEAS.md. All superseded by existing MCP connections._
