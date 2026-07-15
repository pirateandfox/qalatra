// scripts/test-mcp-heartbeats.mjs
// Integration test for heartbeat schedule recompute (bugs C8/C18): update_heartbeat must
// recompute next_run_at on any schedule-field change and normalize run_at_time/minute_offset.
// Exercises the MCP copy (mcp/tools/heartbeats.js); the db-worker copy mirrors it field-for-field.
//
// TASKOS_DB_DIR is set before importing mcp/db.js. Run: node scripts/test-mcp-heartbeats.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-hb-'))
process.env.TASKOS_DB_DIR = dir

let failures = 0
function check(name, cond) {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
}

try {
  const { handlers } = await import('../mcp/tools/heartbeats.js')

  // Daily heartbeat at a fixed time → next_run_at is the next 09:00.
  const hb = handlers.create_heartbeat({ title: 'daily', agent_path: '/tmp/a', prompt: 'go', interval_minutes: 1440, run_at_time: '09:00' })
  check('created with a next_run_at', !!hb.next_run_at)
  const original = hb.next_run_at

  // Shorten to a 30-minute interval → next_run_at must be recomputed to <= ~30 min from now,
  // and the now-invalid run_at_time must be normalized away.
  const updated = handlers.update_heartbeat({ id: hb.id, interval_minutes: 30, minute_offset: 0 })
  check('next_run_at recomputed (changed)', updated.next_run_at !== original)
  check('interval_minutes persisted', updated.interval_minutes === 30)
  check('run_at_time normalized to null for sub-daily', updated.run_at_time == null)
  const soon = new Date(Date.now() + 31 * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  check('next_run_at is within ~31 min (not the stale daily time)', updated.next_run_at <= soon)

  // Editing only a non-schedule field must NOT move next_run_at.
  const afterTitle = handlers.update_heartbeat({ id: hb.id, title: 'renamed' })
  check('non-schedule edit leaves next_run_at unchanged', afterTitle.next_run_at === updated.next_run_at)
  check('title updated', afterTitle.title === 'renamed')

  check('update of missing heartbeat returns error', !!handlers.update_heartbeat({ id: 'nope', title: 'x' }).error)

  // Idempotent active (toggle_heartbeat blind-flip fix): disabling twice must stay disabled.
  const off1 = handlers.update_heartbeat({ id: hb.id, active: false })
  check('active: false disables', off1.active === 0)
  const off2 = handlers.update_heartbeat({ id: hb.id, active: false })
  check('active: false again stays disabled (idempotent)', off2.active === 0)

  // Re-enabling schedules a next run; re-enabling again must not move it.
  const on1 = handlers.update_heartbeat({ id: hb.id, active: true })
  check('active: true re-enables', on1.active === 1)
  check('re-enable schedules next_run_at', !!on1.next_run_at)
  const on2 = handlers.update_heartbeat({ id: hb.id, active: true })
  check('active: true again stays enabled (idempotent)', on2.active === 1)
  check('repeat enable leaves next_run_at unchanged', on2.next_run_at === on1.next_run_at)

  // Combined schedule + active change must not double-set next_run_at.
  const combo = handlers.update_heartbeat({ id: hb.id, interval_minutes: 60, minute_offset: 0, active: true })
  check('schedule + active combo applies both', combo.active === 1 && combo.interval_minutes === 60)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1) }
console.log('\nAll heartbeat (C8/C18) tests passed.')
