import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'

/**
 * Per-task git worktrees for agent folders that opt in with agent.config `worktrees: true`.
 *
 * Jobs in one agent folder share its checkout, so they run one at a time (getQueuedJobs). A repo's
 * whole FlightDesk workload then queues behind itself — on drift, four dispatches queued together
 * started after 90, 128, 209 and 303 minutes. Giving each task its own checkout lets different
 * tasks run side by side while one task's jobs still serialize.
 *
 * Layout: <repo-root>/.qalatra-worktrees/<task-ref>/, and the agent runs in the same subfolder of
 * that worktree as the bound folder occupies in the main tree, so agent.config, CLAUDE.md/AGENTS.md
 * and relative paths resolve as they always have. The path is stable per task on purpose: Claude
 * keys sessions by cwd, so a task resumes only if every one of its jobs launches in one directory.
 *
 * Only the spawn cwd moves. job.agent_path stays the bound folder, and identity (.flightdeskrc,
 * which is untracked and never exists in a worktree) and agent.config are read from there.
 */

export const WORKTREES_DIR = '.qalatra-worktrees'
const GIT_TIMEOUT_MS = 5 * 60_000
const LOCK_RETRIES = 4

export class WorktreeError extends Error {}

function git(args, { cwd, timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim() || err.message
        reject(Object.assign(new Error(detail), { gitArgs: args }))
      } else {
        resolve(String(stdout).trim())
      }
    })
  })
}

const LOCK_ERROR = /index\.lock|\.lock'?:? File exists|cannot lock ref|Unable to create .*\.lock|could not lock/i

/**
 * Parallel fetches and worktree adds from sibling worktrees share one .git, so an occasional
 * index.lock or ref-lock collision is expected. Retry those briefly; anything else is real.
 */
async function gitRetryingLocks(args, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await git(args, opts)
    } catch (err) {
      if (attempt >= LOCK_RETRIES || !LOCK_ERROR.test(err.message)) throw err
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt))
    }
  }
}

/** A task ref becomes one directory name: no separators, no dot-names, bounded length. */
export function worktreeDirName(taskRef) {
  const name = String(taskRef ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 120)
  return name || null
}

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]+(?<!\.lock)(?<![./])$/

/** `base_branch` from the repo's agents/pipeline-config.md table row, if it has one. */
export function baseBranchFromPipelineConfig(text) {
  const match = /^\|\s*`?base_branch`?\s*\|\s*`?([^`|\s]+)`?\s*\|/m.exec(String(text ?? ''))
  return match ? match[1] : null
}

/**
 * The branch a new task worktree starts from, first match wins: the dispatch's own base_branch
 * (external_meta), agent.config `worktree_base`, the repo's agents/pipeline-config.md, then
 * origin's default branch. Never a hardcoded name.
 */
export async function resolveBaseBranch({ repoRoot, cfg, meta }) {
  const candidates = [
    meta?.base_branch,
    cfg?.worktree_base,
    (() => {
      try { return baseBranchFromPipelineConfig(fs.readFileSync(path.join(repoRoot, 'agents', 'pipeline-config.md'), 'utf8')) }
      catch { return null }
    })(),
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const branch = candidate.trim()
    if (!BRANCH_NAME.test(branch)) throw new WorktreeError(`invalid base branch "${branch}"`)
    return branch
  }
  try {
    const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoRoot, timeout: 10_000 })
    if (head.startsWith('origin/')) return head.slice('origin/'.length)
  } catch {}
  throw new WorktreeError('no base branch: set base_branch in agents/pipeline-config.md or worktree_base in agent.config')
}

export async function repoRootFor(agentPath) {
  try {
    return fs.realpathSync(await git(['rev-parse', '--show-toplevel'], { cwd: agentPath, timeout: 10_000 }))
  } catch (err) {
    throw new WorktreeError(`${agentPath} is not inside a git repository: ${err.message}`)
  }
}

/** Keep the worktrees out of `git status` without touching the tracked .gitignore. */
async function ensureExcluded(repoRoot) {
  const commonDir = path.resolve(repoRoot, await git(['rev-parse', '--git-common-dir'], { cwd: repoRoot, timeout: 10_000 }))
  const excludeFile = path.join(commonDir, 'info', 'exclude')
  const line = `/${WORKTREES_DIR}/`
  let current = ''
  try { current = fs.readFileSync(excludeFile, 'utf8') } catch {}
  if (current.split(/\r?\n/).includes(line)) return
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.appendFileSync(excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`)
}

