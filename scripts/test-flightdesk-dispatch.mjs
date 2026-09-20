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

const { createFlightDeskDispatcher, formatAnswersBlock, orderRequests, buildPrompt, sessionOpSpec, flushOutbox, OUTBOX_DIR } = await import('../server/integrations/flightdesk/dispatch.js')
const { BridgeUnavailableError, turnEndsWithQuestion } = await import('../server/session-ops.js')
const { isTransitionRejection, FlightDeskAuthError } = await import('../server/integrations/flightdesk/client.js')
const { externalEnv, diagnosticsKindFor, flightdeskRcEnv, buildAgentEnv } = await import('../server/workers.js')

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
  check('SESSION_OP with no spec → FAILED with a reason (no bridge configured on this dispatcher)', [fd.requests.get('d8').status, fd.requests.get('d8').extras.diagnostics.text], ['FAILED', 'SESSION_OP without an op spec'])
  const rejecting = createFlightDeskDispatcher({ dbCall, clientFor: () => ({ async listDispatches() { throw new FlightDeskAuthError('nope') } }), log: { error() {} } })
  const st = await rejecting.pollFolder(agent)
  check('401 marks the folder rejected', [Boolean(st.rejectedAt), st.lastError], [true, 'nope'])

  // ── 10. SESSION_OP: executed inline by the server, never as a job ──
  const bridgeCalls = []
  let bridgeDown = false, verifyNext = true
  const fakeBridge = {
    async inject({ sessionId, prompt }) { bridgeCalls.push(['inject', sessionId, prompt]); if (bridgeDown) throw new BridgeUnavailableError('down'); return { injected: true, verified: verifyNext, turnId: 'turn-1' } },
    async state({ sessionId }) { bridgeCalls.push(['state', sessionId]); return { state: 'ready', workerStatus: 'idle', prUrl: null, branch: 'feat/x', lastTurnAt: 't9', lastTurnRole: 'assistant', lastTurnEndsWithQuestion: true } },
    async archive({ sessionId }) { bridgeCalls.push(['archive', sessionId]); return { archived: true } },
    async createPr({ sessionId }) { bridgeCalls.push(['create_pr', sessionId]); return { clicked: true, prUrl: null } },
  }
  const fd2 = fakeFlightDesk()
  // Today's FlightDesk has no REQUESTED → DONE shortcut, so the fake enforces the full ladder: the
  // dispatcher must fall back to walking it when the direct report is rejected.
  const opsLogs = []
  const opsDispatcher = createFlightDeskDispatcher({ dbCall, clientFor: () => fd2.client, sessionOps: fakeBridge, log: { error: m => opsLogs.push(m) }, hostname: 'testbox' })
  const agentB = { path: '/agents/ops', name: 'ops', context: 'internal', project: 'ops' }
  await dbCall('upsertAgents', [agentB])

  // FlightDesk's real shape: spec in `sessionOp`, the rendered template text in the request's own `prompt`.
  fd2.add({ id: 's1', taskId: 'fd-task-9', kind: 'SESSION_OP', prompt: 'CI failed on PR #1: lint', sessionOp: { op: 'inject', sessionId: 'sess-cloud-1', templateId: 'ci_failed', params: { checks: ['lint'] } } })
  await opsDispatcher.pollFolder(agentB)
  check('verified inject → DONE with result, no job created', [fd2.requests.get('s1').status, fd2.requests.get('s1').extras.verified, await dbCall('getAgentJobByExternalRef', 's1')], ['DONE', true, null])
  check('inject went to the bridge with the rendered prompt', bridgeCalls[0], ['inject', 'sess-cloud-1', 'CI failed on PR #1: lint'])
  const ledger = await dbCall('getExternalOp', 's1')
  check('op recorded in the ledger', [ledger?.op, ledger?.status, ledger?.result?.turnId], ['inject', 'done', 'turn-1'])

  // Re-delivery of an executed op answers from the ledger — never a second inject.
  fd2.requests.get('s1').status = 'REQUESTED'
  await opsDispatcher.pollFolder(agentB)
  check('re-delivered SESSION_OP is answered from the ledger, not re-executed', [bridgeCalls.filter(c => c[0] === 'inject').length, fd2.requests.get('s1').status], [1, 'DONE'])

  verifyNext = false
  fd2.add({ id: 's2', taskId: 'fd-task-9', kind: 'SESSION_OP', prompt: JSON.stringify({ op: 'inject', sessionId: 'sess-cloud-1', templateId: 'rebase', prompt: 'rebase please' }) })
  await opsDispatcher.pollFolder(agentB)
  check('unverified inject → FAILED, never retried', [fd2.requests.get('s2').status, fd2.requests.get('s2').extras.diagnostics.text.startsWith('inject unverified')], ['FAILED', true])
  verifyNext = true

  fd2.add({ id: 's3', taskId: 'fd-task-9', kind: 'SESSION_OP', prompt: JSON.stringify({ op: 'inject', sessionId: 'sess-cloud-1', prompt: 'no template' }) })
  await opsDispatcher.pollFolder(agentB)
  check('inject without templateId is refused without touching the bridge', [fd2.requests.get('s3').status, fd2.requests.get('s3').extras.diagnostics.text, bridgeCalls.filter(c => c[0] === 'inject').length], ['FAILED', 'inject requires templateId', 2])

  fd2.add({ id: 's4', taskId: 'fd-task-9', kind: 'SESSION_OP', prompt: null, sessionOp: { op: 'state', sessionId: 'sess-cloud-1' } })
  await opsDispatcher.pollFolder(agentB)
  check('state op returns the session read including the last-turn question flag', [fd2.requests.get('s4').status, fd2.requests.get('s4').extras.state, fd2.requests.get('s4').extras.lastTurnEndsWithQuestion], ['DONE', 'ready', true])
  check('null fields are dropped from reports (FlightDesk rejects null for optional strings)', 'prUrl' in fd2.requests.get('s4').extras, false)

  // Deferral: a running job on the folder holds the op unacked.
  const busyTask = await dbCall('createTask', { title: 'busy', agent_path: agentB.path, context: 'internal' })
  const busyJob = await dbCall('createAgentJob', busyTask.id, 'work')
  await dbCall('startAgentJob', busyJob.id)
  fd2.add({ id: 's5', taskId: 'fd-task-9', kind: 'SESSION_OP', prompt: JSON.stringify({ op: 'archive', sessionId: 'sess-cloud-1' }) })
  await opsDispatcher.pollFolder(agentB)
  check('SESSION_OP deferred while a job holds the folder', [fd2.requests.get('s5').status, bridgeCalls.some(c => c[0] === 'archive')], ['REQUESTED', false])
  await dbCall('finishAgentJob', busyJob.id, 'done', 'ok', null)
  await opsDispatcher.pollFolder(agentB)
  check('…and executed once the folder is free', [fd2.requests.get('s5').status, bridgeCalls.some(c => c[0] === 'archive')], ['DONE', true])

  bridgeDown = true
  fd2.add({ id: 's6', taskId: 'fd-task-9', kind: 'SESSION_OP', prompt: JSON.stringify({ op: 'inject', sessionId: 'sess-cloud-1', templateId: 'ci_failed', prompt: 'x' }) })
  await opsDispatcher.pollFolder(agentB)
  check('bridge unreachable → FAILED/dependency_down', [fd2.requests.get('s6').status, fd2.requests.get('s6').extras.diagnostics.kind], ['FAILED', 'dependency_down'])
  bridgeDown = false
  check('no dispatcher errors from the SESSION_OP run', opsLogs, [])
  check('sessionOpSpec accepts a nested sessionOp object', sessionOpSpec({ sessionOp: { op: 'state', sessionId: 'a' } }).op, 'state')
  check('turnEndsWithQuestion heuristic', [
    turnEndsWithQuestion('Done.\n\nShould I also update the docs?'),
    turnEndsWithQuestion('All green, merged.'),
    turnEndsWithQuestion('I added the Prisma model.\n\nI need the migration run and pushed before I can continue.'),
    turnEndsWithQuestion('Blocked on the DATABASE_URL secret — let me know when it is set.'),
    turnEndsWithQuestion('Please note this was refactored earlier.\n\nOpened PR #12 with all tests green.'),
  ], [true, false, true, true, false])

  // ── 11. Outbox replay: GraphQL files sent in order; rejects moved to failed/; transport keeps ──
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-outbox-'))
  const outDir = path.join(folder, OUTBOX_DIR); fs.mkdirSync(outDir)
  fs.writeFileSync(path.join(outDir, '01.json'), JSON.stringify({ query: 'mutation { a }', variables: { n: 1 }, attemptedAt: 't' }))
  fs.writeFileSync(path.join(outDir, '02.json'), JSON.stringify({ query: 'mutation { rejected }', variables: {}, attemptedAt: 't' }))
  fs.writeFileSync(path.join(outDir, '03.json'), JSON.stringify({ query: 'mutation { b }', variables: {}, attemptedAt: 't' }))
  fs.writeFileSync(path.join(outDir, '04.json'), '{not json')
  const sentQueries = []
  let transportDown = false
  const outboxClient = { async graphql(query, variables) {
    if (transportDown) throw new Error('network down')
    if (/rejected/.test(query)) { const e = new Error('Bad input'); e.graphql = true; throw e }
    sentQueries.push([query, variables]); return {}
  } }
  const r1 = await flushOutbox(folder, outboxClient, { log: { error() {} } })
  check('outbox: sends good entries in order, moves rejects and garbage to failed/', [r1, sentQueries.map(q => q[0]), fs.readdirSync(outDir).sort(), fs.readdirSync(path.join(outDir, 'failed')).filter(n => n.endsWith('.json')).sort()],
    [{ sent: 2, failed: 2, pending: 0 }, ['mutation { a }', 'mutation { b }'], ['failed'], ['02.json', '04.json']])
  fs.writeFileSync(path.join(outDir, '05.json'), JSON.stringify({ query: 'mutation { c }', variables: {} }))
  transportDown = true
  const r2 = await flushOutbox(folder, outboxClient, { log: { error() {} } })
  check('outbox: transport failure keeps the file for next time', [r2.pending, fs.existsSync(path.join(outDir, '05.json'))], [1, true])
  fs.rmSync(folder, { recursive: true, force: true })

  // ── 12. Pure helpers ──
  check('empty prompt gets a task-naming fallback', buildPrompt({ taskId: 'X', kind: 'PLAN', prompt: '', task: { title: 'T', description: 'D' } }, null, ''), 'You are working FlightDesk task X (dispatch kind: PLAN).\nTask: T\n\nD')
  check('formatAnswersBlock is empty with no questions', formatAnswersBlock({ questions: [] }), '')
  check('transition rejection detection', [isTransitionRejection(Object.assign(new Error('Invalid dispatch transition'), { graphql: true })), isTransitionRejection(new Error('Invalid dispatch transition'))], [true, false])
  check('diagnostics kinds', ['done', 'timed_out', 'orphaned', 'failed'].map(s => diagnosticsKindFor({ status: s })).concat(diagnosticsKindFor({ status: 'failed', failureKind: 'launch_failed' })), [null, 'timed_out', 'orphaned', 'error', 'launch_failed'])
  check('externalEnv refuses reserved and malformed names', externalEnv({ external_meta: JSON.stringify({ env: { QALATRA_TASK_ID: 'x', 'bad-name': 'y', OK_ONE: 'z', NUM: 3, OBJ: {}, FLIGHTDESK_API_KEY: 'wrong', FLIGHTDESK_API_URL: 'https://evil.test' } }) }), { OK_ONE: 'z', NUM: '3' })

  // ── 13. Folder identity reaches the job env ──
  // The CLI inside a job walks up from its cwd for a .flightdeskrc; an agent that cds to its repo
  // root walks past the folder's rc and runs as ~/.flightdeskrc's user. The rc's credential goes
  // in as the CLI's own override variables, on every job in the folder, regardless of external_meta.
  delete process.env.FLIGHTDESK_API_KEY
  delete process.env.FLIGHTDESK_API_URL
  const bound = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-rc-'))
  const unbound = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-norc-'))
  const rcFile = path.join(bound, '.flightdeskrc')
  fs.writeFileSync(rcFile, JSON.stringify({ apiKey: 'k1', apiUrl: 'https://x.test' }))
  check('rc env: key and url from the folder rc', flightdeskRcEnv(bound), { FLIGHTDESK_API_KEY: 'k1', FLIGHTDESK_API_URL: 'https://x.test' })
  fs.writeFileSync(rcFile, JSON.stringify({ apiKey: 'k1' }))
  fs.utimesSync(rcFile, new Date(Date.now() + 2000), new Date(Date.now() + 2000)) // defeat the mtime cache within one tick
  check('rc env: url defaults when the rc omits it', flightdeskRcEnv(bound), { FLIGHTDESK_API_KEY: 'k1', FLIGHTDESK_API_URL: 'https://api.flightdesk.dev' })
  const unboundEnv = buildAgentEnv({ agentEnv: { FLIGHTDESK_OTHER: 'kept' } }, null, '/bin/sh', unbound)
  check('no rc: nothing added, unrelated FLIGHTDESK_* untouched', [unboundEnv.FLIGHTDESK_API_KEY, unboundEnv.FLIGHTDESK_API_URL, unboundEnv.FLIGHTDESK_OTHER], [undefined, undefined, 'kept'])
  check('no agent_path: nothing added', flightdeskRcEnv(null), {})
  const shadowed = buildAgentEnv({ agentEnv: { FLIGHTDESK_API_KEY: 'settings-wrong' } }, { env: { FLIGHTDESK_API_KEY: 'config-wrong', FLIGHTDESK_API_URL: 'https://config-wrong.test' } }, '/bin/sh', bound)
  check('rc wins over agent.config.env and settings.agentEnv', [shadowed.FLIGHTDESK_API_KEY, shadowed.FLIGHTDESK_API_URL], ['k1', 'https://api.flightdesk.dev'])
  const heartbeatJob = { agent_path: bound, external_meta: null }
  check('heartbeat job (no external_meta) still gets the folder identity', { ...buildAgentEnv({}, null, '/bin/sh', heartbeatJob.agent_path), ...externalEnv(heartbeatJob) }.FLIGHTDESK_API_KEY, 'k1')
  const spoofed = { agent_path: bound, external_meta: JSON.stringify({ env: { FLIGHTDESK_API_KEY: 'wrong' } }) }
  check('external_meta.env cannot re-identify a bound folder', { ...buildAgentEnv({}, null, '/bin/sh', spoofed.agent_path), ...externalEnv(spoofed) }.FLIGHTDESK_API_KEY, 'k1')
  fs.rmSync(rcFile)
  check('rc deleted between launches → next launch has no identity', flightdeskRcEnv(bound), {})
  fs.rmSync(bound, { recursive: true, force: true })
  fs.rmSync(unbound, { recursive: true, force: true })
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
