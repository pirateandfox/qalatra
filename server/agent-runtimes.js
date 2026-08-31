/**
 * Agent runtime adapters.
 *
 * Qalatra spawns CLI coding agents in "prompt mode": it owns the argv and reads the agent's
 * structured output to recover the result text plus a resumable session id. Both are CLI-specific,
 * so each supported runtime supplies them here and the rest of the job pipeline (env building,
 * spawn, timeouts, output rules, job lifecycle) stays provider-neutral.
 *
 * Template-mode commands — those containing {spec_file}, {description}, or {title} — bypass this
 * entirely: Qalatra runs them verbatim and never injects flags.
 *
 * Select one with `"runtime": "claude" | "codex" | "raw"` in agent.config. Absent runtime means
 * `claude`, which is what every pre-existing config was implicitly getting.
 *
 * Output is consumed incrementally rather than buffered and parsed at exit. That is what lets a
 * killed job (timeout, idle kill) still report a session id and whatever the agent had said so far,
 * and it keeps a long, chatty run from accumulating unbounded stdout in the worker process.
 */

export const DEFAULT_RUNTIME = 'claude'

/** Raw stdout kept for diagnostics and as a last-resort result when nothing parsed. */
const TAIL_LIMIT = 64 * 1024
/** A single "line" larger than this can't be a useful event; drop it instead of growing forever. */
const MAX_PENDING_LINE = 8 * 1024 * 1024
/** Cap on whole-output buffering for runtimes whose result *is* their stdout. */
const MAX_BUFFERED_OUTPUT = 5 * 1024 * 1024

/**
 * Streams newline-delimited JSON, tolerating non-JSON lines. Codex interleaves human-readable
 * notices ("Reading additional input from stdin...") with its events and a login shell can add its
 * own, so non-JSON lines are expected rather than exceptional. Lines are assembled across chunk
 * boundaries — a JSON object routinely splits across two 'data' events.
 */
function createNdjsonConsumer({ onEvent, finalize }) {
  let pending = ''
  let tail = ''
  let eventCount = 0

  const handleLine = line => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return
    let event
    try { event = JSON.parse(trimmed) } catch { return }
    eventCount++
    try { onEvent(event) } catch {}
  }

  return {
    push(chunk) {
      const text = String(chunk)
      tail = (tail + text).slice(-TAIL_LIMIT)
      const parts = (pending + text).split('\n')
      pending = parts.pop() ?? ''       // trailing element is the incomplete line
      for (const line of parts) handleLine(line)
      if (pending.length > MAX_PENDING_LINE) pending = ''
    },
    finish() {
      if (pending) { handleLine(pending); pending = '' }
      return finalize({ tail, eventCount })
    },
  }
}

/** Accumulates whole output (bounded) and parses once at exit. */
function createBufferedConsumer(parse) {
  let text = ''
  let truncated = false
  return {
    push(chunk) {
      if (truncated) return
      text += String(chunk)
      if (text.length > MAX_BUFFERED_OUTPUT) {
        text = text.slice(0, MAX_BUFFERED_OUTPUT) + '\n\n[output truncated by Qalatra at 5 MB]'
        truncated = true
      }
    },
    finish() { return parse(text) },
  }
}

// ── Claude Code ───────────────────────────────────────────────────────────────

/**
 * Streaming is the default. `--output-format json` only emits at exit, so killing a job discards the
 * session id along with it and the work becomes unresumable; every stream-json event carries
 * `session_id`, so even a job killed seconds in stays resumable. Set `"stream": false` in
 * agent.config to fall back to the single-blob form without a code change.
 */
const claude = {
  label: 'Claude Code',

  buildArgs({ baseArgs, prompt, resumeMessage, resumeId, stream = true }) {
    const format = stream ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']
    return resumeId
      ? [...baseArgs, '--resume', resumeId, '-p', resumeMessage, ...format]
      : [...baseArgs, '-p', prompt, ...format]
  },

  createConsumer({ stream = true } = {}) {
    if (!stream) {
      return createBufferedConsumer(stdout => {
        let result = String(stdout ?? '').trim()
        let sessionId = null
        try {
          const parsed = JSON.parse(stdout)
          if (parsed.result != null) result = String(parsed.result)
          sessionId = parsed.session_id ?? null
        } catch {}
        return { result, sessionId }
      })
    }

    let sessionId = null
    let resultText = null
    const assistantText = []

    return createNdjsonConsumer({
      onEvent(event) {
        // Present on every event including the first, so this lands within moments of launch.
        if (!sessionId && event.session_id) sessionId = String(event.session_id)
        if (event.type === 'assistant') {
          for (const block of event.message?.content ?? []) {
            if (block?.type === 'text' && block.text) assistantText.push(String(block.text))
          }
        }
        if (event.type === 'result' && event.result != null) resultText = String(event.result)
      },
      finalize({ tail, eventCount }) {
        // No result event means the run was cut short; the assistant text collected so far is the
        // best available answer, and beats reporting nothing at all. Falling back to the raw tail is
        // only useful when nothing parsed — once events flowed, the tail is JSONL noise, and the
        // caller's stderr/timeout notice carries the real explanation.
        const fallback = eventCount ? '' : tail.trim()
        const result = resultText ?? (assistantText.length ? assistantText.join('\n') : fallback)
        return { result, sessionId }
      },
    })
  },
}

// ── Codex CLI ─────────────────────────────────────────────────────────────────

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

  // codex --json is JSONL only; there is no single-blob mode, so codex always streams.
  createConsumer() {
    let sessionId = null
    let resultText = null

    return createNdjsonConsumer({
      onEvent(event) {
        // Emitted before any model work, so it survives a run killed early.
        if (event.type === 'thread.started' && event.thread_id) sessionId = String(event.thread_id)
        // Last agent_message of the run is the final response for the turn.
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text != null) {
          resultText = String(event.item.text)
        }
      },
      finalize({ tail, eventCount }) {
        return { result: resultText ?? (eventCount ? '' : tail.trim()), sessionId }
      },
    })
  },
}

// ── Raw ───────────────────────────────────────────────────────────────────────

const raw = {
  label: 'raw command',
  // Runs the configured command untouched and treats stdout as the result. For wrapper scripts and
  // dispatch commands that aren't a coding CLI and have no session to resume.
  buildArgs({ baseArgs }) { return [...baseArgs] },
  createConsumer() {
    return createBufferedConsumer(stdout => ({ result: String(stdout ?? '').trim(), sessionId: null }))
  },
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
