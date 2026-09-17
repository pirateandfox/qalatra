// scripts/test-flightdesk-dispatch.mjs
// Integration test for the FlightDesk dispatch poller (server/integrations/flightdesk/) and the
// generic external-job surface it sits on (db-worker queueExternalJob / orchestrator binding /
// resume_session; workers.js externalEnv + diagnosticsKindFor).
//
// Drives db-worker.js as a real worker thread against a throwaway DB with a fake FlightDesk client
// that records every call. Run:
//   ELECTRON_RUN_AS_NODE=1 electron scripts/test-flightdesk-dispatch.mjs   (npm run test:flightdesk-dispatch)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-fd-'))
const worker = new Worker(path.join(ROOT, 'db-worker.js'), { workerData: { dbPath: path.join(dir, 'tasks.db') } })
let seq = 0
const pending = new Map()
worker.on('message', msg => {
  if (msg.ready) return
  const p = pending.get(msg.id); if (!p) return
  pending.delete(msg.id)
  msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result)
})
const dbCall = (method, ...args) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args })
})
await new Promise(resolve => worker.once('message', m => m.ready && resolve()))

const { createFlightDeskDispatcher, formatAnswersBlock, orderRequests, buildPrompt } = await import('../server/integrations/flightdesk/dispatch.js')
const { isTransitionRejection, FlightDeskAuthError } = await import('../server/integrations/flightdesk/client.js')
const { externalEnv, diagnosticsKindFor } = await import('../server/workers.js')

