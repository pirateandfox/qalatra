// ipc-handlers.js — all business logic exposed as Electron IPC handlers.
// Replaces the HTTP API server (api.js). The renderer calls
// window.electronAPI.invoke(channel, ...args) and this module handles them.

import { ipcMain, shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import { spawn } from 'child_process'
import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import { nowIso, today, appendAiContext, nextRecurrenceDate } from './mcp/db.js'
import { getS3Client, uploadToS3, deleteFromS3, getPresignedUrl } from './s3.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json')

// ── DB singleton ──────────────────────────────────────────────────────────────

let _db = null

function getDb() {
  if (!_db) throw new Error('DB not initialised — call initDb(dbDir) first')
  return _db
}

export function initDb(dbDir) {
  if (_db) return _db
  fs.mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, 'tasks.db')
  console.log('[ipc] openDb:', dbPath)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  _db = db
  console.log('[ipc] db ready')
  return db
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

// ── Schema migration ──────────────────────────────────────────────────────────

function migrate(db) {
  // Base schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL,
      notes               TEXT,
      status              TEXT NOT NULL DEFAULT 'active',
      my_priority         INTEGER,
      energy_required     TEXT,
      context             TEXT NOT NULL DEFAULT 'personal',
      project             TEXT,
      tags                TEXT,
      source              TEXT,
      source_id           TEXT,
      source_url          TEXT,
      source_priority     TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      due_date            TEXT,
      start_date          TEXT,
      surface_after       TEXT,
      last_touched_human  TEXT,
      last_touched_ai     TEXT,
      last_surfaced       TEXT,
      ai_context          TEXT,
      task_type           TEXT NOT NULL DEFAULT 'task',
      event_time          TEXT,
      end_time            TEXT,
      links               TEXT DEFAULT '[]',
      recurrence          TEXT,
      outcome             TEXT,
      sort_order          INTEGER,
      parent_id           TEXT REFERENCES tasks(id),
      agent_path          TEXT,
      agent_resume        INTEGER NOT NULL DEFAULT 1,
      agent_autorun       INTEGER NOT NULL DEFAULT 0,
      agent_autorun_time  TEXT DEFAULT '09:00'
    );
    CREATE TABLE IF NOT EXISTS daily_notes (
      date       TEXT PRIMARY KEY,
      content    TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS contexts (
      slug       TEXT PRIMARY KEY,
      display_name TEXT,
      label      TEXT,
      color      TEXT NOT NULL DEFAULT '#888888',
      sort_order INTEGER,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id           TEXT PRIMARY KEY,
      task_id      TEXT REFERENCES tasks(id),
      agent_path   TEXT NOT NULL,
      prompt       TEXT NOT NULL,
      user_message TEXT,
      status       TEXT NOT NULL DEFAULT 'queued',
      result       TEXT,
      session_id   TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      started_at   TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      filename   TEXT NOT NULL,
      mimetype   TEXT,
      size_bytes INTEGER,
      bucket     TEXT,
      key        TEXT,
      url        TEXT,
      local_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS notes (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES tasks(id),
      body         TEXT NOT NULL,
      author       TEXT NOT NULL DEFAULT 'user',
      agent_job_id TEXT REFERENCES agent_jobs(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS habits (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT,
      recurrence  TEXT NOT NULL DEFAULT 'daily',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS habit_logs (
      id       TEXT PRIMARY KEY,
      habit_id TEXT NOT NULL REFERENCES habits(id),
      date     TEXT NOT NULL,
      status   TEXT NOT NULL DEFAULT 'done',
      notes    TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(habit_id, date)
    );
  `)

  // Idempotent column additions for older DBs
  const tryAlter = (sql) => { try { db.exec(sql) } catch {} }
  tryAlter('ALTER TABLE tasks RENAME COLUMN notes TO description')
  tryAlter('ALTER TABLE tasks ADD COLUMN description TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN sort_order INTEGER')
  tryAlter('ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id)')
  tryAlter("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'task'")
  tryAlter('ALTER TABLE tasks ADD COLUMN event_time TEXT')
  tryAlter("ALTER TABLE tasks ADD COLUMN links TEXT DEFAULT '[]'")
  tryAlter('ALTER TABLE tasks ADD COLUMN recurrence TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN outcome TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN end_time TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN agent_path TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN agent_resume INTEGER NOT NULL DEFAULT 1')
  tryAlter('ALTER TABLE tasks ADD COLUMN agent_autorun INTEGER NOT NULL DEFAULT 0')
  tryAlter("ALTER TABLE tasks ADD COLUMN agent_autorun_time TEXT DEFAULT '09:00'")
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN session_id TEXT')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN user_message TEXT')
  tryAlter('ALTER TABLE contexts ADD COLUMN label TEXT')
  tryAlter("ALTER TABLE contexts ADD COLUMN color TEXT NOT NULL DEFAULT '#888888'")
  tryAlter('ALTER TABLE contexts ADD COLUMN sort_order INTEGER')
  tryAlter("INSERT OR IGNORE INTO contexts (slug, display_name, label, color, sort_order, active) VALUES ('internal','Internal','Internal','#94a3b8',7,1)")

  // Apply known colors/labels to legacy contexts
  const known = [
    { slug: 'monroe',       color: '#4f9cf9', sort_order: 1, label: 'Monroe Institute' },
    { slug: 'biztobiz',     color: '#f9a94f', sort_order: 2, label: 'Biz to Biz' },
    { slug: 'pirateandfox', color: '#a78bfa', sort_order: 3, label: 'Pirate & Fox' },
    { slug: 'silvermouse',  color: '#fb7185', sort_order: 4, label: 'Silvermouse' },
    { slug: 'flightdesk',   color: '#f472b6', sort_order: 5, label: 'FlightDesk' },
    { slug: 'personal',     color: '#4fcc8a', sort_order: 6, label: 'Personal' },
    { slug: 'internal',     color: '#94a3b8', sort_order: 7, label: 'Internal' },
  ]
  const updateCtx = db.prepare("UPDATE contexts SET color = ?, sort_order = ?, label = CASE WHEN label IS NULL OR label = '' THEN ? ELSE label END WHERE slug = ?")
  for (const c of known) updateCtx.run(c.color, c.sort_order, c.label, c.slug)

  const { n } = db.prepare('SELECT COUNT(*) as n FROM contexts').get()
  if (n === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO contexts (slug, label, color, sort_order) VALUES (@slug, @label, @color, @sort_order)')
    for (const c of known) ins.run(c)
  }

  // Surface snoozed tasks whose time has passed
  db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL WHERE status = 'snoozed' AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime'))`).run()
}

// ── Attachments ───────────────────────────────────────────────────────────────

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
  const db = getDb()
  const pending = db.prepare(`SELECT * FROM attachments WHERE bucket IS NULL AND local_path IS NOT NULL`).all()
  let synced = 0, failed = 0
  for (const att of pending) {
    if (!fs.existsSync(att.local_path)) { failed++; continue }
    try {
      const buffer = fs.readFileSync(att.local_path)
      const ext = path.extname(att.filename)
      const key = `attachments/${att.task_id}/${att.id}${ext}`
      await uploadToS3(client, bucket, key, buffer, att.mimetype)
      const url = settings.s3PublicUrl ? `${settings.s3PublicUrl.replace(/\/$/, '')}/${key}` : null
      db.prepare(`UPDATE attachments SET bucket = ?, key = ?, url = ? WHERE id = ?`).run(bucket, key, url, att.id)
      synced++
    } catch { failed++ }
  }
  return { synced, failed, total: pending.length }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function offsetDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function isHabitDueOn(habit, dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z')
  const dow = d.getUTCDay()
  switch (habit.recurrence) {
    case 'daily':    return true
    case 'weekdays': return dow >= 1 && dow <= 5
    case 'weekly': {
      const created = new Date(habit.created_at.substring(0, 10) + 'T12:00:00Z')
      return d.getUTCDay() === created.getUTCDay()
    }
    case 'monthly': {
      const created = new Date(habit.created_at.substring(0, 10) + 'T12:00:00Z')
      return d.getUTCDate() === created.getUTCDate()
    }
    default: return true
  }
}

// ── Task queries ──────────────────────────────────────────────────────────────

const ORDER = 'sort_order ASC NULLS LAST, my_priority ASC NULLS LAST, created_at ASC'

function attachSubtasks(db, tasks) {
  if (!tasks.length) return tasks
  const ids = tasks.map(t => `'${t.id.replace(/'/g,"''")}'`).join(',')
  const subs = db.prepare(`SELECT * FROM tasks WHERE parent_id IN (${ids}) ORDER BY sort_order ASC NULLS LAST, created_at ASC`).all()
  const byParent = {}
  for (const s of subs) { if (!byParent[s.parent_id]) byParent[s.parent_id] = []; byParent[s.parent_id].push(s) }
  return tasks.map(t => ({ ...t, subtasks: byParent[t.id] ?? [] }))
}

function stampAgentJobs(db, ...arrays) {
  const jobs = db.prepare(`SELECT task_id, status FROM agent_jobs WHERE status IN ('queued','running') OR (status = 'done' AND completed_at >= datetime('now','-24 hours')) OR (status = 'failed' AND completed_at >= datetime('now','-24 hours')) ORDER BY created_at DESC`).all()
  if (!jobs.length) return
  const map = {}
  for (const j of jobs) { if (j.task_id && !map[j.task_id]) map[j.task_id] = j.status }
  for (const arr of arrays) for (const t of arr) { if (map[t.id]) t.agent_job_status = map[t.id] }
}

function autoRolloverRecurring(db) {
  const t = todayStr()
  const stale = db.prepare(`SELECT * FROM tasks WHERE status = 'active' AND recurrence IS NOT NULL AND ((due_date IS NOT NULL AND due_date < ?) OR (due_date IS NULL AND start_date IS NOT NULL AND start_date < ?))`).all(t, t)
  const now = nowIso()
  for (const task of stale) {
    db.prepare(`UPDATE tasks SET status = 'done', outcome = 'skipped', last_touched_human = ?, ai_context = ? WHERE id = ?`).run(now, appendAiContext(task.ai_context, 'Auto-skipped: overdue recurring task.'), task.id)
    const nextDate = nextRecurrenceDate(task.due_date ?? t, task.recurrence)
    if (nextDate) spawnRecurrence(db, task, nextDate, now, `Auto-recurred from task ${task.id}`)
  }
}

function spawnRecurrence(db, task, nextDate, now, reason) {
  const id = crypto.randomUUID()
  db.prepare(`INSERT INTO tasks (id, title, description, status, my_priority, energy_required, context, project, tags, source, source_url, created_at, updated_at, start_date, due_date, task_type, recurrence, ai_context, agent_path, agent_resume, agent_autorun, agent_autorun_time) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, task.title, task.description, task.my_priority, task.energy_required, task.context, task.project, task.tags, task.source ?? 'manual', task.source_url, now, now, nextDate, nextDate, task.task_type, task.recurrence, appendAiContext(null, reason), task.agent_path ?? null, task.agent_resume ?? 1, task.agent_autorun ?? 0, task.agent_autorun_time ?? '09:00')
}

function getTasksForDate(date) {
  const db = getDb()
  const t = todayStr()
  const isToday = date === t
  const nextDay = offsetDate(date, 1)

  if (isToday) {
    autoRolloverRecurring(db)
    const overdue    = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE status = 'active' AND parent_id IS NULL AND due_date IS NOT NULL AND due_date < ? AND task_type = 'task' ORDER BY due_date ASC, ${ORDER}`).all(date))
    const dueToday   = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE status = 'active' AND parent_id IS NULL AND strftime('%Y-%m-%d', due_date) = ? AND task_type = 'task' AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime') OR strftime('%Y-%m-%d', due_date) <= ?) ORDER BY ${ORDER}`).all(date, date))
    const active     = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE status = 'active' AND parent_id IS NULL AND task_type = 'task' AND (due_date IS NULL OR due_date > ?) AND ((start_date IS NULL AND due_date IS NULL) OR (start_date IS NOT NULL AND start_date <= ?)) AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')) ORDER BY ${ORDER}`).all(date, date))
    const doneToday  = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND parent_id IS NULL AND last_touched_human >= ? AND last_touched_human < ? ORDER BY last_touched_human DESC`).all(date, nextDay))
    const events     = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE task_type = 'event' AND parent_id IS NULL AND status != 'done' AND (due_date = ? OR due_date IS NULL) ORDER BY event_time ASC NULLS LAST, created_at ASC`).all(date))
    const reminders  = db.prepare(`SELECT * FROM tasks WHERE task_type = 'reminder' AND parent_id IS NULL AND status != 'done' AND (due_date IS NULL OR due_date <= ?) AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')) ORDER BY ${ORDER}`).all(date)
    const timeSnoozed = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE status = 'snoozed' AND parent_id IS NULL AND task_type = 'task' AND strftime('%Y-%m-%d', due_date) = ? AND surface_after > strftime('%Y-%m-%d %H:%M', 'now', 'localtime') ORDER BY surface_after ASC`).all(date))
    const allHabits  = db.prepare('SELECT * FROM habits WHERE active = 1 ORDER BY created_at ASC').all()
    const todayHabits = allHabits.filter(h => isHabitDueOn(h, date))
    const habitLogs  = todayHabits.length ? db.prepare(`SELECT * FROM habit_logs WHERE date = ? AND habit_id IN (${todayHabits.map(() => '?').join(',')})`).all(date, ...todayHabits.map(h => h.id)) : []
    const habitLogMap = {}
    for (const l of habitLogs) habitLogMap[l.habit_id] = l
    const habits     = todayHabits.map(h => ({ ...h, today_log: habitLogMap[h.id] ?? null }))
    stampAgentJobs(db, overdue, dueToday, active)
    return { view: 'today', date, overdue, dueToday, active, doneToday, timeSnoozed, events, reminders, habits }
  } else if (date > t) {
    const scheduled  = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE strftime('%Y-%m-%d', due_date) = ? AND parent_id IS NULL AND task_type = 'task' AND status != 'snoozed' ORDER BY status ASC, ${ORDER}`).all(date))
    const timeSnoozed = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE strftime('%Y-%m-%d', due_date) = ? AND parent_id IS NULL AND task_type = 'task' AND status = 'snoozed' ORDER BY surface_after ASC`).all(date))
    const events     = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE task_type = 'event' AND parent_id IS NULL AND status != 'done' AND due_date = ? ORDER BY event_time ASC NULLS LAST, created_at ASC`).all(date))
    const reminders  = db.prepare(`SELECT * FROM tasks WHERE task_type = 'reminder' AND parent_id IS NULL AND status != 'done' AND due_date = ? ORDER BY ${ORDER}`).all(date)
    stampAgentJobs(db, scheduled, timeSnoozed)
    return { view: 'future', date, scheduled, timeSnoozed, events, reminders }
  } else {
    const completed  = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND parent_id IS NULL AND last_touched_human >= ? AND last_touched_human < ? ORDER BY last_touched_human DESC`).all(date, nextDay))
    const wasDue     = attachSubtasks(db, db.prepare(`SELECT * FROM tasks WHERE due_date = ? AND parent_id IS NULL ORDER BY status ASC, ${ORDER}`).all(date))
    return { view: 'past', date, completed, wasDue }
  }
}

// ── Task mutations ────────────────────────────────────────────────────────────

function completeTask(taskId) {
  const db = getDb()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  if (!task) return { ok: false, reason: 'not_found' }
  const incomplete = db.prepare(`SELECT count(*) as n FROM tasks WHERE parent_id = ? AND status != 'done'`).get(taskId)
  if (incomplete.n > 0) return { ok: false, reason: 'subtasks_incomplete', count: incomplete.n }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'completed', last_touched_human = ?, ai_context = ? WHERE id = ?`).run(now, appendAiContext(task.ai_context, 'Marked complete via UI.'), taskId)
  if (task.recurrence) {
    const nextDate = nextRecurrenceDate(task.due_date ?? today(), task.recurrence)
    if (nextDate) spawnRecurrence(db, task, nextDate, now, `Recurred from task ${taskId}`)
  }
  return { ok: true }
}

