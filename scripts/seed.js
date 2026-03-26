/**
 * Seed script — populates the DB with sample tasks for testing.
 * Run from ~/task-os: node scripts/seed.js
 */
import { openDb, today } from '../mcp/db.js';
import { v4 as uuidv4 } from 'uuid';

const db = openDb();

const tasks = [
  {
    id: uuidv4(), title: 'Review Monroe sprint tasks', context: 'monroe',
    project: 'Tech Estimates', my_priority: 1, energy_required: 'medium',
    status: 'active', source: 'asana',
    notes: 'Check what is in Incoming and triage with Valentin.',
  },
  {
    id: uuidv4(), title: 'Send Biz to Biz weekly update', context: 'biztobiz',
    my_priority: 2, energy_required: 'low', status: 'active', source: 'manual',
    due_date: today(),
  },
  {
    id: uuidv4(), title: 'Fix mobile menu bug on Sentiosonics', context: 'internal',
    project: 'Sentiosonics', my_priority: 3, energy_required: 'high', status: 'backlog',
    source: 'linear', notes: 'Menu collapses incorrectly on iOS Safari.',
  },
  {
    id: uuidv4(), title: 'Write album bio for All of Us', context: 'personal',
    project: 'Silvermouse', my_priority: 4, energy_required: 'high', status: 'backlog',
    notes: 'Needs to go to label by end of month.',
  },
  {
    id: uuidv4(), title: 'Review Muzebook login flow', context: 'internal',
    project: 'Muzebook', my_priority: 3, energy_required: 'medium', status: 'snoozed',
    surface_after: '2026-03-10',
    ai_context: '[2026-03-07] Snoozed until Edgar responds to design feedback.',
  },
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO tasks (id, title, notes, status, my_priority, energy_required,
    context, project, source, due_date, surface_after, ai_context, created_at, updated_at)
  VALUES (@id, @title, @notes, @status, @my_priority, @energy_required,
    @context, @project, @source, @due_date, @surface_after, @ai_context,
    datetime('now'), datetime('now'))
`);

const insertMany = db.transaction((rows) => {
  for (const row of rows) {
    insert.run({
      notes: null, due_date: null, surface_after: null, ai_context: null,
      project: null, source: 'manual',
      ...row,
    });
  }
});

insertMany(tasks);
console.log(`Seeded ${tasks.length} tasks.`);
