// db-worker.js — SQLite on a dedicated Worker thread so the main thread never blocks.
// Main process sends { id, method, args } → receives { id, result } or { id, error }.

import { workerData, parentPort } from 'worker_threads'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import pkg from 'rrule'
const { rrulestr } = pkg

// ── Pure helpers ──────────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19) }
function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function appendAiContext(existing, note) {
  const entry = `[${today()}] ${note}`
  return existing ? `${existing}\n${entry}` : entry
}
function offsetDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
function nextRecurrenceDate(fromDate, rule) {
  if (!rule) return null
  const SHORTHANDS = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY' }
  try {
    // Anchor to midnight UTC on the day after fromDate — purely date-based, no current time involved.
    // This means completing at 1AM or 11PM gives the same next-day result.
    const dtstart = new Date(offsetDate(fromDate, 1) + 'T00:00:00Z')
    const r = rrulestr(`RRULE:${SHORTHANDS[rule] || rule}`, { dtstart })
    const next = r.after(dtstart, true) // inclusive: first occurrence on or after dtstart
    return next ? next.toISOString().slice(0, 10) : null
  } catch { return null }
}
function isHabitDueOn(habit, dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z')
  const dow = d.getUTCDay()
  switch (habit.recurrence) {
    case 'daily':    return true
    case 'weekdays': return dow >= 1 && dow <= 5
    case 'weekly': {
      const created = new Date(habit.created_at.substring(0, 10) + 'T12:00:00Z')
      return dow === created.getUTCDay()
    }
    case 'monthly': {
      const created = new Date(habit.created_at.substring(0, 10) + 'T12:00:00Z')
      return d.getUTCDate() === created.getUTCDate()
    }
    default: return true
  }
}

// ── Database init ─────────────────────────────────────────────────────────────

const db = new Database(workerData.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
migrate()

// ── Migration ─────────────────────────────────────────────────────────────────

function migrate() {
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
      slug         TEXT PRIMARY KEY,
      display_name TEXT,
      label        TEXT,
      color        TEXT NOT NULL DEFAULT '#888888',
      sort_order   INTEGER,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE TABLE IF NOT EXISTS projects (
      name       TEXT PRIMARY KEY,
      archived   INTEGER NOT NULL DEFAULT 0,
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
      id         TEXT PRIMARY KEY,
      habit_id   TEXT NOT NULL REFERENCES habits(id),
      date       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'done',
      notes      TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(habit_id, date)
    );
  `)

  const tryAlter = sql => { try { db.exec(sql) } catch {} }
  tryAlter('ALTER TABLE tasks RENAME COLUMN notes TO description')
  tryAlter('ALTER TABLE tasks ADD COLUMN description TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN notes TEXT')
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
  // Backfill label from display_name for rows created before label column existed
  tryAlter("UPDATE contexts SET label = display_name WHERE label IS NULL AND display_name IS NOT NULL")
  // Always ensure the default context exists
  db.prepare('INSERT OR IGNORE INTO contexts (slug, display_name, label, color, sort_order) VALUES (?, ?, ?, ?, ?)').run('personal', 'Personal', 'Personal', '#4fcc8a', 1)
  db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL WHERE status = 'snoozed' AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime'))`).run()
  // Backfill projects table from existing task project values
  db.prepare(`INSERT OR IGNORE INTO projects (name) SELECT DISTINCT project FROM tasks WHERE project IS NOT NULL AND project != ''`).run()
}

// ── Query helpers ─────────────────────────────────────────────────────────────

const ORDER = 'sort_order ASC NULLS LAST, my_priority ASC NULLS LAST, created_at ASC'

function attachSubtasks(tasks) {
  if (!tasks.length) return tasks
  const ids = tasks.map(t => `'${t.id.replace(/'/g, "''")}'`).join(',')
  const subs = db.prepare(`SELECT * FROM tasks WHERE parent_id IN (${ids}) ORDER BY sort_order ASC NULLS LAST, created_at ASC`).all()
  const byParent = {}
  for (const s of subs) { if (!byParent[s.parent_id]) byParent[s.parent_id] = []; byParent[s.parent_id].push(s) }
  return tasks.map(t => ({ ...t, subtasks: byParent[t.id] ?? [] }))
}

