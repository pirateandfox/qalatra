import assert from 'node:assert/strict'
import { selectFields, normalizeFields, fieldsSchema } from '../mcp/field-select.js'

// Shaped like a real task read: two scalar columns the caller wants, and the two unbounded
// freeform bodies that overflow the MCP output cap.
const rows = [
  { id: 't1', title: 'One', status: 'active', description: 'x'.repeat(40000), ai_context: 'y'.repeat(26000) },
  { id: 't2', title: 'Two', status: 'done', description: 'z', ai_context: null },
]

// No projection requested: unchanged, same object identity for the array.
assert.equal(selectFields(rows, undefined), rows)
assert.equal(selectFields(rows, null), rows)
assert.equal(selectFields(rows, ''), rows)
assert.equal(selectFields(rows, '   '), rows)

// The point of the feature: the freeform bodies are gone.
const picked = selectFields(rows, 'title,status')
assert.deepEqual(picked, [
  { id: 't1', title: 'One', status: 'active' },
  { id: 't2', title: 'Two', status: 'done' },
])
assert.equal(JSON.stringify(picked).length < 120, true, 'projected payload should be small')

// id is kept even when not asked for — a row you cannot address is not actionable.
assert.deepEqual(selectFields(rows, 'title'), [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }])
// ...and is not duplicated when it is asked for.
assert.deepEqual(Object.keys(selectFields(rows, 'id,title')[0]), ['id', 'title'])

// Whitespace and array form both accepted.
assert.deepEqual(selectFields(rows, ' title , status ')[0], { id: 't1', title: 'One', status: 'active' })
assert.deepEqual(selectFields(rows, ['title'])[0], { id: 't1', title: 'One' })

// A typo fails loudly and names the valid columns, rather than silently handing back results that
// look complete while missing what the caller was counting on.
assert.throws(() => selectFields(rows, 'titel'), /Unknown field\(s\): titel\. Available fields: id, title, status, description, ai_context/)
assert.throws(() => selectFields(rows, 'title,nope,alsonope'), /Unknown field\(s\): nope, alsonope/)

// Single-row form (get_agent_job): the prompt is the big field and is droppable.
const job = { id: 'j1', status: 'timed_out', result: 'Agent timed out', prompt: 'p'.repeat(20000), terminated_by: 'timeout' }
assert.deepEqual(selectFields(job, 'status,result,terminated_by'),
  { id: 'j1', status: 'timed_out', result: 'Agent timed out', terminated_by: 'timeout' })
assert.equal(selectFields(job, undefined), job)

// Empty result sets stay empty rather than throwing on validation with nothing to validate against.
assert.deepEqual(selectFields([], 'anything,at,all'), [])
assert.equal(selectFields(null, 'title'), null)

// normalizeFields contract
assert.equal(normalizeFields(undefined), null)
assert.equal(normalizeFields(','), null)
assert.deepEqual(normalizeFields('a, b'), ['a', 'b'])
assert.deepEqual(normalizeFields(['a', ' b ']), ['a', 'b'])

// The shared schema entry carries the example through, so each tool documents itself.
assert.match(fieldsSchema('id,title').description, /id,title/)
assert.equal(fieldsSchema('x').type, 'string')

console.log('field selection tests passed')
