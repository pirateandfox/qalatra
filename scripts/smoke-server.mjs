#!/usr/bin/env node
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(() => port ? resolve(port) : reject(new Error('No free port found')))
    })
    server.on('error', reject)
  })
}

async function waitForJson(url, options = {}, attempts = 80) {
  let lastError = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, options)
      const data = await res.json().catch(() => ({}))
      return { res, data }
    } catch (e) {
      lastError = e
      await new Promise(resolve => setTimeout(resolve, 125))
    }
  }
  throw lastError || new Error(`Timed out waiting for ${url}`)
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-smoke-'))
  const apiPort = await freePort()
  const mcpPort = await freePort()
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      QALATRA_DATA_DIR: dataDir,
      QALATRA_API_HOST: '127.0.0.1',
      QALATRA_API_PORT: String(apiPort),
      QALATRA_MCP_HOST: '127.0.0.1',
      QALATRA_MCP_PORT: String(mcpPort),
      QALATRA_START_MCP: '0',
      QALATRA_START_WORKERS: '0',
      QALATRA_BACKUP_ON_SHUTDOWN: '0',
      QALATRA_BOOTSTRAP_TOKEN_FILE: '1',
    },
  })

  let output = ''
  let childExit = null
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })
  child.once('exit', (code, signal) => { childExit = { code, signal } })

  try {
    const health = await waitForJson(`http://127.0.0.1:${apiPort}/health`)
    if (!health.res.ok || health.data.ok !== true) throw new Error(`Health check failed: ${health.res.status}`)

    // Unauthenticated static shells the mobile WebView loads. They run BEFORE auth,
    // so a route-level error (e.g. a missing import) crashes the whole process —
    // exactly the 1.9.13 regression. Hit them so that fails the smoke, not the fleet.
    for (const route of ['/terminal', '/mdpdf']) {
      const res = await fetch(`http://127.0.0.1:${apiPort}${route}`)
      if (res.status !== 200) throw new Error(`${route} expected 200, got ${res.status}`)
    }

    const tokenPath = path.join(dataDir, 'admin-token.txt')
    const token = fs.readFileSync(tokenPath, 'utf8').trim()
    if (!token.startsWith('qalatra_')) throw new Error('Bootstrap token was not written')

    const instance = await waitForJson(`http://127.0.0.1:${apiPort}/api/instance`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!instance.res.ok || instance.data.ok !== true) throw new Error(`Authenticated API check failed: ${instance.res.status}`)

    const created = await fetch(`http://127.0.0.1:${apiPort}/api/tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Smoke token', scopes: 'full_access', expiresInDays: 1 }),
    }).then(async res => ({ res, data: await res.json().catch(() => ({})) }))
    if (!created.res.ok || !created.data.token?.expires_at) throw new Error('Expiring token creation failed')

    const rpc = await fetch(`http://127.0.0.1:${apiPort}/api/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'tasks:get' }),
    })
    if (rpc.status !== 404) throw new Error(`/api/rpc expected 404, got ${rpc.status}`)

    const authJson = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    // C16: PATCH/DELETE of a nonexistent task must be 404, not 200 { ok:true }.
    const patchMissing = await fetch(`http://127.0.0.1:${apiPort}/api/v1/tasks/does-not-exist`, {
      method: 'PATCH', headers: authJson, body: JSON.stringify({ title: 'x' }),
    })
    if (patchMissing.status !== 404) throw new Error(`PATCH missing task expected 404, got ${patchMissing.status}`)
    const deleteMissing = await fetch(`http://127.0.0.1:${apiPort}/api/v1/tasks/does-not-exist`, {
      method: 'DELETE', headers: authJson,
    })
    if (deleteMissing.status !== 404) throw new Error(`DELETE missing task expected 404, got ${deleteMissing.status}`)

    // C17: validation errors must be 4xx, not 500.
    const badCreate = await fetch(`http://127.0.0.1:${apiPort}/api/v1/tasks`, {
      method: 'POST', headers: authJson, body: JSON.stringify({}),
    })
    if (badCreate.status !== 400) throw new Error(`POST task with no title expected 400, got ${badCreate.status}`)
    const badPort = await fetch(`http://127.0.0.1:${apiPort}/api/v1/mcp`, {
      method: 'PUT', headers: authJson, body: JSON.stringify({ port: 999999 }),
    })
    if (badPort.status !== 400) throw new Error(`PUT mcp bad port expected 400, got ${badPort.status}`)
    const badSettings = await fetch(`http://127.0.0.1:${apiPort}/api/v1/settings/import`, {
      method: 'POST', headers: authJson, body: JSON.stringify({ json: 'not json' }),
    })
    if (badSettings.status !== 400) throw new Error(`POST settings/import bad json expected 400, got ${badSettings.status}`)

    // Sanity: a valid create still returns 200, and DELETE of a real task is 200 — the latter
    // exercises deleteTask's sync_log path with MCP disabled (bug C19: db-worker must create
    // sync_log itself, else this throws 'no such table').
    const goodCreate = await fetch(`http://127.0.0.1:${apiPort}/api/v1/tasks`, {
      method: 'POST', headers: authJson, body: JSON.stringify({ title: 'smoke task' }),
    }).then(async r => ({ res: r, data: await r.json().catch(() => ({})) }))
    if (!goodCreate.res.ok || !goodCreate.data.task?.id) throw new Error('valid task create failed')

    // C26: GET a nonexistent task must be 404, not 200 { task:null }.
    const getMissing = await fetch(`http://127.0.0.1:${apiPort}/api/v1/tasks/does-not-exist`, { headers: authJson })
    if (getMissing.status !== 404) throw new Error(`GET missing task expected 404, got ${getMissing.status}`)

    // C25: snooze with no `until` must be 400, not a 500 null-deref.
    const badSnooze = await fetch(`http://127.0.0.1:${apiPort}/api/v1/tasks/${goodCreate.data.task.id}/actions/snooze`, {
      method: 'POST', headers: authJson, body: JSON.stringify({}),
    })
    if (badSnooze.status !== 400) throw new Error(`snooze with no until expected 400, got ${badSnooze.status}`)

    const delReal = await fetch(`http://127.0.0.1:${apiPort}/api/v1/tasks/${goodCreate.data.task.id}`, {
      method: 'DELETE', headers: authJson,
    })
    if (delReal.status !== 200) throw new Error(`DELETE real task expected 200, got ${delReal.status}`)

    console.log(`Server smoke passed on port ${apiPort}`)
  } catch (e) {
    console.error(output)
    if (childExit) console.error(`Server process exited early: code=${childExit.code} signal=${childExit.signal}`)
    throw e
  } finally {
    if (!childExit) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
