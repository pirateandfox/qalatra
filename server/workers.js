import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { scanAgents } from './agents.js'
import { syncPendingAttachments } from './attachments.js'
import { getRuntime, isKnownRuntime, DEFAULT_RUNTIME, runtimeNames } from './agent-runtimes.js'
import { createAgentWatchdog } from './agent-watchdog.js'

const MAX_CONCURRENT_JOBS = 3
/** stderr is stored verbatim in job results, so keep it bounded on a long or noisy run. */
const MAX_STDERR = 256 * 1024
let runningJobs = 0

/** Live agent runs, so a server shutdown can take their scopes/process groups down with it. */
const runningAgentProcs = new Set()

// Lifecycle hooks for integrations (server/integrations/). Deliberately generic: an outside
// orchestrator learns that a job started, finished, or died with the instance without the job
// pipeline knowing who is listening. Hooks are best-effort — one that throws is logged and never
// affects the job or the other hooks.
const jobHooks = { started: new Set(), finished: new Set() }
export function onJobStarted(fn) { jobHooks.started.add(fn); return () => jobHooks.started.delete(fn) }
export function onJobFinished(fn) { jobHooks.finished.add(fn); return () => jobHooks.finished.delete(fn) }
async function runJobHooks(kind, payload) {
  for (const fn of jobHooks[kind]) {
    try { await fn(payload) }
    catch (err) { console.error(`[workers] ${kind} hook failed for job ${payload?.job?.id}: ${err.message}`) }
  }
}
// Jobs that were 'running' when the previous instance stopped, resolved once the boot-time sweep
// (resetStuckJobs) has marked them orphaned. Integrations await this to report them.
let resolveOrphanedAtBoot
export const orphanedAtBoot = new Promise(resolve => { resolveOrphanedAtBoot = resolve })

/**
 * Environment an orchestrator asked to inject alongside the reserved QALATRA_* names, carried in
 * agent_jobs.external_meta.env. Only conventional variable names and string values are accepted,
 * and the reserved prefix is refused so an orchestrator cannot override a Qalatra-owned variable.
 */
export function externalEnv(job) {
  let meta
  try { meta = job?.external_meta ? JSON.parse(job.external_meta) : null } catch { return {} }
  const env = meta?.env
  if (!env || typeof env !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || key.startsWith('QALATRA_')) continue
    if (typeof value !== 'string' && typeof value !== 'number') continue
    out[key] = String(value).slice(0, 4096)
  }
  return out
}

/**
 * Kill an agent run and everything it started.
 *
 * SIGKILL to the tracked pid is not enough. The login shell execs through to the agent CLI, so that
 * pid really is the agent — but the agent's own children (a test run, a build, an MCP server it
 * spawned) are reparented and keep running. Measured directly: killing the pid alone left the tool
 * subprocess alive and holding resources. On Linux/systemd, the named per-job scope is the durable
 * boundary: it still contains descendants that call setsid or double-fork. Other POSIX hosts use a
 * detached process group as the best available boundary, and Windows uses taskkill's tree walk.
 */
function killProcessTree(run) {
  const proc = run?.proc ?? run
  const scopeUnit = run?.scopeUnit ?? null
  if (!proc?.pid) return
  if (process.platform === 'win32') {
    // Windows has no process groups to signal; taskkill /T walks the child tree instead.
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    return
  }

  if (scopeUnit) {
    const killed = spawnSync(
      'systemctl',
      ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', scopeUnit],
      { encoding: 'utf8', timeout: 5_000 },
    )
    if (!killed.error && killed.status === 0) return
    const detail = killed.error?.message || String(killed.stderr || killed.stdout || '').trim() || `exit ${killed.status}`
    if (!/not loaded|not found|does not exist/i.test(detail)) {
      console.error(`[workers] scope kill failed for ${scopeUnit}: ${detail}; falling back to process-group kill`)
    }
  }

  try {
    process.kill(-proc.pid, 'SIGKILL')   // negative pid = the whole group from detached:true
    return
  } catch (err) {
    // ESRCH just means the group is already gone; anything else is worth a line before we fall back.
    if (err.code !== 'ESRCH') console.error(`[workers] group kill failed for pid ${proc.pid}: ${err.message}`)
  }
  try { proc.kill('SIGKILL') } catch {}
}

/**
 * Detached agents outlive the signal the service manager sends to Qalatra's own process group, so
 * shutdown has to take them down explicitly or a service restart strands live agent runs.
 */
export function killRunningAgentProcesses() {
  for (const proc of runningAgentProcs) killProcessTree(proc)
  runningAgentProcs.clear()
}

