# Qalatra — Evolution Notes

## 1.2.3 — Heartbeats: persistent interval-based background agents (2026-05-07)

New **Heartbeats** feature — always-on agent runners that fire on a fixed interval (5 min – 24h) and can be paused/resumed at any time.

### Architecture
- New `heartbeats` table: `id, title, description, agent_path, prompt, interval_minutes, active, last_run_at, next_run_at`
- `agent_jobs.heartbeat_id` column added: heartbeat jobs are regular agent jobs with `task_id = NULL` and a `heartbeat_id` FK
- Scheduler in `ipc-handlers.startBackgroundWorkers`: runs every 60s, calls `getDueHeartbeats()`, creates an agent job + updates `next_run_at` for each due heartbeat. Skips any heartbeat that already has a queued/running job to prevent pile-up
- MCP tools in `mcp/tools/heartbeats.js`: `list_heartbeats`, `create_heartbeat`, `update_heartbeat`, `toggle_heartbeat`, `delete_heartbeat`, `list_heartbeat_jobs`

### UI
- **⚡ Heartbeats** sidebar tab (below Habits)
- Card-based list with pulse indicator (animated blue when running, green when active, gray when paused)
- Play/pause toggle button per card
- Expandable job history showing last 10 runs with status and result preview
- Inline create and edit forms with interval picker (5min → 24h)

## 1.2.0 — Reading view, task type toggle, smart new-task form, Code view idle section (2026-05-06)

### Reading view (`task_type = 'reading'`)

New `task_type` value `'reading'` routes tasks to a dedicated **📖 Reading** sidebar section, keeping them off the Priority view. Same pattern as the Coding view.

- Sidebar nav item added between Code and Projects
- `getReadingTasks()` in `db-worker.js`: queries `task_type = 'reading'`, ordered by priority then created date
- `tasks:reading` IPC handler + `fetchReadingTasks()` in `api.ts`
- `ReadingView.tsx`: simple list, no polling needed (no agent jobs)
- MCP `create_task` / `update_task` / `search_tasks` all accept `reading` as a `task_type` value

### Task type toggle in detail panel

Tasks of type `task` (the default) now show a **Type** row in the detail panel with ⌨ Coding and 📖 Reading pills. Clicking a pill toggles that type on; clicking it again resets back to `task`. Hidden for events and reminders.

Previously, setting `task_type = 'coding'` could only be done via MCP or by assigning an agent with `"coding": true`. Now any task can be manually routed to the Code or Reading view from within the UI.

### Code view: idle tasks now visible

**Bug fix (pre-existing):** `CodeAgentsView` only rendered Running and Queued sections. Tasks with `task_type = 'coding'` but no active agent job (idle between pipeline stages, completed job, failed job) were fetched but never displayed — blank screen with tasks.

Added an **⌨ Idle** section for all coding tasks not currently running or queued. The empty state message also updated from "No active code agents running" to "No coding tasks."

### New task form improvements

- **Project field** is now a combobox (`<input list>` + `<datalist>`) instead of free text. Options are filtered to projects whose `context` matches the selected context (or projects with no context). Free-text entry still works for new project names.
- **Agent dropdown** now filters live by both context **and** project. As context or project changes, the agent list narrows in real time. If the currently-selected agent no longer matches, it's cleared automatically.
- Changing context clears project and agent (since both lists change).

### Files changed

- `ui/src/types/task.ts` — added `'reading'` to `task_type` union
- `db-worker.js` — added `getReadingTasks()`; added to exports
- `ipc-handlers.js` — added `tasks:reading` handler
- `ui/src/api.ts` — added `fetchReadingTasks()`; added `fetchProjectSummaries` import to `CreateTask`
- `ui/src/components/ReadingView.tsx` — new component
- `ui/src/components/Sidebar.tsx` — added `'reading'` to `NavSection`, 📖 Reading nav item
- `ui/src/App.tsx` — routes `nav === 'reading'` to `ReadingView`
- `ui/src/components/DetailPanel.tsx` — added `SPECIAL_TYPES` / `SPECIAL_TYPE_LABELS`; Type row with Coding + Reading pills
- `ui/src/components/CodeAgentsView.tsx` — added Idle section; fixed empty-state message
- `ui/src/components/CreateTask.tsx` — project combobox with context-filtered datalist; agent filter includes project; `handleContextChange` / `handleProjectChange` handlers
- `mcp/tools/tasks.js` — updated all `task_type` descriptions to include `reading`

