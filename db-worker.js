// db-worker.js — SQLite on a dedicated Worker thread so the main thread never blocks.
// Main process sends { id, method, args } → receives { id, result } or { id, error }.

import { workerData, parentPort } from 'worker_threads'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import pkg from 'rrule'
import {
  ensureCapabilitySchema,
  getCapability,
  listCapabilities,
  searchCapabilities,
  upsertScannedCapabilities,
} from './server/capability-registry.js'
import { ensureDailyNoteSearchSchema, searchDailyNotes } from './server/daily-note-search.js'
import { autoAttachMentionedFiles } from './server/mentioned-files.js'
const { rrulestr } = pkg

// ── Pure helpers ──────────────────────────────────────────────────────────────

function nowIso() {
  // Local wall-clock time, NOT UTC (bug C10). Must match the day-bucketing queries (which use
  // strftime('now','localtime')) and mcp/db.js's nowIso, so evening completions on a negative-UTC
  // box bucket to the correct local day instead of tomorrow. Only affects human/day-facing columns
  // (last_touched_human, last_reviewed_at, created_at); heartbeat next_run_at scheduling stays UTC
  // via addMinutesFromNow/nextRunAt, which are compared against datetime('now').
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
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
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000)
function nextRecurrenceDate(baseDate, rule) {
  if (!rule) return null
  const SHORTHANDS = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY' }
  try {
    let rruleStr = SHORTHANDS[rule] || rule
    // Anchor to midnight UTC on baseDate (the task's own schedule anchor), then use exclusive
    // after() so we get the NEXT occurrence strictly after baseDate without shifting the
    // weekday/monthday anchor. Using day+1 with inclusive after() collapsed bare FREQ=WEEKLY /
    // FREQ=MONTHLY to next-day, because dtstart itself is the rule's first occurrence (bug C1).
    const dtstart = new Date(baseDate + 'T00:00:00Z')
    // FREQ=MONTHLY without BYMONTHDAY anchors to dtstart's day-of-month, causing 1-day drift on
    // each completion. Explicitly anchor to baseDate's day-of-month.
    if (rruleStr === 'FREQ=MONTHLY') {
      const dom = parseInt(baseDate.slice(8, 10), 10)
      rruleStr = `FREQ=MONTHLY;BYMONTHDAY=${dom}`
    }
    const r = rrulestr(`RRULE:${rruleStr}`, { dtstart })
    const next = r.after(dtstart, false) // exclusive: first occurrence strictly after baseDate
    return next ? next.toISOString().slice(0, 10) : null
  } catch { return null }
}
const DAY_ABBR_TO_DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
function isHabitDueOn(habit, dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z')
  const dow = d.getUTCDay()
  if (habit.recurrence_days) {
    const days = habit.recurrence_days.split(',').map(s => DAY_ABBR_TO_DOW[s.trim()]).filter(n => n !== undefined)
    return days.includes(dow)
  }
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
      hard_deadline       INTEGER NOT NULL DEFAULT 0,
      start_date          TEXT,
      surface_after       TEXT,
      last_reviewed_at    TEXT,
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
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id),
      blocked_by_task_id TEXT NOT NULL REFERENCES tasks(id),
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, blocked_by_task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocked_by ON task_dependencies(blocked_by_task_id);
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
    CREATE TABLE IF NOT EXISTS heartbeats (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      description      TEXT,
      agent_path       TEXT NOT NULL,
      prompt           TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      active           INTEGER NOT NULL DEFAULT 1,
      last_run_at      TEXT,
      next_run_at      TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE TABLE IF NOT EXISTS agents (
      path         TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      context      TEXT,
      project      TEXT,
      description  TEXT,
      command      TEXT,
      coding       INTEGER NOT NULL DEFAULT 0,
      relative_path TEXT,
      folder       TEXT,
      last_seen    TEXT NOT NULL DEFAULT (datetime('now'))
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
  ensureCapabilitySchema(db)
  ensureDailyNoteSearchSchema(db)

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
  tryAlter('ALTER TABLE tasks ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0')
  tryAlter('ALTER TABLE tasks ADD COLUMN hard_deadline INTEGER NOT NULL DEFAULT 0')
  tryAlter('ALTER TABLE tasks ADD COLUMN last_reviewed_at TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN time_estimate INTEGER')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN session_id TEXT')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN user_message TEXT')
  tryAlter('ALTER TABLE contexts ADD COLUMN label TEXT')
  tryAlter("ALTER TABLE contexts ADD COLUMN color TEXT NOT NULL DEFAULT '#888888'")
  tryAlter('ALTER TABLE contexts ADD COLUMN sort_order INTEGER')
  tryAlter('ALTER TABLE habits ADD COLUMN recurrence_days TEXT')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN heartbeat_id TEXT REFERENCES heartbeats(id)')
  tryAlter('ALTER TABLE heartbeats ADD COLUMN run_at_time TEXT')
  tryAlter('ALTER TABLE heartbeats ADD COLUMN minute_offset INTEGER')
  tryAlter('ALTER TABLE tasks ADD COLUMN assigned_agent TEXT')
  tryAlter('ALTER TABLE projects ADD COLUMN is_repo INTEGER NOT NULL DEFAULT 0')
  tryAlter('ALTER TABLE projects ADD COLUMN context TEXT')
  tryAlter('ALTER TABLE attachments ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0')
  db.prepare(`UPDATE tasks SET last_reviewed_at = COALESCE(last_touched_human, created_at, datetime('now')) WHERE last_reviewed_at IS NULL`).run()
  // Backfill projects.context from the most common task context per project
  db.exec(`
    UPDATE projects SET context = (
      SELECT t.context FROM tasks t
      WHERE t.project = projects.name AND t.context IS NOT NULL AND t.status != 'archived'
      GROUP BY t.context ORDER BY COUNT(*) DESC LIMIT 1
    ) WHERE context IS NULL
  `)
  // Backfill label from display_name for rows created before label column existed
  tryAlter("UPDATE contexts SET label = display_name WHERE label IS NULL AND display_name IS NOT NULL")
  // Always ensure the default context exists
  db.prepare('INSERT OR IGNORE INTO contexts (slug, display_name, label, color, sort_order) VALUES (?, ?, ?, ?, ?)').run('personal', 'Personal', 'Personal', '#4fcc8a', 1)
  db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL WHERE status = 'snoozed' AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime'))`).run()
  // Backfill projects table from existing task project values
  db.prepare(`INSERT OR IGNORE INTO projects (name) SELECT DISTINCT project FROM tasks WHERE project IS NOT NULL AND project != ''`).run()
  // Bug C3 cleanup: MCP update_task used to store '' instead of NULL when clearing these
  // reference fields, hiding tasks from every top-level list (parent_id IS NULL filter).
  // Idempotent — repairs any rows already corrupted before the handler fix landed.
  db.prepare(`UPDATE tasks SET parent_id = NULL WHERE parent_id = ''`).run()
  db.prepare(`UPDATE tasks SET agent_path = NULL WHERE agent_path = ''`).run()
  db.prepare(`UPDATE tasks SET assigned_agent = NULL WHERE assigned_agent = ''`).run()
}

