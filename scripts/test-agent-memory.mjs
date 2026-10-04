import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyOom, createScopeMemoryMonitor, formatOomNotice, kernelOomEvidence, parseMemoryEvents } from '../server/agent-memory.js'

const slice = '/user.slice/qalatra-agents.slice'
const scope = `${slice}/qalatra-agent-one.scope`
const kernelLine = (victim, constraint) => JSON.stringify({ MESSAGE: `oom-kill:constraint=CONSTRAINT_MEMCG,oom_memcg=${constraint},task_memcg=${victim},task=node,pid=100,uid=1000` })
for (const [constraint, expected, wording] of [[scope, 'scope', /larger per-run allowance that fits the host budget/], [slice, 'slice', /Reduce concurrent memory demand/], ['/user.slice', 'unknown', /constraining limit is unknown/]]) {
  const kernel = kernelOomEvidence(kernelLine(scope, constraint), scope, slice)
  assert.equal(kernel.constraint, expected)
  const diagnosis = classifyOom({ kernel, requested: { high: '2G', max: '3G' } })
  assert.equal(diagnosis.confirmed, true)
  assert.match(formatOomNotice(diagnosis), wording)
}
assert.equal(kernelOomEvidence(kernelLine(`${scope}-other`, slice), scope, slice).confirmed, false)
assert.equal(kernelOomEvidence(`${kernelLine(scope, scope)}\n${kernelLine(scope, slice)}`, scope, slice).constraint, 'unknown', 'concurrent constraints remain ambiguous')
assert.equal(kernelOomEvidence('not JSON', scope, slice).confirmed, false)
assert.deepEqual(parseMemoryEvents('high 10\nmax 3\noom 1\noom_kill 2\noom_group_kill 1\nunknown 9'), { high: 10, max: 3, oom: 1, oom_kill: 2, oom_group_kill: 1 })

// Victim counters prove a kill, never which limit was responsible (even with local oom events).
const confirmed = classifyOom({ scope: { events: { oom_kill: 1 }, local: { oom: 1 } }, sliceLocalDelta: { oom: 1 } })
assert.equal(confirmed.confirmed, true)
assert.equal(confirmed.constraint, 'unknown')
assert.match(formatOomNotice(confirmed), /own limit or an ancestor's shared limit/)
for (const scopeEvents of [null, { oom_kill: 0 }]) {
  const diagnosis = classifyOom({ scope: { events: scopeEvents }, sliceDelta: { oom_kill: 5 } }, { signal: 'SIGKILL' })
  assert.equal(diagnosis.confirmed, false, 'a sibling OOM cannot prove this job died from OOM')
  assert.equal(diagnosis.suspected, true)
  assert.match(formatOomNotice(diagnosis), /another job may have been the victim/)
}
assert.equal(classifyOom({ sliceDelta: { oom_kill: 5 } }, { code: 0 }).suspected, false)

// Linux cgroup file fixtures: capture counters while a transient scope exists, preserve the last
// observation after collection, compute slice deltas (not historical totals), tolerate no journal.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-memory-'))
const sliceDir = path.join(dir, 'slice')
const scopeDir = path.join(sliceDir, 'job.scope')
fs.mkdirSync(sliceDir)
const writeGroup = (where, { kills = 0, oom = 0 } = {}) => {
  fs.mkdirSync(where, { recursive: true })
  fs.writeFileSync(path.join(where, 'memory.events'), `high 10\nmax 3\noom ${oom}\noom_kill ${kills}\n`)
  fs.writeFileSync(path.join(where, 'memory.events.local'), `high 5\nmax 1\noom ${oom}\noom_kill 0\n`)
  fs.writeFileSync(path.join(where, 'memory.high'), '2147483648')
  fs.writeFileSync(path.join(where, 'memory.max'), '3221225472')
}
const memory = { high: '2G', max: '3G' }
try {
  writeGroup(sliceDir, { kills: 92, oom: 8 })
  const monitor = createScopeMemoryMonitor({ scopeDir, sliceDir, memory, readKernel: async () => { throw new Error('permission denied') } })
  writeGroup(scopeDir, { kills: 2 })
  writeGroup(sliceDir, { kills: 94, oom: 9 })
  monitor.sample()
  fs.rmSync(scopeDir, { recursive: true })
  const diagnosis = await monitor.finish({ code: 137 })
  assert.equal(diagnosis.confirmed, true)
  assert.equal(diagnosis.constraint, 'unknown')
  assert.equal(diagnosis.evidence.sliceDelta.oom_kill, 2)
  assert.equal(diagnosis.evidence.sliceLocalDelta.oom, 1)
  assert.equal(diagnosis.evidence.scope.max, '3221225472')
  assert.equal(diagnosis.evidence.kernel.status, 'unavailable')
  assert.match(formatOomNotice(diagnosis), /MemoryMax=3G/)

  const collected = createScopeMemoryMonitor({ scopeDir, sliceDir, memory, readKernel: async () => ({ status: 'unavailable', confirmed: false }) })
  writeGroup(sliceDir, { kills: 95, oom: 10 })
  const uncertain = await collected.finish({ signal: 'SIGKILL' })
  assert.equal(uncertain.confirmed, false)
  assert.equal(uncertain.suspected, true)
  assert.equal(uncertain.evidence.scope.events, null)

  const missing = createScopeMemoryMonitor({ scopeDir: '/nonexistent/scope', sliceDir: '/nonexistent/slice', memory, readKernel: async () => { throw new Error('no journal') } })
  const absent = await missing.finish({ code: 137 })
  assert.equal(absent.confirmed, false)
  assert.match(formatOomNotice(absent), /does not confirm an OOM kill/)

  const unresolved = createScopeMemoryMonitor({ scopeDir: null, sliceDir: null, memory })
  const unknown = await unresolved.finish({ signal: 'SIGKILL' })
  assert.equal(unknown.confirmed, false)
  assert.equal(unknown.evidence.kernel.status, 'unavailable')
  assert.match(formatOomNotice(unknown), /does not confirm an OOM kill/)
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
console.log('Agent memory evidence tests passed')
