// scripts/test-mcp-tasks-db.mjs
// Integration tests against a throwaway SQLite DB for two MCP-path bugs:
//   C3 — update_task must store NULL (not '') when clearing parent_id/agent_path/assigned_agent,
//        or the task vanishes from every top-level UI list (parent_id IS NULL filter).
//   C4 — morning_briefing's recurring rollover must preserve notes/links/agent linkage and must
//        NOT force-complete events.
//
// TASKOS_DB_DIR is set BEFORE importing mcp/db.js (which reads it at module load).
// Run: node scripts/test-mcp-tasks-db.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-tasksdb-'))
process.env.TASKOS_DB_DIR = dir

let failures = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
}

try {
  const { openDb, today } = await import('../mcp/db.js')
  const { handlers: taskHandlers } = await import('../mcp/tools/tasks.js')
  const { handlers: briefingHandlers } = await import('../mcp/tools/briefing.js')
  const db = openDb()

  // ── C3: clearing parent_id/agent_path/assigned_agent with '' must persist NULL ──
  const parent = taskHandlers.create_task({ title: 'parent' })
  const child = taskHandlers.create_task({ title: 'child', parent_id: parent.task_id, agent_path: '/tmp/x', assigned_agent: 'someagent' })

  let row = db.prepare('SELECT parent_id, agent_path, assigned_agent FROM tasks WHERE id = ?').get(child.task_id)
  check('C3 setup: child starts attached to parent', row.parent_id, parent.task_id)

  taskHandlers.update_task({ task_id: child.task_id, parent_id: '', agent_path: '', assigned_agent: '' })
  row = db.prepare('SELECT parent_id, agent_path, assigned_agent FROM tasks WHERE id = ?').get(child.task_id)
  check('C3: cleared parent_id is NULL', row.parent_id, null)
  check('C3: cleared agent_path is NULL', row.agent_path, null)
  check('C3: cleared assigned_agent is NULL', row.assigned_agent, null)

  // The whole point: a top-level `parent_id IS NULL` query now finds the detached task.
  const visible = db.prepare("SELECT 1 AS v FROM tasks WHERE id = ? AND parent_id IS NULL").get(child.task_id)
  check('C3: detached task is visible to top-level (parent_id IS NULL) queries', visible?.v, 1)

  // ── C4: morning_briefing rollover preserves fields and skips events ──
  const links = JSON.stringify([{ url: 'https://example.com', title: 'ref' }])
  const recId = 'rec-task-1'
  db.prepare(`INSERT INTO tasks (id, title, notes, links, status, context, due_date, task_type, recurrence, agent_path, agent_resume, agent_autorun, agent_autorun_time)
    VALUES (?, ?, ?, ?, 'active', 'personal', '2020-01-01', 'task', 'daily', '/agents/thing', 1, 1, '09:00')`)
    .run(recId, 'overdue recurring', 'keep these notes', links)

  const evId = 'rec-event-1'
  db.prepare(`INSERT INTO tasks (id, title, status, context, due_date, task_type, recurrence)
    VALUES (?, ?, 'active', 'personal', '2020-01-01', 'event', 'daily')`)
    .run(evId, 'overdue recurring event')

  briefingHandlers.morning_briefing()

  const orig = db.prepare('SELECT status, outcome FROM tasks WHERE id = ?').get(recId)
  check('C4: original recurring task marked done', orig.status, 'done')

  const spawned = db.prepare("SELECT * FROM tasks WHERE ai_context LIKE ? AND id != ?").get(`%Auto-recurred from task ${recId}%`, recId)
  check('C4: a next occurrence was spawned', !!spawned, true)
  if (spawned) {
    check('C4: spawned preserves notes', spawned.notes, 'keep these notes')
    check('C4: spawned preserves links', spawned.links, links)
    check('C4: spawned preserves agent_path', spawned.agent_path, '/agents/thing')
    check('C4: spawned preserves agent_autorun', spawned.agent_autorun, 1)
    check('C4: spawned preserves agent_autorun_time', spawned.agent_autorun_time, '09:00')
    check('C4: spawned due_date rolled to today-or-future', spawned.due_date >= today(), true)
  }

  const ev = db.prepare('SELECT status, outcome FROM tasks WHERE id = ?').get(evId)
  check('C4: overdue recurring EVENT is left active (not force-completed)', ev.status, 'active')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1) }
console.log('\nAll MCP tasks-db (C3/C4) tests passed.')