function defaultShell() {
  if (process.env.SHELL) return process.env.SHELL
  try {
    const userShell = os.userInfo().shell
    if (userShell) return userShell
  } catch {}
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/**
 * Place agent runs in their own cgroup slice.
 *
 * Qalatra Server, its MCP child, tmux sessions and every agent otherwise share one cgroup, and
 * `memory.high` throttles reclaim across the whole group without distinguishing the hog from its
 * neighbours — so one runaway agent starves the MCP endpoint while the box still looks healthy.
 * Measured on a live box: the server cgroup held the server, the MCP child, an agent's `claude`,
 * and a tmux session, all under one 6 GB limit.
 *
 * Probed rather than detected by platform, following ensureTmuxServer() in terminal-sessions.js:
 * systemd-run needs a live *user* manager and XDG_RUNTIME_DIR, not merely Linux. macOS, non-systemd
 * Linux and no-user-manager all fall back to today's exact spawn. Cached because a long-running
 * agent cannot retry the way spawnSync can, and this cannot change without the server restarting.
 *
 * The slice must also be given limits (MemoryHigh/MemoryMax) by the fleet — an unknown --slice= is
 * auto-created as transient with *no* limits, which places correctly but contains nothing.
 */
const AGENT_SLICE = 'qalatra-agents.slice'
const PER_AGENT_MEMORY_HIGH = '1G'
const PER_AGENT_MEMORY_MAX = '2G'

let systemdRunProbe = null
function systemdRunAvailable() {
  if (systemdRunProbe === null) {
    systemdRunProbe = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { stdio: 'ignore' }).status === 0
  }
  return systemdRunProbe
}

/**
 * Is the slice a real unit with a finite ceiling?
 *
 * This is the safety interlock. systemd auto-creates an unknown --slice= with NO limits, so using
 * the launcher before the fleet has installed the slice would move agents OUT of the server's capped
 * cgroup and into an uncapped one — protecting the MCP endpoint but leaving a runaway agent
 * completely unbounded, which is a worse blast radius than not doing this at all. Placement without
 * limits is strictly worse than staying put, so refuse it.
 *
 * Deliberately NOT cached: the fleet installs the slice while the server is running, and this answer
 * must be free to change from no to yes without waiting for a restart. One `systemctl show` per job
 * launch, against a job that then runs for minutes.
 */
function agentSliceIsBounded() {
  const shown = spawnSync('systemctl', ['--user', 'show', AGENT_SLICE, '-p', 'MemoryMax', '--value'], { encoding: 'utf8' })
  if (shown.status !== 0) return false
  const value = String(shown.stdout ?? '').trim()
  return value !== '' && value !== 'infinity'
}

let lastLauncherState = null
function agentScopeUnit(jobId) {
  const safeId = String(jobId).replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 180)
  return `qalatra-agent-${safeId}.scope`
}

