import { v4 as uuidv4 } from 'uuid';
import { openDb, withTimestampZones } from '../db.js';
import { selectFields, fieldsSchema } from '../field-select.js';

const AGENT_JOB_LIST_FIELDS = 'id,task_id,status,runtime,created_at,started_at,completed_at,terminated_by,mcp_tool_calls,usage';
const AGENT_JOB_DETAIL_FIELDS = 'id,task_id,status,runtime,result,session_id,created_at,started_at,completed_at,terminated_by,terminated_boundary,mcp_tool_calls,usage';

function withUsage(rows) {
  const convert = row => {
    if (!row) return row;
    const { usage_json, ...rest } = row;
    let usage = null;
    try { usage = usage_json ? JSON.parse(usage_json) : null; } catch {}
    return { ...rest, usage };
  };
  return Array.isArray(rows) ? rows.map(convert) : convert(rows);
}

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
    description: "List recent agent jobs. Status: queued|running|done|failed|orphaned|timed_out. orphaned and timed_out are infrastructure states, not failures; timed_out jobs may be resumed. runtime is claude|codex|raw.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Filter by task ID' },
        limit:   { type: 'integer', description: 'Default 20' },
        fields:  fieldsSchema('id,task_id,status,runtime,terminated_by,completed_at', AGENT_JOB_LIST_FIELDS),
      },
    },
  },
  {
    name: 'get_agent_job',
    description: "Get one agent job's status and result. orphaned and timed_out are infrastructure states, not failures; timed_out jobs may be resumed. Prompt is excluded by default.",
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        fields: fieldsSchema('id,status,result,terminated_by', AGENT_JOB_DETAIL_FIELDS),
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
      `If you create any output files, save them to ${task.agent_path}/output/ and include their file paths in your response. Qalatra will auto-attach existing mentioned files back to this task.`,
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
    return selectFields(withUsage(withTimestampZones(jobs, 'agent_jobs')), args.fields ?? AGENT_JOB_LIST_FIELDS);
  },

  get_agent_job(args) {
    const db = openDb();
    const job = db.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(args.job_id);
    if (!job) throw new Error(`Job not found: ${args.job_id}`);
    return selectFields(withUsage(withTimestampZones(job, 'agent_jobs')), args.fields ?? AGENT_JOB_DETAIL_FIELDS);
  },
};
