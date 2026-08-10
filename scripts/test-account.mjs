import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const sourceDir = path.join(ROOT, 'packages', 'shared', 'src')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-account-test-'))

function compile(sourceName, outputName) {
  const sourcePath = path.join(sourceDir, sourceName)
  const source = fs.readFileSync(sourcePath, 'utf8')
  const result = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  })
  const output = result.outputText.replace(/from ["']\.\/platform["']/g, 'from "./platform.js"')
  fs.writeFileSync(path.join(tempDir, outputName), output)
}

function memoryStore() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

const originalFetch = globalThis.fetch

try {
  compile('platform.ts', 'platform.js')
  compile('account.ts', 'account.js')

  const platform = await import(pathToFileURL(path.join(tempDir, 'platform.js')).href)
  const account = await import(pathToFileURL(path.join(tempDir, 'account.js')).href)
  const persistent = memoryStore()
  const secure = memoryStore()
  const session = memoryStore()

  platform.configurePlatform({
    persistent,
    secure,
    session,
    capabilities: { canManageLocalServer: false, requiresAccountAuth: true },
    account: {
      graphqlUrl: 'https://accounts.example/graphql',
      portalUrl: 'https://accounts.example/',
      productKey: 'connect',
    },
  })

  const queued = [
    response({
      data: {
        login: { token: null, user: null, requires2FA: true, tempToken: 'temporary-2fa-token' },
      },
    }),
    response({
      data: {
        complete2FALogin: {
          token: 'account-jwt',
          user: { id: 'user-1', displayName: 'Ada', activeOrganizationId: 'org-1' },
        },
      },
    }),
    response({
      data: {
        entitlements: [
          { productKey: 'connect', active: false, hasSeat: false },
          { productKey: 'cloud', active: true, hasSeat: true, planName: 'Cloud Agent Node' },
        ],
      },
    }),
    response(
      { errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }] },
      401,
    ),
  ]
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    assert.ok(queued.length, 'unexpected account API request')
    return queued.shift()
  }

  const firstStep = await account.loginAccount('ada@example.com', 'correct horse battery staple')
  assert.deepEqual(firstStep, { status: 'requires_2fa', tempToken: 'temporary-2fa-token' })
  assert.equal(account.getAccountToken(), null, 'temporary 2FA state must not persist as a session')

  const completed = await account.completeAccount2FA('temporary-2fa-token', '123456')
  assert.equal(completed.status, 'authenticated')
  assert.equal(account.getAccountToken(), 'account-jwt')

  const entitlement = await account.getAccountEntitlement()
  assert.equal(entitlement?.productKey, 'cloud', 'an assigned Cloud admin seat should unlock Connect')
  assert.equal(calls[2].init.headers.Authorization, 'Bearer account-jwt')
  assert.equal(account.accountPortalUrl('/team'), 'https://accounts.example/team')

  await assert.rejects(
    account.getAccountEntitlement(),
    /session expired or was revoked/i,
  )
  assert.equal(account.getAccountToken(), null, 'an unauthenticated response must clear the saved token')
  assert.match(calls[0].body.query, /mutation AccountLogin/)
  assert.match(calls[1].body.query, /complete2FALogin/)
  assert.match(calls[2].body.query, /query AccountEntitlements/)
  assert.equal(queued.length, 0)

  console.log('account client tests passed')
} finally {
  globalThis.fetch = originalFetch
  fs.rmSync(tempDir, { recursive: true, force: true })
}
