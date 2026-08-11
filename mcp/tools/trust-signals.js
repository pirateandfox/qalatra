import { withTimestampZones } from '../db.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVE_REVIEW_DAYS = 14;
const DEFAULT_BACKLOG_REVIEW_DAYS = 30;

function datePart(value) {
  if (!value) return null;
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function daysSince(value) {
  const date = datePart(value);
  if (!date) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const thenUtc = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(thenUtc)) return null;
  return Math.floor((todayUtc - thenUtc) / MS_PER_DAY);
}

function reviewSignal(row, daysOverride) {
  const eligible =
    (row.status === 'active' || row.status === 'backlog') &&
    row.task_type !== 'event' &&
    !row.recurrence;
  if (!eligible) return { stale: false, stale_days: null, review_threshold_days: null };

  const threshold = Number.isFinite(daysOverride)
    ? Number(daysOverride)
    : (row.status === 'backlog' ? DEFAULT_BACKLOG_REVIEW_DAYS : DEFAULT_ACTIVE_REVIEW_DAYS);
  const age = daysSince(row.last_reviewed_at ?? row.created_at);
  return {
    stale: age != null && age > threshold,
    stale_days: age,
    review_threshold_days: threshold,
  };
}

function dependencySummary(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    context: row.context,
    project: row.project,
    due_date: row.due_date,
    hard_deadline: row.hard_deadline === 1 || row.hard_deadline === true,
    completed: row.status === 'done',
    dependency_created_at: row.dependency_created_at ?? null,
  };
}

export function enrichTaskRows(db, rows, { daysOverride } = {}) {
  if (!rows.length) return rows;
  const ids = rows.map(row => row.id);
  const placeholders = ids.map(() => '?').join(',');

  const blockedByRows = db.prepare(`
    SELECT
      d.task_id AS relation_task_id,
      d.created_at AS dependency_created_at,
      b.id, b.title, b.status, b.context, b.project, b.due_date, b.hard_deadline
    FROM task_dependencies d
    JOIN tasks b ON b.id = d.blocked_by_task_id
    WHERE d.task_id IN (${placeholders})
    ORDER BY b.title COLLATE NOCASE
  `).all(...ids);

  const blocksRows = db.prepare(`
    SELECT
      d.blocked_by_task_id AS relation_task_id,
      d.created_at AS dependency_created_at,
      t.id, t.title, t.status, t.context, t.project, t.due_date, t.hard_deadline
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id
    WHERE d.blocked_by_task_id IN (${placeholders})
    ORDER BY t.title COLLATE NOCASE
  `).all(...ids);

  const blockedBy = {};
  for (const row of blockedByRows) {
    if (!blockedBy[row.relation_task_id]) blockedBy[row.relation_task_id] = [];
    blockedBy[row.relation_task_id].push(dependencySummary(row));
  }

  const blocks = {};
  for (const row of blocksRows) {
    if (!blocks[row.relation_task_id]) blocks[row.relation_task_id] = [];
    blocks[row.relation_task_id].push(dependencySummary(row));
  }

  // Mirror of attachTrustSignals in db-worker.js: the terminal chokepoint where task rows leave
  // the MCP process, so timestamps are stamped once rather than at every tool's own query.
  return rows.map(row => {
    const blocked_by = blockedBy[row.id] ?? [];
    return withTimestampZones({
      ...row,
      hard_deadline: row.hard_deadline === 1 || row.hard_deadline === true,
      ...reviewSignal(row, daysOverride),
      blocked: blocked_by.some(dep => !dep.completed),
      blocked_by,
      blocks: blocks[row.id] ?? [],
    }, 'tasks');
  });
}

export function getTaskDependencies(db, taskId) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!row) throw new Error(`Task not found: ${taskId}`);
  const enriched = enrichTaskRows(db, [row])[0];
  return {
    blocks: enriched.blocks,
    blocked_by: enriched.blocked_by,
  };
}

export function staleWhereClause(days) {
  if (Number.isFinite(days)) {
    return {
      sql: `date(COALESCE(last_reviewed_at, created_at)) < date('now', @cutoff)`,
      params: { cutoff: `-${Number(days)} days` },
    };
  }
  return {
    sql: `(
      (status = 'backlog' AND date(COALESCE(last_reviewed_at, created_at)) < date('now', '-${DEFAULT_BACKLOG_REVIEW_DAYS} days'))
      OR
      (status = 'active' AND date(COALESCE(last_reviewed_at, created_at)) < date('now', '-${DEFAULT_ACTIVE_REVIEW_DAYS} days'))
    )`,
    params: {},
  };
}
