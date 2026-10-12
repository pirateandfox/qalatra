// A Qalatra Server restart must not turn live agent work into failed turns.
//
// Phase "launch" runs in a child process that plays the old server: it admits jobs, waits for them
// to be up, then shuts down the way server/index.js does (leaveAgentRunsForRestart) and exits. The
// parent plays the next instance: recoverRunningJobs must re-adopt the live run, finish the one that
// ended while nobody watched, time out the one past its deadline, and orphan — resumably — only the
// one whose process is really gone.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { processAgentJobs, leaveAgentRunsForRestart, recoverRunningJobs, onJobFinished, agentWorkerStatus } from '../server/workers.js'
import { agentRunDir, readRunMeta, writeRunMeta } from '../server/agent-runs.js'

if (process.platform === 'win32') {
  console.log('agent restart tests skipped (runs are not adoptable on Windows)')
  process.exit(0)
}

const self = fileURLToPath(import.meta.url)
const settings = { maxConcurrentJobs: 10 }

// The fixture agent: announces a session at once (as stream-json does), sleeps for the duration in
// its title, then reports a result. "killme" never finishes on its own.
function writeFixture(dir) {
  const fixture = path.join(dir, 'agent.cjs')
  fs.writeFileSync(fixture, `
const [name, ms] = process.env.QALATRA_TITLE.split(':')
const say = event => process.stdout.write(JSON.stringify({ session_id: 'session-' + name, ...event }) + '\\n')
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'started ' + name }] } })
setTimeout(() => {
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'finished ' + name }] } })
  say({ type: 'result', result: 'result of ' + name })
  process.exit(0)
}, Number(ms))
`)
  return fixture
}

function jobsFor(dir, fixture) {
  const make = (title, config = {}) => {
    const [name] = title.split(':')
    const agentPath = path.join(dir, name)
    fs.mkdirSync(agentPath, { recursive: true })
    fs.writeFileSync(path.join(agentPath, 'agent.config'), JSON.stringify({ command: [process.execPath, fixture], runtime: 'claude', ...config }))
    return { id: `restart-${name}`, task_id: `task-${name}`, title, agent_path: agentPath, prompt: 'test', state: 'queued', external_ref: null, external_meta: null }
  }
  return [
    make('survivor:9000'),          // still running across the restart → re-adopted, ends done
    make('quick:600'),              // ends while no server is up → finished at boot
    make('killme:600000'),          // killed while no server is up → orphaned, resumable
    make('overdue:600000', { timeout_minutes: 0.05 }), // past its deadline at boot → timed_out
    make('impostor:600000'),        // pid identity no longer matches → never adopted
  ]
}

function fakeDb(file) {
  const load = () => JSON.parse(fs.readFileSync(file, 'utf8'))
  const save = jobs => fs.writeFileSync(file, JSON.stringify(jobs))
  return async (method, ...args) => {
    const jobs = load()
    const job = jobs.find(j => j.id === args[0])
    if (method === 'getQueuedJobs') return jobs.filter(j => j.state === 'queued').slice(0, args[0])
    if (method === 'startAgentJob') { job.state = 'running'; save(jobs); return { claimed: true } }
    if (method === 'getTask') return { title: jobs.find(j => j.task_id === args[0]).title }
    if (method === 'getRunningAgentJobs') return jobs.filter(j => j.state === 'running')
    if (method === 'finishAgentJob') {
      Object.assign(job, { state: args[1], result: args[2], session: args[3], terminatedBy: args[4] })
      save(jobs)
    }
    if (method === 'resetStuckJobs') {
      const { ids, details } = args[1]
      const orphaned = []
      for (const j of jobs) {
        if (j.state !== 'running' || !ids.includes(j.id)) continue
        Object.assign(j, { state: 'orphaned', terminatedBy: 'app_restart', result: details[j.id]?.result ?? 'orphaned', session: details[j.id]?.sessionId ?? null })
        orphaned.push({ ...j, session_id: j.session })
      }
      save(jobs)
      return { ok: true, orphaned }
    }
    return { ok: true }
  }
}

