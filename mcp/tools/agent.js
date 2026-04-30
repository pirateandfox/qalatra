import { v4 as uuidv4 } from 'uuid';
import { openDb } from '../db.js';

export const toolDefs = [
  {
    name: 'queue_agent_job',
    description: 'Queue a task to be run by its assigned agent. The task must have an agent_path set. Prompt is built from title + description.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to dispatch (must have agent_path assigned)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_agent_jobs',
    description: 'List recent agent jobs, optionally filtered by task_id.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Filter by task ID' },
        limit:   { type: 'integer', description: 'Default 20' },
      },
    },
  },
  {
    name: 'get_agent_job',
    description: 'Get the status and result of a specific agent job.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
      },
      required: ['job_id'],
    },
  },
];

export const handlers = {
  queue_agent_job(args) {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.task_id);
    if (!task) throw new Error(`Task not found: ${args.task_id}`);
    if (!task.agent_path) throw new Error(`Task ${args.task_id} has no agent_path assigned`);

    const existingNotes = db.prepare(`SELECT * FROM notes WHERE task_id = ? ORDER BY created_at ASC`).all(args.task_id);
    const parts = [
      `You are an agent running inside Qalatra. Task ID: ${args.task_id}`,
      `If you create any output files, save them to ${task.agent_path}/output/ and include their paths in your response so Qalatra can link them back to this task.`,
      `Task: ${task.title}`,
    ];
    if (task.description) parts.push(task.description);
    const links = (() => { try { return JSON.parse(task.links || '[]'); } catch { return []; } })();
    if (links.length > 0) parts.push(`\nAttached links:\n${links.map(l => `- ${l}`).join('\n')}`);
    const attachments = db.prepare('SELECT filename, local_path, url FROM attachments WHERE task_id = ? ORDER BY created_at ASC').all(args.task_id);
    if (attachments.length > 0) parts.push(`\nAttached files:\n${attachments.map(a => `- ${a.filename}: ${a.local_path || a.url}`).join('\n')}`);
    if (existingNotes.length > 0) {
      parts.push('\n--- Conversation ---');
      for (const n of existingNotes) parts.push(`[${n.author}]: ${n.body}`);
    }

    const id = uuidv4();
    db.prepare(`INSERT INTO agent_jobs (id, task_id, agent_path, prompt) VALUES (?, ?, ?, ?)`)
      .run(id, args.task_id, task.agent_path, parts.join('\n'));

    return { job_id: id, status: 'queued', agent_path: task.agent_path };
  },

  list_agent_jobs(args) {
    const db = openDb();
    const limit = args.limit ?? 20;
    const jobs = args.task_id
      ? db.prepare(`SELECT * FROM agent_jobs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`).all(args.task_id, limit)
      : db.prepare(`SELECT * FROM agent_jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
    return jobs;
  },

  get_agent_job(args) {
    const db = openDb();
    const job = db.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(args.job_id);
    if (!job) throw new Error(`Job not found: ${args.job_id}`);
    return job;
  },
};
