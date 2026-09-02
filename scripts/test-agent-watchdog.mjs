import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
