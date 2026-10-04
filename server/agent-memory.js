import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const COUNTERS = ['high', 'max', 'oom', 'oom_kill', 'oom_group_kill']

export function parseMemoryEvents(text) {
  if (text == null) return null
  const events = {}
  for (const line of String(text).split('\n')) {
    const match = /^(\w+)\s+(\d+)\s*$/.exec(line)
    if (match && COUNTERS.includes(match[1])) events[match[1]] = Number(match[2])
  }
  return events
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return null }
}

function snapshot(dir) {
  if (!dir) return { high: null, max: null, events: null, local: null }
  return {
    high: read(path.join(dir, 'memory.high')),
    max: read(path.join(dir, 'memory.max')),
    events: parseMemoryEvents(read(path.join(dir, 'memory.events'))),
    local: parseMemoryEvents(read(path.join(dir, 'memory.events.local'))),
  }
}

function delta(before, after) {
  if (!before || !after) return null
  return Object.fromEntries(COUNTERS.filter(k => before[k] != null && after[k] >= before[k])
    .map(k => [k, after[k] - before[k]]))
}

/** Only exact victim cgroup matches within this run's time window are correlated evidence.
 * Local oom counters show where allocation failed, but may describe a separate concurrent event.
 * https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files
 */
export function kernelOomEvidence(output, scopeCgroup, sliceCgroup) {
  const constraints = new Set()
  let matched = 0
  for (const line of String(output ?? '').split('\n')) {
    let message
    try { message = JSON.parse(line).MESSAGE } catch { continue }
    if (typeof message !== 'string') continue
    const victim = /(?:^|[,\s])task_memcg=([^,\s]+)/.exec(message)?.[1]
    if (victim !== scopeCgroup && !victim?.startsWith(`${scopeCgroup}/`)) continue
    const constraint = /(?:^|[,\s])oom_memcg=([^,\s]+)/.exec(message)?.[1]
    if (!constraint) continue
    matched++
    constraints.add(constraint === scopeCgroup ? 'scope' : constraint === sliceCgroup ? 'slice' : 'unknown')
  }
  return { status: matched ? 'matched' : 'no_match', confirmed: matched > 0,
    constraint: constraints.size === 1 ? [...constraints][0] : 'unknown' }
}

async function readKernelEvidence({ startedAt, endedAt, scopeCgroup, sliceCgroup }) {
  try {
    const { stdout } = await execFileAsync('journalctl', [
      '--dmesg', '--no-pager', '--output=json', '--grep=oom-kill',
      `--since=@${(startedAt / 1000).toFixed(3)}`, `--until=@${(endedAt / 1000).toFixed(3)}`,
    ], { timeout: 1500, maxBuffer: 256 * 1024 })
    // Empty output also occurs when this user cannot see kernel messages. Do not claim access.
    return stdout.trim() ? kernelOomEvidence(stdout, scopeCgroup, sliceCgroup)
      : { status: 'unavailable_or_no_match', confirmed: false, constraint: 'unknown' }
  } catch {
    return { status: 'unavailable', confirmed: false, constraint: 'unknown' }
  }
}

export function classifyOom(evidence, { signal, code } = {}) {
  const confirmed = (evidence.scope?.events?.oom_kill ?? 0) > 0 || evidence.kernel?.confirmed === true
  const abrupt = signal === 'SIGKILL' || code === 137
  return {
    confirmed,
    suspected: !confirmed && abrupt && (evidence.sliceDelta?.oom_kill ?? 0) > 0,
    unconfirmed: !confirmed && abrupt,
    constraint: confirmed && evidence.kernel?.confirmed ? evidence.kernel.constraint : 'unknown',
    evidence,
  }
}

/** Start BEFORE spawn. Snapshot during the run and at close, before whole-scope cleanup.
 * No root/journal grant is needed. A collected cgroup can lose its final counters; retain only
 * what we actually observed and leave attribution unknown unless kernel evidence correlates it.
 */
