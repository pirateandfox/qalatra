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

// ── Timestamp serialization ────────────────────────────────────────────────────

// Stored timestamps are naive `YYYY-MM-DD HH:MM:SS` carrying no zone marker, and the zone differs
// per column BY DESIGN: scheduler columns are UTC so SQLite can compare them against datetime('now'),
// while day-facing columns are local so an evening write buckets to the right local day (bug C10).
// Storage keeps that split. The cost is that a single row mixes both — heartbeats.last_run_at (UTC)
// sits beside heartbeats.updated_at (local) — so anyone comparing them reads the box offset (4h on
// AST) as elapsed time. That is not hypothetical: it is how an audit after v1.9.35 concluded that
// dispatches which preceded a fix had come after it (docs/bug-heartbeat-timezone-mismatch.md).
// Serializing with an explicit offset at every read boundary removes the need to know the split.
//
// Keyed by table, not column name, because `created_at` is UTC in agent_jobs (SQLite DEFAULT
// datetime('now')) and local in heartbeats (nowIso()). A column-name-keyed map would be wrong for
// one of them.
// tasks are here because agent_jobs.task_id makes tasks-vs-jobs the most reachable cross-zone
// comparison in the system: /tasks/:id/agent-jobs hands a caller task.created_at (local) and
// job.created_at (UTC) at once. notes and attachments are child records of the same task that
// already disagree with each other — notes defaults to datetime('now','localtime'), attachments to
// datetime('now'). Date-only columns (due_date, start_date, event_time…) are deliberately absent:
// this is an allowlist, and toOffsetIso ignores anything that is not a full naive timestamp anyway.
export const TIMESTAMP_ZONES = {
  heartbeats: { last_run_at: 'utc', next_run_at: 'utc', created_at: 'local', updated_at: 'local' },
  agent_jobs: { created_at: 'utc', started_at: 'utc', completed_at: 'utc' },
  tasks: { created_at: 'local', updated_at: 'local', last_reviewed_at: 'local', last_touched_human: 'local', last_touched_ai: 'local' },
  notes: { created_at: 'local' },
  attachments: { created_at: 'utc' },
}

const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

// Naive `YYYY-MM-DD HH:MM:SS` → ISO-8601 with an explicit offset. Anything already carrying a zone
// (or not a timestamp at all) is returned untouched, so this is safe to apply more than once.
// A local value resolves its offset at that instant rather than now, so a timestamp written on the
// far side of a DST change keeps the offset it was actually written with.
export function toOffsetIso(value, zone) {
  if (typeof value !== 'string' || !NAIVE_TIMESTAMP.test(value)) return value
  if (zone === 'utc') return `${value.replace(' ', 'T')}Z`
  const [date, time] = value.split(' ')
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi, s] = time.split(':').map(Number)
  const offsetMins = -new Date(y, mo - 1, d, h, mi, s).getTimezoneOffset()
  const pad = n => String(n).padStart(2, '0')
  const abs = Math.abs(offsetMins)
  return `${date}T${time}${offsetMins < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

// Stamp every known timestamp column on a row — or array of rows — read from `table`. Read paths
// only: never feed the result back into SQL, since the comparisons expect the stored naive form.
export function withTimestampZones(row, table) {
  const zones = TIMESTAMP_ZONES[table]
  if (!row || !zones) return row
  if (Array.isArray(row)) return row.map(r => withTimestampZones(r, table))
  const out = { ...row }
  for (const [column, zone] of Object.entries(zones)) {
    if (out[column] != null) out[column] = toOffsetIso(out[column], zone)
  }
  return out
}

// ── ai_context ordering and cap ─────────────────────────────────────────────────

// ai_context is append-only, and every read that matches a task carries the whole of it. Nothing
// bounded it: a 15-minute heartbeat writing one entry per pass puts ~96 entries a day on a single
// monitor task, so a caller doing a cheap status read eventually fails on the MCP output cap
// because of history it never asked for. Keeping `description` short — the previous mitigation —
// depends on caller discipline and does not touch ai_context at all.
//
// So the tail is capped here, at the one funnel every write goes through (MCP tools, the REST
// worker, briefing/triage), and the oldest entries are dropped. Two budgets, whichever binds
// first: entry count, and total characters for the case where a few entries are individually huge.
export const AI_CONTEXT_MAX_ENTRIES = 50
export const AI_CONTEXT_MAX_CHARS = 8000

// An entry starts with its day stamp at the start of a line. Notes may themselves contain
// newlines, so this — not every '\n' — is the entry boundary.
const AI_CONTEXT_ENTRY_START = /^\[\d{4}-\d{2}-\d{2}\] /
// Bracketed like an entry so the UI thread renders it (DetailPanel matches /^\[(.+?)\]\s*(.+)$/),
// but not date-stamped, so re-parsing never mistakes it for one.
const AI_CONTEXT_TRIM_MARKER = /^\[…\] (\d+) earlier entr(?:y|ies) trimmed$/

function trimMarker(count) {
  return `[…] ${count} earlier ${count === 1 ? 'entry' : 'entries'} trimmed`
}

// Split ai_context into its day-stamped entries. Anything before the first stamp (a previous trim
// marker, or legacy unstamped content) comes back as the first chunk.
function splitAiContext(text) {
  const chunks = []
  for (const line of text.split('\n')) {
    if (chunks.length === 0 || AI_CONTEXT_ENTRY_START.test(line)) chunks.push(line)
    else chunks[chunks.length - 1] += `\n${line}`
  }
  return chunks
}

// Keep the newest entries within both budgets, replacing what was dropped with a visible marker.
// Trimming the *oldest* is only correct because appendAiContext is chronological (bug C24) — the
// two have to be settled together or a cap silently destroys the newest context instead.
export function capAiContext(text) {
  if (!text) return text ?? null

  const chunks = splitAiContext(text)
  // Carry a previous marker's count forward rather than stacking markers, so the number stays a
  // running total of everything ever dropped from this task.
  const priorMarker = chunks.length ? chunks[0].match(AI_CONTEXT_TRIM_MARKER) : null
  const entries = priorMarker ? chunks.slice(1) : chunks
  const priorDropped = priorMarker ? Number(priorMarker[1]) : 0

  const kept = []
  let chars = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const withEntry = chars + entries[i].length + (kept.length ? 1 : 0)
    // `kept.length &&` on the char budget: one entry always survives, even an oversized one.
    // Dropping it would erase the newest context — the one thing the caller definitely wants.
    if (kept.length >= AI_CONTEXT_MAX_ENTRIES || (kept.length && withEntry > AI_CONTEXT_MAX_CHARS)) break
    kept.unshift(entries[i])
    chars = withEntry
  }

  const dropped = priorDropped + (entries.length - kept.length)
  if (dropped === 0) return text
  return `${trimMarker(dropped)}\n${kept.join('\n')}`
}

// Append a day-stamped note to a task's ai_context, chronological / newest-last (bug C24).
// Both surfaces must use this same ordering so a task touched by both MCP and the UI keeps
// its day-stamped entries in a single consistent order.
export function appendAiContext(existing, note) {
  if (!note) return existing ?? null
  const entry = `[${today()}] ${note}`
  return capAiContext(existing ? `${existing}\n${entry}` : entry)
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
