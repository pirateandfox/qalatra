// scripts/test-heartbeat-schedule.mjs
// Cron + timezone heartbeat schedules: weekday selection, DST in America/New_York, validation,
// unchanged interval behaviour, and once-per-slot firing across a server restart (a real db-worker
// thread, terminated and respawned against the same database).
//
// Run: npm run test:heartbeat-schedule (pins TZ so the "server timezone" default is deterministic).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { nextCronRun, parseCron, upcomingCronRuns } from '../server/cron.js'
import { heartbeatNextRunAt, nextRunAt, resolveHeartbeatSchedule } from '../server/task-logic.js'

assert.equal(process.env.TZ, 'America/Puerto_Rico', 'run via `npm run test:heartbeat-schedule` (sets TZ)')

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PR = 'America/Puerto_Rico'
const NY = 'America/New_York'
const iso = d => d.toISOString()
const runs = (expr, tz, count, from) => upcomingCronRuns(expr, tz, count, new Date(from)).map(iso)
const wall = (d, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)

// ── Tue–Fri 05:00 skips Sat–Mon ────────────────────────────────────────────────
// The morning review: 0 5 * * 2-5 in America/Puerto_Rico (UTC-4 year round → 09:00Z).
// 2026-10-17 is a Saturday.
assert.deepEqual(runs('0 5 * * 2-5', PR, 5, '2026-10-17T00:00:00Z'), [
  '2026-10-20T09:00:00.000Z', // Tue
  '2026-10-21T09:00:00.000Z', // Wed
  '2026-10-22T09:00:00.000Z', // Thu
  '2026-10-23T09:00:00.000Z', // Fri
  '2026-10-27T09:00:00.000Z', // next Tue — Sat 24, Sun 25, Mon 26 skipped
])
for (const d of upcomingCronRuns('0 5 * * 2-5', PR, 40, new Date('2026-10-17T00:00:00Z'))) {
  assert.match(wall(d, PR), /^(Tue|Wed|Thu|Fri) 05:00$/, `Tue–Fri run landed on ${wall(d, PR)}`)
}
// Fired at Friday 05:00:30, the next slot is the following Tuesday, not Saturday or Monday.
assert.equal(iso(nextCronRun('0 5 * * 2-5', PR, new Date('2026-10-23T09:00:30Z'))), '2026-10-27T09:00:00.000Z')

// ── Weekday-only schedules ─────────────────────────────────────────────────────
const weekdayRuns = upcomingCronRuns('30 8 * * 1-5', PR, 20, new Date('2026-10-17T00:00:00Z'))
assert.equal(weekdayRuns.length, 20)
for (const d of weekdayRuns) assert.match(wall(d, PR), /^(Mon|Tue|Wed|Thu|Fri) 08:30$/)
assert.equal(iso(weekdayRuns[19]), '2026-11-13T12:30:00.000Z', 'four full weeks of weekdays, nothing extra')
// Names and lists parse the same as numbers; 7 is Sunday.
assert.deepEqual(runs('0 5 * * TUE-FRI', PR, 4, '2026-10-17T00:00:00Z'), runs('0 5 * * 2-5', PR, 4, '2026-10-17T00:00:00Z'))
assert.deepEqual(runs('0 5 * * 7', PR, 2, '2026-10-17T00:00:00Z'), runs('0 5 * * 0', PR, 2, '2026-10-17T00:00:00Z'))
// Day-of-month and day-of-week both restricted → either matches (vixie cron).
assert.deepEqual(runs('0 0 1 * 1', 'UTC', 3, '2026-10-17T00:00:00Z'), [
  '2026-10-19T00:00:00.000Z', '2026-10-26T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
])

// ── Daylight saving, America/New_York ──────────────────────────────────────────
// 2026-03-08: 02:00 EST jumps to 03:00 EDT. 2026-11-01: 02:00 EDT falls back to 01:00 EST.

// A daily local time stays on the local clock across both changes; only the UTC instant moves.
assert.deepEqual(runs('0 5 * * *', NY, 3, '2026-03-07T00:00:00Z'), [
  '2026-03-07T10:00:00.000Z', '2026-03-08T09:00:00.000Z', '2026-03-09T09:00:00.000Z',
])
assert.deepEqual(runs('0 5 * * *', NY, 3, '2026-10-31T00:00:00Z'), [
  '2026-10-31T09:00:00.000Z', '2026-11-01T10:00:00.000Z', '2026-11-02T10:00:00.000Z',
])

