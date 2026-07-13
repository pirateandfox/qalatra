// scripts/test-box-role.mjs
// Standalone tests for the box-role duty-worker gate (bugs C2/C5).
// Pure decision function — no DB, no filesystem. Run: node scripts/test-box-role.mjs

import { shouldRunDutyWorkers } from '../server/box-role.js'

let failures = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`)
}

// Ordinary single-box install: no role configured, no env flag → workers on (historic default).
check('no role, no flag → run',
  shouldRunDutyWorkers({ env: {}, role: null }).run, true)

// Explicit off always wins.
check('QALATRA_START_WORKERS=0 → off',
  shouldRunDutyWorkers({ env: { QALATRA_START_WORKERS: '0' }, role: 'shi-prime', identity: 'shi-prime' }).run, false)

// Canonical box: role matches this box's identity → run.
check('role matches identity → run',
  shouldRunDutyWorkers({ env: {}, role: 'shi-prime', identity: 'shi-prime' }).run, true)

// Non-canonical box (e.g. laptop): role names a different box → do NOT run.
check('role != identity → off (the laptop guard)',
  shouldRunDutyWorkers({ env: {}, role: 'shi-prime', identity: 'justin-laptop' }).run, false)

// Role configured but identity unknown/empty → fail closed.
check('role set, empty identity → off',
  shouldRunDutyWorkers({ env: {}, role: 'shi-prime', identity: '' }).run, false)

// QALATRA_BOX_ROLE env resolves the configured role when role not injected.
check('env QALATRA_BOX_ROLE match → run',
  shouldRunDutyWorkers({ env: { QALATRA_BOX_ROLE: 'boxA', QALATRA_BOX_HOSTNAME: 'boxA' } }).run, true)
check('env QALATRA_BOX_ROLE mismatch → off',
  shouldRunDutyWorkers({ env: { QALATRA_BOX_ROLE: 'boxA', QALATRA_BOX_HOSTNAME: 'boxB' } }).run, false)

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1) }
console.log('\nAll box-role tests passed.')
