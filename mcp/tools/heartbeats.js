import { v4 as uuidv4 } from 'uuid';
import { openDb, nowIso, nextRunAt, withTimestampZones } from '../db.js';

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
        minute_offset:    { type: 'number', description: 'For sub-daily heartbeats: pin runs to clock-aligned times. The heartbeat fires at every Nth minute where N ≡ minute_offset (mod interval_minutes). E.g. interval=30 offset=0 → :00 and :30; interval=30 offset=15 → :15 and :45; interval=60 offset=30 → :30 past every hour.' },
      },
      required: ['title', 'agent_path', 'prompt'],
    },
  },
  {
    name: 'update_heartbeat',
    description: 'Update a heartbeat agent\'s title, description, prompt, agent_path, schedule, or active state. Any schedule change (interval_minutes, run_at_time, minute_offset) recomputes the next run time. Setting `active` is idempotent — use it instead of toggle_heartbeat when you need a heartbeat to be definitely on or definitely off.',
    inputSchema: {
      type: 'object',
      properties: {
        id:               { type: 'string' },
        title:            { type: 'string' },
        description:      { type: 'string' },
        agent_path:       { type: 'string' },
        prompt:           { type: 'string' },
        interval_minutes: { type: 'number' },
        run_at_time:      { type: 'string', description: 'For daily heartbeats (interval_minutes=1440): local time to run, as HH:MM' },
        minute_offset:    { type: 'number', description: 'For sub-daily heartbeats: pin runs to clock-aligned times (N ≡ minute_offset mod interval_minutes)' },
        active:           { type: 'boolean', description: 'Idempotent enable/disable: false pauses the heartbeat, true resumes it (scheduling the next run). Unlike toggle_heartbeat, calling this repeatedly with the same value is safe.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'toggle_heartbeat',
    description: 'Flip a heartbeat between paused and running. WARNING: this is a blind toggle — if another agent already changed the state, calling it will undo that change. When you need a specific state (e.g. "make sure this is disabled"), use update_heartbeat with `active` instead.',
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
    const rows = db.prepare(`
      SELECT h.*,
        (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status = 'done') as runs_done,
        (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status = 'failed') as runs_failed,
        (SELECT COUNT(*) FROM agent_jobs j WHERE j.heartbeat_id = h.id AND j.status IN ('queued','running')) as runs_pending
      FROM heartbeats h ORDER BY h.created_at DESC
    `).all();
    return withTimestampZones(rows, 'heartbeats');
  },

  create_heartbeat({ title, description, agent_path, prompt, interval_minutes, run_at_time, minute_offset } = {}) {
    if (!title || !agent_path || !prompt) return { error: 'title, agent_path, and prompt are required' };
    const db = openDb();
    const id = uuidv4();
    const now = nowIso();
    const mins = interval_minutes ?? 60;
    const runAt = (run_at_time && mins === 1440) ? run_at_time : null;
    const offset = (minute_offset != null && mins < 1440) ? minute_offset : null;
    const firstRun = nextRunAt(mins, runAt, offset);
    db.prepare(`
      INSERT INTO heartbeats (id, title, description, agent_path, prompt, interval_minutes, run_at_time, minute_offset, active, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(id, title.trim(), description ?? null, agent_path.trim(), prompt.trim(), mins, runAt, offset, firstRun, now, now);
    return withTimestampZones(db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id), 'heartbeats');
  },

  update_heartbeat(args = {}) {
    const { id, title, description, agent_path, prompt, interval_minutes, run_at_time, minute_offset, active } = args;
    if (!id) return { error: 'id required' };
    const db = openDb();
    const existing = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id);
    if (!existing) return { error: 'Heartbeat not found' };
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries({ title, description, agent_path, prompt })) {
      if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
    }
    // Recompute next_run_at on ANY schedule change (bug C18) and normalize like create
    // (run_at_time only with interval 1440; minute_offset only with <1440), so schedule edits
    // take effect instead of firing once more on the stale next_run_at (up to ~7 days late).
    const scheduleChanged = ['interval_minutes', 'run_at_time', 'minute_offset'].some(k => k in args && args[k] !== undefined);
    if (scheduleChanged) {
      const mins = (interval_minutes !== undefined ? interval_minutes : existing.interval_minutes) ?? 60;
      const rawRunAt = run_at_time !== undefined ? run_at_time : existing.run_at_time;
      const rawOffset = minute_offset !== undefined ? minute_offset : existing.minute_offset;
      const runAt = (rawRunAt && mins === 1440) ? rawRunAt : null;
      const offset = (rawOffset != null && mins < 1440) ? rawOffset : null;
      sets.push('interval_minutes = ?'); vals.push(mins);
      sets.push('run_at_time = ?'); vals.push(runAt);
      sets.push('minute_offset = ?'); vals.push(offset);
      sets.push('next_run_at = ?'); vals.push(nextRunAt(mins, runAt, offset));
    }
    // Idempotent enable/disable — the fix for the toggle_heartbeat blind-flip footgun:
    // setting the same value twice is a no-op, unlike toggle. Resuming (0→1) schedules
    // the next run like toggle does, unless a schedule change above already set it.
    if (active !== undefined) {
      const newActive = active ? 1 : 0;
      sets.push('active = ?'); vals.push(newActive);
      if (newActive === 1 && existing.active !== 1 && !scheduleChanged) {
        sets.push('next_run_at = ?'); vals.push(nextRunAt(existing.interval_minutes, existing.run_at_time, existing.minute_offset));
      }
    }
    if (!sets.length) return existing;
    sets.push('updated_at = ?'); vals.push(nowIso()); vals.push(id);
    db.prepare(`UPDATE heartbeats SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return withTimestampZones(db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id), 'heartbeats');
  },

  toggle_heartbeat({ id } = {}) {
    if (!id) return { error: 'id required' };
    const db = openDb();
    const hb = db.prepare('SELECT id, active, interval_minutes, run_at_time, minute_offset FROM heartbeats WHERE id = ?').get(id);
    if (!hb) return { error: 'Heartbeat not found' };
    if (hb.active === 1) {
      db.prepare(`UPDATE heartbeats SET active = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    } else {
      const nextRun = nextRunAt(hb.interval_minutes, hb.run_at_time, hb.minute_offset);
      db.prepare(`UPDATE heartbeats SET active = 1, next_run_at = ?, updated_at = ? WHERE id = ?`).run(nextRun, nowIso(), id);
    }
    return withTimestampZones(db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id), 'heartbeats');
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
    const rows = db.prepare(`
      SELECT id, status, result, created_at, started_at, completed_at
      FROM agent_jobs WHERE heartbeat_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(id, limit ?? 10);
    return withTimestampZones(rows, 'agent_jobs');
  },
};