// ── Query helpers ─────────────────────────────────────────────────────────────

const ORDER = 'sort_order ASC NULLS LAST, my_priority ASC NULLS LAST, created_at ASC'
const MS_PER_DAY = 24 * 60 * 60 * 1000
const DEFAULT_ACTIVE_REVIEW_DAYS = 14
const DEFAULT_BACKLOG_REVIEW_DAYS = 30

function datePart(value) {
  if (!value) return null
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : null
}

function daysSince(value) {
  const date = datePart(value)
  if (!date) return null
  const now = new Date()
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const thenUtc = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(thenUtc)) return null
  return Math.floor((todayUtc - thenUtc) / MS_PER_DAY)
}

function reviewSignal(task) {
  const eligible = (task.status === 'active' || task.status === 'backlog') && task.task_type !== 'event' && !task.recurrence
  if (!eligible) return { stale: false, stale_days: null, review_threshold_days: null }
  const threshold = task.status === 'backlog' ? DEFAULT_BACKLOG_REVIEW_DAYS : DEFAULT_ACTIVE_REVIEW_DAYS
  const age = daysSince(task.last_reviewed_at ?? task.created_at)
  return {
    stale: age != null && age > threshold,
    stale_days: age,
    review_threshold_days: threshold,
  }
}

function dependencySummary(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    context: row.context,
    project: row.project,
    due_date: row.due_date,
    hard_deadline: row.hard_deadline === 1 || row.hard_deadline === true,
    completed: row.status === 'done',
    dependency_created_at: row.dependency_created_at ?? null,
  }
}

function attachTrustSignals(tasks) {
  if (!tasks.length) return tasks
  const ids = tasks.map(t => t.id)
  const placeholders = ids.map(() => '?').join(',')
  const blockedByRows = db.prepare(`
    SELECT
      d.task_id AS relation_task_id,
      d.created_at AS dependency_created_at,
      b.id, b.title, b.status, b.context, b.project, b.due_date, b.hard_deadline
    FROM task_dependencies d
    JOIN tasks b ON b.id = d.blocked_by_task_id
    WHERE d.task_id IN (${placeholders})
    ORDER BY b.title COLLATE NOCASE
  `).all(...ids)
  const blocksRows = db.prepare(`
    SELECT
      d.blocked_by_task_id AS relation_task_id,
      d.created_at AS dependency_created_at,
      t.id, t.title, t.status, t.context, t.project, t.due_date, t.hard_deadline
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id
    WHERE d.blocked_by_task_id IN (${placeholders})
    ORDER BY t.title COLLATE NOCASE
  `).all(...ids)
  const blockedBy = {}
  for (const row of blockedByRows) {
    if (!blockedBy[row.relation_task_id]) blockedBy[row.relation_task_id] = []
    blockedBy[row.relation_task_id].push(dependencySummary(row))
  }
  const blocks = {}
  for (const row of blocksRows) {
    if (!blocks[row.relation_task_id]) blocks[row.relation_task_id] = []
    blocks[row.relation_task_id].push(dependencySummary(row))
  }
  return tasks.map(task => {
    const blocked_by = blockedBy[task.id] ?? []
    return {
      ...task,
      hard_deadline: task.hard_deadline === 1 || task.hard_deadline === true,
      ...reviewSignal(task),
      blocked: blocked_by.some(dep => !dep.completed),
      blocked_by,
      blocks: blocks[task.id] ?? [],
    }
  })
}

function attachSubtasks(tasks) {
  if (!tasks.length) return tasks
  const ids = tasks.map(t => `'${t.id.replace(/'/g, "''")}'`).join(',')
  const subs = db.prepare(`SELECT * FROM tasks WHERE parent_id IN (${ids}) ORDER BY sort_order ASC NULLS LAST, created_at ASC`).all()
  const byParent = {}
  for (const s of subs) { if (!byParent[s.parent_id]) byParent[s.parent_id] = []; byParent[s.parent_id].push(s) }
  const attCounts = db.prepare(`SELECT task_id, COUNT(*) as cnt FROM attachments WHERE task_id IN (${ids}) GROUP BY task_id`).all()
  const attByTask = {}
  for (const r of attCounts) attByTask[r.task_id] = r.cnt
  return attachTrustSignals(tasks.map(t => ({ ...t, subtasks: byParent[t.id] ?? [], attachment_count: attByTask[t.id] ?? 0 })))
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
  const stale = db.prepare(`SELECT * FROM tasks WHERE status = 'active' AND task_type != 'event' AND recurrence IS NOT NULL AND ((due_date IS NOT NULL AND due_date < ?) OR (due_date IS NULL AND start_date IS NOT NULL AND start_date < ?))`).all(t, t)
  const now = nowIso()
  // Transaction + compare-and-set claim (bug C12): the MCP briefing runs the same rollover on a
  // separate connection, so two concurrent runs can both read a task as 'active' and both spawn.
  // Flipping active->done only WHERE status='active' means exactly one writer wins; the loser
  // (changes===0) skips the spawn. Also prevents cascade duplication across repeated UI refreshes.
  const rollover = db.transaction((tasks) => {
    for (const task of tasks) {
      const claim = db.prepare(`UPDATE tasks SET status = 'done', outcome = 'skipped', last_touched_human = ?, ai_context = ? WHERE id = ? AND status = 'active'`).run(now, appendAiContext(task.ai_context, 'Auto-skipped: overdue recurring task.'), task.id)
      if (claim.changes !== 1) continue
      // Advance all the way to today-or-future in one shot to preserve cadence alignment.
      let baseDate = task.due_date ?? task.start_date ?? t
      let nextDate = nextRecurrenceDate(baseDate, task.recurrence)
      while (nextDate && nextDate < t) {
        baseDate = nextDate
        nextDate = nextRecurrenceDate(baseDate, task.recurrence)
      }
      if (nextDate) spawnRecurrence(task, nextDate, now, `Auto-recurred from task ${task.id}`)
    }
  })
  rollover(stale)
}

