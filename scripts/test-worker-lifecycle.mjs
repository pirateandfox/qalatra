import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentWorkerStatus, processAgentJobs, killRunningAgentProcesses, onJobFinished } from '../server/workers.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-worker-life-'))
const originalShell = process.env.SHELL
process.env.SHELL = '/bin/bash'
const fixture = path.join(dir, 'agent.cjs')
fs.writeFileSync(fixture, `
console.log(JSON.stringify({ type: 'assistant', session_id: 'retained-session', message: { content: [{ type: 'text', text: 'partial work retained' }] } }))
if (process.env.QALATRA_TITLE !== 'done') setInterval(() => {}, 1000)
`)
const jobs = []
const completed = new Map()
const hooks = []
const off = onJobFinished(payload => hooks.push(payload))
const settings = { maxConcurrentJobs: 1 }
const ctx = {
  loadSettings: () => settings,
  notify: () => {},
  dbCall: async (method, ...args) => {
    if (method === 'getQueuedJobs') return jobs.filter(j => j.state === 'queued').slice(0, args[0])
    const job = jobs.find(j => j.id === args[0])
    if (method === 'startAgentJob') { job.state = 'running'; return { claimed: true } }
    if (method === 'getTask') return { title: jobs.find(j => j.task_id === args[0]).title }
    if (method === 'finishAgentJob') {
      job.state = args[1]
      completed.set(job.id, { status: args[1], result: args[2], session: args[3], terminatedBy: args[4] })
    }
    return { ok: true }
  },
}
const add = (title, config = {}, folder = title) => {
  const agentPath = path.join(dir, folder)
  fs.mkdirSync(agentPath, { recursive: true })
  fs.writeFileSync(path.join(agentPath, 'agent.config'), JSON.stringify({ command: [process.execPath, fixture], ...config }))
  const job = { id: `lifecycle-${jobs.length}-${process.pid}`, task_id: `task-${jobs.length}`, title, agent_path: agentPath, prompt: 'test', state: 'queued' }
  jobs.push(job)
  return job
}
async function waitFor(predicate) {
  const until = Date.now() + 8000
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('worker lifecycle did not settle')
    await new Promise(r => setTimeout(r, 25))
  }
}
try {
  const done = add('done')
  await processAgentJobs(ctx)
  await waitFor(() => completed.has(done.id))
  assert.equal(completed.get(done.id).status, 'done')
  assert.equal(agentWorkerStatus(settings).admittedJobs, 0)

  const timed = add('timed', { timeout_minutes: 0.025 })
  await processAgentJobs(ctx)
  await waitFor(() => completed.has(timed.id))
  assert.equal(completed.get(timed.id).status, 'timed_out')
  assert.equal(completed.get(timed.id).terminatedBy, 'timeout')
  assert.equal(completed.get(timed.id).session, 'retained-session')
  assert.match(completed.get(timed.id).result, /partial work retained/)
  assert.equal(agentWorkerStatus(settings).admittedJobs, 0)

  const cancelled = add('cancelled')
  await processAgentJobs(ctx)
  assert.equal(agentWorkerStatus(settings).admittedJobs, 1)
  killRunningAgentProcesses()
  await waitFor(() => completed.has(cancelled.id))
  assert.equal(completed.get(cancelled.id).status, 'failed')
  assert.equal(agentWorkerStatus(settings).admittedJobs, 0, 'shutdown/cancellation releases the live slot')

  const bad = add('bad', { command: [] })
  await processAgentJobs(ctx)
  assert.equal(completed.get(bad.id).status, 'failed')
  assert.equal(hooks.find(h => h.job.id === bad.id).diagnostics.kind, 'launch_failed')
  assert.equal(agentWorkerStatus(settings).admittedJobs, 0)

  // No runtime + a binary that is neither claude nor codex: stays claude (wrappers forward to it),
  // so Claude's prompt flags are appended, with a warning. An explicit raw runtime appends nothing.
  const argvFixture = path.join(dir, 'argv.cjs')
  fs.writeFileSync(argvFixture, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const origWarn = console.warn
  const origError = console.error
  const warned = []
  const errored = []
  console.warn = (...a) => warned.push(a.join(' '))
  console.error = (...a) => errored.push(a.join(' '))
  try {
    const inferred = add('inferred-claude', { command: [process.execPath, argvFixture, '--own-flag'] })
    await processAgentJobs(ctx)
    await waitFor(() => completed.has(inferred.id))
    assert.equal(completed.get(inferred.id).status, 'done')
    // stdout isn't stream-json, so the claude consumer falls back to the raw tail.
    assert.deepEqual(JSON.parse(completed.get(inferred.id).result), ['--own-flag', '-p', 'test', '--output-format', 'stream-json', '--verbose'])
    assert.ok(warned.some(w => w.includes('not a recognised runtime') && w.includes(argvFixture)), 'an unrecognised binary warns naming the command')

    const explicitRaw = add('explicit-raw', { command: [process.execPath, argvFixture, '--own-flag'], runtime: 'raw' })
    await processAgentJobs(ctx)
    await waitFor(() => completed.has(explicitRaw.id))
    assert.equal(completed.get(explicitRaw.id).result, '["--own-flag"]', 'explicit raw must not append prompt flags')

    // Invalid agent.config: logged with its path, and the job still runs on the default command.
    const broken = add('broken-config')
    fs.writeFileSync(path.join(broken.agent_path, 'agent.config'), '{ not json')
    settings.defaultAgentCommand = `${process.execPath} ${argvFixture}`
    await processAgentJobs(ctx)
    await waitFor(() => completed.has(broken.id))
    assert.equal(completed.get(broken.id).status, 'done', 'an unreadable agent.config falls back to defaults')
    assert.equal(JSON.parse(completed.get(broken.id).result)[0], '-p', 'the default command ran in prompt mode')
    assert.ok(errored.some(e => e.includes(path.join(broken.agent_path, 'agent.config')) && e.includes('continuing with defaults')))
  } finally {
    console.warn = origWarn
    console.error = origError
    delete settings.defaultAgentCommand
  }
  assert.equal(agentWorkerStatus(settings).admittedJobs, 0)

  const missing = add('missing')
  fs.rmSync(missing.agent_path, { recursive: true })
  await processAgentJobs(ctx)
  assert.match(completed.get(missing.id).result, /does not exist/)
  assert.equal(agentWorkerStatus(settings).admittedJobs, 0)

  const error = add('spawn-error')
  process.env.SHELL = path.join(dir, 'nonexistent-shell')
  await processAgentJobs(ctx)
  await waitFor(() => completed.has(error.id))
  // Node emits both error and close on a failed spawn; settle and release exactly once.
  await new Promise(r => setTimeout(r, 30))
  assert.equal(agentWorkerStatus(settings).admittedJobs, 0)
  assert.equal(hooks.filter(h => h.job.id === error.id).length, 1)
  console.log('Worker lifecycle tests passed')
} finally {
  off()
  killRunningAgentProcesses()
  if (originalShell === undefined) delete process.env.SHELL
  else process.env.SHELL = originalShell
  fs.rmSync(dir, { recursive: true, force: true })
}