export function createScopeMemoryMonitor({ scopeDir, sliceDir, memory, readKernel = readKernelEvidence }) {
  const startedAt = Date.now()
  const sliceBefore = snapshot(sliceDir)
  let scope = { high: null, max: null, events: null, local: null }
  let slice = sliceBefore
  let watcher = null
  let stopped = false
  const sample = () => {
    if (stopped) return
    const observed = snapshot(scopeDir)
    // Preserve the last readable fields independently when collection races the snapshot.
    for (const key of Object.keys(scope)) if (observed[key] != null) scope[key] = observed[key]
    const currentSlice = snapshot(sliceDir)
    for (const key of Object.keys(slice)) if (currentSlice[key] != null) slice[key] = currentSlice[key]
    if (!watcher && observed.events != null) {
      try {
        watcher = fs.watch(path.join(scopeDir, 'memory.events'), { persistent: false }, sample)
        watcher.on('error', () => { watcher?.close(); watcher = null })
      } catch {}
    }
  }
  // The slice baseline must not be mutated by subsequent samples.
  slice = { ...sliceBefore }
  sample()
  const timer = setInterval(sample, 100)
  timer.unref()
  const stop = () => { stopped = true; clearInterval(timer); watcher?.close(); watcher = null }
  return {
    sample,
    cancel: stop,
    async finish(exit) {
      sample()
      stop()
      const evidence = {
        requested: memory, scope, slice,
        // A new, uniquely named scope starts its local counters at zero.
        scopeLocalDelta: scope.local,
        sliceLocalDelta: delta(sliceBefore.local, slice.local),
        sliceDelta: delta(sliceBefore.events, slice.events),
        kernel: { status: 'not_queried', confirmed: false, constraint: 'unknown' },
      }
      if ((scope.events?.oom_kill ?? 0) > 0 || exit.signal === 'SIGKILL' || exit.code === 137 || (exit.code !== 0 && (evidence.sliceDelta?.oom_kill ?? 0) > 0)) {
        try {
          evidence.kernel = scopeDir && sliceDir ? await readKernel({ startedAt, endedAt: Date.now(),
            scopeCgroup: scopeDir.replace(/^\/sys\/fs\/cgroup/, ''),
            sliceCgroup: sliceDir.replace(/^\/sys\/fs\/cgroup/, '') })
            : { status: 'unavailable', confirmed: false, constraint: 'unknown' }
        } catch { evidence.kernel = { status: 'unavailable', confirmed: false, constraint: 'unknown' } }
      }
      return classifyOom(evidence, exit)
    },
  }
}

export function formatOomNotice(diagnosis) {
  const { confirmed, suspected, unconfirmed, constraint, evidence } = diagnosis
  if (!confirmed && !unconfirmed) return ''
  let message
  if (suspected) {
    message = 'Possible OOM: the run ended abruptly while OOM kills occurred in the shared slice. This does not confirm that this run was OOM-killed; another job may have been the victim. The constraining limit is unknown.'
  } else if (!confirmed) {
    message = 'The run ended abruptly. Available memory evidence does not confirm an OOM kill; the termination cause and any constraining memory limit are unknown.'
  } else if (constraint === 'scope') {
    message = 'The run was OOM-killed by its per-run scope limit. Reduce workload memory or request a larger per-run allowance that fits the host budget.'
  } else if (constraint === 'slice') {
    message = 'The run was OOM-killed by the shared agent slice limit. Reduce concurrent memory demand or run the workload exclusively/on a suitably sized host.'
  } else {
    message = "The run was OOM-killed. Its own limit or an ancestor's shared limit may have been responsible; the constraining limit is unknown. Check host contention and workload memory before changing allowances."
  }
  const scope = evidence.scope ?? {}
  const slice = evidence.slice ?? {}
  return `${message}\nRequested per-run MemoryHigh=${evidence.requested?.high ?? 'unknown'} MemoryMax=${evidence.requested?.max ?? 'unknown'}; observed scope high/max=${scope.high ?? 'unavailable'}/${scope.max ?? 'unavailable'}; shared slice high/max=${slice.high ?? 'unavailable'}/${slice.max ?? 'unavailable'} (observed values in bytes, or max).\nMemory evidence: ${JSON.stringify(evidence)}`
}
