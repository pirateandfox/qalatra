import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { scanAgents } from './agents.js'
import { syncPendingAttachments } from './attachments.js'

const MAX_CONCURRENT_JOBS = 3
let runningJobs = 0

function defaultShell() {
  if (process.env.SHELL) return process.env.SHELL
  try {
    const userShell = os.userInfo().shell
    if (userShell) return userShell
  } catch {}
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
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

function launchDiagnostics({ cwd, shellBin, env, agentCommand, commandMode }) {
  const home = env.HOME || os.homedir()
  const anthropicConfigDir = env.ANTHROPIC_CONFIG_DIR || path.join(home, '.claude')
  const markers = presentEnvMarkers(env)
  const lines = [
    'Launch diagnostics (sanitized):',
    `- cwd: ${cwd}`,
    `- user: ${env.USER || env.LOGNAME || '(unset)'}`,
    `- uid: ${process.getuid ? process.getuid() : '(n/a)'}`,
    `- home: ${home}`,
    `- shell: ${shellBin}`,
    `- command mode: ${commandMode}`,
    `- command template: ${sanitizeCommand(agentCommand)}`,
    `- PATH: ${env.PATH || '(unset)'}`,
    `- ANTHROPIC_CONFIG_DIR: ${env.ANTHROPIC_CONFIG_DIR || `(unset; default ${anthropicConfigDir})`}`,
    `- Claude config dir: ${pathState(anthropicConfigDir)} (${anthropicConfigDir})`,
    `- ~/.claude.json: ${pathState(path.join(home, '.claude.json'))}`,
    `- token/env markers present: ${markers.length ? markers.join(', ') : 'none'}`,
  ]
  const lookup = commandLookup(shellBin, env, cwd)
  if (lookup) lines.push(`- login-shell lookup:\n${lookup}`)
  return lines.join('\n')
}

function appendLaunchDiagnostics(result, context) {
  const diagnostics = launchDiagnostics(context)
  return `${result || ''}\n\n${diagnostics}`.trim()
}

export function startBackgroundWorkers(ctx) {
  const { dbCall, loadSettings, notify = () => {} } = ctx
  dbCall('resetStuckJobs').catch(() => {})
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

async function finishAgentJobSafely({ dbCall, notify, job, status, result, sessionId }) {
  try {
    await dbCall('finishAgentJob', job.id, status, result, sessionId)
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
    const claim = await dbCall('startAgentJob', job.id)
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
      await dbCall('updateTask', job.task_id, { task_type: 'coding' })
    }

    const shellBin = defaultShell()
    const agentEnv = buildAgentEnv(settings, cfg, shellBin)
    const isTemplateCommand = agentCommand.includes('{spec_file}') || agentCommand.includes('{description}') || agentCommand.includes('{title}')
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let proc
    let promptFile = null
    let bin = ''
    let spawnArgs = []

    try {
      if (isTemplateCommand) {
        let resolvedCommand = agentCommand
        if (agentCommand.includes('{spec_file}')) {
          const specPath = path.join(job.agent_path, 'spec.md')
          fs.writeFileSync(specPath, job.prompt, 'utf8')
          resolvedCommand = resolvedCommand.replace(/\{spec_file\}/g, './spec.md')
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
          : spawn(shellBin, spawnArgs, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv })
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
        spawnArgs = job.prevSessionId
          ? [...baseArgs, '--resume', job.prevSessionId, '-p', job.user_message || job.prompt, '--output-format', 'json']
          : [...baseArgs, '-p', promptArg, '--output-format', 'json']
        proc = process.platform === 'win32'
          ? spawn(bin, spawnArgs, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], shell: true, env: agentEnv })
          : spawn(shellBin, ['-i', '-l', '-c', `${bin} "$@"`, '--', ...spawnArgs], { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv })
      }
    } catch (spawnErr) {
      runningJobs--
      const result = appendLaunchDiagnostics(
        `Failed to start agent: ${spawnErr.message}\n\nCommand: ${bin} ${spawnArgs.slice(0, 2).join(' ')}`,
        { cwd: job.agent_path, shellBin, env: agentEnv, agentCommand, commandMode: isTemplateCommand ? 'template' : 'prompt' },
      )
      await dbCall('finishAgentJob', job.id, 'failed', result, null)
      continue
    }

    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const timeout = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, (cfg?.timeout_minutes ?? 15) * 60 * 1000)

    proc.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      runningJobs--
      if (promptFile) { try { fs.unlinkSync(promptFile) } catch {} }

      let result = stdout.trim()
      let sessionId = null
      try {
        const parsed = JSON.parse(stdout)
        result = parsed.result ?? result
        sessionId = parsed.session_id ?? null
      } catch {}

      const status = code === 0 ? 'done' : 'failed'
      if (!result) {
        result = timedOut
          ? `Agent timed out.${stderr.trim() ? '\n\nStderr:\n' + stderr.trim() : ''}`
          : (stderr.trim() || `No output (exit code ${code})`)
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
        })
      }

      finishAgentJobSafely({ dbCall, notify, job, status, result, sessionId })
        .catch(err => console.error(`[workers] agent completion handler failed for job ${job.id}: ${err.message}`))
    })

    proc.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      runningJobs--
      const result = appendLaunchDiagnostics(
        `Failed to start agent: ${err.message}\n\nCommand: ${bin} ${spawnArgs.slice(0, 2).join(' ')}`,
        { cwd: job.agent_path, shellBin, env: agentEnv, agentCommand, commandMode: isTemplateCommand ? 'template' : 'prompt' },
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
