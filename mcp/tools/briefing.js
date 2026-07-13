import { openDb, today, nowIso, appendAiContext, nextRecurrenceDate, offsetDate, daysBetween } from '../db.js';
import { v4 as uuidv4 } from 'uuid';

// Spawn the next occurrence of a recurring task, preserving every field db-worker preserves
// (bug C4: this copy previously dropped notes/links/agent_path/agent_resume/agent_autorun/
// agent_autorun_time and re-anchored start-date-only tasks). Field-for-field parity with
// db-worker.js spawnRecurrence.
function spawnRecurrence(db, task, nextDate, now, reason) {
  let spawnedStart = null;
  let spawnedDue = nextDate;
  if (task.start_date && task.due_date) {
    spawnedStart = offsetDate(nextDate, -daysBetween(task.start_date, task.due_date));
  } else if (task.start_date && !task.due_date) {
    spawnedStart = nextDate;
    spawnedDue = null;
  }
  // time_estimate + inbox preserved across respawn (bug C15 — this copy was missed; parity with db-worker).
  db.prepare(`INSERT INTO tasks (id, title, description, notes, links, status, my_priority, energy_required, context, project, tags, source, source_url, created_at, updated_at, last_reviewed_at, start_date, due_date, hard_deadline, task_type, recurrence, ai_context, time_estimate, inbox, agent_path, agent_resume, agent_autorun, agent_autorun_time) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), task.title, task.description, task.notes ?? null, task.links ?? null, task.my_priority, task.energy_required, task.context, task.project, task.tags, task.source ?? 'manual', task.source_url, now, now, now, spawnedStart, spawnedDue, task.hard_deadline ? 1 : 0, task.task_type, task.recurrence, appendAiContext(null, reason), task.time_estimate ?? null, task.inbox ?? 0, task.agent_path ?? null, task.agent_resume ?? 1, task.agent_autorun ?? 0, task.agent_autorun_time ?? '09:00');
}

function autoRolloverRecurring(db) {
  const t = today();
  // Exclude events — they must not be auto-skipped/respawned (bug C4; matches db-worker).
  const stale = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'active' AND task_type != 'event' AND recurrence IS NOT NULL
      AND (
        (due_date IS NOT NULL AND due_date < ?)
        OR (due_date IS NULL AND start_date IS NOT NULL AND start_date < ?)
      )
  `).all(t, t);
  const now = nowIso();
  // Wrap claim+spawn per task in a transaction and claim via compare-and-set (bug C12): this
  // rollover runs in a separate process/connection from db-worker's copy, so without a status
  // recheck at write time two concurrent runs both read the task as 'active' and both spawn a
  // fresh occurrence. Flipping active->done only WHERE status='active' means exactly one writer
  // wins the claim (changes===1); the loser skips the spawn.
  const rollover = db.transaction((tasks) => {
    for (const task of tasks) {
      const claim = db.prepare(`UPDATE tasks SET status = 'done', outcome = 'skipped', last_touched_human = ?, ai_context = ? WHERE id = ? AND status = 'active'`)
        .run(now, appendAiContext(task.ai_context, 'Auto-skipped: overdue recurring task.'), task.id);
      if (claim.changes !== 1) continue;
      // Advance from the task's own schedule anchor (not today) to preserve cadence alignment.
      // If skipped/missed across multiple periods, walk forward until the next occurrence >= today.
      let baseDate = task.due_date ?? task.start_date ?? t;
      let nextDate = nextRecurrenceDate(baseDate, task.recurrence);
      while (nextDate && nextDate < t) {
        baseDate = nextDate;
        nextDate = nextRecurrenceDate(baseDate, task.recurrence);
      }
      if (nextDate) spawnRecurrence(db, task, nextDate, now, `Auto-recurred from task ${task.id}`);
    }
  });
  rollover(stale);
  return stale.length;
}

export const toolDefs = [
  {
    name: 'morning_briefing',
    description: 'Daily starting point. Returns overdue tasks, tasks waking from snooze, tasks due today, total active count, and a breakdown by context.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'afternoon_briefing',
    description: 'Mid-day check-in. Returns what was completed today, what is still active, and what is overdue.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'stale_backlog_review',
    description: 'Surface a small batch of backlog items that have not been touched in a while. Updates last_surfaced for returned tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        context:      { type: 'string', description: 'Optional: review one context at a time' },
        limit:        { type: 'integer', description: 'How many to surface (default 5)' },
        max_age_days: { type: 'integer', description: 'Surface items not touched in N days (default 30)' },
      },
    },
  },
];

