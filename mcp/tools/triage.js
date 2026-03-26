import { openDb, today, nowIso, appendAiContext } from '../db.js';

export const toolDefs = [
  {
    name: 'get_todays_tasks',
    description: 'Get all active tasks that are ready to work on today (respects start_date).',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Optional context filter' },
      },
    },
  },
  {
    name: 'get_overdue_tasks',
    description: 'Get all active tasks whose due date is in the past.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_waking_tasks',
    description: 'Get snoozed or archived tasks whose surface_after date has arrived. Includes ai_context so you can brief on why they were paused.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'end_of_day_triage',
    description: 'Returns all active tasks due today or earlier that have not been touched by the human today. Used for EOD triage conversation.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'move_to_backlog',
    description: 'Move a task to backlog status.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        notes:   { type: 'string', description: 'Optional note about why it is being backlogged' },
      },
      required: ['task_id'],
    },
  },
];

export const handlers = {
  get_todays_tasks(args) {
    const db = openDb();
    const t = today();
    const conditions = [
      `status = 'active'`,
      `task_type != 'event'`,
      `(start_date IS NULL OR start_date <= '${t}')`,
      `(surface_after IS NULL OR surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime'))`,
    ];
    if (args.context) conditions.push(`context = '${args.context.replace(/'/g, "''")}'`);
    const where = `WHERE ${conditions.join(' AND ')}`;
    return db.prepare(
      `SELECT id, title, context, project, due_date, my_priority, energy_required, source_url, tags
       FROM tasks ${where}
       ORDER BY my_priority ASC NULLS LAST, due_date ASC NULLS LAST`
    ).all();
  },

  get_overdue_tasks() {
    const db = openDb();
    const t = today();
    return db.prepare(
      `SELECT id, title, context, project, due_date, my_priority, energy_required, source_url
       FROM tasks
       WHERE status = 'active' AND task_type != 'event' AND due_date IS NOT NULL AND due_date < ?
       ORDER BY due_date ASC`
    ).all(t);
  },

  get_waking_tasks() {
    const db = openDb();
    return db.prepare(
      `SELECT * FROM tasks
       WHERE status IN ('snoozed', 'archived')
       AND surface_after IS NOT NULL
       AND surface_after <= strftime('%Y-%m-%d %H:%M', 'now', 'localtime')
       ORDER BY surface_after ASC`
    ).all();
  },

  end_of_day_triage() {
    const db = openDb();
    const t = today();
    return db.prepare(
      `SELECT * FROM tasks
       WHERE status = 'active' AND task_type != 'event'
       AND (due_date IS NULL OR due_date <= ?)
       AND (last_touched_human IS NULL OR last_touched_human < ?)
       ORDER BY my_priority ASC NULLS LAST, due_date ASC NULLS LAST`
    ).all(t, t);
  },

  move_to_backlog(args) {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id);
    if (!task) throw new Error(`Task not found: ${args.task_id}`);

    const ai_context = args.notes
      ? appendAiContext(task.ai_context, `Moved to backlog: ${args.notes}`)
      : task.ai_context;

    db.prepare(`
      UPDATE tasks SET status = 'backlog', ai_context = @ai_context, last_touched_human = @now
      WHERE id = @id
    `).run({ ai_context, now: nowIso(), id: args.task_id });

    return { task_id: args.task_id, status: 'backlog' };
  },
};