function completeTaskWithSubtasks(taskId) {
  const db = getDb()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  if (!task) return { ok: false, reason: 'not_found' }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', last_touched_human = ?, ai_context = ? WHERE parent_id = ? AND status != 'done'`).run(now, appendAiContext(null, 'Bulk-completed with parent via UI.'), taskId)
  db.prepare(`UPDATE tasks SET status = 'done', last_touched_human = ?, ai_context = ? WHERE id = ?`).run(now, appendAiContext(task.ai_context, 'Marked complete via UI (with subtasks).'), taskId)
  return { ok: true }
}

function createSubtask(parentId, title) {
  const db = getDb()
  const parent = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parentId)
  if (!parent) return null
  const id = crypto.randomUUID()
  const now = nowIso()
  db.prepare(`INSERT INTO tasks (id, title, status, context, project, parent_id, source, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, 'manual', ?, ?)`).run(id, title, parent.context, parent.project, parentId, now, now)
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
}

function skipTask(taskId) {
  const db = getDb()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  if (!task || !task.recurrence) return false
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'skipped', last_touched_human = ?, ai_context = ? WHERE id = ?`).run(now, appendAiContext(task.ai_context, 'Skipped via UI.'), taskId)
  const nextDate = nextRecurrenceDate(task.due_date ?? today(), task.recurrence)
  if (nextDate) spawnRecurrence(db, task, nextDate, now, `Recurred from task ${taskId}`)
  return true
}

function uncompleteTask(taskId) {
  const db = getDb()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  if (!task) return false
  db.prepare(`UPDATE tasks SET status = 'active', last_touched_human = ?, ai_context = ? WHERE id = ?`).run(nowIso(), appendAiContext(task.ai_context, 'Reopened via UI.'), taskId)
  return true
}

function snoozeTask(taskId, until) {
  const db = getDb()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  if (!task) return false
  const hasTime = until.includes(' ') || until.includes('T')
  if (hasTime) {
    db.prepare(`UPDATE tasks SET status = 'snoozed', surface_after = ?, due_date = ?, ai_context = ?, last_touched_human = ? WHERE id = ?`).run(until, until.substring(0, 10), appendAiContext(task.ai_context, `Snoozed until ${until}.`), nowIso(), taskId)
  } else {
    db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL, due_date = ?, ai_context = ?, last_touched_human = ? WHERE id = ?`).run(until, appendAiContext(task.ai_context, `Deferred to ${until}.`), nowIso(), taskId)
  }
  return true
}

