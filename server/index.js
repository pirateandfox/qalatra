#!/usr/bin/env node
import http from 'http'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import { dbCall, initDbWorker, closeDbWorker } from './db-client.js'
import { defaultDataDir, ensureDataDir, settingsPath } from './paths.js'
import { initSettings, loadSettings, saveSettings } from './settings.js'
import { authenticate, createToken, ensureBootstrapToken, initAuth, listTokens, requireScope, revokeToken } from './auth.js'
import { deleteAttachment, listAttachments, readAttachmentContent, uploadAttachment } from './attachments.js'
import { runBackup } from './backups.js'
import { fileExists, findInheritedStyle, listDirectory, listWorkspaceRoots, readTextFile, resolveAllowedPath, writeFolderStyle, writeTextFile, writeUserStyle } from './files.js'
import { applyCors, parseBody, parseRawBody, sendBinary, sendJson, streamFile } from './http.js'
import { handleV1 } from './v1.js'
import { startBackgroundWorkers } from './workers.js'
import { createTerminalManager } from './terminal-sessions.js'

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

let mcpProcess = null
let backupTimer = null
const eventClients = new Set()

function publishEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of eventClients) {
    try { res.write(payload) } catch {}
  }
}

function startMcpServer() {
  if (!START_MCP) return
  const entry = path.join(ROOT, 'mcp', 'http-server-entry.cjs')
  const env = {
    ...process.env,
    TASKOS_DB_DIR: DATA_DIR,
    TASKOS_SETTINGS_FILE: SETTINGS_FILE,
    QALATRA_MCP_HOST: process.env.QALATRA_MCP_HOST || '127.0.0.1',
  }
  mcpProcess = spawn(process.execPath, [entry], { stdio: 'inherit', env })
  mcpProcess.on('exit', (code, signal) => {
    if (signal === 'SIGTERM') return
    console.error(`[server] MCP exited code=${code} signal=${signal}; restarting in 2s`)
    setTimeout(startMcpServer, 2000)
  })
}

async function main() {
  initSettings(SETTINGS_FILE)
  await initDbWorker(DATA_DIR)
  const authDb = initAuth(DB_PATH)
  const bootstrap = ensureBootstrapToken(authDb, DATA_DIR, { forceFile: process.env.QALATRA_BOOTSTRAP_TOKEN_FILE === '1' })
  if (bootstrap) {
    console.log(`[server] Created initial full_access token at ${bootstrap.tokenPath}`)
    console.log(`[server] Initial token: ${bootstrap.token}`)
  }

  const ctx = { dbCall, loadSettings, saveSettings, dataDir: DATA_DIR, notify: publishEvent }
  const terminalManager = createTerminalManager({ dataDir: DATA_DIR, loadSettings })
  if (START_WORKERS) {
    startBackgroundWorkers(ctx)
    backupTimer = setInterval(() => {
      runBackup(ctx).catch(e => console.error('[backup] scheduled backup failed:', e.message))
    }, 60 * 60 * 1000)
  }
  startMcpServer()

  const server = http.createServer(async (req, res) => {
    applyCors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const url = new URL(req.url, `http://${req.headers.host || `${API_HOST}:${API_PORT}`}`)

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        started_at: SERVER_STARTED_AT,
        api: { host: API_HOST, port: API_PORT },
        mcp: { started: !!mcpProcess },
        workers: { started: START_WORKERS },
      })
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

  server.listen(API_PORT, API_HOST, () => {
    console.log(`[server] API listening on http://${API_HOST}:${API_PORT}`)
    console.log(`[server] data dir: ${DATA_DIR}`)
  })

  const shutdown = async () => {
    if (backupTimer) clearInterval(backupTimer)
    if (START_WORKERS && BACKUP_ON_SHUTDOWN) {
      await Promise.race([
        runBackup(ctx).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 10_000)),
      ])
    }
    if (mcpProcess) mcpProcess.kill('SIGTERM')
    terminalManager.close()
    server.close()
    await closeDbWorker()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch(err => {
  console.error('[server] fatal:', err)
  process.exit(1)
})
