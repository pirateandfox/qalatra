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
// Also covers the agent scan that fills the agents table those keys come from: Qalatra Server's
// upsertAgents and the MCP rescan_capabilities tool share one transactional write path, and a
// folder gone from under the scanned root is pruned (agents row deleted, capability inactive).
//
// Drives db-worker.js as a real worker thread against a throwaway DB. Run:
//   node scripts/test-job-concurrency.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-jobs-')))
// The agent-scan section drives the MCP rescan_capabilities tool against the same DB file;
// mcp/db.js reads these at import time, so they are set before its dynamic import below.
process.env.TASKOS_DB_DIR = dir
process.env.TASKOS_SETTINGS_FILE = path.join(dir, 'settings.json')
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

  // ── Per-task worktrees (agent.config `worktrees: true`) ──────────────────────────────────────
  // A job with a task identity (external_meta.task_ref) in an opted-in folder is keyed
  // `<folder key>#<task_ref>`, so different tasks run side by side and one task's jobs still
  // serialize. Everything else keeps the folder key.
  await call('upsertAgents', [
    { path: '/agents/wt', name: 'wt', worktrees: true },
    { path: '/agents/nowt', name: 'nowt' },
  ])
  const only = (batch, prefix) => ids(batch.filter(j => j.agent_path.startsWith(prefix)))
  const ext = async (agentPath, ref, taskId = null) => {
    const task = taskId ? { id: taskId } : await call('createTask', { title: `task ${ref}`, agent_path: agentPath, context: 'internal' })
    const job = await call('queueExternalJob', {
      task_id: task.id, agent_path: agentPath, prompt: `work ${ref}`,
      external_meta: { orchestrator: 'flightdesk', task_ref: ref, agent_path: agentPath },
    })
    return { taskId: task.id, id: job.id }
  }

  const w1a = await ext('/agents/wt', 'fd-1')
  const w1b = await ext('/agents/wt', 'fd-1', w1a.taskId)
  const w2 = await ext('/agents/wt', 'fd-2')
  batch = await call('getQueuedJobs', 10)
  check('worktrees: two task refs in one folder are offered together', only(batch, '/agents/wt'), ids([w1a, w2]))
  check('worktrees: the job carries its task ref', batch.find(j => j.id === w1a.id)?.worktreeTaskRef, 'fd-1')

  await call('startAgentJob', w1a.id)
  batch = await call('getQueuedJobs', 10)
  check('worktrees: same task ref waits while its job runs', only(batch, '/agents/wt'), ids([w2]))
  await call('startAgentJob', w2.id)
  batch = await call('getQueuedJobs', 10)
  check('worktrees: both tasks running → nothing more for either', only(batch, '/agents/wt'), [])

  // A job without a task identity in the same folder uses the folder key and the folder itself,
  // so it is not blocked by the worktree jobs — and two of them still serialize.
  const plain1 = await mk('p1', '/agents/wt', 'plain 1')
  const plain2 = await mk('p2', '/agents/wt', 'plain 2')
  batch = await call('getQueuedJobs', 10)
  check('worktrees: a job without a task ref uses the folder key', only(batch, '/agents/wt'), ids([plain1]))
  check('worktrees: …and runs in the folder', batch.find(j => j.id === plain1.id)?.worktreeTaskRef, null)
  void plain2

  // Folder without the opt-in: unchanged, one per folder even across task refs.
  const n1 = await ext('/agents/nowt', 'fd-10')
  const n2 = await ext('/agents/nowt', 'fd-11')
  batch = await call('getQueuedJobs', 10)
  check('no worktrees: one per folder across task refs', only(batch, '/agents/nowt'), ids([n1]))
  check('no worktrees: no task ref handed to the worker', batch.find(j => j.id === n1.id)?.worktreeTaskRef, null)
  void n2

  // A task that already has a session from a run in the folder itself keeps running there under
  // the folder key: Claude keys sessions by cwd, so a worktree could not resume it.
  await call('finishAgentJob', w1a.id, 'done', 'ok', 'sess-w1a')
  await call('setAgentJobRunCwd', w1a.id, '/repo/.qalatra-worktrees/fd-1/agents/wt')
  const legacy = await ext('/agents/wt', 'fd-legacy')
  await call('startAgentJob', legacy.id)
  await call('setAgentJobRunCwd', legacy.id, '/agents/wt')
  await call('finishAgentJob', legacy.id, 'done', 'ok', 'sess-legacy')
  const legacy2 = await ext('/agents/wt', 'fd-legacy', legacy.taskId)
  const preColumn = await ext('/agents/wt', 'fd-old')
  await call('startAgentJob', preColumn.id)
  await call('finishAgentJob', preColumn.id, 'done', 'ok', 'sess-old') // run_cwd NULL: pre-dates the column
  const preColumn2 = await ext('/agents/wt', 'fd-old', preColumn.taskId)
  await call('startAgentJob', plain1.id)
  batch = await call('getQueuedJobs', 10)
  check('worktrees: a worktree session keeps the task in its worktree', batch.find(j => j.id === w1b.id)?.worktreeTaskRef, 'fd-1')
  check('worktrees: resume still finds the worktree session', batch.find(j => j.id === w1b.id)?.prevSessionId, 'sess-w1a')
  check('worktrees: folder-session tasks wait on the folder key', only(batch, '/agents/wt'), ids([w1b]))
  await call('finishAgentJob', plain1.id, 'done', 'ok', null)
  await call('startAgentJob', plain2.id)
  await call('finishAgentJob', plain2.id, 'done', 'ok', null)
  batch = await call('getQueuedJobs', 10)
  const legacyRow = batch.find(j => j.id === legacy2.id) ?? batch.find(j => j.id === preColumn2.id)
  check('worktrees: a folder-session task is offered once the folder is free', Boolean(legacyRow), true)
  check('worktrees: …and runs in the folder, not a worktree', legacyRow?.worktreeTaskRef, null)
  check('worktrees: folder-session tasks serialize with each other on the folder key',
    only(batch, '/agents/wt').filter(id => id === legacy2.id || id === preColumn2.id).length, 1)

  // ── Agent scan: one write path for Qalatra Server and MCP rescan_capabilities ────────────────
  // Both go through syncScannedAgents (server/capability-registry.js): the same columns, agents +
  // capabilities in one transaction, and folders gone from under the scanned root pruned.
  const { scanAgents } = await import('../server/agents.js')
  const { openDb } = await import('../mcp/db.js')
  const { handlers: capHandlers } = await import('../mcp/tools/capabilities.js')
  const { getCapability, syncScannedAgents } = await import('../server/capability-registry.js')
  const mdb = openDb()
  const writeConfig = (folder, cfg) => {
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'agent.config'), JSON.stringify(cfg))
  }
  const scanRoot = path.join(dir, 'agents-root')
  const pipelineDir = path.join(scanRoot, 'repo', 'pipeline')
  const otherDir = path.join(scanRoot, 'other')
  const offDir = path.join(scanRoot, 'off')
  const outsideDir = path.join(dir, 'outside', 'agent')
  writeConfig(pipelineDir, { name: 'pipeline', worktrees: true, concurrency_key: 'repo-key' })
  writeConfig(otherDir, { name: 'other' })
  writeConfig(offDir, { name: 'off', capability: { active: false } })
  writeConfig(outsideDir, { name: 'outside' })
  const agentRow = async p => {
    const row = (await call('listAgentsDb')).find(a => a.path === p)
    if (!row) return null
    const { last_seen, ...rest } = row
    void last_seen
    return rest
  }
  const capActive = p => getCapability(mdb, { path: p })?.active ?? null
  const mcpRescan = root => capHandlers.rescan_capabilities({ root, exclude_folders: [] })

  await call('upsertAgents', await scanAgents(scanRoot), { root: scanRoot })
  await call('upsertAgents', await scanAgents(path.dirname(outsideDir)), { root: path.dirname(outsideDir) })
  const serverRow = await agentRow(pipelineDir)
  check('scan: server path writes concurrency_key and worktrees', [serverRow?.concurrency_key, serverRow?.worktrees], ['repo-key', 1])
  mdb.prepare('DELETE FROM agents WHERE path = ?').run(pipelineDir)
  await mcpRescan(scanRoot)
  check('scan: MCP rescan yields the same agents row as the server scan', await agentRow(pipelineDir), serverRow)
  check('scan: agent.config active:false is respected', capActive(offDir), false)

  fs.rmSync(otherDir, { recursive: true, force: true })
  fs.rmSync(outsideDir, { recursive: true, force: true })
  let res = await mcpRescan(path.join(scanRoot, 'repo'))
  check('scan: narrow rescan leaves rows outside its root alone',
    [Boolean(await agentRow(otherDir)), capActive(otherDir), Boolean(await agentRow(outsideDir)), res.removed_agents], [true, true, true, []])
  res = await mcpRescan(scanRoot)
  check('scan: removed folder → agents row gone, capability inactive', [await agentRow(otherDir), capActive(otherDir)], [null, false])
  check('scan: …and only it', res.removed_agents, [otherDir])
  check('scan: a folder outside the scanned root is untouched even when gone', [Boolean(await agentRow(outsideDir)), capActive(outsideDir)], [true, true])
  check('scan: surviving folders untouched', [Boolean(await agentRow(pipelineDir)), capActive(pipelineDir)], [true, true])
  const missingRoot = await call('upsertAgents', [], { root: path.join(dir, 'no-such-root') })
  check('scan: a missing root prunes nothing', missingRoot.removedAgents, [])

  writeConfig(otherDir, { name: 'other' })
  await call('upsertAgents', await scanAgents(scanRoot), { root: scanRoot })
  check('scan: folder reappears → agents row back, capability active', [Boolean(await agentRow(otherDir)), capActive(otherDir)], [true, true])
  check('scan: reappearance does not override agent.config active:false', capActive(offDir), false)

  // A failure part-way (the capabilities upsert rejects a row after the agents upsert succeeded)
  // rolls back both tables, on both paths.
  const good = (await scanAgents(scanRoot)).map(a => a.path === pipelineDir ? { ...a, name: 'renamed', concurrencyKey: 'other-key' } : a)
  const bad = { path: path.join(scanRoot, 'bad'), name: 'bad', capability: { id: 'cap_bad', path: path.join(scanRoot, 'bad'), name: null } }
  let threw = false
  try { syncScannedAgents(mdb, [...good, bad], { root: scanRoot }) } catch { threw = true }
  const pipeAfterMcp = await agentRow(pipelineDir)
  check('scan: MCP path failure rolls back agents and capabilities',
    [threw, pipeAfterMcp?.name, pipeAfterMcp?.concurrency_key, Boolean(await agentRow(bad.path)), getCapability(mdb, { path: pipelineDir })?.name],
    [true, 'pipeline', 'repo-key', false, 'pipeline'])
  threw = false
  try { await call('upsertAgents', [...good, bad], { root: scanRoot }) } catch { threw = true }
  const pipeAfterServer = await agentRow(pipelineDir)
  check('scan: server path failure rolls back agents and capabilities',
    [threw, pipeAfterServer?.name, Boolean(await agentRow(bad.path)), getCapability(mdb, { path: pipelineDir })?.name],
    [true, 'pipeline', false, 'pipeline'])
} catch (err) {
  failures++
  console.log(`FAIL  ${err.stack || err}`)
} finally {
  await worker.terminate()
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nAll passed')
