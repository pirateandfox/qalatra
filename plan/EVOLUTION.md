# Task OS — Evolution Notes

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
