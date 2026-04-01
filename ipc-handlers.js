// ipc-handlers.js — IPC handler registration. All SQLite runs in db-worker.js (Worker thread).

import { ipcMain, shell, BrowserWindow } from 'electron'
import { Worker } from 'worker_threads'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { getS3Client, uploadToS3, deleteFromS3, getPresignedUrl } from './s3.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json')

// ── DB Worker ─────────────────────────────────────────────────────────────────

let _worker = null
let _pending = new Map()
let _seq = 0

export async function initDbWorker(dbDir) {
  fs.mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, 'tasks.db')
  console.log('[ipc] openDb:', dbPath)
  _worker = new Worker(path.join(__dirname, 'db-worker.js'), { workerData: { dbPath } })
  _worker.on('message', ({ ready, id, result, error }) => {
    if (ready) return
    const p = _pending.get(id)
    if (!p) return
    _pending.delete(id)
    error ? p.reject(new Error(error)) : p.resolve(result)
  })
  _worker.on('error', err => console.error('[db-worker] error:', err.message))
  _worker.on('exit', code => {
    if (code !== 0) {
      console.error('[db-worker] exited with code', code)
      for (const p of _pending.values()) p.reject(new Error('DB worker crashed'))
      _pending.clear()
    }
  })
  await new Promise((resolve, reject) => {
    _worker.once('message', msg => { if (msg.ready) resolve() })
    _worker.once('error', reject)
  })
  console.log('[ipc] db ready')
}

function dbCall(method, ...args) {
  return new Promise((resolve, reject) => {
    if (!_worker) return reject(new Error('DB worker not initialized'))
    const id = ++_seq
    _pending.set(id, { resolve, reject })
    _worker.postMessage({ id, method, args })
  })
}

// ── Settings ──────────────────────────────────────────────────────────────────

let _settingsFile = null

export function initSettings(dbDir) {
  _settingsFile = path.join(dbDir, 'settings.json')
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(_settingsFile, 'utf8')) } catch { return {} }
}

function saveSettings(data) {
  fs.writeFileSync(_settingsFile, JSON.stringify(data, null, 2))
}

// ── Attachments (non-DB) ──────────────────────────────────────────────────────

const MIME_EXTENSIONS = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'text/plain': '.txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
}
function extFromMime(mime) { return MIME_EXTENSIONS[mime] || '' }

function getAttachmentCacheDir(settings) {
  const raw = settings.attachmentCacheDir || path.join(os.homedir(), 'Library', 'Application Support', 'task-os', 'attachments')
  const dir = raw.replace(/^~/, os.homedir())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function syncPendingAttachments() {
  const settings = loadSettings()
  const client = getS3Client(settings)
  const bucket = settings.s3Bucket
  if (!client || !bucket) return { synced: 0, failed: 0 }
  const pending = await dbCall('getPendingAttachments')
  let synced = 0, failed = 0
  for (const att of pending) {
    if (!fs.existsSync(att.local_path)) { failed++; continue }
    try {
      const buffer = fs.readFileSync(att.local_path)
      const ext = path.extname(att.filename)
      const key = `attachments/${att.task_id}/${att.id}${ext}`
      await uploadToS3(client, bucket, key, buffer, att.mimetype)
      const url = settings.s3PublicUrl ? `${settings.s3PublicUrl.replace(/\/$/, '')}/${key}` : null
      await dbCall('updateAttachmentStorage', att.id, bucket, key, url)
      synced++
    } catch { failed++ }
  }
  return { synced, failed, total: pending.length }
}

// ── Agent scanner ─────────────────────────────────────────────────────────────

async function scanAgents(root) {
  const agents = []
  if (!root) return agents
  try { await fs.promises.access(root) } catch { return agents }
  async function walk(dir) {
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = path.join(dir, entry.name)
      const configPath = path.join(fullPath, 'agent.config')
      try {
        await fs.promises.access(configPath)
        const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
        agents.push({ name: config.name ?? entry.name, description: config.description ?? null, command: config.command ?? null, path: fullPath, relativePath: path.relative(root, fullPath) })
      } catch {}
      await walk(fullPath)
    }
  }
  await walk(root)
  return agents
}

// ── Agent job runner ──────────────────────────────────────────────────────────

const MAX_CONCURRENT_JOBS = 3
let runningJobs = 0

