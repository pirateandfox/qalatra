import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import busboy from 'busboy';
import { v4 as uuidv4 } from 'uuid';
import { openDb, nowIso, today, appendAiContext, nextRecurrenceDate } from './mcp/db.js';
import { getS3Client, uploadToS3, deleteFromS3, getPresignedUrl } from './s3.js';

const PORT = 3456;
const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json');

// ── Attachment sync ───────────────────────────────────────────────────────────

async function syncPendingAttachments() {
  const settings = loadSettings();
  const client = getS3Client(settings);
  const bucket = settings.s3Bucket;
  if (!client || !bucket) return { synced: 0, failed: 0 };

  const db = openDb();
  const pending = db.prepare(
    `SELECT * FROM attachments WHERE bucket IS NULL AND local_path IS NOT NULL`
  ).all();

  let synced = 0, failed = 0;
  for (const att of pending) {
    if (!fs.existsSync(att.local_path)) { failed++; continue; }
    try {
      const buffer = fs.readFileSync(att.local_path);
      const ext = path.extname(att.filename);
      const key = `attachments/${att.task_id}/${att.id}${ext}`;
      await uploadToS3(client, bucket, key, buffer, att.mimetype);
      const url = settings.s3PublicUrl
        ? `${settings.s3PublicUrl.replace(/\/$/, '')}/${key}`
        : null;
      db.prepare(`UPDATE attachments SET bucket = ?, key = ?, url = ? WHERE id = ?`)
        .run(bucket, key, url, att.id);
      synced++;
    } catch (_) { failed++; }
  }
  return { synced, failed, total: pending.length };
}

// Run on startup and every 5 minutes
syncPendingAttachments().catch(() => {});
setInterval(() => syncPendingAttachments().catch(() => {}), 5 * 60 * 1000);

// ── Agent job worker ──────────────────────────────────────────────────────────

const MAX_CONCURRENT_JOBS = 3;
let runningJobs = 0;

function processAgentJobs() {
  const db = openDb();
  if (runningJobs >= MAX_CONCURRENT_JOBS) return;
  const slots = MAX_CONCURRENT_JOBS - runningJobs;
  const jobs = db.prepare(
    `SELECT * FROM agent_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`
  ).all(slots);

  for (const job of jobs) {
    runningJobs++;
    db.prepare(`UPDATE agent_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?`).run(job.id);

    const globalSettings = loadSettings();
    let agentCommand = globalSettings.defaultAgentCommand || 'claude --dangerously-skip-permissions';
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(job.agent_path, 'agent.config'), 'utf8'));
      if (cfg.command) agentCommand = cfg.command;
    } catch (_) {}

    const parts = agentCommand.trim().split(/\s+/);
    const bin = parts[0];
    const baseArgs = parts.slice(1);

    // Try to resume a previous session for this task (only if task has agent_resume enabled)
    const task = job.task_id ? db.prepare('SELECT agent_resume FROM tasks WHERE id = ?').get(job.task_id) : null;
    const canResume = task?.agent_resume !== 0;
    const prevSession = canResume && job.task_id
      ? db.prepare(`SELECT session_id FROM agent_jobs WHERE task_id = ? AND session_id IS NOT NULL AND status = 'done' ORDER BY completed_at DESC LIMIT 1`).get(job.task_id)
      : null;

    let args;
    if (prevSession?.session_id) {
      const resumePrompt = job.user_message || job.prompt;
      args = [...baseArgs, '--resume', prevSession.session_id, '-p', resumePrompt, '--output-format', 'json'];
    } else {
      args = [...baseArgs, '-p', job.prompt, '--output-format', 'json'];
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const proc = spawn(bin, args, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const TIMEOUT_MS = 15 * 60 * 1000; // 15 minute hard limit
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.on('close', code => {
      clearTimeout(timeout);
      runningJobs--;
      const db2 = openDb();
      let result = stdout.trim();
      let sessionId = null;
      try {
        const parsed = JSON.parse(stdout);
        result = parsed.result ?? result;
        sessionId = parsed.session_id ?? null;
      } catch (_) {}
      const status = code === 0 ? 'done' : 'failed';
      if (!result) {
        if (timedOut) {
          result = `Agent timed out after ${TIMEOUT_MS / 60000} minutes.`;
          if (stderr.trim()) result += `\n\nStderr:\n${stderr.trim()}`;
        } else {
          result = stderr.trim() || `No output (exit code ${code})`;
        }
      } else if (status === 'failed' && stderr.trim()) {
        result += `\n\nStderr:\n${stderr.trim()}`;
      }
      db2.prepare(`UPDATE agent_jobs SET status = ?, result = ?, session_id = ?, completed_at = datetime('now') WHERE id = ?`)
        .run(status, result, sessionId, job.id);
      // Store agent response as a note
      if (status === 'done' && job.task_id) {
        db2.prepare(`INSERT INTO notes (id, task_id, body, author, agent_job_id) VALUES (?, ?, ?, 'agent', ?)`)
          .run(uuidv4(), job.task_id, result, job.id);
      }
    });

    proc.on('error', err => {
      clearTimeout(timeout);
      runningJobs--;
      openDb().prepare(`UPDATE agent_jobs SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?`)
        .run(err.message, job.id);
    });
  }
}

// On startup, any jobs stuck in 'running' from a previous session get re-queued
try { const db = openDb(); db.prepare(`UPDATE agent_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'`).run(); } catch (_) {}

setInterval(() => { try { processAgentJobs(); } catch (_) {} }, 30_000);

// ── Agent auto-run ────────────────────────────────────────────────────────────
// For tasks with agent_autorun=1: if the task is active, has an agent, and has
// no agent jobs yet, queue one automatically. This pairs with task recurrence —
// each spawned task instance is fresh and gets its own auto-run.

