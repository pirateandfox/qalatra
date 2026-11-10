// Cross-box thread sync (docs/agent-to-agent-threads.md, step 3) — the network half. The rows and
// every rule about them live in server/threads.js; this module only moves them between boxes.
//
// Pull only. Every box has its API on a Cloudflare tunnel, so there is no push path. Each box polls each
// peer in its thread_peers table for:
//   1. threads that peer hosts with this box as a participant, changed since a per-peer cursor;
//      each is applied as a local mirror (accepting the invitation the first time);
//   2. the messages of those threads since the mirror's highest seq;
//   3. and it posts this box's pending messages (the outbox) to their home box, which sequences them.
// The cursor only advances after a page's threads and messages are applied, so a crash or a
// network error re-fetches the page instead of skipping it. Every apply is idempotent.
//
// The peer's key leaves this process only as the Authorization header to that peer's own URL, and
// redirects are refused so it can never follow a 3xx to another host.

import { threadSettings } from './threads.js'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_THREAD_PAGES = 5
const MAX_MESSAGE_PAGES = 10
// HTTP statuses that mean "the home box will never accept this message", so retrying is pointless.
const PERMANENT_STATUSES = new Set([400, 403, 404, 409, 413, 422])

export class PeerRequestError extends Error {
  constructor(message, status = null) {
    super(message)
    this.status = status
  }
}

export async function peerRequest(peer, method, pathAndQuery, body, { fetchImpl = globalThis.fetch } = {}) {
  let res
  try {
    res = await fetchImpl(`${peer.url}/api/v1/threads/peer${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${peer.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new PeerRequestError(`${peer.name} unreachable: ${err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code ?? err.message)}`)
  }
  let json = null
  try { json = await res.json() } catch { /* non-JSON body: reported by status below */ }
  if (!res.ok) throw new PeerRequestError(`${peer.name} answered ${res.status}: ${String(json?.error ?? res.statusText ?? '').slice(0, 200)}`, res.status)
  return json ?? {}
}

async function pullMessages({ dbCall, peer, threadId, sinceSeq, fetchImpl }) {
  let since = sinceSeq
  let inserted = 0
  for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
    const res = await peerRequest(peer, 'GET', `/threads/${encodeURIComponent(threadId)}/messages?since_seq=${since}&limit=200`, undefined, { fetchImpl })
    const applied = await dbCall('applyPeerMessagesDb', { peer: { name: peer.name }, thread_id: threadId, messages: res.messages ?? [] })
    inserted += (applied.inserted ?? 0) + (applied.confirmed ?? 0)
    const next = Number.isInteger(res.next_since_seq) ? res.next_since_seq : since
    if (!res.has_more || next <= since) break
    since = next
  }
  return inserted
}

async function deliverOutbox({ dbCall, peer, fetchImpl, log }) {
  const due = (await dbCall('dueThreadDeliveriesDb', { limit: 50 }))
    .filter(d => String(d.home_peer ?? '').toLowerCase() === peer.name.toLowerCase())
  const touched = new Set()
  for (const d of due) {
    try {
      const res = await peerRequest(peer, 'POST', `/threads/${encodeURIComponent(d.thread_id)}/messages`, { body: d.body, idempotency_key: d.idempotency_key }, { fetchImpl })
      await dbCall('recordThreadDeliveryDb', d.delivery_id, { ok: true, seq: res.message?.seq ?? null })
      touched.add(d.thread_id)
    } catch (err) {
      const permanent = PERMANENT_STATUSES.has(err.status)
      await dbCall('recordThreadDeliveryDb', d.delivery_id, { ok: false, error: err.message, permanent })
      if (permanent) {
        log(`[threads] ${peer.name} refused message ${d.message_id} in ${d.thread_id}: ${err.message}`)
        touched.add(d.thread_id)
      } else {
        // The peer is down or slow; the rest of its outbox would fail the same way this tick.
        break
      }
    }
  }
  return touched
}

export async function syncThreadPeer({ dbCall, peer, primaryAgent, fetchImpl = globalThis.fetch, log = console.error }) {
  const touched = await deliverOutbox({ dbCall, peer, fetchImpl, log })
  let cursor = peer.threads_cursor ?? null
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const q = cursor ? `?since=${encodeURIComponent(cursor)}&limit=50` : '?limit=50'
    const res = await peerRequest(peer, 'GET', `/threads${q}`, undefined, { fetchImpl })
    for (const entry of res.threads ?? []) {
      const applied = await dbCall('applyPeerThreadDb', { peer: { name: peer.name, url: peer.url }, entry, primaryAgent })
      if (applied.skipped) {
        if (applied.skipped === 'id_conflict') log(`[threads] ${peer.name} sent thread ${applied.thread_id}, which already exists here as another box's thread; ignored`)
        continue
      }
      if (applied.needs_accept) {
        await peerRequest(peer, 'POST', `/threads/${encodeURIComponent(applied.thread_id)}/accept`, {}, { fetchImpl })
        // Re-apply so the local row shows 'joined' without waiting for the next tick.
        entry.participants = (entry.participants ?? []).map(p => (p.id === entry.you ? { ...p, state: 'joined' } : p))
        await dbCall('applyPeerThreadDb', { peer: { name: peer.name, url: peer.url }, entry, primaryAgent })
      }
      // Pull even when the counts match: accepting appends a 'joined' system message on the home box.
      const n = await pullMessages({ dbCall, peer, threadId: applied.thread_id, sinceSeq: applied.local_max_seq, fetchImpl })
      if (n || applied.created || applied.needs_accept) touched.add(applied.thread_id)
    }
    const next = res.next_cursor ?? cursor
    await dbCall('recordThreadPeerSyncDb', peer.name, { cursor: next })
    if (!res.has_more || next === cursor) break
    cursor = next
  }
  return [...touched]
}

