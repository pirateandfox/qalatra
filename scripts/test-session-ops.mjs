import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionOps } from '../server/session-ops.js'
import { compactReport } from '../server/integrations/flightdesk/dispatch.js'

const approval = {
  title: 'Allow Claude to use add repo?', action: 'use add repo',
  fields: [{ label: 'Owner', value: 'MoceanicHQ' }, { label: 'Repo', value: 'moceanic-ai' }],
  options: [{ digit: 1, label: 'Deny' }, { digit: 2, label: 'Allow once' }],
  text: 'Allow Claude to use add repo? Deny Allow once',
}

function fixture(state, transcript = [{ role: 'user', text: 'Implement the task' }]) {
  const calls = []
  const ops = createSessionOps({ connectImpl: async () => ({
    async callTool({ name }) {
      calls.push(name)
      if (name.includes('transcript') && transcript instanceof Error) throw transcript
      return { content: [{ type: 'text', text: JSON.stringify(name.includes('get_state') ? state : transcript) }] }
    },
  }) })
  return { ops, calls }
}

test('native approval survives the session reader and FlightDesk report without needing a transcript', async () => {
  const { ops, calls } = fixture({ state: 'awaiting_approval', workerStatus: 'requires_action', needsHuman: true, approval })
  const result = await ops.state({ sessionId: 'session_test' })
  assert.equal(result.needsHuman, true)
  assert.equal(result.sessionIdle, false)
  assert.equal(result.lastTurnEndsWithQuestion, false)
  assert.deepEqual(result.approval, approval)
  assert.deepEqual(compactReport(result).approval, approval)
  assert.deepEqual(calls, ['claude_session_get_state'])
})

for (const signal of [{ workerStatus: 'requires_action' }, { state: 'awaiting_approval' }, { needsHuman: true }, { approval }]) {
  test(`recognizes independently reported approval signal ${Object.keys(signal)[0]}`, async () => {
    const { ops } = fixture({ state: 'running', ...signal }, new Error('transcript unavailable'))
    const result = await ops.state({ sessionId: 'session_test' })
    assert.equal(result.state, 'awaiting_approval')
    assert.equal(result.needsHuman, true)
    assert.equal(result.sessionIdle, false)
  })
}

test('unreadable approval stays pending; absence of a card never means approval granted', async () => {
  const { ops } = fixture({ state: 'awaiting_approval', workerStatus: 'requires_action', approval: null })
  const result = await ops.state({ sessionId: 'session_test' })
  assert.equal(result.needsHuman, true)
  assert.equal(result.approval, null)
})

test('confirmed resumed state carries an explicit clear signal through compactReport', async () => {
  const { ops } = fixture({ state: 'running', workerStatus: 'running', needsHuman: false, approval: null })
  const result = compactReport(await ops.state({ sessionId: 'session_test' }))
  assert.equal(result.needsHuman, false)
  assert.equal(result.approval, null)
})

test('ordinary idle asks keep the existing transcript behavior', async () => {
  const { ops } = fixture({ state: 'ready', workerStatus: 'idle' }, [{ role: 'assistant', text: 'Which color?', timestamp: 'now' }])
  const result = await ops.state({ sessionId: 'session_test' })
  assert.equal(result.needsHuman, false)
  assert.equal(result.sessionIdle, true)
  assert.equal(result.lastTurnEndsWithQuestion, true)
})

test('unknown state cannot clear an approval or count as idle', async () => {
  const { ops } = fixture({ state: 'unknown' }, new Error('unavailable'))
  const result = await ops.state({ sessionId: 'session_test' })
  assert.equal(result.state, 'unknown')
  assert.equal(result.sessionIdle, false)
})
