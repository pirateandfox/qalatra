import fs from 'node:fs'
import path from 'node:path'

// A run whose agent exits while one of its own shell commands is still running left work behind:
// typically a build or test it started in the background before ending its turn. The reap that
// follows kills that work, so the run did not finish what it started and must not be reported as
// a clean 'done'.
export const EXITED_WITH_CHILDREN = 'exited_with_children'

// Only the agent's tool commands count, not everything left in the scope. Stdio MCP servers often
// outlive the agent by a moment (on a box with many of them, about half of all runs end with one
// still in the scope), and they are not work. Claude Code runs every Bash tool command through a
// shell that sources its shell snapshot and evals the command; that wrapper marks the agent's work.
const TOOL_SHELL_MARKER = '/shell-snapshots/snapshot-'
// A foreground command finishes before the agent exits; this only absorbs the exit race.
const GRACE_MS = 2_000
const POLL_MS = 200
const MAX_COMMAND_CHARS = 300

function readCommand(pid, readFile) {
  try {
    return readFile(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').trim()
  } catch {
    return ''
  }
}

/** The command a tool shell evals (the wrapper quotes ' as '\\''), else the whole command line. */
export function toolCommand(cmdline) {
  const evaled = /&& eval '((?:[^']|'\\'')*)'/.exec(cmdline)?.[1]
  return evaled ? evaled.replaceAll("'\\''", "'") : cmdline
}

/** The agent's tool commands still running in a scope's cgroup. Zombies and vanished pids drop out. */
export function scopeProcesses(scopeDir, { readFile = fs.readFileSync } = {}) {
  if (!scopeDir) return []
  let pids
  try {
    pids = readFile(path.join(scopeDir, 'cgroup.procs'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
  const found = []
  for (const pid of pids) {
    const cmdline = readCommand(pid, readFile)
    if (!cmdline.includes(TOOL_SHELL_MARKER)) continue
    found.push({ pid: Number(pid), command: toolCommand(cmdline).slice(0, MAX_COMMAND_CHARS) })
  }
  return found
}

/** What is still running in the scope after the grace period; empty as soon as the scope drains. */
export async function abandonedWork(scopeDir, { graceMs = GRACE_MS, pollMs = POLL_MS, list = scopeProcesses, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let left = list(scopeDir)
  for (let waited = 0; left.length && waited < graceMs; waited += pollMs) {
    await sleep(pollMs)
    left = list(scopeDir)
  }
  return left
}

// FlightDesk keeps the last 4096 characters of a result; the notice must fit inside that.
const MAX_LISTED = 8

export function formatAbandonedNotice(processes) {
  const lines = processes.slice(0, MAX_LISTED).map(p => `  - ${p.command}`)
  if (processes.length > MAX_LISTED) lines.push(`  - …and ${processes.length - MAX_LISTED} more`)
  return `The agent ended its turn while work it started was still running, and that work was killed when the run was cleaned up (${processes.length} process${processes.length === 1 ? '' : 'es'}):\n${lines.join('\n')}\nThe turn did not finish what it started. Run long commands in the foreground and wait for them before ending the turn.`
}
