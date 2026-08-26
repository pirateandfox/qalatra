#!/usr/bin/env node
import http from 'http'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import { dbCall, initDbWorker, closeDbWorker } from './db-client.js'
import { defaultDataDir, ensureDataDir, settingsPath } from './paths.js'
import { initSettings, loadSettings, saveSettings } from './settings.js'
import { authenticate, createToken, ensureBootstrapToken, initAuth, listTokens, requireScope, revokeToken } from './auth.js'
import { deleteAttachment, listAttachments, readAttachmentContent, uploadAttachment } from './attachments.js'
import { applyPendingRestore, runBackup } from './backups.js'
import { fileExists, findInheritedStyle, listDirectory, listWorkspaceRoots, readTextFile, resolveAllowedPath, writeFolderStyle, writeTextFile, writeUserStyle } from './files.js'
import { applyCors, parseBody, parseRawBody, sendBinary, sendJson, streamFile } from './http.js'
import { handleV1 } from './v1.js'
import { startBackgroundWorkers } from './workers.js'
import { createTerminalManager } from './terminal-sessions.js'
import { createBoxWebProxy } from './box-web.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_DIR = ensureDataDir(defaultDataDir())
const SETTINGS_FILE = settingsPath(DATA_DIR)
const DB_PATH = path.join(DATA_DIR, 'tasks.db')
const API_PORT = parseInt(process.env.QALATRA_API_PORT || process.env.PORT || '3456', 10)
const API_HOST = process.env.QALATRA_API_HOST || '127.0.0.1'
const START_MCP = process.env.QALATRA_START_MCP !== '0'
const START_WORKERS = process.env.QALATRA_START_WORKERS !== '0'
const BACKUP_ON_SHUTDOWN = process.env.QALATRA_BACKUP_ON_SHUTDOWN !== '0'
const SERVER_STARTED_AT = new Date().toISOString()
const MCP_RESTART_BASE_MS = Math.max(50, parseInt(process.env.QALATRA_MCP_RESTART_BASE_MS || '500', 10) || 500)
const MCP_START_FAILURE_LIMIT = Math.max(1, parseInt(process.env.QALATRA_MCP_START_FAILURE_LIMIT || '5', 10) || 5)

let mcpProcess = null
let mcpRestartTimer = null
let mcpReady = false
let mcpStatus = START_MCP ? 'pending' : 'disabled'
let mcpLastError = null
let mcpRestartCount = 0
let mcpConsecutiveStartFailures = 0
let backupTimer = null
let shuttingDown = false
const eventClients = new Set()

function crashLogPath() {
  return path.join(DATA_DIR, 'server-crash.log')
}

function formatError(value) {
  if (value instanceof Error) return value.stack || value.message
  return String(value)
}

function logProcessProblem(label, value) {
  const message = `[${new Date().toISOString()}] ${label}: ${formatError(value)}\n`
  console.error(message.trim())
  try { fs.appendFileSync(crashLogPath(), message) } catch {}
}

process.on('unhandledRejection', reason => {
  logProcessProblem('unhandledRejection', reason)
})

process.on('uncaughtException', err => {
  logProcessProblem('uncaughtException', err)
  process.exit(1)
})

function publishEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of eventClients) {
    try { res.write(payload) } catch {}
  }
}

function mcpHealth() {
  return {
    configured: START_MCP,
    started: !!mcpProcess && mcpProcess.exitCode === null,
    ready: mcpReady,
    status: mcpStatus,
    pid: mcpProcess?.pid ?? null,
    restart_count: mcpRestartCount,
    consecutive_start_failures: mcpConsecutiveStartFailures,
    last_error: mcpLastError,
  }
}

