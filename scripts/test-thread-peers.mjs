// Agent-to-agent threads, step 3 (cross-box): two boxes, each with its own SQLite database, wired
// through the real peer-facing route handler (server/v1.js handleThreadPeer) and the real sync
// module (server/thread-peers.js). The network is a fake fetch that authenticates keys the way
// server/index.js does: a key maps to the peer name it was issued to, or the request gets 401.
//
// The scenario is the design note's worked example (§8): Drift hosts a thread, Shi answers.
//
// Run: node scripts/test-thread-peers.mjs   (needs better-sqlite3 built for the running Node)

import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import * as T from '../server/threads.js'
import { handleThreadPeer } from '../server/v1.js'
import { syncThreadPeers, testThreadPeer } from '../server/thread-peers.js'

function freshDb(agents, jobs) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, project TEXT, context TEXT NOT NULL DEFAULT 'personal');
    CREATE TABLE notes (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'user', agent_job_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE agent_jobs (id TEXT PRIMARY KEY, agent_path TEXT NOT NULL, status TEXT NOT NULL, external_ref TEXT, external_meta TEXT);
    CREATE TABLE agents (path TEXT PRIMARY KEY, name TEXT NOT NULL);
  `)
  T.ensureThreadSchema(db)
  T.ensureThreadSchema(db) // idempotent, including the step-3 ALTERs
  for (const [p, n] of agents) db.prepare('INSERT INTO agents VALUES (?, ?)').run(p, n)
  for (const [id, p] of jobs) db.prepare(`INSERT INTO agent_jobs (id, agent_path, status) VALUES (?, ?, 'running')`).run(id, p)
  return db
}

// The db-worker method surface the routes and the sync use, bound to one box's database.
function dbCallFor(db) {
  const methods = {
    listThreadPeerSecretsDb: () => T.listThreadPeerSecrets(db),
    recordThreadPeerSyncDb: (name, a) => T.recordThreadPeerSync(db, name, a ?? {}),
    peerListThreadsDb: (n, o) => T.peerListThreads(db, n, o ?? {}),
    peerReadMessagesDb: (n, id, o) => T.peerReadMessages(db, n, id, o ?? {}),
    peerPostMessageDb: (n, id, a) => T.peerPostMessage(db, n, id, a ?? {}),
    peerAcceptThreadDb: (n, id) => T.peerAcceptThread(db, n, id),
    applyPeerThreadDb: a => T.applyPeerThread(db, a ?? {}),
    applyPeerMessagesDb: a => T.applyPeerMessages(db, a ?? {}),
    dueThreadDeliveriesDb: o => T.dueThreadDeliveries(db, o ?? {}),
    recordThreadDeliveryDb: (id, a) => T.recordThreadDelivery(db, id, a ?? {}),
  }
  return async (method, ...args) => {
    const fn = methods[method]
    if (!fn) throw new Error(`test dbCall: no ${method}`)
    return structuredClone(fn(...args)) // the worker boundary copies, so the test does too
  }
}

function makeBox({ name, url, agents, jobs, primaryAgent }) {
  const db = freshDb(agents, jobs)
  const box = {
    name, url, db, down: false,
    keys: new Map(), // inbound key -> peer name it was issued to
    settings: { threads: { instanceName: name, primaryAgent } },
  }
  box.ctx = { dbCall: dbCallFor(db), loadSettings: () => box.settings, notify: () => {} }
  return box
}

const boxes = new Map()
const requests = []
async function fakeFetch(href, init = {}) {
  const u = new URL(href)
  const box = boxes.get(u.origin)
  assert.equal(init.redirect, 'error', 'a peer request must refuse redirects, so the key never follows a 3xx')
  if (!box || box.down) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
  requests.push({ to: box.name, method: init.method, path: u.pathname })
  const auth = init.headers?.Authorization ?? ''
  const peerName = box.keys.get(auth.replace(/^Bearer /, ''))
  const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  if (!peerName) return respond(401, { error: 'Unauthorized' })
  try {
    const res = await handleThreadPeer({ method: init.method }, u, box.ctx, peerName, { parseBody: async () => JSON.parse(init.body || '{}') })
    return res ? respond(res.status, res.body) : respond(404, { error: 'Not found' })
  } catch (err) {
    return respond(err.status ?? 500, { error: err.message })
  }
}

// One key per direction: each box issues its peer a key, and the peer stores it.
function pair(a, b) {
  const aIssuesB = `key-${a.name}-issued-to-${b.name}`
  const bIssuesA = `key-${b.name}-issued-to-${a.name}`
  a.keys.set(aIssuesB, b.name)
  b.keys.set(bIssuesA, a.name)
  T.upsertThreadPeer(b.db, { name: a.name, url: a.url, token: aIssuesB })
  T.upsertThreadPeer(a.db, { name: b.name, url: b.url, token: bIssuesA })
}

const logs = []
const log = m => logs.push(m)
const sync = box => syncThreadPeers({ dbCall: box.ctx.dbCall, loadSettings: box.ctx.loadSettings, fetchImpl: fakeFetch, log })
const throwsStatus = (fn, status, re) => assert.throws(fn, e => e.status === status && (!re || re.test(e.message)), `expected ${status}${re ? ` ${re}` : ''}`)

const drift = makeBox({ name: 'Drift', url: 'https://api-drift.test', agents: [['/agents/drift', 'drift']], jobs: [['job-drift', '/agents/drift']], primaryAgent: '/agents/drift' })
const shi = makeBox({ name: 'Shi', url: 'https://api-shi.test', agents: [['/agents/shi', 'shi'], ['/agents/other', 'other']], jobs: [['job-shi', '/agents/shi'], ['job-other', '/agents/other']], primaryAgent: '/agents/shi' })
const wisp = makeBox({ name: 'Wisp', url: 'https://api-wisp.test', agents: [['/agents/wisp', 'wisp']], jobs: [], primaryAgent: '/agents/wisp' })
for (const b of [drift, shi, wisp]) boxes.set(b.url, b)
drift.db.prepare(`INSERT INTO tasks (id, title, project, context) VALUES ('tsk_moceanic', 'Moceanic retainer', 'moceanic', 'pirateandfox')`).run()
pair(drift, shi)
pair(drift, wisp)

const driftJob = T.resolveThreadCaller(drift.db, 'job-drift')
const shiJob = T.resolveThreadCaller(shi.db, 'job-shi')

// ── Peer registry: write-only keys ───────────────────────────────────────────
{
  const listed = T.listThreadPeers(shi.db)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'Drift')
  assert.equal(listed[0].has_token, true)
  assert.ok(!('token' in listed[0]), 'a peer listing never carries the key')
  assert.ok(!JSON.stringify(listed).includes('key-Drift'), 'nor anything that looks like it')
  throwsStatus(() => T.upsertThreadPeer(shi.db, { name: '../etc', url: 'https://x.test', token: 'k' }), 400, /Peer name/)
  throwsStatus(() => T.upsertThreadPeer(shi.db, { name: 'Box', url: 'ftp://x.test', token: 'k' }), 400, /http/)
  throwsStatus(() => T.upsertThreadPeer(shi.db, { name: 'Box', url: 'https://user:pw@x.test', token: 'k' }), 400, /credentials/)
  throwsStatus(() => T.upsertThreadPeer(shi.db, { name: 'Box', url: 'https://x.test' }), 400, /token is required/)
  // Updating the URL without a token keeps the stored key.
  T.upsertThreadPeer(shi.db, { name: 'drift', url: 'https://api-drift.test/' })
  assert.equal(T.listThreadPeerSecrets(shi.db)[0].token, 'key-Drift-issued-to-Shi')
  assert.equal(T.listThreadPeerSecrets(shi.db)[0].url, 'https://api-drift.test', 'trailing slash normalized')
  const t = await testThreadPeer({ dbCall: shi.ctx.dbCall, name: 'Drift', fetchImpl: fakeFetch })
  assert.deepEqual([t.ok, t.their_name, t.they_call_us], [true, 'Drift', 'Shi'])
}

// ── 1. Drift opens the thread; Shi is invited ───────────────────────────────
const opened = T.openThread(drift.db, {
  subject: 'Moceanic — invoice in advance or arrears?',
  task_id: 'tsk_moceanic',
  participants: [{ kind: 'instance', name: 'shi' }, { kind: 'human', name: 'Justin' }],
  caller: driftJob,
  settings: drift.settings,
})
const tid = opened.thread.id
{
  const byName = Object.fromEntries(opened.participants.map(p => [p.display_name, p]))
  assert.equal(byName.Drift.role, 'owner', 'the primary agent carries the box name')
  assert.equal(byName.Shi.kind, 'instance')
  assert.equal(byName.Shi.state, 'invited')
  assert.equal(byName.Shi.instance_name, 'Shi', 'the peer row is named as Drift stores it')
  assert.equal(byName.Shi.agent_path, null)
  throwsStatus(() => T.openThread(drift.db, { subject: 'x', participants: [{ kind: 'instance', name: 'Huli' }, { kind: 'human' }], caller: driftJob, settings: drift.settings }), 400, /No thread peer named "Huli"/)
}
// ── 2. Drift posts ───────────────────────────────────────────────────────────
T.postThreadMessage(drift.db, tid, { caller: driftJob, body: "Moceanic's retainer renews on the 1st. Invoice in advance or arrears? Our last three invoices went out in arrears and the client queried it." })

// ── 3. Shi syncs: mirror created, invitation accepted, messages pulled ──────
{
  const r = await sync(shi)
  assert.deepEqual(r.touched, [tid])
  const mirror = shi.db.prepare('SELECT * FROM threads WHERE id = ?').get(tid)
  assert.equal(mirror.home_peer, 'Drift')
  assert.equal(mirror.home_url, 'https://api-drift.test')
  assert.equal(mirror.task_id, null, "the task lives on Drift's box")
  const mine = shi.db.prepare(`SELECT * FROM thread_participants WHERE thread_id = ? AND display_name = 'Shi'`).get(tid)
  assert.equal(mine.agent_path, '/agents/shi', "bound from Shi's own threads.primaryAgent, not from the payload")
  assert.equal(mine.state, 'joined')
  assert.equal(mine.instance_name, null, 'this box')
  const driftRow = shi.db.prepare(`SELECT * FROM thread_participants WHERE thread_id = ? AND display_name = 'Drift'`).get(tid)
  assert.equal(driftRow.agent_path, null, 'a remote participant never gets a local folder')
  assert.equal(driftRow.instance_name, 'Drift')
  // Accepting appended a system message on the home box, and Shi pulled it.
  const home = T.getThread(drift.db, tid)
  assert.equal(home.participants.find(p => p.display_name === 'Shi').state, 'joined')
  assert.match(home.recent_messages.at(-1).body, /Shi joined/)
  const seqs = shi.db.prepare('SELECT seq FROM thread_messages WHERE thread_id = ? ORDER BY seq').all(tid).map(r => r.seq)
  assert.deepEqual(seqs, [1, 2, 3], 'one sequence, the home box’s')
  assert.equal(T.getThread(shi.db, tid).thread.message_count, 3)
  // A second sync with nothing new changes nothing.
  const again = await sync(shi)
  assert.deepEqual(again.touched, [])
}

// ── 4. Shi's primary agent has a reply turn; another local folder does not ──
let replyTurn
{
  const pending = T.findPendingThreadReplies(shi.db, { agentPaths: ['/agents/shi', '/agents/other'], nonce: () => 'n0nce' })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].agent_path, '/agents/shi')
  assert.match(pending[0].prompt, /hosted on Drift/)
  assert.match(pending[0].prompt, /Drift \(agent on Drift\)/)
  assert.match(pending[0].prompt, /<<<n0nce message 2 from Drift/)
  assert.match(pending[0].external_ref, new RegExp(`^thread:${tid}:par_[0-9a-f-]+:2$`), "keyed to the newest real message; seq 3 is the join notice")
  replyTurn = pending[0]
}

// ── 5. Shi answers: pending until the home box numbers it ───────────────────
let shiMsgId
{
  // The reply turn posts with the job id its prompt states — a profile with no shell cannot read
  // QALATRA_JOB_ID, and a post without one is the human's, which this mirror refuses (Huli, 2026-11-11).
  const stated = replyTurn.prompt.match(/job_id: "([^"]+)"/)?.[1]
  assert.equal(stated, replyTurn.job_id)
  shi.db.prepare(`INSERT INTO agent_jobs (id, agent_path, status, external_ref) VALUES (?, ?, 'running', ?)`).run(stated, replyTurn.agent_path, replyTurn.external_ref)
  const turnCaller = T.resolveThreadCaller(shi.db, stated)
  const posted = T.postThreadMessage(shi.db, tid, { caller: turnCaller, body: "In advance, on the 1st — that's what the signed retainer at /home/shi/contracts/moceanic.pdf says." })
  assert.equal(posted.pending, true)
  assert.equal(posted.message.seq, null)
  assert.equal(posted.message.redacted_count, 1, 'sanitized before it is stored on the mirror')
  shiMsgId = posted.message.id
  const view = T.getThread(shi.db, tid)
  assert.equal(view.pending_messages.length, 1)
  // Only the bound folder speaks for Shi; the human and other folders cannot post on a mirror.
  throwsStatus(() => T.postThreadMessage(shi.db, tid, { caller: T.resolveThreadCaller(shi.db, 'job-other'), body: 'hi' }), 403, /not a participant/)
  throwsStatus(() => T.postThreadMessage(shi.db, tid, { caller: { kind: 'human' }, body: 'hi' }), 403, /hosted on Drift/)
  throwsStatus(() => T.closeThread(shi.db, tid, { caller: shiJob, decision: 'x' }), 409, /hosted on Drift/)
  throwsStatus(() => T.freezeThread(shi.db, tid, { caller: { kind: 'human' } }), 409, /hosted on Drift/)

  await sync(shi)
  const onDrift = T.readThreadMessages(drift.db, tid, { since_seq: 3, markRead: false }).messages
  assert.equal(onDrift.length, 1)
  assert.equal(onDrift[0].author, 'Shi')
  assert.equal(onDrift[0].seq, 4)
  assert.ok(onDrift[0].body.includes('[redacted]') && !onDrift[0].body.includes('/home/shi'))
  const local = shi.db.prepare('SELECT seq FROM thread_messages WHERE id = ?').get(shiMsgId)
  assert.equal(local.seq, 4, 'the pending row is stamped with the seq Drift assigned')
  assert.equal(shi.db.prepare('SELECT COUNT(*) AS n FROM thread_messages WHERE thread_id = ?').get(tid).n, 4, 'no duplicate when it comes back down')
  assert.ok(shi.db.prepare('SELECT delivered_at FROM thread_deliveries WHERE message_id = ?').get(shiMsgId).delivered_at)
  assert.equal(shi.db.prepare(`SELECT last_read_seq FROM thread_participants WHERE thread_id = ? AND display_name = 'Shi'`).get(tid).last_read_seq, 4)
  assert.equal(T.getThread(shi.db, tid).pending_messages.length, 0)
  // Shi has answered everything, so no new turn; Drift's primary now has one.
  assert.equal(T.findPendingThreadReplies(shi.db, { agentPaths: ['/agents/shi'] }).length, 0)
  const driftTurn = T.findPendingThreadReplies(drift.db, { agentPaths: ['/agents/drift'], nonce: () => 'n0nce' })
  assert.equal(driftTurn.length, 1)
  assert.match(driftTurn[0].prompt, /<<<n0nce message 4 from Shi/)
  assert.match(driftTurn[0].prompt, /Shi \(agent on Shi\)/)
  // A retried delivery with the same idempotency key lands once.
  const key = shi.db.prepare('SELECT idempotency_key FROM thread_messages WHERE id = ?').get(shiMsgId).idempotency_key
  const dup = T.peerPostMessage(drift.db, 'Shi', tid, { body: 'whatever', idempotency_key: key })
  assert.equal(dup.duplicate, true)
  assert.equal(dup.message.seq, 4)
}

// ── 6. Drift closes; the decision reaches the task and the mirror ───────────
{
  const closed = T.closeThread(drift.db, tid, { caller: driftJob, decision: 'Invoice Moceanic in advance on the 1st, per the signed retainer.' })
  assert.ok(closed.decision_note_id)
  await sync(shi)
  const mirror = T.getThread(shi.db, tid, { tail: 1 })
  assert.equal(mirror.thread.status, 'closed')
  assert.equal(mirror.thread.closed_reason, 'resolved')
  assert.match(mirror.thread.decision, /in advance/)
  assert.equal(mirror.recent_messages[0].kind, 'decision')
  throwsStatus(() => T.postThreadMessage(shi.db, tid, { caller: shiJob, body: 'late' }), 409, /closed/)
  assert.equal(T.findPendingThreadReplies(shi.db, { agentPaths: ['/agents/shi'] }).length, 0, 'closed threads take no turns')
}

// ── 7. The outbox survives a home box that is down ──────────────────────────
{
  const t2 = T.openThread(drift.db, { subject: 'Second', participants: [{ kind: 'instance', name: 'Shi' }, { kind: 'human' }], caller: driftJob, settings: drift.settings }).thread.id
  await sync(shi)
  const posted = T.postThreadMessage(shi.db, t2, { caller: shiJob, body: 'Are you there?' })
  drift.down = true
  await sync(shi)
  const d = shi.db.prepare('SELECT * FROM thread_deliveries WHERE message_id = ?').get(posted.message.id)
  assert.equal(d.attempts, 1)
  assert.equal(d.delivered_at, null)
  assert.equal(d.failed_at, null, 'unreachable is retried, not given up on')
  assert.match(d.last_error, /unreachable: ECONNREFUSED/)
  assert.ok(Date.parse(d.next_attempt_at) > Date.now(), 'backoff')
  assert.match(T.listThreadPeers(shi.db)[0].last_error, /unreachable/)
  assert.ok(logs.some(l => /sync with Drift failed/.test(l)))
  drift.down = false
  shi.db.prepare('UPDATE thread_deliveries SET next_attempt_at = ?').run(new Date(Date.now() - 1000).toISOString())
  await sync(shi)
  assert.ok(shi.db.prepare('SELECT delivered_at FROM thread_deliveries WHERE message_id = ?').get(posted.message.id).delivered_at)
  assert.equal(T.listThreadPeers(shi.db)[0].last_error, null, 'a clean sync clears the peer error')
  assert.equal(T.readThreadMessages(drift.db, t2, { markRead: false }).messages.at(-1).body, 'Are you there?')

  // A refusal is permanent: Justin froze the thread on Drift before Shi's message arrived.
  T.freezeThread(drift.db, t2, { caller: { kind: 'human' } })
  const late = T.postThreadMessage(shi.db, t2, { caller: shiJob, body: 'One more thing' }) // the mirror still says open
  await sync(shi)
  const refused = shi.db.prepare('SELECT * FROM thread_deliveries WHERE message_id = ?').get(late.message.id)
  assert.ok(refused.failed_at, 'a 409 is not retried')
  assert.match(refused.last_error, /409/)
  const view = T.getThread(shi.db, t2)
  assert.equal(view.thread.status, 'frozen', 'and the same sync brought the frozen status down')
  assert.equal(view.pending_messages.length, 1, 'the refused message stays visible, marked')
  assert.ok(view.pending_messages[0].delivery_failed_at)
}

// ── 8. What a peer key does not buy ─────────────────────────────────────────
{
  const wispPeer = T.listThreadPeerSecrets(wisp.db).find(p => p.name === 'Drift')
  const call = (method, path, body) => fakeFetch(`${wispPeer.url}/api/v1/threads/peer${path}`, {
    method, redirect: 'error', headers: { Authorization: `Bearer ${wispPeer.token}` }, body: body && JSON.stringify(body),
  })
  const list = await (await call('GET', '/threads')).json()
  assert.deepEqual(list.threads, [], 'Wisp sees no thread it is not in')
  assert.equal((await call('GET', `/threads/${tid}/messages`)).status, 404, 'not 403: a peer cannot probe for thread ids')
  assert.equal((await call('POST', `/threads/${tid}/messages`, { body: 'let me in' })).status, 404)
  assert.equal((await call('POST', `/threads/${tid}/accept`, {})).status, 404)
  const bad = await fakeFetch(`${drift.url}/api/v1/threads/peer/threads`, { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer nope' } })
  assert.equal(bad.status, 401)
  // A peer speaks only as its own participant: there is no field that names another one.
  const t3 = T.openThread(drift.db, { subject: 'Third', participants: [{ kind: 'instance', name: 'Shi' }, { kind: 'human' }], caller: driftJob, settings: drift.settings })
  const human = t3.participants.find(p => p.kind === 'human')
  const shiKey = T.listThreadPeerSecrets(shi.db)[0].token
  const res = await fakeFetch(`${drift.url}/api/v1/threads/peer/threads/${t3.thread.id}/messages`, {
    method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${shiKey}` }, body: JSON.stringify({ body: 'as Justin', participant_id: human.id, kind: 'decision' }),
  })
  assert.equal(res.status, 200)
  const landed = T.readThreadMessages(drift.db, t3.thread.id, { markRead: false }).messages.at(-1)
  assert.equal(landed.author, 'Shi')
  assert.equal(landed.kind, 'message', 'a peer cannot write a decision')
}

