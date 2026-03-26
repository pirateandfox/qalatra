import { openDb, today } from '../db.js';

export const toolDefs = [
  {
    name: 'get_daily_note',
    description: 'Get the daily note for a specific date.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD (defaults to today)' },
      },
    },
  },
  {
    name: 'update_daily_note',
    description: 'Write or update the daily note for a date. Replaces the full content.',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        date:    { type: 'string',  description: 'YYYY-MM-DD (defaults to today)' },
        content: { type: 'string',  description: 'Markdown content for the note' },
      },
    },
  },
  {
    name: 'get_week_notes',
    description: 'Get daily notes for the 7 days ending on a given date. Useful for weekly review.',
    inputSchema: {
      type: 'object',
      properties: {
        end_date: { type: 'string', description: 'YYYY-MM-DD (defaults to today)' },
      },
    },
  },
];

export const handlers = {
  get_daily_note(args) {
    const date = args.date ?? today();
    const db = openDb();
    const row = db.prepare('SELECT * FROM daily_notes WHERE date = ?').get(date);
    return { date, content: row?.content ?? '' };
  },

  update_daily_note(args) {
    const date = args.date ?? today();
    const db = openDb();
    db.prepare(`
      INSERT INTO daily_notes (date, content, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(date) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
    `).run(date, args.content ?? '');
    return { ok: true, date };
  },

  get_week_notes(args) {
    const end = args.end_date ?? today();
    const db = openDb();
    // Get the 7 days ending on end_date
    const rows = db.prepare(`
      SELECT date, content FROM daily_notes
      WHERE date <= ? AND date >= date(?, '-6 days')
      ORDER BY date DESC
    `).all(end, end);
    return { notes: rows };
  },
};
