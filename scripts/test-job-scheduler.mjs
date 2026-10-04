import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createJobScheduler } from '../server/job-scheduler.js'
import { initSettings, loadSettings, saveSettings, resolveMaxConcurrentJobs, validateSettings } from '../server/settings.js'
import { handleV1 } from '../server/v1.js'

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(r => setImmediate(r))
const warnings = []
const logger = { error: message => warnings.push(message) }

function fixture({ settings = {}, count = 5, prepare = async () => {} } = {}) {
  const jobs = Array.from({ length: count }, (_, id) => ({ id, state: 'queued' }))
  const running = new Map()
  const calls = []
  const scheduler = createJobScheduler({ logger,
    launchJob: async ({ job, release }) => {
      await prepare(job)
      running.set(job.id, () => { job.state = 'done'; release(); release() })
      return true
    },
    failJob: async (_ctx, job) => { job.state = 'failed' },
  })
  const ctx = {
    loadSettings: () => settings,
    dbCall: async (method, value) => {
      calls.push(method)
      if (method === 'getQueuedJobs') return jobs.filter(j => j.state === 'queued').slice(0, value)
      if (method === 'startAgentJob') {
        const job = jobs[value]
        if (job.claimError) { job.state = 'cancelled'; throw new Error('claim failed') }
        if (job.rejectClaim) { job.state = 'cancelled'; return { claimed: false } }
        job.state = 'running'
        return { claimed: true }
      }
      throw new Error(method)
    },
  }
  return { jobs, calls, scheduler, ctx, running, settings,
    pass: () => scheduler.process(ctx),
    status: () => scheduler.status(settings),
    end: id => running.get(id)(),
  }
}

const defaults = fixture()
await defaults.pass()
assert.equal(defaults.status().admittedJobs, 3)
assert.equal(defaults.jobs[3].state, 'queued')
defaults.settings.maxConcurrentJobs = 2
await defaults.pass()
assert.equal(defaults.status().admittedJobs, 3, 'lowering must not kill runs')
defaults.end(0)
await defaults.pass()
assert.equal(defaults.status().admittedJobs, 2, 'no replacement at the new ceiling')
defaults.end(1)
await defaults.pass()
assert.equal(defaults.jobs[3].state, 'running')
defaults.settings.maxConcurrentJobs = 0
assert.equal(defaults.status().paused, true)
defaults.end(2)
defaults.end(3)
await defaults.pass()
assert.equal(defaults.jobs[4].state, 'queued', 'zero drains and queues incoming work')
defaults.settings.maxConcurrentJobs = 2
await defaults.pass()
assert.equal(defaults.jobs[4].state, 'running', 'resume without a restart')

// Covers overlapping DB reads and slow launch/worktree preparation. The reserved slot is visible
// throughout setup, and another pass cannot reuse the batch while a claim or launch is pending.
for (const limit of [1, 2, 3]) {
  const gate = defer()
  const f = fixture({ settings: { maxConcurrentJobs: limit }, prepare: () => gate.promise })
  const first = f.pass()
  await tick()
  assert.equal(f.status().admittedJobs, 1)
  await Promise.all(Array.from({ length: 10 }, () => f.pass()))
  assert.equal(f.calls.filter(x => x === 'getQueuedJobs').length, 1)
  gate.resolve()
  await first
  assert.equal(f.status().admittedJobs, limit)
  assert.equal(f.running.size, limit)
  for (const id of f.running.keys()) f.end(id)
  assert.equal(f.status().admittedJobs, 0, 'duplicate terminal releases do not underflow')
}
const changing = fixture({ prepare: async () => { changing.settings.maxConcurrentJobs = 0 } })
await changing.pass()
assert.equal(changing.status().admittedJobs, 1, 'drain during preparation stops the rest of a batch')