function stampAgentJobs(...arrays) {
  const jobs = db.prepare(`SELECT task_id, status FROM agent_jobs WHERE status IN ('queued','running') OR (status = 'done' AND completed_at >= datetime('now','-24 hours')) OR (status = 'failed' AND completed_at >= datetime('now','-24 hours')) ORDER BY created_at DESC`).all()
  if (!jobs.length) return
  const map = {}
  for (const j of jobs) { if (j.task_id && !map[j.task_id]) map[j.task_id] = j.status }
  for (const arr of arrays) for (const t of arr) { if (map[t.id]) t.agent_job_status = map[t.id] }
}

function autoRolloverRecurring() {
  const t = today()
  const stale = db.prepare(`SELECT * FROM tasks WHERE status = 'active' AND recurrence IS NOT NULL AND ((due_date IS NOT NULL AND due_date < ?) OR (due_date IS NULL AND start_date IS NOT NULL AND start_date < ?))`).all(t, t)
  const now = nowIso()
  for (const task of stale) {
    db.prepare(`UPDATE tasks SET status = 'done', outcome = 'skipped', last_touched_human = ?, ai_context = ? WHERE id = ?`).run(now, appendAiContext(task.ai_context, 'Auto-skipped: overdue recurring task.'), task.id)
    // Advance all the way to today-or-future in one shot to prevent cascade duplication
    // when autoRolloverRecurring runs multiple times (e.g. repeated UI refreshes).
    let baseDate = task.due_date ?? t
    let nextDate = nextRecurrenceDate(baseDate, task.recurrence)
    while (nextDate && nextDate < t) {
      baseDate = nextDate
      nextDate = nextRecurrenceDate(baseDate, task.recurrence)
    }
    if (nextDate) spawnRecurrence(task, nextDate, now, `Auto-recurred from task ${task.id}`)
  }
}

