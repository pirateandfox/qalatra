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
  constructor(message) { super(message); this.name = 'BridgeUnavailableError' }
}
export class UnknownSessionError extends Error {
  constructor(message) { super(message); this.name = 'UnknownSessionError' }
}

function parseToolResult(res, name) {
  const text = (res?.content ?? []).filter(c => c?.type === 'text').map(c => c.text).join('\n')
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text ? { text } : {} }
  if (res?.isError) {
    const message = parsed?.error || parsed?.message || text || `${name} failed`
    // The daemon answers but its Chrome side is gone ("Chrome not connected — is the extension
    // loaded and a claude.ai tab open?"). That is the box's dependency being down, not this op
    // failing, and an orchestrator should hold further ops rather than mark sessions broken.
    if (/chrome not connected|extension|tab open|not connected/i.test(message)) throw new BridgeUnavailableError(message)
    if (/not found|unknown session|no such session|no session/i.test(message)) throw new UnknownSessionError(message)
    throw new Error(message)
  }
  return parsed
}

/** True when the last assistant turn reads as a question left for a human. Heuristic by design. */
export function turnEndsWithQuestion(text) {
  const lines = String(text ?? '').trim().split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return false
  const last = lines[lines.length - 1]
  return /\?\s*$/.test(last) || /\?\s*(\*|_|`)*\s*$/.test(last)
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
      return { injected: Boolean(r?.injected), verified: r?.verified === true, turnId: r?.turnId ?? null }
    },
    /** State plus what the last turn looked like, so "ended asking a question" is visible without an agent. */
    async state({ sessionId }) {
      if (!sessionId) throw new Error('sessionId required')
      return withClient(async c => {
        const s = await call(c, 'claude_session_get_state', { session_id: sessionId })
        let lastTurnAt = null, lastTurnEndsWithQuestion = false, lastTurnRole = null
        try {
          const t = await call(c, 'claude_session_get_transcript', { session_id: sessionId, last_n: 2 })
          const turns = turnsOf(t)
          const last = turns[turns.length - 1]
          if (last) {
            lastTurnAt = turnTime(last)
            lastTurnRole = last.role ?? null
            lastTurnEndsWithQuestion = (last.role ?? 'assistant') !== 'user' && turnEndsWithQuestion(turnText(last))
          }
        } catch { /* transcript is a bonus; state alone is still an answer */ }
        return {
          state: s?.state ?? 'unknown',
          workerStatus: s?.workerStatus ?? null,
          statusBucket: s?.statusBucket ?? null,
          prUrl: s?.prUrl ?? null,
          branch: s?.branchBar ?? s?.branch ?? null,
          lastTurnAt, lastTurnRole, lastTurnEndsWithQuestion,
        }
      })
    },
    async archive({ sessionId }) {
      if (!sessionId) throw new Error('sessionId required')
      const r = await withClient(c => call(c, 'claude_session_archive', { session_id: sessionId }))
      return { archived: r?.archived ?? r?.ok ?? true }
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
