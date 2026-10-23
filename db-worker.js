// db-worker.js — SQLite on a dedicated Worker thread so the main thread never blocks.
// Main process sends { id, method, args } → receives { id, result } or { id, error }.

import { workerData, parentPort } from 'worker_threads'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import pkg from 'rrule'
import {
  ensureAgentSchema,
  ensureCapabilitySchema,
  getCapability,
  listCapabilities,
  searchCapabilities,
  syncScannedAgents,
} from './server/capability-registry.js'
import { ensureDailyNoteSearchSchema, searchDailyNotes } from './server/daily-note-search.js'
import { autoAttachMentionedFiles } from './server/mentioned-files.js'
// Pure business logic (date math, ai_context ordering, heartbeat/habit scheduling) is single-sourced
// in server/task-logic.js — the same module mcp/db.js imports — so the two runtimes cannot silently
// diverge (bugs C10/C15/C24). nextRecurrenceDate is the ONE exception: it stays defined below because
// test-recurrence.mjs extracts it from this file's source text and runs it in isolation. That test
// also asserts this copy === the shared copy, so it is an automated guard against drift.
import {
  today, nowIso, utcNowIso, offsetDate, daysBetween, appendAiContext, isHabitDueOn,
  withTimestampZones, buildHabitHistory, habitRangeError,
  resolveHeartbeatSchedule, touchesHeartbeatSchedule, heartbeatNextRunAt, heartbeatUpcomingRuns,
} from './server/task-logic.js'
const { rrulestr } = pkg

// ── Pure helpers ──────────────────────────────────────────────────────────────

// Validation error carrying an HTTP status (bug C17). The status survives the worker boundary
// (db-worker serializes err.status; db-client rehydrates it) so index.js emits 400, not 500.
function validationError(message) { const e = new Error(message); e.status = 400; return e }
// Kept local (do not move): test-recurrence.mjs regex-extracts this exact function from source and
// runs it with only `rrulestr` injected. It must stay self-contained and byte-for-byte behaviorally
// identical to nextRecurrenceDate in server/task-logic.js (the test asserts db-worker === shared).
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
  // agents (and its concurrency_key / worktrees columns) is defined once in capability-registry.js
  // and shared with mcp/db.js, since both processes write it.
  ensureAgentSchema(db)
  ensureCapabilitySchema(db)
  ensureDailyNoteSearchSchema(db)
  // sync_log is otherwise created only by mcp/db.js, so with MCP disabled (QALATRA_START_MCP=0)
  // db-worker's deleteTask threw 'no such table: sync_log' (bug C19). Create it here too, matching
  // mcp/db.js's schema, so deletion works regardless of whether the MCP process ran.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL REFERENCES tasks(id),
      source        TEXT NOT NULL,
      action        TEXT NOT NULL,
      payload       TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      attempted_at  TEXT,
      response      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  tryAlter('ALTER TABLE tasks ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0')
  tryAlter('ALTER TABLE tasks ADD COLUMN hard_deadline INTEGER NOT NULL DEFAULT 0')
  tryAlter('ALTER TABLE tasks ADD COLUMN last_reviewed_at TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN time_estimate INTEGER')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN session_id TEXT')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN user_message TEXT')
  // Orphan handling (app restart mid-job is infrastructure, not an agent failure):
  //  - terminated_by:        cause of a non-failure termination, e.g. 'app_restart'. Lets
  //                          consumers branch on a field instead of string-matching `result`.
  //  - terminated_boundary:  started_at of the app instance that killed the job, so a consumer
  //                          can tell "died before doing anything" from "died after work landed"
  //                          by comparing against when a late cloud reply arrived.
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN terminated_by TEXT')
  // Which CLI adapter actually ran the job (claude | codex | raw). Recorded at claim time rather
  // than read from agent.config on display, so history stays accurate after a config is retargeted.
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN runtime TEXT')
  // Provider-reported token usage plus the number of Qalatra MCP calls observed in the agent's
  // structured event stream. JSON keeps provider additions forward-compatible without migrations.
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN usage_json TEXT')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN mcp_tool_calls INTEGER')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN terminated_boundary TEXT')
  // One-time backfill: rows marked `failed` that carry the old orphan string were the same
  // infrastructure event under a wrong label. Reclassify so failure counts and the Pipeline
  // Auditor's recurring-infra-error detector stop counting restarts as agent failures.
  // Idempotent: once converted the status is 'orphaned', so the LIKE no longer matches.
  try {
    db.prepare(
      `UPDATE agent_jobs SET status = 'orphaned', terminated_by = 'app_restart' WHERE status = 'failed' AND result LIKE 'Job orphaned:%'`
    ).run()
  } catch { /* columns may not exist yet on a partial migration — non-fatal */ }
  tryAlter('ALTER TABLE contexts ADD COLUMN label TEXT')
  tryAlter("ALTER TABLE contexts ADD COLUMN color TEXT NOT NULL DEFAULT '#888888'")
  tryAlter('ALTER TABLE contexts ADD COLUMN sort_order INTEGER')
  tryAlter('ALTER TABLE habits ADD COLUMN recurrence_days TEXT')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN heartbeat_id TEXT REFERENCES heartbeats(id)')
  tryAlter('ALTER TABLE heartbeats ADD COLUMN run_at_time TEXT')
  tryAlter('ALTER TABLE heartbeats ADD COLUMN minute_offset INTEGER')
  // Cron schedules (cron_expression + IANA timezone) take precedence over the interval columns.
  tryAlter('ALTER TABLE heartbeats ADD COLUMN cron_expression TEXT')
  tryAlter('ALTER TABLE heartbeats ADD COLUMN timezone TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN assigned_agent TEXT')
  tryAlter('ALTER TABLE projects ADD COLUMN is_repo INTEGER NOT NULL DEFAULT 0')
  // agents.concurrency_key / agents.worktrees: added by ensureAgentSchema (server/capability-registry.js).
  // The directory a job was actually spawned in. agent_path stays the bound folder (identity, rc,
  // scans); run_cwd differs from it only for a worktree job. NULL on jobs from before this column.
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN run_cwd TEXT')
  // External orchestration (generic — FlightDesk is the first consumer, see server/integrations/):
  // a job queued by an outside system carries that system's request id in external_ref so a
  // re-delivered request maps to the same job instead of a second one; external_meta is the
  // orchestrator's JSON (name, kind, env to inject). resume_session = 0 starts the turn on a
  // fresh session even when the task has a resumable one — the orchestrator owns stage
  // boundaries. tasks.orchestrator/orchestrator_ref say who *drives* a task, distinct from
  // source/source_url, which say where it was born.
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN external_ref TEXT')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN external_meta TEXT')
  tryAlter('ALTER TABLE agent_jobs ADD COLUMN resume_session INTEGER NOT NULL DEFAULT 1')
  tryAlter('ALTER TABLE tasks ADD COLUMN orchestrator TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN orchestrator_ref TEXT')
  // Recurring tasks: what happens to an occurrence that passes its date undone. NULL/'keep' leaves
  // it active until someone completes or skips it; 'skip' rolls it over (autoRolloverRecurring).
  // series_id is the first occurrence's id, carried by every later one, so a holder of any
  // occurrence's id can find the current one.
  tryAlter('ALTER TABLE tasks ADD COLUMN missed_occurrence TEXT')
  tryAlter('ALTER TABLE tasks ADD COLUMN series_id TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_series_id ON tasks(series_id) WHERE series_id IS NOT NULL')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_external_ref ON agent_jobs(external_ref) WHERE external_ref IS NOT NULL')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_orchestrator ON tasks(orchestrator, orchestrator_ref)')
  // A task an orchestrator drives is a coding task, always: the orchestrator is its system of
  // record, so it belongs in the Coding view and never in the owner's priority/today lists.
  // Earlier bind paths skipped the type; this backfills them on every boot (idempotent).
  db.exec(`UPDATE tasks SET task_type = 'coding' WHERE orchestrator IS NOT NULL AND task_type != 'coding'`)
  // Ledger of code-shaped operations executed on behalf of an orchestrator (session inject, state,
  // archive…) that never become agent jobs. Keyed by the orchestrator's request id so a request
  // re-delivered after a lost report is answered from the ledger instead of executed twice — an
  // inject that lands twice double-posts into a live session.
  db.exec(`CREATE TABLE IF NOT EXISTS external_ops (
    external_ref TEXT PRIMARY KEY,
    orchestrator TEXT NOT NULL,
    op           TEXT NOT NULL,
    status       TEXT NOT NULL,
    result       TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  // Outbox of terminal reports (DONE/FAILED) owed to an orchestrator. A report is written here
  // before it is sent and deleted once the orchestrator has it, so a network blip or a restart
  // between "the job ended" and "the orchestrator heard" cannot leave the request RUNNING there
  // forever. payload is the exact report, so a retry says what the first attempt would have.
  // The job's own terminal write records that a report is owed (target/payload still NULL), in
  // the same transaction, so even a crash before the integration builds the report loses nothing.
  db.exec(`CREATE TABLE IF NOT EXISTS external_reports (
    external_ref    TEXT PRIMARY KEY,
    orchestrator    TEXT NOT NULL,
    agent_path      TEXT,
    target          TEXT,
    mode            TEXT NOT NULL DEFAULT 'ladder',
    payload         TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`)
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
  // Terminal chokepoint for task rows leaving this process (getTask, getBacklog, every
  // attachSubtasks caller), so timestamps are stamped once here rather than at 50+ read sites.
  // Internal reads that feed logic back into SQL never pass through here, which is the point.
  return tasks.map(task => {
    const blocked_by = blockedBy[task.id] ?? []
    return withTimestampZones({
      ...task,
      hard_deadline: task.hard_deadline === 1 || task.hard_deadline === true,
      ...reviewSignal(task),
      blocked: blocked_by.some(dep => !dep.completed),
      blocked_by,
      blocks: blocks[task.id] ?? [],
    }, 'tasks')
  })
}

function attachSubtasks(tasks) {
  if (!tasks.length) return tasks
  const ids = tasks.map(t => `'${t.id.replace(/'/g, "''")}'`).join(',')
  const subs = withTimestampZones(db.prepare(`SELECT * FROM tasks WHERE parent_id IN (${ids}) ORDER BY sort_order ASC NULLS LAST, created_at ASC`).all(), 'tasks')
  const byParent = {}
  for (const s of subs) { if (!byParent[s.parent_id]) byParent[s.parent_id] = []; byParent[s.parent_id].push(s) }
  const attCounts = db.prepare(`SELECT task_id, COUNT(*) as cnt FROM attachments WHERE task_id IN (${ids}) GROUP BY task_id`).all()
  const attByTask = {}
  for (const r of attCounts) attByTask[r.task_id] = r.cnt
  return attachTrustSignals(tasks.map(t => ({ ...t, subtasks: byParent[t.id] ?? [], attachment_count: attByTask[t.id] ?? 0 })))
}