function scheduleMcpRestart() {
  if (shuttingDown || mcpRestartTimer) return
  const exponent = Math.max(0, mcpConsecutiveStartFailures - 1)
  const delay = Math.min(MCP_RESTART_BASE_MS * (2 ** exponent), 30_000)
  mcpStatus = 'restarting'
  mcpRestartCount += 1
  console.error(`[server] restarting MCP in ${delay}ms (attempt ${mcpConsecutiveStartFailures + 1}/${MCP_START_FAILURE_LIMIT})`)
  mcpRestartTimer = setTimeout(() => {
    mcpRestartTimer = null
    startMcpServer()
  }, delay)
}

function startMcpServer() {
  if (!START_MCP || shuttingDown || mcpProcess || mcpRestartTimer) return
  const entry = path.join(ROOT, 'mcp', 'http-server-entry.cjs')
  const env = {
    ...process.env,
    TASKOS_DB_DIR: DATA_DIR,
    TASKOS_SETTINGS_FILE: SETTINGS_FILE,
    QALATRA_MCP_HOST: process.env.QALATRA_MCP_HOST || '127.0.0.1',
  }
  mcpReady = false
  mcpStatus = 'starting'
  mcpLastError = null

  const child = spawn(process.execPath, [entry], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env,
  })
  mcpProcess = child
  let becameReady = false
  let reportedFailure = null

  child.on('message', message => {
    if (mcpProcess !== child || !message || typeof message !== 'object') return
    if (message.type === 'qalatra:mcp-ready') {
      becameReady = true
      mcpReady = true
      mcpStatus = 'ready'
      mcpLastError = null
      mcpConsecutiveStartFailures = 0
      console.log(`[server] MCP child ${child.pid} confirmed listening on ${message.host}:${message.port}`)
    } else if (message.type === 'qalatra:mcp-bind-error') {
      reportedFailure = `${message.code || 'bind error'} on ${message.host}:${message.port}`
      mcpLastError = reportedFailure
      mcpStatus = 'failed'
    }
  })

  child.on('error', err => {
    reportedFailure = formatError(err)
    mcpLastError = reportedFailure
    mcpStatus = 'failed'
  })

  child.on('exit', (code, signal) => {
    if (mcpProcess !== child) return
    mcpProcess = null
    mcpReady = false
    if (shuttingDown) {
      mcpStatus = 'stopped'
      return
    }

    const reason = reportedFailure || `exit code=${code} signal=${signal}`
    mcpLastError = reason
    console.error(`[server] MCP child ${child.pid} exited before shutdown: ${reason}`)
    if (!becameReady) mcpConsecutiveStartFailures += 1
    else mcpConsecutiveStartFailures = 0

    if (mcpConsecutiveStartFailures >= MCP_START_FAILURE_LIMIT) {
      mcpStatus = 'failed'
      logProcessProblem('MCP failed to become ready', `${reason}; giving up after ${mcpConsecutiveStartFailures} attempts`)
      process.exit(1)
    }
    scheduleMcpRestart()
  })
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(value)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

async function stopMcpServer() {
  if (mcpRestartTimer) {
    clearTimeout(mcpRestartTimer)
    mcpRestartTimer = null
  }
  mcpReady = false
  const child = mcpProcess
  if (!child) {
    mcpStatus = START_MCP ? 'stopped' : 'disabled'
    return
  }

  mcpStatus = 'stopping'
  try { child.kill('SIGTERM') } catch {}
  let exited = await waitForChildExit(child, 2_000)
  if (!exited && child.connected) {
    try { child.disconnect() } catch {}
    exited = await waitForChildExit(child, 500)
  }
  if (!exited) {
    try { child.kill('SIGKILL') } catch {}
    await waitForChildExit(child, 500)
  }
  if (mcpProcess === child) mcpProcess = null
  mcpStatus = START_MCP ? 'stopped' : 'disabled'
}