function spawnRecurrence(task, nextDate, now, reason) {
  // Preserve start→due span for multi-day recurring tasks.
  // nextDate is always the new due_date anchor (or start_date if original had no due_date).
  let spawnedStart = null
  let spawnedDue = nextDate
  if (task.start_date && task.due_date) {
    spawnedStart = offsetDate(nextDate, -daysBetween(task.start_date, task.due_date))
  } else if (task.start_date && !task.due_date) {
    spawnedStart = nextDate
    spawnedDue = null
  }
  // time_estimate + inbox preserved across respawn (bug C15 — shared gap with the MCP copy).
  db.prepare(`INSERT INTO tasks (id, title, description, notes, links, status, my_priority, energy_required, context, project, tags, source, source_url, created_at, updated_at, last_reviewed_at, start_date, due_date, hard_deadline, task_type, recurrence, ai_context, time_estimate, inbox, agent_path, agent_resume, agent_autorun, agent_autorun_time) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), task.title, task.description, task.notes ?? null, task.links ?? null, task.my_priority, task.energy_required, task.context, task.project, task.tags, task.source ?? 'manual', task.source_url, now, now, now, spawnedStart, spawnedDue, task.hard_deadline ? 1 : 0, task.task_type, task.recurrence, appendAiContext(null, reason), task.time_estimate ?? null, task.inbox ?? 0, task.agent_path ?? null, task.agent_resume ?? 1, task.agent_autorun ?? 0, task.agent_autorun_time ?? '09:00')
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

function getTasksForDate(date) {
  const t = today()
  const nextDay = offsetDate(date, 1)
  if (date === t) {
    db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL WHERE status = 'snoozed' AND surface_after IS NOT NULL AND surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')`).run()
    autoRolloverRecurring()
    // Auto-complete past events and timed events whose end time has passed
    db.prepare(`
      UPDATE tasks SET status = 'done',
        last_touched_human = strftime('%Y-%m-%d %H:%M', 'now', 'localtime'),
        updated_at = strftime('%Y-%m-%d %H:%M', 'now', 'localtime')
      WHERE task_type = 'event' AND status NOT IN ('done', 'archived')
      AND (
        (due_date IS NOT NULL AND due_date < ?)
        OR (due_date = ? AND event_time IS NOT NULL
            AND time(COALESCE(end_time, time(event_time, '+1 hour'))) <= time('now', 'localtime'))
      )
    `).run(date, date)
    const inbox       = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE inbox = 1 AND status = 'active' AND parent_id IS NULL AND task_type = 'task' ORDER BY created_at DESC`).all())
    const overdue     = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE inbox = 0 AND status = 'active' AND parent_id IS NULL AND due_date IS NOT NULL AND due_date < ? AND task_type = 'task' ORDER BY due_date ASC, ${ORDER}`).all(date))
    const dueToday    = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE inbox = 0 AND status = 'active' AND parent_id IS NULL AND strftime('%Y-%m-%d', due_date) = ? AND task_type = 'task' AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime') OR strftime('%Y-%m-%d', due_date) <= ?) ORDER BY ${ORDER}`).all(date, date))
    const active      = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE inbox = 0 AND status = 'active' AND parent_id IS NULL AND task_type = 'task' AND (due_date IS NULL OR due_date > ?) AND ((start_date IS NULL AND due_date IS NULL) OR (start_date IS NOT NULL AND start_date <= ?)) AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')) ORDER BY ${ORDER}`).all(date, date))
    const doneToday   = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND parent_id IS NULL AND task_type != 'event' AND last_touched_human >= ? AND last_touched_human < ? ORDER BY last_touched_human DESC`).all(date, nextDay))
    const events      = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE task_type = 'event' AND parent_id IS NULL AND (due_date = ? OR due_date IS NULL) ORDER BY event_time ASC NULLS LAST, created_at ASC`).all(date))
    const reminders   = db.prepare(`SELECT * FROM tasks WHERE task_type = 'reminder' AND parent_id IS NULL AND status != 'done' AND (due_date IS NULL OR due_date <= ?) AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')) ORDER BY ${ORDER}`).all(date)
    const timeSnoozed = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'snoozed' AND parent_id IS NULL AND task_type = 'task' AND strftime('%Y-%m-%d', due_date) = ? AND surface_after > strftime('%Y-%m-%d %H:%M', 'now', 'localtime') ORDER BY surface_after ASC`).all(date))
    const allHabits   = db.prepare('SELECT * FROM habits WHERE active = 1 ORDER BY created_at ASC').all()
    const todayHabits = allHabits.filter(h => isHabitDueOn(h, date))
    const habitLogs   = todayHabits.length ? db.prepare(`SELECT * FROM habit_logs WHERE date = ? AND habit_id IN (${todayHabits.map(() => '?').join(',')})`).all(date, ...todayHabits.map(h => h.id)) : []
    const habitLogMap = {}
    for (const l of habitLogs) habitLogMap[l.habit_id] = l
    const habits = todayHabits.map(h => ({ ...h, today_log: habitLogMap[h.id] ?? null }))
    stampAgentJobs(inbox, overdue, dueToday, active)
    return { view: 'today', date, inbox, overdue, dueToday, active, doneToday, timeSnoozed, events, reminders, habits }
  } else if (date > t) {
    const scheduled   = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE strftime('%Y-%m-%d', due_date) = ? AND parent_id IS NULL AND task_type = 'task' AND status = 'active' ORDER BY ${ORDER}`).all(date))
    const timeSnoozed = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE strftime('%Y-%m-%d', due_date) = ? AND parent_id IS NULL AND task_type = 'task' AND status = 'snoozed' ORDER BY surface_after ASC`).all(date))
    const events      = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE task_type = 'event' AND parent_id IS NULL AND status != 'done' AND due_date = ? ORDER BY event_time ASC NULLS LAST, created_at ASC`).all(date))
    const reminders   = db.prepare(`SELECT * FROM tasks WHERE task_type = 'reminder' AND parent_id IS NULL AND status != 'done' AND due_date = ? ORDER BY ${ORDER}`).all(date)
    stampAgentJobs(scheduled, timeSnoozed)
    return { view: 'future', date, scheduled, timeSnoozed, events, reminders }
  } else {
    const completed = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND parent_id IS NULL AND task_type = 'task' AND last_touched_human >= ? AND last_touched_human < ? ORDER BY last_touched_human DESC`).all(date, nextDay))
    const wasDue    = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE due_date = ? AND parent_id IS NULL AND task_type = 'task' ORDER BY status ASC, ${ORDER}`).all(date))
    const events    = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE task_type = 'event' AND parent_id IS NULL AND due_date = ? ORDER BY event_time ASC NULLS LAST, created_at ASC`).all(date))
    return { view: 'past', date, completed, wasDue, events }
  }
}

function getTask(id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  return row ? attachTrustSignals([row])[0] : null
}
function getSubtasks(id) { return attachTrustSignals(db.prepare(`SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC NULLS LAST, created_at ASC`).all(id)) }
function getBacklog() { return attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'backlog' AND parent_id IS NULL ORDER BY context ASC, project ASC NULLS LAST, sort_order ASC NULLS LAST, created_at ASC`).all()) }

function getCodingTasks() {
  const tasks = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE task_type = 'coding' AND status NOT IN ('done','archived') AND parent_id IS NULL ORDER BY created_at DESC`).all())
  stampAgentJobs(tasks)
  return tasks
}

function getReadingTasks() {
  return attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE task_type = 'reading' AND status NOT IN ('done','archived') AND parent_id IS NULL ORDER BY my_priority ASC NULLS LAST, created_at DESC`).all())
}

