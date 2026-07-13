// scripts/test-restore-apply.mjs
// Test the headless restore-apply path (bug C11): applyPendingRestore must swap a pending
// tasks.db.restore into place (backing up the current DB and clearing WAL/SHM), so a headless
// install actually applies a restore instead of silently ignoring it.
//
// Run: node scripts/test-restore-apply.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyPendingRestore } from '../server/backups.js'

let failures = 0
function check(name, cond) {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-restore-'))
try {
  const dbPath = path.join(dir, 'tasks.db')

  // No pending restore → no-op.
  const none = applyPendingRestore(dir)
  check('no pending restore is a no-op', none.applied === false && none.ok === true)

  // Set up an existing DB + stale WAL/SHM, and a pending restore with new contents.
  fs.writeFileSync(dbPath, 'OLD-DB')
  fs.writeFileSync(dbPath + '-wal', 'stale-wal')
  fs.writeFileSync(dbPath + '-shm', 'stale-shm')
  fs.writeFileSync(path.join(dir, 'tasks.db.restore'), 'NEW-DB')

  const res = applyPendingRestore(dir)
  check('reports applied', res.applied === true && res.ok === true)
  check('tasks.db now holds the restore contents', fs.readFileSync(dbPath, 'utf8') === 'NEW-DB')
  check('previous DB backed up to .pre-restore', fs.readFileSync(dbPath + '.pre-restore', 'utf8') === 'OLD-DB')
  check('restore file consumed', !fs.existsSync(path.join(dir, 'tasks.db.restore')))
  check('stale WAL removed', !fs.existsSync(dbPath + '-wal'))
  check('stale SHM removed', !fs.existsSync(dbPath + '-shm'))

  // Running again with no pending file is a no-op (idempotent).
  check('second run is a no-op', applyPendingRestore(dir).applied === false)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1) }
console.log('\nAll restore-apply (C11) tests passed.')