async function processAgentJobs() {
  if (runningJobs >= MAX_CONCURRENT_JOBS) return
  const slots = MAX_CONCURRENT_JOBS - runningJobs
  const jobs = await dbCall('getQueuedJobs', slots)
  const settings = loadSettings()
  for (const job of jobs) {
    runningJobs++
    await dbCall('startAgentJob', job.id)
    let agentCommand = settings.defaultAgentCommand || 'claude --dangerously-skip-permissions'
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(job.agent_path, 'agent.config'), 'utf8'))
      if (cfg.command) agentCommand = cfg.command
    } catch {}
    const parts = agentCommand.trim().split(/\s+/)
    const bin = parts[0]; const baseArgs = parts.slice(1)
    const args = job.prevSessionId
      ? [...baseArgs, '--resume', job.prevSessionId, '-p', job.user_message || job.prompt, '--output-format', 'json']
      : [...baseArgs, '-p', job.prompt, '--output-format', 'json']
    let stdout = '', stderr = '', timedOut = false, settled = false
    // On Windows, spawn the binary directly with shell:true (uses cmd.exe, resolves PATH).
    // On Unix, use a login shell with the "$@" pattern so the prompt is passed as a proper
    // argument rather than interpolated into the shell command (safe for multi-line prompts).
    const proc = process.platform === 'win32'
      ? spawn(bin, args, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
      : spawn(process.env.SHELL || '/bin/zsh', ['-l', '-c', `${bin} "$@"`, '--', ...args], { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const timeout = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, 15 * 60 * 1000)
    proc.on('close', async code => {
      if (settled) return
      settled = true
      clearTimeout(timeout); runningJobs--
      let result = stdout.trim(); let sessionId = null
      try { const p = JSON.parse(stdout); result = p.result ?? result; sessionId = p.session_id ?? null } catch {}
      const status = code === 0 ? 'done' : 'failed'
      if (!result) result = timedOut ? `Agent timed out.${stderr.trim() ? '\n\nStderr:\n' + stderr.trim() : ''}` : (stderr.trim() || `No output (exit code ${code})`)
      else if (status === 'failed' && stderr.trim()) result += `\n\nStderr:\n${stderr.trim()}`
      await dbCall('finishAgentJob', job.id, status, result, sessionId)
      if (status === 'done' && job.task_id) await dbCall('insertAgentNote', uuidv4(), job.task_id, result, job.id)
      BrowserWindow.getAllWindows()[0]?.webContents.send('agent-job:complete', { taskId: job.task_id, jobId: job.id })
    })
    proc.on('error', async err => {
      if (settled) return
      settled = true
      clearTimeout(timeout); runningJobs--
      await dbCall('finishAgentJob', job.id, 'failed', `Failed to start agent: ${err.message}\n\nCommand: ${bin} ${args.slice(0,2).join(' ')} ...\nCheck that the agent command is correct in Settings.`, null)
    })
  }
}

async function autoRunAgents() {
  const tasks = await dbCall('getAutorunTasks')
  for (const task of tasks) {
    const prompt = [task.title, task.description].filter(Boolean).join('\n')
    await dbCall('insertAutorunJob', task.id, task.agent_path, prompt)
  }
}

// ── Background workers ────────────────────────────────────────────────────────