/**
 * Untracked files the agent depends on (.env, local config) don't exist in a fresh worktree.
 * agent.config `worktree_copy` lists them relative to the repo root; each is copied once, when the
 * worktree is created. Paths that escape the repo are refused.
 */
function declaredCopies(list) {
  if (!Array.isArray(list)) return []
  return list.filter(entry => typeof entry === 'string' && entry.trim()).map(entry => {
    const rel = path.normalize(entry.trim())
    if (path.isAbsolute(rel) || rel.split(path.sep).includes('..')) throw new WorktreeError(`worktree_copy entry "${entry}" must be a path inside the repo`)
    return rel
  })
}

function copyDeclaredFiles(repoRoot, worktree, rels) {
  const copied = []
  for (const rel of rels) {
    const from = path.join(repoRoot, rel)
    const to = path.join(worktree, rel)
    if (!fs.existsSync(from) || fs.existsSync(to)) continue
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(from, to, { recursive: true })
    copied.push(rel)
  }
  return copied
}

// Creation and removal of one worktree never overlap: a cleanup that decided a worktree was idle
// must finish before a job that was claimed meanwhile recreates it, and vice versa.
const locks = new Map()
async function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve()
  let release
  const mine = new Promise(resolve => { release = resolve })
  const chained = prev.then(() => mine)
  locks.set(key, chained)
  try {
    await prev
    return await fn()
  } finally {
    release()
    if (locks.get(key) === chained) locks.delete(key)
  }
}

function isWorktree(dir) {
  try { return fs.statSync(path.join(dir, '.git')).isFile() } catch { return false }
}

/**
 * Find or create the task's worktree and return the cwd the agent should launch in. Throws a
 * WorktreeError (reported as launch_failed) rather than ever falling back to the shared folder:
 * two jobs in one tree is exactly what this exists to prevent.
 */