function searchTasks(args = {}) {
  const query = String(args.query ?? '').trim()
  if (!query) return []

  const scope = args.scope === 'all' ? 'all' : 'open'
  const rawLimit = Number(args.limit ?? 80)
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 80
  const statusClause = scope === 'all' ? '' : "AND status NOT IN ('done','archived')"
  const like = `%${query.toLowerCase()}%`
  const rows = db.prepare(`
    SELECT * FROM tasks
    WHERE parent_id IS NULL
      ${statusClause}
      AND (
        lower(coalesce(title, '')) LIKE @like OR
        lower(coalesce(description, '')) LIKE @like OR
        lower(coalesce(notes, '')) LIKE @like OR
        lower(coalesce(ai_context, '')) LIKE @like OR
        lower(coalesce(context, '')) LIKE @like OR
        lower(coalesce(project, '')) LIKE @like OR
        lower(coalesce(tags, '')) LIKE @like OR
        lower(coalesce(source, '')) LIKE @like OR
        lower(coalesce(source_url, '')) LIKE @like
      )
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        WHEN 'backlog' THEN 1
        WHEN 'snoozed' THEN 2
        WHEN 'done' THEN 3
        WHEN 'archived' THEN 4
        ELSE 5
      END,
      CASE task_type
        WHEN 'task' THEN 0
        WHEN 'coding' THEN 1
        WHEN 'reading' THEN 2
        WHEN 'reminder' THEN 3
        WHEN 'event' THEN 4
        ELSE 5
      END,
      sort_order ASC NULLS LAST,
      my_priority ASC NULLS LAST,
      coalesce(last_touched_human, updated_at, created_at) DESC
    LIMIT @limit
  `).all({ like, limit })
  const tasks = attachSubtasks(rows)
  stampAgentJobs(tasks)
  return tasks
}

function createTask(body) {
  if (!body.title) throw new Error('title required')
  const id = crypto.randomUUID(); const now = nowIso()
  db.prepare(`INSERT INTO tasks (id, title, status, context, project, my_priority, due_date, hard_deadline, agent_path, task_type, source, ai_context, created_at, updated_at, last_reviewed_at) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, 'task', 'manual', ?, ?, ?, ?)`)
    .run(id, body.title, body.context ?? 'personal', body.project ?? null, body.my_priority ?? null, body.due_date || null, body.hard_deadline ? 1 : 0, body.agent_path || null, body.ai_context ? `[${now.slice(0, 10)}] ${body.ai_context}` : null, now, now, now)
  if (body.project) db.prepare(`INSERT OR IGNORE INTO projects (name) VALUES (?)`).run(body.project)
  return getTask(id)
}

function updateTask(id, body) {
  const MUTABLE = ['title','description','status','my_priority','energy_required','context','project','tags','source_url','due_date','hard_deadline','start_date','surface_after','task_type','event_time','end_time','recurrence','parent_id','agent_path','agent_resume','agent_autorun','agent_autorun_time','outcome','notes','inbox','time_estimate']
  const now = nowIso()
  if (body.links !== undefined) db.prepare("UPDATE tasks SET links = ?, updated_at = datetime('now'), last_reviewed_at = ? WHERE id = ?").run(JSON.stringify(body.links), now, id)
  const sets = []; const params = {}
  for (const f of MUTABLE) { if (body[f] !== undefined) { sets.push(`${f} = @${f}`); const v = body[f] === '' ? null : body[f]; params[f] = typeof v === 'boolean' ? (v ? 1 : 0) : v } }
  if (sets.length) {
    params.id = id
    params.last_reviewed_at = now
    db.prepare(`UPDATE tasks SET ${sets.join(', ')}, last_reviewed_at = @last_reviewed_at, updated_at = datetime('now') WHERE id = @id`).run(params)
  }
  if (body.project) db.prepare(`INSERT OR IGNORE INTO projects (name) VALUES (?)`).run(body.project)
  return { ok: true }
}

function deleteTask(id) {
  const subtaskIds = db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(id).map(r => r.id)
  const allIds = [id, ...subtaskIds]
  const ph = allIds.map(() => '?').join(',')
  db.prepare(`DELETE FROM task_dependencies WHERE task_id IN (${ph}) OR blocked_by_task_id IN (${ph})`).run(...allIds, ...allIds)
  db.prepare(`DELETE FROM notes       WHERE task_id IN (${ph})`).run(...allIds)
  db.prepare(`DELETE FROM agent_jobs  WHERE task_id IN (${ph})`).run(...allIds)
  db.prepare(`DELETE FROM attachments WHERE task_id IN (${ph})`).run(...allIds)
  db.prepare(`DELETE FROM sync_log    WHERE task_id IN (${ph})`).run(...allIds)
  db.prepare('DELETE FROM tasks WHERE id = ? OR parent_id = ?').run(id, id)
  return { ok: true }
}

function completeTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false, reason: 'not_found' }
  const { n } = db.prepare(`SELECT count(*) as n FROM tasks WHERE parent_id = ? AND status != 'done'`).get(id)
  if (n > 0) return { ok: false, reason: 'subtasks_incomplete', count: n }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'completed', last_touched_human = ?, last_reviewed_at = ?, ai_context = ? WHERE id = ?`).run(now, now, appendAiContext(task.ai_context, 'Marked complete via UI.'), id)
  if (task.recurrence) {
    const nextDate = nextRecurrenceDate(task.due_date ?? task.start_date ?? today(), task.recurrence)
    if (nextDate) spawnRecurrence(task, nextDate, now, `Recurred from task ${id}`)
  }
  return { ok: true }
}

function completeTaskWithSubtasks(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false, reason: 'not_found' }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', last_touched_human = ?, last_reviewed_at = ?, ai_context = ? WHERE parent_id = ? AND status != 'done'`).run(now, now, appendAiContext(null, 'Bulk-completed with parent via UI.'), id)
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'completed', last_touched_human = ?, last_reviewed_at = ?, ai_context = ? WHERE id = ?`).run(now, now, appendAiContext(task.ai_context, 'Marked complete via UI (with subtasks).'), id)
  // Preserve the recurrence chain (bug C9). The UI forces THIS path for any parent that has
  // incomplete subtasks (completeTask rejects it), so without spawning here a recurring task
  // that acquired a subtask would silently end its series. Mirror completeTask's spawn.
  if (task.recurrence) {
    const nextDate = nextRecurrenceDate(task.due_date ?? task.start_date ?? today(), task.recurrence)
    if (nextDate) spawnRecurrence(task, nextDate, now, `Recurred from task ${id}`)
  }
  return { ok: true }
}

function uncompleteTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'active', last_touched_human = ?, last_reviewed_at = ?, ai_context = ? WHERE id = ?`).run(now, now, appendAiContext(task.ai_context, 'Reopened via UI.'), id)
  return { ok: true }
}

function skipTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task || !task.recurrence) return { ok: false }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'skipped', last_touched_human = ?, last_reviewed_at = ?, ai_context = ? WHERE id = ?`).run(now, now, appendAiContext(task.ai_context, 'Skipped via UI.'), id)
  const nextDate = nextRecurrenceDate(task.due_date ?? task.start_date ?? today(), task.recurrence)
  if (nextDate) spawnRecurrence(task, nextDate, now, `Recurred from task ${id}`)
  return { ok: true }
}

function activateTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL, ai_context = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?`).run(appendAiContext(task.ai_context, 'Activated via UI.'), now, now, id)
  return { ok: true }
}

function snoozeTask(id, until) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false }
  const hasTime = until.includes(' ') || until.includes('T')
  if (hasTime) {
    const now = nowIso()
    db.prepare(`UPDATE tasks SET status = 'snoozed', surface_after = ?, due_date = ?, ai_context = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?`).run(until, until.substring(0, 10), appendAiContext(task.ai_context, `Snoozed until ${until}.`), now, now, id)
  } else {
    const now = nowIso()
    db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL, due_date = ?, ai_context = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?`).run(until, appendAiContext(task.ai_context, `Deferred to ${until}.`), now, now, id)
  }
  return { ok: true }
}

function updateTaskTitle(id, title) { const now = nowIso(); db.prepare('UPDATE tasks SET title = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?').run(title, now, now, id); return { ok: true } }
function updateTaskDescription(id, description) { const now = nowIso(); db.prepare('UPDATE tasks SET description = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?').run(description ?? null, now, now, id); return { ok: true } }
function updateTaskDueDate(id, dueDate) { const now = nowIso(); db.prepare('UPDATE tasks SET due_date = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?').run(dueDate || null, now, now, id); return { ok: true } }
function updateTaskRecurrence(id, recurrence) { const now = nowIso(); db.prepare('UPDATE tasks SET recurrence = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?').run(recurrence || null, now, now, id); return { ok: true } }

function addTaskLink(id, url) {
  const task = db.prepare('SELECT links FROM tasks WHERE id = ?').get(id)
  if (!task) throw new Error('Task not found')
  let links = []; try { links = JSON.parse(task.links || '[]') } catch {}
  if (!links.includes(url)) links.push(url)
  db.prepare("UPDATE tasks SET links = ?, updated_at = datetime('now'), last_reviewed_at = ? WHERE id = ?").run(JSON.stringify(links), nowIso(), id)
  return { ok: true }
}

function markReviewed(id) {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id)
  if (!task) throw new Error('Task not found')
  const now = nowIso()
  db.prepare('UPDATE tasks SET last_reviewed_at = ?, last_touched_human = ? WHERE id = ?').run(now, now, id)
  return { ok: true, task_id: id, last_reviewed_at: now }
}

function getStaleTasks(days = null) {
  const parsedDays = days == null ? null : Number(days)
  const hasOverride = Number.isFinite(parsedDays)
  const staleWhere = hasOverride
    ? `date(COALESCE(last_reviewed_at, created_at)) < date('now', @cutoff)`
    : `(
      (status = 'backlog' AND date(COALESCE(last_reviewed_at, created_at)) < date('now', '-${DEFAULT_BACKLOG_REVIEW_DAYS} days'))
      OR
      (status = 'active' AND date(COALESCE(last_reviewed_at, created_at)) < date('now', '-${DEFAULT_ACTIVE_REVIEW_DAYS} days'))
    )`
  const params = hasOverride ? { cutoff: `-${parsedDays} days` } : null
  const stmt = db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('active', 'backlog')
      AND task_type != 'event'
      AND recurrence IS NULL
      AND parent_id IS NULL
      AND ${staleWhere}
    ORDER BY date(COALESCE(last_reviewed_at, created_at)) ASC, sort_order ASC NULLS LAST, my_priority ASC NULLS LAST
  `)
  return attachSubtasks(params ? stmt.all(params) : stmt.all())
}

function getTaskDependencies(id) {
  const task = getTask(id)
  if (!task) throw new Error('Task not found')
  return { blocks: task.blocks, blocked_by: task.blocked_by }
}

function dependencyWouldCycle(taskId, blockedByTaskId) {
  return !!db.prepare(`
    WITH RECURSIVE chain(id) AS (
      SELECT blocked_by_task_id FROM task_dependencies WHERE task_id = ?
      UNION
      SELECT d.blocked_by_task_id
      FROM task_dependencies d
      JOIN chain c ON d.task_id = c.id
    )
    SELECT 1 FROM chain WHERE id = ? LIMIT 1
  `).get(blockedByTaskId, taskId)
}

function addTaskDependency(taskId, blockedByTaskId) {
  if (taskId === blockedByTaskId) throw new Error('A task cannot depend on itself')
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)
  if (!task) throw new Error('Task not found')
  const blocker = db.prepare('SELECT id FROM tasks WHERE id = ?').get(blockedByTaskId)
  if (!blocker) throw new Error('Blocking task not found')
  if (dependencyWouldCycle(taskId, blockedByTaskId)) throw new Error('Dependency would create a cycle')
  db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, blocked_by_task_id) VALUES (?, ?)').run(taskId, blockedByTaskId)
  markReviewed(taskId)
  return { ok: true, task_id: taskId, blocked_by_task_id: blockedByTaskId, ...getTaskDependencies(taskId) }
}

