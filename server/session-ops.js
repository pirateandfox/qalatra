// Code-shaped operations on cloud sessions through claude-bridge.
//
// claude-bridge is a Chrome window on this box, logged into this box's account, exposing MCP over
// HTTP on localhost. Its tools — inject a prompt, read state, read the transcript, archive, click
// "Create PR" — need no model on the calling side; today an agent is only the thing that *decides*
// to call them. This module lets Qalatra Server make those calls directly, so an orchestrator can
// ask for one with zero tokens spent (see server/integrations/flightdesk SESSION_OP, D28).
//
// Generic on purpose: nothing here knows who asked. Only the box that owns the Chrome window can
// reach the bridge, which is why these calls belong in Qalatra Server and never in an external
// system.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:7878/mcp'
export const SESSION_OPS = ['inject', 'state', 'archive', 'create_pr']

export class BridgeUnavailableError extends Error {
  constructor(message, { code = null, details = null } = {}) { super(message); this.name = 'BridgeUnavailableError'; this.code = code; this.details = details }
}
export class UnknownSessionError extends Error {
  constructor(message, { code = null, details = null } = {}) { super(message); this.name = 'UnknownSessionError'; this.code = code; this.details = details }
}

// Claude Bridge 0.1.19 classifies its own failures: `Error: [CODE] message`, then optionally
// `\n\nDetails: {json}` with what the sessions API answered and what the page showed. Routing on
// the code is the point — the prose (and especially the Details, which quote page text) is what
// made a pop-up or a crashed tab look like a missing session.
const GONE_CODES = new Set(['SESSION_NOT_FOUND', 'INVALID_SESSION_ID'])
// PAGE_UNREADABLE reasons that are about the tab, not this session — the ones the bridge itself
// tries to recover by opening/reloading the tab or pressing Escape. row_not_rendered,
// off_code_page and a failed API lookup stay per-op errors.
const PAGE_DOWN_REASONS = new Set(['no_tab', 'tab_crashed', 'content_unreachable', 'error_screen', 'sidebar_empty', 'dialog_open'])

/** Split a bridge error text into { code, message, details }. Uncoded (pre-0.1.19) text gives code null. */
export function parseBridgeError(text) {
  const raw = String(text ?? '')
  const at = raw.search(/\n\s*Details:\s*/)
  let head = raw, details = null
  if (at !== -1) {
    head = raw.slice(0, at)
    try { details = JSON.parse(raw.slice(at).replace(/^\s*Details:\s*/, '')) } catch { details = null }
  }
  const m = head.match(/^Error: \[([A-Z_]+)\]\s*/)
  const message = (m ? head.slice(m[0].length) : head.replace(/^Error:\s*/, '')).trim()
  return { code: m ? m[1] : null, message, details: details && typeof details === 'object' ? details : null }
}

/**
 * The bridge's PAGE_UNREADABLE prose quotes the page — a pop-up's label or text, an error screen's
 * body — in double quotes (describePage). Withhold every quoted run, and any scraped string the
 * details name, so an error message can be forwarded without carrying page content.
 */
export function redactPageText(message, details = null) {
  let out = String(message ?? '')
  const page = details?.page ?? null
  const scraped = [page?.bodyText, ...(Array.isArray(page?.dialogs) ? page.dialogs.flatMap(d => [d?.label, d?.text]) : [])]
    .filter(s => typeof s === 'string' && s.trim().length >= 4)
  for (const s of scraped) out = out.split(s).join('[page text withheld]')
  return out.replace(/"[^"\n]*"/g, '"[page text withheld]"')
}

/** The error to throw for a parsed bridge failure. Exported for tests. */
export function classifyBridgeError({ code, message: rawMessage, details }) {
  const meta = { code, details }
  const message = redactPageText(rawMessage, details)
  if (code) {
    if (GONE_CODES.has(code)) return new UnknownSessionError(message, meta)
    if (code === 'NOT_AUTHENTICATED') return new BridgeUnavailableError(message, meta)
    if (code === 'PAGE_UNREADABLE') {
      // details.recovery: the bridge already tried to fix the page and it is still failing.
      const reason = details?.reason ?? details?.page?.reason ?? null
      if (details?.recovery || PAGE_DOWN_REASONS.has(reason)) return new BridgeUnavailableError(message, meta)
    }
    // TIMEOUT, SESSION_ARCHIVED, the rest of PAGE_UNREADABLE, any code added later: this op failed;
    // nothing says the session is gone or the box is down.
    return Object.assign(new Error(message), meta)
  }
  // Uncoded: an older bridge, or the daemon's own errors ("Chrome not connected — is the extension
  // loaded and a claude.ai tab open?"). Matched on the message only — never on Details — and
  // without a bare "not found", which is how "Create PR button not found" read as a missing session.
  if (/chrome not connected|chrome disconnected|is the extension loaded|tab open|not connected/i.test(message)) return new BridgeUnavailableError(message, meta)
  if (/unknown session|no such session|no session\b|session not found/i.test(message)) return new UnknownSessionError(message, meta)
  return Object.assign(new Error(message), meta)
}

