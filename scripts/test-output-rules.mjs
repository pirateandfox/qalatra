import assert from 'node:assert/strict'
import {
  applyOutputRules,
  finishAgentJobSafely,
  parseAgentOutput,
} from '../server/workers.js'

const qalatraTaskId = '56fe84b7-2630-4e92-b2fb-1e7bfde82097'
const flightDeskTaskId = '6730ed6c-b772-49bc-a39c-d08d26070cd2'
const rule = {
  pattern: 'Task ID: ([a-f0-9-]{36})',
  action: 'add_link',
  url: 'https://flightdesk.dev/app/tasks/{1}',
}

const commandOutput = `Registered successfully\nTask ID: ${flightDeskTaskId}`
assert.deepEqual(parseAgentOutput(commandOutput), { result: commandOutput, sessionId: null })

const agentResult = [
  `You are an agent running inside Qalatra. Task ID: ${qalatraTaskId}`,
  `Task ID: ${flightDeskTaskId}`,
].join('\n')
const parsedAgentOutput = parseAgentOutput(JSON.stringify({ result: agentResult, session_id: 'session-1' }))
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

console.log('output_rules tests passed')
