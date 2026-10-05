// buildHabitHistory backs both the UI year heatmap (GET /api/v1/habits/:id/history) and the MCP
// get_habit_history range mode, so its counting rules are pinned here: due days start at the
// habit's creation (unless backfilled), future days never count, skips excuse without extending
// streaks, and today unlogged doesn't break the current streak.
//
// Run: node scripts/test-habit-history.mjs

import assert from 'node:assert/strict'
import {
  buildHabitHistory, habitRangeError, isValidHabitDate, mondayOf, HABIT_HISTORY_MAX_DAYS,
} from '../server/task-logic.js'

const daily = { id: 'h1', title: 'Practice', recurrence: 'daily', recurrence_days: null, created_at: '2026-01-01 08:00:00' }
const log = (date, status = 'done', notes = null) => ({ date, status, notes })

// ── Range validation ─────────────────────────────────────────────────────────
assert.equal(isValidHabitDate('2026-02-29'), false)  // not a leap year
assert.equal(isValidHabitDate('2028-02-29'), true)
assert.equal(isValidHabitDate('2026-1-01'), false)
assert.equal(habitRangeError('2026-01-01', '2026-12-31'), null)
assert.match(habitRangeError('2026-02-01', '2026-01-01'), /on or before/)
assert.match(habitRangeError('nope', '2026-01-01'), /start/)
assert.match(habitRangeError('2000-01-01', '2026-01-01'), new RegExp(String(HABIT_HISTORY_MAX_DAYS)))

// ── Monday-start weeks ───────────────────────────────────────────────────────
assert.equal(mondayOf('2026-10-05'), '2026-10-05')  // Monday
assert.equal(mondayOf('2026-10-11'), '2026-10-05')  // Sunday
assert.equal(mondayOf('2026-01-01'), '2025-12-29')  // Thursday, crosses the year

// ── Basic counts + streaks ───────────────────────────────────────────────────
{
  const logs = [
    log('2026-01-01'), log('2026-01-02'), log('2026-01-03'),  // run of 3
    /* 01-04 missed */
    log('2026-01-05'), log('2026-01-06', 'skipped'), log('2026-01-07'),  // skip doesn't break: run 2
    /* 01-08 = asOf, unlogged: still open */
  ]
  const h = buildHabitHistory(daily, logs, '2026-01-01', '2026-01-10', { asOf: '2026-01-08', days: true })
  assert.equal(h.days_due, 7)  // 01-01..01-07; 01-08 is still open, 09 and 10 are future
  assert.equal(h.days_done, 5)
  assert.equal(h.days_skipped, 1)
  assert.equal(h.days_missed, 1)  // 01-04
  assert.equal(h.completion_rate, 71)  // 5 / 7
  assert.equal(h.longest_streak, 3)
  assert.equal(h.current_streak, 2)
  assert.equal(h.days.length, 10)
  assert.deepEqual(h.days[7], { date: '2026-01-08', due: true, status: null })  // open today
  assert.deepEqual(h.days[9], { date: '2026-01-10', due: false, status: null, future: true })
  assert.equal(h.days[0].notes, undefined)  // notes only when asked for
}

// ── Days before creation don't count unless backfilled ───────────────────────
{
  const late = { ...daily, created_at: '2026-09-01 10:00:00' }
  const h = buildHabitHistory(late, [log('2026-08-30')], '2026-01-01', '2026-09-03', { asOf: '2026-09-03' })
  assert.equal(h.days_due, 3)  // backfilled 08-30 + 09-01, 09-02 (09-03 is today, still open)
  assert.equal(h.days_done, 1)
  assert.equal(h.completion_rate, 33)
}

// ── Off-schedule sessions: counted as done, never push the rate over 100 ────
{
  const mwf = { ...daily, recurrence_days: 'mon,wed,fri' }
  // Week of 2026-10-05 (Mon). Done Mon, Tue (extra), Wed, Fri.
  const logs = [log('2026-10-05'), log('2026-10-06'), log('2026-10-07'), log('2026-10-09')]
  const h = buildHabitHistory(mwf, logs, '2026-10-05', '2026-10-11', { asOf: '2026-10-11' })
  assert.equal(h.days_due, 3)
  assert.equal(h.days_done, 4)
  assert.equal(h.completion_rate, 100)
  assert.equal(h.days_missed, 0)
  assert.equal(h.current_streak, 4)  // Sat/Sun not due, so they don't break it
}

// ── Rollups ──────────────────────────────────────────────────────────────────
{
  const logs = [log('2026-01-30'), log('2026-02-02'), log('2026-02-03', 'skipped', 'sick')]
  const byMonth = buildHabitHistory(daily, logs, '2026-01-26', '2026-02-08', { asOf: '2026-02-08', rollup: 'month' })
  assert.deepEqual(byMonth.rollup, [
    { period: '2026-01', due: 6, done: 1, skipped: 0, rate: 17 },
    { period: '2026-02', due: 7, done: 1, skipped: 1, rate: 14 },  // 02-08 is today, still open
  ])
  assert.equal(byMonth.days, undefined)  // no per-day rows unless asked for

  const byWeek = buildHabitHistory(daily, logs, '2026-01-26', '2026-02-08', { asOf: '2026-02-08', rollup: 'week', days: true, notes: true })
  assert.deepEqual(byWeek.rollup.map(b => b.period), ['2026-01-26', '2026-02-02'])
  assert.equal(byWeek.rollup[1].done, 1)
  assert.equal(byWeek.days.find(d => d.date === '2026-02-03').notes, 'sick')
}

// ── A full year is 365 per-day rows but only 12 month buckets ───────────────
{
  const h = buildHabitHistory(daily, [], '2025-01-01', '2025-12-31', { asOf: '2026-10-05', rollup: 'month' })
  assert.equal(h.rollup.length, 12)
  assert.equal(h.days_due, 0)  // habit didn't exist yet
  assert.equal(h.completion_rate, null)
}

console.log('habit history: ok')
