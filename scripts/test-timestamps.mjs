import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { toOffsetIso, withTimestampZones, TIMESTAMP_ZONES } from '../server/task-logic.js'

// This suite must run on a fixed-offset zone, or a DST-observing zone would make the expected
// offsets depend on the date the test runs. America/Puerto_Rico is UTC-4 year round and matches
// the boxes Qalatra actually runs on.
assert.equal(process.env.TZ, 'America/Puerto_Rico', 'run via `npm run test:timestamps` (sets TZ)')

// ── The regression this exists to prevent ──────────────────────────────────────
// heartbeats.last_run_at is UTC and heartbeats.updated_at is local, in the same row. Before these
// were serialized with an explicit offset, an audit compared them directly and concluded that
// dispatches at 20:45 UTC came *after* a fix stamped 16:49:43 local — when that fix is 20:49:43 UTC,
// four minutes later. Parsing both with a standard date parser must now order them correctly.
const heartbeat = withTimestampZones(
  { last_run_at: '2026-08-10 20:45:00', next_run_at: '2026-08-10 21:45:00', updated_at: '2026-08-10 16:49:43' },
  'heartbeats',
)
assert.equal(heartbeat.last_run_at, '2026-08-10T20:45:00Z')
assert.equal(heartbeat.updated_at, '2026-08-10T16:49:43-04:00')
assert.ok(
  new Date(heartbeat.updated_at) > new Date(heartbeat.last_run_at),
  'a local 16:49:43 fix must order after a 20:45:00 UTC dispatch on a UTC-4 box',
)

// ── Per-table keying ───────────────────────────────────────────────────────────
// created_at is UTC in agent_jobs (SQLite DEFAULT datetime('now')) and local in heartbeats
// (nowIso()). Keying by column name alone would silently mislabel one of them.
assert.equal(withTimestampZones({ created_at: '2026-08-10 20:45:00' }, 'agent_jobs').created_at, '2026-08-10T20:45:00Z')
assert.equal(
  withTimestampZones({ created_at: '2026-08-10 20:45:00' }, 'heartbeats').created_at,
  '2026-08-10T20:45:00-04:00',
)
assert.notEqual(TIMESTAMP_ZONES.agent_jobs.created_at, TIMESTAMP_ZONES.heartbeats.created_at)

// ── Shape and safety ───────────────────────────────────────────────────────────
assert.equal(toOffsetIso(null, 'utc'), null)
assert.equal(toOffsetIso(undefined, 'local'), undefined)
assert.equal(toOffsetIso('not-a-timestamp', 'local'), 'not-a-timestamp')
// Already-stamped values pass through untouched, so applying this twice is harmless.
assert.equal(toOffsetIso(toOffsetIso('2026-08-10 20:45:00', 'utc'), 'utc'), '2026-08-10T20:45:00Z')
// Null columns stay null rather than becoming a bogus epoch.
assert.equal(withTimestampZones({ started_at: null, created_at: '2026-08-10 20:45:00' }, 'agent_jobs').started_at, null)
// Arrays map element-wise; unknown tables and empty rows are returned as-is.
assert.deepEqual(
  withTimestampZones([{ created_at: '2026-08-10 20:45:00' }, { created_at: '2026-08-10 21:00:00' }], 'agent_jobs')
    .map(r => r.created_at),
  ['2026-08-10T20:45:00Z', '2026-08-10T21:00:00Z'],
)
// A table with no entry in the map is returned untouched rather than guessed at.
assert.deepEqual(withTimestampZones({ created_at: '2026-08-10 20:45:00' }, 'contexts'), { created_at: '2026-08-10 20:45:00' })
assert.equal(withTimestampZones(null, 'agent_jobs'), null)

// Non-timestamp columns are never touched.
const preserved = withTimestampZones({ id: 'hb1', title: '2026 planning', active: 1 }, 'heartbeats')
assert.deepEqual(preserved, { id: 'hb1', title: '2026 planning', active: 1 })


