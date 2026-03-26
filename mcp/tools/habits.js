import { v4 as uuidv4 } from 'uuid';
import { openDb, nowIso } from '../db.js';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function offsetDate(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isHabitDueOn(habit, dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay();
  switch (habit.recurrence) {
    case 'daily':    return true;
    case 'weekdays': return dow >= 1 && dow <= 5;
    case 'weekly': {
      const created = new Date(habit.created_at.substring(0, 10) + 'T12:00:00Z');
      return d.getUTCDay() === created.getUTCDay();
    }
    case 'monthly': {
      const created = new Date(habit.created_at.substring(0, 10) + 'T12:00:00Z');
      return d.getUTCDate() === created.getUTCDate();
    }
    default: return true;
  }
}

export const toolDefs = [
  {
    name: 'list_habits',
    description: 'List all active habits with their completion status for a given date (defaults to today) and a 7-day history.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD (defaults to today)' },
      },
    },
  },
  {
    name: 'create_habit',
    description: 'Create a new habit.',
    inputSchema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Habit name' },
        description: { type: 'string', description: 'Purpose or notes prompt (e.g. "Note what you practiced")' },
        recurrence:  { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly'], description: 'How often the habit recurs' },
      },
      required: ['title'],
    },
  },
  {
    name: 'log_habit',
    description: 'Log a habit completion (or skip) for a date, optionally with session notes.',
    inputSchema: {
      type: 'object',
      properties: {
        habit_id: { type: 'string', description: 'Habit ID' },
        date:     { type: 'string', description: 'YYYY-MM-DD (defaults to today)' },
        status:   { type: 'string', enum: ['done', 'skipped'], description: 'Completion status' },
        notes:    { type: 'string', description: 'Session notes (what did you do, eat, practice, etc.)' },
      },
      required: ['habit_id'],
    },
  },
  {
    name: 'get_habit_history',
    description: 'Get completion history for one habit or all habits over the past N days. Returns logs with notes — use this for weekly AI analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        habit_id: { type: 'string', description: 'Habit ID (omit for all habits)' },
        days:     { type: 'number', description: 'Number of days to look back (default 7)' },
      },
    },
  },
  {
    name: 'update_habit',
    description: 'Update a habit title, description, recurrence, or archive it.',
    inputSchema: {
      type: 'object',
      properties: {
        id:          { type: 'string' },
        title:       { type: 'string' },
        description: { type: 'string' },
        recurrence:  { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly'] },
        active:      { type: 'boolean', description: 'Set false to archive' },
      },
      required: ['id'],
    },
  },
];

export const handlers = {
  list_habits({ date } = {}) {
    const db = openDb();
    const d = date ?? todayStr();
    const allHabits = db.prepare('SELECT * FROM habits WHERE active = 1 ORDER BY created_at ASC').all();
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(offsetDate(d, -i));
    const logs = db.prepare('SELECT * FROM habit_logs WHERE date >= ? AND date <= ?').all(days[0], d);
    const logMap = {};
    for (const l of logs) logMap[`${l.habit_id}:${l.date}`] = l;

    return allHabits
      .filter(h => isHabitDueOn(h, d))
      .map(h => ({
        id:          h.id,
        title:       h.title,
        description: h.description,
        recurrence:  h.recurrence,
        today_log:   logMap[`${h.id}:${d}`] ?? null,
        week: days.map(day => ({
          date: day,
          due:  isHabitDueOn(h, day),
          log:  logMap[`${h.id}:${day}`] ?? null,
        })),
      }));
  },

  create_habit({ title, description, recurrence } = {}) {
    if (!title) return { error: 'title required' };
    const db = openDb();
    const id = uuidv4();
    const now = nowIso();
    db.prepare('INSERT INTO habits (id, title, description, recurrence, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(id, title.trim(), description ?? null, recurrence ?? 'daily', now, now);
    return { id, title, recurrence: recurrence ?? 'daily' };
  },

  log_habit({ habit_id, date, status, notes } = {}) {
    if (!habit_id) return { error: 'habit_id required' };
    const db = openDb();
    const d = date ?? todayStr();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO habit_logs (id, habit_id, date, status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(habit_id, date) DO UPDATE SET status = excluded.status, notes = excluded.notes
    `).run(id, habit_id, d, status ?? 'done', notes ?? null, nowIso());
    return { ok: true, habit_id, date: d, status: status ?? 'done' };
  },

  get_habit_history({ habit_id, days } = {}) {
    const db = openDb();
    const n = days ?? 7;
    const since = offsetDate(todayStr(), -(n - 1));
    const habits = habit_id
      ? db.prepare('SELECT * FROM habits WHERE id = ?').all(habit_id)
      : db.prepare('SELECT * FROM habits WHERE active = 1').all();
    const logs = habit_id
      ? db.prepare('SELECT * FROM habit_logs WHERE habit_id = ? AND date >= ? ORDER BY date DESC').all(habit_id, since)
      : db.prepare('SELECT * FROM habit_logs WHERE date >= ? ORDER BY date DESC').all(since);

    // Build per-habit summary
    return habits.map(h => {
      const hLogs = logs.filter(l => l.habit_id === h.id);
      const done = hLogs.filter(l => l.status === 'done').length;
      // Count days the habit was due in this window
      let due = 0;
      for (let i = 0; i < n; i++) {
        if (isHabitDueOn(h, offsetDate(todayStr(), -(n - 1 - i)))) due++;
      }
      return {
        id:          h.id,
        title:       h.title,
        recurrence:  h.recurrence,
        days_due:    due,
        days_done:   done,
        days_skipped: hLogs.filter(l => l.status === 'skipped').length,
        completion_rate: due > 0 ? Math.round((done / due) * 100) + '%' : 'n/a',
        logs: hLogs.map(l => ({ date: l.date, status: l.status, notes: l.notes })),
      };
    });
  },

  update_habit({ id, title, description, recurrence, active } = {}) {
    if (!id) return { error: 'id required' };
    const db = openDb();
    const sets = ['updated_at = ?']; const params = [nowIso()];
    if (title !== undefined)       { sets.push('title = ?');       params.push(title); }
    if (description !== undefined) { sets.push('description = ?'); params.push(description); }
    if (recurrence !== undefined)  { sets.push('recurrence = ?');  params.push(recurrence); }
    if (active !== undefined)      { sets.push('active = ?');      params.push(active ? 1 : 0); }
    db.prepare(`UPDATE habits SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return { ok: true };
  },
};
