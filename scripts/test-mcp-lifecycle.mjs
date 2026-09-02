#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      err => { clearTimeout(timer); reject(err) },
    )
  })
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()))
}

async function freePort() {
  const server = net.createServer()
  const port = await listen(server)
  await closeServer(server)
  return port
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForHealth(port, predicate, timeoutMs = 10_000) {
  let last = null
  await waitUntil(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      const data = await res.json()
      last = { res, data }
      return predicate(last)
    } catch {
      return false
    }
  }, timeoutMs, `health predicate on port ${port}`)
  return last
}

function startQalatra({ dataDir, apiPort, mcpPort, env = {} }) {
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
      QALATRA_START_MCP: '1',
      QALATRA_START_WORKERS: '0',
      QALATRA_BACKUP_ON_SHUTDOWN: '0',
      QALATRA_BOOTSTRAP_TOKEN_FILE: '1',
      QALATRA_MCP_RESTART_BASE_MS: '50',
      ...env,
    },
  })

  let output = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  return { child, exited, output: () => output }
}

async function stopQalatra(run) {
  if (run.child.exitCode !== null || run.child.signalCode !== null) return
  try { run.child.kill('SIGTERM') } catch {}
  try {
    await withTimeout(run.exited, 3_000, 'Qalatra server shutdown')
  } catch {
    try { run.child.kill('SIGKILL') } catch {}
    await withTimeout(run.exited, 3_000, 'forced Qalatra server shutdown')
  }
}

async function assertPortCanBind(port) {
  const probe = net.createServer()
  try {
    await listen(probe, port)
  } finally {
    if (probe.listening) await closeServer(probe)
  }
}

async function withDataDir(name, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `qalatra-${name}-`))
  try {
    await fn(dataDir)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

async function testParentSigkillReleasesMcp() {
  await withDataDir('mcp-parent-death', async dataDir => {
    const apiPort = await freePort()
    const mcpPort = await freePort()
    const run = startQalatra({ dataDir, apiPort, mcpPort })
    let mcpPid = null
    try {
      const health = await waitForHealth(apiPort, ({ res, data }) => res.status === 200 && data.mcp?.ready === true)
      mcpPid = health.data.mcp.pid
      assert.equal(health.data.mcp.status, 'ready')
      assert.ok(Number.isInteger(mcpPid) && mcpPid > 1, 'health must identify the ready MCP child')

      run.child.kill('SIGKILL')
      const parentExit = await withTimeout(run.exited, 3_000, 'SIGKILLed parent exit')
      assert.equal(parentExit.signal, 'SIGKILL')
      await waitUntil(() => !processIsAlive(mcpPid), 3_000, `MCP child ${mcpPid} to exit after IPC disconnect`)
      await assertPortCanBind(mcpPort)
    } catch (err) {
      throw new Error(`${err.message}\n${run.output()}`)
    } finally {
      await stopQalatra(run)
      if (mcpPid && processIsAlive(mcpPid)) {
        try { process.kill(mcpPid, 'SIGKILL') } catch {}
      }
    }
  })
}

async function testApiLockPrecedesMcpSpawn() {
  await withDataDir('api-lock', async dataDir => {
    const apiBlocker = net.createServer()
    const apiPort = await listen(apiBlocker)
    const mcpPort = await freePort()
    const run = startQalatra({ dataDir, apiPort, mcpPort })
    try {
      // A loaded CI runner can spend more than 500 ms opening the DB worker before listen() reaches
      // EADDRINUSE. Wait for the behavior under test instead of racing startup with a fixed sleep.
      await waitUntil(() => /API port .* in use/.test(run.output()), 5_000, 'API-port retry log')
      assert.equal(run.child.exitCode, null, `losing API process should remain in its existing retry path\n${run.output()}`)
      await assertPortCanBind(mcpPort)
      assert.match(run.output(), /API port .* in use/)
      assert.doesNotMatch(run.output(), /MCP child/)
    } finally {
      await stopQalatra(run)
      await closeServer(apiBlocker)
    }
  })
}

async function testMcpBindFailureIsRedAndBounded() {
  await withDataDir('mcp-bind-failure', async dataDir => {
    const mcpBlocker = net.createServer()
    const mcpPort = await listen(mcpBlocker)
    const apiPort = await freePort()
    const run = startQalatra({
      dataDir,
      apiPort,
      mcpPort,
      env: { QALATRA_MCP_START_FAILURE_LIMIT: '2', QALATRA_MCP_RESTART_BASE_MS: '250' },
    })
    try {
      const health = await waitForHealth(apiPort, ({ res, data }) => res.status === 503 && data.ok === false && data.mcp?.ready === false)
      assert.notEqual(health.data.mcp.status, 'ready')
      const parentExit = await withTimeout(run.exited, 5_000, 'parent to fail after bounded MCP bind attempts')
      assert.equal(parentExit.code, 1, run.output())
      assert.match(run.output(), /giving up after 2 attempts/)
      await assertPortCanBind(apiPort)
    } catch (err) {
      throw new Error(`${err.message}\n${run.output()}`)
    } finally {
      await stopQalatra(run)
      await closeServer(mcpBlocker)
    }
  })
}

async function testGracefulShutdownReapsMcp() {
  await withDataDir('mcp-graceful-stop', async dataDir => {
    const apiPort = await freePort()
    const mcpPort = await freePort()
    const run = startQalatra({ dataDir, apiPort, mcpPort })
    let mcpPid = null
    try {
      const health = await waitForHealth(apiPort, ({ res, data }) => res.status === 200 && data.mcp?.ready === true)
      mcpPid = health.data.mcp.pid
      run.child.kill('SIGTERM')
      const parentExit = await withTimeout(run.exited, 5_000, 'graceful parent exit')
      assert.equal(parentExit.code, 0, run.output())
      await waitUntil(() => !processIsAlive(mcpPid), 3_000, `MCP child ${mcpPid} to exit on graceful shutdown`)
      await assertPortCanBind(mcpPort)
    } catch (err) {
      throw new Error(`${err.message}\n${run.output()}`)
    } finally {
      await stopQalatra(run)
      if (mcpPid && processIsAlive(mcpPid)) {
        try { process.kill(mcpPid, 'SIGKILL') } catch {}
      }
    }
  })
}

await testParentSigkillReleasesMcp()
await testApiLockPrecedesMcpSpawn()
await testMcpBindFailureIsRedAndBounded()
await testGracefulShutdownReapsMcp()
console.log('MCP lifecycle tests passed')
