// server/cron.js — standard 5-field cron expressions evaluated in an IANA timezone.
//
// Pure: no I/O and no side effects at import, so server/task-logic.js (imported by both db-worker
// and MCP) can depend on it. Every instant in and out is a UTC epoch-ms or Date; the timezone is
// only used to decide which wall-clock minutes match. Callers store the result as UTC
// (docs/bug-heartbeat-timezone-mismatch.md) — nothing here produces a local timestamp.
//
// Daylight saving, where the wall clock is not a 1:1 map onto instants:
// - A wall time skipped by a spring-forward (02:30 on the US change day) fires once, at the first
//   instant after the gap (03:00). Several skipped matches collapse into that one run.
// - A wall time repeated by a fall-back (01:30 on the US change day) fires once, on its first
//   occurrence. The second pass through the same wall minute is never matched.

const FIELDS = [
  { name: 'minute',       min: 0, max: 59 },
  { name: 'hour',         min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month',        min: 1, max: 12, names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], nameBase: 1 },
  { name: 'day-of-week',  min: 0, max: 7,  names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], nameBase: 0 },
]

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
// Long enough for the rarest satisfiable schedule (Feb 29 on a given weekday recurs within 28 years
// only with OR semantics, which always matches sooner; Feb 29 alone recurs within 8 years).
const SEARCH_DAYS = 366 * 8 + 2

function cronError(expr, detail) {
  const err = new Error(`Invalid cron expression "${expr}": ${detail}`)
  err.status = 400
  return err
}

function parseValue(raw, field, expr) {
  const upper = raw.toUpperCase()
  if (field.names) {
    const i = field.names.indexOf(upper)
    if (i !== -1) return i + field.nameBase
  }
  if (!/^\d+$/.test(raw)) throw cronError(expr, `${field.name} value "${raw}" is not a number`)
  const n = Number(raw)
  if (n < field.min || n > field.max) throw cronError(expr, `${field.name} value ${n} is out of range ${field.min}-${field.max}`)
  return n
}

function parseField(text, field, expr) {
  const values = new Set()
  for (const part of text.split(',')) {
    if (!part) throw cronError(expr, `empty list item in ${field.name}`)
    const [base, stepText, extra] = part.split('/')
    if (extra !== undefined) throw cronError(expr, `"${part}" in ${field.name} has more than one "/"`)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) throw cronError(expr, `step "${stepText}" in ${field.name} must be a positive integer`)
      step = Number(stepText)
    }
    let lo, hi
    if (base === '*') {
      lo = field.min; hi = field.max
    } else if (base.includes('-')) {
      const [a, b] = base.split('-')
      lo = parseValue(a, field, expr); hi = parseValue(b, field, expr)
      if (lo > hi) throw cronError(expr, `range ${base} in ${field.name} runs backwards`)
    } else {
      lo = parseValue(base, field, expr)
      // "5/15" means "from 5, every 15" — the conventional extension to the field maximum.
      hi = stepText !== undefined ? field.max : lo
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values
}

// Parse a standard 5-field expression. Throws an Error (status 400) naming the offending field.
export function parseCron(expr) {
  if (typeof expr !== 'string' || !expr.trim()) throw cronError(String(expr ?? ''), 'expression is empty')
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw cronError(expr, `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`)
  }
  const [minutes, hours, doms, months, dowsRaw] = parts.map((p, i) => parseField(p, FIELDS[i], expr))
  const dows = new Set([...dowsRaw].map(d => d % 7)) // 7 is Sunday too
  return {
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    doms, months, dows,
    // Vixie semantics: when both day fields are restricted, a day matches if EITHER does.
    // A field counts as unrestricted only when it starts with "*" (so "*/2" is still "every day").
    domStar: parts[2].startsWith('*'),
    dowStar: parts[4].startsWith('*'),
  }
}

// ── Timezones ───────────────────────────────────────────────────────────────────

const formatters = new Map()
function formatter(timeZone) {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    })
    formatters.set(timeZone, f)
  }
  return f
}

// Canonical IANA name for `timeZone`, or null if the runtime does not know it.
export function normalizeTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

// The timezone this process runs in (TZ, else the OS setting).
export function serverTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

// Wall-clock fields of instant `ms` in `timeZone`, plus the same wall time encoded as if it were UTC
// (handy for ordering wall times and for offset arithmetic).
function wallClock(timeZone, ms) {
  const p = {}
  for (const { type, value } of formatter(timeZone).formatToParts(ms)) p[type] = Number(value)
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, encoded: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) }
}

// The UTC instant at which `timeZone`'s wall clock reads the given minute. Repeated wall times
// resolve to their first occurrence; skipped ones to the first instant after the gap.
function wallToInstant(timeZone, y, mo, d, h, mi) {
  const target = Date.UTC(y, mo - 1, d, h, mi)
  // Offsets either side of the target; no zone changes offset twice within 24 hours.
  const offsets = new Set([target - 12 * HOUR_MS, target + 12 * HOUR_MS].map(ms => wallClock(timeZone, ms).encoded - ms))
  const candidates = [...offsets].map(o => target - o)
  const exact = candidates.filter(t => wallClock(timeZone, t).encoded === target)
  if (exact.length) return Math.min(...exact)
  // In a gap: binary-search the first minute whose wall time is at or past the target.
  let lo = Math.min(...candidates), hi = Math.max(...candidates)
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS
    if (wallClock(timeZone, mid).encoded >= target) hi = mid
    else lo = mid
  }
  return hi
}

// ── Schedule evaluation ─────────────────────────────────────────────────────────

function dayMatches(cron, y, mo, d) {
  if (!cron.months.has(mo)) return false
  const domOk = cron.doms.has(d)
  const dowOk = cron.dows.has(new Date(Date.UTC(y, mo - 1, d)).getUTCDay())
  if (cron.domStar && cron.dowStar) return true
  if (cron.domStar) return dowOk
  if (cron.dowStar) return domOk
  return domOk || dowOk
}

// The first run strictly after `after` (Date or epoch ms), as a Date, or null if the expression can
// never fire (e.g. "0 0 31 2 *"). `expr` may be a string or the result of parseCron.
export function nextCronRun(expr, timeZone, after = new Date()) {
  const cron = typeof expr === 'string' ? parseCron(expr) : expr
  const afterMs = Math.floor(+after / 1000) * 1000
  const start = wallClock(timeZone, afterMs)
  // Begin a day early: around a fall-back, the wall date at `after` can already be the next day's
  // in UTC terms, and a match on the earlier wall date may still lie in the future.
  const firstDay = Date.UTC(start.y, start.mo - 1, start.d) - DAY_MS
  const floor = start.encoded - 3 * HOUR_MS
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const day = new Date(firstDay + i * DAY_MS)
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate()
    if (!dayMatches(cron, y, mo, d)) continue
    for (const h of cron.hours) {
      // Skip hours that end well before `after` in wall terms without resolving each minute.
      if (Date.UTC(y, mo - 1, d, h, 59) < floor) continue
      for (const mi of cron.minutes) {
        const t = wallToInstant(timeZone, y, mo, d, h, mi)
        if (t > afterMs) return new Date(t)
      }
    }
  }
  return null
}

// The next `count` runs after `after`, as Dates.
export function upcomingCronRuns(expr, timeZone, count = 3, after = new Date()) {
  const cron = typeof expr === 'string' ? parseCron(expr) : expr
  const runs = []
  let cursor = after
  while (runs.length < count) {
    const next = nextCronRun(cron, timeZone, cursor)
    if (!next) break
    runs.push(next)
    cursor = next
  }
  return runs
}