export const handlers = {
  morning_briefing() {
    const db = openDb();
    const t = today();
    autoRolloverRecurring(db);

    const overdue = db.prepare(
      `SELECT id, title, task_type, tags, context, project, due_date, my_priority, energy_required, time_estimate, source_url, parent_id
       FROM tasks WHERE status = 'active' AND due_date IS NOT NULL AND due_date < ?
         AND task_type NOT IN ('event', 'reading')
       ORDER BY due_date ASC`
    ).all(t);

    const waking_up = db.prepare(
      `SELECT id, title, task_type, tags, context, project, due_date, my_priority, surface_after, ai_context, source_url
       FROM tasks WHERE status IN ('snoozed', 'archived') AND surface_after IS NOT NULL
       AND surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')
       ORDER BY surface_after ASC`
    ).all();

    const due_today = db.prepare(
      `SELECT id, title, task_type, tags, context, project, due_date, my_priority, energy_required, time_estimate, source_url, parent_id
       FROM tasks WHERE status = 'active' AND due_date = ? AND task_type NOT IN ('event', 'reading')
       ORDER BY my_priority ASC NULLS LAST`
    ).all(t);

    const { active_count } = db.prepare(
      `SELECT count(*) as active_count FROM tasks WHERE status = 'active' AND task_type != 'event'`
    ).get();

    const contextRows = db.prepare(
      `SELECT context, count(*) as count FROM tasks WHERE status = 'active' AND task_type != 'event' GROUP BY context ORDER BY count DESC`
    ).all();

    const by_context = Object.fromEntries(contextRows.map(r => [r.context, r.count]));

    const allWorkable = [...overdue, ...due_today];
    const estimatedMinutes = allWorkable.reduce((sum, t) => sum + (t.time_estimate ?? 0), 0);
    const tasksWithEstimate = allWorkable.filter(t => t.time_estimate != null).length;
    const capacity = {
      estimated_minutes: estimatedMinutes,
      tasks_with_estimate: tasksWithEstimate,
      tasks_without_estimate: allWorkable.length - tasksWithEstimate,
    };

    return { overdue, waking_up, due_today, active_count, by_context, capacity };
  },

  afternoon_briefing() {
    const db = openDb();
    const t = today();

    const completed_today = db.prepare(
      `SELECT id, title, context, project, last_touched_human
       FROM tasks WHERE status = 'done' AND task_type != 'event' AND last_touched_human >= ?
       ORDER BY last_touched_human DESC`
    ).all(t);

    const still_active = db.prepare(
      `SELECT id, title, task_type, tags, context, project, due_date, my_priority, energy_required, time_estimate, source_url
       FROM tasks WHERE status = 'active' AND task_type NOT IN ('event', 'reading')
       ORDER BY my_priority ASC NULLS LAST, due_date ASC NULLS LAST`
    ).all();

    const overdue = db.prepare(
      `SELECT id, title, task_type, tags, context, project, due_date, my_priority, time_estimate, source_url, parent_id
       FROM tasks WHERE status = 'active' AND due_date IS NOT NULL AND due_date < ?
         AND task_type NOT IN ('event', 'reading')
       ORDER BY due_date ASC`
    ).all(t);

    return { completed_today, still_active, overdue };
  },

  stale_backlog_review(args) {
    const db = openDb();
    const limit       = args.limit        ?? 5;
    const maxAgeDays  = args.max_age_days ?? 30;
    const cutoff      = new Date(Date.now() - maxAgeDays * 86400000).toISOString().slice(0, 10);

    const conditions = [
      `status = 'backlog'`,
      `(last_surfaced IS NULL OR last_surfaced < '${cutoff}')`,
    ];
    if (args.context) conditions.push(`context = '${args.context.replace(/'/g, "''")}'`);
    const where = `WHERE ${conditions.join(' AND ')}`;

    const rows = db.prepare(
      `SELECT * FROM tasks ${where}
       ORDER BY last_touched_human ASC NULLS FIRST
       LIMIT ${limit}`
    ).all();

    // Update last_surfaced for returned tasks
    const now = nowIso();
    const update = db.prepare(`UPDATE tasks SET last_surfaced = ? WHERE id = ?`);
    const updateMany = db.transaction((tasks) => {
      for (const task of tasks) update.run(now, task.id);
    });
    updateMany(rows);

    return rows;
  },
};
