# Bug: heartbeats table mixes local time and UTC (`last_run_at` local, `next_run_at` UTC)

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
