import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createAgentWatchdog } from '../server/agent-watchdog.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function spawnSleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  })
  await once(child, 'spawn')
  return child
}

async function expectKilled(child, closePromise) {
  const outcome = await Promise.race([
    closePromise.then(([code, signal]) => ({ code, signal })),
    delay(2_000).then(() => null),
  ])
  assert.ok(outcome, `watchdog did not kill pid ${child.pid}`)
  assert.notEqual(outcome.code, 0)
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(50)
  }
  return false
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code !== 'ESRCH'
  }
}

function systemdUserScopesAvailable() {
  if (process.platform !== 'linux') return false
  return spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { stdio: 'ignore' }).status === 0
}

// The main regression: a normal setTimeout cannot run while this loop is occupied. The watchdog's
// separate event loop must still fire, record the cause atomically, and kill the agent process.
{
  const child = await spawnSleeper()
  const closePromise = once(child, 'close')
  const watchdog = createAgentWatchdog({ pid: child.pid, wallClockMs: 150, label: 'wall-clock-test' })
  let mainLoopTimerFired = false
  setTimeout(() => { mainLoopTimerFired = true }, 50)

  const blockedUntil = Date.now() + 600
  while (Date.now() < blockedUntil) {} // intentionally reproduce a blocked Qalatra event loop

  assert.equal(mainLoopTimerFired, false, 'test did not keep the main event loop blocked')
  assert.equal(watchdog.timeoutKind, 'wall-clock')
  await expectKilled(child, closePromise)
  watchdog.cancel()
}

// A tool can create a new process group with setsid. Killing the tracked agent's negative pid does
// not reach it, but killing the named systemd scope must remove both processes and collect the unit.
if (systemdUserScopesAvailable()) {
  const scopeUnit = `qalatra-watchdog-test-${process.pid}-${Date.now()}.scope`
  let child = null
  let escapedPid = null
  try {
    child = spawn(
      'systemd-run',
      [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        `--unit=${scopeUnit}`,
        '/bin/bash',
        '-c',
        'setsid sleep 600 & echo $!; wait',
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    await once(child, 'spawn')
    const pidChunk = await Promise.race([
      once(child.stdout, 'data').then(([chunk]) => chunk),
      once(child, 'close').then(([code]) => { throw new Error(`test scope exited before reporting its escaped pid (code ${code})`) }),
      delay(3_000).then(() => { throw new Error('test scope did not report its escaped pid') }),
    ])
    escapedPid = Number(String(pidChunk).trim())
    assert.ok(Number.isInteger(escapedPid) && escapedPid > 1, 'test agent did not report its escaped child pid')
    assert.ok(processExists(escapedPid), 'escaped child exited before the watchdog fired')

    const closePromise = once(child, 'close')
    const watchdog = createAgentWatchdog({
      pid: child.pid,
      scopeUnit,
      wallClockMs: 150,
      label: 'scope-boundary-test',
    })
    await expectKilled(child, closePromise)
    assert.equal(watchdog.timeoutKind, 'wall-clock')
    assert.ok(await waitFor(() => !processExists(escapedPid)), `escaped pid ${escapedPid} survived the scope kill`)
    const collected = await waitFor(() => {
      const shown = spawnSync('systemctl', ['--user', 'show', scopeUnit, '-p', 'LoadState', '--value'], { encoding: 'utf8' })
      return shown.status !== 0 || String(shown.stdout).trim() === 'not-found'
    })
    assert.ok(collected, `${scopeUnit} was not collected after its timeout`)
    watchdog.cancel()
  } finally {
    spawnSync('systemctl', ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', scopeUnit], { stdio: 'ignore' })
    if (escapedPid && processExists(escapedPid)) {
      try { process.kill(escapedPid, 'SIGKILL') } catch {}
    }
    if (child?.pid && processExists(child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
  }
} else {
  console.log('systemd scope watchdog regression skipped (no systemd user manager)')
}

// Idle enforcement lives in the same independent watchdog and records its distinct cause.
{
  const child = await spawnSleeper()
  const closePromise = once(child, 'close')
  const watchdog = createAgentWatchdog({
    pid: child.pid,
    wallClockMs: 2_000,
    idleTimeoutMs: 150,
    label: 'idle-test',
  })

  const blockedUntil = Date.now() + 500
  while (Date.now() < blockedUntil) {}

  assert.equal(watchdog.timeoutKind, 'idle')
  await expectKilled(child, closePromise)
  watchdog.cancel()
}

// Activity resets only the idle deadline; cancelling removes both deadlines without killing.
{
  const child = await spawnSleeper()
  const watchdog = createAgentWatchdog({
    pid: child.pid,
    wallClockMs: 2_000,
    idleTimeoutMs: 180,
    label: 'activity-test',
  })
  await delay(100)
  watchdog.activity()
  await delay(120)
  assert.equal(watchdog.timeoutKind, null)
  watchdog.cancel()
  child.kill('SIGKILL')
  await once(child, 'close')
}

console.log('agent watchdog tests passed')
