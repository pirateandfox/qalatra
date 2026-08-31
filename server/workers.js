import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { scanAgents } from './agents.js'
import { syncPendingAttachments } from './attachments.js'
import { getRuntime, isKnownRuntime, DEFAULT_RUNTIME, runtimeNames } from './agent-runtimes.js'

const MAX_CONCURRENT_JOBS = 3
/** stderr is stored verbatim in job results, so keep it bounded on a long or noisy run. */
const MAX_STDERR = 256 * 1024
let runningJobs = 0

/** Live agent processes, so a server shutdown can take their process groups down with it. */
const runningAgentProcs = new Set()

/**
 * Kill an agent run and everything it started.
 *
 * SIGKILL to the tracked pid is not enough. The login shell execs through to the agent CLI, so that
 * pid really is the agent — but the agent's own children (a test run, a build, an MCP server it
 * spawned) are reparented and keep running. Measured directly: killing the pid alone left the tool
 * subprocess alive and holding resources. Agents are therefore spawned detached, which puts the run
 * in its own process group, and a negative pid signals every descendant at once.
 */
function killProcessTree(proc) {
  if (!proc?.pid) return
  if (process.platform === 'win32') {
    // Windows has no process groups to signal; taskkill /T walks the child tree instead.
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    return
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
let agentLauncherCache = null
function agentLauncher() {
  if (agentLauncherCache) return agentLauncherCache
  const probe = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'true'], { stdio: 'ignore' })
  agentLauncherCache = probe.status === 0
    ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--slice=qalatra-agents.slice']
    : []
  return agentLauncherCache
}

/**
 * Wrap a spawn in the launcher when one is available. Verified on a live box that `--scope` execs
 * through rather than staying resident, so the tracked pid remains the agent's own shell and stays
 * the leader of its process group: killProcessTree's negative-pid kill reaps the whole scope
 * unchanged, and no scope-stop path is needed. Measured with a shell → agent → tool-subprocess tree,
 * three cgroup members before, zero after.
 */
function withLauncher(command, args) {
  const launcher = agentLauncher()
  return launcher.length ? { command: launcher[0], args: [...launcher.slice(1), command, ...args] } : { command, args }
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

function replaceShellPlaceholder(command, name, value) {
  const quoted = shellQuote(compactTemplateValue(value))
  return command
    .replaceAll(`'{${name}}'`, quoted)
    .replaceAll(`"{${name}}"`, quoted)
    .replaceAll(`{${name}}`, quoted)
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

function sanitizeCommand(command) {
  return String(command)
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS)[A-Za-z0-9_]*=)([^ \t]+)/gi, '$1[redacted]')
    .replace(/(--(?:api-?key|token|secret|password|pass)\s+)([^ \t]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/[^:\s/]+:)[^@\s/]+@/gi, '$1[redacted]@')
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