export async function ensureTaskWorktree({ agentPath, taskRef, cfg = null, meta = null, log = console }) {
  const dirName = worktreeDirName(taskRef)
  if (!dirName) throw new WorktreeError(`task ref "${taskRef}" cannot name a worktree`)
  const repoRoot = await repoRootFor(agentPath)
  const rel = path.relative(repoRoot, fs.realpathSync(agentPath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new WorktreeError(`${agentPath} is outside its repo root ${repoRoot}`)
  const worktree = path.join(repoRoot, WORKTREES_DIR, dirName)

  return withLock(worktree, async () => {
    let created = false
    let base = null
    if (fs.existsSync(worktree)) {
      // Reused as is: between turns the agent owns the contents — its branch, uncommitted work,
      // build output.
      if (!isWorktree(worktree)) throw new WorktreeError(`${worktree} exists but is not a git worktree`)
    } else {
      const copies = declaredCopies(cfg?.worktree_copy) // validated before anything is created
      base = await resolveBaseBranch({ repoRoot, cfg, meta })
      await ensureExcluded(repoRoot)
      try {
        await gitRetryingLocks(['fetch', 'origin', base], { cwd: repoRoot })
      } catch (err) {
        throw new WorktreeError(`git fetch origin ${base} failed: ${err.message}`)
      }
      // Detached: the main tree already has the base branch checked out, and git refuses to check
      // one branch out in two places. The agent creates its task branch from here.
      try {
        await gitRetryingLocks(['worktree', 'add', '--detach', worktree, `origin/${base}`], { cwd: repoRoot })
      } catch (err) {
        throw new WorktreeError(`git worktree add from origin/${base} failed: ${err.message}`)
      }
      created = true
      const copied = copyDeclaredFiles(repoRoot, worktree, copies)
      log.error?.(`[worktrees] created ${worktree} from origin/${base}${copied.length ? ` (copied ${copied.join(', ')})` : ''}`)
    }
    const cwd = path.join(worktree, rel)
    if (!fs.existsSync(cwd)) throw new WorktreeError(`${rel || '.'} does not exist in ${worktree} (is the agent folder committed on ${base ?? 'its branch'}?)`)
    return { cwd, worktree, repoRoot, created, base }
  })
}

/**
 * Remove a worktree unless a queued or running job still needs it. The check runs inside the same
 * lock creation takes, so it cannot race a job that is being launched into this worktree.
 */
export async function removeWorktree({ repoRoot, worktree, isBusy, log = console }) {
  return withLock(worktree, async () => {
    if (!fs.existsSync(worktree)) return { removed: false, reason: 'missing' }
    if (await isBusy()) return { removed: false, reason: 'job_pending' }
    try {
      await gitRetryingLocks(['worktree', 'remove', '--force', worktree], { cwd: repoRoot })
    } catch (err) {
      log.error?.(`[worktrees] git worktree remove ${worktree} failed: ${err.message}`)
      return { removed: false, reason: 'git_failed', error: err.message }
    }
    try { await gitRetryingLocks(['worktree', 'prune'], { cwd: repoRoot }) } catch {}
    log.error?.(`[worktrees] removed ${worktree}`)
    return { removed: true }
  })
}

/** Is any queued or running job for this task ref inside this repo? */
async function taskRefBusy(dbCall, repoRoot, dirName) {
  const active = await dbCall('listActiveTaskRefs')
  return active.some(row => worktreeDirName(row.task_ref) === dirName && isUnder(row.agent_path, repoRoot))
}

function isUnder(target, root) {
  let real = target
  try { real = fs.realpathSync(target) } catch {}
  const rel = path.relative(root, real)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** A task finished: drop its worktree from the repo that holds this agent folder. */
export async function removeTaskWorktree({ dbCall, agentPath, taskRef, log = console }) {
  const dirName = worktreeDirName(taskRef)
  if (!dirName || !agentPath || !fs.existsSync(agentPath)) return { removed: false, reason: 'unbound' }
  let repoRoot
  try { repoRoot = await repoRootFor(agentPath) } catch { return { removed: false, reason: 'not_a_repo' } }
  const worktree = path.join(repoRoot, WORKTREES_DIR, dirName)
  return removeWorktree({ repoRoot, worktree, log, isBusy: () => taskRefBusy(dbCall, repoRoot, dirName) })
}

/**
 * Periodic sweep: a worktree that has run nothing for `idleDays` goes, so an abandoned task does not
 * hold a checkout and its node_modules forever. Last activity comes from the jobs that ran there,
 * or the directory's mtime when none are recorded.
 */
export async function sweepIdleWorktrees({ dbCall, idleDays = 7, now = Date.now(), log = console }) {
  const summary = { checked: 0, removed: 0 }
  const agents = await dbCall('listWorktreeAgents')
  const roots = new Set()
  for (const agent of agents) {
    if (!fs.existsSync(agent.path)) continue
    try { roots.add(await repoRootFor(agent.path)) } catch {}
  }
  for (const repoRoot of roots) {
    const dir = path.join(repoRoot, WORKTREES_DIR)
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()) } catch { continue }
    for (const entry of entries) {
      summary.checked++
      const worktree = path.join(dir, entry.name)
      const last = await dbCall('lastJobActivityUnder', worktree)
      let lastMs = last ? Date.parse(`${String(last).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(last) ? '' : 'Z'}`) : NaN
      if (!Number.isFinite(lastMs)) {
        try { lastMs = fs.statSync(worktree).mtimeMs } catch { continue }
      }
      if (now - lastMs < idleDays * 86_400_000) continue
      const r = await removeWorktree({ repoRoot, worktree, log, isBusy: () => taskRefBusy(dbCall, repoRoot, entry.name) })
      if (r.removed) summary.removed++
    }
  }
  return summary
}
