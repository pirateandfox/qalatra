// scripts/test-mcp-update-status.mjs
// Test C14 on the MCP surface: update_task { status:'done' } on a recurring task must preserve
// the chain (set outcome + spawn the next occurrence), like complete_task — not silently end it.
//
// TASKOS_DB_DIR set before importing mcp/db.js. Run: node scripts/test-mcp-update-status.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-updstatus-'))
process.env.TASKOS_DB_DIR = dir

let failures = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
}

try {
  const { openDb, today } = await import('../mcp/db.js')
  const { handlers } = await import('../mcp/tools/tasks.js')
  const db = openDb()

  // Recurring task completed via update_task {status:'done'}.
  const rec = handlers.create_task({ title: 'weekly', recurrence: 'weekly', due_date: today() })
  handlers.update_task({ task_id: rec.task_id, status: 'done' })
  const orig = db.prepare('SELECT status, outcome FROM tasks WHERE id = ?').get(rec.task_id)
  check('recurring: original marked done', orig.status, 'done')
  check('recurring: outcome set to completed', orig.outcome, 'completed')
  const spawnCount = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE ai_context LIKE ?").get(`%Recurred from task ${rec.task_id}%`).c
  check('recurring: exactly one next occurrence spawned', spawnCount, 1)

  // Non-recurring task completed via update_task must NOT spawn anything.
  const plain = handlers.create_task({ title: 'one-off', due_date: today() })
  handlers.update_task({ task_id: plain.task_id, status: 'done' })
  const total = db.prepare("SELECT COUNT(*) AS c FROM tasks").get().c
  check('non-recurring: no extra task spawned (total is 3: rec, spawn, plain)', total, 3)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1) }
console.log('\nAll update_task status (C14) tests passed.')