// Spring forward: 02:30 does not exist, so it runs once at the next valid time, 03:00 EDT (07:00Z).
assert.deepEqual(runs('30 2 * * *', NY, 3, '2026-03-07T12:00:00Z'), [
  '2026-03-08T07:00:00.000Z', '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z',
])
// Every skipped 02:xx slot collapses into that one 03:00 run.
assert.deepEqual(runs('*/15 2 * * *', NY, 2, '2026-03-08T00:00:00Z'), ['2026-03-08T07:00:00.000Z', '2026-03-09T06:00:00.000Z'])
// Hourly: the missing 02:00 and the real 03:00 are one run, not two.
assert.deepEqual(runs('0 * * * *', NY, 3, '2026-03-08T05:30:00Z'), [
  '2026-03-08T06:00:00.000Z', '2026-03-08T07:00:00.000Z', '2026-03-08T08:00:00.000Z',
])

// Fall back: 01:30 happens twice; it runs once, on the first pass (EDT, 05:30Z), not again at 06:30Z.
assert.deepEqual(runs('30 1 * * *', NY, 2, '2026-10-31T12:00:00Z'), ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'])
// …including when the scheduler asks again right after that first run.
assert.equal(iso(nextCronRun('30 1 * * *', NY, new Date('2026-11-01T05:30:05Z'))), '2026-11-02T06:30:00.000Z')
// Hourly through the repeated hour: 01:00 once, then 02:00 EST.
assert.deepEqual(runs('0 * * * *', NY, 3, '2026-11-01T04:30:00Z'), [
  '2026-11-01T05:00:00.000Z', '2026-11-01T07:00:00.000Z', '2026-11-01T08:00:00.000Z',
])

// ── Validation ─────────────────────────────────────────────────────────────────
const rejects = (fields, pattern, existing = null) => assert.throws(
  () => resolveHeartbeatSchedule(fields, existing),
  err => err.status === 400 && pattern.test(err.message),
  `expected ${pattern} for ${JSON.stringify(fields)}`,
)
rejects({ cron_expression: '0 5 * *' }, /expected 5 fields/)
rejects({ cron_expression: '0 25 * * *' }, /hour value 25 is out of range 0-23/)
rejects({ cron_expression: '0 5 * * 8' }, /day-of-week value 8/)
rejects({ cron_expression: '0 0 31 2 *' }, /never fires/)
rejects({ cron_expression: '0 5 * * 2-5', timezone: 'Mars/Olympus_Mons' }, /Unknown timezone "Mars\/Olympus_Mons"/)
rejects({ cron_expression: '0 5 * * 2-5', interval_minutes: 60 }, /can't be combined with interval_minutes/)
rejects({ cron_expression: '0 5 * * 2-5', run_at_time: '05:00' }, /can't be combined with run_at_time/)
rejects({ interval_minutes: 60, timezone: PR }, /timezone applies only to cron_expression/)
rejects({ interval_minutes: 30 }, /set cron_expression to null/, { cron_expression: '0 5 * * 2-5', timezone: PR, interval_minutes: 60 })
assert.throws(() => parseCron('5-1 * * * *'), /runs backwards/)

// The "done when" schedule is accepted as given.
const morning = resolveHeartbeatSchedule({ cron_expression: '0 5 * * 2-5', timezone: PR })
assert.deepEqual(morning, { interval_minutes: 60, run_at_time: null, minute_offset: null, cron_expression: '0 5 * * 2-5', timezone: PR })
// Timezone defaults to the server's; interval fields sent as null alongside cron are not "set".
assert.equal(resolveHeartbeatSchedule({ cron_expression: '0 5 * * 1-5', run_at_time: null, minute_offset: null }).timezone, PR)
// Clearing cron switches back to an interval.
assert.deepEqual(
  resolveHeartbeatSchedule({ cron_expression: null, interval_minutes: 30, minute_offset: 15 }, { cron_expression: '0 5 * * 2-5', timezone: PR, interval_minutes: 60 }),
  { interval_minutes: 30, run_at_time: null, minute_offset: 15, cron_expression: null, timezone: null },
)
// Changing only the timezone of a cron heartbeat keeps its expression.
assert.equal(resolveHeartbeatSchedule({ timezone: NY }, { cron_expression: '0 5 * * 2-5', timezone: PR }).cron_expression, '0 5 * * 2-5')

// ── Interval heartbeats behave exactly as before ───────────────────────────────
// Same normalization as the pre-cron create/update code, and next_run_at from the same nextRunAt.
const legacyCases = [
  [{}, { interval_minutes: 60, run_at_time: null, minute_offset: null }],
  [{ interval_minutes: 30, minute_offset: 15 }, { interval_minutes: 30, run_at_time: null, minute_offset: 15 }],
  [{ interval_minutes: 1440, run_at_time: '09:00' }, { interval_minutes: 1440, run_at_time: '09:00', minute_offset: null }],
  [{ interval_minutes: 1440, minute_offset: 15 }, { interval_minutes: 1440, run_at_time: null, minute_offset: null }],
  [{ interval_minutes: 30, run_at_time: '09:00' }, { interval_minutes: 30, run_at_time: null, minute_offset: null }],
]
for (const [fields, expected] of legacyCases) {
  const schedule = resolveHeartbeatSchedule(fields)
  assert.deepEqual(schedule, { ...expected, cron_expression: null, timezone: null })
  const viaHeartbeat = Date.parse(`${heartbeatNextRunAt(schedule).replace(' ', 'T')}Z`)
  const viaLegacy = Date.parse(`${nextRunAt(expected.interval_minutes, expected.run_at_time, expected.minute_offset).replace(' ', 'T')}Z`)
  assert.ok(Math.abs(viaHeartbeat - viaLegacy) <= 1000, `next_run_at unchanged for ${JSON.stringify(fields)}`)
}

console.log('PASS  cron, weekday, DST, validation and interval scheduling')

// ── Restart: no double run, no missed run ──────────────────────────────────────
// Drives the real db-worker the way server/workers.js does (getDueHeartbeats → fireHeartbeat), and
// "restarts" by terminating the worker thread and spawning a fresh one on the same file.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-hb-cron-'))
const dbPath = path.join(dir, 'tasks.db')

function startWorker() {
  const worker = new Worker(path.join(ROOT, 'db-worker.js'), { workerData: { dbPath } })
  let seq = 0
  const pending = new Map()
  const ready = new Promise((resolve, reject) => {
    worker.on('error', reject)
    worker.on('message', msg => {
      if (msg.ready) return resolve()
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.error ? p.reject(Object.assign(new Error(msg.error), { status: msg.status })) : p.resolve(msg.result)
    })
  })
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, method, args })
  })
  return { ready, call, stop: () => worker.terminate() }
}

