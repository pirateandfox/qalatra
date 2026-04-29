import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';
import pkg from 'rrule';
const { rrulestr } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TASKOS_DB_DIR ?? path.join(__dirname, '..', 'db');
const DB_PATH = path.join(DATA_DIR, 'tasks.db');

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL,
      description         TEXT,
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
      sort_order          INTEGER,
      parent_id           TEXT REFERENCES tasks(id),
      recurrence          TEXT,
      outcome             TEXT,
      agent_path          TEXT,
      agent_resume        INTEGER NOT NULL DEFAULT 1,
      agent_autorun       INTEGER NOT NULL DEFAULT 0,
      agent_autorun_time  TEXT DEFAULT '09:00'
    );

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

    CREATE TABLE IF NOT EXISTS daily_notes (
      date       TEXT PRIMARY KEY,
      content    TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contexts (
      slug          TEXT PRIMARY KEY,
      display_name  TEXT,
      source        TEXT,
      source_config TEXT,
      notes         TEXT,
      active        INTEGER NOT NULL DEFAULT 1
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

    CREATE TABLE IF NOT EXISTS attachments (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      mimetype     TEXT,
      size_bytes   INTEGER,
      bucket       TEXT,
      key          TEXT,
      url          TEXT,
      local_path   TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TRIGGER IF NOT EXISTS tasks_updated_at
    AFTER UPDATE ON tasks
    FOR EACH ROW
    BEGIN
      UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
    END;
  `);

  // Migrations — add columns that may not exist in older DBs
  const tryAlter = sql => { try { db.exec(sql); } catch (_) {} };
  // Handle notes→description rename (db-worker migration) for older MCP-only DBs
  tryAlter('ALTER TABLE tasks RENAME COLUMN notes TO description');
  const existingCols = db.prepare(`PRAGMA table_info(tasks)`).all().map(r => r.name);
  if (!existingCols.includes('recurrence'))         db.exec('ALTER TABLE tasks ADD COLUMN recurrence TEXT');
  if (!existingCols.includes('outcome'))            db.exec('ALTER TABLE tasks ADD COLUMN outcome TEXT');
  if (!existingCols.includes('end_time'))           db.exec('ALTER TABLE tasks ADD COLUMN end_time TEXT');
  if (!existingCols.includes('agent_path'))         db.exec('ALTER TABLE tasks ADD COLUMN agent_path TEXT');
  if (!existingCols.includes('links'))              db.exec("ALTER TABLE tasks ADD COLUMN links TEXT DEFAULT '[]'");
  if (!existingCols.includes('sort_order'))         db.exec('ALTER TABLE tasks ADD COLUMN sort_order INTEGER');
  if (!existingCols.includes('agent_resume'))       db.exec('ALTER TABLE tasks ADD COLUMN agent_resume INTEGER NOT NULL DEFAULT 1');
  if (!existingCols.includes('agent_autorun'))      db.exec('ALTER TABLE tasks ADD COLUMN agent_autorun INTEGER NOT NULL DEFAULT 0');
  if (!existingCols.includes('agent_autorun_time')) db.exec("ALTER TABLE tasks ADD COLUMN agent_autorun_time TEXT DEFAULT '09:00'");
  if (!existingCols.includes('description'))        db.exec('ALTER TABLE tasks ADD COLUMN description TEXT');
  if (!existingCols.includes('inbox'))              db.exec('ALTER TABLE tasks ADD COLUMN inbox INTEGER NOT NULL DEFAULT 0');

  // Migrations for contexts table columns added after initial schema
  const contextCols = db.prepare(`PRAGMA table_info(contexts)`).all().map(r => r.name);
  if (!contextCols.includes('label')) {
    db.exec(`ALTER TABLE contexts ADD COLUMN label TEXT`);
  }
  if (!contextCols.includes('color')) {
    db.exec(`ALTER TABLE contexts ADD COLUMN color TEXT NOT NULL DEFAULT '#888888'`);
  }
  if (!contextCols.includes('sort_order')) {
    db.exec(`ALTER TABLE contexts ADD COLUMN sort_order INTEGER`);
  }

  // Migrations for habits table
  const habitCols = db.prepare(`PRAGMA table_info(habits)`).all().map(r => r.name);
  if (!habitCols.includes('recurrence_days')) {
    db.exec(`ALTER TABLE habits ADD COLUMN recurrence_days TEXT`);
  }

  // Seed default contexts on first run
  const { c } = db.prepare('SELECT count(*) as c FROM contexts').get();
  if (c === 0) {
    db.prepare(
      'INSERT OR IGNORE INTO contexts (slug, display_name, source, notes) VALUES (?, ?, ?, ?)'
    ).run('personal', 'Personal', null, 'Personal tasks and habits');
  }
}

export function openDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  // Set busy_timeout BEFORE journal_mode and initSchema so both the API and MCP
  // processes can wait on each other's write locks during simultaneous startup
  // instead of failing immediately with SQLITE_BUSY.
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

export function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function nowIso() {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${day} ${h}:${mi}:${s}`;
}

// Legacy shorthand → RRULE string
const LEGACY_RRULE = {
  'daily':    'FREQ=DAILY',
  'weekdays': 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  'weekly':   'FREQ=WEEKLY',
  'monthly':  'FREQ=MONTHLY',
};

export function toRruleString(recurrence) {
  return LEGACY_RRULE[recurrence] ?? recurrence;
}

// Human-readable description of a recurrence pattern
export function rruleToText(recurrence) {
  if (!recurrence) return null;
  try {
    const rule = rrulestr('RRULE:' + toRruleString(recurrence));
    return rule.toText();
  } catch (_) {
    return recurrence;
  }
}

// Returns the next ISO date string (YYYY-MM-DD) after baseDate for the given recurrence.
// recurrence: legacy shorthand OR full RRULE string (e.g. 'FREQ=MONTHLY;BYMONTHDAY=1')
export function nextRecurrenceDate(baseDate, recurrence) {
  if (!recurrence) return null;
  try {
    let rruleStr = toRruleString(recurrence);
    // Anchor to midnight UTC on baseDate. Use exclusive after() so we always get the
    // NEXT occurrence strictly after baseDate without shifting the weekday/monthday anchor.
    // (Using day+1 with inclusive was shifting FREQ=WEEKLY's weekday anchor when baseDate
    // and the completion day were on different weekdays.)
    const dtstart = new Date(baseDate + 'T00:00:00Z');
    // FREQ=MONTHLY without BYMONTHDAY would anchor to dtstart's day-of-month, causing 1-day drift
    // on each completion. Fix by explicitly anchoring to baseDate's day-of-month.
    if (rruleStr === 'FREQ=MONTHLY') {
      const dom = parseInt(baseDate.slice(8, 10), 10);
      rruleStr = `FREQ=MONTHLY;BYMONTHDAY=${dom}`;
    }
    const rule = rrulestr('RRULE:' + rruleStr, { dtstart });
    const next = rule.after(dtstart, false); // exclusive: first occurrence strictly after baseDate
    return next ? next.toISOString().slice(0, 10) : null;
  } catch (_) {
    return null;
  }
}

// Returns true if the agent schedule is due given the last run time.
// agentSchedule: RRULE string with BYHOUR/BYMINUTE (e.g. 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0')
// lastRunAt: ISO datetime string or null
export function isAgentScheduleDue(agentSchedule, lastRunAt) {
  if (!agentSchedule) return false;
  try {
    const now = new Date();
    const rule = rrulestr('RRULE:' + agentSchedule);
    // Find the most recent occurrence that should have fired by now
    const lastOccurrence = rule.before(now, true);
    if (!lastOccurrence) return false;
    if (!lastRunAt) return true;
    return lastOccurrence > new Date(lastRunAt);
  } catch (_) {
    return false;
  }
}

export function appendAiContext(existing, newNote) {
  if (!newNote) return existing ?? null;
  const entry = `[${today()}] ${newNote}`;
  return existing ? `${entry}\n${existing}` : entry;
}