function parseToolResult(res, name) {
  const text = (res?.content ?? []).filter(c => c?.type === 'text').map(c => c.text).join('\n')
  if (res?.isError) {
    let json = null
    try { json = JSON.parse(text) } catch {}
    const jsonMessage = json && typeof json === 'object' ? (json.error || json.message) : null
    throw classifyBridgeError(jsonMessage ? { code: json.code ?? null, message: String(jsonMessage), details: json.details ?? null }
      : text ? parseBridgeError(text)
      : { code: null, message: `${name} failed`, details: null })
  }
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text ? { text } : {} }
  return parsed
}

/**
 * The parts of get_state's `pageIssue` that may leave this box. The bridge's page diagnostics quote
 * the page (bodyText, dialog labels and text); none of that is passed on.
 */
export function safePageIssue(issue) {
  if (!issue || typeof issue !== 'object') return null
  return {
    reason: typeof issue.reason === 'string' ? issue.reason.slice(0, 40) : null,
    errorScreen: issue.errorScreen === true,
    dialogs: Array.isArray(issue.dialogs) ? issue.dialogs.length : 0,
    sidebarRows: Number.isFinite(issue.sidebarRows) ? issue.sidebarRows : null,
    composer: typeof issue.composer === 'boolean' ? issue.composer : null,
  }
}
/** `recovered` / `recovery` is { action, reason, outcome } — bridge enums, copied field by field anyway. */
export function safeRecovery(r) {
  if (!r || typeof r !== 'object') return null
  const pick = v => (typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : null)
  return { action: pick(r.action), reason: pick(r.reason), outcome: pick(r.outcome) }
}

/**
 * True when the last assistant turn reads as something left for a human to do or answer.
 * Heuristic by design. A bare `?` is not enough: the most common ask from a cloud session is an
 * imperative — "I need the migration run and pushed before I can continue." — and treating only
 * question marks as asks would leave exactly that case to the age ceiling, which surfaces but
 * never re-dispatches. So the closing paragraph is checked for request phrasing as well.
 */
