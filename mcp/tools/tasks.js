import { v4 as uuidv4 } from 'uuid';
import { openDb, nowIso, today, appendAiContext, nextRecurrenceDate } from '../db.js';

const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000)
const offsetDate = (dateStr, days) => { const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }

function spawnNextOccurrence(db, task, now) {
  if (!task.recurrence) return null;
  // Advance from the task's due_date (or start_date) to today-or-future in one shot,
  // so completing a long-overdue task spawns for today (or next future occurrence),
  // not for a date that's already in the past.
  const t = today();
  let baseDate = task.due_date ?? task.start_date ?? t;
  let nextDate = nextRecurrenceDate(baseDate, task.recurrence);
  while (nextDate && nextDate < t) {
    baseDate = nextDate;
    nextDate = nextRecurrenceDate(baseDate, task.recurrence);
  }
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
    start_date:        task.start_date && task.due_date ? offsetDate(nextDate, -daysBetween(task.start_date, task.due_date)) : (task.start_date && !task.due_date ? nextDate : null),
    due_date:          task.start_date && !task.due_date ? null : nextDate,
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
        task_type:       { type: 'string', description: 'task (default) | event | reminder | reading | coding. Set coding only to explicitly route to the Code view. Agents can be assigned to any task type.' },
        event_time:      { type: 'string', description: 'HH:MM start time for events (e.g. 14:30). Null = all-day.' },
        end_time:        { type: 'string', description: 'HH:MM end time for events. If omitted, defaults to 1hr after event_time.' },
        parent_id:       { type: 'string', description: 'ID of parent task (for subtasks)' },
        recurrence:      { type: 'string', description: 'daily | weekdays | weekly | monthly — auto-respawns on completion. Also accepts full RRULE strings for precision (e.g. FREQ=WEEKLY;BYDAY=MO for every Monday, FREQ=MONTHLY;BYMONTHDAY=1 for 1st of month).' },
        agent_path:      { type: 'string', description: 'Absolute path to the agent folder to dispatch this task to.' },
        assigned_agent:  { type: 'string', description: 'Human-readable name of the agent assigned to this task (e.g. "Code Planner", "Research Agent"). Used to filter tasks by agent.' },
        links:           { type: 'array', items: { type: 'string' }, description: 'Array of URLs or file paths to attach to the task' },
        inbox:           { type: 'boolean', description: 'Mark as inbox item — surfaces in a separate Inbox section for human review before scheduling. Use when creating tasks on behalf of the user that need triage.' },
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
        description:     { type: 'string', description: 'Detailed task description / agent prompt (also accepted as "notes")' },
        notes:           { type: 'string', description: 'Alias for description — use either field name' },
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
        task_type:       { type: 'string', description: 'task | event | reminder | coding | reading' },
        event_time:      { type: 'string', description: 'HH:MM start time for events. Null = all-day.' },
        end_time:        { type: 'string', description: 'HH:MM end time for events. Defaults to 1hr after event_time if omitted.' },
        recurrence:      { type: 'string', description: 'daily | weekdays | weekly | monthly | null to clear. Also accepts full RRULE strings (e.g. FREQ=WEEKLY;BYDAY=MO for every Monday).' },
        parent_id:       { type: 'string', description: 'ID of parent task (for subtasks). Pass empty string to clear.' },
        links:           { type: 'array', items: { type: 'object' }, description: 'Array of link objects e.g. [{"url": "/path/to/file.md"}]. Replaces existing links.' },
        agent_path:          { type: 'string', description: 'Absolute path to the agent folder for this task. Pass empty string to clear.' },
        assigned_agent:      { type: 'string', description: 'Human-readable agent name (e.g. "Code Planner"). Pass empty string to clear.' },
        agent_autorun:       { type: 'boolean', description: 'Whether the agent should run automatically on a schedule.' },
        agent_autorun_time:  { type: 'string', description: 'HH:MM time for the daily auto-run (e.g. "05:00"). Requires agent_autorun: true.' },
        inbox:               { type: 'boolean', description: 'Set to false to clear from inbox (move to normal task list).' },
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
    description: 'Search tasks by keyword, context, status, task_type, tags, or assigned agent.',
    inputSchema: {
      type: 'object',
      properties: {
        query:          { type: 'string', description: 'Searches title, description, ai_context' },
        context:        { type: 'string', description: 'Context slug or label (e.g. "monroe" or "Monroe Institute"). Use list_contexts to see all values.' },
        status:         { type: 'string', description: 'active | snoozed | backlog | archived | done' },
        task_type:      { type: 'string', description: 'Filter by type: task | event | reminder | coding | reading' },
        tags:           { type: 'string' },
        assigned_agent: { type: 'string', description: 'Filter by assigned_agent name (partial match, case-insensitive)' },
        agent_path:     { type: 'string', description: 'Filter by agent_path folder (partial match, e.g. "muzebook/agents/plan")' },
        limit:          { type: 'integer', description: 'Default 20' },
      },
    },
  },
  {
    name: 'get_tasks_by_agent',
    description: 'Get tasks assigned to a specific agent, each annotated with its latest job status (job_status: queued | running | done | failed | null). Matches against assigned_agent (human name) OR agent_path (folder path). Pass a name like "Code Planner" or a path fragment like "muzebook/agents/plan". Filter by job_status to find currently running jobs or only unstarted work.',
    inputSchema: {
      type: 'object',
      properties: {
        agent:      { type: 'string', description: 'Agent name or path fragment (partial match against assigned_agent OR agent_path, case-insensitive)' },
        status:     { type: 'string', description: 'Task status: active | snoozed | backlog | archived | done. Defaults to active.' },
        job_status: { type: 'string', description: 'Filter by latest agent job status: queued | running | done | failed | none (no job ever queued)' },
        context:    { type: 'string', description: 'Optional context filter' },
        limit:      { type: 'integer', description: 'Default 50' },
      },
      required: ['agent'],
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
  {
    name: 'list_projects',
    description: 'List all projects with their task counts. Use this before rename_project to see the current project names.',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: { type: 'boolean', description: 'Include archived projects (default false)' },
      },
    },
  },
  {
    name: 'rename_project',
    description: 'Rename a project. If the target name already exists, the two projects are merged (all tasks from "from" move to "to", the "from" project is deleted). Use this to clean up slug/title duplicates like "silvermouse" → "Silvermouse" or to consolidate projects.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Current project name (exact match)' },
        to:   { type: 'string', description: 'New project name. If this already exists, projects will be merged.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'delete_context',
    description: 'Delete a context. Tasks referencing this context will have their context field cleared (set to null). Use list_contexts first to confirm the slug.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The context slug to delete (exact match)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'delete_project',
    description: 'Delete a project. Tasks referencing this project will have their project field cleared (set to null). Use list_projects first to confirm the name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The project name to delete (exact match)' },
      },
      required: ['name'],
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
        agent_path, assigned_agent, links, inbox
      ) VALUES (
        @id, @title, @description, @status, @my_priority, @energy_required, @context, @project, @tags,
        @source, @source_id, @source_url, @source_priority, @due_date, @start_date, @surface_after,
        @created_at, @updated_at, @ai_context, @task_type, @event_time, @end_time, @parent_id, @recurrence,
        @agent_path, @assigned_agent, @links, @inbox
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
      assigned_agent:  args.assigned_agent  ?? null,
      links:           args.links ? JSON.stringify(args.links) : null,
      inbox:           args.inbox ? 1 : 0,
    });
    const status = args.status ?? 'active';
    return { task_id: id, title: args.title, status, created_at: now };
  },

  update_task(args) {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id);
    if (!task) throw new Error(`Task not found: ${args.task_id}`);

    // Accept 'notes' as an alias for 'description' (legacy field name)
    if (args.notes !== undefined && args.description === undefined) args.description = args.notes;

    const mutableFields = [
      'title', 'description', 'status', 'my_priority', 'energy_required',
      'context', 'project', 'tags', 'source_url', 'due_date', 'start_date', 'surface_after',
      'task_type', 'event_time', 'end_time', 'recurrence', 'parent_id', 'agent_path',
      'assigned_agent', 'agent_autorun', 'agent_autorun_time', 'inbox',
    ];

    const updates = {};
    const setClauses = [];

    for (const field of mutableFields) {
      if (args[field] !== undefined) {
        const v = args[field];
        updates[field] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
        setClauses.push(`${field} = @${field}`);
      }
    }

    if (args.ai_context !== undefined) {
      updates.ai_context = appendAiContext(task.ai_context, args.ai_context);
      setClauses.push('ai_context = @ai_context');
    }

    if (args.agent_autorun !== undefined) {
      updates.agent_autorun = args.agent_autorun ? 1 : 0;
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
      const ctx = db.prepare(
        `SELECT slug FROM contexts WHERE LOWER(slug) = LOWER(?) OR LOWER(label) = LOWER(?) LIMIT 1`
      ).get(args.context, args.context);
      conditions.push('context = @context');
      params.context = ctx ? ctx.slug : args.context;
    }
    if (args.status) {
      conditions.push('status = @status');
      params.status = args.status;
    }
    if (args.tags) {
      conditions.push('tags LIKE @tags');
      params.tags = `%${args.tags}%`;
    }
    if (args.assigned_agent) {
      conditions.push('assigned_agent LIKE @assigned_agent');
      params.assigned_agent = `%${args.assigned_agent}%`;
    }
    if (args.agent_path) {
      conditions.push('agent_path LIKE @agent_path');
      params.agent_path = `%${args.agent_path}%`;
    }
    if (args.task_type) {
      conditions.push('task_type = @task_type');
      params.task_type = args.task_type;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = args.limit ?? 20;
    return db.prepare(
      `SELECT * FROM tasks ${where} ORDER BY my_priority ASC, due_date ASC LIMIT ${limit}`
    ).all(params);
  },

  get_tasks_by_agent(args) {
    const db = openDb();
    const pattern = `%${args.agent}%`;
    const conditions = [
      '(LOWER(t.assigned_agent) LIKE LOWER(@pattern) OR LOWER(t.agent_path) LIKE LOWER(@pattern))',
    ];
    const params = { pattern };

    const status = args.status ?? 'active';
    conditions.push('t.status = @status');
    params.status = status;

    if (args.context) {
      const ctx = db.prepare(
        `SELECT slug FROM contexts WHERE LOWER(slug) = LOWER(?) OR LOWER(label) = LOWER(?) LIMIT 1`
      ).get(args.context, args.context);
      conditions.push('t.context = @context');
      params.context = ctx ? ctx.slug : args.context;
    }

    const limit = args.limit ?? 50;
    let rows = db.prepare(`
      SELECT t.*,
             aj.id         AS job_id,
             aj.status     AS job_status,
             aj.started_at AS job_started_at,
             aj.completed_at AS job_completed_at
      FROM tasks t
      LEFT JOIN agent_jobs aj ON aj.task_id = t.id
        AND aj.id = (
          SELECT id FROM agent_jobs WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
        )
      WHERE ${conditions.join(' AND ')}
      ORDER BY t.my_priority ASC, t.due_date ASC
      LIMIT ${limit}
    `).all(params);

    if (args.job_status) {
      if (args.job_status === 'none') {
        rows = rows.filter(r => r.job_status == null);
      } else {
        rows = rows.filter(r => r.job_status === args.job_status);
      }
    }

    return { agent: args.agent, status, count: rows.length, tasks: rows };
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
    const subtaskIds = db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(args.task_id).map(r => r.id);
    const allIds = [args.task_id, ...subtaskIds];
    const ph = allIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM notes       WHERE task_id IN (${ph})`).run(...allIds);
    db.prepare(`DELETE FROM agent_jobs  WHERE task_id IN (${ph})`).run(...allIds);
    db.prepare(`DELETE FROM attachments WHERE task_id IN (${ph})`).run(...allIds);
    db.prepare(`DELETE FROM sync_log    WHERE task_id IN (${ph})`).run(...allIds);
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

  list_projects(args) {
    const db = openDb();
    const includeArchived = args?.include_archived ?? false;
    const rows = includeArchived
      ? db.prepare('SELECT * FROM projects ORDER BY archived ASC, name ASC').all()
      : db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY name ASC').all();
    const counts = db.prepare(`
      SELECT project, COUNT(*) as total,
        SUM(CASE WHEN status = 'active'  THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'backlog' THEN 1 ELSE 0 END) as backlog
      FROM tasks WHERE project IS NOT NULL GROUP BY project
    `).all();
    const countMap = {};
    for (const r of counts) countMap[r.project] = r;
    return rows.map(p => ({
      name: p.name,
      archived: p.archived === 1,
      active: countMap[p.name]?.active ?? 0,
      backlog: countMap[p.name]?.backlog ?? 0,
      total: countMap[p.name]?.total ?? 0,
    }));
  },

  rename_project(args) {
    const db = openDb();
    const { from, to } = args;
    if (!from || !to) throw new Error('Both "from" and "to" are required');
    if (from === to) throw new Error('"from" and "to" are the same');
    const existing = db.prepare('SELECT name FROM projects WHERE name = ?').get(to);
    db.transaction(() => {
      db.prepare('UPDATE tasks SET project = ? WHERE project = ?').run(to, from);
      if (existing) {
        db.prepare('DELETE FROM projects WHERE name = ?').run(from);
      } else {
        db.prepare('UPDATE projects SET name = ? WHERE name = ?').run(to, from);
      }
    })();
    return { ok: true, from, to, merged: !!existing };
  },

  delete_context(args) {
    const db = openDb();
    const slug = args.slug.trim();
    const existing = db.prepare('SELECT slug, label FROM contexts WHERE slug = ?').get(slug);
    if (!existing) throw new Error(`Context '${slug}' not found.`);
    const { changes } = db.prepare('UPDATE tasks SET context = NULL WHERE context = ?').run(slug);
    // Clear from agents table so rescan doesn't leave orphaned references that Claude would recreate
    db.prepare('UPDATE agents SET context = NULL WHERE context = ?').run(slug);
    db.prepare('DELETE FROM contexts WHERE slug = ?').run(slug);
    return { ok: true, deleted: slug, label: existing.label, tasks_cleared: changes };
  },

  delete_project(args) {
    const db = openDb();
    const name = args.name.trim();
    const existing = db.prepare('SELECT name FROM projects WHERE name = ?').get(name);
    if (!existing) throw new Error(`Project '${name}' not found.`);
    const { changes } = db.prepare('UPDATE tasks SET project = NULL WHERE project = ?').run(name);
    db.prepare('DELETE FROM projects WHERE name = ?').run(name);
    return { ok: true, deleted: name, tasks_cleared: changes };
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
