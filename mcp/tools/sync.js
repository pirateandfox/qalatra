import { v4 as uuidv4 } from 'uuid';
import { openDb, nowIso } from '../db.js';

export const toolDefs = [
  {
    name: 'queue_sync',
    description: 'Queue a sync action for a task to be pushed to an external system. Writes to sync_log with status pending.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        source:  { type: 'string', description: 'asana | notion | linear | github' },
        action:  { type: 'string', description: 'created | updated | completed | snoozed' },
        payload: { type: 'object', description: 'Optional JSON payload context' },
      },
      required: ['task_id', 'source', 'action'],
    },
  },
  {
    name: 'get_pending_syncs',
    description: 'Return all pending sync_log entries, joined with task data.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mark_sync_complete',
    description: 'Mark a sync_log entry as successfully synced.',
    inputSchema: {
      type: 'object',
      properties: {
        sync_log_id: { type: 'string' },
        response:    { type: 'string', description: 'JSON response from external system' },
      },
      required: ['sync_log_id'],
    },
  },
];

export const handlers = {
  queue_sync(args) {
    const db = openDb();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO sync_log (id, task_id, source, action, payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
    `).run(id, args.task_id, args.source, args.action, args.payload ? JSON.stringify(args.payload) : null);
    return { sync_log_id: id, status: 'pending' };
  },

  get_pending_syncs() {
    const db = openDb();
    return db.prepare(`
      SELECT s.*, t.title, t.context, t.source_url
      FROM sync_log s
      JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'pending'
      ORDER BY s.created_at ASC
    `).all();
  },

  mark_sync_complete(args) {
    const db = openDb();
    const row = db.prepare('SELECT * FROM sync_log WHERE id = ?').get(args.sync_log_id);
    if (!row) throw new Error(`sync_log entry not found: ${args.sync_log_id}`);

    db.prepare(`
      UPDATE sync_log SET status = 'success', attempted_at = ?, response = ? WHERE id = ?
    `).run(nowIso(), args.response ?? null, args.sync_log_id);

    return { sync_log_id: args.sync_log_id, status: 'success' };
  },
};
