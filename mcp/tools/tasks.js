import { v4 as uuidv4 } from 'uuid';
import { openDb, nowIso, today, appendAiContext, nextRecurrenceDate } from '../db.js';

function spawnNextOccurrence(db, task, now) {
  if (!task.recurrence) return null;
  // Use the task's own due_date as the base so completing a past-due task
  // spawns for the correct next date, not the day after today.
  const baseDate = task.due_date ?? today();
  const nextDate = nextRecurrenceDate(baseDate, task.recurrence);
  if (!nextDate) return null;
  const next_task_id = uuidv4();
  db.prepare(`
    INSERT INTO tasks (
      id, title, description, status, my_priority, energy_required, context, project,
      tags, source, source_url, created_at, updated_at, start_date, due_date,
      task_type, recurrence, ai_context,
      agent_path, agent_resume, agent_autorun, agent_autorun_time
    ) VALUES (
      @id, @title, @description, 'active', @my_priority, @energy_required, @context, @project,
      @tags, @source, @source_url, @created_at, @updated_at, @start_date, @due_date,
      @task_type, @recurrence, @ai_context,
      @agent_path, @agent_resume, @agent_autorun, @agent_autorun_time
    )
  `).run({
    id:                next_task_id,
    title:             task.title,
    description:       task.description,
    my_priority:       task.my_priority,
    energy_required:   task.energy_required,
    context:           task.context,
    project:           task.project,
    tags:              task.tags,
    source:            task.source ?? 'manual',
    source_url:        task.source_url,
    created_at:        now,
    updated_at:        now,
    start_date:        nextDate,
    due_date:          nextDate,
    task_type:         task.task_type,
    recurrence:        task.recurrence,
    ai_context:        appendAiContext(null, `Recurred from task ${task.id}`),
    agent_path:        task.agent_path ?? null,
    agent_resume:      task.agent_resume ?? 1,
    agent_autorun:     task.agent_autorun ?? 0,
    agent_autorun_time: task.agent_autorun_time ?? '09:00',
  });
  return { next_task_id, next_start_date: nextDate };
}

function queueSyncEntry(db, task_id, source, action, payload) {
  db.prepare(`
    INSERT INTO sync_log (id, task_id, source, action, payload, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
  `).run(uuidv4(), task_id, source, action, JSON.stringify(payload));
}