function removeTaskDependency(taskId, blockedByTaskId) {
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND blocked_by_task_id = ?').run(taskId, blockedByTaskId)
  markReviewed(taskId)
  return { ok: true, task_id: taskId, blocked_by_task_id: blockedByTaskId, ...getTaskDependencies(taskId) }
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
  db.prepare(`INSERT INTO tasks (id, title, status, context, project, parent_id, source, created_at, updated_at, last_reviewed_at) VALUES (?, ?, 'active', ?, ?, ?, 'manual', ?, ?, ?)`).run(id, title, parent.context, parent.project, parentId, now, now, now)
  return getTask(id)
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
function searchDailyNotesDb(args = {}) {
  return searchDailyNotes(db, args)
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

function getProjectSummaries() {
  const projects = db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY name ASC').all()
  const activeCounts = db.prepare(`SELECT project, COUNT(*) as n FROM tasks WHERE status = 'active' AND task_type NOT IN ('coding','event') AND project IS NOT NULL GROUP BY project`).all()
  const codingCounts = db.prepare(`SELECT project, COUNT(*) as n FROM tasks WHERE task_type = 'coding' AND status NOT IN ('done','archived') AND project IS NOT NULL GROUP BY project`).all()
  const backlogCounts = db.prepare(`SELECT project, COUNT(*) as n FROM tasks WHERE status = 'backlog' AND project IS NOT NULL GROUP BY project`).all()
  // Fallback context from tasks for projects that predate the context column
  const ctxRows = db.prepare(`SELECT project, context FROM tasks WHERE project IS NOT NULL AND status NOT IN ('archived') GROUP BY project`).all()
  // Agent counts: explicit project match OR context-slug-equals-project-name match.
  // This gives silvermouse its 6 context agents without flooding unrelated projects.
  const agentCounts = db.prepare(`
    SELECT name_key, COUNT(*) as n FROM (
      SELECT project AS name_key FROM agents WHERE project IS NOT NULL
      UNION ALL
      SELECT context AS name_key FROM agents WHERE project IS NULL AND context IS NOT NULL
    ) GROUP BY name_key
  `).all()
  const activeMap = {}, codingMap = {}, backlogMap = {}, ctxMap = {}, agentCountMap = {}
  for (const r of activeCounts) activeMap[r.project] = r.n
  for (const r of codingCounts) codingMap[r.project] = r.n
  for (const r of backlogCounts) backlogMap[r.project] = r.n
  for (const r of ctxRows) ctxMap[r.project] = r.context
  for (const r of agentCounts) agentCountMap[r.name_key] = r.n
  return projects.map(p => ({
    name: p.name,
    context: p.context ?? ctxMap[p.name] ?? null,
    isRepo: p.is_repo === 1,
    activeCount: activeMap[p.name] ?? 0,
    codingCount: codingMap[p.name] ?? 0,
    backlogCount: backlogMap[p.name] ?? 0,
    agentCount: agentCountMap[p.name] ?? 0,
  }))
}

function getProjectDetail(name) {
  const project = db.prepare('SELECT * FROM projects WHERE name = ?').get(name)
  const active = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE project = ? AND status = 'active' AND task_type NOT IN ('coding','event') AND parent_id IS NULL ORDER BY ${ORDER}`).all(name))
  const coding = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE project = ? AND task_type = 'coding' AND status NOT IN ('done','archived') AND parent_id IS NULL ORDER BY created_at DESC`).all(name))
  const backlog = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE project = ? AND status = 'backlog' AND parent_id IS NULL ORDER BY ${ORDER}`).all(name))
  const doneRecent = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE project = ? AND status = 'done' AND parent_id IS NULL AND last_touched_human >= datetime('now','-14 days','localtime') ORDER BY last_touched_human DESC LIMIT 20`).all(name))
  stampAgentJobs(active, coding)
  // Show agents explicitly assigned to this project, OR whose context slug IS the project name
  // (e.g. project "silvermouse" matches agents with context="silvermouse").
  // We intentionally do NOT use the tasks' context — that would flood projects like "ROI Solutions"
  // (whose tasks live in "internal") with unrelated internal-context agents.
  const agents = db.prepare(`
    SELECT * FROM agents
    WHERE project = ?
       OR (context = ? AND project IS NULL)
    ORDER BY folder ASC NULLS LAST, name ASC
  `).all(name, name)
  const ctxRow = db.prepare(`
    SELECT context, COUNT(*) as n FROM tasks
    WHERE project = ? AND context IS NOT NULL AND status NOT IN ('archived')
    GROUP BY context ORDER BY n DESC LIMIT 1
  `).get(name)
  return {
    name,
    context: project?.context ?? ctxRow?.context ?? null,
    isRepo: project?.is_repo === 1,
    active, coding, backlog, doneRecent, agents,
  }
}

