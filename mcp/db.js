import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';
import { ensureAgentSchema, ensureCapabilitySchema } from '../server/capability-registry.js';
import { ensureDailyNoteSearchSchema } from '../server/daily-note-search.js';

// Pure business logic (date math, recurrence, ai_context ordering, heartbeat/habit scheduling)
// lives in server/task-logic.js — the single source shared with db-worker.js so the two runtimes
// cannot silently diverge. Re-exported here so mcp/tools/* (and test-recurrence.mjs) keep importing
// them from '../db.js' as before, now backed by that one implementation.
import {
  today, nowIso, offsetDate, daysBetween, addMinutesFromNow,
  appendAiContext, LEGACY_RRULE, toRruleString, rruleToText,
  nextRecurrenceDate, isAgentScheduleDue, nextRunAt,
  isHabitDueOn, DAY_ABBR_TO_DOW,
} from '../server/task-logic.js';
export {
  today, nowIso, offsetDate, daysBetween, addMinutesFromNow,
  appendAiContext, LEGACY_RRULE, toRruleString, rruleToText,
  nextRecurrenceDate, isAgentScheduleDue, nextRunAt,
  isHabitDueOn, DAY_ABBR_TO_DOW,
};

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
      sort_order          INTEGER,
      parent_id           TEXT REFERENCES tasks(id),
      recurrence          TEXT,
      outcome             TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocked_by
      ON task_dependencies(blocked_by_task_id);

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
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      mimetype     TEXT,
      size_bytes   INTEGER,
      bucket       TEXT,
      key          TEXT,
      url          TEXT,
      local_path   TEXT,
      encrypted    INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      name       TEXT PRIMARY KEY,
      archived   INTEGER NOT NULL DEFAULT 0,
      is_repo    INTEGER NOT NULL DEFAULT 0,
      context    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TRIGGER IF NOT EXISTS tasks_updated_at
    AFTER UPDATE ON tasks
    FOR EACH ROW
    BEGIN
      UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
    END;
  `);
  ensureAgentSchema(db);
  ensureCapabilitySchema(db);
  ensureDailyNoteSearchSchema(db);

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
  if (!existingCols.includes('assigned_agent'))     db.exec('ALTER TABLE tasks ADD COLUMN assigned_agent TEXT');
  if (!existingCols.includes('hard_deadline'))      db.exec('ALTER TABLE tasks ADD COLUMN hard_deadline INTEGER NOT NULL DEFAULT 0');
  if (!existingCols.includes('last_reviewed_at'))   db.exec('ALTER TABLE tasks ADD COLUMN last_reviewed_at TEXT');
  if (!existingCols.includes('time_estimate'))      db.exec('ALTER TABLE tasks ADD COLUMN time_estimate INTEGER');
  db.exec(`UPDATE tasks SET last_reviewed_at = COALESCE(last_touched_human, created_at, datetime('now')) WHERE last_reviewed_at IS NULL`);

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

  // Migrations for heartbeats table
  const heartbeatCols = db.prepare(`PRAGMA table_info(heartbeats)`).all().map(r => r.name);
  if (!heartbeatCols.includes('run_at_time')) {
    db.exec(`ALTER TABLE heartbeats ADD COLUMN run_at_time TEXT`);
  }
  // Schema parity with db-worker.js (bug C18 support): db-worker adds minute_offset via its own
  // migration; mcp/db.js was missing it, so an MCP-first init lacked the column that the heartbeat
  // create/update handlers write.
  if (!heartbeatCols.includes('minute_offset')) {
    db.exec(`ALTER TABLE heartbeats ADD COLUMN minute_offset INTEGER`);
  }

  // Migrations for agent_jobs table
  const agentJobCols = db.prepare(`PRAGMA table_info(agent_jobs)`).all().map(r => r.name);
  if (!agentJobCols.includes('heartbeat_id')) {
    db.exec(`ALTER TABLE agent_jobs ADD COLUMN heartbeat_id TEXT REFERENCES heartbeats(id)`);
  }

  // Migrations for attachments table
  const attachmentCols = db.prepare(`PRAGMA table_info(attachments)`).all().map(r => r.name);
  if (!attachmentCols.includes('encrypted')) {
    db.exec(`ALTER TABLE attachments ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0`);
  }

  // Seed default contexts on first run
  const { c } = db.prepare('SELECT count(*) as c FROM contexts').get();
  if (c === 0) {
    db.prepare(
      'INSERT OR IGNORE INTO contexts (slug, display_name, source, notes) VALUES (?, ?, ?, ?)'
    ).run('personal', 'Personal', null, 'Personal tasks and habits');
  }
}

export function openDb({ busyTimeout = 1000 } = {}) {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  // Keep busy_timeout short in the MCP server (default 1000ms) so SQLITE_BUSY surfaces
  // quickly and the HTTP retry loop has room to retry within the 5s Axios timeout window.
  // The db-worker passes 5000ms for startup where longer waits are acceptable.
  db.pragma(`busy_timeout = ${busyTimeout}`);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

// Pure date/recurrence/ai_context/heartbeat/habit helpers now live in server/task-logic.js and are
// imported + re-exported at the top of this file (single source shared with db-worker.js).
