# Bug: heartbeats table mixes local time and UTC (`last_run_at` local, `next_run_at` UTC)

**Status:** REOPENED 2026-08-10, then FIXED at the read boundary — see
"Recurrence: `last_run_at` vs `updated_at` (2026-08-10)" at the bottom. The 2026-07-13 fix below
resolved the *scheduling* half correctly and is still in force; it did not close the
**forensics** half this doc also raised, because `updated_at` stayed local while `last_run_at`
became UTC. The row still mixes zones — it is now serialized with an explicit offset so that no
longer misleads a reader.

**Original status:** FIXED 2026-07-13 — `markHeartbeatRun` in `db-worker.js` now writes `last_run_at` with
`utcNowIso()` (new helper in `server/task-logic.js`) instead of local `nowIso()`. Existing rows
self-correct on their next run (no migration). Root cause confirmed: the C10 fix made `nowIso()`
local for day-bucketing columns, and `last_run_at` was swept along with it while `next_run_at`
stayed UTC. The UI's `relativeTime` already parsed both as UTC, so "Last: Xh ago" was also off by
the box offset — fixed by the same change.

**Severity:** medium (data-consistency / scheduling correctness; not user-facing crash)
**Found:** 2026-07-13, while investigating a Code Pipeline heartbeat that stopped firing.
**Area:** heartbeat scheduler / db-worker

## Symptom

A single heartbeat row shows `last_run_at` and `next_run_at` in **different timezones**:

```
Code Pipeline heartbeat (ac2c6e32-…), observed 2026-07-13 ~14:55 UTC on a UTC-4 box:
  last_run_at  = 2026-07-13 10:19:43     <- LOCAL (AST, UTC-4)
  next_run_at  = 2026-07-13 15:09:46     <- UTC
  agent_jobs.created_at for that same run = 2026-07-13 14:19:43   <- UTC
```

`last_run_at` (10:19) matches the run's `agent_jobs.created_at` (14:19 UTC) minus the 4h box
offset — i.e. it was written in **local** time. `next_run_at` (15:09 UTC) is in **UTC**. The two
scheduler columns disagree by the box's UTC offset.

## Why it matters

- Any comparison of `next_run_at` against a **local** `now`, or of `last_run_at` against a **UTC**
  `now`, is off by the UTC offset — on a negative-UTC box (all of Justin's are UTC-4) that's a 4h
  error, which can make a heartbeat fire late, early, or look perpetually due/not-due.
- It's the same class as the already-fixed **bug C23** in `server/v1.js` (`today()` used local date
  and mis-branched date-less API requests on negative-UTC boxes). This is that bug's twin in the
  heartbeat writer.
- It makes operational forensics unreliable — you can't compare `last_run_at` to `agent_jobs`
  timestamps without knowing which column is in which zone.

## Root cause (to confirm)

The code path that records a heartbeat run writes `last_run_at` with a **local** clock, while the
path that computes/stores `next_run_at` uses **UTC** (or `datetime('now')`, which is UTC in SQLite).
`agent_jobs.created_at` uses `datetime('now')` (UTC), so the heartbeat *job* timestamps are already
UTC — only `last_run_at` is the outlier.

## Fix