const failing = fixture({ prepare: async job => { if (job.id === 2) throw new Error('worktree failure') } })
failing.jobs[0].claimError = true
failing.jobs[1].rejectClaim = true
await failing.pass()
assert.equal(failing.status().admittedJobs, 0)
await failing.pass()
assert.equal(failing.status().admittedJobs, 2, 'claim errors, rejected claims and launch errors release capacity')

const readFails = fixture()
const dbCall = readFails.ctx.dbCall
readFails.ctx.dbCall = async () => { throw new Error('database unavailable') }
await assert.rejects(readFails.pass(), /database unavailable/)
readFails.ctx.dbCall = dbCall
await readFails.pass()
assert.equal(readFails.status().admittedJobs, 3, 'a rejected query cannot wedge the admission lock')

for (const value of [-1, 1.5, '2', '', null, true, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
  assert.throws(() => validateSettings({ maxConcurrentJobs: value }), { status: 400 })
  assert.equal(resolveMaxConcurrentJobs({ maxConcurrentJobs: value }, logger.error), 3)
}
for (const value of [0, 1, 2, 3, 100, Number.MAX_SAFE_INTEGER]) validateSettings({ maxConcurrentJobs: value })
assert.equal(resolveMaxConcurrentJobs({}), 3)

const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-scheduler-settings-'))
const originalError = console.error
try {
  console.error = logger.error
  const file = path.join(settingsDir, 'settings.json')
  initSettings(file)
  saveSettings({ maxConcurrentJobs: 0 })
  assert.equal(loadSettings().maxConcurrentJobs, 0)
  assert.throws(() => saveSettings({ maxConcurrentJobs: Infinity }), { status: 400 })
  assert.equal(loadSettings().maxConcurrentJobs, 0, 'invalid writes leave the last good policy intact')
  for (const persisted of ['null', '[]', '{"maxConcurrentJobs":NaN}', '{"maxConcurrentJobs":1e400}', '{"maxConcurrentJobs":"unlimited"}']) {
    const before = warnings.length
    fs.writeFileSync(file, persisted)
    assert.equal(resolveMaxConcurrentJobs(loadSettings(), logger.error), 3)
    assert.ok(warnings.length > before, 'invalid persisted settings must produce a diagnostic')
  }
} finally {
  console.error = originalError
  fs.rmSync(settingsDir, { recursive: true, force: true })
}

// Exercise the authenticated API handler's settings surfaces, including import and PATCH.
let settings = { unrelated: { preserved: true } }
const ctx = { loadSettings: () => settings, saveSettings: value => { validateSettings(value); settings = value } }
const request = (method, resource, body) => handleV1({ method }, new URL(`http://local/api/v1/settings${resource}`), ctx, { parseBody: async () => body })
await request('PATCH', '', { maxConcurrentJobs: 2 })
assert.deepEqual(settings, { unrelated: { preserved: true }, maxConcurrentJobs: 2 })
assert.equal((await request('GET', '/worker')).body.worker.maxConcurrentJobs, 2)
for (const value of [-1, 0.5, '2', null, true, Infinity]) {
  await assert.rejects(request('PUT', '', { maxConcurrentJobs: value }), { status: 400 })
  await assert.rejects(request('PATCH', '', { maxConcurrentJobs: value }), { status: 400 })
  await assert.rejects(request('POST', '/import', { json: JSON.stringify({ maxConcurrentJobs: value }) }), { status: 400 })
}
for (const body of [null, [], 42]) await assert.rejects(request('PUT', '', body), { status: 400 })
await request('PUT', '', { maxConcurrentJobs: 0 })
assert.deepEqual(settings, { maxConcurrentJobs: 0 }, 'PUT retains whole-document replacement semantics')
assert.equal((await request('GET', '/worker')).body.worker.paused, true)
await request('POST', '/import', { json: '{}' })
assert.equal((await request('GET', '/worker')).body.worker.maxConcurrentJobs, 3)
console.log('Job scheduler and settings tests passed')