function spawnRecurrence(task, nextDate, now, reason) {
  db.prepare(`INSERT INTO tasks (id, title, description, status, my_priority, energy_required, context, project, tags, source, source_url, created_at, updated_at, start_date, due_date, task_type, recurrence, ai_context, agent_path, agent_resume, agent_autorun, agent_autorun_time) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), task.title, task.description, task.my_priority, task.energy_required, task.context, task.project, task.tags, task.source ?? 'manual', task.source_url, now, now, nextDate, nextDate, task.task_type, task.recurrence, appendAiContext(null, reason), task.agent_path ?? null, task.agent_resume ?? 1, task.agent_autorun ?? 0, task.agent_autorun_time ?? '09:00')
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

function getTasksForDate(date) {
  const t = today()
  const nextDay = offsetDate(date, 1)
  if (date === t) {
    autoRolloverRecurring()
    const overdue     = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'active' AND parent_id IS NULL AND due_date IS NOT NULL AND due_date < ? AND task_type = 'task' ORDER BY due_date ASC, ${ORDER}`).all(date))
    const dueToday    = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'active' AND parent_id IS NULL AND strftime('%Y-%m-%d', due_date) = ? AND task_type = 'task' AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime') OR strftime('%Y-%m-%d', due_date) <= ?) ORDER BY ${ORDER}`).all(date, date))
    const active      = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'active' AND parent_id IS NULL AND task_type = 'task' AND (due_date IS NULL OR due_date > ?) AND ((start_date IS NULL AND due_date IS NULL) OR (start_date IS NOT NULL AND start_date <= ?)) AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')) ORDER BY ${ORDER}`).all(date, date))
    const doneToday   = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND parent_id IS NULL AND last_touched_human >= ? AND last_touched_human < ? ORDER BY last_touched_human DESC`).all(date, nextDay))
    const events      = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE task_type = 'event' AND parent_id IS NULL AND status != 'done' AND (due_date = ? OR due_date IS NULL) ORDER BY event_time ASC NULLS LAST, created_at ASC`).all(date))
    const reminders   = db.prepare(`SELECT * FROM tasks WHERE task_type = 'reminder' AND parent_id IS NULL AND status != 'done' AND (due_date IS NULL OR due_date <= ?) AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')) ORDER BY ${ORDER}`).all(date)
    const timeSnoozed = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'snoozed' AND parent_id IS NULL AND task_type = 'task' AND strftime('%Y-%m-%d', due_date) = ? AND surface_after > strftime('%Y-%m-%d %H:%M', 'now', 'localtime') ORDER BY surface_after ASC`).all(date))
    const allHabits   = db.prepare('SELECT * FROM habits WHERE active = 1 ORDER BY created_at ASC').all()
    const todayHabits = allHabits.filter(h => isHabitDueOn(h, date))
    const habitLogs   = todayHabits.length ? db.prepare(`SELECT * FROM habit_logs WHERE date = ? AND habit_id IN (${todayHabits.map(() => '?').join(',')})`).all(date, ...todayHabits.map(h => h.id)) : []
    const habitLogMap = {}
    for (const l of habitLogs) habitLogMap[l.habit_id] = l
    const habits = todayHabits.map(h => ({ ...h, today_log: habitLogMap[h.id] ?? null }))
    stampAgentJobs(overdue, dueToday, active)
    return { view: 'today', date, overdue, dueToday, active, doneToday, timeSnoozed, events, reminders, habits }
  } else if (date > t) {
    const scheduled   = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE strftime('%Y-%m-%d', due_date) = ? AND parent_id IS NULL AND task_type = 'task' AND status != 'snoozed' ORDER BY status ASC, ${ORDER}`).all(date))
    const timeSnoozed = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE strftime('%Y-%m-%d', due_date) = ? AND parent_id IS NULL AND task_type = 'task' AND status = 'snoozed' ORDER BY surface_after ASC`).all(date))
    const events      = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE task_type = 'event' AND parent_id IS NULL AND status != 'done' AND due_date = ? ORDER BY event_time ASC NULLS LAST, created_at ASC`).all(date))
    const reminders   = db.prepare(`SELECT * FROM tasks WHERE task_type = 'reminder' AND parent_id IS NULL AND status != 'done' AND due_date = ? ORDER BY ${ORDER}`).all(date)
    stampAgentJobs(scheduled, timeSnoozed)
    return { view: 'future', date, scheduled, timeSnoozed, events, reminders }
  } else {
    const completed = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND parent_id IS NULL AND last_touched_human >= ? AND last_touched_human < ? ORDER BY last_touched_human DESC`).all(date, nextDay))
    const wasDue    = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE due_date = ? AND parent_id IS NULL ORDER BY status ASC, ${ORDER}`).all(date))
    return { view: 'past', date, completed, wasDue }
  }
}

function getTask(id) { return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null }
function getSubtasks(id) { return db.prepare(`SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC NULLS LAST, created_at ASC`).all(id) }
function getBacklog() { return db.prepare(`SELECT * FROM tasks WHERE status = 'backlog' AND parent_id IS NULL ORDER BY context ASC, project ASC NULLS LAST, sort_order ASC NULLS LAST, created_at ASC`).all() }

function createTask(body) {
  if (!body.title) throw new Error('title required')
  const id = crypto.randomUUID(); const now = nowIso()
  db.prepare(`INSERT INTO tasks (id, title, status, context, project, my_priority, due_date, agent_path, task_type, source, ai_context, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, 'task', 'manual', ?, ?, ?)`)
    .run(id, body.title, body.context ?? 'personal', body.project ?? null, body.my_priority ?? null, body.due_date || null, body.agent_path || null, body.ai_context ? `[${now.slice(0, 10)}] ${body.ai_context}` : null, now, now)
  if (body.project) db.prepare(`INSERT OR IGNORE INTO projects (name) VALUES (?)`).run(body.project)
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
}

