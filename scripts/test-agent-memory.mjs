import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyOom, createScopeMemoryMonitor, formatOomNotice, isOomKill, kernelOomEvidence, parseMemoryEvents } from '../server/agent-memory.js'

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
  // Still reported as a (likely) slice OOM, so the orchestrator gets the memory hint.
  assert.equal(diagnosis.likely, 'slice')
  assert.equal(isOomKill(diagnosis), true)
  assert.match(formatOomNotice(diagnosis).split('\n')[0], /likely OOM-killed by the shared agent slice.*another job may have been the victim/)
}
assert.equal(classifyOom({ sliceDelta: { oom_kill: 5 } }, { code: 0 }).suspected, false)
assert.equal(isOomKill(classifyOom({ sliceDelta: { oom_kill: 5 } }, { code: 0 })), false)

// An unconfirmed SIGKILL with the scope at its MemoryMax is a likely scope OOM: a `max` event, or
// a peak at the limit. The scope wins over a concurrent slice kill.
for (const scope of [{ events: { max: 3, oom_kill: 0 } }, { max: '3221225472', peak: '3221225472', events: { max: 0 } }]) {
  const diagnosis = classifyOom({ scope, sliceDelta: { oom_kill: 1 } }, { code: 137 })
  assert.equal(diagnosis.confirmed, false)
  assert.equal(diagnosis.likely, 'scope')
  assert.equal(diagnosis.constraint, 'scope')
  assert.equal(isOomKill(diagnosis), true)
  assert.match(formatOomNotice(diagnosis).split('\n')[0], /likely OOM-killed by its per-run scope limit/)
}
assert.equal(classifyOom({ scope: { max: 'max', peak: '9' } }, { signal: 'SIGKILL' }).likely, null, 'an unlimited scope is never at its max')
assert.equal(classifyOom({ scope: { events: { max: 3 } } }, { code: 1 }).likely, null, 'a normal failure is not an OOM')

// A kill with no memory evidence must not read as an OOM to FlightDesk's matcher.
const FLIGHTDESK_OOM = /out of memory|\bOOM\b|OOM-killed|memory limit/i
const plainKill = classifyOom({ scope: { events: { max: 0, oom_kill: 0 } }, sliceDelta: { oom_kill: 0 } }, { signal: 'SIGKILL' })
assert.equal(isOomKill(plainKill), false)
assert.doesNotMatch(formatOomNotice(plainKill).split('\n')[0], FLIGHTDESK_OOM)
for (const d of [confirmed, classifyOom({ scope: { events: { max: 1 } } }, { code: 137 }), classifyOom({ sliceDelta: { oom_kill: 1 } }, { code: 137 })]) {
  assert.match(formatOomNotice(d).split('\n')[0], /OOM-killed/)
}

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
  assert.equal(isOomKill(absent), false)
  assert.match(formatOomNotice(absent), /no sign of memory pressure/)

  // The monitor reads memory.peak: a scope that peaked at memory.max and was SIGKILLed with no kill
  // counter is a likely scope OOM.
  const atMax = createScopeMemoryMonitor({ scopeDir, sliceDir, memory, readKernel: async () => ({ status: 'unavailable', confirmed: false }) })
  writeGroup(scopeDir)
  fs.writeFileSync(path.join(scopeDir, 'memory.peak'), '3221225472')
  atMax.sample()
  const likely = await atMax.finish({ code: 137 })
  assert.equal(likely.evidence.scope.peak, '3221225472')
  assert.equal([likely.confirmed, likely.likely, isOomKill(likely)].join(), 'false,scope,true')
  fs.rmSync(scopeDir, { recursive: true })

  const unresolved = createScopeMemoryMonitor({ scopeDir: null, sliceDir: null, memory })
  const unknown = await unresolved.finish({ signal: 'SIGKILL' })
  assert.equal(unknown.confirmed, false)
  assert.equal(unknown.evidence.kernel.status, 'unavailable')
  assert.match(formatOomNotice(unknown), /no sign of memory pressure/)
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
console.log('Agent memory evidence tests passed')