function stampAgentJobs(...arrays) {
  const jobs = db.prepare(`SELECT task_id, status FROM agent_jobs WHERE status IN ('queued','running') OR (status IN ('done','failed','orphaned') AND completed_at >= datetime('now','-24 hours')) ORDER BY created_at DESC`).all()
  if (!jobs.length) return
  const map = {}
  for (const j of jobs) { if (j.task_id && !map[j.task_id]) map[j.task_id] = j.status }
  for (const arr of arrays) for (const t of arr) { if (map[t.id]) t.agent_job_status = map[t.id] }
}

// Only tasks set to skip a missed occurrence roll over; by default a missed occurrence stays
// active until someone completes or skips it, so unfinished work is never marked done unseen.
function autoRolloverRecurring() {
  const t = today()
  const stale = db.prepare(`SELECT * FROM tasks WHERE status = 'active' AND task_type != 'event' AND recurrence IS NOT NULL AND missed_occurrence = 'skip' AND ((due_date IS NOT NULL AND due_date < ?) OR (due_date IS NULL AND start_date IS NOT NULL AND start_date < ?))`).all(t, t)
  const now = nowIso()
  // Transaction + compare-and-set claim (bug C12): the MCP briefing runs the same rollover on a
  // separate connection, so two concurrent runs can both read a task as 'active' and both spawn.
  // Flipping active->done only WHERE status='active' means exactly one writer wins; the loser
  // (changes===0) skips the spawn. Also prevents cascade duplication across repeated UI refreshes.
  const rollover = db.transaction((tasks) => {
    for (const task of tasks) {
      // updated_at, not last_touched_human: no person touched it.
      const claim = db.prepare(`UPDATE tasks SET status = 'done', outcome = 'skipped', updated_at = ?, ai_context = ? WHERE id = ? AND status = 'active'`).run(now, appendAiContext(task.ai_context, 'Auto-skipped: overdue recurring task.'), task.id)
      if (claim.changes !== 1) continue
      const nextDate = nextOccurrenceDate(task)
      if (nextDate) spawnRecurrence(task, nextDate, now, `Auto-recurred from task ${task.id}`)
    }
  })
  rollover(stale)
}