## 1.1.1 — Sidebar nav, Code view, coding task type, MCP auto-restart (2026-05-05)

### Sidebar navigation

The top tab bar has been replaced with a 160px left sidebar. Nav items:

| Item | Key | Shows |
|------|-----|-------|
| ★ Priority | `priority` | Tasks needing human attention today |
| ⌨ Code | `code` | All tasks with `task_type = 'coding'` |
| ⊞ Projects | `project` | Tasks grouped by context → project |
| ≡ Backlog | `backlog` | Backlog tasks |
| ◎ Habits | `habits` | Daily habits |

The sidebar handles the macOS traffic-light drag zone (top 44px). Utility buttons (New Task, Daily Note, Settings, Theme) moved to the sidebar bottom. The date nav and terminal/refresh controls remain in a slim content-area header above the main panel.

The single `nav: NavSection` state in `App.tsx` replaces the previous `screen` + `view` pair.

### `task_type = 'coding'` and the Code view

**The problem:** Autonomous coding agents run for long periods (15–60+ minutes) with only occasional human review points. They cluttered the Priority view, making it hard to see what actually needed attention.

**The solution:** A new `task_type` value `'coding'` routes tasks to the Code view permanently. Priority view excludes `task_type = 'coding'` entirely. The Code view is the holding area for anything in the coding pipeline.

#### Feedback loop (human review)

When a coding task needs human review, the monitoring agent calls:
```
update_task({ task_id: "...", task_type: "task" })
```
This moves the task from Code → Priority, where it appears like a normal task. Once the human gives feedback and hands it back to the pipeline, the agent sets `task_type` back to `'coding'` to return it to the Code view.

#### Auto-set on agent start

Add `"coding": true` to an agent's `agent.config`. When the Qalatra job runner starts that agent's job, it automatically sets `task_type = 'coding'` on the task:

```json
{
  "name": "FlightDesk Builder",
  "command": "node build-pipeline.js {spec_file}",
  "coding": true
}
```

No AI involvement needed — the runner does the flip as soon as it starts executing.

#### MCP tool changes

- `create_task` and `update_task`: `task_type` now accepts `'coding'` in addition to `task | event | reminder`.
- `search_tasks`: new `task_type` filter parameter. The monitoring agent can find all its work with:
  ```
  search_tasks({ task_type: "coding", status: "active" })
  ```
- `update_task` is the signal for "needs human review" — set `task_type: "task"` to surface in Priority, set `task_type: "coding"` to return to Code view.

#### Key behaviors

- Coding tasks at rest between pipeline stages stay in the Code view (not just when an agent is actively running).
- `agent_job_status` (queued/running/done/failed) still drives the visual spinner within the Code view.
- Completed/archived coding tasks disappear like normal tasks — they don't persist in the Code view.
- The sidebar badge on ⌨ Code shows the count of active agent jobs (`agent_job_status = running | queued`) from today's task data.

#### Files changed

- `ui/src/types/task.ts` — added `'coding'` to `task_type` union
- `ui/src/api.ts` — added `coding` field to `Agent` interface; added `fetchCodingTasks()`
- `db-worker.js` — added `getCodingTasks()` (queries `task_type = 'coding'`, not done/archived)
- `ipc-handlers.js` — added `tasks:coding` IPC handler; `scanAgents` includes `coding` field; job runner auto-sets `task_type = 'coding'` when `cfg.coding === true`
- `ui/src/components/CodeAgentsView.tsx` — new view component, polls every 5s when agents active
- `ui/src/components/TaskList.tsx` — `PriorityView` filters out `task_type === 'coding'`
- `mcp/tools/tasks.js` — updated `task_type` descriptions; added `task_type` filter to `search_tasks`

### MCP server auto-restart via launchd

