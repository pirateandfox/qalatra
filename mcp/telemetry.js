function jsonLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return 0 }
}

export function resultItemCount(result) {
  if (Array.isArray(result)) return result.length
  if (!result || typeof result !== 'object') return null
  for (const key of ['tasks', 'jobs', 'notes', 'habits', 'heartbeats', 'capabilities', 'results']) {
    if (Array.isArray(result[key])) return result[key].length
  }
  return null
}

/** Privacy-safe operational telemetry: sizes and timing, never argument or result contents. */
export function logMcpMetric(event, data = {}, logger = console) {
  logger.log(JSON.stringify({ component: 'qalatra-mcp', event, at: new Date().toISOString(), ...data }))
}

export function toolCallMetric({ name, args, result, startedAt, ok, errorCode = null }) {
  return {
    tool: name,
    ok,
    duration_ms: Math.max(0, Date.now() - startedAt),
    argument_bytes: jsonLength(args ?? {}),
    result_bytes: jsonLength(result),
    item_count: resultItemCount(result),
    ...(errorCode ? { error_code: errorCode } : {}),
  }
}

export function toolListMetric(definitions) {
  return { tool_count: definitions.length, definition_bytes: jsonLength(definitions) }
}