// The next occurrence after this one, advanced to today or later in one step so the cadence stays
// aligned and completing a long-overdue occurrence does not spawn one that is already overdue.
function nextOccurrenceDate(task) {
  const t = today()
  let baseDate = task.due_date ?? task.start_date ?? t
  let nextDate = nextRecurrenceDate(baseDate, task.recurrence)
  while (nextDate && nextDate < t) {
    baseDate = nextDate
    nextDate = nextRecurrenceDate(baseDate, task.recurrence)
  }
  return nextDate
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
  db.prepare(`INSERT INTO tasks (id, title, description, notes, links, status, my_priority, energy_required, context, project, tags, source, source_url, created_at, updated_at, last_reviewed_at, start_date, due_date, hard_deadline, task_type, recurrence, ai_context, time_estimate, inbox, agent_path, agent_resume, agent_autorun, agent_autorun_time, missed_occurrence, series_id) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), task.title, task.description, task.notes ?? null, task.links ?? null, task.my_priority, task.energy_required, task.context, task.project, task.tags, task.source ?? 'manual', task.source_url, now, now, now, spawnedStart, spawnedDue, task.hard_deadline ? 1 : 0, task.task_type, task.recurrence, appendAiContext(null, reason), task.time_estimate ?? null, task.inbox ?? 0, task.agent_path ?? null, task.agent_resume ?? 1, task.agent_autorun ?? 0, task.agent_autorun_time ?? '09:00', task.missed_occurrence ?? null, task.series_id ?? task.id)
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
            -- bug C20: time(event_time,'+1 hour') wraps for a 23:xx event (e.g. 23:30 -> 00:30),
            -- and an explicit cross-midnight end_time is < start. Either way the computed end is
            -- next-day, so it must NOT auto-complete on the event's own date (the due_date < today
            -- branch catches it the next day). Only same-day-completing when end >= start.
            AND time(COALESCE(end_time, time(event_time, '+1 hour'))) >= time(event_time)
            AND time(COALESCE(end_time, time(event_time, '+1 hour'))) <= time('now', 'localtime'))
      )
    `).run(date, date)
    const inbox       = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE inbox = 1 AND status = 'active' AND parent_id IS NULL AND task_type = 'task' AND orchestrator IS NULL ORDER BY created_at DESC`).all())
    const overdue     = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE inbox = 0 AND status = 'active' AND parent_id IS NULL AND due_date IS NOT NULL AND due_date < ? AND task_type = 'task' AND orchestrator IS NULL ORDER BY due_date ASC, ${ORDER}`).all(date))
    const dueToday    = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE inbox = 0 AND status = 'active' AND parent_id IS NULL AND strftime('%Y-%m-%d', due_date) = ? AND task_type = 'task' AND orchestrator IS NULL AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime') OR strftime('%Y-%m-%d', due_date) <= ?) ORDER BY ${ORDER}`).all(date, date))
    const active      = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE inbox = 0 AND status = 'active' AND parent_id IS NULL AND task_type = 'task' AND orchestrator IS NULL AND (due_date IS NULL OR due_date > ?) AND ((start_date IS NULL AND due_date IS NULL) OR (start_date IS NOT NULL AND start_date <= ?)) AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')) ORDER BY ${ORDER}`).all(date, date))
    const doneToday   = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND parent_id IS NULL AND task_type != 'event' AND orchestrator IS NULL AND last_touched_human >= ? AND last_touched_human < ? ORDER BY last_touched_human DESC`).all(date, nextDay))
    const events      = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE task_type = 'event' AND parent_id IS NULL AND (due_date = ? OR due_date IS NULL) ORDER BY event_time ASC NULLS LAST, created_at ASC`).all(date))
    const reminders   = db.prepare(`SELECT * FROM tasks WHERE task_type = 'reminder' AND parent_id IS NULL AND status != 'done' AND (due_date IS NULL OR due_date <= ?) AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')) ORDER BY ${ORDER}`).all(date)
    const timeSnoozed = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'snoozed' AND parent_id IS NULL AND task_type = 'task' AND orchestrator IS NULL AND strftime('%Y-%m-%d', due_date) = ? AND surface_after > strftime('%Y-%m-%d %H:%M', 'now', 'localtime') ORDER BY surface_after ASC`).all(date))
    const allHabits   = db.prepare('SELECT * FROM habits WHERE active = 1 ORDER BY created_at ASC').all()
    const todayHabits = allHabits.filter(h => isHabitDueOn(h, date))
    const habitLogs   = todayHabits.length ? db.prepare(`SELECT * FROM habit_logs WHERE date = ? AND habit_id IN (${todayHabits.map(() => '?').join(',')})`).all(date, ...todayHabits.map(h => h.id)) : []
    const habitLogMap = {}
    for (const l of habitLogs) habitLogMap[l.habit_id] = l
    const habits = todayHabits.map(h => ({ ...h, today_log: habitLogMap[h.id] ?? null }))
    stampAgentJobs(inbox, overdue, dueToday, active)
    return { view: 'today', date, inbox, overdue, dueToday, active, doneToday, timeSnoozed, events, reminders, habits }
  } else if (date > t) {
    // A task with only a start date is listed on that date: today's view hides it until then, so
    // matching due_date alone left it in no date view at all.
    const scheduled   = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE (strftime('%Y-%m-%d', due_date) = ? OR (due_date IS NULL AND strftime('%Y-%m-%d', start_date) = ?)) AND parent_id IS NULL AND task_type = 'task' AND orchestrator IS NULL AND status = 'active' ORDER BY ${ORDER}`).all(date, date))
    const timeSnoozed = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE strftime('%Y-%m-%d', due_date) = ? AND parent_id IS NULL AND task_type = 'task' AND orchestrator IS NULL AND status = 'snoozed' ORDER BY surface_after ASC`).all(date))
    const events      = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE task_type = 'event' AND parent_id IS NULL AND status != 'done' AND due_date = ? ORDER BY event_time ASC NULLS LAST, created_at ASC`).all(date))
    const reminders   = db.prepare(`SELECT * FROM tasks WHERE task_type = 'reminder' AND parent_id IS NULL AND status != 'done' AND due_date = ? ORDER BY ${ORDER}`).all(date)
    stampAgentJobs(scheduled, timeSnoozed)
    return { view: 'future', date, scheduled, timeSnoozed, events, reminders }
  } else {
    const completed = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'done' AND parent_id IS NULL AND task_type = 'task' AND orchestrator IS NULL AND last_touched_human >= ? AND last_touched_human < ? ORDER BY last_touched_human DESC`).all(date, nextDay))
    const wasDue    = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE due_date = ? AND parent_id IS NULL AND task_type = 'task' AND orchestrator IS NULL ORDER BY status ASC, ${ORDER}`).all(date))
    const events    = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE task_type = 'event' AND parent_id IS NULL AND due_date = ? ORDER BY event_time ASC NULLS LAST, created_at ASC`).all(date))
    return { view: 'past', date, completed, wasDue, events }
  }
}

function getTask(id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!row) return null
  const current = currentOccurrenceId(row)
  return attachTrustSignals([current ? { ...row, current_occurrence_id: current } : row])[0]
}

// For a finished occurrence of a recurring task, the series' active occurrence, if any. The series
// is keyed by the first occurrence's id, which that occurrence itself holds only as its own id.
function currentOccurrenceId(task) {
  if (!task.recurrence || task.status === 'active') return null
  const series = task.series_id ?? task.id
  return db.prepare(`SELECT id FROM tasks WHERE (series_id = ? OR id = ?) AND status = 'active' AND id != ? ORDER BY created_at DESC LIMIT 1`).get(series, series, task.id)?.id ?? null
}
function getSubtasks(id) { return attachTrustSignals(db.prepare(`SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC NULLS LAST, created_at ASC`).all(id)) }
function getBacklog() { return attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE status = 'backlog' AND parent_id IS NULL ORDER BY context ASC, project ASC NULLS LAST, sort_order ASC NULLS LAST, created_at ASC`).all()) }

function getCodingTasks() {
  const tasks = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE (task_type = 'coding' OR orchestrator IS NOT NULL) AND status NOT IN ('done','archived') AND parent_id IS NULL ORDER BY created_at DESC`).all())
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

// 'keep' (the default, stored as NULL) or 'skip'; see the tasks.missed_occurrence migration.
function normalizeMissedOccurrence(value) {
  if (value == null || value === '' || value === 'keep') return null
  if (value === 'skip') return 'skip'
  throw validationError("missed_occurrence must be 'keep' or 'skip'")
}

function createTask(body) {
  if (!body.title) throw validationError('title required')
  const id = crypto.randomUUID(); const now = nowIso()

  // Honor the same fields on insert as MCP create_task and REST updateTask.
  // Previously this hardcoded task_type='task'/source='manual' and dropped the
  // event-time and most other columns, forcing callers into a POST-then-PATCH
  // workaround. Built as a dynamic insert so only provided columns are set and
  // schema defaults cover the rest. Keep in sync with mcp/tools/tasks.js
  // create_task (the known db-worker ↔ mcp parallel-logic pair).
  const cols = {
    id,
    title:     body.title,
    status:    body.status ?? 'active',
    context:   body.context ?? 'personal',
    source:    body.source ?? 'manual',
    task_type: body.task_type ?? 'task',
    created_at: now,
    updated_at: now,
    last_reviewed_at: now,
  }

  // Passthrough columns: set only when provided (schema defaults handle the rest).
  const PASSTHROUGH = [
    'description', 'notes', 'my_priority', 'energy_required', 'project', 'tags',
    'source_id', 'source_url', 'source_priority', 'due_date', 'start_date', 'surface_after',
    'event_time', 'end_time', 'parent_id', 'recurrence', 'agent_path', 'assigned_agent',
    'agent_resume', 'agent_autorun', 'agent_autorun_time', 'time_estimate', 'missed_occurrence',
  ]
  if (body.missed_occurrence !== undefined) body = { ...body, missed_occurrence: normalizeMissedOccurrence(body.missed_occurrence) }
  for (const f of PASSTHROUGH) {
    if (body[f] !== undefined) cols[f] = body[f] === '' ? null : body[f]
  }
  // REST conventions (mirror updateTask): booleans → 1/0, links stored as JSON
  // text, ai_context date-prefixed via the shared helper.
  if (body.hard_deadline !== undefined) cols.hard_deadline = body.hard_deadline ? 1 : 0
  if (body.inbox !== undefined) cols.inbox = body.inbox ? 1 : 0
  if (body.links !== undefined) cols.links = body.links == null ? null : JSON.stringify(body.links)
  if (body.ai_context) cols.ai_context = appendAiContext(null, body.ai_context)

  const keys = Object.keys(cols)
  db.prepare(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map(k => `@${k}`).join(', ')})`).run(cols)
  if (body.project) db.prepare(`INSERT OR IGNORE INTO projects (name) VALUES (?)`).run(body.project)
  return getTask(id)
}