// The scheduler tick from server/workers.js runDueHeartbeats.
async function tick(w) {
  let fired = 0
  for (const hb of await w.call('getDueHeartbeats')) if ((await w.call('fireHeartbeat', hb.id)).fired) fired++
  return fired
}

const { default: Database } = await import('better-sqlite3')
let w = startWorker()
await w.ready
const side = new Database(dbPath)
const jobsFor = id => side.prepare('SELECT id, status FROM agent_jobs WHERE heartbeat_id = ? ORDER BY created_at').all(id)
const nextRunOf = id => side.prepare('SELECT next_run_at FROM heartbeats WHERE id = ?').get(id).next_run_at

try {
  const hb = await w.call('createHeartbeat', {
    title: 'Morning review', agent_path: dir, prompt: 'review', cron_expression: '0 5 * * 2-5', timezone: PR,
  })
  assert.equal(hb.cron_expression, '0 5 * * 2-5')
  assert.equal(hb.timezone, PR)
  assert.match(hb.next_run_at, /T09:00:00Z$/, 'next_run_at is stored and served as UTC')
  assert.equal(hb.upcoming_runs.length, 3)
  assert.equal(hb.upcoming_runs[0], hb.next_run_at.replace('Z', '.000Z'))
  await assert.rejects(w.call('createHeartbeat', { title: 'x', agent_path: dir, prompt: 'x', cron_expression: 'nope' }),
    err => err.status === 400 && /Invalid cron expression/.test(err.message))

  // Not due yet: nothing fires.
  assert.equal(await tick(w), 0)

  // The slot passes (Friday 05:00 AST). It fires once…
  side.prepare('UPDATE heartbeats SET next_run_at = ? WHERE id = ?').run('2026-10-16 09:00:00', hb.id)
  assert.equal(await tick(w), 1)
  assert.equal(jobsFor(hb.id).length, 1)
  const advanced = nextRunOf(hb.id)
  assert.ok(advanced > new Date().toISOString().replace('T', ' ').slice(0, 19), 'next_run_at moved past now')
  assert.match(wall(new Date(`${advanced.replace(' ', 'T')}Z`), PR), /^(Tue|Wed|Thu|Fri) 05:00$/)
  // …and a second tick in the same slot does nothing, whether or not the job has finished.
  assert.equal(await tick(w), 0)
  assert.deepEqual(await w.call('fireHeartbeat', hb.id), { fired: false })
  side.prepare(`UPDATE agent_jobs SET status = 'done' WHERE heartbeat_id = ?`).run(hb.id)
  assert.equal(await tick(w), 0)

  // Restart after the run: the fresh instance does not run that slot again.
  await w.stop()
  w = startWorker(); await w.ready
  assert.equal(await tick(w), 0, 'no double run after restart')
  assert.equal(jobsFor(hb.id).length, 1)
  assert.equal(nextRunOf(hb.id), advanced, 'boot does not reschedule')

  // The server is down across a slot (several, even): at boot it is overdue and runs exactly once.
  await w.stop()
  side.prepare('UPDATE heartbeats SET next_run_at = ? WHERE id = ?').run('2026-10-13 09:00:00', hb.id)
  w = startWorker(); await w.ready
  assert.equal(await tick(w), 1, 'missed slot runs at boot')
  assert.equal(await tick(w), 0, 'missed slots collapse into one run')
  assert.equal(jobsFor(hb.id).length, 2)

  // A restart while that run is still queued neither duplicates it nor loses the next slot.
  await w.stop()
  w = startWorker(); await w.ready
  assert.equal(await tick(w), 0)
  assert.equal(jobsFor(hb.id).length, 2)
  assert.ok(nextRunOf(hb.id) > '2026-10-13 09:00:00')

  // Interval heartbeats through the same path: unchanged columns, fire once, advance by the rule.
  const interval = await w.call('createHeartbeat', { title: 'poll', agent_path: dir, prompt: 'poll', interval_minutes: 30, minute_offset: 0 })
  assert.equal(interval.cron_expression, null)
  assert.equal(interval.timezone, null)
  assert.deepEqual(interval.upcoming_runs, [])
  side.prepare('UPDATE heartbeats SET next_run_at = ? WHERE id = ?').run('2026-10-16 09:00:00', interval.id)
  assert.equal(await tick(w), 1)
  assert.equal(await tick(w), 0)
  const legacyNext = Date.parse(`${nextRunAt(30, null, 0).replace(' ', 'T')}Z`)
  assert.ok(Math.abs(Date.parse(`${nextRunOf(interval.id).replace(' ', 'T')}Z`) - legacyNext) <= 1000)

  // Switching between schedule types through update.
  await assert.rejects(w.call('updateHeartbeat', hb.id, { interval_minutes: 60 }), /set cron_expression to null/)
  const switched = await w.call('updateHeartbeat', hb.id, { cron_expression: null, timezone: null, interval_minutes: 1440, run_at_time: '05:00' })
  assert.equal(switched.cron_expression, null)
  assert.equal(switched.run_at_time, '05:00')
  const back = await w.call('updateHeartbeat', hb.id, { cron_expression: '0 5 * * 2-5', timezone: PR })
  assert.equal(back.run_at_time, null)
  assert.match(back.next_run_at, /T09:00:00Z$/)

  console.log('PASS  restart: once per slot, no double run, missed slot runs once')
} finally {
  await w.stop()
  side.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── MCP tools ──────────────────────────────────────────────────────────────────
const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-hb-mcp-'))
process.env.TASKOS_DB_DIR = mcpDir
try {
  const { handlers } = await import('../mcp/tools/heartbeats.js')
  const base = { title: 'Morning review', agent_path: mcpDir, prompt: 'review' }
  assert.match(handlers.create_heartbeat({ ...base, cron_expression: '0 5 * * 2-5', timezone: 'Nowhere/Land' }).error, /Unknown timezone/)
  assert.match(handlers.create_heartbeat({ ...base, cron_expression: '0 5 * 2-5' }).error, /expected 5 fields/)
  assert.match(handlers.create_heartbeat({ ...base, cron_expression: '0 5 * * 2-5', interval_minutes: 60 }).error, /can't be combined/)

  const hb = handlers.create_heartbeat({ ...base, cron_expression: '0 5 * * 2-5', timezone: PR })
  assert.equal(hb.error, undefined)
  const listed = handlers.list_heartbeats().find(h => h.id === hb.id)
  assert.equal(listed.cron_expression, '0 5 * * 2-5')
  assert.equal(listed.timezone, PR)
  assert.match(listed.next_run_at, /T09:00:00Z$/)
  assert.equal(listed.upcoming_runs.length, 3)

  assert.match(handlers.update_heartbeat({ id: hb.id, cron_expression: '99 * * * *' }).error, /minute value 99/)
  assert.match(handlers.update_heartbeat({ id: hb.id, timezone: 'Bad/Zone' }).error, /Unknown timezone/)
  const moved = handlers.update_heartbeat({ id: hb.id, timezone: NY })
  assert.equal(moved.timezone, NY)
  assert.match(moved.next_run_at, /T(09|10):00:00Z$/, '05:00 New York is 09:00Z or 10:00Z depending on DST')
  console.log('PASS  MCP create/update/list with cron_expression and timezone')
} finally {
  fs.rmSync(mcpDir, { recursive: true, force: true })
}

console.log('\nAll heartbeat schedule tests passed.')
