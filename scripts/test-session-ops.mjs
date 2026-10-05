import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionOps, parseBridgeError, redactPageText, BridgeUnavailableError, UnknownSessionError } from '../server/session-ops.js'
import { compactReport, sessionOpFailure, DIAGNOSTICS_CHARS } from '../server/integrations/flightdesk/dispatch.js'

const approval = {
  title: 'Allow Claude to use add repo?', action: 'use add repo',
  fields: [{ label: 'Owner', value: 'MoceanicHQ' }, { label: 'Repo', value: 'moceanic-ai' }],
  options: [{ digit: 1, label: 'Deny' }, { digit: 2, label: 'Allow once' }],
  text: 'Allow Claude to use add repo? Deny Allow once',
}

function fixture(state, transcript = [{ role: 'user', text: 'Implement the task' }]) {
  const calls = []
  const args = []
  const ops = createSessionOps({ connectImpl: async () => ({
    async callTool({ name, arguments: a }) {
      calls.push(name)
      args.push([name, a])
      if (name.includes('transcript') && transcript instanceof Error) throw transcript
      return { content: [{ type: 'text', text: JSON.stringify(name.includes('get_state') ? state : transcript) }] }
    },
  }) })
  return { ops, calls, args }
}

test('native approval survives the session reader and FlightDesk report without needing a transcript', async () => {
  const { ops, calls } = fixture({ state: 'awaiting_approval', workerStatus: 'requires_action', needsHuman: true, approval })
  const result = await ops.state({ sessionId: 'session_test' })
  assert.equal(result.needsHuman, true)
  assert.equal(result.sessionIdle, false)
  assert.equal(result.lastTurnEndsWithQuestion, false)
  assert.deepEqual(result.approval, approval)
  assert.deepEqual(compactReport(result).approval, approval)
  assert.deepEqual(calls, ['claude_session_get_state'])
})

for (const signal of [{ workerStatus: 'requires_action' }, { state: 'awaiting_approval' }, { needsHuman: true }, { approval }]) {
  test(`recognizes independently reported approval signal ${Object.keys(signal)[0]}`, async () => {
    const { ops } = fixture({ state: 'running', ...signal }, new Error('transcript unavailable'))
    const result = await ops.state({ sessionId: 'session_test' })
    assert.equal(result.state, 'awaiting_approval')
    assert.equal(result.needsHuman, true)
    assert.equal(result.sessionIdle, false)
  })
}

test('unreadable approval stays pending; absence of a card never means approval granted', async () => {
  const { ops } = fixture({ state: 'awaiting_approval', workerStatus: 'requires_action', approval: null })
  const result = await ops.state({ sessionId: 'session_test' })
  assert.equal(result.needsHuman, true)
  assert.equal(result.approval, null)
})

test('confirmed resumed state carries an explicit clear signal through compactReport', async () => {
  const { ops } = fixture({ state: 'running', workerStatus: 'running', needsHuman: false, approval: null })
  const result = compactReport(await ops.state({ sessionId: 'session_test' }))
  assert.equal(result.needsHuman, false)
  assert.equal(result.approval, null)
})

test('ordinary idle asks keep the existing transcript behavior', async () => {
  const { ops } = fixture({ state: 'ready', workerStatus: 'idle' }, [{ role: 'assistant', text: 'Which color?', timestamp: 'now' }])
  const result = await ops.state({ sessionId: 'session_test' })
  assert.equal(result.needsHuman, false)
  assert.equal(result.sessionIdle, true)
  assert.equal(result.lastTurnEndsWithQuestion, true)
})

test('unknown state cannot clear an approval or count as idle', async () => {
  const { ops } = fixture({ state: 'unknown' }, new Error('unavailable'))
  const result = await ops.state({ sessionId: 'session_test' })
  assert.equal(result.state, 'unknown')
  assert.equal(result.sessionIdle, false)
})