function updateTask(id, body) {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!existing) return { ok: false, reason: 'not_found' } // bug C16: 0-row PATCH must not report success
  const MUTABLE = ['title','description','status','my_priority','energy_required','context','project','tags','source_url','due_date','hard_deadline','start_date','surface_after','task_type','event_time','end_time','recurrence','parent_id','agent_path','agent_resume','agent_autorun','agent_autorun_time','outcome','notes','inbox','time_estimate','missed_occurrence']
  if (body.missed_occurrence !== undefined) body = { ...body, missed_occurrence: normalizeMissedOccurrence(body.missed_occurrence) }
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
  // bug C14: completing a recurring task through a status update must preserve the chain, exactly
  // like completeTask — otherwise the series silently ends (autoRolloverRecurring only sweeps
  // status='active', so a done recurring task is never recovered).
  if (body.status === 'done' && existing.status !== 'done' && existing.recurrence) {
    if (body.outcome === undefined) db.prepare(`UPDATE tasks SET outcome = 'completed' WHERE id = ?`).run(id)
    const nextDate = nextOccurrenceDate(existing)
    if (nextDate) spawnRecurrence(existing, nextDate, now, `Recurred from task ${id}`)
  }
  return { ok: true }
}

function deleteTask(id) {
  const exists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id)
  if (!exists) return { ok: false, reason: 'not_found' } // bug C16: DELETE of a missing task must 404
  const subtaskIds = db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(id).map(r => r.id)
  const allIds = [id, ...subtaskIds]
  const ph = allIds.map(() => '?').join(',')
  // Single transaction (bug C19): otherwise a throw partway (e.g. missing sync_log) commits the
  // earlier child deletes while leaving the task row, silently destroying data on a failed delete.
  const purge = db.transaction(() => {
    db.prepare(`DELETE FROM task_dependencies WHERE task_id IN (${ph}) OR blocked_by_task_id IN (${ph})`).run(...allIds, ...allIds)
    db.prepare(`DELETE FROM notes       WHERE task_id IN (${ph})`).run(...allIds)
    db.prepare(`DELETE FROM agent_jobs  WHERE task_id IN (${ph})`).run(...allIds)
    db.prepare(`DELETE FROM attachments WHERE task_id IN (${ph})`).run(...allIds)
    db.prepare(`DELETE FROM sync_log    WHERE task_id IN (${ph})`).run(...allIds)
    db.prepare('DELETE FROM tasks WHERE id = ? OR parent_id = ?').run(id, id)
  })
  purge()
  return { ok: true }
}

// Optional completion note from the UI ("Complete with note…"). Mirrors MCP complete_task's
// `notes` arg: the outcome goes into ai_context as `Completed: …` (the agent-facing record), and
// is also posted as a user note so it shows in the task's notes thread for the human.
const COMPLETION_NOTE_MAX = 4000
function normalizeCompletionNote(note) {
  if (note == null) return null
  if (typeof note !== 'string') throw validationError('note must be a string')
  const trimmed = note.trim()
  if (!trimmed) return null
  if (trimmed.length > COMPLETION_NOTE_MAX) throw validationError(`note must be at most ${COMPLETION_NOTE_MAX} characters`)
  return trimmed
}
function completionContext(note, fallback) {
  return note ? `Completed via UI: ${note}` : fallback
}
function postCompletionNote(taskId, note) {
  if (!note) return
  db.prepare(`INSERT INTO notes (id, task_id, body, author) VALUES (?, ?, ?, 'user')`).run(crypto.randomUUID(), taskId, `Completed — ${note}`)
}

