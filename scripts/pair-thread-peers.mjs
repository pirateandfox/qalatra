#!/usr/bin/env node
// Pair two Qalatra boxes for cross-box threads: one key per direction, each issued by the box it
// authenticates to (docs/agent-to-agent-threads.md, "Pairing").
//
//   QALATRA_PAIR_A_TOKEN=… QALATRA_PAIR_B_TOKEN=… \
//     node scripts/pair-thread-peers.mjs https://api-shi.example.com https://api-drift.example.com
//
// The two tokens are each box's full_access (owner) token, read from the environment so they never
// appear in shell history or `ps`. The peer keys this mints go from one box's API straight into
// the other's and are never printed, logged or written to disk. Re-running is safe: issuing again
// replaces the previous key in that direction, so it doubles as key rotation.
//
// Each box must have a thread name (settings.threads.instanceName, or the top-level instanceName):
// that is the name its peer stores it under, and the name agents use in open_thread.

const [urlA, urlB] = process.argv.slice(2).map(u => String(u ?? '').replace(/\/+$/, ''))
const tokenA = process.env.QALATRA_PAIR_A_TOKEN
const tokenB = process.env.QALATRA_PAIR_B_TOKEN

function usage(msg) {
  if (msg) console.error(`pair-thread-peers: ${msg}`)
  console.error('usage: QALATRA_PAIR_A_TOKEN=… QALATRA_PAIR_B_TOKEN=… node scripts/pair-thread-peers.mjs <box A API url> <box B API url>')
  process.exit(2)
}
if (!urlA || !urlB) usage('two API URLs are required')
if (!tokenA || !tokenB) usage('QALATRA_PAIR_A_TOKEN and QALATRA_PAIR_B_TOKEN must both be set')
if (urlA === urlB) usage('the two URLs are the same box')

async function call(base, token, method, route, body) {
  const res = await fetch(`${base}/api/v1/threads${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  const data = await res.json().catch(() => ({}))
  // Error text comes from the box's API; it never contains a key, but cap it anyway.
  if (!res.ok) throw new Error(`${method} ${base}/api/v1/threads${route} → ${res.status} ${String(data.error ?? '').slice(0, 200)}`)
  return data
}

async function boxName(base, token) {
  const info = await call(base, token, 'GET', '/peers')
  if (!info.instance_name) throw new Error(`${base} has no thread name; set settings.threads.instanceName (or instanceName) there first`)
  return info.instance_name
}

// `issuer` mints a key for `holder` and `holder` stores it under the issuer's name and URL.
async function oneDirection(issuer, holder) {
  const issued = await call(issuer.url, issuer.token, 'POST', `/peers/${encodeURIComponent(holder.name)}/issue`)
  if (!issued.key) throw new Error(`${issuer.name} returned no key`)
  await call(holder.url, holder.token, 'PUT', `/peers/${encodeURIComponent(issuer.name)}`, { url: issuer.url, token: issued.key })
  const test = await call(holder.url, holder.token, 'POST', `/peers/${encodeURIComponent(issuer.name)}/test`)
  if (!test.result?.ok) throw new Error(`${holder.name} → ${issuer.name} check failed: ${test.result?.error ?? 'unknown'}`)
  console.log(`  ${holder.name} → ${issuer.name}: ok (${issuer.name} knows it as "${test.result.they_call_us}")`)
}

try {
  const a = { url: urlA, token: tokenA }
  const b = { url: urlB, token: tokenB }
  ;[a.name, b.name] = await Promise.all([boxName(a.url, a.token), boxName(b.url, b.token)])
  if (a.name.toLowerCase() === b.name.toLowerCase()) throw new Error(`both boxes are named "${a.name}"; give each a distinct thread name`)
  console.log(`Pairing ${a.name} (${a.url}) with ${b.name} (${b.url})`)
  await oneDirection(a, b)
  await oneDirection(b, a)
  console.log('Paired. Each box now holds its own key to the other; nothing was printed or stored here.')
} catch (err) {
  console.error(`pair-thread-peers: ${err.message}`)
  process.exit(1)
}
