import assert from 'node:assert/strict'
import { resultItemCount, toolCallMetric, toolListMetric } from '../mcp/telemetry.js'

assert.equal(resultItemCount([{ id: 1 }, { id: 2 }]), 2)
assert.equal(resultItemCount({ tasks: [{ id: 1 }] }), 1)
assert.equal(resultItemCount({ ok: true }), null)

const call = toolCallMetric({
  name: 'search_tasks',
  args: { status: 'active' },
  result: [{ id: 'one' }],
  startedAt: Date.now(),
  ok: true,
})
assert.equal(call.tool, 'search_tasks')
assert.equal(call.ok, true)
assert.equal(call.item_count, 1)
assert.equal(call.argument_bytes, Buffer.byteLength(JSON.stringify({ status: 'active' })))
assert.equal(call.result_bytes, Buffer.byteLength(JSON.stringify([{ id: 'one' }])))
assert.equal(Object.hasOwn(call, 'args'), false, 'telemetry must not contain argument contents')
assert.equal(Object.hasOwn(call, 'result'), false, 'telemetry must not contain result contents')

assert.deepEqual(toolListMetric([{ name: 'one' }]), {
  tool_count: 1,
  definition_bytes: Buffer.byteLength(JSON.stringify([{ name: 'one' }])),
})

console.log('MCP telemetry tests passed')
