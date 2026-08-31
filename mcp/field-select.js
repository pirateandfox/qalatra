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

/** Accepts "a,b" or ["a","b"]; returns null when no projection was requested. */
export function normalizeFields(fields) {
  if (fields == null) return null;
  const list = Array.isArray(fields) ? fields : String(fields).split(',');
  const cleaned = list.map(field => String(field).trim()).filter(Boolean);
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
export function fieldsSchema(example) {
  return {
    type: 'string',
    description:
      `Comma-separated columns to return, e.g. "${example}". Omit for every column. ` +
      'Use this for routine/bulk reads: description and ai_context are unbounded freeform text, and ' +
      'a response over the output cap fails outright rather than truncating. id is always included. ' +
      'An unknown name errors and lists the valid ones.',
  };
}