**The problem:** The Qalatra MCP server (port 3457) had no process supervisor. A crash left it down until manually restarted. Agent tool calls during that window hung for the full timeout (observed: 60+ minutes). The coding pipeline runs every 30 minutes unattended — one crash = one wasted hour.

**The solution:** A launchd plist at `~/Library/LaunchAgents/com.qalatra.mcp.plist` supervises the MCP server process. On crash, launchd restarts it within 5 seconds.

#### Ownership model

launchd starts the MCP server at login. Electron already has an `isPortTaken(3457)` check in `startMcpServer()` — when launchd owns the port, Electron silently skips spawning its own. All requests route through the supervised process.

When Electron is also running (e.g., dev mode), both attempt the port:
- launchd service starts first (at login), takes port 3457
- Electron opens, finds port taken, skips spawning — no conflict

#### Port conflict handling

Previously, `EADDRINUSE` caused `process.exit(1)`, making launchd restart every 5 seconds and spam the log. Fixed: the server now retries internally every 30 seconds on port conflict, staying alive until the port becomes free. Real crashes still exit with code 1, triggering a launchd restart within 5 seconds.

#### Plist location

- Active: `~/Library/LaunchAgents/com.qalatra.mcp.plist`
- Repo copy: `scripts/com.qalatra.mcp.plist`

Key plist settings:
```xml
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>RunAtLoad</key><true/>
```

Node path is hardcoded to the asdf-installed binary (`~/.asdf/installs/nodejs/22.14.0/bin/node`). Update if the Node version changes.

Logs: `~/Library/Logs/qalatra-mcp.log`

To reload after changes: `launchctl kickstart -k gui/$(id -u)/com.qalatra.mcp`

#### `ping` health-check tool

A new `ping` MCP tool returns immediately with `{ ok: true, ts: "..." }`. Agents can call it before starting a pipeline run to verify MCP is reachable in <1s rather than waiting for a tool timeout to discover the server is down.

```
ping({})  →  { "ok": true, "ts": "2026-05-05T13:00:00.000Z" }
```

#### Files changed

- `mcp/tools/health.js` — new file, exports `ping` tool
- `mcp/http-server.js` — imports health tools; `EADDRINUSE` now retries every 30s instead of crashing
- `~/Library/LaunchAgents/com.qalatra.mcp.plist` — launchd service definition
- `scripts/com.qalatra.mcp.plist` — repo copy

## 1.0.73 — Inbox, collapsible sections, agent indicator (2026-04-27)

### Inbox
- Agent-created tasks can now be flagged as `inbox = 1`, placing them in a separate triage area at the top of the today view (open by default).
- Inbox tasks are excluded from the overdue/dueToday/active lists so they don't pollute the main task view.
- Each inbox task shows a **Schedule →** button that clears the inbox flag and moves it into the regular task list.
- MCP `create_task` and `update_task` both support the `inbox` boolean field.

### Collapsible Scheduled and Snoozed sections
- The today view now shows **Snoozed** (time-deferred tasks) and **Scheduled** (autorun tasks not yet fired) as collapsible sections at the bottom, collapsed by default.
- Collapse state persists across page loads via localStorage.
- Scheduled tasks (autorun with no job yet) are filtered out of the main task list and shown only in the Scheduled section.

### Agent running indicator redesign
- Replaced the tiny spinning `⟳` with a 10px amber pulsing circle for running jobs, and a hollow muted circle for queued jobs.
- The green ★ (done) and red ✕ (failed) indicators are unchanged.

### DeferredSection component
- Extracted reusable `DeferredSection` component used for Inbox, Snoozed, and Scheduled sections.
- Header style matches the Tasks section: 12px, uppercase, bold, with icon and count on the same line.
- Accepts a `defaultOpen` prop (defaults false) with localStorage override.

## 1.0.72 — Autorun timezone fix, snoozed task wake-up, meeting attachments (2026-04-29)

### Autorun timezone fix
- Fixed a bug where agent autorun tasks fired at 8 PM local time instead of their scheduled time for users in negative UTC offsets (e.g. US Eastern).
- **Root cause:** `getAutorunTasks()` in `db-worker.js` used `date('now')` (UTC) for the due-date check but `time('now', 'localtime')` (local) for the time check. For UTC-4 users, after 8 PM local the UTC date had already rolled to the next day, making the next day's task appear immediately eligible.
- **Fix:** changed `date('now')` to `date('now', 'localtime')` so both checks use local time consistently.

