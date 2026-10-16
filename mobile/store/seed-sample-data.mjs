#!/usr/bin/env node
// Seeds a Qalatra server with a believable sample workspace for store screenshots and the App
// Review demo server. Dates are relative to today, so re-running on another day still looks live.
//
//   QALATRA_URL=https://api-review.qalatra.com QALATRA_TOKEN_FILE=~/.secrets/qalatra-review-token \
//     node mobile/store/seed-sample-data.mjs
//
// The token is read from a file so it never lands in shell history. Adds data; never deletes.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const base = (process.env.QALATRA_URL || '').replace(/\/$/, '')
const tokenFile = (process.env.QALATRA_TOKEN_FILE || '').replace(/^~/, homedir())
if (!base || !tokenFile) {
  console.error('Set QALATRA_URL and QALATRA_TOKEN_FILE')
  process.exit(1)
}
const token = readFileSync(tokenFile, 'utf8').trim()

async function api(method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.ok === false) throw new Error(`${method} ${path}: ${res.status} ${json.error || ''}`)
  return json
}

const day = offset => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().slice(0, 10)
}

const contexts = [
  { slug: 'work', label: 'Work', color: '#8b5cf6' },
  { slug: 'launch', label: 'Launch', color: '#f59e0b' },
  { slug: 'home', label: 'Home', color: '#38bdf8' },
]
const existing = new Set((await api('GET', '/contexts')).contexts.map(c => c.slug))
for (const c of contexts) if (!existing.has(c.slug)) await api('POST', '/contexts', c)

for (const name of ['Mobile launch', 'Website refresh', 'Q4 planning']) {
  await api('POST', '/projects', { name }).catch(() => {})
}

const tasks = [
  { title: 'Submit the iOS build for App Review', context: 'launch', project: 'Mobile launch', my_priority: 1, energy_required: 'high', due_date: day(0),
    description: 'Attach build 0.3.1, double-check screenshots and the review notes, then submit.' },
  { title: 'Review the pricing page copy', context: 'work', project: 'Website refresh', my_priority: 2, energy_required: 'medium', due_date: day(0),
    description: 'Tighten the hero copy and make the plan comparison scannable on mobile. Check the FAQ answers against the new billing flow.',
    notes: 'Lead with the outcome, not the feature list. Keep the table to three columns.',
    log: ['Sent the draft to Maya for a second read.', 'Maya: the annual toggle should default to monthly.'] },
  { title: 'Reply to Maya about the onboarding flow', context: 'work', my_priority: 2, energy_required: 'low', due_date: day(0) },
  { title: 'Weekly review', context: 'work', my_priority: 3, recurrence: 'weekly', due_date: day(0) },
  { title: 'Draft the launch announcement', context: 'launch', project: 'Mobile launch', my_priority: 2, energy_required: 'high', due_date: day(1) },
  { title: 'Book the dentist', context: 'home', my_priority: 4, energy_required: 'low', due_date: day(0) },
  { title: 'Fix flaky login test in CI', context: 'work', project: 'Mobile launch', my_priority: 1, energy_required: 'medium', due_date: day(-1),
    task_type: 'coding', description: 'Fails roughly one run in ten on the 2FA step. Agent is looking into a race in the mock clock.' },
  { title: 'Plan Q4 goals with the team', context: 'work', project: 'Q4 planning', my_priority: 3, due_date: day(3) },
  { title: 'Renew domain names', context: 'home', my_priority: 5, due_date: day(5) },
  { title: 'Water the plants', context: 'home', recurrence: 'FREQ=WEEKLY;BYDAY=MO,TH', due_date: day(0) },
  { title: 'Calm Technology, by Amber Case', task_type: 'reading', context: 'home', my_priority: 3 },
  { title: 'Shape Up: stop running in circles', task_type: 'reading', context: 'work', my_priority: 2,
    source_url: 'https://basecamp.com/shapeup' },
  { title: 'Explore offline mode for the mobile app', context: 'work', project: 'Mobile launch', status: 'backlog' },
  { title: 'Write a getting-started guide', context: 'launch', project: 'Website refresh', status: 'backlog' },
]
for (const { log = [], ...t } of tasks) {
  const { task } = await api('POST', '/tasks', t)
  for (const body of log) await api('POST', `/tasks/${task.id}/notes`, { body })
}

// History per habit, oldest first, ending today: d = done, s = skipped, . = nothing logged.
const habits = [
  { title: 'Morning walk', recurrence: 'daily', history: 'ddddd' },
  { title: 'Read 20 pages', recurrence: 'daily', history: 'ddsd.' },
  { title: 'Inbox zero', recurrence: 'weekdays', history: 'dddd.' },
]
for (const { history, ...h } of habits) {
  await api('POST', '/habits', h).catch(e => console.warn(`habit "${h.title}": ${e.message}`))
}
const { habits: created } = await api('GET', `/habits?date=${day(0)}`)
for (const { title, history } of habits) {
  const habit = created.find(c => c.title === title)
  if (!habit) continue
  for (let i = 0; i < history.length; i++) {
    const status = { d: 'done', s: 'skipped' }[history[i]]
    if (status) await api('POST', `/habits/${habit.id}/log`, { date: day(i - history.length + 1), status })
  }
}

await api('PUT', `/daily-notes/${day(0)}`, {
  content: `# ${day(0)}\n\n## Focus\n- Ship the mobile build to review\n- Pricing page copy\n\n## Notes\n- Maya suggested a shorter onboarding: sign in, connect, done.\n- CI flake looks like a timing issue in the 2FA mock.\n`,
})

console.log(`Seeded ${tasks.length} tasks, 3 habits and today's note on ${base}`)
