// Durable per-run state, so an agent run outlives the Qalatra Server process that launched it.
//
// An agent's stdout/stderr used to be pipes into the server. When the server stopped, the pipes
// went with it: the run lost its output (and its session id), and the next boot could only mark it
// orphaned. Now every run writes to files in its own directory, and a tiny POSIX wrapper records the
// agent's exit status there too. A restarted server reads the same files, so it can re-attach to a
// run that is still alive, finish one that ended while nobody was watching, or — only when the work
// really is gone — orphan it with whatever session id and partial output the files still hold.
//
//   <dataDir>/agent-runs/<job-id>/
//     run.json     supervision metadata written at launch (pid identity, scope, timeouts, runtime)
//     stdout.log   the agent's stdout, consumed incrementally by the runtime adapter
//     stderr.log   the agent's stderr
//     exit         the agent's exit status, written atomically by the wrapper when it ends
//
// The directory is removed once the job's terminal state is persisted.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

const RUNS_DIR = 'agent-runs'
const READ_CHUNK = 256 * 1024
/** Per poll, so a large backlog (re-reading an hour of stream-json after a restart) never blocks the loop for long. */
const MAX_READ_PER_POLL = 8 * 1024 * 1024

export function agentRunsRoot(dataDir) {
  return path.join(dataDir || path.join(os.tmpdir(), 'qalatra'), RUNS_DIR)
}

function safeJobId(jobId) {
  return String(jobId).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 180)
}

export function agentRunDir(dataDir, jobId) {
  return path.join(agentRunsRoot(dataDir), safeJobId(jobId))
}

export function runFiles(runDir) {
  return {
    meta: path.join(runDir, 'run.json'),
    stdout: path.join(runDir, 'stdout.log'),
    stderr: path.join(runDir, 'stderr.log'),
    exit: path.join(runDir, 'exit'),
  }
}

/** Fresh directory + open fds for the child's stdout/stderr. The caller closes the fds after spawn. */
export function prepareRunDir(dataDir, jobId) {
  const runDir = agentRunDir(dataDir, jobId)
  // A leftover from an earlier attempt of the same job id must not be re-read as this run's output.
  fs.rmSync(runDir, { recursive: true, force: true })
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const files = runFiles(runDir)
  return {
    runDir,
    files,
    stdoutFd: fs.openSync(files.stdout, 'a', 0o600),
    stderrFd: fs.openSync(files.stderr, 'a', 0o600),
  }
}

export function writeRunMeta(runDir, meta) {
  const file = runFiles(runDir).meta
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(meta), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
}

export function readRunMeta(runDir) {
  try { return JSON.parse(fs.readFileSync(runFiles(runDir).meta, 'utf8')) } catch { return null }
}

/** The agent's exit status, or null while it is running (or if it was killed before writing one). */
export function readExitStatus(runDir) {
  try {
    const text = fs.readFileSync(runFiles(runDir).exit, 'utf8').trim()
    return /^\d+$/.test(text) ? Number(text) : null
  } catch { return null }
}

export function removeRunDir(runDir) {
  try { fs.rmSync(runDir, { recursive: true, force: true }) } catch {}
}

/** Remove run directories that no live job owns (a crash between persisting and cleanup). */
export function sweepRunDirs(dataDir, keepJobIds) {
  const root = agentRunsRoot(dataDir)
  const keep = new Set([...keepJobIds].map(safeJobId))
  let names = []
  try { names = fs.readdirSync(root) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (keep.has(name)) continue
    removeRunDir(path.join(root, name))
    removed++
  }
  return removed
}

/**
 * Records the agent's exit status next to its output. `"$@"` runs the real command untouched (the
 * login-shell argv structure inside it must survive intact); the status is written to a temp file
 * and renamed so a reader never sees a partial number, and the wrapper exits with the same status
 * so a live parent still observes the agent's own exit code. Not exec'd on purpose: the wrapper has
 * to outlive the agent to write the file. It is the tracked pid and the process-group leader.
 */
const EXIT_WRAPPER = '"$@"; s=$?; printf \'%s\\n\' "$s" > "$QALATRA_EXIT_FILE.tmp" && mv -f "$QALATRA_EXIT_FILE.tmp" "$QALATRA_EXIT_FILE"; exit "$s"'

export function withExitRecorder(command, args) {
  return { command: '/bin/sh', args: ['-c', EXIT_WRAPPER, 'qalatra-agent', command, ...args] }
}

/**
 * A process's start time, used with its pid as its identity. A bare pid is not enough to re-adopt
 * a run after a restart: after a reboot (or enough churn) the same pid can belong to something
 * unrelated, and adopting it would arm a watchdog that SIGKILLs a stranger's process group.
 */
export function processStartTime(pid) {
  if (!pid || process.platform === 'win32') return null
  const shown = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })
  const text = shown.status === 0 ? String(shown.stdout ?? '').trim() : ''
  return text || null
}

/** Is the run's tracked process (the exit-recording wrapper) still the one we launched? */
export function runProcessAlive(meta) {
  if (!meta?.pid || !meta.pidStart) return false
  try { process.kill(meta.pid, 0) } catch (err) { if (err.code !== 'EPERM') return false }
  return processStartTime(meta.pid) === meta.pidStart
}

/** Incremental reader for a file another process appends to. */
export function createFileTail(file, onData) {
  let fd = null
  let offset = 0
  return {
    /** Read everything appended since the last call (bounded per call unless `all`). Returns bytes read. */
    read({ all = false } = {}) {
      if (fd === null) {
        try { fd = fs.openSync(file, 'r') } catch { return 0 }
      }
      let total = 0
      const buf = Buffer.allocUnsafe(READ_CHUNK)
      while (all || total < MAX_READ_PER_POLL) {
        let n = 0
        try { n = fs.readSync(fd, buf, 0, READ_CHUNK, offset) } catch { break }
        if (n <= 0) break
        offset += n
        total += n
        onData(Buffer.from(buf.subarray(0, n)))
      }
      return total
    },
    close() {
      if (fd !== null) { try { fs.closeSync(fd) } catch {} }
      fd = null
    },
  }
}

/** Newest modification time across the run's output, for the idle clock of a re-adopted run. */
export function lastOutputAt(runDir) {
  const files = runFiles(runDir)
  let latest = 0
  for (const file of [files.stdout, files.stderr]) {
    try { latest = Math.max(latest, fs.statSync(file).mtimeMs) } catch {}
  }
  return latest || null
}