const resolvedApprovals = [
  { approvalId: 'appr_1', questionIndex: 0, seq: 3, source: 'bridge', decisionId: 'q_1', applied: ['Allow once'] },
  { approvalId: 'appr_1', questionIndex: 1, seq: 4, source: 'ui', applied: ['Deny'] },
]

test('Claude Bridge 0.1.18 resolved-approval history reaches the FlightDesk report verbatim', async () => {
  const { ops, args } = fixture({
    state: 'running', workerStatus: 'running', needsHuman: false, approval: null,
    resolvedApprovals, resolvedApprovalsCursor: 4, resolvedApprovalsTruncated: false,
    resolvedApprovalsError: 'should not travel',
  })
  const result = await ops.state({ sessionId: 'session_test' })
  const report = compactReport(result)
  assert.deepEqual(report.resolvedApprovals, resolvedApprovals)
  assert.equal(report.resolvedApprovalsCursor, 4)
  assert.equal(report.resolvedApprovalsTruncated, false)
  assert.equal('resolvedApprovalsError' in result, false)
  assert.equal('resolvedApprovalsError' in report, false)
  // No resolved_since cursor: FlightDesk dedupes, and the default page of 20 is enough.
  assert.deepEqual(args.find(([n]) => n === 'claude_session_get_state')[1], { session_id: 'session_test' })
})

test('older bridge without history: the fields are omitted from the report, not sent as null', async () => {
  const { ops } = fixture({ state: 'running', workerStatus: 'running', needsHuman: false, approval: null })
  const result = await ops.state({ sessionId: 'session_test' })
  assert.equal(result.resolvedApprovals, null)
  const report = compactReport(result)
  for (const k of ['resolvedApprovals', 'resolvedApprovalsCursor', 'resolvedApprovalsTruncated']) assert.equal(k in report, false)
})

// ── Claude Bridge 0.1.19 error codes ──
// `Error: [CODE] message` + `\n\nDetails: {json}` (host/daemon.js). Details quote the page.
const BODY = 'Something went wrong SECRET-PAGE-TEXT customer invoice 4411'
const bridgeText = (code, message, details) => `Error: [${code}] ${message}` + (details ? `\n\nDetails: ${JSON.stringify(details)}` : '')
const pageDetails = (reason, extra = {}) => ({
  sessionId: 'session_x',
  lookup: { status: 'found', apiStatus: 200, error: null },
  page: { reason, path: '/code', dialogs: [], errorScreen: reason === 'error_screen', bodyText: BODY, sidebarRows: 0, composer: false, visibility: 'visible' },
  ...extra,
})

function failing(text) {
  return createSessionOps({ connectImpl: async () => ({
    async callTool() { return { isError: true, content: [{ type: 'text', text }] } },
  }) })
}
async function errorOf(text) {
  try { await failing(text).inject({ sessionId: 'session_x', prompt: 'hi' }) } catch (err) { return err }
  throw new Error('expected a failure')
}
const plain = err => !(err instanceof UnknownSessionError) && !(err instanceof BridgeUnavailableError)

test('parseBridgeError splits code, message and Details', () => {
  const p = parseBridgeError(bridgeText('PAGE_UNREADABLE', 'Session x exists, but…', { page: { reason: 'dialog_open' } }))
  assert.deepEqual(p, { code: 'PAGE_UNREADABLE', message: 'Session x exists, but…', details: { page: { reason: 'dialog_open' } } })
  assert.deepEqual(parseBridgeError('Error: Chrome not connected'), { code: null, message: 'Chrome not connected', details: null })
})

for (const code of ['SESSION_NOT_FOUND', 'INVALID_SESSION_ID']) {
  test(`${code} is an unknown session`, async () => {
    const err = await errorOf(bridgeText(code, 'Session not found: session_x', { lookup: { status: 'not_found', apiStatus: 404 } }))
    assert.ok(err instanceof UnknownSessionError)
    assert.equal(err.code, code)
    assert.equal(err.details.lookup.status, 'not_found')
    assert.equal(err.message, 'Session not found: session_x')
  })
}

