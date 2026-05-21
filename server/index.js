#!/usr/bin/env node
import http from 'http'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dbCall, initDbWorker, closeDbWorker } from './db-client.js'
import { defaultDataDir, ensureDataDir, settingsPath } from './paths.js'
import { initSettings, loadSettings, saveSettings } from './settings.js'
import { authenticate, createToken, ensureBootstrapToken, initAuth, listTokens, requireScope, revokeToken } from './auth.js'
import { deleteAttachment, listAttachments, readAttachmentContent, uploadAttachment } from './attachments.js'
import { runBackup } from './backups.js'
import { fileExists, findInheritedStyle, mimeTypeForPath, readTextFile, resolveAllowedPath, writeFolderStyle, writeTextFile, writeUserStyle } from './files.js'
import { handleV1 } from './v1.js'
import { startBackgroundWorkers } from './workers.js'

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

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
  res.end(JSON.stringify(body))
}

function sendBinary(res, status, buffer, mimeType, filename) {
  const headers = {
    'Content-Type': mimeType || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
  if (filename) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
  res.writeHead(status, headers)
  res.end(buffer)
}

function streamFile(req, res, filePath) {
  const stat = fs.statSync(filePath)
  const mimeType = mimeTypeForPath(filePath)
  const baseHeaders = {
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
  }
  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1
      if (start <= end && end < stat.size) {
        res.writeHead(206, {
          ...baseHeaders,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        })
        fs.createReadStream(filePath, { start, end }).pipe(res)
        return
      }
    }
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size })
  fs.createReadStream(filePath).pipe(res)
}

function publishEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of eventClients) {
    try { res.write(payload) } catch {}
  }
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      if (!data.trim()) return resolve({})
      try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

async function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => { chunks.push(chunk) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
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
  if (START_WORKERS) {
    startBackgroundWorkers(ctx)
    backupTimer = setInterval(() => {
      runBackup(ctx).catch(e => console.error('[backup] scheduled backup failed:', e.message))
    }, 60 * 60 * 1000)
  }
  startMcpServer()

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
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
      sendJson(res, 500, { error: e.message })
    }
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
