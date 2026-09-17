// scripts/test-job-concurrency.mjs
// Integration test for per-key job serialization in db-worker getQueuedJobs.
//
// Every job in an agent folder shares that folder's working tree, so two jobs there at once
// fight over one checkout. Before this, getQueuedJobs returned queued jobs in created_at order
// with no regard for what was already running or for what else was in the same batch, so a
// backlog landing after a restart (or two dispatches queued back to back on one task) ran
// concurrently. The rule now: at most one job per concurrency key at a time, where the key is
// agent.config `concurrency_key` and defaults to the agent folder.
//
// Drives db-worker.js as a real worker thread against a throwaway DB. Run:
//   node scripts/test-job-concurrency.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-jobs-'))
const worker = new Worker(path.join(ROOT, 'db-worker.js'), { workerData: { dbPath: path.join(dir, 'tasks.db') } })

let seq = 0
const pending = new Map()
worker.on('message', msg => {
  if (msg.ready) return
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result)
})
function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, method, args })
  })
}
await new Promise(resolve => worker.once('message', m => m.ready && resolve()))

let failures = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`)
}
const ids = jobs => jobs.map(j => j.id).sort()

try {
  // Three agent folders. A and B share a key (one repo split into plan/ and execute/ folders);
  // C has no key and so is serialized on its own folder path.
  await call('upsertAgents', [
    { path: '/agents/repo/plan', name: 'plan', concurrencyKey: 'repo' },
    { path: '/agents/repo/execute', name: 'execute', concurrencyKey: 'repo' },
    { path: '/agents/other', name: 'other' },
  ])

  const mk = async (id, agentPath, title) => {
    const t = await call('createTask', { title, agent_path: agentPath, context: 'internal' })
    // Give each job a distinct created_at so ordering is deterministic without sleeping.
    return { taskId: t.id, ...(await call('createAgentJob', t.id, `job ${id}`)) }
  }

  const a1 = await mk('a1', '/agents/repo/plan', 'A1')
  const a2 = await mk('a2', '/agents/repo/execute', 'A2')
  const c1 = await mk('c1', '/agents/other', 'C1')
  const c2 = await mk('c2', '/agents/other', 'C2')

  // Nothing running: one job per key. a1 (repo) and c1 (other) — never a2 or c2 alongside them.
  let batch = await call('getQueuedJobs', 10)
  check('idle: one job per key in a batch', ids(batch), ids([a1, c1]))

  // Claim a1. The repo key is now held: a2 must not be offered, c1 still is.
  await call('startAgentJob', a1.id)
  batch = await call('getQueuedJobs', 10)
  check('running job holds its key', ids(batch), ids([c1]))

  // a1 finishes; a2 becomes eligible again, and only it for that key.
  await call('finishAgentJob', a1.id, 'done', 'ok', 'sess-a1')
  batch = await call('getQueuedJobs', 10)
  check('key released on finish', ids(batch), ids([a2, c1]))

  // Claim both; nothing left to offer even though c2 is queued.
  await call('startAgentJob', a2.id)
  await call('startAgentJob', c1.id)
  batch = await call('getQueuedJobs', 10)
  check('all keys held → empty batch', ids(batch), [])

  // A limit smaller than the eligible set still returns the oldest per key, not the oldest overall
  // repeated. Finish everything, queue two more on `other`, and ask for one.
  await call('finishAgentJob', a2.id, 'done', 'ok', 'sess-a2')
  await call('finishAgentJob', c1.id, 'done', 'ok', 'sess-c1')
  batch = await call('getQueuedJobs', 1)
  check('limit 1 returns the oldest eligible job', ids(batch), ids([c2]))

  // A job whose agent folder is not in the agents table (removed or never scanned) still
  // serializes on its own path rather than escaping the rule.
  const z1 = await mk('z1', '/agents/unscanned', 'Z1')
  const z2 = await mk('z2', '/agents/unscanned', 'Z2')
  batch = await call('getQueuedJobs', 10)
  check('unscanned folder serializes on its path', ids(batch), ids([c2, z1]))
  await call('startAgentJob', z1.id)
  batch = await call('getQueuedJobs', 10)
  check('unscanned folder key held while running', ids(batch), ids([c2]))
  void z2

  // Resume lookup is unchanged: a2's job on the repo key still sees its own task's session.
  const a3 = await call('createAgentJob', a2.taskId, 'follow-up')
  await call('startAgentJob', c2.id)
  batch = await call('getQueuedJobs', 10)
  const a3row = batch.find(j => j.id === a3.id)
  check('prevSessionId still resolved per task', a3row?.prevSessionId, 'sess-a2')
} catch (err) {
  failures++
  console.log(`FAIL  ${err.stack || err}`)
} finally {
  await worker.terminate()
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nAll passed')
