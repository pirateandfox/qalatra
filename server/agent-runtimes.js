/**
 * Agent runtime adapters.
 *
 * Qalatra spawns CLI coding agents in "prompt mode": it owns the argv and parses the agent's
 * structured output to recover the result text plus a resumable session id. Both of those are
 * CLI-specific, so each supported runtime supplies them here and the rest of the job pipeline
 * (env building, spawn, timeout, output rules, job lifecycle) stays provider-neutral.
 *
 * Template-mode commands — those containing {spec_file}, {description}, or {title} — bypass this
 * entirely: Qalatra runs them verbatim and never injects flags.
 *
 * Select one with `"runtime": "claude" | "codex" | "raw"` in agent.config. Absent runtime means
 * `claude`, which is what every pre-existing config was implicitly getting.
 */

export const DEFAULT_RUNTIME = 'claude'

/**
 * Parse newline-delimited JSON, skipping anything that isn't a JSON object. Codex interleaves
 * human-readable notices ("Reading additional input from stdin...") with its JSONL events, and a
 * login shell can add its own noise, so non-JSON lines are expected rather than exceptional.
 */
function jsonLines(stdout) {
  const events = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try { events.push(JSON.parse(trimmed)) } catch {}
  }
  return events
}

const claude = {
  label: 'Claude Code',
  buildArgs({ baseArgs, prompt, resumeMessage, resumeId }) {
    return resumeId
      ? [...baseArgs, '--resume', resumeId, '-p', resumeMessage, '--output-format', 'json']
      : [...baseArgs, '-p', prompt, '--output-format', 'json']
  },
  parseOutput(stdout) {
    let result = String(stdout ?? '').trim()
    let sessionId = null
    try {
      const parsed = JSON.parse(stdout)
      if (parsed.result != null) result = String(parsed.result)
      sessionId = parsed.session_id ?? null
    } catch {}
    return { result, sessionId }
  },
}

/**
 * `codex exec resume` accepts a strict subset of `codex exec`'s options — no --sandbox, -C/--cd,
 * --profile, --add-dir, --color, --oss — and clap hard-errors on an unrecognized flag instead of
 * ignoring it. Forwarding a config's flags blindly therefore fails every resumed turn with exit 2,
 * so anything resume doesn't accept is dropped and reported. Dropping degrades toward codex's
 * default sandbox rather than toward more access, so a dropped flag can't widen permissions.
 * Verified against codex-cli 0.151.0 (`codex exec resume --help`).
 */
const CODEX_RESUME_FLAGS = new Set([
  '-c', '--config', '--last', '--all', '--enable', '--disable', '-i', '--image', '--strict-config',
  '-m', '--model', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
  '--thread-source', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
  '--output-schema', '--json', '-o', '--output-last-message',
])

/** Flags that consume the following argv entry, so dropping one has to drop its value too. */
const CODEX_VALUE_FLAGS = new Set([
  '-c', '--config', '--enable', '--disable', '-i', '--image', '-m', '--model', '--thread-source',
  '--output-schema', '-o', '--output-last-message', '-s', '--sandbox', '-C', '--cd', '--add-dir',
  '--color', '--local-provider', '-p', '--profile',
])

function filterCodexResumeArgs(baseArgs) {
  const kept = []
  const dropped = []
  for (let i = 0; i < baseArgs.length; i++) {
    const token = baseArgs[i]
    const name = token.split('=')[0]
    const takesValue = CODEX_VALUE_FLAGS.has(name) && !token.includes('=')
    if (token.startsWith('-') && CODEX_RESUME_FLAGS.has(name)) {
      kept.push(token)
      if (takesValue && i + 1 < baseArgs.length) kept.push(baseArgs[++i])
    } else {
      // Bare tokens are dropped too: on resume they would be parsed as the positional SESSION_ID.
      dropped.push(token)
      if (takesValue && i + 1 < baseArgs.length) dropped.push(baseArgs[++i])
    }
  }
  return { kept, dropped }
}

const codex = {
  label: 'Codex CLI',
  buildArgs({ baseArgs, prompt, resumeMessage, resumeId, onWarn }) {
    // `codex exec` is the non-interactive entry point. Drop a literal `exec` the config already
    // supplied so `"command": "codex exec --foo"` doesn't spawn `codex exec exec --foo`.
    const args = baseArgs[0] === 'exec' ? baseArgs.slice(1) : baseArgs
    // Unlike Claude, codex takes the prompt (and the session id on resume) as positional
    // arguments, so every flag has to be emitted before them.
    if (!resumeId) return ['exec', ...args, '--json', prompt]
    const { kept, dropped } = filterCodexResumeArgs(args)
    if (dropped.length && typeof onWarn === 'function') {
      onWarn(`codex exec resume does not accept ${dropped.join(' ')} — dropped for this resumed turn`)
    }
    return ['exec', 'resume', ...kept, '--json', resumeId, resumeMessage]
  },
  parseOutput(stdout) {
    let sessionId = null
    let result = null
    for (const event of jsonLines(stdout)) {
      // Emitted first, before any model work — so this survives even a partial run.
      if (event.type === 'thread.started' && event.thread_id) sessionId = event.thread_id
      // Last agent_message of the run is the final response for the turn.
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text != null) {
        result = String(event.item.text)
      }
    }
    return { result: result ?? String(stdout ?? '').trim(), sessionId }
  },
}

const raw = {
  label: 'raw command',
  // Runs the configured command untouched and treats stdout as the result. For wrapper scripts and
  // dispatch commands that aren't a coding CLI and have no session to resume.
  buildArgs({ baseArgs }) { return [...baseArgs] },
  parseOutput(stdout) { return { result: String(stdout ?? '').trim(), sessionId: null } },
}

const RUNTIMES = { claude, codex, raw }

export function isKnownRuntime(name) {
  return typeof name === 'string' && Object.hasOwn(RUNTIMES, name)
}

export function runtimeNames() {
  return Object.keys(RUNTIMES)
}

/** Unknown or absent names resolve to the default so a typo degrades to today's behavior. */
export function getRuntime(name) {
  return RUNTIMES[isKnownRuntime(name) ? name : DEFAULT_RUNTIME]
}
