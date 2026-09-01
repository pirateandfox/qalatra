// ai_context is append-only and every task read carries the whole of it, so nothing bounded the
// payload: a 15-minute heartbeat puts ~96 entries a day on one monitor task until an unrelated
// status read fails the MCP output cap. capAiContext bounds the tail at the single write funnel.
//
// Run: node scripts/test-ai-context-cap.mjs

import assert from 'node:assert/strict'
import {
  capAiContext, appendAiContext,
  AI_CONTEXT_MAX_ENTRIES, AI_CONTEXT_MAX_CHARS,
} from '../server/task-logic.js'

const MARKER = /^\[…\] (\d+) earlier entr(?:y|ies) trimmed$/
const entry = (day, text) => `[2026-08-${String(day).padStart(2, '0')}] ${text}`

// Empty / absent input is passed through untouched.
assert.equal(capAiContext(null), null)
assert.equal(capAiContext(undefined), null)
assert.equal(capAiContext(''), '')  // falsy input passes through, matching appendAiContext's `existing ?? null`

// Under both budgets: byte-identical, no marker.
const small = [entry(1, 'a'), entry(2, 'b')].join('\n')
assert.equal(capAiContext(small), small)

// ── Entry-count budget ────────────────────────────────────────────────────────
// 200 entries, as the acceptance case describes.
const many = Array.from({ length: 200 }, (_, i) => `[2026-08-01] note ${i}`).join('\n')
const capped = many.split('\n').reduce((acc, line) => capAiContext(acc ? `${acc}\n${line}` : line), null)
const lines = capped.split('\n')

// A marker, then exactly the budget in entries.
assert.match(lines[0], MARKER)
assert.equal(lines.length, AI_CONTEXT_MAX_ENTRIES + 1)
assert.equal(Number(lines[0].match(MARKER)[1]), 200 - AI_CONTEXT_MAX_ENTRIES)

// The survivors are the NEWEST entries — trimming the wrong end would destroy the context the
// caller actually wants, which is why the append/prepend ambiguity had to be settled first.
assert.equal(lines[1], '[2026-08-01] note 150')
assert.equal(lines[lines.length - 1], '[2026-08-01] note 199')
assert.equal(capped.includes('note 149'), false)

// Markers accumulate a running total instead of stacking.
const more = appendAiContext(capped, 'one more')
assert.equal(more.split('\n').filter(l => MARKER.test(l)).length, 1)
assert.equal(Number(more.split('\n')[0].match(MARKER)[1]), 151)
assert.equal(more.endsWith('one more'), true)

// ── Character budget ──────────────────────────────────────────────────────────
// Few entries, each large: the count budget never binds, so chars must.
const fat = Array.from({ length: 6 }, (_, i) => `[2026-08-01] ${String(i).repeat(3000)}`).join('\n')
const fatCapped = capAiContext(fat)
assert.match(fatCapped.split('\n')[0], MARKER)
assert.equal(fatCapped.length < AI_CONTEXT_MAX_CHARS + 100, true, 'char budget should bind')
assert.equal(fatCapped.includes('5'.repeat(3000)), true, 'newest survives')
assert.equal(fatCapped.includes('0'.repeat(3000)), false, 'oldest dropped')

// A single entry over the whole budget still survives: erasing it would drop the newest context,
// which is worse than exceeding the cap on one write.
const huge = `[2026-08-01] ${'x'.repeat(AI_CONTEXT_MAX_CHARS * 2)}`
assert.equal(capAiContext(huge), huge)
assert.equal(capAiContext(`[2026-08-01] old\n${huge}`), `[…] 1 earlier entry trimmed\n${huge}`)

// ── Multi-line entries ────────────────────────────────────────────────────────
// The boundary is a day stamp at line start, not every newline, so a note containing newlines
// stays one entry and is not shredded into fragments by the trim.
const multi = [`[2026-08-01] first\n  continued\n  still first`, `[2026-08-02] second`].join('\n')
assert.equal(capAiContext(multi), multi)
const multiTrimmed = capAiContext([...Array.from({ length: 60 }, (_, i) => `[2026-08-01] n${i}\n  cont ${i}`)].join('\n'))
assert.equal(multiTrimmed.split('\n')[1], '[2026-08-01] n10')  // 60 entries, newest 50 kept
assert.equal(multiTrimmed.split('\n')[2], '  cont 10')       // its continuation line rode along

// Legacy unstamped content is not mistaken for a marker; it is an entry and can be trimmed.
const legacy = capAiContext(['unstamped legacy blob', ...Array.from({ length: 60 }, (_, i) => `[2026-08-01] n${i}`)].join('\n'))
assert.equal(legacy.includes('unstamped legacy blob'), false)
assert.match(legacy.split('\n')[0], MARKER)

// A line that merely looks marker-ish is not treated as one.
const decoy = ['[…] not really a marker', '[2026-08-01] real'].join('\n')
assert.equal(capAiContext(decoy), decoy)

// ── appendAiContext contract is unchanged apart from the cap ──────────────────
assert.equal(appendAiContext(null, ''), null)
assert.equal(appendAiContext('existing', null), 'existing')
assert.match(appendAiContext(null, 'hello'), /^\[\d{4}-\d{2}-\d{2}\] hello$/)
assert.equal(appendAiContext('[2026-08-01] a', 'b').split('\n')[0], '[2026-08-01] a')

console.log('ai_context cap tests passed')
