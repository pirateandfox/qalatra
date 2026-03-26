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
      parent_id           TEXT REFERENCES tasks(id),
      recurrence          TEXT
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
      display_name  TEXT NOT NULL,
      source        TEXT,
      source_config TEXT,
      notes         TEXT,
      active        INTEGER NOT NULL DEFAULT 1
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
  const existingCols = db.prepare(`PRAGMA table_info(tasks)`).all().map(r => r.name);
  if (!existingCols.includes('recurrence')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN recurrence TEXT`);
  }
  if (!existingCols.includes('outcome')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN outcome TEXT`);
  }
  if (!existingCols.includes('end_time')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN end_time TEXT`);
  }
  if (!existingCols.includes('agent_path')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN agent_path TEXT`);
  }

  // Seed default contexts on first run
  const { c } = db.prepare('SELECT count(*) as c FROM contexts').get();
  if (c === 0) {
    const ins = db.prepare(
      'INSERT OR IGNORE INTO contexts (slug, display_name, source, notes) VALUES (?, ?, ?, ?)'
    );
    ins.run('personal',     'Personal',         null,     'Personal tasks and habits');
    ins.run('silvermouse',  'Silvermouse',       null,     'Silvermouse band projects');
    ins.run('pirateandfox', 'Pirate & Fox',     'linear', 'Pirate & Fox projects (Muzebook, MVP Accelerator, NestledJS, Stack, Sentiosonics)');
    ins.run('flightdesk',   'FlightDesk',       'linear', 'FlightDesk product — Justin\'s dev task tracker');
    ins.run('monroe',       'Monroe Institute', 'asana',  'Monroe Institute client work');
    ins.run('biztobiz',     'Biz to Biz',       'notion', 'Biz to Biz client work');
    ins.run('silvermouse',  'Silvermouse',       null,     'Silvermouse band projects — All of Us release and other music');
  }
}

export function openDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
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
    const rruleStr = toRruleString(recurrence);
    const dtstart = new Date(baseDate + 'T12:00:00Z');
    const rule = rrulestr('RRULE:' + rruleStr, { dtstart });
    const next = rule.after(dtstart, false); // strictly after baseDate
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
