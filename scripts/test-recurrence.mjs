// scripts/test-recurrence.mjs
// Standalone regression test for the recurrence date math (bug C1).
//
// There is no unit-test harness in this repo, so this script stands alone.
// It verifies BOTH copies of nextRecurrenceDate produce the correct next date:
//   1. mcp/db.js — imported directly (exported reference implementation)
//   2. db-worker.js — extracted from source (the function is module-private and the
//      file cannot be imported normally: it opens the DB and calls parentPort at load).
//      After the C1 fix its only external dependency is rrulestr, so we rebuild it in
//      isolation from the shipped source text and exercise it here.
//
// Run: node scripts/test-recurrence.mjs   (exit 0 = pass, 1 = fail)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pkg from 'rrule'
const { rrulestr } = pkg

import { nextRecurrenceDate as mcpNext } from '../mcp/db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

// ── Rebuild db-worker's nextRecurrenceDate from source (real shipped text) ──
function loadDbWorkerNext() {
  const src = readFileSync(join(repoRoot, 'db-worker.js'), 'utf8')
  const m = src.match(/function nextRecurrenceDate\(baseDate, rule\) \{[\s\S]*?\n\}/)
  if (!m) throw new Error('Could not locate nextRecurrenceDate in db-worker.js — did the signature change?')
  // The function references only rrulestr from module scope after the fix.
  // eslint-disable-next-line no-new-func
  const factory = new Function('rrulestr', `${m[0]}\nreturn nextRecurrenceDate;`)
  return factory(rrulestr)
}

const dbwNext = loadDbWorkerNext()

// ── Test cases: [baseDate (task's own due_date), recurrence, expectedNextDate] ──
// Dates chosen against a known calendar: 2026-07-06 Mon, -07 Tue, -08 Wed,
// -10 Fri, -13 Mon.
const cases = [
  // daily — was already correct; must stay +1
  ['2026-07-06', 'daily', '2026-07-07'],
  ['2026-07-10', 'daily', '2026-07-11'],

  // weekdays — Fri -> Mon (skip weekend); Mon -> Tue
  ['2026-07-10', 'weekdays', '2026-07-13'],
  ['2026-07-06', 'weekdays', '2026-07-07'],

  // weekly — THE C1 BUG: must be +7, not +1 (Tue)
  ['2026-07-06', 'weekly', '2026-07-13'],
  ['2026-07-10', 'weekly', '2026-07-17'],

  // monthly — THE C1 BUG: must be next month same day-of-month, not +1
  ['2026-07-06', 'monthly', '2026-08-06'],
  ['2026-07-15', 'monthly', '2026-08-15'],

  // anchored RRULE strings (bypass the shorthand map entirely)
  ['2026-07-08', 'FREQ=WEEKLY;BYDAY=MO', '2026-07-13'], // Wed -> next Mon
  ['2026-07-01', 'FREQ=MONTHLY;BYMONTHDAY=1', '2026-08-01'],
]

let failed = 0
console.log('Recurrence regression test (bug C1)\n')
for (const [base, rule, expected] of cases) {
  const dbw = dbwNext(base, rule)
  const mcp = mcpNext(base, rule)
  const ok = dbw === expected && mcp === expected && dbw === mcp
  if (!ok) failed++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  base=${base} rule=${rule.padEnd(26)} ` +
    `expected=${expected} db-worker=${dbw} mcp=${mcp}`
  )
}

// Explicit anti-regression assertions for the exact C1 failure mode.
const weeklyDbw = dbwNext('2026-07-06', 'weekly')
if (weeklyDbw === '2026-07-07') { failed++; console.log('FAIL  C1 regression: weekly collapsed to next-day (db-worker)') }
const monthlyDbw = dbwNext('2026-07-06', 'monthly')
if (monthlyDbw === '2026-07-07') { failed++; console.log('FAIL  C1 regression: monthly collapsed to next-day (db-worker)') }

console.log(`\n${failed === 0 ? 'ALL PASSED' : failed + ' FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
