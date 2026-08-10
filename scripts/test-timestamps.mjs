import assert from 'node:assert/strict'
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
assert.deepEqual(withTimestampZones({ created_at: '2026-08-10 20:45:00' }, 'tasks'), { created_at: '2026-08-10 20:45:00' })
assert.equal(withTimestampZones(null, 'agent_jobs'), null)

// Non-timestamp columns are never touched.
const preserved = withTimestampZones({ id: 'hb1', title: '2026 planning', active: 1 }, 'heartbeats')
assert.deepEqual(preserved, { id: 'hb1', title: '2026 planning', active: 1 })

console.log('timestamp serialization tests passed')