function autoRunAgents() {
  const db = openDb();
  const tasks = db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.agent_path IS NOT NULL
      AND t.agent_autorun = 1
      AND t.status = 'active'
      AND (t.due_date IS NULL OR t.due_date <= date('now'))
      AND time('now', 'localtime') >= COALESCE(t.agent_autorun_time, '09:00')
      AND NOT EXISTS (
        SELECT 1 FROM agent_jobs j WHERE j.task_id = t.id
      )
  `).all();

  for (const task of tasks) {
    const prompt = [
      `Task: ${task.title}`,
      task.description,
    ].filter(Boolean).join('\n');

    const id = uuidv4();
    db.prepare(`INSERT INTO agent_jobs (id, task_id, agent_path, prompt, user_message) VALUES (?, ?, ?, ?, ?)`)
      .run(id, task.id, task.agent_path, prompt, null);
  }
}

setInterval(() => { try { autoRunAgents(); } catch (_) {} }, 5 * 60_000);
// autoRunAgents() called after migrate() at startup

// ── Agent scanner ─────────────────────────────────────────────────────────────

function scanAgents(root) {
  const agents = [];
  if (!root || !fs.existsSync(root)) return agents;

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      const configPath = path.join(fullPath, 'agent.config');
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          agents.push({
            name:        config.name        ?? entry.name,
            description: config.description ?? null,
            command:     config.command     ?? null,
            path:        fullPath,
            relativePath: path.relative(root, fullPath),
          });
        } catch (_) { /* malformed agent.config — skip */ }
      }
      walk(fullPath);
    }
  }

  walk(root);
  return agents;
}

// ── Settings ──────────────────────────────────────────────────────────────────

const SETTINGS_FILE = process.env.TASKOS_SETTINGS_FILE
  ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'db', 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (_) { return {}; }
}

function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

function getAttachmentCacheDir(settings) {
  const raw = settings.attachmentCacheDir || path.join(os.homedir(), 'Library', 'Application Support', 'task-os', 'attachments');
  const dir = raw.replace(/^~/, os.homedir());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const MIME_EXTENSIONS = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'application/pdf': '.pdf', 'text/plain': '.txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};
function extFromMime(mime) {
  return MIME_EXTENSIONS[mime] || '';
}

// ── Schema migration ──────────────────────────────────────────────────────────

function migrate(db) {
  try { db.exec('ALTER TABLE tasks ADD COLUMN sort_order INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id)'); } catch (_) {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'task'"); } catch (_) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN event_time TEXT'); } catch (_) {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN links TEXT DEFAULT '[]'"); } catch (_) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN recurrence TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN outcome TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN end_time TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN agent_path TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN agent_resume INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN agent_autorun INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { db.exec("ALTER TABLE tasks ADD COLUMN agent_autorun_time TEXT DEFAULT '09:00'"); } catch (_) {}
  try { db.exec('ALTER TABLE tasks RENAME COLUMN notes TO description'); } catch (_) {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id          TEXT PRIMARY KEY,
      task_id     TEXT REFERENCES tasks(id),
      agent_path  TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'queued',
      result      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      started_at  TEXT,
      completed_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      filename    TEXT NOT NULL,
      mimetype    TEXT,
      size_bytes  INTEGER,
      bucket      TEXT,
      key         TEXT,
      url         TEXT,
      local_path  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try { db.exec('ALTER TABLE agent_jobs ADD COLUMN session_id TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE agent_jobs ADD COLUMN user_message TEXT'); } catch (_) {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES tasks(id),
      body         TEXT NOT NULL,
      author       TEXT NOT NULL DEFAULT 'user',
      agent_job_id TEXT REFERENCES agent_jobs(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contexts (
      slug       TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '#888888',
      sort_order INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Migrate old schema (display_name → label, add color/sort_order)
  try { db.exec('ALTER TABLE contexts ADD COLUMN label TEXT'); } catch (_) {}
  try { db.exec("ALTER TABLE contexts ADD COLUMN color TEXT NOT NULL DEFAULT '#888888'"); } catch (_) {}
  try { db.exec('ALTER TABLE contexts ADD COLUMN sort_order INTEGER'); } catch (_) {}
  try {
    db.exec("UPDATE contexts SET label = display_name WHERE (label IS NULL OR label = '') AND display_name IS NOT NULL");
  } catch (_) {}
  // Apply known colors to pre-existing contexts that were seeded without color
  const knownColors = [
    { slug: 'monroe',       color: '#4f9cf9', sort_order: 1, label: 'Monroe Institute' },
    { slug: 'biztobiz',     color: '#f9a94f', sort_order: 2, label: 'Biz to Biz' },
    { slug: 'pirateandfox', color: '#a78bfa', sort_order: 3, label: 'Pirate & Fox' },
    { slug: 'silvermouse',  color: '#fb7185', sort_order: 4, label: 'Silvermouse' },
    { slug: 'flightdesk',   color: '#f472b6', sort_order: 5, label: 'FlightDesk' },
    { slug: 'personal',     color: '#4fcc8a', sort_order: 6, label: 'Personal' },
    { slug: 'internal',     color: '#94a3b8', sort_order: 7, label: 'Internal' },
  ];
  const updateCtx = db.prepare("UPDATE contexts SET color = ?, sort_order = ?, label = CASE WHEN label IS NULL OR label = '' THEN ? ELSE label END WHERE slug = ?");
  for (const c of knownColors) updateCtx.run(c.color, c.sort_order, c.label, c.slug);

  // Seed defaults if table is still empty
  const contextCount = db.prepare('SELECT COUNT(*) as n FROM contexts').get();
  if (contextCount.n === 0) {
    const insertCtx = db.prepare(
      `INSERT OR IGNORE INTO contexts (slug, label, color, sort_order) VALUES (@slug, @label, @color, @sort_order)`
    );
    for (const c of knownColors) insertCtx.run(c);
  }

  // Insert internal if missing (slug not in table)
  db.prepare("INSERT OR IGNORE INTO contexts (slug, display_name, label, color, sort_order, active) VALUES ('internal','Internal','Internal','#94a3b8',7,1)").run();

  // Surface snoozed tasks whose snooze time has passed
  db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL WHERE status = 'snoozed' AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime'))`).run();

  // Habits
  db.exec(`
    CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      recurrence TEXT NOT NULL DEFAULT 'daily',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS habit_logs (
      id TEXT PRIMARY KEY,
      habit_id TEXT NOT NULL REFERENCES habits(id),
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done',
      notes TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(habit_id, date)
    );
  `);
}

// ── Platform link helpers ──────────────────────────────────────────────────────