// Each distinct failure is logged once until that peer next syncs cleanly.
const warnedPeerErrors = new Set()

// One pass over every configured peer. A peer that fails is recorded on its row (last_error) and
// does not stop the others.
export async function syncThreadPeers({ dbCall, loadSettings, fetchImpl = globalThis.fetch, log = console.error, notify = null }) {
  const cfg = threadSettings(loadSettings())
  if (!cfg.enabled) return { peers: 0, touched: [] }
  const peers = await dbCall('listThreadPeerSecretsDb')
  const touched = []
  for (const peer of peers) {
    try {
      const ids = await syncThreadPeer({ dbCall, peer, primaryAgent: cfg.primaryAgent, fetchImpl, log })
      touched.push(...ids)
      for (const key of warnedPeerErrors) if (key.startsWith(`${peer.name}:`)) warnedPeerErrors.delete(key)
    } catch (err) {
      await dbCall('recordThreadPeerSyncDb', peer.name, { error: err.message }).catch(() => {})
      if (!warnedPeerErrors.has(`${peer.name}:${err.message}`)) {
        warnedPeerErrors.add(`${peer.name}:${err.message}`)
        log(`[threads] sync with ${peer.name} failed: ${err.message}`)
      }
    }
  }
  for (const threadId of new Set(touched)) notify?.({ type: 'thread:message', threadId })
  return { peers: peers.length, touched: [...new Set(touched)] }
}

// Check one peer end to end: its URL answers and the key it issued this box is accepted there.
export async function testThreadPeer({ dbCall, name, fetchImpl = globalThis.fetch }) {
  const peer = (await dbCall('listThreadPeerSecretsDb')).find(p => p.name.toLowerCase() === String(name).toLowerCase())
  if (!peer) return { ok: false, error: `No peer named ${name}` }
  try {
    const hello = await peerRequest(peer, 'GET', '/hello', undefined, { fetchImpl })
    return { ok: true, peer: peer.name, their_name: hello.name ?? null, they_call_us: hello.you ?? null }
  } catch (err) {
    return { ok: false, peer: peer.name, status: err.status ?? null, error: err.message }
  }
}