async function waitFor(predicate, ms = 15_000, what = 'condition') {
  const until = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() >= until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

if (process.argv[2] === 'launch') {
  // ── The old server ──
  const [, , , dataDir, dbFile] = process.argv
  const dbCall = fakeDb(dbFile)
  const ctx = { dbCall, loadSettings: () => settings, notify: () => {}, dataDir }
  await processAgentJobs(ctx)
  const ids = JSON.parse(fs.readFileSync(dbFile, 'utf8')).map(j => j.id)
  await waitFor(() => ids.every(id => {
    const out = path.join(agentRunDir(dataDir, id), 'stdout.log')
    return readRunMeta(agentRunDir(dataDir, id)) && fs.existsSync(out) && fs.statSync(out).size > 0
  }), 15_000, 'every run to start')
  const left = leaveAgentRunsForRestart()
  process.stdout.write(JSON.stringify({ left }))
  process.exit(0)
}

// ── The next instance ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-restart-'))
const dataDir = path.join(dir, 'data')
const dbFile = path.join(dir, 'jobs.json')
const originalShell = process.env.SHELL
process.env.SHELL = '/bin/bash'
const fixture = writeFixture(dir)
fs.writeFileSync(dbFile, JSON.stringify(jobsFor(dir, fixture)))
const dbCall = fakeDb(dbFile)
const state = id => JSON.parse(fs.readFileSync(dbFile, 'utf8')).find(j => j.id === id)
const hooks = []
const off = onJobFinished(payload => hooks.push(payload))
const pids = []

try {
  const launcher = spawn(process.execPath, [self, 'launch', dataDir, dbFile], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env })
  let out = ''
  launcher.stdout.on('data', d => { out += d })
  const exitCode = await new Promise(resolve => launcher.on('exit', resolve))
  assert.equal(exitCode, 0, 'the old server exits cleanly')
  assert.equal(JSON.parse(out).left, 5, 'shutdown leaves every adoptable run running')

  for (const name of ['survivor', 'quick', 'killme', 'overdue', 'impostor']) {
    const meta = readRunMeta(agentRunDir(dataDir, `restart-${name}`))
    assert.ok(meta?.pid && meta.pidStart, `${name} recorded its pid identity`)
    pids.push(meta.pid)
    assert.equal(state(`restart-${name}`).state, 'running', `${name} is still 'running' in the db after the old server exits`)
  }
  const meta = name => readRunMeta(agentRunDir(dataDir, `restart-${name}`))

  // While no server is up: quick ends on its own, killme is killed, impostor's identity is forged.
  await waitFor(() => fs.existsSync(path.join(agentRunDir(dataDir, 'restart-quick'), 'exit')), 10_000, 'quick to record its exit')
  process.kill(-meta('killme').pid, 'SIGKILL')
  await waitFor(() => { try { process.kill(meta('killme').pid, 0); return false } catch { return true } }, 5_000, 'killme to die')
  const impostorMeta = meta('impostor')
  writeRunMeta(agentRunDir(dataDir, 'restart-impostor'), { ...impostorMeta, pidStart: 'Thu Jan  1 00:00:00 1970' })
  // overdue's 3-second allowance passes while nobody is watching.
  await new Promise(r => setTimeout(r, 3_200))

  const orphaned = await recoverRunningJobs({ dbCall, loadSettings: () => settings, dataDir, startedAt: 'boundary' })

  assert.deepEqual(orphaned.map(j => j.id).sort(), ['restart-impostor', 'restart-killme'], 'only runs whose work is gone are orphaned')
  const killme = orphaned.find(j => j.id === 'restart-killme')
  assert.equal(killme.session_id, 'session-killme', 'the orphan carries the session id salvaged from its output')
  assert.match(state('restart-killme').result, /started killme/, 'partial output is kept on the orphan')
  assert.match(state('restart-killme').result, /resumable/)

  await waitFor(() => state('restart-quick').state !== 'running', 5_000, 'quick to be finished')
  assert.equal(state('restart-quick').state, 'done', 'a run that ended unwatched is finished from its recorded exit')
  assert.equal(state('restart-quick').result, 'result of quick')
  assert.equal(state('restart-quick').session, 'session-quick')

  await waitFor(() => state('restart-overdue').state !== 'running', 10_000, 'overdue to be timed out')
  assert.equal(state('restart-overdue').state, 'timed_out', 'the original deadline still applies after re-adoption')
  assert.equal(state('restart-overdue').session, 'session-overdue')

  assert.equal(state('restart-survivor').state, 'running', 'the live run is re-adopted, not orphaned')
  assert.equal(agentWorkerStatus(settings).admittedJobs, 1, 'the re-adopted run holds an admission slot')
  await waitFor(() => state('restart-survivor').state !== 'running', 20_000, 'survivor to finish')
  assert.equal(state('restart-survivor').state, 'done', 'the re-adopted run finishes done')
  assert.equal(state('restart-survivor').result, 'result of survivor', 'output written after the restart is read')
  assert.equal(state('restart-survivor').session, 'session-survivor')
  assert.equal(hooks.find(h => h.job.id === 'restart-survivor').status, 'done', 'orchestrators hear done, never failed')
  assert.equal(agentWorkerStatus(settings).admittedJobs, 0, 'the slot is released when the re-adopted run ends')
  await waitFor(() => !fs.existsSync(agentRunDir(dataDir, 'restart-survivor')), 5_000, 'survivor run dir cleanup')
  assert.ok(!fs.existsSync(agentRunDir(dataDir, 'restart-killme')), 'orphans\' run dirs are swept once persisted')

  console.log('agent restart tests passed')
} finally {
  off()
  // impostor was never adopted, so nothing else will kill it.
  for (const pid of pids) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  if (originalShell === undefined) delete process.env.SHELL
  else process.env.SHELL = originalShell
  fs.rmSync(dir, { recursive: true, force: true })
}
process.exit(0)
