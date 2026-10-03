// scripts/test-worktrees.mjs
// Per-task worktrees (server/worktrees.js) against a real git repo with a real origin.
//
// Covers the lifecycle (created on the first job, reused on the second, kept while a job for the
// task is queued or running, removed afterwards and by the idle sweep), launch failure on a bad
// base, the identity rule (a worktree job's .flightdeskrc comes from the bound folder, never the
// worktree or ~), and that the agent scan never registers a worktree's copy of an agent folder.
//
//   node scripts/test-worktrees.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ensureTaskWorktree, removeTaskWorktree, sweepIdleWorktrees, worktreeDirName,
  baseBranchFromPipelineConfig, WorktreeError, WORKTREES_DIR,
} from '../server/worktrees.js'
import { buildAgentEnv } from '../server/workers.js'
import { scanAgents } from '../server/agents.js'

const quiet = { error: () => {} }
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qalatra-worktrees-')))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let failures = 0
async function test(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`) }
  catch (err) { failures++; console.log(`FAIL  ${name}\n      ${err.stack || err}`) }
}

try {
  // origin (bare) ← repo (the agent's main tree), base branch `trunk` so nothing can assume develop.
  const origin = path.join(tmp, 'origin.git')
  const repo = path.join(tmp, 'repo')
  git(tmp, 'init', '--bare', '-b', 'trunk', origin)
  git(tmp, 'clone', origin, repo)
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  const agentDir = path.join(repo, 'agents', 'pipeline')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'agent.config'), JSON.stringify({ name: 'pipeline', worktrees: true, worktree_copy: ['.env'] }))
  fs.writeFileSync(path.join(repo, 'agents', 'pipeline-config.md'), '| Field | Value |\n|---|---|\n| `base_branch` | `trunk` |\n')
  git(repo, 'checkout', '-b', 'trunk')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')
  git(repo, 'push', 'origin', 'trunk')
  // Untracked, like the real thing: the folder's identity and a local secret.
  fs.writeFileSync(path.join(agentDir, '.flightdeskrc'), JSON.stringify({ apiKey: 'fd-folder-key', apiUrl: 'https://fd.example' }))
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')
  const cfg = JSON.parse(fs.readFileSync(path.join(agentDir, 'agent.config'), 'utf8'))

  let active = [] // what listActiveTaskRefs returns
  let lastActivity = null
  const dbCall = async (method, ...args) => {
    if (method === 'listActiveTaskRefs') return active
    if (method === 'lastJobActivityUnder') return lastActivity
    if (method === 'listWorktreeAgents') return [{ path: agentDir }]
    throw new Error(`unexpected dbCall ${method} ${JSON.stringify(args)}`)
  }

  const wtPath = path.join(repo, WORKTREES_DIR, 'fd-123')
  let first

  await test('base branch comes from agents/pipeline-config.md', () => {
    assert.equal(baseBranchFromPipelineConfig('| `base_branch` | `develop` |'), 'develop')
    assert.equal(baseBranchFromPipelineConfig('| base_branch | main |'), 'main')
    assert.equal(baseBranchFromPipelineConfig('nothing here'), null)
  })

  await test('task refs become one safe directory name', () => {
    assert.equal(worktreeDirName('fd-123'), 'fd-123')
    assert.equal(worktreeDirName('../../etc'), '-..-etc')
    assert.ok(!worktreeDirName('../x').includes('/'))
    assert.equal(worktreeDirName(''), null)
    assert.equal(worktreeDirName('...'), null)
  })

  await test('first job creates the worktree, detached at origin/<base>, cwd in the matching subfolder', async () => {
    first = await ensureTaskWorktree({ agentPath: agentDir, taskRef: 'fd-123', cfg, log: quiet })
    assert.equal(first.created, true)
    assert.equal(first.worktree, wtPath)
    assert.equal(first.cwd, path.join(wtPath, 'agents', 'pipeline'))
    assert.ok(fs.existsSync(path.join(first.cwd, 'agent.config')))
    assert.equal(git(wtPath, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/trunk'))
    assert.throws(() => git(wtPath, 'symbolic-ref', '-q', 'HEAD'), 'HEAD is detached')
    assert.equal(fs.readFileSync(path.join(wtPath, '.env'), 'utf8'), 'SECRET=1\n', 'worktree_copy copied .env')
    assert.ok(!fs.existsSync(path.join(first.cwd, '.flightdeskrc')), 'the untracked rc is not in the worktree')
    assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.qalatra-worktrees\/$/m)
    assert.ok(!git(repo, 'status', '--porcelain', '--untracked-files=all').includes(WORKTREES_DIR), 'worktrees never show in the main tree status')
  })

  await test('second job reuses the worktree as is, agent state included', async () => {
    fs.writeFileSync(path.join(first.cwd, 'scratch.txt'), 'agent work in progress')
    git(wtPath, 'switch', '-c', 'task/fd-123')
    const second = await ensureTaskWorktree({ agentPath: agentDir, taskRef: 'fd-123', cfg, log: quiet })
    assert.equal(second.created, false)
    assert.equal(second.cwd, first.cwd)
    assert.equal(fs.readFileSync(path.join(second.cwd, 'scratch.txt'), 'utf8'), 'agent work in progress')
    assert.equal(git(wtPath, 'branch', '--show-current'), 'task/fd-123')
  })

  await test('identity comes from the bound folder, not the worktree cwd or ~/.flightdeskrc', () => {
    // The worker passes job.agent_path (the bound folder) — never runCwd — to buildAgentEnv.
    const env = buildAgentEnv({}, cfg, '/bin/sh', agentDir)
    assert.equal(env.FLIGHTDESK_API_KEY, 'fd-folder-key')
    assert.equal(env.FLIGHTDESK_API_URL, 'https://fd.example')
    const fromWorktree = buildAgentEnv({}, cfg, '/bin/sh', first.cwd)
    assert.equal(fromWorktree.FLIGHTDESK_API_KEY, process.env.FLIGHTDESK_API_KEY, 'the worktree has no rc, which is why it must not be the lookup path')
  })

  await test('the agent scan does not register a worktree copy of the agent folder', async () => {
    const agents = await scanAgents(repo)
    assert.deepEqual(agents.map(a => a.path), [agentDir])
    assert.equal(agents[0].worktrees, true)
  })

  await test('a worktree with a queued or running job for its task is not removed', async () => {
    active = [{ agent_path: agentDir, task_ref: 'fd-123' }]
    const r = await removeTaskWorktree({ dbCall, agentPath: agentDir, taskRef: 'fd-123', log: quiet })
    assert.equal(r.removed, false)
    assert.equal(r.reason, 'job_pending')
    assert.ok(fs.existsSync(wtPath))
  })

  await test('a job for the same ref in another repo does not hold it', async () => {
    active = [{ agent_path: path.join(tmp, 'elsewhere'), task_ref: 'fd-123' }]
    const r = await removeTaskWorktree({ dbCall, agentPath: agentDir, taskRef: 'fd-123', log: quiet })
    assert.equal(r.removed, true)
    assert.ok(!fs.existsSync(wtPath))
    assert.ok(!git(repo, 'worktree', 'list').includes(wtPath), 'pruned from git worktree list')
    active = []
  })

  await test('the idle sweep removes worktrees that ran nothing for N days, keeps recent ones', async () => {
    await ensureTaskWorktree({ agentPath: agentDir, taskRef: 'fd-old', cfg, log: quiet })
    await ensureTaskWorktree({ agentPath: agentDir, taskRef: 'fd-new', cfg, log: quiet })
    const day = 86_400_000
    const now = Date.now()
    const calls = []
    const sweepDb = async (method, arg) => {
      if (method === 'lastJobActivityUnder') {
        calls.push(arg)
        return arg.endsWith('fd-old') ? new Date(now - 10 * day).toISOString().replace('T', ' ').slice(0, 19) : new Date(now - day).toISOString()
      }
      return dbCall(method, arg)
    }
    const r = await sweepIdleWorktrees({ dbCall: sweepDb, idleDays: 7, now, log: quiet })
    assert.equal(r.removed, 1)
    assert.ok(!fs.existsSync(path.join(repo, WORKTREES_DIR, 'fd-old')))
    assert.ok(fs.existsSync(path.join(repo, WORKTREES_DIR, 'fd-new')))
    assert.equal(calls.length, 2)
  })

  await test('a bad base ref fails the launch instead of falling back to the folder', async () => {
    await assert.rejects(
      ensureTaskWorktree({ agentPath: agentDir, taskRef: 'fd-bad', cfg: { ...cfg }, meta: { base_branch: 'no-such-branch' }, log: quiet }),
      err => err instanceof WorktreeError && /no-such-branch/.test(err.message),
    )
    assert.ok(!fs.existsSync(path.join(repo, WORKTREES_DIR, 'fd-bad')))
    await assert.rejects(
      ensureTaskWorktree({ agentPath: agentDir, taskRef: 'fd-bad', cfg: { worktree_base: '--upload-pack=evil' }, log: quiet }),
      err => err instanceof WorktreeError && /invalid base branch/.test(err.message),
    )
  })

  await test('a folder outside any git repo fails the launch', async () => {
    const loose = path.join(tmp, 'loose')
    fs.mkdirSync(loose)
    await assert.rejects(ensureTaskWorktree({ agentPath: loose, taskRef: 'fd-1', cfg, log: quiet }), WorktreeError)
  })

  await test('worktree_copy refuses paths outside the repo', async () => {
    await assert.rejects(
      ensureTaskWorktree({ agentPath: agentDir, taskRef: 'fd-escape', cfg: { worktree_copy: ['../../etc/passwd'] }, log: quiet }),
      err => err instanceof WorktreeError && /inside the repo/.test(err.message),
    )
    assert.ok(!fs.existsSync(path.join(repo, WORKTREES_DIR, 'fd-escape')), 'refused before anything was created')
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nAll passed')
