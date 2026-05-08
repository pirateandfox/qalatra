import { v4 as uuidv4 } from 'uuid';
import { openDb, nowIso } from '../db.js';

function nextRunAt(intervalMinutes, runAtTime) {
  if (runAtTime && intervalMinutes === 1440) {
    const [h, m] = runAtTime.split(':').map(Number);
    const target = new Date();
    target.setHours(h, m, 0, 0);
    if (target <= new Date()) target.setDate(target.getDate() + 1);
    return target.toISOString().replace('T', ' ').slice(0, 19);
  }
  return new Date(Date.now() + intervalMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

export const toolDefs = [
  {
    name: 'list_heartbeats',
    description: 'List all heartbeat agents — persistent background agents that run on a fixed interval (e.g. every 10 min, every hour). Shows active/paused state, timing, and recent run counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_heartbeat',
    description: 'Create a new heartbeat agent that runs a Claude agent prompt on a fixed schedule.',
    inputSchema: {
      type: 'object',
      properties: {
        title:            { type: 'string', description: 'Name for this heartbeat' },
        description:      { type: 'string', description: 'What this heartbeat does' },
        agent_path:       { type: 'string', description: 'Absolute path to the working directory the agent runs in' },
        prompt:           { type: 'string', description: 'The prompt sent to the Claude agent on each run' },
        interval_minutes: { type: 'number', description: 'How often to run in minutes (e.g. 5, 10, 15, 30, 60, 120, 240, 1440)' },
        run_at_time:      { type: 'string', description: 'For daily heartbeats (interval_minutes=1440): local time to run, as HH:MM (e.g. "09:00", "17:30")' },
      },
      required: ['title', 'agent_path', 'prompt'],
    },
  },
  {
    name: 'update_heartbeat',
    description: 'Update a heartbeat agent\'s title, description, prompt, agent_path, or interval.',
    inputSchema: {
      type: 'object',
      properties: {
        id:               { type: 'string' },
        title:            { type: 'string' },
        description:      { type: 'string' },
        agent_path:       { type: 'string' },
        prompt:           { type: 'string' },
        interval_minutes: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'toggle_heartbeat',
    description: 'Pause or resume a heartbeat agent. Pausing stops it from running; resuming schedules the next run immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Heartbeat ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_heartbeat',
    description: 'Permanently delete a heartbeat agent and its job history.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Heartbeat ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_heartbeat_jobs',
    description: 'List recent job runs for a heartbeat agent.',
    inputSchema: {
      type: 'object',
      properties: {
        id:    { type: 'string', description: 'Heartbeat ID' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['id'],
    },
  },
];

export const handlers = {
  list_heartbeats() {
    const db = openDb();
    return db.prepare(`
      SELECT h.*,
        (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status = 'done') as runs_done,
        (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status = 'failed') as runs_failed,
        (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status IN ('queued','running')) as runs_pending
      FROM heartbeats h ORDER BY h.created_at DESC
    `).all();
  },

  create_heartbeat({ title, description, agent_path, prompt, interval_minutes, run_at_time } = {}) {
    if (!title || !agent_path || !prompt) return { error: 'title, agent_path, and prompt are required' };
    const db = openDb();
    const id = uuidv4();
    const now = nowIso();
    const mins = interval_minutes ?? 60;
    const runAt = (run_at_time && mins === 1440) ? run_at_time : null;
    const firstRun = nextRunAt(mins, runAt);
    db.prepare(`
      INSERT INTO heartbeats (id, title, description, agent_path, prompt, interval_minutes, run_at_time, active, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(id, title.trim(), description ?? null, agent_path.trim(), prompt.trim(), mins, runAt, firstRun, now, now);
    return db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id);
  },

  update_heartbeat({ id, title, description, agent_path, prompt, interval_minutes, run_at_time } = {}) {
    if (!id) return { error: 'id required' };
    const db = openDb();
    const allowed = { title, description, agent_path, prompt, interval_minutes, run_at_time };
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(allowed)) {
      if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
    }
    if (!sets.length) return db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id);
    sets.push('updated_at = ?'); vals.push(nowIso()); vals.push(id);
    db.prepare(`UPDATE heartbeats SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id);
  },

  toggle_heartbeat({ id } = {}) {
    if (!id) return { error: 'id required' };
    const db = openDb();
    const hb = db.prepare('SELECT id, active, interval_minutes FROM heartbeats WHERE id = ?').get(id);
    if (!hb) return { error: 'Heartbeat not found' };
    if (hb.active === 1) {
      db.prepare(`UPDATE heartbeats SET active = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    } else {
      const nextRun = addMinutesFromNow(hb.interval_minutes);
      db.prepare(`UPDATE heartbeats SET active = 1, next_run_at = ?, updated_at = ? WHERE id = ?`).run(nextRun, nowIso(), id);
    }
    return db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id);
  },

  delete_heartbeat({ id } = {}) {
    if (!id) return { error: 'id required' };
    const db = openDb();
    db.prepare(`DELETE FROM agent_jobs WHERE heartbeat_id = ?`).run(id);
    db.prepare(`DELETE FROM heartbeats WHERE id = ?`).run(id);
    return { ok: true };
  },

  list_heartbeat_jobs({ id, limit } = {}) {
    if (!id) return { error: 'id required' };
    const db = openDb();
    return db.prepare(`
      SELECT id, status, result, created_at, started_at, completed_at
      FROM agent_jobs WHERE heartbeat_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(id, limit ?? 10);
  },
};