### Snoozed task wake-up without restart
- Snoozed tasks with a past `surface_after` are now activated every time the today view loads, not only on app startup.
- Previously the wake-up query only ran once in `migrate()` at launch. Tasks snoozed by the EOD agent overnight would not surface until the app was restarted.

### Meeting view attachments
- Attachments are now listed in the Meeting view panel below the agenda items.
- Event cards show a 📎 indicator when attachments are present.
- `attachSubtasks` now returns `attachment_count` so the indicator is available without a separate fetch.

### MCP update_task accepts `notes` as alias for `description`
- `update_task` now accepts either `description` or `notes` — whichever the agent uses. Normalised server-side before write.

## 1.0.71 — Update banner, terminal layout fix, cascade delete, full agent context (2026-04-17)

### In-app update banner
- Replaced the native `dialog.showMessageBox` update flow with a slim 32px banner at the bottom of the app.
- `autoDownload` is now `false` — finding an update never triggers a background download automatically.
- On launch and every 4 hours, the app silently polls for a new version. If one is found, the banner appears with a **Download** button.
- Manual "Check for Updates…" from the menu shows all states: checking (spinner), up to date (auto-dismisses after 3s), and error.
- Download progress shows a progress bar in the banner. Once downloaded, the banner turns green with a **Restart & Install** button.
- All states can be dismissed with ✕ except checking/downloading (which transition automatically).

### Terminal no longer overlays task list
- The docked terminal panel now participates in the flex column layout instead of floating as a fixed overlay over the content.
- Added `inline` prop to `BottomPanel` — when set, the panel is `position: relative` and pushes the layout up rather than covering it. Settings and DailyNote retain their fixed-overlay behavior.
- Removed the `paddingBottom` hack in `App.tsx` that was compensating for the overlay.

### Cascade delete fix
- Deleting a task now correctly removes all dependent records first: `notes`, `agent_jobs`, `attachments`, and `sync_log`, for both the task and any subtasks.
- Fixed in both `db-worker.js` (UI path) and `mcp/tools/tasks.js` (MCP/Claude path). Previously the UI path only cleaned `agent_jobs`, leaving notes and attachments behind and causing silent failures when FK constraints were enforced.

### Full context passed to agents
- Agent jobs now include the full task context in the prompt: title, description, attached links, attached files, and the full existing notes/conversation history.
- Applied to all three launch paths: MCP `queue_agent_job` tool, UI "Run Agent" button (`createAgentJob` in db-worker), and the autorun scheduler (`autoRunAgents` in ipc-handlers).
- `autoRunAgents` now calls `createAgentJob` directly instead of building its own minimal prompt, ensuring consistent context across all launch paths.

## 1.0.70 — Terminal & MCP stability fixes (2026-04-16)

### Terminal reopen fix
- Closing and reopening the terminal panel now works reliably every time.
- **Root cause:** the old pty's `onExit` callback fired asynchronously after the new pty was already spawned, nulling out `ptyProcess` and sending a spurious `terminal:exit` event to the renderer. This left the new pty unreachable (input silently dropped) and showed a false "Process exited" message.
- **Fix:** each `onExit` closure now captures its own `thisPty` reference and only clears `ptyProcess` / notifies the renderer if it's still the active process.

### MCP HTTP server crash fix
- The MCP HTTP server no longer crashes with `ERR_HTTP_HEADERS_SENT` when a long-lived SSE connection hits the 30-second timeout.
- **Root cause:** the timeout handler called `res.writeHead(504)` without checking `res.headersSent`. For SSE (GET) connections, headers are sent immediately when the event stream opens, so the timeout fired on a half-open connection and threw.
- **Fix:** added `!res.headersSent` guard — the timeout now just destroys the socket for already-streaming connections instead of trying to write a new status line.

## Unreleased — Project-scoped agent filtering