const PLATFORMS = [
  { key: 'asana',   pattern: /asana\.com/,            label: 'Asana',
    svg: `<img src="/logos/asana.png" style="width:14px;height:14px;object-fit:contain">` },
  { key: 'missive', pattern: /missiveapp\.com/,        label: 'Missive',
    svg: `<img src="/logos/missive.png" style="width:14px;height:14px;object-fit:contain">` },
  { key: 'notion',  pattern: /notion\.so/,             label: 'Notion',
    svg: `<img src="/logos/notion.png" style="width:14px;height:14px;object-fit:contain">` },
  { key: 'linear',  pattern: /linear\.app/,            label: 'Linear',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 14.5L9.5 20.5L20.5 3.5"/><path d="M3.5 3.5L20.5 20.5"/></svg>` },
  { key: 'github',  pattern: /github\.com/,            label: 'GitHub',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg>` },
  { key: 'slack',   pattern: /slack\.com/,             label: 'Slack',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M9 4a2 2 0 1 0 0 4h2V4a2 2 0 0 0-2-2z"/><path d="M4 9a2 2 0 0 0 0 4h4V9H4z"/><path d="M15 20a2 2 0 0 0 0-4h-2v4a2 2 0 0 0 2 2z"/><path d="M20 15a2 2 0 0 0 0-4h-4v4h4z"/></svg>` },
  { key: 'youtube', pattern: /youtu\.be|youtube\.com/, label: 'YouTube',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3V9z" fill="currentColor" stroke="none"/></svg>` },
  { key: 'flightdesk', pattern: /flightdesk\.dev/,    label: 'FlightDesk',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 17L12 5l9 12H3z"/></svg>` },
];

function detectPlatform(url) {
  if (!url) return null;
  return PLATFORMS.find(p => p.pattern.test(url)) ?? { key: 'link', label: 'Link',
    svg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` };
}

function platformIcon(url) {
  const p = detectPlatform(url);
  if (!p) return '';
  return `<a href="${escHtml(url)}" target="_blank" class="platform-icon-link" title="${escHtml(p.label)}">${p.svg}</a>`;
}

function allLinks(task) {
  const urls = [];
  if (task.source_url) urls.push(task.source_url);
  try {
    const extra = JSON.parse(task.links || '[]');
    if (Array.isArray(extra)) urls.push(...extra);
  } catch (_) {}
  return [...new Set(urls)];
}

function attachSubtasks(db, tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map(t => `'${t.id.replace(/'/g,"''")}'`).join(',');
  const subtasks = db.prepare(
    `SELECT * FROM tasks WHERE parent_id IN (${ids}) ORDER BY sort_order ASC NULLS LAST, created_at ASC`
  ).all();
  const byParent = {};
  for (const s of subtasks) {
    if (!byParent[s.parent_id]) byParent[s.parent_id] = [];
    byParent[s.parent_id].push(s);
  }
  return tasks.map(t => ({ ...t, subtasks: byParent[t.id] ?? [] }));
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function offsetDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Alias used by habits API
const offsetDateStr = offsetDate;

function isHabitDueOn(habit, dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  switch (habit.recurrence) {
    case 'daily':    return true;
    case 'weekdays': return dow >= 1 && dow <= 5;
    case 'weekly': {
      const created = new Date(habit.created_at.substring(0, 10) + 'T12:00:00Z');
      return d.getUTCDay() === created.getUTCDay();
    }
    case 'monthly': {
      const created = new Date(habit.created_at.substring(0, 10) + 'T12:00:00Z');
      return d.getUTCDate() === created.getUTCDate();
    }
    default: return true;
  }
}

function formatDisplayDate(dateStr) {
  const today = todayStr();
  if (dateStr === today)              return `Today — ${fmtDate(dateStr)}`;
  if (dateStr === offsetDate(today, 1))  return `Tomorrow — ${fmtDate(dateStr)}`;
  if (dateStr === offsetDate(today, -1)) return `Yesterday — ${fmtDate(dateStr)}`;
  return fmtDate(dateStr);
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// ── Recurring task auto-rollover ──────────────────────────────────────────────
// Finds overdue recurring tasks and auto-skips them, spawning the next occurrence.
// Runs on every today-view load so stale habits don't pile up.

function autoRolloverRecurring(db) {
  const t = todayStr();
  const stale = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'active' AND recurrence IS NOT NULL
      AND (
        (due_date IS NOT NULL AND due_date < ?)
        OR (due_date IS NULL AND start_date IS NOT NULL AND start_date < ?)
      )
  `).all(t, t);
  const now = nowIso();
  for (const task of stale) {
    db.prepare(`UPDATE tasks SET status = 'done', outcome = 'skipped', last_touched_human = ?, ai_context = ? WHERE id = ?`)
      .run(now, appendAiContext(task.ai_context, 'Auto-skipped: overdue recurring task.'), task.id);
    const nextDate = nextRecurrenceDate(task.due_date ?? t, task.recurrence);
    if (nextDate) {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO tasks (
          id, title, description, status, my_priority, energy_required, context, project,
          tags, source, source_url, created_at, updated_at, start_date, due_date, task_type, recurrence, ai_context,
          agent_path, agent_resume, agent_autorun, agent_autorun_time
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, task.title, task.description, task.my_priority, task.energy_required,
        task.context, task.project, task.tags, task.source ?? 'manual', task.source_url,
        now, now, nextDate, nextDate, task.task_type, task.recurrence,
        appendAiContext(null, `Auto-recurred from task ${task.id}`),
        task.agent_path ?? null, task.agent_resume ?? 1, task.agent_autorun ?? 0, task.agent_autorun_time ?? '09:00'
      );
    }
  }
  return stale.length;
}

// ── DB queries ────────────────────────────────────────────────────────────────

const ORDER = 'sort_order ASC NULLS LAST, my_priority ASC NULLS LAST, created_at ASC';

function stampAgentJobs(db, ...taskArrays) {
  const jobs = db.prepare(`
    SELECT task_id, status FROM agent_jobs
    WHERE status IN ('queued','running')
       OR (status = 'done' AND completed_at >= datetime('now','-24 hours'))
       OR (status = 'failed' AND completed_at >= datetime('now','-24 hours'))
    ORDER BY created_at DESC
  `).all();
  if (!jobs.length) return;
  const map = {};
  for (const j of jobs) { if (j.task_id && !map[j.task_id]) map[j.task_id] = j.status; }
  for (const arr of taskArrays) {
    for (const task of arr) {
      if (map[task.id]) task.agent_job_status = map[task.id];
    }
  }
}

function getTasksForDate(date) {
  const db = openDb();
  migrate(db);
  const today = todayStr();
  const isToday = date === today;
  const nextDay = offsetDate(date, 1);

  if (isToday) {
    autoRolloverRecurring(db);

    const overdue = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'active' AND parent_id IS NULL AND due_date IS NOT NULL AND due_date < ?
        AND task_type = 'task'
      ORDER BY due_date ASC, ${ORDER}
    `).all(date));

    const dueToday = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'active' AND parent_id IS NULL AND strftime('%Y-%m-%d', due_date) = ?
        AND task_type = 'task'
        AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime') OR strftime('%Y-%m-%d', due_date) <= ?)
      ORDER BY ${ORDER}
    `).all(date, date));

    const active = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'active' AND parent_id IS NULL AND task_type = 'task'
        AND (due_date IS NULL OR due_date > ?)
        AND (
          (start_date IS NULL AND due_date IS NULL)
          OR (start_date IS NOT NULL AND start_date <= ?)
        )
        AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime'))
      ORDER BY ${ORDER}
    `).all(date, date));

    const doneToday = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'done' AND parent_id IS NULL
        AND last_touched_human >= ? AND last_touched_human < ?
      ORDER BY last_touched_human DESC
    `).all(date, nextDay));

    const events = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks
      WHERE task_type = 'event' AND parent_id IS NULL AND status != 'done'
        AND (due_date = ? OR due_date IS NULL)
      ORDER BY event_time ASC NULLS LAST, created_at ASC
    `).all(date));

    const reminders = db.prepare(`
      SELECT * FROM tasks
      WHERE task_type = 'reminder' AND parent_id IS NULL AND status != 'done'
        AND (due_date IS NULL OR due_date <= ?)
        AND (surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime'))
      ORDER BY ${ORDER}
    `).all(date);

    const allHabits = db.prepare('SELECT * FROM habits WHERE active = 1 ORDER BY created_at ASC').all();
    const todayHabits = allHabits.filter(h => isHabitDueOn(h, date));
    const habitLogs = todayHabits.length
      ? db.prepare(`SELECT * FROM habit_logs WHERE date = ? AND habit_id IN (${todayHabits.map(() => '?').join(',')})`)
          .all(date, ...todayHabits.map(h => h.id))
      : [];
    const habitLogMap = {};
    for (const l of habitLogs) habitLogMap[l.habit_id] = l;
    const habits = todayHabits.map(h => ({ ...h, today_log: habitLogMap[h.id] ?? null }));

    const timeSnoozed = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'snoozed' AND parent_id IS NULL AND task_type = 'task'
        AND strftime('%Y-%m-%d', due_date) = ?
        AND surface_after > strftime('%Y-%m-%d %H:%M', 'now', 'localtime')
      ORDER BY surface_after ASC
    `).all(date));

    stampAgentJobs(db, overdue, dueToday, active);
    return { view: 'today', date, overdue, dueToday, active, doneToday, timeSnoozed, events, reminders, habits };

  } else if (date > today) {
    const scheduled = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks WHERE strftime('%Y-%m-%d', due_date) = ? AND parent_id IS NULL AND task_type = 'task' AND status != 'snoozed' ORDER BY status ASC, ${ORDER}
    `).all(date));

    const timeSnoozed = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks WHERE strftime('%Y-%m-%d', due_date) = ? AND parent_id IS NULL AND task_type = 'task' AND status = 'snoozed' ORDER BY surface_after ASC
    `).all(date));

    const futureEvents = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks
      WHERE task_type = 'event' AND parent_id IS NULL AND status != 'done' AND due_date = ?
      ORDER BY event_time ASC NULLS LAST, created_at ASC
    `).all(date));

    const futureReminders = db.prepare(`
      SELECT * FROM tasks
      WHERE task_type = 'reminder' AND parent_id IS NULL AND status != 'done' AND due_date = ?
      ORDER BY ${ORDER}
    `).all(date);

    stampAgentJobs(db, scheduled, timeSnoozed);
    return { view: 'future', date, scheduled, timeSnoozed, events: futureEvents, reminders: futureReminders };

  } else {
    const completed = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'done' AND parent_id IS NULL
        AND last_touched_human >= ? AND last_touched_human < ?
      ORDER BY last_touched_human DESC
    `).all(date, nextDay));

    const wasDue = attachSubtasks(db, db.prepare(`
      SELECT * FROM tasks WHERE due_date = ? AND parent_id IS NULL ORDER BY status ASC, ${ORDER}
    `).all(date));

    return { view: 'past', date, completed, wasDue };
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

function completeTask(taskId) {
  const db = openDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  // Block if any subtasks are not done
  const incomplete = db.prepare(
    `SELECT count(*) as n FROM tasks WHERE parent_id = ? AND status != 'done'`
  ).get(taskId);
  if (incomplete.n > 0) return { ok: false, reason: 'subtasks_incomplete', count: incomplete.n };
  const now = nowIso();
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'completed', last_touched_human = ?, ai_context = ? WHERE id = ?`)
    .run(now, appendAiContext(task.ai_context, 'Marked complete via web UI.'), taskId);
  // Spawn next occurrence for recurring tasks
  if (task.recurrence) {
    const baseDate = task.due_date ?? today();
    const nextDate = nextRecurrenceDate(baseDate, task.recurrence);
    if (nextDate) {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO tasks (
          id, title, description, status, my_priority, energy_required, context, project,
          tags, source, source_url, created_at, updated_at, start_date, due_date, task_type, recurrence, ai_context,
          agent_path, agent_resume, agent_autorun, agent_autorun_time
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, task.title, task.description, task.my_priority, task.energy_required,
        task.context, task.project, task.tags, task.source ?? 'manual', task.source_url,
        now, now, nextDate, nextDate, task.task_type, task.recurrence,
        appendAiContext(null, `Recurred from task ${taskId}`),
        task.agent_path ?? null, task.agent_resume ?? 1, task.agent_autorun ?? 0, task.agent_autorun_time ?? '09:00'
      );
    }
  }
  return { ok: true };
}