function listProjects(includeArchived = false) {
  return includeArchived
    ? db.prepare('SELECT * FROM projects ORDER BY archived ASC, name ASC').all()
    : db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY name ASC').all()
}
function createProjectExplicit(name) {
  db.prepare('INSERT OR IGNORE INTO projects (name) VALUES (?)').run(name)
  return { ok: true }
}
function updateProject(name, fields) {
  const allowed = ['is_repo', 'archived']
  const sets = []; const params = {}
  for (const f of allowed) { if (fields[f] !== undefined) { sets.push(`${f} = @${f}`); params[f] = fields[f] } }
  if (!sets.length) return { ok: true }
  params.name = name
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE name = @name`).run(params)
  return { ok: true }
}
function upsertAgents(agents) {
  const upsert = db.prepare(`
    INSERT INTO agents (path, name, context, project, description, command, coding, relative_path, folder, last_seen)
    VALUES (@path, @name, @context, @project, @description, @command, @coding, @relative_path, @folder, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET
      name = excluded.name, context = excluded.context, project = excluded.project,
      description = excluded.description, command = excluded.command, coding = excluded.coding,
      relative_path = excluded.relative_path, folder = excluded.folder, last_seen = excluded.last_seen
  `)
  const run = db.transaction(list => { for (const a of list) upsert.run(a) })
  run(agents.map(a => ({
    path: a.path, name: a.name, context: a.context ?? null, project: a.project ?? null,
    description: a.description ?? null, command: a.command ?? null,
    coding: a.coding ? 1 : 0, relative_path: a.relativePath ?? null, folder: a.folder ?? null,
  })))
  upsertScannedCapabilities(db, agents)
  return { ok: true, count: agents.length }
}
function listAgentsDb(filter = {}) {
  const conds = []; const params = {}
  if (filter.project !== undefined) { conds.push('project = @project'); params.project = filter.project }
  if (filter.context !== undefined) { conds.push('context = @context'); params.context = filter.context }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return db.prepare(`SELECT * FROM agents ${where} ORDER BY folder ASC NULLS LAST, name ASC`).all(params)
}
function listCapabilitiesDb(filter = {}) { return listCapabilities(db, filter) }
function getCapabilityDb(selector = {}) { return getCapability(db, selector) }
function searchCapabilitiesDb(args = {}) { return searchCapabilities(db, args) }
function renameProject(oldName, newName) {
  const existing = db.prepare('SELECT name FROM projects WHERE name = ?').get(newName)
  db.transaction(() => {
    db.prepare('UPDATE tasks SET project = ? WHERE project = ?').run(newName, oldName)
    if (existing) {
      // merge: target already exists, just remove the old row
      db.prepare('DELETE FROM projects WHERE name = ?').run(oldName)
    } else {
      db.prepare('UPDATE projects SET name = ? WHERE name = ?').run(newName, oldName)
    }
  })()
  return { ok: true, merged: !!existing }
}
function setProjectContext(name, context) {
  db.prepare("UPDATE projects SET context = ? WHERE name = ?").run(context, name)
  db.prepare("UPDATE tasks SET context = ? WHERE project = ?").run(context, name)
  return { ok: true }
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
  return allHabits.map(h => ({
    ...h,
    today_log: logMap[`${h.id}:${d}`] ?? null,
    week: days.map(day => ({ date: day, due: isHabitDueOn(h, day), log: logMap[`${h.id}:${day}`] ?? null })),
  }))
}
function createHabit(body) {
  if (!body.title) throw new Error('title required')
  const id = crypto.randomUUID(); const now = nowIso()
  db.prepare('INSERT INTO habits (id, title, description, recurrence, recurrence_days, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(id, body.title.trim(), body.description ?? null, body.recurrence ?? 'daily', body.recurrence_days ?? null, now, now)
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
function updateHabit(body) {
  if (!body.id) throw new Error('id required')
  const sets = ['updated_at = ?']; const params = [nowIso()]
  if (body.title !== undefined)           { sets.push('title = ?');            params.push(body.title) }
  if (body.description !== undefined)     { sets.push('description = ?');      params.push(body.description) }
  if (body.recurrence !== undefined)      { sets.push('recurrence = ?');       params.push(body.recurrence) }
  if (body.recurrence_days !== undefined) { sets.push('recurrence_days = ?');  params.push(body.recurrence_days || null) }
  if (body.active !== undefined)          { sets.push('active = ?');           params.push(body.active ? 1 : 0) }
  db.prepare(`UPDATE habits SET ${sets.join(', ')} WHERE id = ?`).run(...params, body.id)
  return { ok: true }
}

// ── Attachments ───────────────────────────────────────────────────────────────

function listAttachments(taskId) { return db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(taskId) }
function insertAttachment(data) {
  const { id, taskId, filename, mimeType, sizeBytes, bucket, key, url, localPath, encrypted } = data
  db.prepare(`INSERT INTO attachments (id, task_id, filename, mimetype, size_bytes, bucket, key, url, local_path, encrypted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, filename, mimeType, sizeBytes, bucket, key, url, localPath, encrypted ?? 0)
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id)
}
function getAttachment(id) { return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) ?? null }
function deleteAttachment(id) { db.prepare('DELETE FROM attachments WHERE id = ?').run(id); return { ok: true } }
function getPendingAttachments() { return db.prepare(`SELECT * FROM attachments WHERE bucket IS NULL AND local_path IS NOT NULL`).all() }
function updateAttachmentStorage(id, bucket, key, url, encrypted = 0) {
  db.prepare(`UPDATE attachments SET bucket = ?, key = ?, url = ?, encrypted = ? WHERE id = ?`).run(bucket, key, url, encrypted, id)
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
    `You are an agent running inside Qalatra. Task ID: ${taskId}`,
    `If you create any output files, save them to ${task.agent_path}/output/ and include their file paths in your response. Qalatra will auto-attach existing mentioned files back to this task.`,
    `Task: ${task.title}`
  ]
  if (task.description) parts.push(task.description)
  const links = (() => { try { return JSON.parse(task.links || '[]') } catch { return [] } })()
  if (links.length > 0) parts.push(`\nAttached links:\n${links.map(l => `- ${l}`).join('\n')}`)
  const attachments = db.prepare('SELECT filename, local_path, url FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(taskId)
  if (attachments.length > 0) parts.push(`\nAttached files:\n${attachments.map(a => `- ${a.filename}: ${a.local_path || a.url}`).join('\n')}`)
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
function startAgentJob(id) {
  // Atomic claim (bug C6): only transition a job that is still 'queued'. If another worker/
  // instance already claimed it, changes === 0 and the caller must not run it.
  const info = db.prepare(`UPDATE agent_jobs SET status = 'running', started_at = datetime('now') WHERE id = ? AND status = 'queued'`).run(id)
  return { ok: info.changes === 1, claimed: info.changes === 1 }
}
function finishAgentJob(id, status, result, sessionId) {
  db.prepare(`UPDATE agent_jobs SET status = ?, result = ?, session_id = ?, completed_at = datetime('now') WHERE id = ?`).run(status, result, sessionId, id)
  return { ok: true }
}
function insertAgentNote(id, taskId, result, jobId) {
  db.prepare(`INSERT INTO notes (id, task_id, body, author, agent_job_id) VALUES (?, ?, ?, 'agent', ?)`).run(id, taskId, result, jobId)
  const job = jobId ? db.prepare('SELECT agent_path FROM agent_jobs WHERE id = ?').get(jobId) : null
  const task = db.prepare('SELECT agent_path FROM tasks WHERE id = ?').get(taskId)
  const baseDirs = [job?.agent_path, task?.agent_path].filter(Boolean)
  try {
    const attachments = autoAttachMentionedFiles(db, { taskId, text: result, baseDirs })
    return { ok: true, auto_attached: attachments.length, attachments }
  } catch (err) {
    return { ok: true, auto_attached: 0, attachments: [], auto_attach_error: err.message }
  }
}
function resetStuckJobs() {
  // Jobs stuck for less than the 15-min timeout window were likely orphaned by an app crash — re-queue them.
  // Jobs stuck longer than that will never recover on their own — mark them failed.
  db.prepare(`UPDATE agent_jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND started_at > datetime('now', '-16 minutes')`).run()
  db.prepare(`UPDATE agent_jobs SET status = 'failed', result = 'Job orphaned: app was restarted while this job was running and it exceeded the timeout window.', completed_at = datetime('now') WHERE status = 'running'`).run()
  return { ok: true }
}
function getAutorunTasks() {
  return db.prepare(`SELECT t.* FROM tasks t WHERE t.agent_path IS NOT NULL AND t.agent_autorun = 1 AND t.status = 'active' AND (t.due_date IS NULL OR t.due_date <= date('now', 'localtime')) AND time('now', 'localtime') >= COALESCE(t.agent_autorun_time, '09:00') AND NOT EXISTS (SELECT 1 FROM agent_jobs j WHERE j.task_id = t.id)`).all()
}
function insertAutorunJob(taskId, agentPath, prompt) {
  const fullPrompt = `You are an agent running inside Qalatra. Task ID: ${taskId}\nIf you create any output files, save them to ${agentPath}/output/ and include their file paths in your response. Qalatra will auto-attach existing mentioned files back to this task.\n${prompt}`
  db.prepare(`INSERT INTO agent_jobs (id, task_id, agent_path, prompt) VALUES (?, ?, ?, ?)`).run(crypto.randomUUID(), taskId, agentPath, fullPrompt)
  return { ok: true }
}

// ── Heartbeats ────────────────────────────────────────────────────────────────

function addMinutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
}

// Compute next run timestamp. For daily heartbeats with a specific time, schedules
// the next occurrence of that local time (today if not yet passed, tomorrow if it has).
function nextRunAt(intervalMinutes, runAtTime, minuteOffset) {
  if (runAtTime && intervalMinutes === 1440) {
    const [h, m] = runAtTime.split(':').map(Number)
    const target = new Date()
    target.setHours(h, m, 0, 0)
    if (target <= new Date()) target.setDate(target.getDate() + 1)
    return target.toISOString().replace('T', ' ').slice(0, 19)
  }
  if (minuteOffset != null && intervalMinutes < 1440) {
    const now = new Date()
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    const elapsed = ((nowMinutes - minuteOffset) % intervalMinutes + intervalMinutes) % intervalMinutes
    const minutesUntilNext = elapsed === 0 ? intervalMinutes : intervalMinutes - elapsed
    const next = new Date(now.getTime() + minutesUntilNext * 60_000)
    next.setSeconds(0, 0)
    return next.toISOString().replace('T', ' ').slice(0, 19)
  }
  return addMinutesFromNow(intervalMinutes)
}

