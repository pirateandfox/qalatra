// scripts/test-mcp-parity.mjs
// MCP parity lows:
//   C22 — MCP create_task/update_task must upsert the projects table, or a project created via
//         MCP is invisible in list/summary views until a server restart.
//   C24 — mcp/db.js appendAiContext must APPEND (chronological), matching db-worker, not prepend.
//
// TASKOS_DB_DIR set before importing mcp/db.js. Run: node scripts/test-mcp-parity.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-parity-'))
process.env.TASKOS_DB_DIR = dir

let failures = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
}

try {
  const { openDb, appendAiContext } = await import('../mcp/db.js')
  const { handlers } = await import('../mcp/tools/tasks.js')
  const db = openDb()

  // C24: append order — newest entry is last.
  const first = appendAiContext(null, 'first')
  const second = appendAiContext(first, 'second')
  const lines = second.split('\n')
  check('C24: appendAiContext keeps chronological order (oldest first)', lines[0].includes('first'), true)
  check('C24: newest entry is last', lines[lines.length - 1].includes('second'), true)

  // C22: create_task registers the project.
  handlers.create_task({ title: 't1', project: 'New Client' })
  check('C22: create_task upserts project', !!db.prepare('SELECT 1 AS v FROM projects WHERE name = ?').get('New Client'), true)

  // C22: update_task registers a newly-assigned project too.
  const t2 = handlers.create_task({ title: 't2' })
  handlers.update_task({ task_id: t2.task_id, project: 'Another Project' })
  check('C22: update_task upserts project', !!db.prepare('SELECT 1 AS v FROM projects WHERE name = ?').get('Another Project'), true)

  // Idempotent — no duplicate row / no throw on repeat.
  handlers.create_task({ title: 't3', project: 'New Client' })
  check('C22: project upsert is idempotent', db.prepare('SELECT COUNT(*) AS c FROM projects WHERE name = ?').get('New Client').c, 1)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1) }
console.log('\nAll MCP parity (C22/C24) tests passed.')
