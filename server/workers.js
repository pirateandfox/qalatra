import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { scanAgents } from './agents.js'
import { syncPendingAttachments } from './attachments.js'

const MAX_CONCURRENT_JOBS = 3
let runningJobs = 0

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

async function processAgentJobs({ dbCall, loadSettings, notify }) {
  if (runningJobs >= MAX_CONCURRENT_JOBS) return
  const jobs = await dbCall('getQueuedJobs', MAX_CONCURRENT_JOBS - runningJobs)
  const settings = loadSettings()

  for (const job of jobs) {
    runningJobs++
    await dbCall('startAgentJob', job.id)

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

    const shellBin = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
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
            const description = (task?.description ?? job.user_message ?? '').replace(/\n/g, ' ').replace(/'/g, "\\'")
            resolvedCommand = resolvedCommand.replace(/\{description\}/g, description)
          }
          if (agentCommand.includes('{title}')) {
            const title = (task?.title ?? '').replace(/'/g, "\\'")
            resolvedCommand = resolvedCommand.replace(/\{title\}/g, title)
          }
        }
        bin = shellBin
        spawnArgs = ['-i', '-l', '-c', resolvedCommand]
        proc = process.platform === 'win32'
          ? spawn('cmd.exe', ['/c', resolvedCommand], { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'] })
          : spawn(shellBin, spawnArgs, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'] })
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
          ? spawn(bin, spawnArgs, { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
          : spawn(shellBin, ['-i', '-l', '-c', `${bin} "$@"`, '--', ...spawnArgs], { cwd: job.agent_path, stdio: ['ignore', 'pipe', 'pipe'] })
      }
    } catch (spawnErr) {
      runningJobs--
      await dbCall('finishAgentJob', job.id, 'failed', `Failed to start agent: ${spawnErr.message}\n\nCommand: ${bin} ${spawnArgs.slice(0, 2).join(' ')}`, null)
      continue
    }

    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const timeout = setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, (cfg?.timeout_minutes ?? 15) * 60 * 1000)

    proc.on('close', async code => {
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

      await dbCall('finishAgentJob', job.id, status, result, sessionId)
      if (status === 'done' && job.task_id) await dbCall('insertAgentNote', uuidv4(), job.task_id, result, job.id)
      notify({ type: 'agent-job:complete', taskId: job.task_id, jobId: job.id })
    })

    proc.on('error', async err => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      runningJobs--
      await dbCall('finishAgentJob', job.id, 'failed', `Failed to start agent: ${err.message}\n\nCommand: ${bin} ${spawnArgs.slice(0, 2).join(' ')}`, null)
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