// ── tasks / notes / attachments ────────────────────────────────────────────────
// tasks-vs-agent_jobs is the most reachable cross-zone comparison in the system, because
// /tasks/:id/agent-jobs hands a caller both at once. A task created at 16:49:43 local must order
// after a job dispatched at 20:45:00 UTC, not ~4h before it.
const task = withTimestampZones({ created_at: '2026-08-10 16:49:43', last_reviewed_at: '2026-08-10 09:00:00' }, 'tasks')
const dispatch = withTimestampZones({ created_at: '2026-08-10 20:45:00' }, 'agent_jobs')
assert.equal(task.created_at, '2026-08-10T16:49:43-04:00')
assert.equal(dispatch.created_at, '2026-08-10T20:45:00Z')
assert.ok(new Date(task.created_at) > new Date(dispatch.created_at), 'task must order after the job')

// notes and attachments are child records of the same task that disagree with each other:
// notes DEFAULTs to datetime('now','localtime'), attachments to datetime('now').
assert.equal(withTimestampZones({ created_at: '2026-08-10 12:00:00' }, 'notes').created_at, '2026-08-10T12:00:00-04:00')
assert.equal(withTimestampZones({ created_at: '2026-08-10 12:00:00' }, 'attachments').created_at, '2026-08-10T12:00:00Z')

// Date-only columns must survive untouched — they are not in the map, and are not full timestamps.
const dated = withTimestampZones({ due_date: '2026-08-10', start_date: '2026-08-11', created_at: '2026-08-10 12:00:00' }, 'tasks')
assert.equal(dated.due_date, '2026-08-10')
assert.equal(dated.start_date, '2026-08-11')

// The UI slices these strings rather than parsing them; both slices must survive stamping.
assert.equal(task.last_reviewed_at.slice(0, 10), '2026-08-10')
assert.equal(
  withTimestampZones({ created_at: '2026-08-10 14:30:00' }, 'notes').created_at.slice(0, 16).replace('T', ' '),
  '2026-08-10 14:30',
)

// ── Insert-path guard ──────────────────────────────────────────────────────────
// tasks.created_at is declared DEFAULT (datetime('now')) — UTC — while every writer supplies local
// nowIso(). SQLite cannot alter a default in place, so changing it would leave existing databases
// on the old one and only diverge new installs. Instead: every INSERT INTO tasks must name
// created_at explicitly. If one ever stops, UTC values land in a local column and no zone map can
// describe a column with two zones.
// This is a source-text guard, the same technique test-recurrence.mjs uses. Two insert shapes
// exist: a literal column list, and db-worker's createTask, which builds its list from a `cols`
// object. Both must end up naming created_at.
const sources = ['../db-worker.js', '../mcp/tools/tasks.js', '../mcp/tools/briefing.js']
let literal = 0
let dynamic = 0
for (const rel of sources) {
  const src = await readFile(new URL(rel, import.meta.url), 'utf8')
  for (const stmt of src.matchAll(/INSERT INTO tasks\s*\(([\s\S]*?)\)/g)) {
    const columns = stmt[1]
    if (columns.includes('${')) {
      // Dynamic list: the guarantee lives in the object the keys come from.
      dynamic++
      assert.ok(
        /created_at:\s*now\b/.test(src),
        `dynamic INSERT INTO tasks in ${rel} builds its columns from an object that never sets created_at`,
      )
    } else {
      literal++
      assert.ok(
        /\bcreated_at\b/.test(columns),
        `INSERT INTO tasks in ${rel} omits created_at — it would fall through to the UTC schema default`,
      )
    }
  }
}
assert.equal(dynamic, 1, `expected exactly one dynamic task INSERT (db-worker createTask), found ${dynamic}`)
assert.ok(literal >= 5, `expected the known literal task INSERT sites, found ${literal}`)
const inserts = literal + dynamic

console.log(`timestamp serialization tests passed (${inserts} task insert sites checked)`)