function listHeartbeats() {
  return db.prepare(`
    SELECT h.*,
      (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status = 'done') as runs_done,
      (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status = 'failed') as runs_failed,
      (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status IN ('queued','running')) as runs_pending
    FROM heartbeats h ORDER BY h.created_at DESC
  `).all()
}

function createHeartbeat({ title, description, agent_path, prompt, interval_minutes, run_at_time, minute_offset } = {}) {
  if (!title || !agent_path || !prompt) throw new Error('title, agent_path, and prompt are required')
  const id = crypto.randomUUID()
  const now = nowIso()
  const mins = interval_minutes ?? 60
  const runAt = (run_at_time && mins === 1440) ? run_at_time : null
  const offset = (minute_offset != null && mins < 1440) ? minute_offset : null
  const firstRun = nextRunAt(mins, runAt, offset)
  db.prepare(`
    INSERT INTO heartbeats (id, title, description, agent_path, prompt, interval_minutes, run_at_time, minute_offset, active, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, title.trim(), description ?? null, agent_path.trim(), prompt.trim(), mins, runAt, offset, firstRun, now, now)
  return db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id)
}

function updateHeartbeat(id, fields = {}) {
  const existing = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id)
  if (!existing) return undefined
  const sets = []
  const vals = []
  for (const k of ['title', 'description', 'agent_path', 'prompt']) {
    if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]) }
  }
  // Recompute next_run_at on ANY schedule-field change (bug C8) and apply the create-path
  // normalization (run_at_time only valid with interval 1440; minute_offset only with <1440),
  // so a schedule edit takes effect immediately instead of firing on the stale next_run_at.
  if (['interval_minutes', 'run_at_time', 'minute_offset'].some(k => k in fields)) {
    const mins = (('interval_minutes' in fields) ? fields.interval_minutes : existing.interval_minutes) ?? 60
    const rawRunAt = ('run_at_time' in fields) ? fields.run_at_time : existing.run_at_time
    const rawOffset = ('minute_offset' in fields) ? fields.minute_offset : existing.minute_offset
    const runAt = (rawRunAt && mins === 1440) ? rawRunAt : null
    const offset = (rawOffset != null && mins < 1440) ? rawOffset : null
    sets.push('interval_minutes = ?'); vals.push(mins)
    sets.push('run_at_time = ?'); vals.push(runAt)
    sets.push('minute_offset = ?'); vals.push(offset)
    sets.push('next_run_at = ?'); vals.push(nextRunAt(mins, runAt, offset))
  }
  if (!sets.length) return existing
  sets.push('updated_at = ?'); vals.push(nowIso()); vals.push(id)
  db.prepare(`UPDATE heartbeats SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id)
}

function deleteHeartbeat(id) {
  db.prepare(`DELETE FROM agent_jobs WHERE heartbeat_id = ?`).run(id)
  db.prepare(`DELETE FROM heartbeats WHERE id = ?`).run(id)
  return { ok: true }
}

function toggleHeartbeat(id) {
  const hb = db.prepare('SELECT id, active, interval_minutes, run_at_time, minute_offset FROM heartbeats WHERE id = ?').get(id)
  if (!hb) throw new Error('Heartbeat not found')
  if (hb.active === 1) {
    db.prepare(`UPDATE heartbeats SET active = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id)
  } else {
    const nr = nextRunAt(hb.interval_minutes, hb.run_at_time ?? null, hb.minute_offset ?? null)
    db.prepare(`UPDATE heartbeats SET active = 1, next_run_at = ?, updated_at = ? WHERE id = ?`).run(nr, nowIso(), id)
  }
  return db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id)
}

function getDueHeartbeats() {
  return db.prepare(`
    SELECT h.* FROM heartbeats h
    WHERE h.active = 1
    AND h.next_run_at IS NOT NULL
    AND h.next_run_at <= datetime('now')
    AND NOT EXISTS (
      SELECT 1 FROM agent_jobs j
      WHERE j.heartbeat_id = h.id AND j.status IN ('queued','running')
    )
  `).all()
}

function markHeartbeatRun(id, intervalMinutes, runAtTime, minuteOffset) {
  const now = nowIso()
  const nr = nextRunAt(intervalMinutes, runAtTime ?? null, minuteOffset ?? null)
  db.prepare(`UPDATE heartbeats SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`).run(now, nr, now, id)
  return { ok: true }
}

function createHeartbeatJob(heartbeatId) {
  const hb = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(heartbeatId)
  if (!hb) throw new Error('Heartbeat not found')
  const id = crypto.randomUUID()
  db.prepare(`
    INSERT INTO agent_jobs (id, task_id, heartbeat_id, agent_path, prompt, user_message)
    VALUES (?, NULL, ?, ?, ?, NULL)
  `).run(id, heartbeatId, hb.agent_path, hb.prompt)
  return { id, status: 'queued' }
}

function listHeartbeatJobs(heartbeatId, limit = 10) {
  return db.prepare(`
    SELECT id, status, result, created_at, started_at, completed_at
    FROM agent_jobs WHERE heartbeat_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(heartbeatId, limit)
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const METHODS = {
  getTasksForDate, getTask, getSubtasks, getBacklog, getCodingTasks, getReadingTasks,
  searchTasks,
  createTask, updateTask, deleteTask,
  completeTask, completeTaskWithSubtasks, uncompleteTask,
  skipTask, activateTask, snoozeTask,
  updateTaskTitle, updateTaskDescription, updateTaskDueDate, updateTaskRecurrence,
  addTaskLink, reorderTasks, createSubtask,
  markReviewed, getStaleTasks, getTaskDependencies, addTaskDependency, removeTaskDependency,
  listNotes, addNote,
  getDailyNote, saveDailyNote, searchDailyNotesDb,
  listContexts, createContext, updateContext, deleteContext,
  getProjectSummaries, getProjectDetail,
  listProjects, createProjectExplicit, updateProject, renameProject, setProjectContext, archiveProject, unarchiveProject, deleteProject,
  upsertAgents, listAgentsDb,
  listCapabilitiesDb, getCapabilityDb, searchCapabilitiesDb,
  listHabits, createHabit, updateHabit, logHabit, unlogHabit,
  listAttachments, insertAttachment, getAttachment, deleteAttachment,
  getPendingAttachments, updateAttachmentStorage,
  listAgentJobs, getAgentJob, createAgentJob,
  getQueuedJobs, startAgentJob, finishAgentJob, insertAgentNote,
  resetStuckJobs, getAutorunTasks, insertAutorunJob,
  listHeartbeats, createHeartbeat, updateHeartbeat, deleteHeartbeat, toggleHeartbeat,
  getDueHeartbeats, markHeartbeatRun, createHeartbeatJob, listHeartbeatJobs,
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
