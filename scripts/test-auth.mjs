import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { authenticate, ensureBootstrapToken, initAuth } from '../server/auth.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-auth-test-'))
const token = 'qalatra_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'
let authDb

try {
  authDb = initAuth(path.join(tempDir, 'tasks.db'))

  assert.throws(
    () => ensureBootstrapToken(authDb, tempDir, { token: 'not-a-valid-token' }),
    /QALATRA_BOOTSTRAP_TOKEN/,
  )

  const bootstrap = ensureBootstrapToken(authDb, tempDir, { token })
  assert.ok(bootstrap)
  assert.equal(fs.readFileSync(bootstrap.tokenPath, 'utf8').trim(), token)
  assert.equal(fs.statSync(bootstrap.tokenPath).mode & 0o777, 0o600)

  const user = authenticate(authDb, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.ok(user?.scopes.includes('full_access'))
  assert.equal(
    ensureBootstrapToken(authDb, tempDir, { token: `${token}more` }),
    null,
    'an active full-access token must not be replaced on a normal restart',
  )

  console.log('bootstrap authentication tests passed')
} finally {
  authDb?.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
}
