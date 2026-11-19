// Composes the prompt a fresh (non-resumed) agent job receives, within a byte budget.
//
// The prompt goes to the CLI as a single argv entry, and Linux caps one argument at
// MAX_ARG_STRLEN = 131,072 bytes. Task notes are unbounded and permanent, and they used to be
// replayed in full into every later dispatch, so a long-lived handle task eventually crossed that
// limit and died at launch with E2BIG (box report, first seen 2026-09-19: 134,881 bytes).
// Resumed sessions already send only the new turn (resumeMessageForJob in server/workers.js); this
// bounds the fresh-dispatch path the same way. The newest notes are kept, because they are the
// current state of the conversation. Older ones are replaced by a marker that tells the agent where
// to read them.

/** Budget for the whole composed prompt, in UTF-8 bytes. Leaves headroom under 131,072. */
export const AGENT_PROMPT_MAX_BYTES = 120 * 1024
/** Space always kept for the conversation when the description is huge. */
const MIN_CONVERSATION_BYTES = 16 * 1024
/** The OS per-argument limit (Linux MAX_ARG_STRLEN), less the terminating NUL. */
export const ARG_MAX_STRLEN = 128 * 1024 - 1

const bytes = text => Buffer.byteLength(text, 'utf8')

/** Truncate to at most maxBytes UTF-8 bytes without splitting a character. */
export function truncateUtf8(text, maxBytes, fromEnd = false) {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let start = fromEnd ? buf.length - maxBytes : 0
  let end = fromEnd ? buf.length : maxBytes
  // UTF-8 continuation bytes are 10xxxxxx; never start or end inside a character.
  if (fromEnd) { while (start < end && (buf[start] & 0xc0) === 0x80) start++ }
  else { while (end > start && (buf[end] & 0xc0) === 0x80) end-- }
  return buf.subarray(start, end).toString('utf8')
}

/**
 * @param {object} p
 * @param {string} p.taskId
 * @param {object} p.task         tasks row (title, description, agent_path)
 * @param {string[]} p.links
 * @param {{filename:string, local_path?:string, url?:string}[]} p.attachments
 * @param {{author:string, body:string}[]} p.notes   oldest first
 * @param {string|null} p.userMessage
 * @param {number} [p.maxBytes]
 * @returns {{ prompt: string, omittedNotes: number, truncatedDescription: boolean }}
 */
export function composeAgentPrompt({ taskId, task, links = [], attachments = [], notes = [], userMessage = null, maxBytes = AGENT_PROMPT_MAX_BYTES }) {
  const head = [
    `You are an agent running inside Qalatra. Task ID: ${taskId}`,
    `If you create any output files, save them to ${task.agent_path}/output/ and include their file paths in your response. Qalatra will auto-attach existing mentioned files back to this task.`,
    `Task: ${task.title}`,
  ]
  const extras = []
  if (links.length > 0) extras.push(`\nAttached links:\n${links.map(l => `- ${l}`).join('\n')}`)
  if (attachments.length > 0) extras.push(`\nAttached files:\n${attachments.map(a => `- ${a.filename}: ${a.local_path || a.url}`).join('\n')}`)
  const userLine = userMessage ? `[user]: ${userMessage}` : null

  // Everything except the description and the notes is fixed; the user's new turn must survive whole.
  const fixedBytes = bytes([...head, ...extras, ...(userLine ? [userLine] : [])].join('\n')) + 8
  let description = task.description || ''
  let truncatedDescription = false
  const descriptionBudget = maxBytes - fixedBytes - (notes.length > 0 ? MIN_CONVERSATION_BYTES : 0)
  if (description && bytes(description) > descriptionBudget) {
    const marker = `\n[… description truncated to fit the launch limit; read the full description with get_task (fields="description") for task ${taskId}]`
    description = truncateUtf8(description, Math.max(0, descriptionBudget - bytes(marker))) + marker
    truncatedDescription = true
  }

  const parts = [...head]
  if (description) parts.push(description)
  parts.push(...extras)

  let omittedNotes = 0
  if (notes.length > 0) {
    const used = bytes(parts.join('\n')) + (userLine ? bytes(userLine) + 1 : 0)
    const header = '\n--- Conversation ---'
    // Reserve room for the omission marker up front so adding it can never overflow.
    const markerReserve = 200
    let remaining = maxBytes - used - bytes(header) - 1 - markerReserve
    const kept = []
    for (let i = notes.length - 1; i >= 0; i--) {
      const line = `[${notes[i].author}]: ${notes[i].body}`
      const cost = bytes(line) + 1
      if (cost <= remaining) { kept.unshift(line); remaining -= cost; continue }
      // The newest note always appears, trimmed to its tail if it alone is too big.
      if (kept.length === 0 && remaining > 64) {
        kept.unshift(`[${notes[i].author}]: […] ${truncateUtf8(notes[i].body, remaining - bytes(`[${notes[i].author}]: […] `) - 1, true)}`)
        omittedNotes = i
      } else {
        omittedNotes = i + 1
      }
      break
    }
    parts.push(header)
    if (omittedNotes > 0) {
      parts.push(`[… ${omittedNotes} earlier note${omittedNotes === 1 ? '' : 's'} omitted to fit the launch limit; read them with get_task_notes for task ${taskId}]`)
    }
    parts.push(...kept)
  }
  if (userLine) parts.push(userLine)
  return { prompt: parts.join('\n'), omittedNotes, truncatedDescription }
}

/**
 * A prompt-mode argv entry over the OS per-argument limit fails at spawn with a bare E2BIG. Name the
 * cause instead. Only Linux enforces a per-argument cap; macOS limits the argv+env total.
 */
export function promptArgError(prompt, platform = process.platform) {
  if (platform !== 'linux' || typeof prompt !== 'string') return null
  const size = bytes(prompt)
  if (size <= ARG_MAX_STRLEN) return null
  return `Prompt is ${size.toLocaleString('en-US')} bytes, over the ${ARG_MAX_STRLEN.toLocaleString('en-US')}-byte per-argument limit, so the agent could not be started. Shorten the task description or the orchestrator's prompt.`
}
