// scripts/test-mcp-scope.mjs
// Tests the scope decision the MCP server uses to gate tool calls (bug C7).
// mcp/http-server.js computes `req._mcpFullAccess = requireScope(user, 'full_access')` after
// authenticate(), and refuses tools/call when that is false. This exercises the exact predicate
// against REAL auth code (createToken/authenticate/requireScope) on a throwaway DB.
//
// Run: node scripts/test-mcp-scope.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initAuth, createToken, authenticate, requireScope } from '../server/auth.js'

let failures = 0
function check(name, got, want) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-scope-'))
try {
  const db = initAuth(path.join(dir, 'tasks.db'))
  const ro = createToken(db, { label: 'ro', scopes: 'read_only' })
  const fa = createToken(db, { label: 'fa', scopes: 'full_access' })

  const reqFor = t => ({ headers: { authorization: `Bearer ${t}` } })
  const mayCall = user => !!user && requireScope(user, 'full_access')

  const roUser = authenticate(db, reqFor(ro.token))
  const faUser = authenticate(db, reqFor(fa.token))

  check('read_only token authenticates', !!roUser, true)
  check('read_only token CANNOT call MCP tools', mayCall(roUser), false)
  check('full_access token CAN call MCP tools', mayCall(faUser), true)
  check('missing/invalid token → no user', authenticate(db, reqFor('qalatra_bogus')), null)
  check('no auth header → no user', authenticate(db, { headers: {} }), null)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1) }
console.log('\nAll MCP scope tests passed.')
