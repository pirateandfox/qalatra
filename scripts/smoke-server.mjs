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
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })

  try {
    const health = await waitForJson(`http://127.0.0.1:${apiPort}/health`)
    if (!health.res.ok || health.data.ok !== true) throw new Error(`Health check failed: ${health.res.status}`)

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

    console.log(`Server smoke passed on port ${apiPort}`)
  } catch (e) {
    console.error(output)
    throw e
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
