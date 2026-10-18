import { v4 as uuidv4 } from 'uuid';
import {
  openDb, nowIso, withTimestampZones,
  resolveHeartbeatSchedule, touchesHeartbeatSchedule, heartbeatNextRunAt, heartbeatUpcomingRuns,
} from '../db.js';

const CRON_DESCRIPTION = 'Standard 5-field cron expression (minute hour day-of-month month day-of-week), evaluated in `timezone`. E.g. "0 5 * * 2-5" = 05:00 Tuesday–Friday. Takes precedence over the interval fields and cannot be combined with interval_minutes, run_at_time or minute_offset.';
const TIMEZONE_DESCRIPTION = 'IANA timezone for cron_expression, e.g. "America/Puerto_Rico". Defaults to the server\'s timezone. Only valid with cron_expression.';

// A heartbeat row leaving the process: zone-stamped, plus the next three cron runs (UTC ISO; empty
// for interval schedules). Computed from the stored naive row, before stamping.
function heartbeatOut(row) {
  if (!row) return row;
  return withTimestampZones({ ...row, upcoming_runs: heartbeatUpcomingRuns(row) }, 'heartbeats');
}

export const toolDefs = [
  {
    name: 'list_heartbeats',
    description: 'List all heartbeat agents — persistent background agents that run on a fixed interval (e.g. every 10 min, every hour) or a cron schedule in a timezone. Shows active/paused state, schedule (cron_expression, timezone), next_run_at, upcoming_runs (next three cron runs, UTC), and recent run counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_heartbeat',
    description: 'Create a new heartbeat agent that runs a Claude agent prompt on a schedule: either interval_minutes (with optional run_at_time / minute_offset) or cron_expression + timezone, not both. An invalid cron expression or unknown timezone is rejected.',
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
        cron_expression:  { type: 'string', description: CRON_DESCRIPTION },
        timezone:         { type: 'string', description: TIMEZONE_DESCRIPTION },
      },
      required: ['title', 'agent_path', 'prompt'],
    },
  },
  {
    name: 'update_heartbeat',
    description: 'Update a heartbeat agent\'s title, description, prompt, agent_path, schedule, or active state. Any schedule change (interval_minutes, run_at_time, minute_offset, cron_expression, timezone) recomputes the next run time. To switch a cron heartbeat back to an interval, pass cron_expression: null with the interval fields. Setting `active` is idempotent — use it instead of toggle_heartbeat when you need a heartbeat to be definitely on or definitely off.',
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
        cron_expression:  { type: ['string', 'null'], description: `${CRON_DESCRIPTION} null switches back to the interval fields.` },
        timezone:         { type: 'string', description: TIMEZONE_DESCRIPTION },
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
    return rows.map(heartbeatOut);
  },

  create_heartbeat(args = {}) {
    const { title, description, agent_path, prompt } = args;
    if (!title || !agent_path || !prompt) return { error: 'title, agent_path, and prompt are required' };
    let schedule;
    try { schedule = resolveHeartbeatSchedule(args); } catch (err) { return { error: err.message }; }
    const db = openDb();
    const id = uuidv4();
    const now = nowIso();
    db.prepare(`
      INSERT INTO heartbeats (id, title, description, agent_path, prompt, interval_minutes, run_at_time, minute_offset, cron_expression, timezone, active, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(id, title.trim(), description ?? null, agent_path.trim(), prompt.trim(), schedule.interval_minutes, schedule.run_at_time,
      schedule.minute_offset, schedule.cron_expression, schedule.timezone, heartbeatNextRunAt(schedule), now, now);
    return heartbeatOut(db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id));
  },

  update_heartbeat(args = {}) {
    const { id, title, description, agent_path, prompt, active } = args;
    if (!id) return { error: 'id required' };
    const db = openDb();
    const existing = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id);
    if (!existing) return { error: 'Heartbeat not found' };
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries({ title, description, agent_path, prompt })) {
      if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
    }
    // Recompute next_run_at on ANY schedule change (bug C18) and normalize like create, so schedule
    // edits take effect instead of firing once more on the stale next_run_at (up to ~7 days late).
    // resolveHeartbeatSchedule rejects cron mixed with interval fields, bad cron and unknown zones.
    const scheduleChanged = touchesHeartbeatSchedule(args);
    if (scheduleChanged) {
      let schedule;
      try { schedule = resolveHeartbeatSchedule(args, existing); } catch (err) { return { error: err.message }; }
      for (const [k, v] of Object.entries(schedule)) { sets.push(`${k} = ?`); vals.push(v); }
      sets.push('next_run_at = ?'); vals.push(heartbeatNextRunAt(schedule));
    }
    // Idempotent enable/disable — the fix for the toggle_heartbeat blind-flip footgun:
    // setting the same value twice is a no-op, unlike toggle. Resuming (0→1) schedules
    // the next run like toggle does, unless a schedule change above already set it.
    if (active !== undefined) {
      const newActive = active ? 1 : 0;
      sets.push('active = ?'); vals.push(newActive);
      if (newActive === 1 && existing.active !== 1 && !scheduleChanged) {
        sets.push('next_run_at = ?'); vals.push(heartbeatNextRunAt(existing));
      }
    }
    if (!sets.length) return heartbeatOut(existing);
    sets.push('updated_at = ?'); vals.push(nowIso()); vals.push(id);
    db.prepare(`UPDATE heartbeats SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return heartbeatOut(db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id));
  },

  toggle_heartbeat({ id } = {}) {
    if (!id) return { error: 'id required' };
    const db = openDb();
    const hb = db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id);
    if (!hb) return { error: 'Heartbeat not found' };
    if (hb.active === 1) {
      db.prepare(`UPDATE heartbeats SET active = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id);
    } else {
      db.prepare(`UPDATE heartbeats SET active = 1, next_run_at = ?, updated_at = ? WHERE id = ?`).run(heartbeatNextRunAt(hb), nowIso(), id);
    }
    return heartbeatOut(db.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id));
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