// ── 9. What a home box cannot do to a mirror ────────────────────────────────
{
  const local = T.openThread(shi.db, { subject: 'Local to Shi', participants: [{ kind: 'human' }], caller: shiJob, settings: shi.settings }).thread.id
  const peer = { name: 'Drift', url: drift.url }
  // Claiming a thread id that exists here as Shi's own thread.
  const forged = {
    thread: { id: local, subject: 'hijack', status: 'closed', message_count: 0 },
    participants: [{ id: 'par_00000000-0000-4000-8000-000000000000', kind: 'instance', display_name: 'Shi' }],
    you: 'par_00000000-0000-4000-8000-000000000000',
  }
  assert.equal(T.applyPeerThread(shi.db, { peer, entry: forged, primaryAgent: '/agents/shi' }).skipped, 'id_conflict')
  assert.equal(T.getThread(shi.db, local).thread.status, 'open', 'untouched')
  // Naming a local folder for a participant.
  const tid4 = 'thr_11111111-1111-4111-8111-111111111111'
  T.applyPeerThread(shi.db, {
    peer,
    entry: {
      thread: { id: tid4, subject: 'x', status: 'open', message_count: 0 },
      participants: [
        { id: 'par_11111111-1111-4111-8111-111111111111', kind: 'agent', display_name: 'Drift', agent_path: '/agents/other' },
        { id: 'par_22222222-2222-4222-8222-222222222222', kind: 'instance', display_name: 'Shi' },
      ],
      you: 'par_22222222-2222-4222-8222-222222222222',
    },
    primaryAgent: '/agents/shi',
  })
  const rows = shi.db.prepare('SELECT display_name, agent_path FROM thread_participants WHERE thread_id = ? ORDER BY display_name').all(tid4)
  assert.deepEqual(rows, [{ display_name: 'Drift', agent_path: null }, { display_name: 'Shi', agent_path: '/agents/shi' }])
  // Reusing a participant id that belongs to another thread does not move it.
  const victim = shi.db.prepare(`SELECT id FROM thread_participants WHERE thread_id = ? AND display_name = 'Shi'`).get(tid).id
  T.applyPeerThread(shi.db, {
    peer,
    entry: { thread: { id: 'thr_33333333-3333-4333-8333-333333333333', subject: 'y', status: 'open' }, participants: [{ id: victim, kind: 'instance', display_name: 'Mallory' }], you: victim },
    primaryAgent: '/agents/shi',
  })
  assert.equal(shi.db.prepare('SELECT thread_id, display_name FROM thread_participants WHERE id = ?').get(victim).thread_id, tid)
  // Messages for a participant that is not in the thread, or a thread that is not Drift's mirror, are dropped.
  const r1 = T.applyPeerMessages(shi.db, { peer, thread_id: tid4, messages: [{ id: 'msg_44444444-4444-4444-8444-444444444444', seq: 1, kind: 'message', body: 'x', participant_id: victim }] })
  assert.equal(r1.inserted, 0)
  assert.equal(T.applyPeerMessages(shi.db, { peer, thread_id: local, messages: [] }).skipped, 'not_a_mirror')
  // And a remote body is sanitized again on arrival.
  const r2 = T.applyPeerMessages(shi.db, { peer, thread_id: tid4, messages: [{ id: 'msg_55555555-5555-4555-8555-555555555555', seq: 1, kind: 'message', body: 'key qalatra_abcdefghijklmnopqrstuvwx', participant_id: 'par_11111111-1111-4111-8111-111111111111' }] })
  assert.equal(r2.inserted, 1)
  assert.ok(!T.readThreadMessages(shi.db, tid4, { markRead: false }).messages[0].body.includes('qalatra_abc'))
}