function activateTask(taskId) {
  const db = getDb()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  if (!task) return false
  db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL, ai_context = ?, last_touched_human = ? WHERE id = ?`).run(appendAiContext(task.ai_context, 'Activated via UI.'), nowIso(), taskId)
  return true
}

function reorderTasks(ids) {
  const db = getDb()
  const update = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?')
  db.transaction((list) => { list.forEach((id, i) => update.run(i, id)) })(ids)
}

// ── Agent scanner ─────────────────────────────────────────────────────────────

function scanAgents(root) {
  const agents = []
  if (!root || !fs.existsSync(root)) return agents
  function walk(dir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = path.join(dir, entry.name)
      const configPath = path.join(fullPath, 'agent.config')
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
          agents.push({ name: config.name ?? entry.name, description: config.description ?? null, command: config.command ?? null, path: fullPath, relativePath: path.relative(root, fullPath) })
        } catch {}
      }
      walk(fullPath)
    }
  }
  walk(root)
  return agents
}

// ── Agent job worker ──────────────────────────────────────────────────────────

const MAX_CONCURRENT_JOBS = 3
let runningJobs = 0

function processAgentJobs() {
  const db = getDb()
  if (runningJobs >= MAX_CONCURRENT_JOBS) return
  const slots = MAX_CONCURRENT_JOBS - runningJobs
  const jobs = db.prepare(`SELECT * FROM agent_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`).all(slots)
  for (const job of jobs) {
    runningJobs++
    db.prepare(`UPDATE agent_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?`).run(job.id)
    const settings = loadSettings()
    let agentCommand = settings.defaultAgentCommand || 'claude --dangerously-skip-permissions'
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(job.agent_path, 'agent.config'), 'utf8'))
      if (cfg.command) agentCommand = cfg.command
    } catch {}
    const parts = agentCommand.trim().split(/\s+/)
    const bin = parts[0]; const baseArgs = parts.slice(1)
    const task = job.task_id ? db.prepare('SELECT agent_resume FROM tasks WHERE id = ?').get(job.task_id) : null
    const canResume = task?.agent_resume !== 0
    const prevSession = canResume && job.task_id
      ? db.prepare(`SELECT session_id FROM agent_jobs WHERE task_id = ? AND session_id IS NOT NULL AND status = 'done' ORDER BY completed_at DESC LIMIT 1`).get(job.task_id)
      : null
    const args = prevSession?.session_id
      ? [...baseArgs, '--resume', prevSession.session_id, '-p', job.user_message || job.prompt, '--output-format', 'json']
      : [...baseArgs, '-p', job.prompt, '--output-format', 'json']
    let stdout = '', stderr = '', timedOut = false
    const proc = spawn(bin, args, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const timeout = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, 15 * 60 * 1000)
    proc.on('close', code => {
      clearTimeout(timeout); runningJobs--
      const db2 = getDb()
      let result = stdout.trim(); let sessionId = null
      try { const p = JSON.parse(stdout); result = p.result ?? result; sessionId = p.session_id ?? null } catch {}
      const status = code === 0 ? 'done' : 'failed'
      if (!result) result = timedOut ? `Agent timed out.${stderr.trim() ? '\n\nStderr:\n' + stderr.trim() : ''}` : (stderr.trim() || `No output (exit code ${code})`)
      else if (status === 'failed' && stderr.trim()) result += `\n\nStderr:\n${stderr.trim()}`
      db2.prepare(`UPDATE agent_jobs SET status = ?, result = ?, session_id = ?, completed_at = datetime('now') WHERE id = ?`).run(status, result, sessionId, job.id)
      if (status === 'done' && job.task_id) db2.prepare(`INSERT INTO notes (id, task_id, body, author, agent_job_id) VALUES (?, ?, ?, 'agent', ?)`).run(uuidv4(), job.task_id, result, job.id)
    })
    proc.on('error', err => { clearTimeout(timeout); runningJobs--; getDb().prepare(`UPDATE agent_jobs SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?`).run(err.message, job.id) })
  }
}

function autoRunAgents() {
  const db = getDb()
  const tasks = db.prepare(`SELECT t.* FROM tasks t WHERE t.agent_path IS NOT NULL AND t.agent_autorun = 1 AND t.status = 'active' AND (t.due_date IS NULL OR t.due_date <= date('now')) AND time('now', 'localtime') >= COALESCE(t.agent_autorun_time, '09:00') AND NOT EXISTS (SELECT 1 FROM agent_jobs j WHERE j.task_id = t.id)`).all()
  for (const task of tasks) {
    const prompt = [task.title, task.description].filter(Boolean).join('\n')
    db.prepare(`INSERT INTO agent_jobs (id, task_id, agent_path, prompt, user_message) VALUES (?, ?, ?, ?, ?)`).run(uuidv4(), task.id, task.agent_path, prompt, null)
  }
}

// ── Background workers ────────────────────────────────────────────────────────

export function startBackgroundWorkers() {
  // Re-queue any jobs stuck in 'running' from previous session
  try { getDb().prepare(`UPDATE agent_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`).run() } catch {}
  syncPendingAttachments().catch(() => {})
  setInterval(() => syncPendingAttachments().catch(() => {}), 5 * 60 * 1000)
  setInterval(() => { try { processAgentJobs() } catch {} }, 30_000)
  setInterval(() => { try { autoRunAgents() } catch {} }, 5 * 60_000)
}

// ── IPC handler registration ──────────────────────────────────────────────────

export function setupIpcHandlers(getMcpProcessRef) {
  // Tasks
  ipcMain.handle('tasks:list', async (_, date) => {
    const d = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr()
    return getTasksForDate(d)
  })
  ipcMain.handle('task:get', async (_, id) => {
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    if (!task) throw new Error('Task not found')
    return task
  })
  ipcMain.handle('task:subtasks', async (_, id) =>
    getDb().prepare(`SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC NULLS LAST, created_at ASC`).all(id)
  )
  ipcMain.handle('task:backlog', async () =>
    getDb().prepare(`SELECT * FROM tasks WHERE status = 'backlog' AND parent_id IS NULL ORDER BY context ASC, project ASC NULLS LAST, sort_order ASC NULLS LAST, created_at ASC`).all()
  )
  ipcMain.handle('task:create', async (_, body) => {
    if (!body.title) throw new Error('title required')
    const db = getDb()
    const id = crypto.randomUUID()
    const now = nowIso()
    db.prepare(`INSERT INTO tasks (id, title, status, context, project, task_type, source, ai_context, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, 'task', 'manual', ?, ?, ?)`)
      .run(id, body.title, body.context ?? 'personal', body.project ?? null, body.ai_context ? `[${now.slice(0,10)}] ${body.ai_context}` : null, now, now)
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  })
  ipcMain.handle('task:update', async (_, id, body) => {
    const db = getDb()
    const MUTABLE = ['title','description','status','my_priority','energy_required','context','project','tags','source_url','due_date','start_date','surface_after','task_type','event_time','end_time','recurrence','parent_id','agent_path','agent_resume','agent_autorun','agent_autorun_time','outcome','notes']
    if (body.links !== undefined) db.prepare("UPDATE tasks SET links = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(body.links), id)
    const sets = []; const params = {}
    for (const f of MUTABLE) { if (body[f] !== undefined) { sets.push(`${f} = @${f}`); params[f] = body[f] === '' ? null : body[f] } }
    if (sets.length) { params.id = id; db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(params) }
    return { ok: true }
  })
  ipcMain.handle('task:delete', async (_, id) => {
    const db = getDb()
    db.prepare('DELETE FROM agent_jobs WHERE task_id = ?').run(id)
    db.prepare('DELETE FROM tasks WHERE id = ? OR parent_id = ?').run(id, id)
    return { ok: true }
  })
  ipcMain.handle('task:complete', async (_, id) => completeTask(id))
  ipcMain.handle('task:complete-with-subtasks', async (_, id) => completeTaskWithSubtasks(id))
  ipcMain.handle('task:uncomplete', async (_, id) => { uncompleteTask(id); return { ok: true } })
  ipcMain.handle('task:skip', async (_, id) => { skipTask(id); return { ok: true } })
  ipcMain.handle('task:activate', async (_, id) => { activateTask(id); return { ok: true } })
  ipcMain.handle('task:snooze', async (_, id, until) => { snoozeTask(id, until); return { ok: true } })
  ipcMain.handle('task:update-title', async (_, id, title) => {
    getDb().prepare('UPDATE tasks SET title = ?, last_touched_human = ? WHERE id = ?').run(title, nowIso(), id)
    return { ok: true }
  })
  ipcMain.handle('task:update-description', async (_, id, description) => {
    getDb().prepare('UPDATE tasks SET description = ?, last_touched_human = ? WHERE id = ?').run(description ?? null, nowIso(), id)
    return { ok: true }
  })
  ipcMain.handle('task:update-due-date', async (_, id, due_date) => {
    getDb().prepare('UPDATE tasks SET due_date = ?, last_touched_human = ? WHERE id = ?').run(due_date || null, nowIso(), id)
    return { ok: true }
  })
  ipcMain.handle('task:update-recurrence', async (_, id, recurrence) => {
    getDb().prepare('UPDATE tasks SET recurrence = ?, last_touched_human = ? WHERE id = ?').run(recurrence || null, nowIso(), id)
    return { ok: true }
  })
  ipcMain.handle('task:add-link', async (_, id, url) => {
    const db = getDb()
    const task = db.prepare('SELECT links FROM tasks WHERE id = ?').get(id)
    if (!task) throw new Error('Task not found')
    let links = []; try { links = JSON.parse(task.links || '[]') } catch {}
    if (!links.includes(url)) links.push(url)
    db.prepare("UPDATE tasks SET links = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(links), id)
    return { ok: true }
  })
  ipcMain.handle('task:reorder', async (_, ids) => { reorderTasks(ids); return { ok: true } })
  ipcMain.handle('task:create-subtask', async (_, parentId, title) => createSubtask(parentId, title))

  // Notes
  ipcMain.handle('notes:list', async (_, taskId) =>
    getDb().prepare(`SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC`).all(taskId)
  )
  ipcMain.handle('notes:add', async (_, taskId, body) => {
    if (!body?.trim()) throw new Error('body required')
    const id = uuidv4()
    getDb().prepare(`INSERT INTO notes (id, task_id, body, author) VALUES (?, ?, ?, 'user')`).run(id, taskId, body.trim())
    return { id }
  })

  // Daily notes
  ipcMain.handle('daily-note:get', async (_, date) => {
    const row = getDb().prepare('SELECT * FROM daily_notes WHERE date = ?').get(date)
    return { date, content: row?.content ?? '' }
  })
  ipcMain.handle('daily-note:save', async (_, date, content) => {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date')
    getDb().prepare(`INSERT INTO daily_notes (date, content, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(date) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`).run(date, content ?? '')
    return { ok: true }
  })

  // Contexts
  ipcMain.handle('contexts:list', async () =>
    getDb().prepare('SELECT * FROM contexts ORDER BY sort_order ASC NULLS LAST, label ASC').all()
  )
  ipcMain.handle('contexts:create', async (_, slug, label, color) => {
    if (!slug || !label) throw new Error('slug and label required')
    const db = getDb()
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM contexts').get().m ?? 0
    db.prepare('INSERT INTO contexts (slug, label, color, sort_order) VALUES (?, ?, ?, ?)').run(slug.trim().toLowerCase(), label.trim(), color ?? '#888888', maxOrder + 1)
    return { slug }
  })
  ipcMain.handle('contexts:update', async (_, slug, fields) => {
    const db = getDb()
    const sets = []; const params = []
    if (fields.label !== undefined) { sets.push('label = ?'); params.push(fields.label) }
    if (fields.color !== undefined) { sets.push('color = ?'); params.push(fields.color) }
    if (fields.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(fields.sort_order) }
    if (!sets.length) throw new Error('nothing to update')
    db.prepare(`UPDATE contexts SET ${sets.join(', ')} WHERE slug = ?`).run(...params, slug)
    return { ok: true }
  })
  ipcMain.handle('contexts:delete', async (_, slug) => {
    getDb().prepare('DELETE FROM contexts WHERE slug = ?').run(slug)
    return { ok: true }
  })

  // Habits
  ipcMain.handle('habits:list', async (_, date) => {
    const d = date ?? todayStr()
    const db = getDb()
    const allHabits = db.prepare('SELECT * FROM habits WHERE active = 1 ORDER BY created_at ASC').all()
    const dow = new Date(d + 'T00:00:00Z').getUTCDay()
    const daysFromMon = dow === 0 ? 6 : dow - 1
    const monday = offsetDate(d, -daysFromMon)
    const days = Array.from({ length: 7 }, (_, i) => offsetDate(monday, i))
    const logs = db.prepare(`SELECT * FROM habit_logs WHERE date >= ? AND date <= ?`).all(days[0], days[6])
    const logMap = {}
    for (const l of logs) logMap[`${l.habit_id}:${l.date}`] = l
    return allHabits.filter(h => isHabitDueOn(h, d)).map(h => ({
      ...h,
      today_log: logMap[`${h.id}:${d}`] ?? null,
      week: days.map(day => ({ date: day, due: isHabitDueOn(h, day), log: logMap[`${h.id}:${day}`] ?? null })),
    }))
  })
  ipcMain.handle('habits:create', async (_, body) => {
    if (!body.title) throw new Error('title required')
    const db = getDb()
    const id = crypto.randomUUID()
    const now = nowIso()
    db.prepare('INSERT INTO habits (id, title, description, recurrence, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(id, body.title.trim(), body.description ?? null, body.recurrence ?? 'daily', now, now)
    return { id }
  })
  ipcMain.handle('habits:log', async (_, habitId, date, status, notes) => {
    if (!habitId || !date) throw new Error('habit_id and date required')
    const id = crypto.randomUUID()
    getDb().prepare(`INSERT INTO habit_logs (id, habit_id, date, status, notes, created_at) VALUES (?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(habit_id, date) DO UPDATE SET status = excluded.status, notes = excluded.notes`).run(id, habitId, date, status ?? 'done', notes ?? null)
    return { ok: true }
  })
  ipcMain.handle('habits:unlog', async (_, habitId, date) => {
    if (!habitId || !date) throw new Error('habit_id and date required')
    getDb().prepare('DELETE FROM habit_logs WHERE habit_id = ? AND date = ?').run(habitId, date)
    return { ok: true }
  })

  // Attachments
  ipcMain.handle('attachments:list', async (_, taskId) => {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(taskId)
    const settings = loadSettings()
    const client = getS3Client(settings)
    return Promise.all(rows.map(async (a) => {
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
    const db = getDb()
    db.prepare(`INSERT INTO attachments (id, task_id, filename, mimetype, size_bytes, bucket, key, url, local_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, filename, mimeType, buffer.length, uploadedBucket, uploadedKey, url, localPath)
    return { ok: true, warning, attachment: { id, filename, url, local_path: localPath } }
  })
  ipcMain.handle('attachments:delete', async (_, id) => {
    const db = getDb()
    const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id)
    if (!att) throw new Error('Attachment not found')
    const settings = loadSettings()
    const client = getS3Client(settings)
    if (client && att.bucket && att.key) { try { await deleteFromS3(client, att.bucket, att.key) } catch {} }
    if (att.local_path && fs.existsSync(att.local_path)) { try { fs.unlinkSync(att.local_path) } catch {} }
    db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
    return { ok: true }
  })
  ipcMain.handle('attachments:sync', async () => {
    try { return { ok: true, ...(await syncPendingAttachments()) } } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('attachment:open', async (_, id) => {
    const att = getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id)
    if (att?.local_path && fs.existsSync(att.local_path)) await shell.openPath(att.local_path)
    return { ok: !!att }
  })

  // Agents
  ipcMain.handle('agents:list', async () => {
    const settings = loadSettings()
    return scanAgents(settings.terminalCwd || process.env.HOME)
  })
  ipcMain.handle('agent-jobs:list', async (_, taskId) => {
    const db = getDb()
    return taskId
      ? db.prepare(`SELECT * FROM agent_jobs WHERE task_id = ? ORDER BY created_at DESC`).all(taskId)
      : db.prepare(`SELECT * FROM agent_jobs ORDER BY created_at DESC LIMIT 50`).all()
  })
  ipcMain.handle('agent-jobs:get', async (_, id) => {
    const job = getDb().prepare('SELECT * FROM agent_jobs WHERE id = ?').get(id)
    if (!job) throw new Error('Job not found')
    return job
  })
  ipcMain.handle('agent-jobs:create', async (_, taskId, userMessage) => {
    const db = getDb()
    const task = taskId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) : null
    if (!task || !task.agent_path) throw new Error('task_id required and task must have agent_path')
    const existingNotes = db.prepare(`SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC`).all(taskId)
    const parts = [`Task: ${task.title}`]
    if (task.description) parts.push(task.description)
    if (existingNotes.length > 0) {
      parts.push('\n--- Conversation ---')
      for (const n of existingNotes) parts.push(`[${n.author}]: ${n.body}`)
    }
    if (userMessage) parts.push(`[user]: ${userMessage}`)
    const id = uuidv4()
    db.prepare(`INSERT INTO agent_jobs (id, task_id, agent_path, prompt, user_message) VALUES (?, ?, ?, ?, ?)`).run(id, taskId, task.agent_path, parts.join('\n'), userMessage ?? null)
    return { id, status: 'queued' }
  })

  // Settings
  ipcMain.handle('settings:get', async () => loadSettings())
  ipcMain.handle('settings:save', async (_, data) => { saveSettings(data); return { ok: true } })

  // MCP
  ipcMain.handle('mcp:status', async () => {
    const s = loadSettings()
    const port = parseInt(s.mcpPort ?? '3457', 10)
    let claudeJson = {}
    try { claudeJson = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8')) } catch {}
    const entry = claudeJson.mcpServers?.['task-os']
    const isHttpConfigured = entry?.type === 'http' && entry?.url === `http://localhost:${port}/mcp`
    return { port, isHttpConfigured, currentEntry: entry ?? null }
  })
  ipcMain.handle('mcp:apply', async (_, port, getWin) => {
    const p = parseInt(port, 10)
    if (isNaN(p) || p < 1024 || p > 65535) throw new Error('Invalid port')
    const s = loadSettings(); s.mcpPort = p; saveSettings(s)
    let claudeJson = {}
    try { claudeJson = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8')) } catch {}
    if (!claudeJson.mcpServers) claudeJson.mcpServers = {}
    claudeJson.mcpServers['task-os'] = { type: 'http', url: `http://localhost:${p}/mcp` }
    fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(claudeJson, null, 2))
    // Signal main process to restart MCP server
    if (getMcpProcessRef) getMcpProcessRef(p)
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

  // File system (mdpdf autosave + email preview)
  ipcMain.handle('file:read', async (_, filePath) => {
    const allowed = path.join(os.homedir(), 'IdeaProjects')
    if (!filePath.startsWith(allowed)) throw new Error('Forbidden')
    return fs.readFileSync(filePath, 'utf-8')
  })
  ipcMain.handle('file:write', async (_, filePath, contents) => {
    const allowed = path.join(os.homedir(), 'IdeaProjects')
    if (!filePath.startsWith(allowed)) throw new Error('Forbidden')
    if (typeof contents !== 'string') throw new Error('contents must be string')
    fs.writeFileSync(filePath, contents, 'utf-8')
    return { ok: true }
  })

  console.log('[ipc] handlers registered')
}