const REQUEST_PHRASES = /\b(please|i need|i'?ll need|can you|could you|would you|let me know|waiting (for|on)|blocked (on|by|until)|once you('ve| have)|when you('ve| have)|before i can (continue|proceed)|run (the|a) migration|needs? (to be )?(run|applied|pushed|merged)|requires? (a |the )?(human|manual))\b/i
export function turnEndsWithQuestion(text) {
  const body = String(text ?? '').trim()
  if (!body) return false
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1]
  if (/\?\s*(\*|_|`)*\s*$/.test(last)) return true
  // The closing paragraph: everything after the last blank line, capped so a long final
  // summary does not match on an incidental "please" three screens up.
  const paragraphs = body.split(/\n\s*\n/)
  const closing = paragraphs[paragraphs.length - 1].slice(-600)
  return REQUEST_PHRASES.test(closing)
}

function turnsOf(transcript) {
  if (Array.isArray(transcript)) return transcript
  if (Array.isArray(transcript?.turns)) return transcript.turns
  if (Array.isArray(transcript?.messages)) return transcript.messages
  return []
}
function turnText(turn) {
  if (typeof turn?.text === 'string') return turn.text
  if (typeof turn?.content === 'string') return turn.content
  if (Array.isArray(turn?.content)) return turn.content.map(c => c?.text ?? '').join('\n')
  return ''
}
function turnTime(turn) { return turn?.timestamp ?? turn?.ts ?? turn?.createdAt ?? turn?.created_at ?? null }

export function createSessionOps({ bridgeUrl = process.env.CLAUDE_BRIDGE_URL || DEFAULT_BRIDGE_URL, timeoutMs = 90_000, connectImpl = null } = {}) {
  // One short-lived connection per operation: the bridge is local and operations are rare, and a
  // dropped long-lived session would otherwise turn every later op into a confusing failure.
  async function withClient(fn) {
    if (connectImpl) return fn(await connectImpl())
    const client = new Client({ name: 'qalatra-session-ops', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(bridgeUrl))
    try { await client.connect(transport) }
    catch (err) { throw new BridgeUnavailableError(`claude-bridge unreachable at ${bridgeUrl}: ${err.message}`) }
    try { return await fn(client) }
    finally { await client.close().catch(() => {}) }
  }
  async function call(client, name, args) {
    let res
    try { res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }) }
    catch (err) {
      if (/ECONNREFUSED|ECONNRESET|fetch failed|timed out|timeout/i.test(err.message)) throw new BridgeUnavailableError(err.message)
      throw err
    }
    return parseToolResult(res, name)
  }

  return {
    bridgeUrl,
    /** Deliver a prompt. `verified` is the bridge's own proof it landed as a new turn in *that* session. */
    async inject({ sessionId, prompt }) {
      if (!sessionId) throw new Error('sessionId required')
      if (!String(prompt ?? '').trim()) throw new Error('prompt required')
      const r = await withClient(c => call(c, 'claude_session_inject', { session_id: sessionId, prompt }))
      return { injected: Boolean(r?.injected), verified: r?.verified === true, turnId: r?.turnId ?? null, recovered: safeRecovery(r?.recovered) }
    },
    /** State plus what the last turn looked like, so "ended asking a question" is visible without an agent. */
    async state({ sessionId }) {
      if (!sessionId) throw new Error('sessionId required')
      return withClient(async c => {
        const s = await call(c, 'claude_session_get_state', { session_id: sessionId })
        const needsHuman = s?.needsHuman === true || s?.state === 'awaiting_approval' || s?.workerStatus === 'requires_action' || Boolean(s?.approval)
        let lastTurnAt = null, lastTurnEndsWithQuestion = false, lastTurnRole = null, lastTurnAsk = false
        try {
          const t = needsHuman ? [] : await call(c, 'claude_session_get_transcript', { session_id: sessionId, last_n: 2 })
          const turns = turnsOf(t)
          const last = turns[turns.length - 1]
          if (last) {
            lastTurnAt = turnTime(last)
            lastTurnRole = last.role ?? null
            lastTurnAsk = turnEndsWithQuestion(turnText(last))
            lastTurnEndsWithQuestion = (last.role ?? 'assistant') !== 'user' && lastTurnAsk
          }
        } catch { /* transcript is a bonus; state alone is still an answer */ }
        const state = needsHuman ? 'awaiting_approval' : (s?.state ?? 'unknown')
        // "unknown" must be treated as busy, never idle (bridge contract). Idle = the session is
        // not running, the worker reports idle, and the last word was the assistant's — i.e. it
        // stopped and is waiting on someone, whatever it said.
        const sessionIdle = state === 'ready' && (s?.workerStatus == null || /idle/i.test(String(s.workerStatus))) && lastTurnRole !== 'user'
        return {
          state,
          workerStatus: s?.workerStatus ?? null,
          needsHuman,
          approval: s?.approval ?? null,
          // Claude Bridge 0.1.18: every resolved card page, including answers clicked in Claude.
          // Passed through verbatim; FlightDesk dedupes on (approvalId, questionIndex, seq), so no
          // resolved_since cursor is sent. resolvedApprovalsError is deliberately not forwarded.
          resolvedApprovals: s?.resolvedApprovals ?? null,
          resolvedApprovalsCursor: s?.resolvedApprovalsCursor ?? null,
          resolvedApprovalsTruncated: s?.resolvedApprovalsTruncated ?? null,
          statusBucket: s?.statusBucket ?? null,
          // With a pageIssue the page could not be scraped, so a null prUrl/branch means "not
          // read", not "no PR". The state itself then comes from the sessions API.
          prUrl: s?.prUrl ?? null,
          branch: s?.branchBar ?? s?.branch ?? null,
          pageIssue: safePageIssue(s?.pageIssue),
          recovered: safeRecovery(s?.recovered),
          sessionIdle,
          lastTurnAt, lastTurnRole,
          // A stopped session whose last turn asks for something — question mark or not.
          lastTurnEndsWithQuestion: lastTurnEndsWithQuestion || (sessionIdle && lastTurnRole === 'assistant' && lastTurnAsk),
        }
      })
    },
    async archive({ sessionId }) {
      if (!sessionId) throw new Error('sessionId required')
      let r
      try { r = await withClient(c => call(c, 'claude_session_archive', { session_id: sessionId })) }
      catch (err) {
        // Archiving a session that is already archived is the goal, not a failure.
        if (err.code === 'SESSION_ARCHIVED') return { archived: true, alreadyArchived: true, recovered: null }
        throw err
      }
      return { archived: r?.archived ?? r?.ok ?? true, recovered: safeRecovery(r?.recovered) }
    },
    async createPr({ sessionId }) {
      if (!sessionId) throw new Error('sessionId required')
      const r = await withClient(c => call(c, 'claude_session_create_pr', { session_id: sessionId }))
      return { clicked: r?.clicked ?? r?.ok ?? true, prUrl: r?.prUrl ?? null }
    },
    /** warmed: 0 with reads still answering is the "tab is dead" signature (2026-08-25 incident). */
    async warm() {
      const r = await withClient(c => call(c, 'claude_sessions_warm', {}))
      return { warmed: Number(r?.warmed ?? 0) }
    },
  }
}
