// server/task-logic.js — single source of truth for the PURE business logic that the two
// separate backend runtimes (db-worker.js on its worker thread, and the MCP process via
// mcp/db.js + mcp/tools/*) each used to carry their own divergent copy of.
//
// Why this file exists: db-worker.js and mcp/ run in SEPARATE processes/threads with SEPARATE
// SQLite handles, so they cannot share DB-access code. But the date math, recurrence rules,
// ai_context ordering, heartbeat scheduling, and habit-due logic are all pure functions with no
// I/O — those belong here, imported by both sides, so a fix on one side can never silently fail
// to reach the other again (the class of bugs C1/C4/C10/C15/C24 in the 2026-07-11 bug hunt).
//
// HARD CONSTRAINT: this module must have NO side effects at import time — no DB open, no
// parentPort, no filesystem or network. It is safe for any process to `import` it. Its only
// dependency is the pure `rrule` library.

import pkg from 'rrule'
const { rrulestr } = pkg

// ── Date primitives (local wall-clock) ─────────────────────────────────────────

// Local calendar date YYYY-MM-DD. Used for day-bucketing that must match the SQLite
// strftime('now','localtime') queries.
export function today() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Local wall-clock timestamp YYYY-MM-DD HH:MM:SS, NOT UTC (bug C10). Must match the day-bucketing
// queries (which use strftime('now','localtime')) so evening completions on a negative-UTC box
// bucket to the correct local day instead of tomorrow. Only used for human/day-facing columns
// (last_touched_human, last_reviewed_at, created_at); heartbeat scheduling columns (next_run_at,
// last_run_at) stay UTC via addMinutesFromNow/nextRunAt/utcNowIso, compared against datetime('now').
export function nowIso() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// Shift a YYYY-MM-DD date string by N days, anchored at noon UTC to avoid DST edge cases.
export function offsetDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000)

// UTC-based "now + N minutes" as YYYY-MM-DD HH:MM:SS, for heartbeat next_run_at (compared against
// SQLite datetime('now'), which is UTC).
export function addMinutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
}

// UTC "now" as YYYY-MM-DD HH:MM:SS — for scheduler columns that live alongside next_run_at and
// agent_jobs.created_at (both UTC). heartbeats.last_run_at must use this, not nowIso(), or the two
// scheduler columns disagree by the box's UTC offset (docs/bug-heartbeat-timezone-mismatch.md).
export const utcNowIso = () => addMinutesFromNow(0)

// ── ai_context ordering ─────────────────────────────────────────────────────────

// Append a day-stamped note to a task's ai_context, chronological / newest-last (bug C24).
// Both surfaces must use this same ordering so a task touched by both MCP and the UI keeps
// its day-stamped entries in a single consistent order.
export function appendAiContext(existing, note) {
  if (!note) return existing ?? null
  const entry = `[${today()}] ${note}`
  return existing ? `${existing}\n${entry}` : entry
}

// ── Recurrence ─────────────────────────────────────────────────────────────────

// Legacy shorthand → RRULE string.
export const LEGACY_RRULE = {
  daily:    'FREQ=DAILY',
  weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  weekly:   'FREQ=WEEKLY',
  monthly:  'FREQ=MONTHLY',
}

export function toRruleString(recurrence) {
  return LEGACY_RRULE[recurrence] ?? recurrence
}

// Human-readable description of a recurrence pattern.
export function rruleToText(recurrence) {
  if (!recurrence) return null
  try {
    const rule = rrulestr('RRULE:' + toRruleString(recurrence))
    return rule.toText()
  } catch (_) {
    return recurrence
  }
}