async function main() {
  initSettings(SETTINGS_FILE)
  // Apply any pending DB restore BEFORE the worker opens tasks.db (bug C11) — this is the only
  // place it happens on a headless install; the Electron app has its own equivalent at startup.
  const restore = applyPendingRestore(DATA_DIR)
  if (restore.applied) console.log('[server] applied pending DB restore (tasks.db.restore)')
  else if (restore.error) console.error(`[server] pending DB restore failed: ${restore.error}`)
  await initDbWorker(DATA_DIR)
  const authDb = initAuth(DB_PATH)
  const bootstrap = ensureBootstrapToken(authDb, DATA_DIR, {
    forceFile: process.env.QALATRA_BOOTSTRAP_TOKEN_FILE === '1',
    token: process.env.QALATRA_BOOTSTRAP_TOKEN || '',
  })
  if (bootstrap) {
    console.log(`[server] Created initial full_access token at ${bootstrap.tokenPath}`)
  }

  const ctx = { dbCall, loadSettings, saveSettings, dataDir: DATA_DIR, notify: publishEvent, startedAt: SERVER_STARTED_AT }
  const terminalManager = createTerminalManager({ dataDir: DATA_DIR, loadSettings })
  const boxWebProxy = createBoxWebProxy()
  // NOTE: background workers are started only AFTER a successful port bind (in the
  // server.listen callback below). Binding the API port is the single-instance lock: a second
  // process against the same data dir fails EADDRINUSE, never enters the callback, and therefore
  // never runs resetStuckJobs / job processing / heartbeats against jobs the live instance owns
  // (bug C6). Do not move worker startup back before listen.
  const server = http.createServer(async (req, res) => {
    applyCors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const url = new URL(req.url, `http://${req.headers.host || `${API_HOST}:${API_PORT}`}`)

    if (url.pathname === '/health') {
      const mcp = mcpHealth()
      const ok = !START_MCP || mcp.ready
      sendJson(res, ok ? 200 : 503, {
        ok,
        started_at: SERVER_STARTED_AT,
        api: { host: API_HOST, port: API_PORT },
        mcp,
        workers: { started: START_WORKERS },
      })
      return
    }

    if (url.pathname.startsWith('/api/box-web/proxy/')) {
      if (boxWebProxy.handleProxy(req, res, url)) return
    }

    // Markdown editor app shell for the mobile/iPad WebView. Served WITHOUT auth
    // on purpose — it's just static client code; its data calls (/api/files) carry
    // the bearer token the WebView host injects. Same-origin, so those calls work.
    if (url.pathname === '/mdpdf' && req.method === 'GET') {
      const file = path.join(__dirname, 'static', 'mdpdf.html')
      if (fs.existsSync(file)) {
        streamFile(req, res, file, { 'Cache-Control': 'no-store, max-age=0' })
      } else {
        sendJson(res, 404, { error: 'mdpdf editor bundle not built (run npm run build:mdpdf)' })
      }
      return
    }

    // xterm.js terminal app shell for the mobile/iPad WebView. Like /mdpdf it's
    // an unauthenticated static shell; the actual pty WebSocket it opens carries
    // the token in its URL (terminalSocketUrl).
    if (url.pathname === '/terminal' && req.method === 'GET') {
      const file = path.join(__dirname, 'static', 'terminal.html')
      if (fs.existsSync(file)) {
        // Never let the WebView cache the shell — it changes every release, and a
        // stale cached copy means fixes silently never reach the device.
        streamFile(req, res, file, { 'Cache-Control': 'no-store, max-age=0' })
      } else {
        sendJson(res, 404, { error: 'terminal bundle not built (run npm run build:terminal)' })
      }
      return
    }

    const user = authenticate(authDb, req)
    if (!user) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    try {
      if (url.pathname === '/api/instance' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, name: loadSettings().instanceName || 'Qalatra', started_at: SERVER_STARTED_AT })
        return
      }

      if (url.pathname.startsWith('/api/') && !requireScope(user, 'full_access')) {
        sendJson(res, 403, { error: 'Forbidden' })
        return
      }

      if (url.pathname === '/api/box-web/session' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, session: boxWebProxy.createSession() })
        return
      }

      if (url.pathname === '/api/box-web/status' && req.method === 'GET') {
        const status = await boxWebProxy.checkStatus()
        sendJson(res, 200, {
          ok: true,
          available: status.ok,
          target: status.target,
          statusCode: status.statusCode,
          error: status.error,
        })
        return
      }

      if (url.pathname.startsWith('/api/v1')) {
        const response = await handleV1(req, url, ctx, { parseBody })
        if (response) {
          sendJson(res, response.status, response.body)
          return
        }
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        })
        res.write(': connected\n\n')
        eventClients.add(res)
        const keepAlive = setInterval(() => {
          try { res.write(': keep-alive\n\n') } catch {}
        }, 25_000)
        req.on('close', () => {
          clearInterval(keepAlive)
          eventClients.delete(res)
        })
        return
      }

      if (url.pathname === '/api/tokens' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, tokens: listTokens(authDb) })
        return
      }

      if (url.pathname === '/api/tokens' && req.method === 'POST') {
        const body = await parseBody(req)
        sendJson(res, 200, { ok: true, token: createToken(authDb, body) })
        return
      }

      if (url.pathname === '/api/files/exists' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, exists: fileExists(url.searchParams.get('path'), loadSettings()) })
        return
      }

      if (url.pathname === '/api/files' && req.method === 'GET') {
        const filePath = url.searchParams.get('path')
        sendJson(res, 200, { ok: true, path: filePath, content: readTextFile(filePath, loadSettings()) })
        return
      }

      if (url.pathname === '/api/files/content' && req.method === 'GET') {
        streamFile(req, res, resolveAllowedPath(url.searchParams.get('path'), loadSettings()))
        return
      }

      if (url.pathname === '/api/files/list' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...listDirectory(url.searchParams.get('path'), loadSettings()) })
        return
      }

      if (url.pathname === '/api/workspace/roots' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, roots: listWorkspaceRoots(loadSettings()) })
        return
      }

      if (url.pathname === '/api/terminal/status' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, tmux: terminalManager.status() })
        return
      }

      if (url.pathname === '/api/terminal/sessions' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...terminalManager.listSessions() })
        return
      }

      if (url.pathname === '/api/terminal/sessions' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, session: terminalManager.createSession(await parseBody(req)) })
        return
      }

      const terminalSessionMatch = url.pathname.match(/^\/api\/terminal\/sessions\/([^/]+)(?:\/([^/]+))?$/)
      if (terminalSessionMatch) {
        const id = decodeURIComponent(terminalSessionMatch[1])
        const action = terminalSessionMatch[2]
        if (!action && req.method === 'PATCH') {
          sendJson(res, 200, { ok: true, session: terminalManager.updateSession(id, await parseBody(req)) })
          return
        }
        if (!action && req.method === 'DELETE') {
          sendJson(res, 200, terminalManager.killSession(id, { remove: true }))
          return
        }
        if (action === 'kill' && req.method === 'POST') {
          sendJson(res, 200, terminalManager.killSession(id))
          return
        }
        if (action === 'image' && req.method === 'POST') {
          const buffer = await parseRawBody(req)
          sendJson(res, 200, { ok: true, ...terminalManager.saveImage(id, buffer, url.searchParams.get('ext')) })
          return
        }
      }

      if (url.pathname === '/api/attachments' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, attachments: await listAttachments(ctx, url.searchParams.get('taskId')) })
        return
      }

      if (url.pathname === '/api/attachments' && req.method === 'POST') {
        const buffer = await parseRawBody(req)
        sendJson(res, 200, await uploadAttachment(
          ctx,
          url.searchParams.get('taskId'),
          url.searchParams.get('filename'),
          url.searchParams.get('mimeType') || 'application/octet-stream',
          buffer,
        ))
        return
      }

      const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/)
      if (attachmentMatch && req.method === 'DELETE') {
        sendJson(res, 200, await deleteAttachment(ctx, decodeURIComponent(attachmentMatch[1])))
        return
      }

      if (url.pathname === '/api/files' && req.method === 'PUT') {
        const body = await parseBody(req)
        sendJson(res, 200, writeTextFile(url.searchParams.get('path'), body.content, loadSettings()))
        return
      }

      if (url.pathname === '/api/styles/inherited' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, style: findInheritedStyle(url.searchParams.get('dir'), loadSettings()) })
        return
      }

      if (url.pathname === '/api/styles/user' && req.method === 'PUT') {
        const body = await parseBody(req)
        sendJson(res, 200, writeUserStyle(body.content))
        return
      }

      if (url.pathname === '/api/styles/folder' && req.method === 'PUT') {
        const body = await parseBody(req)
        sendJson(res, 200, writeFolderStyle(body.dir, body.content, loadSettings()))
        return
      }

      const attachmentContentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/content$/)
      if (attachmentContentMatch && req.method === 'GET') {
        const { attachment, buffer, mimeType } = await readAttachmentContent(ctx, decodeURIComponent(attachmentContentMatch[1]))
        sendBinary(res, 200, buffer, mimeType, attachment.filename)
        return
      }

      const tokenMatch = url.pathname.match(/^\/api\/tokens\/([^/]+)$/)
      if (tokenMatch && req.method === 'DELETE') {
        sendJson(res, 200, revokeToken(authDb, tokenMatch[1]))
        return
      }

      sendJson(res, 404, { error: 'Not found' })
    } catch (e) {
      sendJson(res, e.status || e.statusCode || 500, { error: e.message })
    }
  })

  const terminalWss = new WebSocketServer({ noServer: true })
  terminalWss.on('error', err => logProcessProblem('terminal websocket server error', err))
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || `${API_HOST}:${API_PORT}`}`)
    const match = url.pathname.match(/^\/api\/terminal\/sessions\/([^/]+)\/socket$/)
    if (!match) {
      socket.destroy()
      return
    }

    const token = url.searchParams.get('token') || ''
    req.headers.authorization = `Bearer ${token}`
    const user = authenticate(authDb, req)
    if (!user || !requireScope(user, 'full_access')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    terminalWss.handleUpgrade(req, socket, head, ws => {
      try {
        terminalManager.attachWebSocket(ws, decodeURIComponent(match[1]), url.searchParams)
      } catch (e) {
        try { ws.send(JSON.stringify({ type: 'error', error: e.message })) } catch {}
        ws.close()
      }
    })
  })

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] API port ${API_PORT} in use; retrying in 30s`)
      setTimeout(() => server.listen(API_PORT, API_HOST), 30_000)
      return
    }
    logProcessProblem('http server error', err)
    process.exit(1)
  })

  server.listen(API_PORT, API_HOST, () => {
    console.log(`[server] API listening on http://${API_HOST}:${API_PORT}`)
    console.log(`[server] data dir: ${DATA_DIR}`)
    // The API port is the single-instance lock. Only the generation that owns it may launch MCP;
    // otherwise a losing API process can leave behind a competing MCP child before it discovers
    // EADDRINUSE on 3456.
    startMcpServer()
    // Start background workers only now that we hold the port (single-instance lock — see note
    // above): a second process fails EADDRINUSE, never enters this callback, and so never runs
    // resetStuckJobs / job processing / heartbeats against the live instance's jobs (bug C6).
    if (START_WORKERS) {
      startBackgroundWorkers(ctx)
      backupTimer = setInterval(() => {
        runBackup(ctx).catch(e => console.error('[backup] scheduled backup failed:', e.message))
      }, 60 * 60 * 1000)
    }
  })

  let shutdownPromise = null
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    shutdownPromise = (async () => {
      if (backupTimer) clearInterval(backupTimer)
      await stopMcpServer()
      if (START_WORKERS && BACKUP_ON_SHUTDOWN) {
        await Promise.race([
          runBackup(ctx).catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 10_000)),
        ])
      }
      terminalManager.close()
      server.close()
      await closeDbWorker()
      process.exit(0)
    })()
    return shutdownPromise
  }
  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}

main().catch(err => {
  console.error('[server] fatal:', err)
  process.exit(1)
})
