import { openDb, today, nowIso, appendAiContext, nextRecurrenceDate } from '../db.js';
import { v4 as uuidv4 } from 'uuid';

function autoRolloverRecurring(db) {
  const t = today();
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
    // Advance from the task's original due_date (not today) to preserve cadence alignment.
    // If the task was skipped/missed across multiple periods, walk forward until we find
    // the next occurrence that is >= today.
    let baseDate = task.due_date ?? t;
    let nextDate = nextRecurrenceDate(baseDate, task.recurrence);
    while (nextDate && nextDate < t) {
      baseDate = nextDate;
      nextDate = nextRecurrenceDate(baseDate, task.recurrence);
    }
    if (nextDate) {
      db.prepare(`
        INSERT INTO tasks (
          id, title, description, status, my_priority, energy_required, context, project,
          tags, source, source_url, created_at, updated_at, start_date, due_date, task_type, recurrence, ai_context
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), task.title, task.description, task.my_priority, task.energy_required,
        task.context, task.project, task.tags, task.source ?? 'manual', task.source_url,
        now, now, nextDate, nextDate, task.task_type, task.recurrence,
        appendAiContext(null, `Auto-recurred from task ${task.id}`)
      );
    }
  }
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
      `SELECT id, title, context, project, due_date, my_priority, energy_required, source_url, parent_id
       FROM tasks WHERE status = 'active' AND due_date IS NOT NULL AND due_date < ?
         AND (task_type IS NULL OR task_type != 'event')
       ORDER BY due_date ASC`
    ).all(t);

    const waking_up = db.prepare(
      `SELECT id, title, context, project, due_date, my_priority, surface_after, ai_context, source_url
       FROM tasks WHERE status IN ('snoozed', 'archived') AND surface_after IS NOT NULL
       AND surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')
       ORDER BY surface_after ASC`
    ).all();

    const due_today = db.prepare(
      `SELECT id, title, context, project, due_date, my_priority, energy_required, source_url, parent_id
       FROM tasks WHERE status = 'active' AND due_date = ? AND task_type != 'event'
       ORDER BY my_priority ASC NULLS LAST`
    ).all(t);

    const { active_count } = db.prepare(
      `SELECT count(*) as active_count FROM tasks WHERE status = 'active' AND task_type != 'event'`
    ).get();

    const contextRows = db.prepare(
      `SELECT context, count(*) as count FROM tasks WHERE status = 'active' AND task_type != 'event' GROUP BY context ORDER BY count DESC`
    ).all();

    const by_context = Object.fromEntries(contextRows.map(r => [r.context, r.count]));

    return { overdue, waking_up, due_today, active_count, by_context };
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
      `SELECT id, title, context, project, due_date, my_priority, energy_required, source_url
       FROM tasks WHERE status = 'active' AND task_type != 'event'
       ORDER BY my_priority ASC NULLS LAST, due_date ASC NULLS LAST`
    ).all();

    const overdue = db.prepare(
      `SELECT id, title, context, project, due_date, my_priority, source_url, parent_id
       FROM tasks WHERE status = 'active' AND due_date IS NOT NULL AND due_date < ?
         AND (task_type IS NULL OR task_type != 'event')
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
