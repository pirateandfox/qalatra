// scripts/test-mcp-recur-spawn.mjs
// What a recurring task's next occurrence carries over, through every spawn path:
//   db-worker: completeTask, skipTask, auto-rollover (today's view)
//   MCP:       complete_task, skip_task, morning_briefing rollover
// All of them insert the row built by nextOccurrenceRow (server/task-logic.js).
//
// Carried over (bug C15): notes, links, time_estimate, agent fields.
// Not carried over: inbox. It flags one occurrence for a human decision; copying it put next
// week's occurrence in the Inbox the moment this week's was completed.
//
// TASKOS_DB_DIR is set before importing mcp/db.js. Run: node scripts/test-mcp-recur-spawn.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-spawn-'))
const dbPath = path.join(dir, 'tasks.db')
process.env.TASKOS_DB_DIR = dir

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
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result)
    })
  })
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, method, args })
  })
  return { ready, call, stop: () => worker.terminate() }
}

const w = startWorker()
let passed = 0
try {
  await w.ready
  const { openDb, today } = await import('../mcp/db.js')
  const { offsetDate } = await import('../server/task-logic.js')
  const { handlers } = await import('../mcp/tools/tasks.js')
  const briefing = await import('../mcp/tools/briefing.js')
  const db = openDb()
  const t = today()
  const links = JSON.stringify(['https://example.com/standing-ref'])

  // An Inbox-flagged weekly series carrying every field C15 protects.
  function seed(id, due = t, extra = {}) {
    db.prepare(`INSERT INTO tasks (id, title, notes, links, status, context, start_date, due_date, task_type, recurrence,
        time_estimate, inbox, agent_path, agent_resume, agent_autorun, agent_autorun_time, missed_occurrence)
      VALUES (@id, 'weekly review', 'standing notes', @links, 'active', 'personal', @start, @due, 'task', 'weekly',
        45, 1, '/agents/review', 0, 1, '06:30', @missed)`)
      .run({ id, links, start: offsetDate(due, -1), due, missed: extra.missed ?? null })
  }
  const spawnedFrom = id => db.prepare('SELECT * FROM tasks WHERE series_id = ? AND id != ?').get(id, id)

  function checkSpawn(label, id) {
    const s = spawnedFrom(id)
    assert.ok(s, `${label}: spawned a next occurrence`)
    assert.equal(s.inbox, 0, `${label}: next occurrence is not in the Inbox`)
    assert.equal(s.notes, 'standing notes', `${label}: notes carried over`)
    assert.equal(s.links, links, `${label}: links carried over`)
    assert.equal(s.time_estimate, 45, `${label}: time_estimate carried over`)
    assert.equal(s.agent_path, '/agents/review', `${label}: agent_path carried over`)
    assert.equal(s.agent_resume, 0, `${label}: agent_resume carried over`)
    assert.equal(s.agent_autorun, 1, `${label}: agent_autorun carried over`)
    assert.equal(s.agent_autorun_time, '06:30', `${label}: agent_autorun_time carried over`)
    assert.ok(s.due_date >= t, `${label}: due date is today or later`)
    assert.equal(s.start_date, offsetDate(s.due_date, -1), `${label}: start→due span kept`)
    passed++
    console.log(`PASS  ${label}`)
  }

  // db-worker paths
  seed('w-complete'); await w.call('completeTask', 'w-complete'); checkSpawn('db-worker completeTask', 'w-complete')
  seed('w-skip'); await w.call('skipTask', 'w-skip'); checkSpawn('db-worker skipTask', 'w-skip')
  seed('w-roll', offsetDate(t, -7), { missed: 'skip' }); await w.call('getTasksForDate', t); checkSpawn('db-worker auto-rollover', 'w-roll')

  // MCP paths
  seed('m-complete'); handlers.complete_task({ task_id: 'm-complete' }); checkSpawn('MCP complete_task', 'm-complete')
  seed('m-skip'); handlers.skip_task({ task_id: 'm-skip' }); checkSpawn('MCP skip_task', 'm-skip')
  seed('m-roll', offsetDate(t, -7), { missed: 'skip' }); briefing.handlers.morning_briefing(); checkSpawn('MCP briefing rollover', 'm-roll')

  // The completed occurrence keeps its own flag; only the new one starts clean.
  assert.equal(db.prepare('SELECT inbox FROM tasks WHERE id = ?').get('m-complete').inbox, 1)
} finally {
  await w.stop()
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log(`\nAll ${passed} recurrence-spawn paths passed.`)