function completeTaskWithSubtasks(taskId) {
  const db = openDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  const now = nowIso();
  db.prepare(`UPDATE tasks SET status = 'done', last_touched_human = ?, ai_context = ? WHERE parent_id = ? AND status != 'done'`)
    .run(now, appendAiContext(null, 'Bulk-completed with parent via web UI.'), taskId);
  db.prepare(`UPDATE tasks SET status = 'done', last_touched_human = ?, ai_context = ? WHERE id = ?`)
    .run(now, appendAiContext(task.ai_context, 'Marked complete via web UI (with subtasks).'), taskId);
  return { ok: true };
}

function createSubtask(parentId, title) {
  const db = openDb();
  const parent = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parentId);
  if (!parent) return null;
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO tasks (id, title, status, context, project, parent_id, source, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?, ?, 'manual', ?, ?)
  `).run(id, title, parent.context, parent.project, parentId, now, now);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function skipTask(taskId) {
  const db = openDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task || !task.recurrence) return false;
  const now = nowIso();
  db.prepare(`UPDATE tasks SET status = 'done', outcome = 'skipped', last_touched_human = ?, ai_context = ? WHERE id = ?`)
    .run(now, appendAiContext(task.ai_context, 'Skipped via web UI.'), taskId);
  // Spawn next occurrence
  const baseDate = task.due_date ?? today();
  const nextDate = nextRecurrenceDate(baseDate, task.recurrence);
  if (nextDate) {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, my_priority, energy_required, context, project,
        tags, source, source_url, created_at, updated_at, start_date, due_date, task_type, recurrence, ai_context,
        agent_path, agent_resume, agent_autorun
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, task.title, task.description, task.my_priority, task.energy_required,
      task.context, task.project, task.tags, task.source ?? 'manual', task.source_url,
      now, now, nextDate, nextDate, task.task_type, task.recurrence,
      appendAiContext(null, `Recurred from task ${taskId}`),
      task.agent_path ?? null, task.agent_resume ?? 1, task.agent_autorun ?? 0
    );
  }
  return true;
}

function uncompleteTask(taskId) {
  const db = openDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return false;
  db.prepare(`UPDATE tasks SET status = 'active', last_touched_human = ?, ai_context = ? WHERE id = ?`)
    .run(nowIso(), appendAiContext(task.ai_context, 'Reopened via web UI.'), taskId);
  return true;
}

function snoozeTask(taskId, until) {
  const db = openDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return false;
  const hasTime = until.includes(' ') || until.includes('T');
  if (hasTime) {
    // Time-based snooze: hide until that datetime, task stays on that day's view behind a toggle
    const untilDate = until.substring(0, 10);
    db.prepare(`UPDATE tasks SET status = 'snoozed', surface_after = ?, due_date = ?, ai_context = ?, last_touched_human = ? WHERE id = ?`)
      .run(until, untilDate, appendAiContext(task.ai_context, `Snoozed until ${until}.`), nowIso(), taskId);
  } else {
    // Date-only defer: just push the due date, stay active
    db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL, due_date = ?, ai_context = ?, last_touched_human = ? WHERE id = ?`)
      .run(until, appendAiContext(task.ai_context, `Deferred to ${until}.`), nowIso(), taskId);
  }
  return true;
}