export function startBackgroundWorkers() {
  dbCall('resetStuckJobs').catch(() => {})
  syncPendingAttachments().catch(() => {})
  setInterval(() => syncPendingAttachments().catch(() => {}), 5 * 60 * 1000)
  setInterval(() => processAgentJobs().catch(() => {}), 30_000)
  setInterval(() => autoRunAgents().catch(() => {}), 5 * 60_000)
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

export function setupIpcHandlers(onMcpPortChange) {
  // Tasks
  ipcMain.handle('tasks:list', (_, date) => {
    const d = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : new Date().toISOString().slice(0, 10)
    return dbCall('getTasksForDate', d)
  })
  ipcMain.handle('task:get', (_, id) => dbCall('getTask', id).then(t => { if (!t) throw new Error('Task not found'); return t }))
  ipcMain.handle('task:subtasks', (_, id) => dbCall('getSubtasks', id))
  ipcMain.handle('task:backlog', () => dbCall('getBacklog'))
  ipcMain.handle('task:create', (_, body) => dbCall('createTask', body))
  ipcMain.handle('task:update', (_, id, body) => dbCall('updateTask', id, body))
  ipcMain.handle('task:delete', (_, id) => dbCall('deleteTask', id))
  ipcMain.handle('task:complete', (_, id) => dbCall('completeTask', id))
  ipcMain.handle('task:complete-with-subtasks', (_, id) => dbCall('completeTaskWithSubtasks', id))
  ipcMain.handle('task:uncomplete', (_, id) => dbCall('uncompleteTask', id))
  ipcMain.handle('task:skip', (_, id) => dbCall('skipTask', id))
  ipcMain.handle('task:activate', (_, id) => dbCall('activateTask', id))
  ipcMain.handle('task:snooze', (_, id, until) => dbCall('snoozeTask', id, until))
  ipcMain.handle('task:update-title', (_, id, title) => dbCall('updateTaskTitle', id, title))
  ipcMain.handle('task:update-description', (_, id, description) => dbCall('updateTaskDescription', id, description))
  ipcMain.handle('task:update-due-date', (_, id, dueDate) => dbCall('updateTaskDueDate', id, dueDate))
  ipcMain.handle('task:update-recurrence', (_, id, recurrence) => dbCall('updateTaskRecurrence', id, recurrence))
  ipcMain.handle('task:add-link', (_, id, url) => dbCall('addTaskLink', id, url))
  ipcMain.handle('task:reorder', (_, ids) => dbCall('reorderTasks', ids))
  ipcMain.handle('task:create-subtask', (_, parentId, title) => dbCall('createSubtask', parentId, title))

  // Notes
  ipcMain.handle('notes:list', (_, taskId) => dbCall('listNotes', taskId))
  ipcMain.handle('notes:add', (_, taskId, body) => dbCall('addNote', taskId, body))

  // Daily notes
  ipcMain.handle('daily-note:get', (_, date) => dbCall('getDailyNote', date))
  ipcMain.handle('daily-note:save', (_, date, content) => dbCall('saveDailyNote', date, content))

  // Contexts
  ipcMain.handle('contexts:list', () => dbCall('listContexts'))
  ipcMain.handle('contexts:create', (_, slug, label, color) => dbCall('createContext', slug, label, color))
  ipcMain.handle('contexts:update', (_, slug, fields) => dbCall('updateContext', slug, fields))
  ipcMain.handle('contexts:delete', (_, slug) => dbCall('deleteContext', slug))

  // Projects
  ipcMain.handle('projects:list', (_, includeArchived) => dbCall('listProjects', includeArchived))
  ipcMain.handle('projects:archive', (_, name) => dbCall('archiveProject', name))
  ipcMain.handle('projects:unarchive', (_, name) => dbCall('unarchiveProject', name))
  ipcMain.handle('projects:delete', (_, name) => dbCall('deleteProject', name))

  // Habits
  ipcMain.handle('habits:list', (_, date) => dbCall('listHabits', date))
  ipcMain.handle('habits:create', (_, body) => dbCall('createHabit', body))
  ipcMain.handle('habits:log', (_, habitId, date, status, notes) => dbCall('logHabit', habitId, date, status, notes))
  ipcMain.handle('habits:unlog', (_, habitId, date) => dbCall('unlogHabit', habitId, date))

  // Attachments
  ipcMain.handle('attachments:list', async (_, taskId) => {
    const rows = await dbCall('listAttachments', taskId)
    const settings = loadSettings()
    const client = getS3Client(settings)
    return Promise.all(rows.map(async a => {
      if (!a.url && a.bucket && a.key && client) {
        try { a = { ...a, url: await getPresignedUrl(client, a.bucket, a.key) } } catch {}
      }
      return a
    }))
  })
  ipcMain.handle('attachments:upload', async (_, taskId, filename, mimeType, bufferArray) => {
    const settings = loadSettings()
    const cacheDir = getAttachmentCacheDir(settings)
    const client = getS3Client(settings)
    const bucket = settings.s3Bucket || null
    const id = uuidv4()
    const safeExt = path.extname(filename) || extFromMime(mimeType)
    const key = `attachments/${taskId}/${id}${safeExt}`
    const localPath = path.join(cacheDir, `${id}${safeExt}`)
    const buffer = Buffer.from(bufferArray)
    fs.writeFileSync(localPath, buffer)
    let url = null, uploadedBucket = null, uploadedKey = null, warning = null
    if (client && bucket) {
      try {
        await uploadToS3(client, bucket, key, buffer, mimeType)
        uploadedBucket = bucket; uploadedKey = key
        url = settings.s3PublicUrl ? `${settings.s3PublicUrl.replace(/\/$/, '')}/${key}` : null
      } catch { warning = 's3_upload_failed' }
    }
    await dbCall('insertAttachment', { id, taskId, filename, mimeType, sizeBytes: buffer.length, bucket: uploadedBucket, key: uploadedKey, url, localPath })
    return { ok: true, warning, attachment: { id, filename, url, local_path: localPath } }
  })
  ipcMain.handle('attachments:delete', async (_, id) => {
    const att = await dbCall('getAttachment', id)
    if (!att) throw new Error('Attachment not found')
    const settings = loadSettings()
    const client = getS3Client(settings)
    if (client && att.bucket && att.key) { try { await deleteFromS3(client, att.bucket, att.key) } catch {} }
    if (att.local_path && fs.existsSync(att.local_path)) { try { fs.unlinkSync(att.local_path) } catch {} }
    return dbCall('deleteAttachment', id)
  })
  ipcMain.handle('attachments:sync', async () => {
    try { return { ok: true, ...(await syncPendingAttachments()) } } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('attachment:open', async (_, id) => {
    const att = await dbCall('getAttachment', id)
    if (att?.local_path && fs.existsSync(att.local_path)) await shell.openPath(att.local_path)
    return { ok: !!att }
  })

  // Agents
  ipcMain.handle('agents:list', () => {
    const settings = loadSettings()
    return scanAgents(settings.agentsRoot || settings.terminalCwd || process.env.HOME)
  })
  ipcMain.handle('agent-jobs:list', (_, taskId) => dbCall('listAgentJobs', taskId))
  ipcMain.handle('agent-jobs:get', (_, id) => dbCall('getAgentJob', id))
  ipcMain.handle('agent-jobs:create', (_, taskId, userMessage) => dbCall('createAgentJob', taskId, userMessage))

  // Settings
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_, data) => { saveSettings(data); return { ok: true } })

  // MCP
  ipcMain.handle('mcp:status', () => {
    const s = loadSettings()
    const port = parseInt(s.mcpPort ?? '3457', 10)
    let claudeJson = {}
    try { claudeJson = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8')) } catch {}
    const entry = claudeJson.mcpServers?.['task-os']
    const url = `http://localhost:${port}/mcp`
    const isHttpConfigured = (entry?.type === 'http' && entry?.url === url) ||
      (entry?.type === 'stdio' && entry?.args?.includes(url))
    return { port, isHttpConfigured, currentEntry: entry ?? null }
  })
  ipcMain.handle('mcp:apply', (_, port) => {
    const p = parseInt(port, 10)
    if (isNaN(p) || p < 1024 || p > 65535) throw new Error('Invalid port')
    const s = loadSettings(); s.mcpPort = p; saveSettings(s)
    let claudeJson = {}
    try { claudeJson = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8')) } catch {}
    if (!claudeJson.mcpServers) claudeJson.mcpServers = {}
    // Use mcp-remote stdio proxy so task-os works in both interactive and non-interactive
    // (agent subprocess) Claude Code sessions. Direct HTTP type is skipped in -p mode.
    claudeJson.mcpServers['task-os'] = { type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', `http://localhost:${p}/mcp`] }
    fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(claudeJson, null, 2))
    if (onMcpPortChange) onMcpPortChange(p)
    return { ok: true, port: p, url: `http://localhost:${p}/mcp` }
  })

  // S3 test
  ipcMain.handle('s3:test', async (_, creds) => {
    const client = getS3Client({ s3Endpoint: creds.s3Endpoint, s3AccessKey: creds.s3AccessKey, s3SecretKey: creds.s3SecretKey })
    if (!client) return { ok: false, error: 'Missing credentials' }
    try {
      const { HeadBucketCommand } = await import('@aws-sdk/client-s3')
      await client.send(new HeadBucketCommand({ Bucket: creds.s3Bucket }))
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  })

  // File system
  ipcMain.handle('file:exists', (_, filePath) => {
    const allowed = path.join(os.homedir(), 'IdeaProjects')
    if (!filePath.startsWith(allowed)) return false
    return fs.existsSync(filePath)
  })
  ipcMain.handle('file:read', (_, filePath) => {
    const allowed = path.join(os.homedir(), 'IdeaProjects')
    if (!filePath.startsWith(allowed)) throw new Error('Forbidden')
    return fs.readFileSync(filePath, 'utf-8')
  })
  ipcMain.handle('file:write', (_, filePath, contents) => {
    const allowed = path.join(os.homedir(), 'IdeaProjects')
    if (!filePath.startsWith(allowed)) throw new Error('Forbidden')
    if (typeof contents !== 'string') throw new Error('contents must be string')
    fs.writeFileSync(filePath, contents, 'utf-8')
    return { ok: true }
  })

  console.log('[ipc] handlers registered')
}