Standardize the `heartbeats` table on **UTC** (to match `agent_jobs` and SQLite's `datetime('now')`):
- Write `last_run_at` with the same UTC clock as `agent_jobs.created_at`.
- Compute `next_run_at = last_run_at + interval_minutes` in UTC.
- Audit every reader/comparator of `last_run_at` / `next_run_at` (scheduler tick, UI display,
  "due now?" check) to ensure they compare against a UTC `now`, and convert to local only at display.
- One-time migration: existing `last_run_at` values on negative-UTC boxes are shifted by the offset;
  either normalize them or accept they self-correct on the next run.

## Repro

```sql
SELECT h.last_run_at AS hb_last_local,
       h.next_run_at AS hb_next,
       (SELECT created_at FROM agent_jobs
         WHERE heartbeat_id=h.id ORDER BY created_at DESC LIMIT 1) AS job_created_utc
FROM heartbeats h WHERE h.active=1;
-- hb_last_local will differ from job_created_utc by the box UTC offset; hb_next is UTC.
```

## Not the cause of the 2026-07-13 incident

The heartbeat that stopped that day was explicitly set `active=0` (paused) — a separate,
non-automated event (there is no auto-pause path in the server). This tz bug was merely surfaced
during that investigation. The external watchdog (`shi/tools/fleet-alerting/`) is what caught the
stall and now distinguishes "paused" from "scheduler-stalled" in its alert.

---

## Recurrence: `last_run_at` vs `updated_at` (2026-08-10)

**Status:** FIXED at the read boundary (storage deliberately unchanged).

The 2026-07-13 fix aligned `last_run_at` with `next_run_at` and `agent_jobs.created_at` — all UTC.
It left `heartbeats.updated_at` on local `nowIso()`, which is correct for its own purpose but means
a single row still carries both zones, unlabeled. `markHeartbeatRun` writes them in one statement:

```js
db.prepare(`UPDATE heartbeats SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
  .run(utcNowIso(), nr, nowIso(), id)   // UTC, UTC, LOCAL
```

So the third bullet of "Why it matters" above — *"you can't compare `last_run_at` to `agent_jobs`
timestamps without knowing which column is in which zone"* — never closed. It moved.

### How it resurfaced

An audit of the v1.9.35 `/home/pf` → `/home/ansible` path correction reported that **four dispatches
after the correction still used the old path**. They did not. The audit read the fix time from
`updated_at` (`16:49:43`, local) and the dispatch times from `agent_jobs.created_at` (`20:45`, UTC),
compared them as if both were the same clock, and got the order backwards. `16:49:43` local on a
UTC-4 box is `20:49:43` UTC — four minutes *after* the last dispatch it cited. There were zero
failures after the fix.

This is the documented hazard producing exactly the documented consequence, roughly four weeks after
the doc was marked FIXED. Marking it fixed is what made it invisible.

### Fix

Storage keeps the split — scheduler columns must stay UTC for `datetime('now')` comparisons, and
day-facing columns must stay local for day-bucketing (bug C10). Changing either would break
something real. Instead, `server/task-logic.js` gained:

- `TIMESTAMP_ZONES` — a per-table map of column → zone. **Per-table, not per-column-name**, because
  `created_at` is UTC in `agent_jobs` and local in `heartbeats`.
- `toOffsetIso(value, zone)` — naive `YYYY-MM-DD HH:MM:SS` → ISO-8601 with an explicit offset
  (`...Z` or `...-04:00`), resolving a local value's offset *at that instant* so DST is handled.
- `withTimestampZones(row, table)` — applied on every read path that leaves the process:
  `listHeartbeats`, `createHeartbeat`, `updateHeartbeat`, `toggleHeartbeat`, `listHeartbeatJobs`,
  `listAgentJobs`, `getAgentJob` in `db-worker.js`, and the matching MCP handlers in
  `mcp/tools/heartbeats.js` and `mcp/tools/agent.js`.

Every consumer — the UI, an MCP client, an auditing agent — now receives a timestamp that a standard
date parser resolves to the correct instant without knowing the split. Read paths only: the stamped
form must never be written back into SQL, where comparisons expect the naive form.

`scripts/test-timestamps.mjs` (in `ci:server`, so it runs in the pre-publish gate) asserts the
specific ordering this audit got wrong, and that `created_at` resolves differently for the two
tables — so the map cannot drift back.

### Extended to tasks, notes, attachments (2026-08-11)

`tasks` was added the next day, because tasks-vs-`agent_jobs` turned out to be the *most* reachable
cross-zone comparison in the system, not a latent one: `agent_jobs.task_id` relates them directly,
and `/tasks/:id/agent-jobs` hands a caller `task.created_at` (local) and `job.created_at` (UTC) at
the same time — the identical shape of the comparison that produced the bad audit finding, on the
most-used entity in the product. `notes` (local, `datetime('now','localtime')`) and `attachments`
(UTC, `datetime('now')`) came with it: they are child records of the same task that already
disagreed with each other.

Rather than touch 55 task read sites in `db-worker.js` and ~37 across `mcp/tools/`, stamping happens
at the two terminal chokepoints every externally-returned task row already passes through —
`attachTrustSignals` (db-worker) and `enrichTaskRows` (MCP) — plus `attachSubtasks` for nested
subtask rows, which never reach either as top-level rows. Internal reads that feed logic back into
SQL do not pass through these, which is exactly what makes the chokepoint safe.

Two handlers hand-build their response instead of returning a row (`create_task`, `mark_reviewed`)
and are stamped individually. That gap was found by probing the running MCP handlers, not by reading
the code — worth repeating when extending the map to another table.

### `tasks.created_at` has a UTC default and local writers

`tasks.created_at` is declared `DEFAULT (datetime('now'))` — UTC — while all six insert sites supply
local `nowIso()`. The default therefore never fires today, and there is no live inconsistency. It is
**deliberately not** changed to `datetime('now','localtime')`: SQLite cannot alter a default in
place, so existing databases would keep the UTC default while new installs got the local one, which
is strictly worse than the current uniform-by-accident state.

The risk is a *future* insert that omits the column, which would put UTC values into a local column
— and no zone map can describe a column with two zones. `scripts/test-timestamps.mjs` guards this by
asserting every `INSERT INTO tasks` names `created_at` (and that db-worker's one dynamic insert
builds its column list from an object that sets it).

### What is still not covered

`contexts.created_at` (UTC) and `daily_notes.updated_at` (UTC) are not in the map — nothing compares
them against anything. `getPendingAttachments` is deliberately left unstamped because it feeds the
upload worker rather than a caller. Add tables to `TIMESTAMP_ZONES` when a real comparison appears,
not speculatively; the map is only trustworthy while every entry has been verified against the
actual writer.
