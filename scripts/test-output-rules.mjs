import assert from 'node:assert/strict'
import {
  applyOutputRules,
  finishAgentJobSafely,
} from '../server/workers.js'
import { getRuntime } from '../server/agent-runtimes.js'

// Output parsing moved from a single parseAgentOutput() into per-runtime consumers. Feeding a
// consumer in chunks also exercises the cross-chunk line assembly the streaming path depends on.
function consume(consumer, text, chunkSize = 7) {
  for (let i = 0; i < text.length; i += chunkSize) consumer.push(text.slice(i, i + chunkSize))
  return consumer.finish()
}
const claudeRuntime = getRuntime('claude')
const parseBuffered = output => consume(claudeRuntime.createConsumer({ stream: false }), output)
const parseStreamed = output => consume(claudeRuntime.createConsumer({ stream: true }), output)

const qalatraTaskId = '56fe84b7-2630-4e92-b2fb-1e7bfde82097'
const flightDeskTaskId = '6730ed6c-b772-49bc-a39c-d08d26070cd2'
const rule = {
  pattern: 'Task ID: ([a-f0-9-]{36})',
  action: 'add_link',
  url: 'https://flightdesk.dev/app/tasks/{1}',
}

const commandOutput = `Registered successfully\nTask ID: ${flightDeskTaskId}`
assert.deepEqual(parseBuffered(commandOutput), { result: commandOutput, sessionId: null })

const agentResult = [
  `You are an agent running inside Qalatra. Task ID: ${qalatraTaskId}`,
  `Task ID: ${flightDeskTaskId}`,
].join('\n')
const parsedAgentOutput = parseBuffered(JSON.stringify({ result: agentResult, session_id: 'session-1' }))
assert.deepEqual(parsedAgentOutput, { result: agentResult, sessionId: 'session-1' })

const calls = []
const notifications = []
await finishAgentJobSafely({
  dbCall: async (method, ...args) => {
    calls.push([method, ...args])
    if (method === 'insertAgentNote') return { ok: true, auto_attached: 0 }
    return { ok: true }
  },
  notify: event => notifications.push(event),
  job: { id: 'job-1', task_id: qalatraTaskId },
  status: 'done',
  result: parsedAgentOutput.result,
  sessionId: parsedAgentOutput.sessionId,
  outputRules: [rule],
})

assert.deepEqual(calls.map(call => call[0]), ['finishAgentJob', 'insertAgentNote', 'addTaskLink'])
assert.deepEqual(calls[2], [
  'addTaskLink',
  qalatraTaskId,
  `https://flightdesk.dev/app/tasks/${flightDeskTaskId}`,
])
assert.deepEqual(notifications, [{ type: 'agent-job:complete', taskId: qalatraTaskId, jobId: 'job-1' }])

const commandCalls = []
await applyOutputRules({
  dbCall: async (...args) => { commandCalls.push(args) },
  jobId: 'job-2',
  taskId: qalatraTaskId,
  rules: [rule],
  output: commandOutput,
})
assert.deepEqual(commandCalls, [[
  'addTaskLink',
  qalatraTaskId,
  `https://flightdesk.dev/app/tasks/${flightDeskTaskId}`,
]])

const recoveryCalls = []
const errors = []
await applyOutputRules({
  dbCall: async (...args) => { recoveryCalls.push(args) },
  jobId: 'job-3',
  taskId: qalatraTaskId,
  rules: [{ ...rule, pattern: '[' }, rule],
  output: commandOutput,
  logger: { error: message => errors.push(message) },
})
assert.equal(errors.length, 1)
assert.match(errors[0], /output rule 1 failed for job job-3/)
assert.equal(recoveryCalls.length, 1)

const failedJobCalls = []
await finishAgentJobSafely({
  dbCall: async (method, ...args) => { failedJobCalls.push([method, ...args]); return { ok: true } },
  notify: () => {},
  job: { id: 'job-4', task_id: qalatraTaskId },
  status: 'failed',
  result: commandOutput,
  sessionId: null,
  outputRules: [rule],
})
assert.deepEqual(failedJobCalls.map(call => call[0]), ['finishAgentJob'])

// Streaming path: the final result event wins, and output rules must match against that extracted
// text rather than the surrounding JSONL envelope.
const streamed = parseStreamed([
  '{"type":"system","subtype":"init","session_id":"session-2"}',
  `{"type":"assistant","session_id":"session-2","message":{"content":[{"type":"text","text":"working"}]}}`,
  `{"type":"result","subtype":"success","session_id":"session-2","result":${JSON.stringify(agentResult)}}`,
  '',
].join('\n'))
assert.deepEqual(streamed, { result: agentResult, sessionId: 'session-2' })

const streamedRuleCalls = []
await applyOutputRules({
  dbCall: async (...args) => { streamedRuleCalls.push(args) },
  jobId: 'job-5',
  taskId: qalatraTaskId,
  rules: [rule],
  output: streamed.result,
})
assert.deepEqual(streamedRuleCalls, [[
  'addTaskLink',
  qalatraTaskId,
  `https://flightdesk.dev/app/tasks/${flightDeskTaskId}`,
]])

// The reason streaming exists: a run killed before it can report a result still yields a resumable
// session id, plus whatever the agent had already said.
const killed = parseStreamed([
  '{"type":"system","subtype":"init","session_id":"session-3"}',
  '{"type":"assistant","session_id":"session-3","message":{"content":[{"type":"text","text":"partial work"}]}}',
  '{"type":"assistant","session_id":"session-3","message":{"con',   // truncated by SIGKILL mid-write
].join('\n'))
assert.deepEqual(killed, { result: 'partial work', sessionId: 'session-3' })

// A timed-out job records the cause so consumers can tell a resource limit from an agent failure.
const timedOutCalls = []
await finishAgentJobSafely({
  dbCall: async (method, ...args) => { timedOutCalls.push([method, ...args]); return { ok: true } },
  notify: () => {},
  job: { id: 'job-6', task_id: qalatraTaskId },
  status: 'timed_out',
  result: 'Agent timed out after 60 minutes',
  sessionId: 'session-3',
  terminatedBy: 'timeout',
  outputRules: [rule],
})
// No note and no output rules for a non-done job, and the cause is persisted.
assert.deepEqual(timedOutCalls.map(call => call[0]), ['finishAgentJob'])
assert.deepEqual(timedOutCalls[0], ['finishAgentJob', 'job-6', 'timed_out', 'Agent timed out after 60 minutes', 'session-3', 'timeout'])

console.log('output_rules tests passed')
