// ipc-handlers.js — IPC handler registration. All SQLite runs in db-worker.js (Worker thread).

import { ipcMain, shell, BrowserWindow, safeStorage } from 'electron'
import { Worker } from 'worker_threads'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { randomBytes } from 'crypto'
import { getS3Client, getBackupS3Client, uploadToS3, downloadFromS3, deleteFromS3, getPresignedUrl, listS3Objects } from './s3.js'
import { encrypt, decrypt } from './crypto.js'
import Database from 'better-sqlite3'

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

// ── Encryption key management ─────────────────────────────────────────────────

function keystorePath() {
  return path.join(path.dirname(_settingsFile), 'keystore')
}

function loadEncryptionKey() {
  try {
    const encrypted = fs.readFileSync(keystorePath())
    const b64 = safeStorage.decryptString(encrypted)
    return Buffer.from(b64, 'base64')
  } catch { return null }
}

function saveEncryptionKey(keyBuffer) {
  const encrypted = safeStorage.encryptString(keyBuffer.toString('base64'))
  fs.writeFileSync(keystorePath(), encrypted)
}

function generateEncryptionKey() {
  const key = randomBytes(32)
  saveEncryptionKey(key)
  return key
}

// ── DB backup ─────────────────────────────────────────────────────────────────

let _lastBackupTime = null
let _lastBackupStatus = null

