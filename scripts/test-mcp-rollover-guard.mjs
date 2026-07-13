// scripts/test-mcp-rollover-guard.mjs
// Regression test for the recurring-rollover concurrency guard (bug C12). The true failure is
// cross-process (two connections rolling over the same task), which a single-threaded test can't
// reproduce; this instead verifies the compare-and-set behaviour that makes duplication
// impossible: a task already claimed (status flipped) is NOT spawned again, and repeated rollover
// runs never produce a second occurrence.
//
// TASKOS_DB_DIR set before importing mcp/db.js. Run: node scripts/test-mcp-rollover-guard.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-rollover-'))
process.env.TASKOS_DB_DIR = dir

let failures = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
}

try {
  const { openDb } = await import('../mcp/db.js')
  const { handlers } = await import('../mcp/tools/briefing.js')
  const db = openDb()

  const id = 'roll-1'
  db.prepare(`INSERT INTO tasks (id, title, status, context, due_date, task_type, recurrence)
    VALUES (?, 'overdue daily', 'active', 'personal', '2020-01-01', 'task', 'daily')`).run(id)

  handlers.morning_briefing()
  handlers.morning_briefing() // second run must NOT create a duplicate

  const spawnedCount = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE ai_context LIKE ?").get(`%Auto-recurred from task ${id}%`).c
  check('exactly one next occurrence after two rollover runs', spawnedCount, 1)

  const original = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id)
  check('original claimed to done', original.status, 'done')

  // Compare-and-set: a task no longer 'active' is never re-claimed/spawned. Insert one that is
  // already done+overdue+recurring; it must not be selected or spawned.
  db.prepare(`INSERT INTO tasks (id, title, status, context, due_date, task_type, recurrence)
    VALUES ('roll-done', 'already done', 'done', 'personal', '2020-01-01', 'task', 'daily')`).run()
  handlers.morning_briefing()
  const doneSpawn = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE ai_context LIKE ?").get('%Auto-recurred from task roll-done%').c
  check('a non-active recurring task is never spawned', doneSpawn, 0)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1) }
console.log('\nAll rollover-guard (C12) tests passed.')