test('NOT_AUTHENTICATED is the bridge being unavailable', async () => {
  const err = await errorOf(bridgeText('NOT_AUTHENTICATED', 'Not signed in to claude.ai in the bridge browser.', { lookup: { status: 'unauthenticated' } }))
  assert.ok(err instanceof BridgeUnavailableError)
})

for (const details of [
  { reason: 'no_tab', recovery: { action: 'open_tab', outcome: 'failed' } },
  { reason: 'tab_crashed', tabId: 4, url: 'https://claude.ai/code', chromeError: 'Cannot access contents of the page. Extension manifest must request permission' },
  pageDetails('error_screen', { recovery: { action: 'reload_tab', reason: 'error_screen', outcome: 'still_failing' } }),
  pageDetails('dialog_open'),
]) {
  test(`PAGE_UNREADABLE (${details.reason ?? details.page.reason}) is the bridge being unavailable, never an unknown session`, async () => {
    const err = await errorOf(bridgeText('PAGE_UNREADABLE', 'The session is NOT missing — clear the page and retry.', details))
    assert.ok(err instanceof BridgeUnavailableError)
    assert.equal(err.code, 'PAGE_UNREADABLE')
  })
}

test('PAGE_UNREADABLE about one session (row not rendered) is a plain op failure', async () => {
  const err = await errorOf(bridgeText('PAGE_UNREADABLE', 'Session x exists, but the sidebar shows 4 row(s) but not this one.', pageDetails('row_not_rendered')))
  assert.ok(plain(err))
  assert.equal(err.code, 'PAGE_UNREADABLE')
})

for (const code of ['TIMEOUT', 'SESSION_ARCHIVED']) {
  test(`${code} is neither an unknown session nor the bridge down`, async () => {
    const err = await errorOf(bridgeText(code, 'the page did not answer, so the session was not checked'))
    assert.ok(plain(err))
    assert.equal(err.code, code)
  })
}

test('archiving an already-archived session succeeds', async () => {
  const r = await failing(bridgeText('SESSION_ARCHIVED', 'Session session_x is archived — it has no sidebar row to act on')).archive({ sessionId: 'session_x' })
  assert.equal(r.archived, true)
  assert.equal(r.alreadyArchived, true)
})

for (const message of ['Create PR button not found', 'Chat input not found', 'Archive option not found', 'Send button not found']) {
  test(`uncoded UI scrape failure "${message}" is not an unknown session`, async () => {
    const err = await errorOf(`Error: ${message}`)
    assert.ok(plain(err))
    assert.equal(err.message, message)
  })
}

test('Details text never drives classification', async () => {
  const details = pageDetails('row_not_rendered', { lookup: { status: 'error', error: 'not found' } })
  details.page.dialogs = [{ role: 'dialog', label: 'No sessions', text: 'Session not found — no session here, not connected' }]
  const err = await errorOf(bridgeText('PAGE_UNREADABLE', 'Could not confirm whether session x exists.', details))
  assert.ok(plain(err))
  assert.ok(!err.message.includes('Details'))
})

test('legacy uncoded errors keep their classification', async () => {
  assert.ok(await errorOf('Error: Chrome not connected — is the extension loaded and a claude.ai tab open?') instanceof BridgeUnavailableError)
  assert.ok(await errorOf('Error: unknown session session_x') instanceof UnknownSessionError)
  // The crashed-tab text mentions "Extension manifest"; coded, it is routed by its code, not prose.
  const crashed = await errorOf(bridgeText('PAGE_UNREADABLE', 'claude.ai tab 4 is not responding: Cannot access contents of the page. Extension manifest must request permission.', { reason: 'content_unreachable' }))
  assert.equal(crashed.code, 'PAGE_UNREADABLE')
})

