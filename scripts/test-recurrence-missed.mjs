// scripts/test-recurrence-missed.mjs
// A missed recurring occurrence stays active until someone completes or skips it, unless the task
// is set to missed_occurrence = 'skip'. Drives the real db-worker (today's view runs the rollover)
// and the MCP briefing/tasks handlers against the same database file.
//
// Run: node scripts/test-recurrence-missed.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { today, offsetDate } from '../server/task-logic.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-missed-'))
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

const w = startWorker()
try {
  await w.ready
  const side = new Database(dbPath)
  const row = id => side.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  const series = id => side.prepare('SELECT * FROM tasks WHERE series_id = ? ORDER BY created_at').all(id)
  const t = today()
  const lastWeek = offsetDate(t, -7)

  const keep = await w.call('createTask', { title: 'weekly report', recurrence: 'weekly', due_date: lastWeek, ai_context: 'PR #12 still unreviewed' })
  const skip = await w.call('createTask', { title: 'stretch', recurrence: 'daily', due_date: lastWeek, missed_occurrence: 'skip' })
  assert.equal(row(keep.id).missed_occurrence, null, "'keep' is the default and stored as NULL")
  assert.equal(row(skip.id).missed_occurrence, 'skip')
  await assert.rejects(w.call('createTask', { title: 'bad', recurrence: 'daily', missed_occurrence: 'later' }), /missed_occurrence/)

  await w.call('getTasksForDate', t)
  assert.equal(row(keep.id).status, 'active', 'a missed keep occurrence stays active')
  assert.equal(series(keep.id).length, 0, 'and nothing is spawned for it')
  const skipped = row(skip.id)
  assert.equal(skipped.status, 'done')
  assert.equal(skipped.outcome, 'skipped')
  assert.equal(skipped.last_touched_human, null, 'an automatic skip does not claim a person touched it')
  const [skipNext] = series(skip.id)
  assert.ok(skipNext, 'the skip task rolled over')
  assert.equal(skipNext.due_date, t, 'to today, not a past date')
  assert.equal(skipNext.missed_occurrence, 'skip', 'missed_occurrence carries to the next occurrence')
  console.log('PASS  keep stays active; skip rolls over without touching last_touched_human')

  await w.call('completeTask', keep.id)
  const [keepNext] = series(keep.id)
  assert.ok(keepNext.due_date >= t, `completing an overdue occurrence spawns today or later (got ${keepNext.due_date})`)
  assert.equal(keepNext.missed_occurrence, null)
  assert.ok(!keepNext.ai_context.includes('PR #12'), 'ai_context is not copied between occurrences')
  await w.call('completeTask', keepNext.id)
  const chain = series(keep.id)
  assert.equal(chain.length, 2, 'a third occurrence keeps the first occurrence as series_id')
  console.log('PASS  completion advances to today-or-future; series_id carries across occurrences')

  const old = await w.call('getTask', keep.id)
  assert.equal(old.current_occurrence_id, chain[1].id, 'getTask on a finished occurrence names the current one')
  assert.equal((await w.call('getTask', chain[1].id)).current_occurrence_id, undefined, 'an active occurrence has none')

  await w.call('updateTask', keepNext.id, { missed_occurrence: 'skip' })
  assert.equal(row(keepNext.id).missed_occurrence, 'skip')
  await w.call('updateTask', keepNext.id, { missed_occurrence: 'keep' })
  assert.equal(row(keepNext.id).missed_occurrence, null)
  console.log('PASS  HTTP get/update: current_occurrence_id and missed_occurrence')

  // MCP side: briefing rollover and complete_task carry the same columns.
  const { handlers: tasks } = await import('../mcp/tools/tasks.js')
  const { handlers: briefing } = await import('../mcp/tools/briefing.js')
  const mcpKeep = tasks.create_task({ title: 'mcp keep', recurrence: 'weekly', due_date: lastWeek })
  const mcpSkip = tasks.create_task({ title: 'mcp skip', recurrence: 'daily', due_date: lastWeek, missed_occurrence: 'skip' })
  assert.throws(() => tasks.create_task({ title: 'bad', missed_occurrence: 'nope' }), /missed_occurrence/)
  briefing.morning_briefing()
  assert.equal(row(mcpKeep.task_id).status, 'active', 'MCP briefing leaves a keep occurrence alone')
  assert.equal(row(mcpSkip.task_id).status, 'done', 'MCP briefing rolls a skip occurrence over')
  assert.equal(row(mcpSkip.task_id).last_touched_human, null)
  assert.equal(series(mcpSkip.task_id)[0].missed_occurrence, 'skip')
  const done = tasks.complete_task({ task_id: mcpKeep.task_id })
  assert.equal(row(done.next_task_id).series_id, mcpKeep.task_id)
  const viaMcp = tasks.get_task({ task_id: mcpKeep.task_id, fields: 'current_occurrence_id,series_id' })
  assert.equal(viaMcp.current_occurrence_id, done.next_task_id)
  const found = tasks.search_tasks({ series_id: mcpKeep.task_id, fields: 'status' })
  assert.equal(found.length, 2, 'search_tasks by series_id returns every occurrence')
  console.log('PASS  MCP briefing, complete_task, get_task and search_tasks')

  const inFive = offsetDate(t, 5)
  const startOnly = await w.call('createTask', { title: 'start-only later', start_date: inFive })
  const dueOnly = await w.call('createTask', { title: 'due-only later', due_date: inFive })
  const ids = list => list.map(task => task.id)
  const todayView = await w.call('getTasksForDate', t)
  const hiddenToday = [...todayView.overdue, ...todayView.dueToday, ...todayView.active]
  assert.ok(!ids(hiddenToday).includes(startOnly.id) && !ids(hiddenToday).includes(dueOnly.id), 'both stay out of today until their date')
  const later = await w.call('getTasksForDate', inFive)
  assert.ok(ids(later.scheduled).includes(startOnly.id), 'a start-only task is listed on its start date')
  assert.ok(ids(later.scheduled).includes(dueOnly.id), 'a due-only task is still listed on its due date')
  const both = await w.call('createTask', { title: 'span', start_date: inFive, due_date: offsetDate(t, 8) })
  assert.ok(!ids((await w.call('getTasksForDate', inFive)).scheduled).includes(both.id), 'a task with a due date is listed on its due date only')
  console.log('PASS  future-date view lists start-only tasks on their start date')
  side.close()
} finally {
  await w.stop()
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log('\nAll missed-occurrence tests passed.')
