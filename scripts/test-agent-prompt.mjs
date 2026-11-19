// Fresh-dispatch prompts are bounded: task notes used to be replayed in full into every job, so a
// long-lived handle task crossed Linux's 131,072-byte per-argument limit and died with E2BIG.
//
// Run: node scripts/test-agent-prompt.mjs

import assert from 'node:assert/strict'
import { composeAgentPrompt, promptArgError, truncateUtf8, AGENT_PROMPT_MAX_BYTES, ARG_MAX_STRLEN } from '../server/agent-prompt.js'

const bytes = s => Buffer.byteLength(s, 'utf8')
const task = { title: 'Pipeline handle', description: 'Watch the board.', agent_path: '/w/agents/pipeline' }
const base = { taskId: 't1', task }

// Small task: every note, in order, no marker — same shape as before.
{
  const notes = [{ author: 'agent', body: 'first' }, { author: 'user', body: 'second' }]
  const { prompt, omittedNotes } = composeAgentPrompt({ ...base, notes, userMessage: 'go' })
  assert.equal(omittedNotes, 0)
  assert.ok(prompt.includes('--- Conversation ---\n[agent]: first\n[user]: second\n[user]: go'))
  assert.ok(!prompt.includes('omitted'))
}

// The reported case: ~1 KB note per run, enough runs to exceed the limit.
{
  const notes = Array.from({ length: 200 }, (_, i) => ({ author: 'agent', body: `run ${i} ` + 'x'.repeat(1000) }))
  const { prompt, omittedNotes } = composeAgentPrompt({ ...base, notes, userMessage: 'new turn' })
  assert.ok(bytes(prompt) <= AGENT_PROMPT_MAX_BYTES, `prompt ${bytes(prompt)} over budget`)
  assert.ok(omittedNotes > 0)
  assert.ok(prompt.includes(`[… ${omittedNotes} earlier notes omitted`))
  assert.ok(prompt.includes('get_task_notes for task t1'))
  assert.ok(prompt.includes('run 199 '), 'newest note kept')
  assert.ok(!prompt.includes(`run ${omittedNotes - 1} `), 'oldest notes dropped')
  assert.ok(prompt.endsWith('[user]: new turn'), 'user turn kept whole, last')
  assert.equal(promptArgError(prompt, 'linux'), null)
}

// A huge description is truncated, and still leaves room for the conversation.
{
  const big = { ...task, description: 'd'.repeat(300 * 1024) }
  const notes = [{ author: 'user', body: 'latest instruction' }]
  const { prompt, truncatedDescription } = composeAgentPrompt({ taskId: 't2', task: big, notes })
  assert.ok(truncatedDescription)
  assert.ok(bytes(prompt) <= AGENT_PROMPT_MAX_BYTES)
  assert.ok(prompt.includes('description truncated'))
  assert.ok(prompt.includes('[user]: latest instruction'))
}

// A single enormous newest note is kept as its tail rather than dropped.
{
  const notes = [{ author: 'agent', body: 'old' }, { author: 'agent', body: 'a'.repeat(200 * 1024) + 'THE-END' }]
  const { prompt, omittedNotes } = composeAgentPrompt({ ...base, notes })
  assert.ok(bytes(prompt) <= AGENT_PROMPT_MAX_BYTES)
  assert.equal(omittedNotes, 1)
  assert.ok(prompt.includes('THE-END'))
}

// Multi-byte text never splits a character.
{
  assert.equal(truncateUtf8('ééé', 3), 'é')
  assert.equal(truncateUtf8('ééé', 3, true), 'é')
  const notes = Array.from({ length: 100 }, () => ({ author: 'a', body: '🦊'.repeat(500) }))
  const { prompt } = composeAgentPrompt({ ...base, notes })
  assert.ok(!prompt.includes('�'))
  assert.ok(bytes(prompt) <= AGENT_PROMPT_MAX_BYTES)
}

// Launch guard: names the size on Linux, silent elsewhere and under the limit.
{
  const over = 'x'.repeat(ARG_MAX_STRLEN + 1)
  assert.match(promptArgError(over, 'linux'), /per-argument limit/)
  assert.equal(promptArgError(over, 'darwin'), null)
  assert.equal(promptArgError('x'.repeat(ARG_MAX_STRLEN), 'linux'), null)
}

console.log('agent-prompt: ok')
