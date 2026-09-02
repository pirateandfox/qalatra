import { spawnSync } from 'child_process'
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads'

const TIMEOUT_NONE = 0
const TIMEOUT_WALL_CLOCK = 1
const TIMEOUT_IDLE = 2

function timeoutKind(code) {
  if (code === TIMEOUT_WALL_CLOCK) return 'wall-clock'
  if (code === TIMEOUT_IDLE) return 'idle'
  return null
}

function killProcessTree(pid) {
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    if (killed.error) throw killed.error
    return
  }

  try {
    process.kill(-pid, 'SIGKILL') // negative pid = the whole group from detached:true
    return
  } catch (err) {
    if (err.code !== 'ESRCH') throw err
  }

  // The process may have failed to become a group leader. Preserve the old single-pid fallback.
  try { process.kill(pid, 'SIGKILL') } catch (err) {
    if (err.code !== 'ESRCH') throw err
  }
}

function startWatchdog() {
  const { pid, wallClockDeadline, initialActivityAt, idleTimeoutMs, stateBuffer } = workerData
  const state = new Int32Array(stateBuffer)
  let wallClockTimer = null
  let idleTimer = null
  let settled = false

  const reportError = err => {
    try { parentPort?.postMessage({ type: 'error', message: err.message }) } catch {}
  }

  const fire = code => {
    if (settled) return
    settled = true
    clearTimeout(wallClockTimer)
    clearTimeout(idleTimer)

    // Store the reason before signalling. The server's close callback may run as soon as the
    // process dies; the shared atomic makes classification independent of IPC message ordering.
    Atomics.store(state, 0, code)
    try { killProcessTree(pid) } catch (err) { reportError(err) }
  }

  const armAt = (deadline, callback) => {
    const remaining = deadline - Date.now()
    return setTimeout(callback, Math.max(0, remaining))
  }

  wallClockTimer = armAt(wallClockDeadline, () => fire(TIMEOUT_WALL_CLOCK))

  const bumpIdle = activityAt => {
    if (!idleTimeoutMs || settled) return
    clearTimeout(idleTimer)
    idleTimer = armAt(activityAt + idleTimeoutMs, () => fire(TIMEOUT_IDLE))
  }
  bumpIdle(initialActivityAt)

  parentPort?.on('message', message => {
    if (message?.type === 'activity') bumpIdle(Number(message.at) || Date.now())
    if (message?.type === 'cancel') {
      settled = true
      clearTimeout(wallClockTimer)
      clearTimeout(idleTimer)
      parentPort.close()
    }
  })
}

if (!isMainThread) startWatchdog()

/**
 * Arm a timeout in a separate Node worker event loop.
 *
 * A timer on Qalatra Server's main event loop cannot enforce the deadline when that same loop is
 * blocked. The worker owns both the clocks and the process-tree kill. A SharedArrayBuffer carries
 * the fired reason back synchronously, so a delayed main loop still persists `timed_out` rather
 * than mistaking the watchdog's SIGKILL for an agent failure.
 */
export function createAgentWatchdog({ pid, wallClockMs, idleTimeoutMs = 0, label = String(pid), logger = console }) {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const initialActivityAt = Date.now()
  const wallClockDeadline = initialActivityAt + wallClockMs
  let worker

  try {
    worker = new Worker(new URL(import.meta.url), {
      name: `qalatra-agent-watchdog-${label}`,
      workerData: { pid, wallClockDeadline, initialActivityAt, idleTimeoutMs, stateBuffer: state.buffer },
    })
  } catch (err) {
    throw new Error(`Could not arm independent timeout watchdog for agent ${label}: ${err.message}`)
  }

  let cancelled = false
  worker.on('message', message => {
    if (message?.type === 'error') logger.error(`[workers] timeout watchdog for job ${label}: ${message.message}`)
  })
  worker.on('error', err => {
    if (!cancelled) logger.error(`[workers] timeout watchdog crashed for job ${label}: ${err.message}`)
  })
  worker.on('exit', code => {
    if (!cancelled && code !== 0 && Atomics.load(state, 0) === TIMEOUT_NONE) {
      logger.error(`[workers] timeout watchdog exited unexpectedly for job ${label} (code ${code})`)
    }
  })
  // The watchdog protects a live agent but must not keep Qalatra Server alive during shutdown.
  worker.unref()

  return {
    activity() {
      if (!cancelled) worker.postMessage({ type: 'activity', at: Date.now() })
    },
    get timeoutKind() {
      return timeoutKind(Atomics.load(state, 0))
    },
    cancel() {
      if (cancelled) return
      cancelled = true
      try { worker.postMessage({ type: 'cancel' }) } catch {}
      worker.terminate().catch(() => {})
    },
  }
}
