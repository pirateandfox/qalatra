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
  const output = result.outputText.replace(/from ["']\.\/(\w[\w-]*)["']/g, 'from "./$1.js"')
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
  compile('emitter.ts', 'emitter.js')
  compile('account.ts', 'account.js')
  compile('account-access.ts', 'account-access.js')

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

  // The API returns one record per plan/pool. A canceled record must not hide a valid seat.
  secure.setItem('qalatra.account.token', 'account-jwt')
  queued.push(response({ data: { entitlements: [
    { productKey: 'connect', active: false, hasSeat: false },
    { productKey: 'connect', active: true, hasSeat: true },
  ] } }))
  assert.equal((await account.getAccountEntitlement()).active, true)
  assert.match(calls.at(-1).body.query, /accountEntitlements/)

  const { createAccountAccessController, ACCOUNT_OUTAGE_GRACE_MS } = await import(pathToFileURL(path.join(tempDir, 'account-access.js')).href)
  let token = 'first'
  let now = 1000
  let result = { productKey: 'connect', active: true, hasSeat: true }
  let failure = null
  let resolvePending
  let delayed = false
  const controller = createAccountAccessController({
    token: () => token,
    now: () => now,
    hydrate: async () => {},
    onChange: () => () => {},
    entitlement: async () => {
      if (delayed) return new Promise(resolve => { resolvePending = resolve })
      if (failure) throw failure
      return result
    },
  })
  await controller.check()
  assert.equal(controller.getSnapshot().status, 'licensed')
  failure = new account.AccountServiceError('offline', true)
  now += ACCOUNT_OUTAGE_GRACE_MS - 1
  await controller.check()
  assert.equal(controller.getSnapshot().status, 'licensed', 'brief outages preserve an existing session')
  now += 1
  await controller.check()
  assert.equal(controller.getSnapshot().status, 'error', 'outages cannot extend access indefinitely')
  failure = null
  await controller.check()
  result = { ...result, active: false }
  await controller.check()
  assert.equal(controller.getSnapshot().status, 'unlicensed', 'revocation never receives outage grace')
  result = { ...result, active: true }
  delayed = true
  const oldCheck = controller.check()
  token = null
  await controller.check()
  resolvePending(result)
  await oldCheck
  assert.equal(controller.getSnapshot().status, 'login', 'a stale response cannot undo sign-out')
  delayed = false
  token = 'second'
  failure = new account.AccountServiceError('offline', true)
  await controller.check()
  assert.equal(controller.getSnapshot().status, 'error', 'a new account cannot inherit outage grace')
  failure = null
  await controller.check()
  failure = new account.AccountServiceError('forbidden')
  await controller.check()
  assert.equal(controller.getSnapshot().status, 'error', 'definitive API errors fail closed')

  // Grace expires on its own, even between regular polling ticks.
  failure = null
  await controller.check()
  now += ACCOUNT_OUTAGE_GRACE_MS - 10
  failure = new account.AccountServiceError('offline', true)
  await controller.check()
  assert.equal(controller.getSnapshot().status, 'licensed')
  now += 10
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(controller.getSnapshot().status, 'error', 'outage grace has an independent deadline')

  // An unauthorized response for an old credential must not sign out a newer session.
  const pendingRequest = new Promise(resolve => { resolvePending = resolve })
  globalThis.fetch = () => pendingRequest
  const stale = account.getAccountEntitlement()
  secure.setItem('qalatra.account.token', 'new-session')
  resolvePending(response({ errors: [{ message: 'Unauthorized' }] }, 401))
  await assert.rejects(stale)
  assert.equal(account.getAccountToken(), 'new-session')

  // Exercise the real native adapter against SecureStore's documented key restrictions.
  fs.writeFileSync(path.join(tempDir, 'async-storage.js'), `export default {
    setItem: async () => {}, removeItem: async () => {}, multiGet: async keys => keys.map(key => [key, null]),
  }`)
  fs.writeFileSync(path.join(tempDir, 'secure-store.js'), `
    export const values = new Map();
    function validate(key) { if (!/^[\\w.-]+$/.test(key)) throw new Error('Invalid SecureStore key'); }
    export async function getItemAsync(key) { validate(key); return values.get(key) ?? null; }
    export async function setItemAsync(key, value) { validate(key); values.set(key, value); }
    export async function deleteItemAsync(key) { validate(key); values.delete(key); }
  `)
  const nativeSource = fs.readFileSync(path.join(ROOT, 'mobile/src/platform.native.ts'), 'utf8')
  const nativeOutput = ts.transpileModule(nativeSource, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText.replaceAll('@qalatra/shared', './platform.js')
    .replaceAll('@react-native-async-storage/async-storage', './async-storage.js')
    .replaceAll('expo-secure-store', './secure-store.js')
  fs.writeFileSync(path.join(tempDir, 'native.js'), nativeOutput)
  await import(pathToFileURL(path.join(tempDir, 'native.js')).href)
  await account.hydrateAccount()
  platform.getPlatform().secure.setItem('qalatra.account.token', 'device-session')
  const nativeStorage = await import(pathToFileURL(path.join(tempDir, 'secure-store.js')).href)
  assert.equal([...nativeStorage.values.values()][0], 'device-session')
  account.clearAccountToken()
  assert.equal(nativeStorage.values.size, 0)

  console.log('account client, native credential storage, and access lifecycle tests passed')
} finally {
  globalThis.fetch = originalFetch
  fs.rmSync(tempDir, { recursive: true, force: true })
}
