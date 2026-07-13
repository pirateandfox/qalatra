// scripts/test-mcp-recur-spawn.mjs
// Integration test for MCP recurrence respawn field preservation (bug C15): complete_task's
// spawnNextOccurrence must carry notes, links, time_estimate and inbox onto the next occurrence.
// (C9's db-worker completeTaskWithSubtasks mirrors completeTask's spawn but runs inside the
// worker thread, so it is covered by inspection + the shared spawn path exercised here.)
//
// TASKOS_DB_DIR set before importing mcp/db.js. Run: node scripts/test-mcp-recur-spawn.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-spawn-'))
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

  const id = 'rec-src-1'
  const links = JSON.stringify(['https://example.com/ref'])
  db.prepare(`INSERT INTO tasks (id, title, notes, links, status, context, due_date, task_type, recurrence, time_estimate, inbox)
    VALUES (?, 'weekly recurring', 'accumulated notes', ?, 'active', 'personal', ?, 'task', 'weekly', 45, 1)`)
    .run(id, links, today())

  const res = handlers.complete_task({ task_id: id })
  check('complete_task spawned a next occurrence', !!res.next_task_id, true)

  const spawned = db.prepare('SELECT * FROM tasks WHERE id = ?').get(res.next_task_id)
  check('spawned preserves notes', spawned.notes, 'accumulated notes')
  check('spawned preserves links', spawned.links, links)
  check('spawned preserves time_estimate', spawned.time_estimate, 45)
  check('spawned preserves inbox', spawned.inbox, 1)
  check('spawned due_date rolled a week forward', spawned.due_date > today(), true)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1) }
console.log('\nAll MCP recurrence-spawn (C15) tests passed.')
