/**
 * Field projection for MCP read tools.
 *
 * Every read that matches a task returns that task's full `description` and `ai_context`. Both are
 * freeform, `ai_context` is append-only by design, so their size grows without bound and has nothing
 * to do with the query being asked. Past the MCP output cap the call *fails* rather than truncating,
 * so a status read that costs nothing 99 times fails the 100th because of an unrelated task's
 * history — observed at 55,658 and 56,237 characters for a single matched task, on a caller that
 * wanted about ten scalar fields.
 *
 * `fields` lets a caller ask for the columns it needs and skip the freeform bodies entirely. The
 * full body remains available from `get_task` / `get_agent_job` without a projection.
 */

/** True when the caller wrote `*` (alone or in a list): the complete record, bodies included. */
export function wantsEverything(fields) {
  if (fields == null) return false;
  const list = Array.isArray(fields) ? fields : String(fields).split(',');
  return list.some(field => String(field).trim() === '*');
}

/** Accepts "a,b" or ["a","b"]; `*` explicitly requests the complete record. */
export function normalizeFields(fields) {
  if (fields == null) return null;
  const list = Array.isArray(fields) ? fields : String(fields).split(',');
  const cleaned = list.map(field => String(field).trim()).filter(Boolean);
  if (cleaned.includes('*')) return null;
  return cleaned.length ? cleaned : null;
}

/**
 * Project `rows` (an array, or a single row object) down to `fields`.
 *
 * `always` is kept even when not requested — a row with no identifier is not useful to act on, and
 * a caller asking for `title` alone would otherwise get results it cannot then address.
 *
 * An unrecognised field throws rather than being dropped. Silently ignoring a typo would hand back
 * results that look complete while missing the column the caller was counting on, which is a worse
 * failure than a loud one naming the valid columns.
 */
export function selectFields(rows, fields, { always = ['id'] } = {}) {
  const requested = normalizeFields(fields);
  if (!requested) return rows;

  const single = !Array.isArray(rows);
  const list = single ? (rows ? [rows] : []) : rows;
  if (!list.length) return rows;

  const available = Object.keys(list[0]);
  const unknown = requested.filter(field => !available.includes(field));
  if (unknown.length) {
    throw new Error(
      `Unknown field(s): ${unknown.join(', ')}. Available fields: ${available.join(', ')}`
    );
  }

  const keep = [...new Set([...always.filter(field => available.includes(field)), ...requested])];
  const projected = list.map(row => Object.fromEntries(keep.map(key => [key, row[key]])));
  return single ? projected[0] : projected;
}

/** Shared schema entry so every tool documents the option identically. */
export function fieldsSchema(example, defaultFields = null) {
  const defaultDescription = defaultFields
    ? 'Defaults to compact fields; "*" returns the complete record. '
    : 'Omit for the complete record. ';
  return {
    type: 'string',
    description:
      `Comma-separated columns to return, e.g. "${example}". ${defaultDescription}` +
      'id is always included; unknown names error.',
  };
}

/**
 * Drop `bodies` from a single row unless `fields` names them (or is `*`), reporting the size of
 * each omitted body under `omitted` so the caller knows there is something to fetch and how big it
 * is. A detail read that only needs status and ids should not pay for a plan, and a caller that
 * does need the plan can ask for exactly that column.
 */
export function withoutBodies(row, fields, bodies) {
  if (!row) return row;
  if (wantsEverything(fields)) return row;
  const requested = normalizeFields(fields);
  if (requested) return selectFields(row, requested);
  const omitted = {};
  const kept = {};
  for (const [key, value] of Object.entries(row)) {
    if (bodies.includes(key)) {
      const length = value == null ? 0 : String(value).length;
      if (length > 0) omitted[key] = length;
    } else {
      kept[key] = value;
    }
  }
  return Object.keys(omitted).length ? { ...kept, omitted } : kept;
}

/**
 * Keep the last `maxChars` of `text`, replacing what was cut with a visible marker in the same
 * shape `appendAiContext` uses. The tail is what a status check wants — the agent's final summary
 * and any error sit at the end — and the marker tells the caller the full body exists.
 */
export function tailText(text, maxChars) {
  if (text == null) return text;
  const value = String(text);
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) return value;
  const tail = value.slice(value.length - maxChars);
  return `[…] ${value.length - maxChars} earlier characters trimmed\n${tail}`;
}