// ── 10. Disabled boxes do not sync; mirrors do not expire or sweep ──────────
{
  const before = requests.length
  shi.settings.threads.enabled = false
  assert.deepEqual(await sync(shi), { peers: 0, touched: [] })
  assert.equal(requests.length, before, 'no network at all')
  shi.settings.threads.enabled = true
  // Backdate everything a day, so the sweep's cutoff never races the clock.
  shi.db.prepare(`UPDATE threads SET last_message_at = '2026-01-01T00:00:00.000Z', created_at = '2026-01-01T00:00:00.000Z'`).run()
  const r = T.sweepAbandonedThreads(shi.db, { days: 1 })
  const mirrorsTouched = shi.db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE home_url IS NOT NULL AND closed_reason = 'abandoned'`).get().n
  assert.equal(mirrorsTouched, 0, 'a mirror is closed only by its home box')
  assert.ok(r.abandoned >= 1, 'local threads still sweep')
}

// ── 11. The sync cursor sees a change that keeps updated_at identical ───────
{
  const cursor = T.peerListThreads(drift.db, 'Shi', {}).next_cursor
  assert.deepEqual(T.peerListThreads(drift.db, 'Shi', { since: cursor }).threads, [])
  // Same-millisecond change: updated_at does not move, sync_version still does.
  drift.db.prepare('UPDATE threads SET decision = decision, updated_at = updated_at WHERE id = ?').run(tid)
  assert.deepEqual(T.peerListThreads(drift.db, 'Shi', { since: cursor }).threads.map(e => e.thread.id), [tid])
}

// ── 12. Settings ─────────────────────────────────────────────────────────────
{
  const cfg = T.threadSettings({ instanceName: 'Box', threads: { primaryAgent: '/agents/p', autoReplyAgents: ['/agents/a'] } })
  assert.equal(cfg.instanceName, 'Box', 'falls back to the top-level instanceName')
  assert.deepEqual(cfg.autoReplyAgents, ['/agents/a', '/agents/p'], 'the primary agent takes reply turns')
  assert.match(T.validateThreadSettings({ primaryAgent: 3 }), /primaryAgent/)
}

console.log('test-thread-peers: ok')