test('page text quoted in a bridge message is withheld', async () => {
  const err = await errorOf(bridgeText('PAGE_UNREADABLE', `Session x exists, but the claude.ai page is not showing it (the page is showing an error: "${BODY}").`, pageDetails('error_screen')))
  assert.ok(!err.message.includes('SECRET-PAGE-TEXT'))
  assert.equal(redactPageText('a pop-up is open: "Billing"', null), 'a pop-up is open: "[page text withheld]"')
})

test('get_state pageIssue and recovered pass through without page text', async () => {
  const pageIssue = { reason: 'dialog_open', path: '/code/session_x', dialogs: [{ role: 'dialog', label: 'Billing', text: BODY }], errorScreen: false, bodyText: BODY, sidebarRows: 0, composer: false }
  const { ops } = fixture({ state: 'ready', workerStatus: 'idle', prUrl: null, branchBar: null, pageIssue, recovered: { action: 'dismiss_dialog', reason: 'dialog_open', outcome: 'recovered' } }, new Error('no transcript'))
  const result = await ops.state({ sessionId: 'session_test' })
  assert.deepEqual(result.pageIssue, { reason: 'dialog_open', errorScreen: false, dialogs: 1, sidebarRows: 0, composer: false })
  assert.deepEqual(result.recovered, { action: 'dismiss_dialog', reason: 'dialog_open', outcome: 'recovered' })
  assert.ok(!JSON.stringify(compactReport(result)).includes('SECRET-PAGE-TEXT'))
})

test('inject and archive pass recovered through', async () => {
  const recovered = { action: 'reload_tab', reason: 'tab_crashed', outcome: 'recovered' }
  const ops = createSessionOps({ connectImpl: async () => ({
    async callTool({ name }) {
      const body = name.includes('inject') ? { injected: true, verified: true, turnId: 't', recovered } : { archived: true, recovered }
      return { content: [{ type: 'text', text: JSON.stringify(body) }] }
    },
  }) })
  assert.deepEqual((await ops.inject({ sessionId: 's', prompt: 'p' })).recovered, recovered)
  assert.deepEqual((await ops.archive({ sessionId: 's' })).recovered, recovered)
})

test('sessionOpFailure: code leads, only allow-listed details travel, unknown-session wording kept', async () => {
  const details = pageDetails('error_screen', { recovery: { action: 'reload_tab', reason: 'error_screen', outcome: 'still_failing' } })
  details.page.dialogs = [{ role: 'dialog', label: 'Billing', text: BODY }]
  const down = sessionOpFailure(await errorOf(bridgeText('PAGE_UNREADABLE', 'x'.repeat(6000), details)), 'session_x')
  assert.equal(down.diagnostics.kind, 'dependency_down')
  assert.ok(down.diagnostics.text.startsWith('[PAGE_UNREADABLE] '))
  assert.ok(down.diagnostics.text.length <= DIAGNOSTICS_CHARS)
  assert.deepEqual(down.bridgeError, { code: 'PAGE_UNREADABLE', details: { lookup: { status: 'found', apiStatus: 200 }, pageReason: 'error_screen', recovery: { action: 'reload_tab', reason: 'error_screen', outcome: 'still_failing' } } })
  assert.ok(!JSON.stringify(down).includes('SECRET-PAGE-TEXT'))
  assert.ok(!JSON.stringify(down).includes('Billing'))

  const gone = sessionOpFailure(await errorOf(bridgeText('SESSION_NOT_FOUND', 'Session not found: session_x', { lookup: { status: 'not_found', apiStatus: 404, error: 'raw api text' }, page: { reason: 'row_not_rendered', bodyText: BODY } })), 'session_x')
  assert.equal(gone.diagnostics.kind, 'error')
  assert.match(gone.diagnostics.text, /^\[SESSION_NOT_FOUND\] unknown session session_x: /)
  assert.ok(!JSON.stringify(gone).includes('raw api text') && !JSON.stringify(gone).includes('SECRET-PAGE-TEXT'))

  assert.deepEqual(sessionOpFailure(await errorOf('Error: Create PR button not found'), 'session_x'), { diagnostics: { kind: 'error', text: 'Create PR button not found' } })
})