export const toolDefs = [
  {
    name: 'create_task',
    description: 'Create a new task. Returns the new task ID.',
    inputSchema: {
      type: 'object',
      properties: {
        title:           { type: 'string', description: 'Task title (required)' },
        description:     { type: 'string', description: 'Detailed task description / agent prompt' },
        context:         { type: 'string', description: 'personal | internal | monroe | biztobiz | any slug' },
        project:         { type: 'string', description: 'Project name within the context' },
        my_priority:     { type: 'integer', description: '1 (highest) to 5 (lowest)' },
        energy_required: { type: 'string', description: 'high | medium | low | async' },
        due_date:        { type: 'string', description: 'ISO date YYYY-MM-DD' },
        start_date:      { type: 'string', description: 'Do not surface before this date' },
        surface_after:   { type: 'string', description: 'Snooze/defer: surface on or after this date' },
        source:          { type: 'string', description: 'asana | notion | linear | github | manual' },
        source_id:       { type: 'string' },
        source_url:      { type: 'string', description: 'Deep link back to the original task/item' },
        source_priority: { type: 'string', description: 'Priority in the originating system' },
        tags:            { type: 'string', description: 'Comma-separated tags' },
        ai_context:      { type: 'string', description: 'Initial context note' },
        status:          { type: 'string', description: 'active (default) | snoozed | backlog | archived' },
        task_type:       { type: 'string', description: 'task (default) | event | reminder' },
        event_time:      { type: 'string', description: 'HH:MM start time for events (e.g. 14:30). Null = all-day.' },
        end_time:        { type: 'string', description: 'HH:MM end time for events. If omitted, defaults to 1hr after event_time.' },
        parent_id:       { type: 'string', description: 'ID of parent task (for subtasks)' },
        recurrence:      { type: 'string', description: 'daily | weekdays | weekly | monthly — auto-respawns on completion' },
        agent_path:      { type: 'string', description: 'Absolute path to the agent folder to dispatch this task to (e.g. /Users/you/IdeaProjects/myrepo/agents/planning)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Update fields on a task. ai_context is prepended (timestamped) rather than overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:         { type: 'string' },
        title:           { type: 'string' },
        description:     { type: 'string', description: 'Detailed task description / agent prompt' },
        status:          { type: 'string', description: 'active | snoozed | backlog | archived | done' },
        context:         { type: 'string' },
        project:         { type: 'string' },
        my_priority:     { type: 'integer' },
        energy_required: { type: 'string' },
        due_date:        { type: 'string' },
        start_date:      { type: 'string' },
        surface_after:   { type: 'string' },
        source_url:      { type: 'string' },
        tags:            { type: 'string' },
        ai_context:      { type: 'string', description: 'New note to prepend (timestamped automatically)' },
        task_type:       { type: 'string', description: 'task | event | reminder' },
        event_time:      { type: 'string', description: 'HH:MM start time for events. Null = all-day.' },
        end_time:        { type: 'string', description: 'HH:MM end time for events. Defaults to 1hr after event_time if omitted.' },
        recurrence:      { type: 'string', description: 'daily | weekdays | weekly | monthly | null to clear' },
        parent_id:       { type: 'string', description: 'ID of parent task (for subtasks). Pass empty string to clear.' },
        links:           { type: 'array', items: { type: 'object' }, description: 'Array of link objects e.g. [{"url": "/path/to/file.md"}]. Replaces existing links.' },
        agent_path:      { type: 'string', description: 'Absolute path to the agent folder for this task. Pass empty string to clear.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_task',
    description: 'Get full details for a single task by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'search_tasks',
    description: 'Search tasks by keyword, context, status, or tags.',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Searches title, description, ai_context' },
        context: { type: 'string' },
        status:  { type: 'string', description: 'active | snoozed | backlog | archived | done' },
        tags:    { type: 'string' },
        limit:   { type: 'integer', description: 'Default 20' },
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done. Queues a sync entry if the task has an external source.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        notes:   { type: 'string', description: 'Optional completion notes' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'snooze_task',
    description: 'Snooze a task until a future date. Reason is written to ai_context.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:       { type: 'string' },
        surface_after: { type: 'string', description: 'ISO date to resurface (required)' },
        reason:        { type: 'string' },
      },
      required: ['task_id', 'surface_after'],
    },
  },
  {
    name: 'skip_task',
    description: 'Skip a recurring task for today. Marks it done with outcome=skipped and spawns the next occurrence. Use this instead of complete_task when the habit was not done.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_tasks_by_source',
    description: 'Get tasks from a specific external source (asana, linear, notion, github, manual), optionally filtered by context, status, or a specific source_id.',
    inputSchema: {
      type: 'object',
      properties: {
        source:    { type: 'string', description: 'asana | linear | notion | github | manual' },
        source_id: { type: 'string', description: 'Exact external ID to look up a specific task' },
        context:   { type: 'string', description: 'Optional context filter' },
        status:    { type: 'string', description: 'active | snoozed | backlog | done | archived. Defaults to active.' },
      },
      required: ['source'],
    },
  },
  {
    name: 'delete_task',
    description: 'Permanently delete a task and all its subtasks. Use only when the task is wrong/invalid, not just done or deferred.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_contexts',
    description: 'List all registered contexts with label, color, and task counts by status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_context',
    description: 'Register a new context (client, project area, or life area) so it appears in the UI with proper label and color.',
    inputSchema: {
      type: 'object',
      properties: {
        slug:  { type: 'string', description: 'Unique identifier, lowercase, no spaces (e.g. "jamtronica")' },
        label: { type: 'string', description: 'Display name (e.g. "Jamtronica")' },
        color: { type: 'string', description: 'Hex color code (e.g. "#f59e0b"). Defaults to #888888.' },
      },
      required: ['slug', 'label'],
    },
  },
  {
    name: 'archive_task',
    description: 'Archive a task, optionally with a future resurface date.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:       { type: 'string' },
        surface_after: { type: 'string', description: 'Optional: resurface on this date' },
        reason:        { type: 'string' },
      },
      required: ['task_id'],
    },
  },
];

export const handlers = {
  create_task(args) {
    const db = openDb();
    const id = uuidv4();
    const now = nowIso();
    db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, my_priority, energy_required, context, project, tags,
        source, source_id, source_url, source_priority, due_date, start_date, surface_after,
        created_at, updated_at, ai_context, task_type, event_time, end_time, parent_id, recurrence,
        agent_path
      ) VALUES (
        @id, @title, @description, @status, @my_priority, @energy_required, @context, @project, @tags,
        @source, @source_id, @source_url, @source_priority, @due_date, @start_date, @surface_after,
        @created_at, @updated_at, @ai_context, @task_type, @event_time, @end_time, @parent_id, @recurrence,
        @agent_path
      )
    `).run({
      id,
      title:           args.title,
      description:     args.description      ?? null,
      status:          args.status          ?? 'active',
      my_priority:     args.my_priority     ?? null,
      energy_required: args.energy_required ?? null,
      context:         args.context         ?? 'personal',
      project:         args.project         ?? null,
      tags:            args.tags            ?? null,
      source:          args.source          ?? 'manual',
      source_id:       args.source_id       ?? null,
      source_url:      args.source_url      ?? null,
      source_priority: args.source_priority ?? null,
      due_date:        args.due_date        ?? null,
      start_date:      args.start_date      ?? null,
      surface_after:   args.surface_after   ?? null,
      created_at:      now,
      updated_at:      now,
      ai_context:      args.ai_context ? appendAiContext(null, args.ai_context) : null,
      task_type:       args.task_type       ?? 'task',
      event_time:      args.event_time      ?? null,
      end_time:        args.end_time        ?? null,
      parent_id:       args.parent_id       ?? null,
      recurrence:      args.recurrence      ?? null,
      agent_path:      args.agent_path      ?? null,
    });
    const status = args.status ?? 'active';
    return { task_id: id, title: args.title, status, created_at: now };
  },

  update_task(args) {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id);
    if (!task) throw new Error(`Task not found: ${args.task_id}`);

    const mutableFields = [
      'title', 'description', 'status', 'my_priority', 'energy_required',
      'context', 'project', 'tags', 'source_url', 'due_date', 'start_date', 'surface_after',
      'task_type', 'event_time', 'end_time', 'recurrence', 'parent_id', 'agent_path',
    ];

    const updates = {};
    const setClauses = [];

    for (const field of mutableFields) {
      if (args[field] !== undefined) {
        updates[field] = args[field];
        setClauses.push(`${field} = @${field}`);
      }
    }

    if (args.ai_context !== undefined) {
      updates.ai_context = appendAiContext(task.ai_context, args.ai_context);
      setClauses.push('ai_context = @ai_context');
    }

    if (args.links !== undefined) {
      updates.links = JSON.stringify(args.links);
      setClauses.push('links = @links');
    }

    updates.last_touched_ai = nowIso();
    setClauses.push('last_touched_ai = @last_touched_ai');

    updates.task_id = args.task_id;
    db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = @task_id`).run(updates);

    return { task_id: args.task_id, updated_fields: Object.keys(updates).filter(k => k !== 'task_id') };
  },

  get_task(args) {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id);
    if (!task) throw new Error(`Task not found: ${args.task_id}`);
    return task;
  },

  search_tasks(args) {
    const db = openDb();
    const conditions = [];
    const params = {};

    if (args.query) {
      conditions.push('(title LIKE @query OR description LIKE @query OR ai_context LIKE @query)');
      params.query = `%${args.query}%`;
    }
    if (args.context) {
      conditions.push('context = @context');
      params.context = args.context;
    }
    if (args.status) {
      conditions.push('status = @status');
      params.status = args.status;
    }
    if (args.tags) {
      conditions.push('tags LIKE @tags');
      params.tags = `%${args.tags}%`;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = args.limit ?? 20;
    return db.prepare(
      `SELECT * FROM tasks ${where} ORDER BY my_priority ASC, due_date ASC LIMIT ${limit}`
    ).all(params);
  },

  complete_task(args) {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id);
    if (!task) throw new Error(`Task not found: ${args.task_id}`);

    const now = nowIso();
    const note = args.notes ? `Completed: ${args.notes}` : 'Marked complete.';
    const ai_context = appendAiContext(task.ai_context, note);

    db.prepare(`
      UPDATE tasks SET status = 'done', outcome = 'completed', last_touched_human = @now, ai_context = @ai_context
      WHERE id = @id
    `).run({ now, ai_context, id: args.task_id });

    if (task.source && task.source !== 'manual') {
      queueSyncEntry(db, args.task_id, task.source, 'completed', { title: task.title });
    }

    const next = spawnNextOccurrence(db, task, now);
    return { task_id: args.task_id, completed_at: now, ...( next ?? {}) };
  },

  skip_task(args) {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id);
    if (!task) throw new Error(`Task not found: ${args.task_id}`);
    if (!task.recurrence) throw new Error(`Task ${args.task_id} is not a recurring task — use complete_task instead.`);

    const now = nowIso();
    const ai_context = appendAiContext(task.ai_context, 'Skipped.');

    db.prepare(`
      UPDATE tasks SET status = 'done', outcome = 'skipped', last_touched_human = @now, ai_context = @ai_context
      WHERE id = @id
    `).run({ now, ai_context, id: args.task_id });

    const next = spawnNextOccurrence(db, task, now);
    return { task_id: args.task_id, skipped_at: now, ...( next ?? {}) };
  },

  snooze_task(args) {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id);
    if (!task) throw new Error(`Task not found: ${args.task_id}`);

    const reason = args.reason ?? 'No reason given.';
    const ai_context = appendAiContext(task.ai_context, `Snoozed until ${args.surface_after}: ${reason}`);

    db.prepare(`
      UPDATE tasks SET status = 'snoozed', surface_after = @surface_after,
      ai_context = @ai_context, last_touched_human = @now WHERE id = @id
    `).run({ surface_after: args.surface_after, ai_context, now: nowIso(), id: args.task_id });

    return { task_id: args.task_id, surface_after: args.surface_after };
  },

  get_tasks_by_source(args) {
    const db = openDb();
    const conditions = ['source = @source'];
    const params = { source: args.source };

    if (args.source_id) { conditions.push('source_id = @source_id'); params.source_id = args.source_id; }
    if (args.context)   { conditions.push('context = @context');     params.context   = args.context; }
    conditions.push('status = @status');
    params.status = args.status ?? 'active';

    return db.prepare(
      `SELECT id, title, status, context, project, due_date, my_priority, source_id, source_url, energy_required
       FROM tasks WHERE ${conditions.join(' AND ')}
       ORDER BY my_priority ASC NULLS LAST, due_date ASC NULLS LAST`
    ).all(params);
  },

  delete_task(args) {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id);
    if (!task) throw new Error(`Task not found: ${args.task_id}`);
    db.prepare('DELETE FROM agent_jobs WHERE task_id = ?').run(args.task_id);
    db.prepare('DELETE FROM tasks WHERE id = ? OR parent_id = ?').run(args.task_id, args.task_id);
    return { deleted: args.task_id, title: task.title };
  },

  list_contexts() {
    const db = openDb();
    const rows = db.prepare(`
      SELECT
        c.slug, c.label, c.color,
        COALESCE(t.active,  0) as active,
        COALESCE(t.snoozed, 0) as snoozed,
        COALESCE(t.backlog, 0) as backlog,
        COALESCE(t.done,    0) as done
      FROM contexts c
      LEFT JOIN (
        SELECT context,
          SUM(CASE WHEN status = 'active'  THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN status = 'snoozed' THEN 1 ELSE 0 END) as snoozed,
          SUM(CASE WHEN status = 'backlog' THEN 1 ELSE 0 END) as backlog,
          SUM(CASE WHEN status = 'done'    THEN 1 ELSE 0 END) as done
        FROM tasks WHERE task_type != 'event'
        GROUP BY context
      ) t ON t.context = c.slug
      ORDER BY c.sort_order ASC NULLS LAST, c.label ASC
    `).all();
    return rows;
  },

  create_context(args) {
    const db = openDb();
    const slug = args.slug.trim().toLowerCase();
    const existing = db.prepare('SELECT slug FROM contexts WHERE slug = ?').get(slug);
    if (existing) throw new Error(`Context '${slug}' already exists.`);
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM contexts').get().m ?? 0;
    const label = args.label.trim();
    db.prepare('INSERT INTO contexts (slug, display_name, label, color, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(slug, label, label, args.color ?? '#888888', maxOrder + 1);
    return { slug, label, color: args.color ?? '#888888' };
  },

  archive_task(args) {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id);
    if (!task) throw new Error(`Task not found: ${args.task_id}`);

    const reason = args.reason ?? 'Archived.';
    const resurfaceNote = args.surface_after ? ` Will resurface ${args.surface_after}.` : '';
    const ai_context = appendAiContext(task.ai_context, `Archived: ${reason}${resurfaceNote}`);

    db.prepare(`
      UPDATE tasks SET status = 'archived', surface_after = @surface_after,
      ai_context = @ai_context, last_touched_human = @now WHERE id = @id
    `).run({ surface_after: args.surface_after ?? null, ai_context, now: nowIso(), id: args.task_id });

    return { task_id: args.task_id, archived_until: args.surface_after ?? null };
  },
};