function updateTask(id, body) {
  const MUTABLE = ['title','description','status','my_priority','energy_required','context','project','tags','source_url','due_date','start_date','surface_after','task_type','event_time','end_time','recurrence','parent_id','agent_path','agent_resume','agent_autorun','agent_autorun_time','outcome','notes']
  if (body.links !== undefined) db.prepare("UPDATE tasks SET links = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(body.links), id)
  const sets = []; const params = {}
  for (const f of MUTABLE) { if (body[f] !== undefined) { sets.push(`${f} = @${f}`); params[f] = body[f] === '' ? null : body[f] } }
  if (sets.length) { params.id = id; db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(params) }
  if (body.project) db.prepare(`INSERT OR IGNORE INTO projects (name) VALUES (?)`).run(body.project)
  return { ok: true }
}

function deleteTask(id) {
  db.prepare('DELETE FROM agent_jobs WHERE task_id = ?').run(id)
  db.prepare('DELETE FROM tasks WHERE id = ? OR parent_id = ?').run(id, id)
  return { ok: true }
}

function completeTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false, reason: 'not_found' }
  const { n } = db.prepare(`SELECT count(*) as n FROM tasks WHERE parent_id = ? AND status != 'done'`).get(id)
  if (n > 0) return { ok: false, reason: 'subtasks_incomplete', count: n }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'completed', last_touched_human = ?, ai_context = ? WHERE id = ?`).run(now, appendAiContext(task.ai_context, 'Marked complete via UI.'), id)
  if (task.recurrence) {
    const nextDate = nextRecurrenceDate(task.due_date ?? today(), task.recurrence)
    if (nextDate) spawnRecurrence(task, nextDate, now, `Recurred from task ${id}`)
  }
  return { ok: true }
}

function completeTaskWithSubtasks(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false, reason: 'not_found' }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', last_touched_human = ?, ai_context = ? WHERE parent_id = ? AND status != 'done'`).run(now, appendAiContext(null, 'Bulk-completed with parent via UI.'), id)
  db.prepare(`UPDATE tasks SET status = 'done', last_touched_human = ?, ai_context = ? WHERE id = ?`).run(now, appendAiContext(task.ai_context, 'Marked complete via UI (with subtasks).'), id)
  return { ok: true }
}

function uncompleteTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false }
  db.prepare(`UPDATE tasks SET status = 'active', last_touched_human = ?, ai_context = ? WHERE id = ?`).run(nowIso(), appendAiContext(task.ai_context, 'Reopened via UI.'), id)
  return { ok: true }
}

function skipTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task || !task.recurrence) return { ok: false }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'skipped', last_touched_human = ?, ai_context = ? WHERE id = ?`).run(now, appendAiContext(task.ai_context, 'Skipped via UI.'), id)
  const nextDate = nextRecurrenceDate(task.due_date ?? today(), task.recurrence)
  if (nextDate) spawnRecurrence(task, nextDate, now, `Recurred from task ${id}`)
  return { ok: true }
}

function activateTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false }
  db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL, ai_context = ?, last_touched_human = ? WHERE id = ?`).run(appendAiContext(task.ai_context, 'Activated via UI.'), nowIso(), id)
  return { ok: true }
}