function completeTask(id, note) {
  const completionNote = normalizeCompletionNote(note)
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false, reason: 'not_found' }
  const { n } = db.prepare(`SELECT count(*) as n FROM tasks WHERE parent_id = ? AND status != 'done'`).get(id)
  if (n > 0) return { ok: false, reason: 'subtasks_incomplete', count: n }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'completed', last_touched_human = ?, last_reviewed_at = ?, ai_context = ? WHERE id = ?`).run(now, now, appendAiContext(task.ai_context, completionContext(completionNote, 'Marked complete via UI.')), id)
  postCompletionNote(id, completionNote)
  if (task.recurrence) {
    const nextDate = nextOccurrenceDate(task)
    if (nextDate) spawnRecurrence(task, nextDate, now, `Recurred from task ${id}`)
  }
  return { ok: true }
}

function completeTaskWithSubtasks(id, note) {
  const completionNote = normalizeCompletionNote(note)
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return { ok: false, reason: 'not_found' }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', last_touched_human = ?, last_reviewed_at = ?, ai_context = ? WHERE parent_id = ? AND status != 'done'`).run(now, now, appendAiContext(null, 'Bulk-completed with parent via UI.'), id)
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'completed', last_touched_human = ?, last_reviewed_at = ?, ai_context = ? WHERE id = ?`).run(now, now, appendAiContext(task.ai_context, completionContext(completionNote, 'Marked complete via UI (with subtasks).')), id)
  postCompletionNote(id, completionNote)
  // Preserve the recurrence chain (bug C9). The UI forces THIS path for any parent that has
  // incomplete subtasks (completeTask rejects it), so without spawning here a recurring task
  // that acquired a subtask would silently end its series. Mirror completeTask's spawn.
  if (task.recurrence) {
    const nextDate = nextOccurrenceDate(task)
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
  const nextDate = nextOccurrenceDate(task)
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
  // Validate before dereferencing (bug C25): a missing/empty `until` used to throw a raw
  // TypeError (until.includes(...)) surfaced as HTTP 500 instead of a 400 for a missing param.
  if (typeof until !== 'string' || !until.trim()) throw validationError('until is required')
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

// bug C16: return not_found (mapped to 404) instead of {ok:true} when the row doesn't exist.
function updateTaskTitle(id, title) { const now = nowIso(); const info = db.prepare('UPDATE tasks SET title = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?').run(title, now, now, id); if (info.changes === 0) return { ok: false, reason: 'not_found' }; return { ok: true } }
function updateTaskDescription(id, description) { const now = nowIso(); const info = db.prepare('UPDATE tasks SET description = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?').run(description ?? null, now, now, id); if (info.changes === 0) return { ok: false, reason: 'not_found' }; return { ok: true } }
function updateTaskDueDate(id, dueDate) { const now = nowIso(); const info = db.prepare('UPDATE tasks SET due_date = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?').run(dueDate || null, now, now, id); if (info.changes === 0) return { ok: false, reason: 'not_found' }; return { ok: true } }
function updateTaskRecurrence(id, recurrence) { const now = nowIso(); const info = db.prepare('UPDATE tasks SET recurrence = ?, last_touched_human = ?, last_reviewed_at = ? WHERE id = ?').run(recurrence || null, now, now, id); if (info.changes === 0) return { ok: false, reason: 'not_found' }; return { ok: true } }

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
      AND orchestrator IS NULL
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

function listNotes(taskId) { return withTimestampZones(db.prepare(`SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC`).all(taskId), 'notes') }
function addNote(taskId, body) {
  if (!body?.trim()) throw validationError('body required')
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
  if (!slug || !label) throw validationError('slug and label required')
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
  const activeCounts = db.prepare(`SELECT project, COUNT(*) as n FROM tasks WHERE status = 'active' AND task_type NOT IN ('coding','event') AND orchestrator IS NULL AND project IS NOT NULL GROUP BY project`).all()
  const codingCounts = db.prepare(`SELECT project, COUNT(*) as n FROM tasks WHERE (task_type = 'coding' OR orchestrator IS NOT NULL) AND status NOT IN ('done','archived') AND project IS NOT NULL GROUP BY project`).all()
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
  const active = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE project = ? AND status = 'active' AND task_type NOT IN ('coding','event') AND orchestrator IS NULL AND parent_id IS NULL ORDER BY ${ORDER}`).all(name))
  const coding = attachSubtasks(db.prepare(`SELECT * FROM tasks WHERE project = ? AND (task_type = 'coding' OR orchestrator IS NOT NULL) AND status NOT IN ('done','archived') AND parent_id IS NULL ORDER BY created_at DESC`).all(name))
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
// One implementation with the MCP rescan_capabilities tool (syncScannedAgents): agents + capabilities
// upserted, and rows under `opts.root` whose folder is gone pruned, in one transaction.
function upsertAgents(agents, opts = {}) {
  return syncScannedAgents(db, agents, { root: opts.root ?? null })
}
function queuedAgentPaths() {
  return db.prepare(`SELECT DISTINCT agent_path FROM agent_jobs WHERE status = 'queued' AND agent_path IS NOT NULL`).pluck().all()
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
// Day-by-day history for one habit over [start, end] (year view + drill-down). Archived habits
// are included so their history stays auditable.
function getHabitHistory(habitId, start, end) {
  const err = habitRangeError(start, end)
  if (err) throw validationError(err)
  const habit = db.prepare('SELECT * FROM habits WHERE id = ?').get(habitId)
  if (!habit) { const e = new Error('Habit not found'); e.status = 404; throw e }
  const logs = db.prepare('SELECT date, status, notes FROM habit_logs WHERE habit_id = ? AND date >= ? AND date <= ?').all(habitId, start, end)
  return { ...buildHabitHistory(habit, logs, start, end, { days: true, notes: true }), created_at: habit.created_at }
}
function createHabit(body) {
  if (!body.title) throw validationError('title required')
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

function listAttachments(taskId) { return withTimestampZones(db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(taskId), 'attachments') }
function insertAttachment(data) {
  const { id, taskId, filename, mimeType, sizeBytes, bucket, key, url, localPath, encrypted } = data
  db.prepare(`INSERT INTO attachments (id, task_id, filename, mimetype, size_bytes, bucket, key, url, local_path, encrypted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, filename, mimeType, sizeBytes, bucket, key, url, localPath, encrypted ?? 0)
  return withTimestampZones(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id), 'attachments')
}
// getPendingAttachments below is deliberately unstamped: it feeds the upload worker, not a caller.
function getAttachment(id) { return withTimestampZones(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id), 'attachments') ?? null }
function deleteAttachment(id) { db.prepare('DELETE FROM attachments WHERE id = ?').run(id); return { ok: true } }
function getPendingAttachments() { return db.prepare(`SELECT * FROM attachments WHERE bucket IS NULL AND local_path IS NOT NULL`).all() }
function updateAttachmentStorage(id, bucket, key, url, encrypted = 0) {
  db.prepare(`UPDATE attachments SET bucket = ?, key = ?, url = ?, encrypted = ? WHERE id = ?`).run(bucket, key, url, encrypted, id)
  return { ok: true }
}

// ── Agent jobs ────────────────────────────────────────────────────────────────

function listAgentJobs(taskId) {
  const rows = taskId
    ? db.prepare(`SELECT * FROM agent_jobs WHERE task_id = ? ORDER BY created_at DESC`).all(taskId)
    : db.prepare(`SELECT * FROM agent_jobs ORDER BY created_at DESC LIMIT 50`).all()
  return withTimestampZones(rows, 'agent_jobs')
}
function getAgentJob(id) {
  const job = db.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(id)
  if (!job) throw new Error('Job not found')
  return withTimestampZones(job, 'agent_jobs')
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
// One job at a time per concurrency key. Every job in an agent folder shares that folder's
// working tree — a pipeline's migration path checks out the branch, runs installs and reads the
// tree back — so two jobs there at once fight over one checkout, and after a restart or an outage
// the whole backlog arrives together, which makes this the normal case rather than an edge. The
// key comes from agent.config (`concurrency_key`) and defaults to the agent folder; a repo that
// spreads plan/execute/pipeline folders over one checkout sets the same key in each. Within a
// batch only the oldest queued job per key is returned, and none while a running job holds it.
// Ties on created_at (second resolution) break on rowid so two jobs queued in the same second
// still serialize.
//
// A folder with `worktrees: true` gives each task its own checkout instead, so a job that carries a
// task identity (external_meta.task_ref) is keyed `<folder key>#<task_ref>`: different tasks run in
// parallel up to MAX_CONCURRENT_JOBS, one task's jobs still run one at a time. Two exceptions keep
// the folder key and the folder cwd: a job with no task identity (heartbeat, manual run), and a
// task that already has a session from a run in the folder itself. Claude keys sessions by cwd, so
// that task could not resume from a worktree; it finishes where it started.
const JOB_TASK_REF_SQL = `CASE WHEN json_valid(j.external_meta) THEN json_extract(j.external_meta, '$.task_ref') END`
const JOB_BASE_KEY_SQL = `COALESCE(a.concurrency_key, j.agent_path)`
const JOB_USES_WORKTREE_SQL = `(
  COALESCE(a.worktrees, 0) = 1 AND j.task_id IS NOT NULL AND ${JOB_TASK_REF_SQL} IS NOT NULL AND ${JOB_TASK_REF_SQL} != ''
  AND NOT EXISTS (
    SELECT 1 FROM agent_jobs p
    WHERE p.task_id = j.task_id AND p.id != j.id AND p.session_id IS NOT NULL
      AND (p.run_cwd IS NULL OR p.run_cwd = p.agent_path)
  )
)`
function getQueuedJobs(limit) {
  const jobs = db.prepare(`
    WITH base AS (
      SELECT j.rowid AS rid, j.*, ${JOB_BASE_KEY_SQL} AS base_ckey,
        ${JOB_USES_WORKTREE_SQL} AS use_worktree, ${JOB_TASK_REF_SQL} AS worktree_task_ref
      FROM agent_jobs j LEFT JOIN agents a ON a.path = j.agent_path
      WHERE j.status IN ('queued', 'running')
    ),
    keyed AS (
      SELECT *, base_ckey || CASE WHEN use_worktree THEN '#' || worktree_task_ref ELSE '' END AS ckey FROM base
    )
    SELECT * FROM keyed q
    WHERE q.status = 'queued'
      AND NOT EXISTS (SELECT 1 FROM keyed r WHERE r.status = 'running' AND r.ckey = q.ckey)
      AND q.rid = (SELECT rid FROM keyed f WHERE f.status = 'queued' AND f.ckey = q.ckey ORDER BY f.created_at ASC, f.rid ASC LIMIT 1)
    ORDER BY q.created_at ASC, q.rid ASC LIMIT ?
  `).all(limit).map(({ rid, ckey, base_ckey, use_worktree, worktree_task_ref, ...job }) => ({
    ...job,
    worktreeTaskRef: use_worktree ? worktree_task_ref : null,
  }))
  return jobs.map(job => {
    const task = job.task_id ? db.prepare('SELECT agent_resume FROM tasks WHERE id = ?').get(job.task_id) : null
    const canResume = task?.agent_resume !== 0 && job.resume_session !== 0
    const prev = canResume && job.task_id
      ? db.prepare(`SELECT session_id FROM agent_jobs WHERE task_id = ? AND session_id IS NOT NULL AND (status IN ('done', 'timed_out', 'orphaned') OR (status = 'failed' AND terminated_by IN ('oom', 'exited_with_children'))) ORDER BY completed_at DESC, rowid DESC LIMIT 1`).get(job.task_id)
      : null
    return { ...job, prevSessionId: prev?.session_id ?? null }
  })
}
// Queue a job whose prompt an outside orchestrator composed. The prompt is stored verbatim —
// nothing from the task record is prepended — so what the agent saw is exactly the row the
// orchestrator holds. user_message is set to the same text: on a resumed session only the new
// turn is sent (resumeMessageForJob in server/workers.js), and the orchestrator's prompt *is* the
// new turn. Idempotent on external_ref: a re-delivered request returns the job it already made.
function queueExternalJob(body = {}) {
  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  if (!prompt.trim()) throw validationError('prompt required')
  if (!body.agent_path) throw validationError('agent_path required')
  const externalRef = body.external_ref ? String(body.external_ref) : null
  if (externalRef) {
    const existing = db.prepare('SELECT id, status FROM agent_jobs WHERE external_ref = ?').get(externalRef)
    if (existing) return { id: existing.id, status: existing.status, existing: true }
  }
  const task = body.task_id ? db.prepare('SELECT id, status, orchestrator, ai_context FROM tasks WHERE id = ?').get(body.task_id) : null
  if (body.task_id && !task) throw validationError('task not found')
  const id = crypto.randomUUID()
  // New work for an orchestrated task that already closed (a PR reopened, a late closeout) reopens
  // that same task, so one orchestrator task always maps to one Qalatra task. Done in the same
  // synchronous call as the insert, so a sweep can never close it between reopen and queue.
  if (task?.orchestrator && (task.status === 'done' || task.status === 'archived')) {
    db.prepare(`UPDATE tasks SET status = 'active', outcome = NULL, ai_context = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(appendAiContext(task.ai_context, `Reopened: new ${task.orchestrator} dispatch.`), task.id)
  }
  db.prepare(`INSERT INTO agent_jobs (id, task_id, agent_path, prompt, user_message, external_ref, external_meta, resume_session) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, body.task_id ?? null, body.agent_path, prompt, prompt, externalRef,
      body.external_meta == null ? null : JSON.stringify(body.external_meta),
      body.resume_session === false || body.resume_session === 0 ? 0 : 1)
  return { id, status: 'queued', existing: false }
}
function getAgentJobByExternalRef(externalRef) {
  const job = db.prepare('SELECT * FROM agent_jobs WHERE external_ref = ?').get(String(externalRef))
  return job ? withTimestampZones(job, 'agent_jobs') : null
}
function findTaskByOrchestratorRef(orchestrator, ref) {
  const row = db.prepare('SELECT id FROM tasks WHERE orchestrator = ? AND orchestrator_ref = ? ORDER BY created_at ASC LIMIT 1').get(orchestrator, String(ref))
  return row ? getTask(row.id) : null
}
// Every create/bind path goes through here, and it always makes the task a coding task: the
// orchestrator is its system of record, so it lives in the Coding view, never the priority view.
function bindTaskOrchestrator(taskId, orchestrator, ref) {
  const info = db.prepare(`UPDATE tasks SET orchestrator = ?, orchestrator_ref = ?, task_type = 'coding' WHERE id = ?`).run(orchestrator, String(ref), taskId)
  if (!info.changes) throw new Error('Task not found')
  return { ok: true }
}
// Open tasks an orchestrator drives, with whether any job for them is still queued or running —
// the input to the orchestrator's "is this finished?" sweep.
function listOpenOrchestratedTasks(orchestrator) {
  return db.prepare(`
    SELECT t.id, t.orchestrator_ref, t.status,
      COALESCE(t.agent_path, (SELECT j.agent_path FROM agent_jobs j WHERE j.task_id = t.id ORDER BY j.created_at DESC LIMIT 1)) AS agent_path,
      EXISTS (SELECT 1 FROM agent_jobs j WHERE j.task_id = t.id AND j.status IN ('queued', 'running')) AS has_pending_job
    FROM tasks t
    WHERE t.orchestrator = ? AND t.status NOT IN ('done', 'archived')
    ORDER BY t.created_at ASC
  `).all(orchestrator).map(r => ({ ...r, has_pending_job: Boolean(r.has_pending_job) }))
}
// Close a task because its orchestrator is finished with it. Refuses while a job is queued or
// running — the same task receives later dispatches (build after plan, closeout after merge), so
// "a job finished" alone is never enough. Writes nothing to sync_log: the orchestrator is the
// system of record and already knows. Check and write happen in one synchronous call.
function closeOrchestratedTask(taskId, note) {
  const task = db.prepare('SELECT id, status, orchestrator, ai_context FROM tasks WHERE id = ?').get(taskId)
  if (!task) return { closed: false, reason: 'not_found' }
  if (!task.orchestrator) return { closed: false, reason: 'not_orchestrated' }
  if (task.status === 'done' || task.status === 'archived') return { closed: false, reason: 'already_closed' }
  const pending = db.prepare(`SELECT 1 FROM agent_jobs WHERE task_id = ? AND status IN ('queued', 'running') LIMIT 1`).get(taskId)
  if (pending) return { closed: false, reason: 'job_pending' }
  const now = nowIso()
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'completed', last_reviewed_at = ?, updated_at = datetime('now'), ai_context = ? WHERE id = ?`)
    .run(now, appendAiContext(task.ai_context, note || 'Closed: orchestrator finished; no pending jobs.'), taskId)
  return { closed: true }
}
function recordExternalOp({ external_ref, orchestrator, op, status, result }) {
  db.prepare(`INSERT INTO external_ops (external_ref, orchestrator, op, status, result) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(external_ref) DO UPDATE SET status = excluded.status, result = excluded.result`)
    .run(String(external_ref), orchestrator, op, status, result == null ? null : JSON.stringify(result))
  return { ok: true }
}
function getExternalOp(externalRef) {
  const row = db.prepare('SELECT * FROM external_ops WHERE external_ref = ?').get(String(externalRef))
  if (!row) return null
  let result = null
  try { result = row.result ? JSON.parse(row.result) : null } catch { result = { text: row.result } }
  return { ...row, result }
}
// Report outbox (see external_reports). Enqueue fills a row the job's terminal write left blank
// and otherwise keeps the first payload: the report built when the job ended is the authoritative
// one, and a later reconcile must not replace it.
function parseReport(row) {
  if (!row) return null
  let payload = null
  try { payload = row.payload ? JSON.parse(row.payload) : null } catch { payload = null }
  return { ...row, payload }
}
function enqueueExternalReport({ external_ref, orchestrator, agent_path = null, target, mode = 'ladder', payload = null }) {
  db.prepare(`INSERT INTO external_reports (external_ref, orchestrator, agent_path, target, mode, payload) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_ref) DO UPDATE SET
      agent_path = COALESCE(external_reports.agent_path, excluded.agent_path),
      target = COALESCE(external_reports.target, excluded.target),
      mode = CASE WHEN external_reports.payload IS NULL THEN excluded.mode ELSE external_reports.mode END,
      payload = COALESCE(external_reports.payload, excluded.payload)`)
    .run(String(external_ref), orchestrator, agent_path, target, mode, payload == null ? null : JSON.stringify(payload))
  return parseReport(db.prepare('SELECT * FROM external_reports WHERE external_ref = ?').get(String(external_ref)))
}
function getExternalReport(externalRef) {
  return parseReport(db.prepare('SELECT * FROM external_reports WHERE external_ref = ?').get(String(externalRef)))
}
function listDueExternalReports(orchestrator, now = new Date().toISOString(), limit = 50) {
  return db.prepare(`SELECT * FROM external_reports WHERE orchestrator = ? AND next_attempt_at <= ? ORDER BY created_at LIMIT ?`)
    .all(orchestrator, now, limit).map(parseReport)
}
function countExternalReports(orchestrator) {
  return db.prepare('SELECT COUNT(*) AS n FROM external_reports WHERE orchestrator = ?').get(orchestrator).n
}
function ackExternalReport(externalRef) {
  return { deleted: db.prepare('DELETE FROM external_reports WHERE external_ref = ?').run(String(externalRef)).changes }
}
function deferExternalReport(externalRef, nextAttemptAt, error) {
  db.prepare('UPDATE external_reports SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE external_ref = ?')
    .run(nextAttemptAt, error == null ? null : String(error).slice(0, 1000), String(externalRef))
  return getExternalReport(externalRef)
}
// Whether a session operation must wait for a running job under this folder's base concurrency
// key (see getQueuedJobs), since that job's agent may be mid-inject into the same session. Only
// a job that could be touching the op's session blocks it: one for the same task (task_ref ===
// taskRef), one with no task identity (a heartbeat or manual run could be doing anything), or one
// whose own session is the op's session. A long job for another task, in its worktree or the
// shared checkout, no longer stalls that task's relays. Without a taskRef the op can't be
// attributed, so any running job in the folder still counts. Job admission is unaffected.
function folderHasRunningJob(agentPath, { taskRef = null, sessionId = null } = {}) {
  const row = db.prepare(`
    WITH me AS (SELECT COALESCE((SELECT concurrency_key FROM agents WHERE path = @path), @path) AS ckey)
    SELECT 1 AS busy FROM agent_jobs j LEFT JOIN agents a ON a.path = j.agent_path, me
    WHERE j.status = 'running' AND ${JOB_BASE_KEY_SQL} = me.ckey
      AND (@taskRef IS NULL
        OR COALESCE(${JOB_TASK_REF_SQL}, '') = ''
        OR ${JOB_TASK_REF_SQL} = @taskRef
        OR (@sessionId IS NOT NULL AND j.session_id = @sessionId))
    LIMIT 1
  `).get({ path: agentPath, taskRef: taskRef ? String(taskRef) : null, sessionId: sessionId ? String(sessionId) : null })
  return Boolean(row?.busy)
}
function setAgentJobRunCwd(id, cwd) {
  db.prepare('UPDATE agent_jobs SET run_cwd = ? WHERE id = ?').run(cwd, id)
  return { ok: true }
}
// Inputs to worktree cleanup: which task refs still have a queued or running job (a worktree is
// never removed under one), and when a worktree last ran anything.
function listActiveTaskRefs() {
  return db.prepare(`
    SELECT DISTINCT j.agent_path, ${JOB_TASK_REF_SQL} AS task_ref
    FROM agent_jobs j WHERE j.status IN ('queued', 'running') AND ${JOB_TASK_REF_SQL} IS NOT NULL
  `).all()
}
function lastJobActivityUnder(cwd) {
  const row = db.prepare(`
    SELECT MAX(COALESCE(completed_at, started_at, created_at)) AS last
    FROM agent_jobs WHERE run_cwd = @cwd OR run_cwd LIKE @prefix ESCAPE '\\'
  `).get({ cwd, prefix: `${cwd.replace(/[\\%_]/g, m => `\\${m}`)}/%` })
  return row?.last ?? null
}
function listWorktreeAgents() {
  return db.prepare('SELECT path, concurrency_key FROM agents WHERE worktrees = 1').all()
}
function startAgentJob(id) {
  // Atomic claim (bug C6): only transition a job that is still 'queued'. If another worker/
  // instance already claimed it, changes === 0 and the caller must not run it.
  const info = db.prepare(`UPDATE agent_jobs SET status = 'running', started_at = datetime('now') WHERE id = ? AND status = 'queued'`).run(id)
  return { ok: info.changes === 1, claimed: info.changes === 1 }
}
function setAgentJobRuntime(id, runtime) {
  db.prepare('UPDATE agent_jobs SET runtime = ? WHERE id = ?').run(runtime, id)
  return { ok: true }
}
function finishAgentJob(id, status, result, sessionId, terminatedBy = null, usage = null, mcpToolCalls = null) {
  db.transaction(() => {
    db.prepare(`UPDATE agent_jobs SET status = ?, result = ?, session_id = ?, terminated_by = ?, usage_json = ?, mcp_tool_calls = ?, completed_at = datetime('now') WHERE id = ?`)
      .run(status, result, sessionId, terminatedBy, usage ? JSON.stringify(usage) : null, mcpToolCalls, id)
    oweExternalReport(id)
  })()
  return { ok: true }
}
// An orchestrated job just reached a terminal status: record that its orchestrator is owed a
// report. The integration fills in what to send; this row only guarantees somebody will. It is
// not due for a minute, so the tick does not race the finish hook and rebuild a report that is
// less specific than the one the hook is about to store (launch_failed, dependency_down…).
function oweExternalReport(jobId) {
  const job = db.prepare('SELECT external_ref, external_meta, agent_path FROM agent_jobs WHERE id = ?').get(jobId)
  if (!job?.external_ref) return
  let orchestrator = null
  try { orchestrator = JSON.parse(job.external_meta ?? 'null')?.orchestrator ?? null } catch {}
  if (!orchestrator) return
  db.prepare(`INSERT INTO external_reports (external_ref, orchestrator, agent_path, next_attempt_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')) ON CONFLICT(external_ref) DO NOTHING`)
    .run(String(job.external_ref), orchestrator, job.agent_path)
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
function getRunningAgentJobs() {
  return db.prepare(`SELECT * FROM agent_jobs WHERE status = 'running'`).all()
}
const ORPHANED_RESULT = 'Job orphaned: the app instance running it stopped (restart or crash) before it reported a result. This is an infrastructure event, not an agent failure; partial work may still have landed.'
function resetStuckJobs(bootBoundary = null, { ids = null, details = {} } = {}) {
  // Runs once at startup, only on the instance that won the single-instance port lock (see
  // server/index.js). The previous instance is therefore gone. Boot reconciliation
  // (recoverRunningJobs in server/workers.js) has already re-adopted the runs that are still alive
  // and finished the ones that ended while nobody watched; it passes the rest as `ids`. Without
  // `ids`, every 'running' job is treated as lost.
  //
  // That is an INFRASTRUCTURE event, not an agent failure, so it gets its own terminal status
  // (`orphaned`) and cause (`terminated_by = 'app_restart'`) rather than being labelled `failed` —
  // which would pollute failure counts / infra-error detectors and hide the cause behind a string.
  // `details[id]` carries the session id and partial output salvaged from the run's files, so the
  // orphan stays resumable.
  //
  // We deliberately do NOT auto-requeue. Job prompts are built at launch and these jobs are not
  // idempotent, so a blind requeue re-injects already-completed work (a cloud session's reply can
  // land after the job dies). Requeue is the consumer/orchestrator's decision — it can reconstruct
  // what actually completed and requeue safely; `terminated_boundary` gives it the restart instant
  // to reason about without diffing PR head SHAs.
  // Reported back so an integration can tell its orchestrator which of *its* runs died with the
  // instance, instead of leaving them ACKNOWLEDGED forever on the other side.
  const running = db.prepare(`SELECT id, task_id, agent_path, session_id, external_ref, external_meta FROM agent_jobs WHERE status = 'running'`).all()
  const wanted = Array.isArray(ids) ? new Set(ids) : null
  const targets = wanted ? running.filter(job => wanted.has(job.id)) : running
  const update = db.prepare(`
    UPDATE agent_jobs
    SET status = 'orphaned',
        terminated_by = 'app_restart',
        terminated_boundary = @boundary,
        result = @result,
        session_id = COALESCE(@session, session_id),
        completed_at = datetime('now')
    WHERE id = @id AND status = 'running'
  `)
  const orphaned = []
  db.transaction(() => {
    for (const job of targets) {
      const detail = details?.[job.id] ?? {}
      const session = detail.sessionId ?? null
      update.run({ id: job.id, boundary: bootBoundary, result: detail.result || ORPHANED_RESULT, session })
      oweExternalReport(job.id)
      orphaned.push({ ...job, session_id: session ?? job.session_id })
    }
  })()
  return { ok: true, orphaned }
}
// A one-shot task autoruns once, ever. A recurring task is one row per occurrence until it is
// completed, so "ever" wedged it: a run that died before completing the task (timeout, OOM, crash)
// never spawned the next occurrence, and the row's single job blocked autorun for good. A recurring
// task is therefore blocked only by a job still in flight or one already launched today (local
// day; created_at is UTC), so an unfinished occurrence retries at most once a day until it is done.
function getAutorunTasks() {
  return db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.agent_path IS NOT NULL AND t.agent_autorun = 1 AND t.status = 'active'
      AND (t.due_date IS NULL OR t.due_date <= date('now', 'localtime'))
      AND time('now', 'localtime') >= COALESCE(t.agent_autorun_time, '09:00')
      AND NOT EXISTS (
        SELECT 1 FROM agent_jobs j WHERE j.task_id = t.id
          AND (t.recurrence IS NULL
            OR j.status IN ('queued', 'running')
            OR j.created_at >= datetime('now', 'localtime', 'start of day', 'utc'))
      )
  `).all()
}
function insertAutorunJob(taskId, agentPath, prompt) {
  const fullPrompt = `You are an agent running inside Qalatra. Task ID: ${taskId}\nIf you create any output files, save them to ${agentPath}/output/ and include their file paths in your response. Qalatra will auto-attach existing mentioned files back to this task.\n${prompt}`
  db.prepare(`INSERT INTO agent_jobs (id, task_id, agent_path, prompt) VALUES (?, ?, ?, ?)`).run(crypto.randomUUID(), taskId, agentPath, fullPrompt)
  return { ok: true }
}

// ── Heartbeats ────────────────────────────────────────────────────────────────
// Schedule validation and next-run math are imported from server/task-logic.js (shared with mcp).

// A heartbeat row leaving the process: zone-stamped, plus the next three cron runs (UTC ISO; empty
// for interval schedules). Computed from the stored naive row, before stamping.
function heartbeatOut(row) {
  if (!row) return row
  return withTimestampZones({ ...row, upcoming_runs: heartbeatUpcomingRuns(row) }, 'heartbeats')
}

function listHeartbeats() {
  const rows = db.prepare(`
    SELECT h.*,
      (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status = 'done') as runs_done,
      (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status = 'failed') as runs_failed,
      (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status IN ('queued','running')) as runs_pending
    FROM heartbeats h ORDER BY h.created_at DESC
  `).all()
  return rows.map(heartbeatOut)
}

function createHeartbeat(fields = {}) {
  const { title, description, agent_path, prompt } = fields
  if (!title || !agent_path || !prompt) throw new Error('title, agent_path, and prompt are required')
  const schedule = resolveHeartbeatSchedule(fields)
  const id = crypto.randomUUID()
  const now = nowIso()
  db.prepare(`
    INSERT INTO heartbeats (id, title, description, agent_path, prompt, interval_minutes, run_at_time, minute_offset, cron_expression, timezone, active, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, title.trim(), description ?? null, agent_path.trim(), prompt.trim(), schedule.interval_minutes, schedule.run_at_time,
    schedule.minute_offset, schedule.cron_expression, schedule.timezone, heartbeatNextRunAt(schedule), now, now)
  return heartbeatOut(db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id))
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
  // normalization, so a schedule edit takes effect immediately instead of firing on the stale
  // next_run_at. resolveHeartbeatSchedule rejects cron mixed with interval fields.
  const scheduleChanged = touchesHeartbeatSchedule(fields)
  if (scheduleChanged) {
    const schedule = resolveHeartbeatSchedule(fields, existing)
    for (const [k, v] of Object.entries(schedule)) { sets.push(`${k} = ?`); vals.push(v) }
    sets.push('next_run_at = ?'); vals.push(heartbeatNextRunAt(schedule))
  }
  // Idempotent enable/disable — the fix for the toggleHeartbeat blind-flip footgun:
  // setting the same value twice is a no-op, unlike toggle. Resuming (0→1) schedules
  // the next run like toggle does, unless a schedule change above already set it.
  if ('active' in fields && fields.active !== undefined) {
    const newActive = fields.active ? 1 : 0
    sets.push('active = ?'); vals.push(newActive)
    if (newActive === 1 && existing.active !== 1 && !scheduleChanged) {
      sets.push('next_run_at = ?'); vals.push(heartbeatNextRunAt(existing))
    }
  }
  if (!sets.length) return heartbeatOut(existing)
  sets.push('updated_at = ?'); vals.push(nowIso()); vals.push(id)
  db.prepare(`UPDATE heartbeats SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return heartbeatOut(db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id))
}

function deleteHeartbeat(id) {
  db.prepare(`DELETE FROM agent_jobs WHERE heartbeat_id = ?`).run(id)
  db.prepare(`DELETE FROM heartbeats WHERE id = ?`).run(id)
  return { ok: true }
}

function toggleHeartbeat(id) {
  const hb = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id)
  if (!hb) throw new Error('Heartbeat not found')
  if (hb.active === 1) {
    db.prepare(`UPDATE heartbeats SET active = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id)
  } else {
    db.prepare(`UPDATE heartbeats SET active = 1, next_run_at = ?, updated_at = ? WHERE id = ?`).run(heartbeatNextRunAt(hb), nowIso(), id)
  }
  return heartbeatOut(db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id))
}

// next_run_at and datetime('now') are both UTC. A heartbeat with a queued or running job waits for
// it to finish rather than piling up runs.
const HEARTBEAT_IS_DUE = `
  h.active = 1
  AND h.next_run_at IS NOT NULL
  AND h.next_run_at <= datetime('now')
  AND NOT EXISTS (
    SELECT 1 FROM agent_jobs j
    WHERE j.heartbeat_id = h.id AND j.status IN ('queued','running')
  )`

function getDueHeartbeats() {
  return db.prepare(`SELECT h.* FROM heartbeats h WHERE ${HEARTBEAT_IS_DUE}`).all()
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

// Fire one due heartbeat: queue its job and advance next_run_at in one transaction, re-checking
// due-ness inside it. These used to be two separate calls (createHeartbeatJob, then
// markHeartbeatRun), so a restart between them left next_run_at on the slot that had just run, and
// it ran again once that job finished. Now a slot fires exactly once: either both writes land or
// neither does, and the new next_run_at is the first slot strictly after now. A slot missed while
// the server was down is still overdue at boot and fires once; several missed slots collapse into
// that one run.
// last_run_at is UTC like next_run_at and agent_jobs.created_at, not local nowIso()
// (docs/bug-heartbeat-timezone-mismatch.md); updated_at stays local like the rest of the table.
const fireHeartbeat = db.transaction((id) => {
  const hb = db.prepare(`SELECT h.* FROM heartbeats h WHERE h.id = ? AND ${HEARTBEAT_IS_DUE}`).get(id)
  if (!hb) return { fired: false }
  const job = createHeartbeatJob(id)
  db.prepare(`UPDATE heartbeats SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
    .run(utcNowIso(), heartbeatNextRunAt(hb), nowIso(), id)
  return { fired: true, job_id: job.id }
})

function listHeartbeatJobs(heartbeatId, limit = 10) {
  const rows = db.prepare(`
    SELECT id, status, result, created_at, started_at, completed_at
    FROM agent_jobs WHERE heartbeat_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(heartbeatId, limit)
  return withTimestampZones(rows, 'agent_jobs')
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
  upsertAgents, queuedAgentPaths, listAgentsDb,
  listCapabilitiesDb, getCapabilityDb, searchCapabilitiesDb,
  listHabits, getHabitHistory, createHabit, updateHabit, logHabit, unlogHabit,
  listAttachments, insertAttachment, getAttachment, deleteAttachment,
  getPendingAttachments, updateAttachmentStorage,
  listAgentJobs, getAgentJob, createAgentJob,
  getQueuedJobs, startAgentJob, setAgentJobRuntime, finishAgentJob, insertAgentNote,
  resetStuckJobs, getRunningAgentJobs, getAutorunTasks, insertAutorunJob,
  queueExternalJob, getAgentJobByExternalRef, findTaskByOrchestratorRef, bindTaskOrchestrator, listOpenOrchestratedTasks, closeOrchestratedTask,
  recordExternalOp, getExternalOp, folderHasRunningJob,
  enqueueExternalReport, getExternalReport, listDueExternalReports, countExternalReports, ackExternalReport, deferExternalReport,
  setAgentJobRunCwd, listActiveTaskRefs, lastJobActivityUnder, listWorktreeAgents,
  listHeartbeats, createHeartbeat, updateHeartbeat, deleteHeartbeat, toggleHeartbeat,
  getDueHeartbeats, fireHeartbeat, listHeartbeatJobs,
}

parentPort.on('message', ({ id, method, args }) => {
  const fn = METHODS[method]
  if (!fn) { parentPort.postMessage({ id, error: `Unknown method: ${method}` }); return }
  try {
    parentPort.postMessage({ id, result: fn(...(args ?? [])) })
  } catch (err) {
    // Carry err.status across the boundary (bug C17) so validation errors become HTTP 4xx.
    parentPort.postMessage({ id, error: err.message, status: err.status ?? null })
  }
})

parentPort.postMessage({ ready: true })