function activateTask(taskId) {
  const db = openDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return false;
  db.prepare(`UPDATE tasks SET status = 'active', surface_after = NULL, ai_context = ?, last_touched_human = ? WHERE id = ?`)
    .run(appendAiContext(task.ai_context, 'Activated via web UI.'), nowIso(), taskId);
  return true;
}

function reorderTasks(ids) {
  const db = openDb();
  const update = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
  db.transaction((list) => { list.forEach((id, i) => update.run(i, id)); })(ids);
}

// ── HTML helpers ──────────────────────────────────────────────────────────────


// ── Body parsers ──────────────────────────────────────────────────────────────

function parseFormBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c.toString(); });
    req.on('end', () => {
      const params = {};
      for (const pair of body.split('&')) {
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        const k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
        const v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
        params[k] = v;
      }
      resolve(params);
    });
  });
}

function parseJsonBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve({}); } });
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

process.on('uncaughtException', err => { console.error('[api] uncaughtException:', err); });
process.on('unhandledRejection', err => { console.error('[api] unhandledRejection:', err); });

const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;
  const contentType = req.headers['content-type'] ?? '';

  // GET /logos/*.png
  if (req.method === 'GET' && pathname.startsWith('/logos/')) {
    const name = pathname.slice(7); // strip /logos/
    if (/^[a-z0-9_-]+\.png$/.test(name)) {
      const filePath = path.join('/Users/justinhandley/IdeaProjects/project-manager/logos', name);
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
        res.end(fs.readFileSync(filePath));
        return;
      }
    }
    res.writeHead(404); res.end(); return;
  }

  // GET /favicon.svg
  if (req.method === 'GET' && pathname === '/favicon.svg') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <!-- Background -->
  <rect width="32" height="32" rx="7" fill="#1a1d27"/>
  <!-- Row 1: checkmark + line (completed, blue) -->
  <polyline points="5.5,11 8.5,14 13.5,8" fill="none" stroke="#4f9cf9" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="17" y1="11" x2="27" y2="11" stroke="#4f9cf9" stroke-width="2.5" stroke-linecap="round"/>
  <!-- Row 2: empty circle + line (pending, muted) -->
  <circle cx="9.5" cy="18" r="3" fill="none" stroke="#d1d5db" stroke-width="2"/>
  <line x1="17" y1="18" x2="25" y2="18" stroke="#d1d5db" stroke-width="2.5" stroke-linecap="round"/>
  <!-- Row 3: empty circle + short line (pending, more muted) -->
  <circle cx="9.5" cy="25" r="3" fill="none" stroke="#d1d5db" stroke-width="2"/>
  <line x1="17" y1="25" x2="23" y2="25" stroke="#d1d5db" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
    res.end(svg);
    return;
  }

  // GET /api/task/:id/subtasks
  if (req.method === 'GET' && pathname.match(/^\/api\/task\/[^/]+\/subtasks$/)) {
    const taskId = pathname.split('/')[3];
    const db = openDb();
    const subtasks = db.prepare(
      `SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC NULLS LAST, created_at ASC`
    ).all(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(subtasks));
    return;
  }

  // GET /api/daily-note/:date
  if (req.method === 'GET' && pathname.match(/^\/api\/daily-note\/\d{4}-\d{2}-\d{2}$/)) {
    const date = pathname.split('/').pop();
    const db = openDb();
    const row = db.prepare('SELECT * FROM daily_notes WHERE date = ?').get(date);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ date, content: row?.content ?? '' }));
    return;
  }

  // POST /api/daily-note  { date, content }
  if (req.method === 'POST' && pathname === '/api/daily-note') {
    const body = await parseJsonBody(req);
    if (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      const db = openDb();
      db.prepare(`
        INSERT INTO daily_notes (date, content, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(date) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
      `).run(body.date, body.content ?? '');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/task/:id/attachments
  if (req.method === 'GET' && pathname.match(/^\/api\/task\/[^/]+\/attachments$/)) {
    const taskId = pathname.split('/')[3];
    const db = openDb();
    const rows = db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
    const settings = loadSettings();
    const client = getS3Client(settings);
    const result = await Promise.all(rows.map(async (a) => {
      if (!a.url && a.bucket && a.key && client) {
        try { a = { ...a, url: await getPresignedUrl(client, a.bucket, a.key) }; } catch (_) {}
      }
      return a;
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // POST /api/task/:id/attachments — multipart upload
  if (req.method === 'POST' && pathname.match(/^\/api\/task\/[^/]+\/attachments$/)) {
    const taskId = pathname.split('/')[3];
    const settings = loadSettings();
    const cacheDir = getAttachmentCacheDir(settings);
    const client = getS3Client(settings);
    const bucket = settings.s3Bucket || null;

    await new Promise((resolve, reject) => {
      const bb = busboy({ headers: req.headers });
      bb.on('file', async (fieldname, file, info) => {
        const { filename, mimeType } = info;
        const id = uuidv4();
        const safeExt = path.extname(filename) || extFromMime(mimeType);
        const key = `attachments/${taskId}/${id}${safeExt}`;
        const localPath = path.join(cacheDir, `${id}${safeExt}`);

        const chunks = [];
        file.on('data', d => chunks.push(d));
        file.on('end', async () => {
          const buffer = Buffer.concat(chunks);
          fs.writeFileSync(localPath, buffer);

          let url = null;
          let uploadedBucket = null;
          let uploadedKey = null;
          let warning = null;

          if (client && bucket) {
            try {
              await uploadToS3(client, bucket, key, buffer, mimeType);
              uploadedBucket = bucket;
              uploadedKey = key;
              url = settings.s3PublicUrl ? `${settings.s3PublicUrl.replace(/\/$/, '')}/${key}` : null;
            } catch (e) {
              warning = 's3_upload_failed';
            }
          }

          const db = openDb();
          db.prepare(`
            INSERT INTO attachments (id, task_id, filename, mimetype, size_bytes, bucket, key, url, local_path)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, taskId, filename, mimeType, buffer.length, uploadedBucket, uploadedKey, url, localPath);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, warning, attachment: { id, filename, url, local_path: localPath } }));
          resolve();
        });
      });
      bb.on('error', reject);
      req.pipe(bb);
    });
    return;
  }

  // GET /api/attachment/:id/local — serve local file
  if (req.method === 'GET' && pathname.match(/^\/api\/attachment\/[^/]+\/local$/)) {
    const id = pathname.split('/')[3];
    const db = openDb();
    const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
    if (!att || !att.local_path || !fs.existsSync(att.local_path)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': att.mimetype || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${att.filename}"` });
    fs.createReadStream(att.local_path).pipe(res);
    return;
  }

  // GET /api/preview/file?path=... — serve a local HTML file for the email previewer
  if (req.method === 'GET' && pathname === '/api/preview/file') {
    const filePath = url.searchParams.get('path');
    if (!filePath) { res.writeHead(400); res.end('Missing path'); return; }
    const allowedRoot = path.join(os.homedir(), 'IdeaProjects');
    if (!filePath.startsWith(allowedRoot)) { res.writeHead(403); res.end('Forbidden'); return; }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch (_) {
      res.writeHead(404); res.end('File not found');
    }
    return;
  }

  // POST /api/write-file — write a local file (for mdpdf autosave)
  if (req.method === 'POST' && pathname === '/api/write-file') {
    let body = '';
    req.on('data', chunk => { body += chunk });
    req.on('end', () => {
      try {
        const { path: filePath, contents } = JSON.parse(body);
        if (!filePath || typeof contents !== 'string') { res.writeHead(400); res.end('Missing path or contents'); return; }
        const allowedRoot = path.join(os.homedir(), 'IdeaProjects');
        if (!filePath.startsWith(allowedRoot)) { res.writeHead(403); res.end('Forbidden'); return; }
        fs.writeFileSync(filePath, contents, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
    return;
  }

  // DELETE /api/attachment/:id
  if (req.method === 'DELETE' && pathname.match(/^\/api\/attachment\/[^/]+$/)) {
    const id = pathname.split('/')[3];
    const db = openDb();
    const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
    if (!att) { res.writeHead(404); res.end('{}'); return; }
    const settings = loadSettings();
    const client = getS3Client(settings);
    if (client && att.bucket && att.key) {
      try { await deleteFromS3(client, att.bucket, att.key); } catch (_) {}
    }
    if (att.local_path && fs.existsSync(att.local_path)) {
      try { fs.unlinkSync(att.local_path); } catch (_) {}
    }
    db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/s3/test — test S3 connection
  if (req.method === 'POST' && pathname === '/api/s3/test') {
    const body = await parseJsonBody(req);
    const client = getS3Client({ s3Endpoint: body.s3Endpoint, s3AccessKey: body.s3AccessKey, s3SecretKey: body.s3SecretKey });
    if (!client) { res.writeHead(200); res.end(JSON.stringify({ ok: false, error: 'Missing credentials' })); return; }
    try {
      const { HeadBucketCommand } = await import('@aws-sdk/client-s3');
      await client.send(new HeadBucketCommand({ Bucket: body.s3Bucket }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /api/attachments/sync — manually trigger pending attachment sync
  if (req.method === 'POST' && pathname === '/api/attachments/sync') {
    try {
      const result = await syncPendingAttachments();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /api/agent-jobs — queue a job for a task's assigned agent
  if (req.method === 'POST' && pathname === '/api/agent-jobs') {
    const body = await parseJsonBody(req);
    const { task_id, user_message } = body;
    const db = openDb();
    const task = task_id ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(task_id) : null;
    if (!task || !task.agent_path) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task_id required and task must have an agent_path assigned' }));
      return;
    }
    // Build full context prompt from task + note thread
    const existingNotes = db.prepare(`SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC`).all(task_id);
    const promptParts = [`Task: ${task.title}`];
    if (task.description) promptParts.push(task.description);
    if (existingNotes.length > 0) {
      promptParts.push('\n--- Conversation ---');
      for (const n of existingNotes) {
        promptParts.push(`[${n.author}]: ${n.body}`);
      }
    }
    if (user_message) promptParts.push(`[user]: ${user_message}`);
    const prompt = promptParts.join('\n');
    const id = uuidv4();
    db.prepare(`INSERT INTO agent_jobs (id, task_id, agent_path, prompt, user_message) VALUES (?, ?, ?, ?, ?)`)
      .run(id, task_id, task.agent_path, prompt, user_message ?? null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, status: 'queued' }));
    return;
  }

  // GET /api/agent-jobs — list jobs, optionally filtered by task_id
  if (req.method === 'GET' && pathname === '/api/agent-jobs') {
    const db = openDb();
    const task_id = url.searchParams.get('task_id');
    const jobs = task_id
      ? db.prepare(`SELECT * FROM agent_jobs WHERE task_id = ? ORDER BY created_at DESC`).all(task_id)
      : db.prepare(`SELECT * FROM agent_jobs ORDER BY created_at DESC LIMIT 50`).all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jobs));
    return;
  }

  // GET /api/task/:id/notes
  if (req.method === 'GET' && pathname.match(/^\/api\/task\/[^/]+\/notes$/)) {
    const taskId = pathname.split('/')[3];
    const db = openDb();
    const notes = db.prepare(`SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC`).all(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(notes));
    return;
  }

  // POST /api/task/:id/notes
  if (req.method === 'POST' && pathname.match(/^\/api\/task\/[^/]+\/notes$/)) {
    const taskId = pathname.split('/')[3];
    const body = await parseJsonBody(req);
    const { body: noteBody } = body;
    if (!noteBody?.trim()) { res.writeHead(400); res.end('{}'); return; }
    const db = openDb();
    const id = uuidv4();
    db.prepare(`INSERT INTO notes (id, task_id, body, author) VALUES (?, ?, ?, 'user')`).run(id, taskId, noteBody.trim());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  // GET /api/agent-jobs/:id
  if (req.method === 'GET' && pathname.match(/^\/api\/agent-jobs\/[^/]+$/)) {
    const jobId = pathname.slice('/api/agent-jobs/'.length);
    const db = openDb();
    const job = db.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(jobId);
    if (!job) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(job));
    return;
  }

  // GET /api/agents — scan workbench root for agent.config folders
  if (req.method === 'GET' && pathname === '/api/agents') {
    const settings = loadSettings();
    const root = settings.terminalCwd || process.env.HOME;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scanAgents(root)));
    return;
  }

  // GET /api/settings
  if (req.method === 'GET' && pathname === '/api/settings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadSettings()));
    return;
  }

  // POST /api/settings
  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await parseJsonBody(req);
    saveSettings(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/mcp/status
  if (req.method === 'GET' && pathname === '/api/mcp/status') {
    const s = loadSettings();
    const port = parseInt(s.mcpPort ?? '3457', 10);
    let claudeJson = {};
    try { claudeJson = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8')); } catch {}
    const entry = claudeJson.mcpServers?.['task-os'];
    const isHttpConfigured = entry?.type === 'http' && entry?.url === `http://localhost:${port}/mcp`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ port, isHttpConfigured, currentEntry: entry ?? null }));
    return;
  }

  // POST /api/mcp/apply — save port, update ~/.claude.json, restart MCP server
  if (req.method === 'POST' && pathname === '/api/mcp/apply') {
    const body = await parseJsonBody(req);
    const port = parseInt(body.port ?? '3457', 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid port' }));
      return;
    }
    // Save to settings
    const s = loadSettings();
    s.mcpPort = port;
    saveSettings(s);
    // Update ~/.claude.json
    let claudeJson = {};
    try { claudeJson = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf8')); } catch {}
    if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
    claudeJson.mcpServers['task-os'] = { type: 'http', url: `http://localhost:${port}/mcp` };
    fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(claudeJson, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port, url: `http://localhost:${port}/mcp` }));
    return;
  }

  // GET /api/backlog — return all backlog tasks as JSON
  if (req.method === 'GET' && pathname === '/api/backlog') {
    const db = openDb();
    const tasks = db.prepare(
      `SELECT * FROM tasks WHERE status = 'backlog' AND parent_id IS NULL ORDER BY context ASC, project ASC NULLS LAST, sort_order ASC NULLS LAST, created_at ASC`
    ).all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tasks));
    return;
  }

  // GET /api/tasks?date=YYYY-MM-DD — return full task data as JSON for React UI
  if (req.method === 'GET' && pathname === '/api/tasks') {
    const dateParam = url.searchParams.get('date');
    const date = (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) ? dateParam : todayStr();
    try {
      const data = getTasksForDate(date);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // PATCH /api/task/:id — partial update any mutable fields
  if (req.method === 'PATCH' && pathname.match(/^\/api\/task\/[^/]+$/)) {
    const taskId = pathname.slice('/api/task/'.length);
    const body = await parseJsonBody(req);
    const db = openDb();
    const MUTABLE = ['title','description','status','my_priority','energy_required','context','project',
      'tags','source_url','due_date','start_date','surface_after','task_type','event_time','end_time','recurrence','parent_id','agent_path','agent_resume','agent_autorun','agent_autorun_time','outcome'];
    // links is JSON — handle separately
    if (body.links !== undefined) {
      const db2 = openDb();
      db2.prepare('UPDATE tasks SET links = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(body.links), taskId);
    }
    const sets = []; const params = {};
    for (const f of MUTABLE) {
      if (body[f] !== undefined) { sets.push(`${f} = @${f}`); params[f] = body[f] === '' ? null : body[f]; }
    }
    if (sets.length) {
      params.id = taskId;
      db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(params);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // DELETE /api/task/:id
  if (req.method === 'DELETE' && pathname.startsWith('/api/task/')) {
    const taskId = pathname.slice('/api/task/'.length);
    const db = openDb();
    db.prepare('DELETE FROM agent_jobs WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ? OR parent_id = ?').run(taskId, taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/task/:id — return task as JSON
  if (req.method === 'GET' && pathname.startsWith('/api/task/')) {
    const taskId = pathname.slice('/api/task/'.length);
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(task));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/habits/create') {
    const body = await parseJsonBody(req);
    if (!body.title) { res.writeHead(400); res.end('title required'); return; }
    const db = openDb();
    const id = crypto.randomUUID();
    const now = nowIso();
    db.prepare('INSERT INTO habits (id, title, description, recurrence, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(id, body.title.trim(), body.description ?? null, body.recurrence ?? 'daily', now, now);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/habits/update') {
    const body = await parseJsonBody(req);
    if (!body.id) { res.writeHead(400); res.end('id required'); return; }
    const db = openDb();
    const sets = ['updated_at = ?']; const p = [nowIso()];
    if (body.title !== undefined)       { sets.push('title = ?');       p.push(body.title); }
    if (body.description !== undefined) { sets.push('description = ?'); p.push(body.description); }
    if (body.recurrence !== undefined)  { sets.push('recurrence = ?');  p.push(body.recurrence); }
    if (body.active !== undefined)      { sets.push('active = ?');      p.push(body.active ? 1 : 0); }
    db.prepare(`UPDATE habits SET ${sets.join(', ')} WHERE id = ?`).run(...p, body.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/habits/log') {
    const body = await parseJsonBody(req);
    if (!body.habit_id || !body.date) { res.writeHead(400); res.end('habit_id and date required'); return; }
    const db = openDb();
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO habit_logs (id, habit_id, date, status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(habit_id, date) DO UPDATE SET status = excluded.status, notes = excluded.notes
    `).run(id, body.habit_id, body.date, body.status ?? 'done', body.notes ?? null, nowIso());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/habits/unlog') {
    const body = await parseJsonBody(req);
    if (!body.habit_id || !body.date) { res.writeHead(400); res.end('habit_id and date required'); return; }
    const db = openDb();
    db.prepare('DELETE FROM habit_logs WHERE habit_id = ? AND date = ?').run(body.habit_id, body.date);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST') {
    if (pathname === '/create-subtask') {
      const body = await parseJsonBody(req);
      const newSub = (body.parent_id && body.title) ? createSubtask(body.parent_id, body.title) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(newSub ?? {}));
      return;
    }

    if (pathname === '/create-task-json') {
      const body = await parseJsonBody(req);
      if (!body.title) { res.writeHead(400); res.end('{}'); return; }
      const db = openDb();
      const id = crypto.randomUUID();
      const now = nowIso();
      db.prepare(`
        INSERT INTO tasks (id, title, status, context, project, task_type, source, ai_context, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?, 'task', 'manual', ?, ?, ?)
      `).run(id, body.title, body.context ?? 'personal', body.project ?? null,
             body.ai_context ? `[${now.slice(0,10)}] ${body.ai_context}` : null, now, now);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    if (pathname === '/update-title') {
      const body = await parseJsonBody(req);
      if (body.task_id && body.title) {
        const db = openDb();
        db.prepare('UPDATE tasks SET title = ?, last_touched_human = ? WHERE id = ?')
          .run(body.title, nowIso(), body.task_id);
      }
      res.writeHead(200); res.end('ok');
      return;
    }

    if (pathname === '/update-description') {
      const body = await parseJsonBody(req);
      if (body.task_id) {
        const db = openDb();
        db.prepare('UPDATE tasks SET description = ?, last_touched_human = ? WHERE id = ?')
          .run(body.description ?? null, nowIso(), body.task_id);
      }
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (pathname === '/update-recurrence') {
      const body = await parseJsonBody(req);
      if (body.task_id) {
        const db = openDb();
        db.prepare('UPDATE tasks SET recurrence = ?, last_touched_human = ? WHERE id = ?')
          .run(body.recurrence ?? null, nowIso(), body.task_id);
      }
      res.writeHead(200); res.end('ok');
      return;
    }

    if (pathname === '/update-due-date') {
      const body = await parseJsonBody(req);
      if (body.task_id) {
        const db = openDb();
        db.prepare('UPDATE tasks SET due_date = ?, last_touched_human = ? WHERE id = ?')
          .run(body.due_date || null, nowIso(), body.task_id);
      }
      res.writeHead(200); res.end('ok');
      return;
    }

    if (pathname === '/add-link') {
      const body = await parseJsonBody(req);
      if (body.task_id && body.url) {
        const db = openDb();
        const task = db.prepare('SELECT links, source_url FROM tasks WHERE id = ?').get(body.task_id);
        if (task) {
          let existing = [];
          try { existing = JSON.parse(task.links || '[]'); } catch (_) {}
          if (!existing.includes(body.url) && task.source_url !== body.url) {
            existing.push(body.url);
            db.prepare('UPDATE tasks SET links = ? WHERE id = ?').run(JSON.stringify(existing), body.task_id);
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/reorder') {
      const body = await parseJsonBody(req);
      if (Array.isArray(body.ids)) reorderTasks(body.ids);
      res.writeHead(200);
      res.end('ok');
      return;
    }

    const body = await parseFormBody(req);
    const redirect = (body.redirect && body.redirect.startsWith('/')) ? body.redirect : '/';
    if (pathname === '/complete'            && body.task_id) completeTask(body.task_id);
    if (pathname === '/complete-with-subtasks' && body.task_id) completeTaskWithSubtasks(body.task_id);
    if (pathname === '/uncomplete' && body.task_id) uncompleteTask(body.task_id);
    if (pathname === '/snooze'     && body.task_id) snoozeTask(body.task_id, body.until);
    if (pathname === '/activate'   && body.task_id) activateTask(body.task_id);
    if (pathname === '/skip'       && body.task_id) skipTask(body.task_id);
    res.writeHead(303, { Location: redirect });
    res.end();
    return;
  }


  // GET /api/contexts
  if (req.method === 'GET' && pathname === '/api/contexts') {
    const db = openDb();
    const rows = db.prepare('SELECT * FROM contexts ORDER BY sort_order ASC NULLS LAST, label ASC').all();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }

  // POST /api/contexts
  if (req.method === 'POST' && pathname === '/api/contexts') {
    const body = await parseJsonBody(req);
    const { slug, label, color } = body;
    if (!slug || !label) { res.writeHead(400); res.end('slug and label required'); return; }
    const db = openDb();
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM contexts').get().m ?? 0;
    db.prepare('INSERT INTO contexts (slug, label, color, sort_order) VALUES (?, ?, ?, ?)')
      .run(slug.trim().toLowerCase(), label.trim(), color ?? '#888888', maxOrder + 1);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ slug }));
    return;
  }

  // PUT /api/contexts/:slug
  if (req.method === 'PUT' && pathname.match(/^\/api\/contexts\/[^/]+$/)) {
    const slug = pathname.split('/')[3];
    const fields = await parseJsonBody(req);
    const db = openDb();
    const sets = []; const params = [];
    if (fields.label !== undefined) { sets.push('label = ?'); params.push(fields.label); }
    if (fields.color !== undefined) { sets.push('color = ?'); params.push(fields.color); }
    if (fields.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(fields.sort_order); }
    if (sets.length === 0) { res.writeHead(400); res.end('nothing to update'); return; }
    db.prepare(`UPDATE contexts SET ${sets.join(', ')} WHERE slug = ?`).run(...params, slug);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // DELETE /api/contexts/:slug
  if (req.method === 'DELETE' && pathname.match(/^\/api\/contexts\/[^/]+$/)) {
    const slug = pathname.split('/')[3];
    const db = openDb();
    db.prepare('DELETE FROM contexts WHERE slug = ?').run(slug);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Habits API ────────────────────────────────────────────────────────────────

  // GET /api/habits?date=YYYY-MM-DD  — habits due on date with log status + 7-day history
  if (req.method === 'GET' && pathname === '/api/habits') {
    const date = url.searchParams.get('date') ?? todayStr();
    const db = openDb();
    const allHabits = db.prepare('SELECT * FROM habits WHERE active = 1 ORDER BY created_at ASC').all();
    // Current week Mon–Sun containing the requested date
    const d = new Date(date + 'T00:00:00Z')
    const dow = d.getUTCDay()
    const daysFromMon = dow === 0 ? 6 : dow - 1
    const monday = offsetDateStr(date, -daysFromMon)
    const days = Array.from({ length: 7 }, (_, i) => offsetDateStr(monday, i))
    const logs = db.prepare(`SELECT * FROM habit_logs WHERE date >= ? AND date <= ?`).all(days[0], days[6]);
    const logMap = {};
    for (const l of logs) logMap[`${l.habit_id}:${l.date}`] = l;

    const result = allHabits
      .filter(h => isHabitDueOn(h, date))
      .map(h => ({
        ...h,
        today_log: logMap[`${h.id}:${date}`] ?? null,
        week: days.map(d => ({
          date: d,
          due: isHabitDueOn(h, d),
          log: logMap[`${h.id}:${d}`] ?? null,
        })),
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /api/habits/history?habit_id=&days=7
  if (req.method === 'GET' && pathname === '/api/habits/history') {
    const habit_id = url.searchParams.get('habit_id');
    const days = parseInt(url.searchParams.get('days') ?? '7', 10);
    const db = openDb();
    const since = offsetDateStr(todayStr(), -(days - 1));
    const query = habit_id
      ? db.prepare('SELECT * FROM habit_logs WHERE habit_id = ? AND date >= ? ORDER BY date DESC').all(habit_id, since)
      : db.prepare('SELECT * FROM habit_logs WHERE date >= ? ORDER BY date DESC').all(since);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(query));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
  } catch (err) {
    console.error('[api] request error:', err);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error'); }
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Run: lsof -ti :${PORT} | xargs kill -9`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

// ── Terminal WebSocket server ─────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const shell = process.env.SHELL || '/bin/zsh';
  const settings = loadSettings();
  const cwd = settings.terminalCwd || process.env.HOME;

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env,
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n` }));
    console.error('[terminal] pty.spawn failed:', err);
    return;
  }

  ptyProcess.onData(data => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  ptyProcess.onExit(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit' }));
    }
  });

  ws.on('message', (msg) => {
    try {
      const message = JSON.parse(msg.toString());
      if (message.type === 'input') {
        ptyProcess.write(message.data);
      } else if (message.type === 'resize') {
        ptyProcess.resize(message.cols, message.rows);
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    try { ptyProcess.kill(); } catch (_) {}
  });
});

// Run migrations at startup so all tables/columns exist before any request
migrate(openDb());
try { autoRunAgents(); } catch (_) {}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Task OS  →  http://localhost:${PORT}`);
});