export function buildSystemdAgentLauncher(jobId) {
  const scopeUnit = agentScopeUnit(jobId)
  return {
    scopeUnit,
    args: [
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--unit=${scopeUnit}`,
      `--slice=${AGENT_SLICE}`,
      `--property=MemoryHigh=${PER_AGENT_MEMORY_HIGH}`,
      `--property=MemoryMax=${PER_AGENT_MEMORY_MAX}`,
      '--property=OOMPolicy=kill',
    ],
  }
}

function agentLauncher(jobId) {
  let reason = null
  if (!systemdRunAvailable()) reason = 'no systemd user manager'
  else if (!agentSliceIsBounded()) reason = `${AGENT_SLICE} has no memory ceiling — agents stay in the server cgroup, which is at least bounded`
  if (reason !== lastLauncherState) {
    console.error(reason ? `[workers] agent slice isolation off: ${reason}` : `[workers] agent slice isolation on: ${AGENT_SLICE}`)
    lastLauncherState = reason
  }
  if (reason) return { args: [], scopeUnit: null }

  return buildSystemdAgentLauncher(jobId)
}

/**
 * Wrap a spawn in a deterministic per-job scope when the launcher is available. The name is known
 * before spawn, so the watchdog can kill the scope even after the tracked agent pid has disappeared.
 * A per-scope ceiling limits one run independently of its siblings in the shared agent slice.
 */
function withLauncher(command, args, jobId) {
  const launcher = agentLauncher(jobId)
  return launcher.args.length
    ? { command: launcher.args[0], args: [...launcher.args.slice(1), command, ...args], scopeUnit: launcher.scopeUnit }
    : { command, args, scopeUnit: null }
}

function shellQuote(value) {
  if (process.platform === 'win32') {
    return `"${String(value).replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function compactTemplateValue(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ')
}

const TEMPLATE_PLACEHOLDERS = ['spec_file', 'description', 'title']

/**
 * An agent.config `command` is either a shell string (run through the login shell, so `$(…)`,
 * `cd`, `&&` all work and quoting is the author's problem) or an argv array (spawned directly, no
 * shell, so there is no quoting to get wrong). Placeholders are recognised in both forms.
 */
export function isArgvCommand(command) {
  return Array.isArray(command)
}

/** Returns a reason string when an argv command cannot be spawned, else null. */
export function argvCommandError(command) {
  if (!Array.isArray(command)) return null
  if (command.length === 0) return 'agent.config "command" array is empty'
  const bad = command.findIndex(part => typeof part !== 'string' || part.length === 0)
  if (bad !== -1) return `agent.config "command" array element ${bad} must be a non-empty string`
  return null
}

function commandMentions(command, text) {
  const parts = Array.isArray(command) ? command : [String(command)]
  return parts.some(part => String(part).includes(text))
}

export function commandHasPlaceholder(command) {
  return TEMPLATE_PLACEHOLDERS.some(name => commandMentions(command, `{${name}}`))
}

/**
 * Substitute placeholders into an argv array. Each element is a single argument, so the value is
 * spliced in verbatim — no shell quoting, no newline flattening — and `--prompt={description}`
 * style embedding works the same as a bare `{description}` element.
 */
export function resolveArgvTemplate(argv, values, { onWarn = console.error } = {}) {
  return argv.map(part => {
    let out = part
    for (const name of TEMPLATE_PLACEHOLDERS) {
      const placeholder = `{${name}}`
      if (!out.includes(placeholder)) continue
      // A quote hugging the placeholder is almost always a shell-string config ported over
      // literally; in argv form the quotes are delivered to the agent as part of the value.
      if (out.includes(`'${placeholder}'`) || out.includes(`"${placeholder}"`)) {
        onWarn(`argv elements are not shell-parsed: the quotes around ${placeholder} will reach the command literally; use a bare ${placeholder} element instead`)
      }
      out = out.replaceAll(placeholder, String(values[name] ?? ''))
    }
    return out
  })
}

/**
 * Login-shell wrapper for an argv spawn. The shell only supplies the user's profile (PATH and
 * friends); the argv is handed through `"$0" "$@"` untouched, so nothing in it is re-parsed.
 */
function loginShellArgv(bin, args) {
  return ['-i', '-l', '-c', '"$0" "$@"', bin, ...args]
}

/**
 * Task values are exposed to every agent run as environment variables, so a shell-string command
 * can write `--description "$QALATRA_DESCRIPTION"` and keep its shell features without the value
 * ever entering the command text. Capped well under the per-string environment limit so a huge
 * task description cannot turn into an E2BIG spawn failure for an agent that never asked for it.
 */
const MAX_TEMPLATE_ENV_VALUE = 64 * 1024

function envValue(value) {
  const text = String(value ?? '')
  return text.length > MAX_TEMPLATE_ENV_VALUE
    ? `${text.slice(0, MAX_TEMPLATE_ENV_VALUE)}\n[… truncated to ${MAX_TEMPLATE_ENV_VALUE} characters]`
    : text
}

export function templateEnv({ job, values }) {
  const env = {
    QALATRA_JOB_ID: String(job.id),
    QALATRA_TITLE: envValue(values.title),
    QALATRA_DESCRIPTION: envValue(values.description),
  }
  if (job.task_id) env.QALATRA_TASK_ID = String(job.task_id)
  if (values.spec_file) env.QALATRA_SPEC_FILE = values.spec_file
  return env
}

export function replaceShellPlaceholder(command, name, value, { onWarn = console.error } = {}) {
  const quoted = shellQuote(compactTemplateValue(value))
  const exactReplaced = command
    .replaceAll(`'{${name}}'`, quoted)
    .replaceAll(`"{${name}}"`, quoted)

  // Bare placeholders are supported for compatibility, but a quote immediately before one after
  // the exact quote-delimited forms have been consumed means the author almost certainly appended
  // text inside the quote. Inserting our already-shell-quoted value there closes that quote early
  // and can reduce a multi-word prompt to its first bare word.
  const placeholder = `{${name}}`
  let offset = exactReplaced.indexOf(placeholder)
  while (offset !== -1) {
    const openingQuote = exactReplaced[offset - 1]
    if ((openingQuote === "'" || openingQuote === '"') && exactReplaced[offset + placeholder.length] !== openingQuote) {
      onWarn(`unsafe quoted {${name}} placeholder: the opening ${openingQuote} is not immediately closed after the placeholder; keep ${openingQuote}{${name}}${openingQuote} exact and concatenate extra text outside it, reference "$QALATRA_${name.toUpperCase()}" instead, or switch "command" to an argv array`)
    }
    offset = exactReplaced.indexOf(placeholder, offset + placeholder.length)
  }

  return exactReplaced.replaceAll(placeholder, quoted)
}

function validEnvName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

function expandEnvValue(value, env) {
  const home = env.HOME || os.homedir()
  return String(value)
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => env[key] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => env[key] ?? '')
}

function envMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function buildAgentEnv(settings, cfg, shellBin) {
  const env = { ...process.env }
  if (!env.HOME) env.HOME = os.homedir()
  try {
    const user = os.userInfo()
    if (!env.USER && user.username) env.USER = user.username
    if (!env.LOGNAME && user.username) env.LOGNAME = user.username
  } catch {}
  if (!env.SHELL && shellBin) env.SHELL = shellBin

  const configured = { ...envMap(settings.agentEnv), ...envMap(cfg?.env) }
  for (const [key, value] of Object.entries(configured)) {
    if (!validEnvName(key)) continue
    if (value === null) {
      delete env[key]
    } else {
      env[key] = expandEnvValue(value, env)
    }
  }
  return env
}

function pathState(target) {
  try {
    const stat = fs.statSync(target)
    if (stat.isDirectory()) return 'directory'
    if (stat.isFile()) return 'file'
    return 'exists'
  } catch {
    return 'missing'
  }
}

function presentEnvMarkers(env) {
  return [
    'CLAUDECODE',
    'AI_AGENT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'CODEX_HOME',
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
  ].filter(key => env[key] !== undefined)
}

/** Render an argv command the way a shell user would read it, so the sanitizer's flag patterns still apply. */
function describeCommand(command) {
  if (!Array.isArray(command)) return String(command)
  return command.map(part => (/[\s"'\\]/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

function sanitizeCommand(command) {
  return describeCommand(command)
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS)[A-Za-z0-9_]*=)([^ \t]+)/gi, '$1[redacted]')
    .replace(/(--(?:api-?key|token|secret|password|pass)\s+)([^ \t]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/[^:\s/]+:)[^@\s/]+@/gi, '$1[redacted]@')
}

export function commandDiagnosticLines(agentCommand, resolvedCommand = null) {
  const lines = [`- command template: ${sanitizeCommand(agentCommand)}`]
  if (resolvedCommand != null) lines.push(`- resolved command: ${sanitizeCommand(resolvedCommand)}`)
  return lines
}

/**
 * A resumed CLI session already contains the prompt and conversation from its earlier turns.
 * Re-sending job.prompt duplicates that history in one argv entry; task notes make it grow without
 * bound and can eventually exceed the operating system's per-argument limit before the CLI starts.
 * Explicit human feedback is the next turn. Scheduled/manual re-runs without feedback get only a
 * compact instruction to inspect the live task, whose id is already part of the resumed session.
 */
export function resumeMessageForJob(job) {
  if (typeof job?.user_message === 'string' && job.user_message.trim()) return job.user_message
  if (job?.task_id) {
    return `Continue working on Qalatra task ${job.task_id} from the existing session. Check the task and its notes in Qalatra for updates since your previous run, then act on the current instructions.`
  }
  return 'Continue from the existing session and carry out the current run.'
}

function commandLookup(shellBin, env, cwd) {
  if (process.platform === 'win32') return null
  const script = [
    'printf "login_user=%s\\n" "$(id -un 2>/dev/null || whoami 2>/dev/null || true)"',
    'printf "login_home=%s\\n" "$HOME"',
    'printf "login_shell=%s\\n" "$SHELL"',
    'printf "claude_path=%s\\n" "$(command -v claude 2>/dev/null || true)"',
    'printf "flightdesk_path=%s\\n" "$(command -v flightdesk 2>/dev/null || true)"',
    'printf "script_path=%s\\n" "$(command -v script 2>/dev/null || true)"',
    'printf "claude_version=%s\\n" "$(claude --version 2>/dev/null | head -n 1 || true)"',
  ].join('; ')
  try {
    const result = spawnSync(shellBin, ['-i', '-l', '-c', script], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
    return output ? output.slice(0, 4000) : null
  } catch (err) {
    return `lookup_error=${err.message}`
  }
}

function launchDiagnostics({ cwd, shellBin, env, agentCommand, resolvedCommand, commandMode, runtimeName }) {
  const home = env.HOME || os.homedir()
  const markers = presentEnvMarkers(env)
  const lines = [
    'Launch diagnostics (sanitized):',
    `- cwd: ${cwd}`,
    `- user: ${env.USER || env.LOGNAME || '(unset)'}`,
    `- uid: ${process.getuid ? process.getuid() : '(n/a)'}`,
    `- home: ${home}`,
    `- shell: ${shellBin}`,
    `- command mode: ${commandMode}`,
    `- runtime: ${runtimeName || DEFAULT_RUNTIME}`,
    // Whether the run was placed in its own cgroup slice. If this says "none", agents share the
    // server's cgroup and one runaway can still throttle the MCP endpoint.
    `- launcher: ${launcherDescription()}`,
    ...commandDiagnosticLines(agentCommand, resolvedCommand),
    `- PATH: ${env.PATH || '(unset)'}`,
  ]
  // Only surface the config paths that belong to the runtime that actually failed; dumping Claude's
  // paths for a broken Codex agent sends you looking in the wrong place.
  if (runtimeName === 'codex') {
    const codexHome = env.CODEX_HOME || path.join(home, '.codex')
    lines.push(`- CODEX_HOME: ${env.CODEX_HOME || `(unset; default ${codexHome})`}`)
    lines.push(`- Codex config dir: ${pathState(codexHome)} (${codexHome})`)
    lines.push(`- codex config.toml: ${pathState(path.join(codexHome, 'config.toml'))}`)
  } else {
    const anthropicConfigDir = env.ANTHROPIC_CONFIG_DIR || path.join(home, '.claude')
    lines.push(`- ANTHROPIC_CONFIG_DIR: ${env.ANTHROPIC_CONFIG_DIR || `(unset; default ${anthropicConfigDir})`}`)
    lines.push(`- Claude config dir: ${pathState(anthropicConfigDir)} (${anthropicConfigDir})`)
    lines.push(`- ~/.claude.json: ${pathState(path.join(home, '.claude.json'))}`)
  }
  lines.push(`- token/env markers present: ${markers.length ? markers.join(', ') : 'none'}`)
  const lookup = commandLookup(shellBin, env, cwd)
  if (lookup) lines.push(`- login-shell lookup:\n${lookup}`)
  return lines.join('\n')
}

function launcherDescription() {
  const launcher = agentLauncher('<job-id>')
  return launcher.args.length ? launcher.args.join(' ') : `none (agents share the server cgroup; ${AGENT_SLICE} not installed or unbounded)`
}

function appendLaunchDiagnostics(result, context) {
  const diagnostics = launchDiagnostics(context)
  return `${result || ''}\n\n${diagnostics}`.trim()
}

export function findLastOutputRuleMatch(output, pattern) {
  const regex = new RegExp(pattern, 'g')
  let lastMatch = null
  for (const match of String(output ?? '').matchAll(regex)) lastMatch = match
  return lastMatch
}

export async function applyOutputRules({ dbCall, jobId, taskId, rules, output, logger = console }) {
  if (!taskId || !Array.isArray(rules) || rules.length === 0) return

  for (const [index, rule] of rules.entries()) {
    try {
      if (!rule?.pattern) continue
      const match = findLastOutputRuleMatch(output, rule.pattern)
      if (!match) continue

      if (rule.action === 'add_link' && rule.url) {
        const url = rule.url.replace(/\{(\d+)\}/g, (_, group) => match[Number(group)] ?? '')
        if (url) await dbCall('addTaskLink', taskId, url)
      } else if (rule.action === 'set_field' && rule.field) {
        const value = match[rule.group ?? 1] ?? match[0]
        if (value) await dbCall('updateTask', taskId, { [rule.field]: value })
      }
    } catch (err) {
      logger.error(`[workers] output rule ${index + 1} failed for job ${jobId}: ${err.message}`)
    }
  }
}

export function startBackgroundWorkers(ctx) {
  const { dbCall, loadSettings, notify = () => {}, startedAt = null } = ctx
  // Pass this instance's start time as the orphan "restart boundary": any job still 'running'
  // was killed when the previous instance stopped, and the consumer can compare a late cloud
  // reply's timestamp against this to tell whether the job's work landed before or after death.
  dbCall('resetStuckJobs', startedAt)
    .then(r => resolveOrphanedAtBoot(Array.isArray(r?.orphaned) ? r.orphaned : []))
    .catch(() => resolveOrphanedAtBoot([]))
  syncPendingAttachments(ctx).catch(() => {})
  runAgentScan({ dbCall, loadSettings }).catch(() => {})
  setInterval(() => syncPendingAttachments(ctx).catch(() => {}), 5 * 60 * 1000)
  setInterval(() => processAgentJobs({ dbCall, loadSettings, notify }).catch(() => {}), 30_000)
  setInterval(() => autoRunAgents({ dbCall }).catch(() => {}), 5 * 60_000)
  setTimeout(() => runDueHeartbeats({ dbCall }).catch(() => {}), 5_000)
  setInterval(() => runDueHeartbeats({ dbCall }).catch(() => {}), 60_000)
}

export async function runAgentScan({ dbCall, loadSettings }) {
  const settings = loadSettings()
  const excludeFolders = (settings.agentExcludeFolders ?? '').split(',').map(f => f.trim()).filter(Boolean)
  const root = settings.agentsRoot || settings.terminalCwd || process.env.HOME
  if (!root) return []
  const agents = await scanAgents(root, excludeFolders)
  await dbCall('upsertAgents', agents)
  return agents
}

// Why a job did not end 'done', in terms an orchestrator can act on. `error` is the agent's own
// failure; the others are Qalatra's limits or infrastructure and should not count against the agent.
export function diagnosticsKindFor({ status, failureKind = null }) {
  if (status === 'done') return null
  if (status === 'timed_out') return 'timed_out'
  if (status === 'orphaned') return 'orphaned'
  return failureKind || 'error'
}

export async function finishAgentJobSafely({ dbCall, notify, job, status, result, sessionId, terminatedBy = null, usage = null, mcpToolCalls = null, outputRules = [], failureKind = null }) {
  try {
    await dbCall('finishAgentJob', job.id, status, result, sessionId, terminatedBy, usage, mcpToolCalls)
  } catch (err) {
    console.error(`[workers] failed to persist agent job ${job.id}: ${err.message}`)
    return
  }

  await runJobHooks('finished', {
    job, status, result, sessionId, terminatedBy,
    diagnostics: { kind: diagnosticsKindFor({ status, failureKind }), resumable: Boolean(sessionId) },
  })

  if (status === 'done' && job.task_id) {
    try {
      const noteResult = await dbCall('insertAgentNote', uuidv4(), job.task_id, result, job.id)
      if (noteResult?.auto_attach_error) {
        console.error(`[workers] auto-attach failed for job ${job.id}: ${noteResult.auto_attach_error}`)
      }
    } catch (err) {
      console.error(`[workers] failed to insert agent note for job ${job.id}: ${err.message}`)
    }

    await applyOutputRules({
      dbCall,
      jobId: job.id,
      taskId: job.task_id,
      rules: outputRules,
      output: result,
    })
  }

  try {
    notify({ type: 'agent-job:complete', taskId: job.task_id, jobId: job.id })
  } catch (err) {
    console.error(`[workers] failed to publish agent completion for job ${job.id}: ${err.message}`)
  }
}

async function processAgentJobs({ dbCall, loadSettings, notify }) {
  if (runningJobs >= MAX_CONCURRENT_JOBS) return
  const jobs = await dbCall('getQueuedJobs', MAX_CONCURRENT_JOBS - runningJobs)
  const settings = loadSettings()

  for (const job of jobs) {
    runningJobs++
    // Atomic claim (bug C6): skip the job if another worker/instance already took it.
    // Guarded (bug C21): a rejected dbCall here (e.g. SQLITE_BUSY/IO) must decrement the slot,
    // otherwise the increment above leaks a permanent concurrency slot and eventually wedges the
    // whole worker (runningJobs never falls back below MAX_CONCURRENT_JOBS).
    let claim
    try {
      claim = await dbCall('startAgentJob', job.id)
    } catch (err) {
      runningJobs--
      console.error(`[workers] failed to claim agent job ${job.id}: ${err.message}`)
      continue
    }
    if (claim && claim.claimed === false) {
      runningJobs--
      continue
    }

    if (!fs.existsSync(job.agent_path)) {
      runningJobs--
      await finishAgentJobSafely({ dbCall, notify, job, status: 'failed', result: `Agent path does not exist: ${job.agent_path}`, sessionId: null, failureKind: 'launch_failed' })
      continue
    }

    let agentCommand = settings.defaultAgentCommand || 'claude --dangerously-skip-permissions'
    let cfg = null
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(job.agent_path, 'agent.config'), 'utf8'))
      if (cfg.command) agentCommand = cfg.command
    } catch {}

    if (cfg?.coding && job.task_id) {
      // Non-fatal + guarded (bug C21): a rejection here must not escape the loop and leak the
      // slot; the job can still run without the coding-type update.
      try { await dbCall('updateTask', job.task_id, { task_type: 'coding' }) }
      catch (err) { console.error(`[workers] failed to set coding type for job ${job.id}: ${err.message}`) }
    }

    const argvError = argvCommandError(agentCommand)
    if (argvError) {
      runningJobs--
      await finishAgentJobSafely({ dbCall, notify, job, status: 'failed', result: `${argvError} (${job.agent_path})`, sessionId: null, failureKind: 'launch_failed' })
      continue
    }

    const shellBin = defaultShell()
    const agentEnv = buildAgentEnv(settings, cfg, shellBin)
    const argvCommand = isArgvCommand(agentCommand)
    const isTemplateCommand = commandHasPlaceholder(agentCommand)
    const commandMode = isTemplateCommand ? (argvCommand ? 'template (argv)' : 'template (shell)') : 'prompt'

    if (cfg?.runtime != null && !isKnownRuntime(cfg.runtime)) {
      console.error(`[workers] agent ${job.agent_path} declares unknown runtime "${cfg.runtime}"; falling back to ${DEFAULT_RUNTIME} (known: ${runtimeNames().join(', ')})`)
    }
    // Template commands run verbatim, so no runtime owns their argv. Their output still goes through
    // the claude adapter's non-streaming parser, which is the lenient one (structured result if the
    // command happens to emit Claude JSON, raw stdout otherwise) — exactly what they relied on before.
    const runtimeName = isTemplateCommand ? DEFAULT_RUNTIME : cfg?.runtime
    const runtime = getRuntime(runtimeName)
    // Recorded for display. A template command isn't driven by a CLI adapter at all, so it reports
    // 'raw' rather than claiming to be a Claude job just because it borrows that parser.
    const resolvedRuntime = isTemplateCommand ? 'raw' : (isKnownRuntime(runtimeName) ? runtimeName : DEFAULT_RUNTIME)
    // Best-effort: surfacing which CLI ran a job is useful but never worth failing the job over.
    try { await dbCall('setAgentJobRuntime', job.id, resolvedRuntime) }
    catch (err) { console.error(`[workers] failed to record runtime for job ${job.id}: ${err.message}`) }
    // Template commands emit whatever they emit, so they can't be stream-parsed.
    const stream = isTemplateCommand ? false : cfg?.stream !== false
    const consumer = runtime.createConsumer({ stream })
    let stderr = ''
    let watchdog = null
    let watchdogArmError = null
    let idleMinutes = 0
    let bumpIdle = () => {}
    let settled = false
    let proc
    let scopeUnit = null
    let promptFile = null
    let specFile = null
    let resolvedCommand = null
    let bin = ''
    let spawnArgs = []

    try {
      const onTemplateWarn = message => console.error(`[workers] job ${job.id} template warning: ${message}`)
      const task = job.task_id ? await dbCall('getTask', job.task_id) : null
      const values = {
        title: task?.title ?? '',
        description: task?.description ?? job.user_message ?? '',
      }
      if (commandMentions(agentCommand, '{spec_file}') || commandMentions(agentCommand, 'QALATRA_SPEC_FILE')) {
        // Per-job spec filename (bug C13): a fixed spec.md is clobbered when two jobs for the
        // same agent land in one batch (they spawn back-to-back without awaiting), so job 1's
        // shell reads job 2's spec. A unique name per job keeps them isolated.
        const specName = `spec-${job.id}.md`
        const specPath = path.join(job.agent_path, specName)
        fs.writeFileSync(specPath, job.prompt, 'utf8')
        specFile = specPath
        values.spec_file = `./${specName}`
      }
      // Reserved names: set after buildAgentEnv so an agent.config `env` entry cannot shadow them.
      Object.assign(agentEnv, templateEnv({ job, values }))
      Object.assign(agentEnv, externalEnv(job))

      if (isTemplateCommand && argvCommand) {
        // Argv form: every element is one argument, spawned without a shell. Placeholder values
        // land as (parts of) argv entries, so there is no quoting for an author to get wrong.
        const argv = resolveArgvTemplate(agentCommand, values, { onWarn: onTemplateWarn })
        resolvedCommand = argv
        bin = argv[0]
        spawnArgs = argv.slice(1)
        proc = process.platform === 'win32'
          ? spawn(bin, spawnArgs, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv })
          : (() => {
            const launched = withLauncher(shellBin, loginShellArgv(bin, spawnArgs), job.id)
            scopeUnit = launched.scopeUnit
            return spawn(launched.command, launched.args, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv, detached: true })
          })()
      } else if (isTemplateCommand) {
        resolvedCommand = agentCommand
        if (values.spec_file) resolvedCommand = resolvedCommand.replace(/\{spec_file\}/g, values.spec_file)
        for (const name of ['description', 'title']) {
          if (!agentCommand.includes(`{${name}}`)) continue
          resolvedCommand = replaceShellPlaceholder(resolvedCommand, name, values[name], { onWarn: onTemplateWarn })
        }
        bin = shellBin
        spawnArgs = ['-i', '-l', '-c', resolvedCommand]
        proc = process.platform === 'win32'
          ? spawn('cmd.exe', ['/c', resolvedCommand], { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv })
          : (() => {
            const launched = withLauncher(shellBin, spawnArgs, job.id)
            scopeUnit = launched.scopeUnit
            return spawn(launched.command, launched.args, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv, detached: true })
          })()
      } else {
        const parts = argvCommand ? agentCommand : agentCommand.trim().split(/\s+/)
        bin = parts[0]
        const baseArgs = parts.slice(1)
        let promptArg = job.prompt
        if (process.platform === 'win32' && !job.prevSessionId) {
          promptFile = path.join(os.tmpdir(), `qalatra-prompt-${job.id}.txt`)
          fs.writeFileSync(promptFile, job.prompt, 'utf8')
          promptArg = `"Read and follow the instructions in the file: ${promptFile}"`
        }
        spawnArgs = runtime.buildArgs({
          baseArgs,
          prompt: promptArg,
          // --resume restores the prior transcript provider-side. Only the new turn belongs here;
          // job.prompt contains the complete task-note history and must never be replayed.
          resumeMessage: resumeMessageForJob(job),
          resumeId: job.prevSessionId || null,
          stream,
          onWarn: message => console.error(`[workers] job ${job.id} (${runtimeName || DEFAULT_RUNTIME}): ${message}`),
        })
        proc = process.platform === 'win32'
          ? spawn(bin, spawnArgs, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], shell: true, env: agentEnv })
          : (() => {
            // The -c '"$0" "$@"' bin ...args structure must survive intact — the args are
            // deliberately not re-parsed by the shell — so the launcher wraps the whole shell
            // invocation rather than being folded into the -c payload. bin/spawnArgs stay the
            // agent's own, so launch diagnostics keep reporting the agent, not systemd-run.
            const launched = withLauncher(shellBin, loginShellArgv(bin, spawnArgs), job.id)
            scopeUnit = launched.scopeUnit
            return spawn(launched.command, launched.args, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv, detached: true })
          })()
      }
    } catch (spawnErr) {
      runningJobs--
      if (promptFile) { try { fs.unlinkSync(promptFile) } catch {} }
      if (specFile) { try { fs.unlinkSync(specFile) } catch {} }
      const result = appendLaunchDiagnostics(
        `Failed to start agent: ${spawnErr.message}\n\nCommand: ${bin} ${spawnArgs.slice(0, 2).join(' ')}`,
        { cwd: job.agent_path, shellBin, env: agentEnv, agentCommand, resolvedCommand, commandMode, runtimeName },
      )
      await finishAgentJobSafely({ dbCall, notify, job, status: 'failed', result, sessionId: null, failureKind: 'launch_failed' })
      continue
    }

    const runHandle = { proc, scopeUnit }
    runningAgentProcs.add(runHandle)
    // The process is up: this is the moment an orchestrator should see RUNNING.
    void runJobHooks('started', { job })

    // stderr stays whole-buffered (it is small and used verbatim in failure messages) but is
    // capped so a runaway agent logging to stderr for an hour can't exhaust the worker.
    const appendStderr = d => {
      if (stderr.length >= MAX_STDERR) return
      stderr = (stderr + d).slice(0, MAX_STDERR)
    }
    proc.stdout.on('data', d => { consumer.push(d); bumpIdle() })
    proc.stderr.on('data', d => { appendStderr(d); bumpIdle() })
    // 15 minutes was too tight for a modern coding agent, but a hung job holds one of only
    // MAX_CONCURRENT_JOBS slots for the whole window, so this stays bounded. 60 sits just above the
    // 45 that every deliberately-configured agent here settled on. Override with timeout_minutes.
    const timeoutMinutes = cfg?.timeout_minutes ?? 60
    // Opt-in second limit: a wall clock can't tell a productive 50-minute run from one wedged after
    // 90 seconds, but streamed output can. Left off by default because a single long tool call
    // (a full test suite, a big build) legitimately emits nothing for a while.
    idleMinutes = Number(cfg?.idle_timeout_minutes) || 0
    try {
      watchdog = createAgentWatchdog({
        pid: proc.pid,
        scopeUnit,
        wallClockMs: timeoutMinutes * 60 * 1000,
        idleTimeoutMs: idleMinutes * 60 * 1000,
        label: job.id,
      })
    } catch (err) {
      // Running without the configured safety boundary is worse than failing this one job visibly.
      watchdogArmError = err.message
      killProcessTree(runHandle)
      console.error(`[workers] ${err.message}`)
    }
    bumpIdle = () => watchdog?.activity()

    proc.on('close', code => {
      if (settled) return
      settled = true
      const timeoutKind = watchdog?.timeoutKind ?? null
      watchdog?.cancel()
      // The tracked command can exit while a daemonized tool remains in the scope with closed
      // stdio. Reap any such remainder on every terminal path, not only when the watchdog fired.
      if (scopeUnit) killProcessTree(runHandle)
      runningAgentProcs.delete(runHandle)
      runningJobs--
      if (promptFile) { try { fs.unlinkSync(promptFile) } catch {} }
      if (specFile) { try { fs.unlinkSync(specFile) } catch {} }

      let { result, sessionId, usage, mcpToolCalls } = consumer.finish()

      // A timeout is Qalatra's own limit cutting off an agent that was still working — a resource
      // event, not an agent failure — so it gets its own terminal status alongside `orphaned`
      // rather than polluting failure counts. Streaming means sessionId survives the kill, so
      // these stay resumable (see the resume lookup in db-worker.js).
      const status = watchdogArmError ? 'failed' : (timeoutKind ? 'timed_out' : (code === 0 ? 'done' : 'failed'))
      const timeoutNotice = timeoutKind === 'idle'
        ? `Agent killed after ${idleMinutes} minutes with no output (idle_timeout_minutes).`
        : `Agent timed out after ${timeoutMinutes} minutes (set timeout_minutes in agent.config to raise it).`
      if (watchdogArmError) {
        result = `${watchdogArmError}\n\nThe agent was stopped rather than allowed to run without its configured timeout.${stderr.trim() ? '\n\nStderr:\n' + stderr.trim() : ''}`
      } else if (timeoutKind) {
        const partial = result ? `\n\nPartial output before the kill:\n${result}` : ''
        const resumable = sessionId ? `\n\nSession ${sessionId} is resumable — send a follow-up message on this task to continue it.` : ''
        result = `${timeoutNotice}${resumable}${partial}${stderr.trim() ? '\n\nStderr:\n' + stderr.trim() : ''}`
      } else if (!result) {
        result = stderr.trim() || `No output (exit code ${code})`
      } else if (status === 'failed' && stderr.trim()) {
        result += `\n\nStderr:\n${stderr.trim()}`
      }
      if (status === 'failed') {
        result = appendLaunchDiagnostics(result, {
          cwd: job.agent_path,
          shellBin,
          env: agentEnv,
          agentCommand,
          resolvedCommand,
          commandMode,
          runtimeName,
        })
      }

      finishAgentJobSafely({ dbCall, notify, job, status, result, sessionId, terminatedBy: timeoutKind ? 'timeout' : null, usage, mcpToolCalls, outputRules: cfg?.output_rules })
        .catch(err => console.error(`[workers] agent completion handler failed for job ${job.id}: ${err.message}`))
    })

    proc.on('error', err => {
      if (settled) return
      settled = true
      watchdog?.cancel()
      if (scopeUnit) killProcessTree(runHandle)
      runningAgentProcs.delete(runHandle)
      runningJobs--
      if (promptFile) { try { fs.unlinkSync(promptFile) } catch {} }
      if (specFile) { try { fs.unlinkSync(specFile) } catch {} }
      const result = appendLaunchDiagnostics(
        `Failed to start agent: ${err.message}\n\nCommand: ${bin} ${spawnArgs.slice(0, 2).join(' ')}`,
        { cwd: job.agent_path, shellBin, env: agentEnv, agentCommand, resolvedCommand, commandMode, runtimeName },
      )
      finishAgentJobSafely({ dbCall, notify, job, status: 'failed', result, sessionId: null, failureKind: 'launch_failed' })
        .catch(err => console.error(`[workers] agent error handler failed for job ${job.id}: ${err.message}`))
    })
  }
}

async function autoRunAgents({ dbCall }) {
  const tasks = await dbCall('getAutorunTasks')
  for (const task of tasks) {
    await dbCall('createAgentJob', task.id, null)
  }
}

async function runDueHeartbeats({ dbCall }) {
  const due = await dbCall('getDueHeartbeats')
  for (const hb of due) {
    await dbCall('createHeartbeatJob', hb.id)
    await dbCall('markHeartbeatRun', hb.id, hb.interval_minutes, hb.run_at_time ?? null, hb.minute_offset ?? null)
  }
}