function snoozeTask(id, until) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false }
  const hasTime = until.includes(' ') || until.includes('T')
  if (hasTime) {
    db.prepare(`UPDATE tasks SET status = 'snoozed', surface_after = ?, due_date = ?, ai_context = ?, last_touched_human = ? WHERE id = ?`).run(until, until.substring(0, 10), appendAiContext(task.ai_context, `Snoozed until ${until}.`), nowIso(), id)
  } else {
    db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL, due_date = ?, ai_context = ?, last_touched_human = ? WHERE id = ?`).run(until, appendAiContext(task.ai_context, `Deferred to ${until}.`), nowIso(), id)
  }
  return { ok: true }
}

function updateTaskTitle(id, title) { db.prepare('UPDATE tasks SET title = ?, last_touched_human = ? WHERE id = ?').run(title, nowIso(), id); return { ok: true } }
function updateTaskDescription(id, description) { db.prepare('UPDATE tasks SET description = ?, last_touched_human = ? WHERE id = ?').run(description ?? null, nowIso(), id); return { ok: true } }
function updateTaskDueDate(id, dueDate) { db.prepare('UPDATE tasks SET due_date = ?, last_touched_human = ? WHERE id = ?').run(dueDate || null, nowIso(), id); return { ok: true } }
function updateTaskRecurrence(id, recurrence) { db.prepare('UPDATE tasks SET recurrence = ?, last_touched_human = ? WHERE id = ?').run(recurrence || null, nowIso(), id); return { ok: true } }

function addTaskLink(id, url) {
  const task = db.prepare('SELECT links FROM tasks WHERE id = ?').get(id)
  if (!task) throw new Error('Task not found')
  let links = []; try { links = JSON.parse(task.links || '[]') } catch {}
  if (!links.includes(url)) links.push(url)
  db.prepare("UPDATE tasks SET links = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(links), id)
  return { ok: true }
}

function reorderTasks(ids) {
  const update = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?')
  db.transaction(list => { list.forEach((id, i) => update.run(i, id)) })(ids)
  return { ok: true }
}

function createSubtask(parentId, title) {
  const parent = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parentId)
  if (!parent) return null
  const id = crypto.randomUUID(); const now = nowIso()
  db.prepare(`INSERT INTO tasks (id, title, status, context, project, parent_id, source, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, 'manual', ?, ?)`).run(id, title, parent.context, parent.project, parentId, now, now)
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
}

// ── Notes ─────────────────────────────────────────────────────────────────────

function listNotes(taskId) { return db.prepare(`SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC`).all(taskId) }
function addNote(taskId, body) {
  if (!body?.trim()) throw new Error('body required')
  const id = crypto.randomUUID()
  db.prepare(`INSERT INTO notes (id, task_id, body, author) VALUES (?, ?, ?, 'user')`).run(id, taskId, body.trim())
  return { id }
}

// ── Daily notes ───────────────────────────────────────────────────────────────

function getDailyNote(date) {
  const row = db.prepare('SELECT * FROM daily_notes WHERE date = ?').get(date)
  return { date, content: row?.content ?? '' }
}
function saveDailyNote(date, content) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date')
  db.prepare(`INSERT INTO daily_notes (date, content, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(date) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`).run(date, content ?? '')
  return { ok: true }
}

// ── Contexts ──────────────────────────────────────────────────────────────────

function listContexts() { return db.prepare('SELECT * FROM contexts ORDER BY sort_order ASC NULLS LAST, label ASC').all() }
function createContext(slug, label, color) {
  if (!slug || !label) throw new Error('slug and label required')
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM contexts').get().m ?? 0
  const trimmedLabel = label.trim()
  db.prepare('INSERT INTO contexts (slug, display_name, label, color, sort_order) VALUES (?, ?, ?, ?, ?)').run(slug.trim().toLowerCase(), trimmedLabel, trimmedLabel, color ?? '#888888', maxOrder + 1)
  return { slug }
}
function updateContext(slug, fields) {
  const sets = []; const params = []
  if (fields.label !== undefined) { sets.push('label = ?'); params.push(fields.label); sets.push('display_name = ?'); params.push(fields.label) }
  if (fields.color !== undefined) { sets.push('color = ?'); params.push(fields.color) }
  if (fields.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(fields.sort_order) }
  if (!sets.length) throw new Error('nothing to update')
  db.prepare(`UPDATE contexts SET ${sets.join(', ')} WHERE slug = ?`).run(...params, slug)
  return { ok: true }
}
function deleteContext(slug) { db.prepare('DELETE FROM contexts WHERE slug = ?').run(slug); return { ok: true } }

// ── Projects ──────────────────────────────────────────────────────────────────

function listProjects(includeArchived = false) {
  return includeArchived
    ? db.prepare('SELECT * FROM projects ORDER BY archived ASC, name ASC').all()
    : db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY name ASC').all()
}
function archiveProject(name) { db.prepare('UPDATE projects SET archived = 1 WHERE name = ?').run(name); return { ok: true } }
function unarchiveProject(name) { db.prepare('UPDATE projects SET archived = 0 WHERE name = ?').run(name); return { ok: true } }
function deleteProject(name) { db.prepare('DELETE FROM projects WHERE name = ?').run(name); return { ok: true } }

// ── Habits ────────────────────────────────────────────────────────────────────

function listHabits(date) {
  const d = date ?? today()
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
}
function createHabit(body) {
  if (!body.title) throw new Error('title required')
  const id = crypto.randomUUID(); const now = nowIso()
  db.prepare('INSERT INTO habits (id, title, description, recurrence, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(id, body.title.trim(), body.description ?? null, body.recurrence ?? 'daily', now, now)
  return { id }
}
function logHabit(habitId, date, status, notes) {
  if (!habitId || !date) throw new Error('habit_id and date required')
  db.prepare(`INSERT INTO habit_logs (id, habit_id, date, status, notes, created_at) VALUES (?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(habit_id, date) DO UPDATE SET status = excluded.status, notes = excluded.notes`).run(crypto.randomUUID(), habitId, date, status ?? 'done', notes ?? null)
  return { ok: true }
}
function unlogHabit(habitId, date) {
  db.prepare('DELETE FROM habit_logs WHERE habit_id = ? AND date = ?').run(habitId, date)
  return { ok: true }
}

// ── Attachments ───────────────────────────────────────────────────────────────

function listAttachments(taskId) { return db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(taskId) }
function insertAttachment(data) {
  const { id, taskId, filename, mimeType, sizeBytes, bucket, key, url, localPath } = data
  db.prepare(`INSERT INTO attachments (id, task_id, filename, mimetype, size_bytes, bucket, key, url, local_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, filename, mimeType, sizeBytes, bucket, key, url, localPath)
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id)
}
function getAttachment(id) { return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) ?? null }
function deleteAttachment(id) { db.prepare('DELETE FROM attachments WHERE id = ?').run(id); return { ok: true } }
function getPendingAttachments() { return db.prepare(`SELECT * FROM attachments WHERE bucket IS NULL AND local_path IS NOT NULL`).all() }
function updateAttachmentStorage(id, bucket, key, url) {
  db.prepare(`UPDATE attachments SET bucket = ?, key = ?, url = ? WHERE id = ?`).run(bucket, key, url, id)
  return { ok: true }
}