function launchDiagnostics({ cwd, shellBin, env, agentCommand, commandMode, runtimeName }) {
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
    `- launcher: ${agentLauncher().length ? agentLauncher().join(' ') : 'none (agents share the server cgroup)'}`,
    `- command template: ${sanitizeCommand(agentCommand)}`,
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
  dbCall('resetStuckJobs', startedAt).catch(() => {})
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

export async function finishAgentJobSafely({ dbCall, notify, job, status, result, sessionId, terminatedBy = null, outputRules = [] }) {
  try {
    await dbCall('finishAgentJob', job.id, status, result, sessionId, terminatedBy)
  } catch (err) {
    console.error(`[workers] failed to persist agent job ${job.id}: ${err.message}`)
    return
  }

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
      await dbCall('finishAgentJob', job.id, 'failed', `Agent path does not exist: ${job.agent_path}`, null)
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

    const shellBin = defaultShell()
    const agentEnv = buildAgentEnv(settings, cfg, shellBin)
    const isTemplateCommand = agentCommand.includes('{spec_file}') || agentCommand.includes('{description}') || agentCommand.includes('{title}')

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
    let timeoutKind = null           // 'wall-clock' | 'idle' once a timer fires
    let idleTimer = null
    let idleMinutes = 0
    let bumpIdle = () => {}
    let settled = false
    let proc
    let promptFile = null
    let specFile = null
    let bin = ''
    let spawnArgs = []

    try {
      if (isTemplateCommand) {
        let resolvedCommand = agentCommand
        if (agentCommand.includes('{spec_file}')) {
          // Per-job spec filename (bug C13): a fixed spec.md is clobbered when two jobs for the
          // same agent land in one batch (they spawn back-to-back without awaiting), so job 1's
          // shell reads job 2's spec. A unique name per job keeps them isolated.
          const specName = `spec-${job.id}.md`
          const specPath = path.join(job.agent_path, specName)
          fs.writeFileSync(specPath, job.prompt, 'utf8')
          specFile = specPath
          resolvedCommand = resolvedCommand.replace(/\{spec_file\}/g, `./${specName}`)
        }
        if (agentCommand.includes('{description}') || agentCommand.includes('{title}')) {
          const task = job.task_id ? await dbCall('getTask', job.task_id) : null
          if (agentCommand.includes('{description}')) {
            resolvedCommand = replaceShellPlaceholder(resolvedCommand, 'description', task?.description ?? job.user_message ?? '')
          }
          if (agentCommand.includes('{title}')) {
            resolvedCommand = replaceShellPlaceholder(resolvedCommand, 'title', task?.title ?? '')
          }
        }
        bin = shellBin
        spawnArgs = ['-i', '-l', '-c', resolvedCommand]
        proc = process.platform === 'win32'
          ? spawn('cmd.exe', ['/c', resolvedCommand], { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv })
          : (() => {
            const launched = withLauncher(shellBin, spawnArgs)
            return spawn(launched.command, launched.args, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv, detached: true })
          })()
      } else {
        const parts = agentCommand.trim().split(/\s+/)
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
          resumeMessage: job.user_message || job.prompt,
          resumeId: job.prevSessionId || null,
          stream,
          onWarn: message => console.error(`[workers] job ${job.id} (${runtimeName || DEFAULT_RUNTIME}): ${message}`),
        })
        proc = process.platform === 'win32'
          ? spawn(bin, spawnArgs, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], shell: true, env: agentEnv })
          : (() => {
            // The -c '<bin> "$@"' -- ...args structure must survive intact — the args are
            // deliberately not re-parsed by the shell — so the launcher wraps the whole shell
            // invocation rather than being folded into the -c payload. bin/spawnArgs stay the
            // agent's own, so launch diagnostics keep reporting the agent, not systemd-run.
            const launched = withLauncher(shellBin, ['-i', '-l', '-c', `${bin} "$@"`, '--', ...spawnArgs])
            return spawn(launched.command, launched.args, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv, detached: true })
          })()
      }
    } catch (spawnErr) {
      runningJobs--
      if (promptFile) { try { fs.unlinkSync(promptFile) } catch {} }
      if (specFile) { try { fs.unlinkSync(specFile) } catch {} }
      const result = appendLaunchDiagnostics(
        `Failed to start agent: ${spawnErr.message}\n\nCommand: ${bin} ${spawnArgs.slice(0, 2).join(' ')}`,
        { cwd: job.agent_path, shellBin, env: agentEnv, agentCommand, commandMode: isTemplateCommand ? 'template' : 'prompt', runtimeName },
      )
      await dbCall('finishAgentJob', job.id, 'failed', result, null)
      continue
    }

    runningAgentProcs.add(proc)

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
    const timeout = setTimeout(() => { timeoutKind = 'wall-clock'; killProcessTree(proc) }, timeoutMinutes * 60 * 1000)
    // Opt-in second limit: a wall clock can't tell a productive 50-minute run from one wedged after
    // 90 seconds, but streamed output can. Left off by default because a single long tool call
    // (a full test suite, a big build) legitimately emits nothing for a while.
    idleMinutes = Number(cfg?.idle_timeout_minutes) || 0
    bumpIdle = () => {
      if (!idleMinutes) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { timeoutKind = 'idle'; killProcessTree(proc) }, idleMinutes * 60 * 1000)
    }
    bumpIdle()

    proc.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(idleTimer)
      runningAgentProcs.delete(proc)
      runningJobs--
      if (promptFile) { try { fs.unlinkSync(promptFile) } catch {} }
      if (specFile) { try { fs.unlinkSync(specFile) } catch {} }

      let { result, sessionId } = consumer.finish()

      // A timeout is Qalatra's own limit cutting off an agent that was still working — a resource
      // event, not an agent failure — so it gets its own terminal status alongside `orphaned`
      // rather than polluting failure counts. Streaming means sessionId survives the kill, so
      // these stay resumable (see the resume lookup in db-worker.js).
      const status = timeoutKind ? 'timed_out' : (code === 0 ? 'done' : 'failed')
      const timeoutNotice = timeoutKind === 'idle'
        ? `Agent killed after ${idleMinutes} minutes with no output (idle_timeout_minutes).`
        : `Agent timed out after ${timeoutMinutes} minutes (set timeout_minutes in agent.config to raise it).`
      if (timeoutKind) {
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
          commandMode: isTemplateCommand ? 'template' : 'prompt',
          runtimeName,
        })
      }

      finishAgentJobSafely({ dbCall, notify, job, status, result, sessionId, terminatedBy: timeoutKind ? 'timeout' : null, outputRules: cfg?.output_rules })
        .catch(err => console.error(`[workers] agent completion handler failed for job ${job.id}: ${err.message}`))
    })

    proc.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(idleTimer)
      runningAgentProcs.delete(proc)
      runningJobs--
      if (promptFile) { try { fs.unlinkSync(promptFile) } catch {} }
      if (specFile) { try { fs.unlinkSync(specFile) } catch {} }
      const result = appendLaunchDiagnostics(
        `Failed to start agent: ${err.message}\n\nCommand: ${bin} ${spawnArgs.slice(0, 2).join(' ')}`,
        { cwd: job.agent_path, shellBin, env: agentEnv, agentCommand, commandMode: isTemplateCommand ? 'template' : 'prompt', runtimeName },
      )
      finishAgentJobSafely({ dbCall, notify, job, status: 'failed', result, sessionId: null })
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