// Returns the next ISO date string (YYYY-MM-DD) strictly after baseDate for the given recurrence.
// recurrence: legacy shorthand OR full RRULE string (e.g. 'FREQ=MONTHLY;BYMONTHDAY=1').
//
// NOTE ON DUPLICATION: db-worker.js keeps its own byte-for-byte copy of this function, because
// test-recurrence.mjs extracts db-worker's copy from source text and runs it with only `rrulestr`
// injected (db-worker.js cannot be imported — it opens the DB and calls parentPort at load). That
// test asserts db-worker's copy === this copy on every case, so it is an automated guard against
// the two drifting apart. If you change the math here, change db-worker.js's copy identically and
// run `node scripts/test-recurrence.mjs`.
export function nextRecurrenceDate(baseDate, recurrence) {
  if (!recurrence) return null
  try {
    let rruleStr = toRruleString(recurrence)
    // Anchor to midnight UTC on baseDate (the task's own schedule anchor), then use exclusive
    // after() so we get the NEXT occurrence strictly after baseDate without shifting the
    // weekday/monthday anchor. Using day+1 with inclusive after() collapsed bare FREQ=WEEKLY /
    // FREQ=MONTHLY to next-day, because dtstart itself is the rule's first occurrence (bug C1).
    const dtstart = new Date(baseDate + 'T00:00:00Z')
    // FREQ=MONTHLY without BYMONTHDAY anchors to dtstart's day-of-month, causing 1-day drift on
    // each completion. Explicitly anchor to baseDate's day-of-month.
    if (rruleStr === 'FREQ=MONTHLY') {
      const dom = parseInt(baseDate.slice(8, 10), 10)
      rruleStr = `FREQ=MONTHLY;BYMONTHDAY=${dom}`
    }
    const rule = rrulestr('RRULE:' + rruleStr, { dtstart })
    const next = rule.after(dtstart, false) // exclusive: first occurrence strictly after baseDate
    return next ? next.toISOString().slice(0, 10) : null
  } catch (_) {
    return null
  }
}

// Returns true if the agent schedule is due given the last run time.
// agentSchedule: RRULE string with BYHOUR/BYMINUTE (e.g. 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0').
// lastRunAt: ISO datetime string or null.
export function isAgentScheduleDue(agentSchedule, lastRunAt) {
  if (!agentSchedule) return false
  try {
    const now = new Date()
    const rule = rrulestr('RRULE:' + agentSchedule)
    const lastOccurrence = rule.before(now, true)
    if (!lastOccurrence) return false
    if (!lastRunAt) return true
    return lastOccurrence > new Date(lastRunAt)
  } catch (_) {
    return false
  }
}

// ── Heartbeat scheduling ─────────────────────────────────────────────────────────

// Compute the next heartbeat run timestamp (UTC, YYYY-MM-DD HH:MM:SS). For daily heartbeats with
// a specific time, schedules the next occurrence of that local time (today if not yet passed,
// tomorrow if it has). Must be recomputed on any schedule-field change (bugs C8/C18).
export function nextRunAt(intervalMinutes, runAtTime, minuteOffset) {
  if (runAtTime && intervalMinutes === 1440) {
    const [h, m] = runAtTime.split(':').map(Number)
    const target = new Date()
    target.setHours(h, m, 0, 0)
    if (target <= new Date()) target.setDate(target.getDate() + 1)
    return target.toISOString().replace('T', ' ').slice(0, 19)
  }
  if (minuteOffset != null && intervalMinutes < 1440) {
    const now = new Date()
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    const elapsed = ((nowMinutes - minuteOffset) % intervalMinutes + intervalMinutes) % intervalMinutes
    const minutesUntilNext = elapsed === 0 ? intervalMinutes : intervalMinutes - elapsed
    const next = new Date(now.getTime() + minutesUntilNext * 60_000)
    next.setSeconds(0, 0)
    return next.toISOString().replace('T', ' ').slice(0, 19)
  }
  return addMinutesFromNow(intervalMinutes)
}

// ── Habits ───────────────────────────────────────────────────────────────────────

export const DAY_ABBR_TO_DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

export function isHabitDueOn(habit, dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z')
  const dow = d.getUTCDay()
  if (habit.recurrence_days) {
    const days = habit.recurrence_days.split(',').map(s => DAY_ABBR_TO_DOW[s.trim()]).filter(n => n !== undefined)
    return days.includes(dow)
  }
  switch (habit.recurrence) {
    case 'daily':    return true
    case 'weekdays': return dow >= 1 && dow <= 5
    case 'weekly': {
      const created = new Date(habit.created_at.substring(0, 10) + 'T12:00:00Z')
      return dow === created.getUTCDay()
    }
    case 'monthly': {
      const created = new Date(habit.created_at.substring(0, 10) + 'T12:00:00Z')
      return d.getUTCDate() === created.getUTCDate()
    }
    default: return true
  }
}