export async function runBackup() {
  const key = loadEncryptionKey()
  if (!key) return { ok: false, error: 'No encryption key — generate one in Settings first' }
  const settings = loadSettings()
  const client = getBackupS3Client(settings)
  if (!client) return { ok: false, error: 'Backup bucket not configured' }
  const dbPath = path.join(path.dirname(_settingsFile), 'tasks.db')
  const tmpPath = path.join(os.tmpdir(), `qalatra-backup-${Date.now()}.db`)
  let backupDb
  try {
    backupDb = new Database(dbPath, { readonly: true })
    await backupDb.backup(tmpPath)
    backupDb.close(); backupDb = null
    const plain = fs.readFileSync(tmpPath)
    const enc = encrypt(plain, key)
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const objKey = `db/tasks-${ts}.db.enc`
    await uploadToS3(client, settings.backupBucket, objKey, enc, 'application/octet-stream')
    await pruneOldBackups(client, settings.backupBucket)
    _lastBackupTime = new Date().toISOString()
    _lastBackupStatus = 'ok'
    console.log(`[backup] uploaded ${objKey} (${enc.length} bytes)`)
    return { ok: true, key: objKey, size: enc.length, timestamp: _lastBackupTime }
  } catch (e) {
    _lastBackupStatus = 'failed'
    console.error('[backup] failed:', e.message)
    return { ok: false, error: e.message }
  } finally {
    backupDb?.close()
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

async function pruneOldBackups(client, bucket) {
  try {
    const objects = await listS3Objects(client, bucket, 'db/')
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    for (const obj of objects) {
      if (obj.LastModified && new Date(obj.LastModified) < cutoff) {
        await deleteFromS3(client, bucket, obj.Key).catch(() => {})
        console.log(`[backup] pruned old backup: ${obj.Key}`)
      }
    }
  } catch {}
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
  const raw = settings.attachmentCacheDir || path.join(os.homedir(), 'Library', 'Application Support', 'qalatra', 'attachments')
  const dir = raw.replace(/^~/, os.homedir())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function syncPendingAttachments() {
  const settings = loadSettings()
  const client = getS3Client(settings)
  const bucket = settings.s3Bucket
  if (!client || !bucket) return { synced: 0, failed: 0 }
  const encKey = loadEncryptionKey()
  const pending = await dbCall('getPendingAttachments')
  let synced = 0, failed = 0
  for (const att of pending) {
    if (!fs.existsSync(att.local_path)) { failed++; continue }
    try {
      let buffer = fs.readFileSync(att.local_path)
      const ext = path.extname(att.filename)
      const key = `attachments/${att.task_id}/${att.id}${ext}`
      let encrypted = 0
      if (encKey) { buffer = encrypt(buffer, encKey); encrypted = 1 }
      await uploadToS3(client, bucket, key, buffer, att.mimetype)
      const url = (!encrypted && settings.s3PublicUrl) ? `${settings.s3PublicUrl.replace(/\/$/, '')}/${key}` : null
      await dbCall('updateAttachmentStorage', att.id, bucket, key, url, encrypted)
      synced++
    } catch { failed++ }
  }
  return { synced, failed, total: pending.length }
}

// ── Agent scanner ─────────────────────────────────────────────────────────────

async function scanAgents(root, excludeFolders = []) {
  const agents = []
  if (!root) return agents
  try { await fs.promises.access(root) } catch { return agents }
  const excluded = new Set(excludeFolders.map(f => f.trim()).filter(Boolean))
  async function walk(dir, topLevelFolder) {
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (excluded.has(entry.name)) continue
      const fullPath = path.join(dir, entry.name)
      // Track the top-level subfolder under root so we can label global agents
      const folder = topLevelFolder ?? entry.name
      const configPath = path.join(fullPath, 'agent.config')
      try {
        await fs.promises.access(configPath)
        const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'))
        agents.push({
          name: config.name ?? entry.name,
          context: config.context ?? null,
          project: config.project ?? null,
          description: config.description ?? null,
          command: config.command ?? null,
          coding: config.coding === true,
          path: fullPath,
          relativePath: path.relative(root, fullPath),
          folder,
        })
      } catch {}
      await walk(fullPath, folder)
    }
  }
  await walk(root, null)
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

    // Fail fast if agent_path doesn't exist — spawn would throw synchronously, leaving
    // the job permanently stuck in 'running' with no close/error handler attached.
    if (!fs.existsSync(job.agent_path)) {
      runningJobs--
      await dbCall('finishAgentJob', job.id, 'failed', `Agent path does not exist: ${job.agent_path}\n\nCreate the directory or update the task's agent path.`, null)
      continue
    }

    let agentCommand = settings.defaultAgentCommand || 'claude --dangerously-skip-permissions'
    let cfg = null
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(job.agent_path, 'agent.config'), 'utf8'))
      if (cfg.command) agentCommand = cfg.command
    } catch {}
    if (cfg?.coding && job.task_id) {
      await dbCall('updateTask', job.task_id, { task_type: 'coding' })
    }
    const isTemplateCommand = agentCommand.includes('{spec_file}') || agentCommand.includes('{description}')
    const shellBin = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')

    let stdout = '', stderr = '', timedOut = false, settled = false
    let proc, promptFile = null
    // Declared here so the error handler can reference them regardless of which branch ran.
    let bin = '', spawnArgs = []

    try {
      if (isTemplateCommand) {
        // Template mode: supports {spec_file} and {description} placeholders.
        // Runs the command as a raw shell string so pipes, redirects, etc. work.
        // Does NOT append -p or --output-format json — the command is fully specified.
        let resolvedCommand = agentCommand

        if (agentCommand.includes('{spec_file}')) {
          const specPath = path.join(job.agent_path, 'spec.md')
          fs.writeFileSync(specPath, job.prompt, 'utf8')
          resolvedCommand = resolvedCommand.replace(/\{spec_file\}/g, './spec.md')
        }

        if (agentCommand.includes('{description}') || agentCommand.includes('{title}')) {
          const task = job.task_id ? await dbCall('getTask', job.task_id) : null
          if (agentCommand.includes('{description}')) {
            const description = (task?.description ?? job.user_message ?? '').replace(/\n/g, ' ').replace(/'/g, "\\'")
            resolvedCommand = resolvedCommand.replace(/\{description\}/g, description)
          }
          if (agentCommand.includes('{title}')) {
            const title = (task?.title ?? '').replace(/'/g, "\\'")
            resolvedCommand = resolvedCommand.replace(/\{title\}/g, title)
          }
        }

        bin = shellBin; spawnArgs = ['-i', '-l', '-c', resolvedCommand]
        proc = process.platform === 'win32'
          ? spawn('cmd.exe', ['/c', resolvedCommand], { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'] })
          : spawn(shellBin, ['-i', '-l', '-c', resolvedCommand], { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'] })
      } else {
        // Standard mode: append -p {prompt} --output-format json and use safe arg passing.
        const parts = agentCommand.trim().split(/\s+/)
        bin = parts[0]; const baseArgs = parts.slice(1)

        // On Windows with shell:true, cmd.exe joins args without quoting, so any multi-word
        // prompt passed via -p gets truncated at the first space (Claude only receives "You").
        // Fix: write the full prompt to a temp file and pass a short quoted instruction instead.
        // Temp file is cleaned up after the process exits.
        let promptArg = job.prompt
        if (process.platform === 'win32' && !job.prevSessionId) {
          promptFile = path.join(os.tmpdir(), `taskos-prompt-${job.id}.txt`)
          fs.writeFileSync(promptFile, job.prompt, 'utf8')
          promptArg = `"Read and follow the instructions in the file: ${promptFile}"`
        }

        spawnArgs = job.prevSessionId
          ? [...baseArgs, '--resume', job.prevSessionId, '-p', job.user_message || job.prompt, '--output-format', 'json']
          : [...baseArgs, '-p', promptArg, '--output-format', 'json']

        proc = process.platform === 'win32'
          ? spawn(bin, spawnArgs, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
          : spawn(shellBin, ['-i', '-l', '-c', `${bin} "$@"`, '--', ...spawnArgs], { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'] })
      }
    } catch (spawnErr) {
      runningJobs--
      await dbCall('finishAgentJob', job.id, 'failed', `Failed to start agent: ${spawnErr.message}\n\nCommand: ${bin} ${spawnArgs.slice(0, 2).join(' ')}`, null)
      continue
    }

    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const timeout = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, 15 * 60 * 1000)
    proc.on('close', async code => {
      if (settled) return
      settled = true
      clearTimeout(timeout); runningJobs--
      if (promptFile) { try { fs.unlinkSync(promptFile) } catch {} }
      let result = stdout.trim(); let sessionId = null
      try { const p = JSON.parse(stdout); result = p.result ?? result; sessionId = p.session_id ?? null } catch {}
      const status = code === 0 ? 'done' : 'failed'
      if (!result) result = timedOut ? `Agent timed out.${stderr.trim() ? '\n\nStderr:\n' + stderr.trim() : ''}` : (stderr.trim() || `No output (exit code ${code})`)
      else if (status === 'failed' && stderr.trim()) result += `\n\nStderr:\n${stderr.trim()}`
      await dbCall('finishAgentJob', job.id, status, result, sessionId)
      if (status === 'done' && job.task_id) await dbCall('insertAgentNote', uuidv4(), job.task_id, result, job.id)
      // Apply output_rules from agent.config.
      // Supported actions:
      //   add_link:  { action, pattern, url }          — regex match → construct URL → attach to task
      //   set_field: { action, pattern, field, group }  — regex match → write capture group to task field
      if (status === 'done' && job.task_id) {
        const rules = cfg?.output_rules ?? []
        for (const rule of rules) {
          try {
            if (rule.action === 'add_link' && rule.pattern && rule.url) {
              const match = stdout.match(new RegExp(rule.pattern))
              if (match) {
                const url = rule.url.replace(/\{(\d+)\}/g, (_, i) => match[parseInt(i)] ?? '')
                if (url) await dbCall('addTaskLink', job.task_id, url)
              }
            } else if (rule.action === 'set_field' && rule.pattern && rule.field) {
              const match = stdout.match(new RegExp(rule.pattern))
              if (match) {
                const value = match[rule.group ?? 1] ?? match[0]
                if (value) await dbCall('updateTask', job.task_id, { [rule.field]: value })
              }
            }
          } catch {}
        }
      }
      BrowserWindow.getAllWindows()[0]?.webContents.send('agent-job:complete', { taskId: job.task_id, jobId: job.id })
    })
    proc.on('error', async err => {
      if (settled) return
      settled = true
      clearTimeout(timeout); runningJobs--
      await dbCall('finishAgentJob', job.id, 'failed', `Failed to start agent: ${err.message}\n\nCommand: ${bin} ${spawnArgs.slice(0, 2).join(' ')}`, null)
    })
  }
}

async function autoRunAgents() {
  const tasks = await dbCall('getAutorunTasks')
  for (const task of tasks) {
    await dbCall('createAgentJob', task.id, null)
  }
}

// ── Background workers ────────────────────────────────────────────────────────

async function runAgentScan() {
  const settings = loadSettings()
  const excludeFolders = (settings.agentExcludeFolders ?? '').split(',').map(f => f.trim()).filter(Boolean)
  const agents = await scanAgents(settings.agentsRoot || settings.terminalCwd || process.env.HOME, excludeFolders)
  if (agents.length) await dbCall('upsertAgents', agents).catch(() => {})
}

async function runDueHeartbeats() {
  const due = await dbCall('getDueHeartbeats')
  for (const hb of due) {
    await dbCall('createHeartbeatJob', hb.id)
    await dbCall('markHeartbeatRun', hb.id, hb.interval_minutes, hb.run_at_time ?? null)
  }
}

export function startBackgroundWorkers() {
  dbCall('resetStuckJobs').catch(() => {})
  syncPendingAttachments().catch(() => {})
  runAgentScan().catch(() => {})
  setInterval(() => syncPendingAttachments().catch(() => {}), 5 * 60 * 1000)
  setInterval(() => processAgentJobs().catch(() => {}), 30_000)
  setInterval(() => autoRunAgents().catch(() => {}), 5 * 60_000)
  setTimeout(() => runDueHeartbeats().catch(() => {}), 5_000)
  setInterval(() => runDueHeartbeats().catch(() => {}), 60_000)
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
  ipcMain.handle('tasks:coding', () => dbCall('getCodingTasks'))
  ipcMain.handle('tasks:reading', () => dbCall('getReadingTasks'))
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
  ipcMain.handle('projects:summaries', () => dbCall('getProjectSummaries'))
  ipcMain.handle('project:detail', (_, name) => dbCall('getProjectDetail', name))
  ipcMain.handle('project:create', (_, name) => dbCall('createProjectExplicit', name))
  ipcMain.handle('project:rename', (_, oldName, newName) => dbCall('renameProject', oldName, newName))
  ipcMain.handle('project:set-context', (_, name, context) => dbCall('setProjectContext', name, context))
  ipcMain.handle('projects:archive', (_, name) => dbCall('archiveProject', name))
  ipcMain.handle('projects:unarchive', (_, name) => dbCall('unarchiveProject', name))
  ipcMain.handle('projects:delete', (_, name) => dbCall('deleteProject', name))

  // Heartbeats
  ipcMain.handle('heartbeats:list', () => dbCall('listHeartbeats'))
  ipcMain.handle('heartbeats:create', (_, body) => dbCall('createHeartbeat', body))
  ipcMain.handle('heartbeats:update', (_, id, fields) => dbCall('updateHeartbeat', id, fields))
  ipcMain.handle('heartbeats:delete', (_, id) => dbCall('deleteHeartbeat', id))
  ipcMain.handle('heartbeats:toggle', (_, id) => dbCall('toggleHeartbeat', id))
  ipcMain.handle('heartbeats:jobs', (_, id, limit) => dbCall('listHeartbeatJobs', id, limit ?? 10))

  // Habits
  ipcMain.handle('habits:list', (_, date) => dbCall('listHabits', date))
  ipcMain.handle('habits:create', (_, body) => dbCall('createHabit', body))
  ipcMain.handle('habits:update', (_, body) => dbCall('updateHabit', body))
  ipcMain.handle('habits:log', (_, habitId, date, status, notes) => dbCall('logHabit', habitId, date, status, notes))
  ipcMain.handle('habits:unlog', (_, habitId, date) => dbCall('unlogHabit', habitId, date))

  // Attachments
  ipcMain.handle('attachments:list', async (_, taskId) => {
    const rows = await dbCall('listAttachments', taskId)
    const settings = loadSettings()
    const client = getS3Client(settings)
    return Promise.all(rows.map(async a => {
      // Encrypted attachments are served via attachments:download — don't generate presigned URLs for them
      if (!a.url && a.bucket && a.key && client && !a.encrypted) {
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
    const encKey = loadEncryptionKey()
    const id = uuidv4()
    const safeExt = path.extname(filename) || extFromMime(mimeType)
    const key = `attachments/${taskId}/${id}${safeExt}`
    const localPath = path.join(cacheDir, `${id}${safeExt}`)
    const plainBuffer = Buffer.from(bufferArray)
    fs.writeFileSync(localPath, plainBuffer)  // local cache is always unencrypted
    let url = null, uploadedBucket = null, uploadedKey = null, warning = null, encrypted = 0
    if (client && bucket) {
      try {
        let uploadBuffer = plainBuffer
        if (encKey) { uploadBuffer = encrypt(plainBuffer, encKey); encrypted = 1 }
        await uploadToS3(client, bucket, key, uploadBuffer, mimeType)
        uploadedBucket = bucket; uploadedKey = key
        url = (!encrypted && settings.s3PublicUrl) ? `${settings.s3PublicUrl.replace(/\/$/, '')}/${key}` : null
      } catch { warning = 's3_upload_failed' }
    }
    await dbCall('insertAttachment', { id, taskId, filename, mimeType, sizeBytes: plainBuffer.length, bucket: uploadedBucket, key: uploadedKey, url, localPath, encrypted })
    return { ok: true, warning, attachment: { id, filename, url, local_path: localPath } }
  })
  // Download and decrypt an encrypted attachment, saving to cache then opening
  ipcMain.handle('attachments:download', async (_, id) => {
    const att = await dbCall('getAttachment', id)
    if (!att) return { ok: false, error: 'Not found' }
    // If local cache exists, open directly
    if (att.local_path && fs.existsSync(att.local_path)) {
      await shell.openPath(att.local_path)
      return { ok: true }
    }
    if (!att.bucket || !att.key) return { ok: false, error: 'No remote copy' }
    const settings = loadSettings()
    const client = getS3Client(settings)
    if (!client) return { ok: false, error: 'S3 not configured' }
    try {
      let buffer = await downloadFromS3(client, att.bucket, att.key)
      if (att.encrypted) {
        const encKey = loadEncryptionKey()
        if (!encKey) return { ok: false, error: 'No encryption key — import your key in Settings' }
        buffer = decrypt(buffer, encKey)
      }
      const cacheDir = getAttachmentCacheDir(settings)
      const localPath = path.join(cacheDir, `${att.id}${path.extname(att.filename)}`)
      fs.writeFileSync(localPath, buffer)
      await dbCall('updateTask', att.task_id, {})  // no-op, just refresh
      await shell.openPath(localPath)
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
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
  ipcMain.handle('agents:list', async () => {
    const agents = await runAgentScan().then(() => {
      const settings = loadSettings()
      const excludeFolders = (settings.agentExcludeFolders ?? '').split(',').map(f => f.trim()).filter(Boolean)
      return scanAgents(settings.agentsRoot || settings.terminalCwd || process.env.HOME, excludeFolders)
    }).catch(() => [])
    return agents
  })
  ipcMain.handle('agents:rescan', async () => { await runAgentScan(); return { ok: true } })
  ipcMain.handle('agents:list-db', (_, filter) => dbCall('listAgentsDb', filter ?? {}))
  ipcMain.handle('project:update', (_, name, fields) => dbCall('updateProject', name, fields))
  ipcMain.handle('agent-jobs:list', (_, taskId) => dbCall('listAgentJobs', taskId))
  ipcMain.handle('agent-jobs:get', (_, id) => dbCall('getAgentJob', id))
  ipcMain.handle('agent-jobs:create', (_, taskId, userMessage) => dbCall('createAgentJob', taskId, userMessage))

  // Settings
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_, data) => { saveSettings(data); return { ok: true } })
  ipcMain.handle('settings:export', () => {
    const s = loadSettings()
    return { ok: true, json: JSON.stringify(s, null, 2) }
  })
  ipcMain.handle('settings:import', (_, json) => {
    try {
      const parsed = JSON.parse(json)
      if (typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'Invalid settings JSON' }
      saveSettings(parsed)
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  })

  // Encryption key
  ipcMain.handle('key:status', () => ({ present: !!loadEncryptionKey() }))
  ipcMain.handle('key:generate', () => {
    generateEncryptionKey()
    return { ok: true }
  })
  ipcMain.handle('key:export', () => {
    const key = loadEncryptionKey()
    if (!key) return { ok: false, error: 'No key found' }
    return { ok: true, key: key.toString('base64') }
  })
  ipcMain.handle('key:import', (_, base64) => {
    try {
      const buf = Buffer.from(base64.trim(), 'base64')
      if (buf.length !== 32) return { ok: false, error: 'Invalid key — must be 32 bytes (256-bit)' }
      saveEncryptionKey(buf)
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  })

  // Backup
  ipcMain.handle('backup:run', () => runBackup())
  ipcMain.handle('backup:status', () => ({ lastTime: _lastBackupTime, lastStatus: _lastBackupStatus }))
  ipcMain.handle('backup:list', async () => {
    const settings = loadSettings()
    const client = getBackupS3Client(settings)
    if (!client) return { ok: false, error: 'Backup bucket not configured' }
    try {
      const objects = await listS3Objects(client, settings.backupBucket, 'db/')
      const items = objects
        .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))
        .slice(0, 20)
        .map(o => ({ key: o.Key, size: o.Size, date: o.LastModified }))
      return { ok: true, items }
    } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('backup:restore', async (_, objKey) => {
    const key = loadEncryptionKey()
    if (!key) return { ok: false, error: 'No encryption key — import your key first' }
    const settings = loadSettings()
    const client = getBackupS3Client(settings)
    if (!client) return { ok: false, error: 'Backup bucket not configured' }
    try {
      const enc = await downloadFromS3(client, settings.backupBucket, objKey)
      const plain = decrypt(enc, key)
      const restorePath = path.join(path.dirname(_settingsFile), 'tasks.db.restore')
      fs.writeFileSync(restorePath, plain)
      return { ok: true, message: 'Restore file written — restart Qalatra to apply.' }
    } catch (e) { return { ok: false, error: e.message } }
  })

  // MCP
  ipcMain.handle('mcp:status', () => {
    const s = loadSettings()
    const port = parseInt(s.mcpPort ?? '3457', 10)
    let claudeJson = {}
    try { claudeJson = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8')) } catch {}
    const entry = claudeJson.mcpServers?.['qalatra']
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
    // Use mcp-remote stdio proxy so qalatra works in both interactive and non-interactive
    // (agent subprocess) Claude Code sessions. Direct HTTP type is skipped in -p mode.
    claudeJson.mcpServers['qalatra'] = { type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', `http://localhost:${p}/mcp`] }
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

  // md-style cascade: walk up from startDir looking for .md-style.json, then check ~/.md-style.json
  ipcMain.handle('style:find', (_, startDir) => {
    const home = os.homedir()
    let dir = startDir
    while (true) {
      const candidate = path.join(dir, '.md-style.json')
      if (fs.existsSync(candidate)) {
        try { return { foundPath: candidate, content: fs.readFileSync(candidate, 'utf-8') } } catch { /* skip */ }
      }
      const parent = path.dirname(dir)
      if (parent === dir || dir === home) break
      dir = parent
    }
    // user-level default
    const userDefault = path.join(home, '.md-style.json')
    if (fs.existsSync(userDefault)) {
      try { return { foundPath: userDefault, content: fs.readFileSync(userDefault, 'utf-8') } } catch { /* skip */ }
    }
    return null
  })

  // Write user-level default style (~/.md-style.json)
  ipcMain.handle('style:write-user', (_, contents) => {
    if (typeof contents !== 'string') throw new Error('contents must be string')
    fs.writeFileSync(path.join(os.homedir(), '.md-style.json'), contents, 'utf-8')
    return { ok: true }
  })

  // Write folder-level style ({dir}/.md-style.json) — restricted to IdeaProjects
  ipcMain.handle('style:write-folder', (_, dir, contents) => {
    const allowed = path.join(os.homedir(), 'IdeaProjects')
    if (!dir.startsWith(allowed)) throw new Error('Forbidden')
    if (typeof contents !== 'string') throw new Error('contents must be string')
    fs.writeFileSync(path.join(dir, '.md-style.json'), contents, 'utf-8')
    return { ok: true }
  })

  console.log('[ipc] handlers registered')
}