### agent.config `project` field
- `agent.config` now supports a `project` field alongside `context`.
- Agent picker in the detail panel filters to: global agents (no context, no project) + agents whose context matches the task AND whose project matches the task (or have no project set).
- This allows multiple repos under one context (e.g. `monroe`) to each have their own coding agents without polluting each other's task views.

### Context + project migration
- `nestled` context created. All nestled-* repos (`nestled`, `nestled-template`, `nestledjs.com`, `nestledforms.com`, `nestled-forms`) now use `context: nestled` with a per-repo `project` field in their agent.configs and plan agents.
- `mi-core` agents moved to `context: monroe, project: mi-core`.
- `tmi-shopify-3.0` agents moved to `context: monroe, project: tmi-shopify-3.0`.

## 1.0.67 — Link chips, agent output rules, recurrence + view fixes, HTTP timeout (2026-04-14)

### Link chips with labels
- All attached links now render as chips showing icon + name (e.g. "Asana", "Linear", "FlightDesk") in both the task row and detail panel. Previously icon-only.
- Unknown URLs fall back to the hostname as the label.
- `detectPlatform()` in `constants.ts` is the single source of truth for platform detection and display names.
- Platform icons updated: FlightDesk now uses its real SVG logo instead of a placeholder triangle.

### Agent output rules
- `agent.config` now supports an `output_rules` array. Rules define regex patterns to match against agent stdout and actions to take when they match.
- Currently supported action: `add_link` — extracts a capture group from the output and adds the interpolated URL as a link on the Qalatra task.
- Example: capture a FlightDesk task ID from `flightdesk register` output and attach the FlightDesk task URL automatically.
- Rules are per-agent and live in the agent's own repo — nothing ships globally with Qalatra.
- Rule format:
  ```json
  {
    "output_rules": [
      {
        "pattern": "Task ID: ([a-f0-9-]{36})",
        "action": "add_link",
        "url": "https://yourapp.com/tasks/{1}"
      }
    ]
  }
  ```

### Bug fixes
- **Weekly recurrence cadence**: `nextRecurrenceDate` now uses `baseDate` as `dtstart` with `rule.after(dtstart, false)` (exclusive) instead of day+1 with inclusive. `FREQ=WEEKLY` without `BYDAY` was anchoring to the completion day's weekday rather than the original task day, causing a Monday task completed on Tuesday to recur on Tuesday. Now correctly recurs on the following Monday.
- **Future view showing completed tasks**: The future `scheduled` query now filters `status = 'active'` only. Previously `status != 'snoozed'` allowed done tasks (e.g. tasks previously deferred which had a future `due_date` set) to appear in forward date views after being completed.

### MCP HTTP server timeouts
- Per-request timeout of 30 seconds: if a request hasn't completed, the server sends a `504` JSON-RPC error and destroys the socket. Prevents stale connections from blocking indefinitely.
- `keepAliveTimeout` (65 s) and `headersTimeout` (31 s) added to the server instance.

## 1.0.60 — Habit recurrence_days: specific day scheduling (2026-04-04)

- **New field**: `recurrence_days TEXT` added to the `habits` table (migration runs on startup). Stores comma-separated day abbreviations: `mon,wed,fri` or `tue,thu` etc.
- **Filtering logic**: `isHabitDueOn()` in both `db-worker.js` and `mcp/tools/habits.js` checks `recurrence_days` first — if set, only fires on those days. Existing habits with no `recurrence_days` behave exactly as before.
- **Habits screen shows all habits**: `listHabits` no longer filters by due-today — all active habits are always shown. The task screen inline habits list still filters to due-today only.
- **Day picker UI**: When creating or editing a habit with recurrence = "Weekdays", a row of day chips (Mo Tu We Th Fr Sa Su) appears. Selected days are highlighted green and stored as `recurrence_days`.
- **Inline edit UI**: Each `HabitRow` now has a ✎ button (visible on hover) that expands an inline edit form — title, notes prompt, recurrence + day picker. Also includes an Archive button.
- **Day badge**: Habits with `recurrence_days` show a compact badge (e.g. `Mo We Fr`) next to the title.
- **MCP tools updated**: `create_habit` and `update_habit` both accept `recurrence_days`. Set to empty string to clear.

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