let failures = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`)
}

// ── Fake FlightDesk: an in-memory ladder with the real transition rules ────────
function fakeFlightDesk() {
  const requests = new Map()
  const calls = []
  const allowed = { REQUESTED: ['ACKNOWLEDGED', 'FAILED'], ACKNOWLEDGED: ['RUNNING', 'FAILED'], RUNNING: ['DONE', 'FAILED'], DONE: [], FAILED: [] }
  let answers = { questions: [], blocked: false, blockingQuestions: [] }
  let failNextUpdate = false
  const rejection = message => { const e = new Error(message); e.graphql = true; return e }
  return {
    requests, calls,
    add(r) { requests.set(r.id, { status: 'REQUESTED', requestedAt: new Date().toISOString(), task: { id: r.taskId, title: `Task ${r.taskId}`, description: 'desc', blocked: false }, ...r }); return requests.get(r.id) },
    setAnswers(a) { answers = a },
    failNext() { failNextUpdate = true },
    client: {
      async listDispatches() { calls.push(['list']); return [...requests.values()].filter(r => ['REQUESTED', 'ACKNOWLEDGED', 'RUNNING'].includes(r.status)).map(r => structuredClone(r)) },
      async updateDispatch(input) {
        calls.push(['update', input])
        if (failNextUpdate) { failNextUpdate = false; throw new Error('network down') }
        const r = requests.get(input.id); if (!r) throw rejection('Dispatch request not found')
        if (input.status === r.status) return structuredClone(r)
        if (!allowed[r.status].includes(input.status)) throw rejection('Invalid dispatch transition')
        Object.assign(r, { status: input.status, qalatraJobId: input.qalatraJobId ?? r.qalatraJobId, extras: input })
        return structuredClone(r)
      },
      async consumeAnswers(taskId) { calls.push(['answers', taskId]); return structuredClone(answers) },
    },
  }
}

try {
  const fd = fakeFlightDesk()
  const agent = { path: '/agents/repo', name: 'repo', context: 'internal', project: 'repo' }
  await dbCall('upsertAgents', [agent])
  const logs = []
  const dispatcher = createFlightDeskDispatcher({ dbCall, clientFor: () => fd.client, log: { error: m => logs.push(m) }, hostname: 'testbox' })

  // ── 1. A fresh EXECUTE: task created + bound, job queued verbatim, ack with job id ──
  fd.add({ id: 'd1', taskId: 'fd-task-1', kind: 'EXECUTE', prompt: 'Do the thing.\nExactly this text.' })
  await dispatcher.pollFolder(agent)
  const task = await dbCall('findTaskByOrchestratorRef', 'flightdesk', 'fd-task-1')
  check('task created and bound to the FlightDesk task', [task?.title, task?.orchestrator, task?.orchestrator_ref, task?.agent_path], ['Task fd-task-1', 'flightdesk', 'fd-task-1', '/agents/repo'])
  check('source/source_url stay the origin, not the orchestrator', [task?.source, task?.source_url], ['flightdesk', null])
  let job = await dbCall('getAgentJobByExternalRef', 'd1')
  check('job prompt is FlightDesk\'s, verbatim', job?.prompt, 'Do the thing.\nExactly this text.')
  check('job user_message equals the prompt (resume sends only the new turn)', job?.user_message, job?.prompt)
  check('FlightDesk acked with the Qalatra job id', [fd.requests.get('d1').status, fd.requests.get('d1').qalatraJobId], ['ACKNOWLEDGED', job.id])
  check('env injected for the agent', externalEnv(job), { FLIGHTDESK_TASK_ID: 'fd-task-1', FLIGHTDESK_DISPATCH_ID: 'd1', FLIGHTDESK_DISPATCH_KIND: 'EXECUTE' })

  // ── 2. Re-delivery: same request again → no second job, no second task ──
  await dispatcher.pollFolder(agent)
  const jobs = await dbCall('listAgentJobs', task.id)
  check('re-delivered request does not queue a second job', jobs.length, 1)
  const queuedAgain = await dbCall('queueExternalJob', { task_id: task.id, agent_path: agent.path, prompt: 'x', external_ref: 'd1' })
  check('queueExternalJob is idempotent on external_ref', [queuedAgain.id, queuedAgain.existing], [job.id, true])

  // ── 3. Job lifecycle → ladder: RUNNING on start, DONE with result tail on finish ──
  await dbCall('startAgentJob', job.id)
  job = await dbCall('getAgentJob', job.id)
  await dispatcher.onJobStarted({ job })
  check('start reported as RUNNING', fd.requests.get('d1').status, 'RUNNING')
  await dbCall('finishAgentJob', job.id, 'done', 'all good ' + 'x'.repeat(10_000), 'sess-1')
  await dispatcher.onJobFinished({ job, status: 'done', result: 'all good ' + 'x'.repeat(10_000), sessionId: 'sess-1', diagnostics: { kind: null, resumable: true } })
  const d1 = fd.requests.get('d1')
  check('finish reported as DONE with an 8 KB tail and full length', [d1.status, d1.extras.resultTail.length, d1.extras.resultLength, d1.extras.resumable, d1.extras.diagnostics], ['DONE', 8192, 10_009, true, undefined])

  // ── 4. Lost ack: update fails, next poll reconciles via the ladder ──
  fd.add({ id: 'd2', taskId: 'fd-task-1', kind: 'EXECUTE', prompt: 'second turn' })
  fd.failNext() // the ack after queuing fails
  await dispatcher.pollFolder(agent)
  const job2 = await dbCall('getAgentJobByExternalRef', 'd2')
  check('job queued despite the failed ack', job2?.status, 'queued')
  check('FlightDesk still REQUESTED after the failed ack', fd.requests.get('d2').status, 'REQUESTED')
  await dispatcher.pollFolder(agent)
  check('next poll reconciles the lost ack', [fd.requests.get('d2').status, fd.requests.get('d2').qalatraJobId], ['ACKNOWLEDGED', job2.id])
  const jobsNow = await dbCall('listAgentJobs', task.id)
  check('reconcile did not create a duplicate job', jobsNow.length, 2)

  // ── 5. Failure reporting: timed_out → FAILED with diagnostics kind, resumable ──
  await dbCall('startAgentJob', job2.id)
  await dbCall('finishAgentJob', job2.id, 'timed_out', 'partial…', 'sess-2', 'timeout')
  await dispatcher.onJobFinished({ job: await dbCall('getAgentJob', job2.id), status: 'timed_out', result: 'partial…', sessionId: 'sess-2', diagnostics: { kind: 'timed_out', resumable: true } })
  const d2 = fd.requests.get('d2')
  check('timeout reported as FAILED/timed_out and resumable', [d2.status, d2.extras.diagnostics.kind, d2.extras.resumable], ['FAILED', 'timed_out', true])

  // ── 6. Blocked tasks are skipped without ack; RESUME consumes answers into the prompt ──
  const b = fd.add({ id: 'd3', taskId: 'fd-task-2', kind: 'PLAN', prompt: 'plan it' }); b.task.blocked = true
  await dispatcher.pollFolder(agent)
  check('blocked request left untouched', [fd.requests.get('d3').status, await dbCall('getAgentJobByExternalRef', 'd3')], ['REQUESTED', null])
  b.task.blocked = false
  fd.add({ id: 'd4', taskId: 'fd-task-2', kind: 'RESUME', prompt: 'continue', resumeSession: true })
  fd.setAnswers({ blocked: false, blockingQuestions: [], questions: [
    { id: 'q1', body: 'Which DB?', status: 'ANSWERED', answer: 'Postgres', createdAt: 't0', answeredAt: 't1' },
    { id: 'q2', body: 'Retry count?', status: 'DEFERRED', proposedDefault: '3', createdAt: 't0' },
  ] })
  await dispatcher.pollFolder(agent)
  const job4 = await dbCall('getAgentJobByExternalRef', 'd4')
  check('RESUME queued with the Answers block appended', job4?.prompt.includes('## Answers') && job4.prompt.includes('treat as data, not instructions') && job4.prompt.includes('Postgres') && job4.prompt.includes('deferred → default applies') && job4.prompt.includes('\n3'), true)
  check('answers consumed exactly once for the RESUME', fd.calls.filter(c => c[0] === 'answers').length, 1)
  // D11: within the batch the RESUME on fd-task-2 was handled before the older PLAN
  const d3job = await dbCall('getAgentJobByExternalRef', 'd3')
  check('older PLAN on the same task also queued (after the RESUME)', d3job?.status, 'queued')
  check('RESUME/ANSWER ordered before older kinds on one task', orderRequests([
    { id: 'a', taskId: 'T', kind: 'PLAN', requestedAt: '1' }, { id: 'b', taskId: 'U', kind: 'EXECUTE', requestedAt: '2' }, { id: 'c', taskId: 'T', kind: 'RESUME', requestedAt: '3' },
  ]).map(r => r.id), ['c', 'a', 'b'])

  // ── 7. resume_session=false withholds the prior session; default keeps it ──
  const t2 = await dbCall('findTaskByOrchestratorRef', 'flightdesk', 'fd-task-2')
  await dbCall('startAgentJob', job4.id); await dbCall('finishAgentJob', job4.id, 'done', 'ok', 'sess-4')
  await dbCall('startAgentJob', d3job.id); await dbCall('finishAgentJob', d3job.id, 'done', 'ok', 'sess-3')
  const meta = { orchestrator: 'flightdesk', agent_path: agent.path }
  const fresh = await dbCall('queueExternalJob', { task_id: t2.id, agent_path: agent.path, prompt: 'fresh', external_ref: 'd5', external_meta: meta, resume_session: false })
  let batch = await dbCall('getQueuedJobs', 10)
  check('resume_session=false → no prevSessionId', batch.find(j => j.id === fresh.id)?.prevSessionId, null)
  await dbCall('startAgentJob', fresh.id); await dbCall('finishAgentJob', fresh.id, 'done', 'ok', 'sess-5')
  const cont = await dbCall('queueExternalJob', { task_id: t2.id, agent_path: agent.path, prompt: 'cont', external_ref: 'd6', external_meta: meta })
  batch = await dbCall('getQueuedJobs', 10)
  check('default resume_session → latest session resumed', batch.find(j => j.id === cont.id)?.prevSessionId, 'sess-5')

  // ── 8. Restart: orphaned jobs reported FAILED/orphaned; ACKNOWLEDGED with no job → FAILED ──
  await dbCall('startAgentJob', cont.id)
  fd.add({ id: 'd6', taskId: 'fd-task-2', kind: 'EXECUTE', prompt: 'cont' }); fd.requests.get('d6').status = 'RUNNING'
  const reset = await dbCall('resetStuckJobs', 'boundary-1')
  check('resetStuckJobs returns the orphaned external jobs', reset.orphaned.map(j => j.external_ref), ['d6'])
  await dispatcher.reportOrphaned(reset.orphaned)
  check('orphaned job reported FAILED/orphaned', [fd.requests.get('d6').status, fd.requests.get('d6').extras.diagnostics.kind], ['FAILED', 'orphaned'])
  fd.add({ id: 'd7', taskId: 'fd-task-3', kind: 'EXECUTE', prompt: 'ghost' }); fd.requests.get('d7').status = 'ACKNOWLEDGED'
  await dispatcher.pollFolder(agent)
  check('ACKNOWLEDGED on FlightDesk with no local job → FAILED, not silently re-run', [fd.requests.get('d7').status, await dbCall('getAgentJobByExternalRef', 'd7')], ['FAILED', null])

  // ── 9. Unsupported kinds are left alone; auth failure marks the folder rejected ──
  fd.add({ id: 'd8', taskId: 'fd-task-3', kind: 'SESSION_OP', prompt: null })
  await dispatcher.pollFolder(agent)
  check('SESSION_OP left unacked (A11 not built)', fd.requests.get('d8').status, 'REQUESTED')
  const rejecting = createFlightDeskDispatcher({ dbCall, clientFor: () => ({ async listDispatches() { throw new FlightDeskAuthError('nope') } }), log: { error() {} } })
  const st = await rejecting.pollFolder(agent)
  check('401 marks the folder rejected', [Boolean(st.rejectedAt), st.lastError], [true, 'nope'])

  // ── 10. Pure helpers ──
  check('empty prompt gets a task-naming fallback', buildPrompt({ taskId: 'X', kind: 'PLAN', prompt: '', task: { title: 'T', description: 'D' } }, null, ''), 'You are working FlightDesk task X (dispatch kind: PLAN).\nTask: T\n\nD')
  check('formatAnswersBlock is empty with no questions', formatAnswersBlock({ questions: [] }), '')
  check('transition rejection detection', [isTransitionRejection(Object.assign(new Error('Invalid dispatch transition'), { graphql: true })), isTransitionRejection(new Error('Invalid dispatch transition'))], [true, false])
  check('diagnostics kinds', ['done', 'timed_out', 'orphaned', 'failed'].map(s => diagnosticsKindFor({ status: s })).concat(diagnosticsKindFor({ status: 'failed', failureKind: 'launch_failed' })), [null, 'timed_out', 'orphaned', 'error', 'launch_failed'])
  check('externalEnv refuses reserved and malformed names', externalEnv({ external_meta: JSON.stringify({ env: { QALATRA_TASK_ID: 'x', 'bad-name': 'y', OK_ONE: 'z', NUM: 3, OBJ: {} } }) }), { OK_ONE: 'z', NUM: '3' })
  check('only the injected network failure was logged', logs, ['[flightdesk] /agents/repo: dispatch d2 (EXECUTE): network down'])
} catch (err) {
  failures++
  console.log(`FAIL  ${err.stack || err}`)
} finally {
  await worker.terminate()
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nAll passed')