// ── Agent jobs ────────────────────────────────────────────────────────────────

function listAgentJobs(taskId) {
  return taskId
    ? db.prepare(`SELECT * FROM agent_jobs WHERE task_id = ? ORDER BY created_at DESC`).all(taskId)
    : db.prepare(`SELECT * FROM agent_jobs ORDER BY created_at DESC LIMIT 50`).all()
}
function getAgentJob(id) {
  const job = db.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(id)
  if (!job) throw new Error('Job not found')
  return job
}
function createAgentJob(taskId, userMessage) {
  const task = taskId ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) : null
  if (!task || !task.agent_path) throw new Error('task_id required and task must have agent_path')
  const existingNotes = db.prepare(`SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC`).all(taskId)
  const parts = [
    `You are an agent running inside Task OS. Task ID: ${taskId}`,
    `If you create any output files, save them to ${task.agent_path}/output/ and include their paths in your response so Task OS can link them back to this task.`,
    `Task: ${task.title}`
  ]
  if (task.description) parts.push(task.description)
  if (existingNotes.length > 0) {
    parts.push('\n--- Conversation ---')
    for (const n of existingNotes) parts.push(`[${n.author}]: ${n.body}`)
  }
  if (userMessage) parts.push(`[user]: ${userMessage}`)
  const id = crypto.randomUUID()
  db.prepare(`INSERT INTO agent_jobs (id, task_id, agent_path, prompt, user_message) VALUES (?, ?, ?, ?, ?)`).run(id, taskId, task.agent_path, parts.join('\n'), userMessage ?? null)
  return { id, status: 'queued' }
}
function getQueuedJobs(limit) {
  const jobs = db.prepare(`SELECT * FROM agent_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`).all(limit)
  return jobs.map(job => {
    const task = job.task_id ? db.prepare('SELECT agent_resume FROM tasks WHERE id = ?').get(job.task_id) : null
    const canResume = task?.agent_resume !== 0
    const prev = canResume && job.task_id
      ? db.prepare(`SELECT session_id FROM agent_jobs WHERE task_id = ? AND session_id IS NOT NULL AND status = 'done' ORDER BY completed_at DESC LIMIT 1`).get(job.task_id)
      : null
    return { ...job, prevSessionId: prev?.session_id ?? null }
  })
}
function startAgentJob(id) { db.prepare(`UPDATE agent_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?`).run(id); return { ok: true } }
function finishAgentJob(id, status, result, sessionId) {
  db.prepare(`UPDATE agent_jobs SET status = ?, result = ?, session_id = ?, completed_at = datetime('now') WHERE id = ?`).run(status, result, sessionId, id)
  return { ok: true }
}
function insertAgentNote(id, taskId, result, jobId) {
  db.prepare(`INSERT INTO notes (id, task_id, body, author, agent_job_id) VALUES (?, ?, ?, 'agent', ?)`).run(id, taskId, result, jobId)
  return { ok: true }
}
function resetStuckJobs() { db.prepare(`UPDATE agent_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`).run(); return { ok: true } }
function getAutorunTasks() {
  return db.prepare(`SELECT t.* FROM tasks t WHERE t.agent_path IS NOT NULL AND t.agent_autorun = 1 AND t.status = 'active' AND (t.due_date IS NULL OR t.due_date <= date('now')) AND time('now', 'localtime') >= COALESCE(t.agent_autorun_time, '09:00') AND NOT EXISTS (SELECT 1 FROM agent_jobs j WHERE j.task_id = t.id)`).all()
}
function insertAutorunJob(taskId, agentPath, prompt) {
  const fullPrompt = `You are an agent running inside Task OS. Task ID: ${taskId}\nIf you create any output files, save them to ${agentPath}/output/ and include their paths in your response so Task OS can link them back to this task.\n${prompt}`
  db.prepare(`INSERT INTO agent_jobs (id, task_id, agent_path, prompt) VALUES (?, ?, ?, ?)`).run(crypto.randomUUID(), taskId, agentPath, fullPrompt)
  return { ok: true }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const METHODS = {
  getTasksForDate, getTask, getSubtasks, getBacklog,
  createTask, updateTask, deleteTask,
  completeTask, completeTaskWithSubtasks, uncompleteTask,
  skipTask, activateTask, snoozeTask,
  updateTaskTitle, updateTaskDescription, updateTaskDueDate, updateTaskRecurrence,
  addTaskLink, reorderTasks, createSubtask,
  listNotes, addNote,
  getDailyNote, saveDailyNote,
  listContexts, createContext, updateContext, deleteContext,
  listProjects, archiveProject, unarchiveProject, deleteProject,
  listHabits, createHabit, logHabit, unlogHabit,
  listAttachments, insertAttachment, getAttachment, deleteAttachment,
  getPendingAttachments, updateAttachmentStorage,
  listAgentJobs, getAgentJob, createAgentJob,
  getQueuedJobs, startAgentJob, finishAgentJob, insertAgentNote,
  resetStuckJobs, getAutorunTasks, insertAutorunJob,
}

parentPort.on('message', ({ id, method, args }) => {
  const fn = METHODS[method]
  if (!fn) { parentPort.postMessage({ id, error: `Unknown method: ${method}` }); return }
  try {
    parentPort.postMessage({ id, result: fn(...(args ?? [])) })
  } catch (err) {
    parentPort.postMessage({ id, error: err.message })
  }
})

parentPort.postMessage({ ready: true })
