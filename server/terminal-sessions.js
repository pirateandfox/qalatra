import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import pty from 'node-pty'
import { configuredRoots, resolveAllowedPath } from './files.js'

function now() {
  return new Date().toISOString()
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

function tmuxAvailable() {
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' })
  const ok = result.status === 0
  let error = null
  if (!ok) {
    if (result.error?.code === 'ENOENT') {
      error = os.platform() === 'darwin'
        ? 'tmux is not installed — run: brew install tmux'
        : 'tmux is not installed — run: sudo apt install tmux  (or equivalent for your distro)'
    } else {
      error = (result.stderr || result.error?.message || 'tmux not available').trim()
    }
  }
  return { ok, version: ok ? result.stdout.trim() : null, error }
}

function tmuxSessionExists(name) {
  return spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status === 0
}

function runTmux(args) {
  const result = spawnSync('tmux', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.error?.message || `tmux ${args.join(' ')} failed`).trim())
  }
  return result.stdout
}

// The tmux server inherits the cgroup of whatever first starts it. Started
// implicitly by `new-session` from inside qalatra-server, it lands in
// qalatra-server.service's cgroup, where systemd's default
// KillMode=control-group kills it — and every terminal — on restart. Start it
// in its own transient scope instead. No-op if a server is already running.
//
// Portability: systemd-run only exists on systemd Linux and needs XDG_RUNTIME_DIR
// + a live user manager, so we attempt-and-fall-back rather than detect. On macOS,
// non-systemd Linux, or when no user manager is present, we drop to a plain
// `tmux start-server`, which reduces cleanly to the previous behaviour.
// Idempotent: `tmux start-server` no-ops when a server is already running.
//
// Limitation: this does NOT move an already-running tmux server out of the wrong
// cgroup — it only governs where a *newly* started server lands. If a server is
// already running in qalatra-server.service's cgroup, the fix takes effect once
// that server exits (e.g. after the next restart with no live sessions).
function ensureTmuxServer() {
  const scoped = spawnSync('systemd-run', [
    '--user', '--scope', '--quiet', '--collect',
    'tmux', 'start-server',
  ], { stdio: 'ignore' })
  if (scoped.status === 0) return
  runTmux(['start-server']) // macOS, non-systemd Linux, or no user manager
}

function sessionName(id) {
  return `qalatra_${id.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 48)}`
}

function defaultCwd(settings = {}) {
  const roots = configuredRoots(settings)
  for (const root of roots) {
    try {
      if (fs.statSync(root).isDirectory()) return root
    } catch {}
  }
  return os.homedir()
}

function assertDirectory(cwd, settings) {
  const resolved = resolveAllowedPath(cwd || defaultCwd(settings), settings)
  const stat = fs.statSync(resolved)
  if (!stat.isDirectory()) throw new Error(`Terminal cwd is not a directory: ${resolved}`)
  return resolved
}

function safeTitle(title, cwd) {
  const trimmed = String(title || '').trim()
  if (trimmed) return trimmed.slice(0, 120)
  return path.basename(cwd) || cwd
}

export function createTerminalManager({ dataDir, loadSettings }) {
  const storeFile = path.join(dataDir, 'terminal-sessions.json')
  const activePtys = new Set()
  const lastTouchMs = new Map()

  function loadStore() {
    const store = readJson(storeFile, { sessions: [] })
    return { sessions: Array.isArray(store.sessions) ? store.sessions : [] }
  }

  function saveStore(store) {
    writeJson(storeFile, store)
  }

  function enrich(session) {
    const running = tmuxSessionExists(session.tmuxSession)
    return { ...session, status: running ? 'running' : 'exited' }
  }

  function listSessions() {
    const status = tmuxAvailable()
    const store = loadStore()
    return {
      tmux: status,
      sessions: store.sessions.map(enrich).sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt))),
    }
  }

  function getSession(id) {
    const store = loadStore()
    const session = store.sessions.find(s => s.id === id)
    if (!session) throw new Error(`Terminal session not found: ${id}`)
    return session
  }

  function upsertSession(session) {
    const store = loadStore()
    const next = store.sessions.filter(s => s.id !== session.id)
    next.push(session)
    saveStore({ sessions: next })
  }

  function createSession(input = {}) {
    const status = tmuxAvailable()
    if (!status.ok) throw new Error('tmux is required for persistent remote terminal sessions. Install tmux on the Qalatra server.')

    const settings = loadSettings()
    const cwd = assertDirectory(input.cwd, settings)
    const id = crypto.randomUUID()
    const tmuxSession = sessionName(id)
    const createdAt = now()
    // Ensure the tmux server is running in its own scope before `new-session`
    // implicitly starts one inside this service's cgroup (see ensureTmuxServer).
    ensureTmuxServer()
    runTmux(['new-session', '-d', '-s', tmuxSession, '-c', cwd])
    // Enable tmux mouse mode so mouse-wheel scroll works (tmux handles it natively).
    // With mouse on, normal click-drag is intercepted by tmux's copy-mode. To get those
    // selections onto the user's system clipboard, enable set-clipboard: tmux then emits
    // an OSC 52 sequence on copy (TERM=xterm-256color advertises the Ms capability), which
    // xterm.js catches and writes to the native clipboard. Plain click-drag now copies on
    // release; Shift+drag still uses xterm's own selection + Cmd+C.
    try { runTmux(['set-option', '-t', tmuxSession, 'mouse', 'on']) } catch {}
    try { runTmux(['set-option', '-s', 'set-clipboard', 'on']) } catch {}

    const session = {
      id,
      title: safeTitle(input.title, cwd),
      cwd,
      taskId: input.taskId || null,
      agentPath: input.agentPath || null,
      tmuxSession,
      createdAt,
      lastActivityAt: createdAt,
      lastAttachedAt: null,
    }
    upsertSession(session)

    const command = String(input.command || '').trim()
    if (command) {
      runTmux(['send-keys', '-t', tmuxSession, command, 'C-m'])
    }

    return enrich(session)
  }

  function updateSession(id, input = {}) {
    const current = getSession(id)
    const updated = {
      ...current,
      title: input.title === undefined ? current.title : safeTitle(input.title, current.cwd),
      taskId: input.taskId === undefined ? current.taskId : input.taskId || null,
      agentPath: input.agentPath === undefined ? current.agentPath : input.agentPath || null,
      lastActivityAt: now(),
    }
    upsertSession(updated)
    return enrich(updated)
  }

  function touchSession(id, field = 'lastActivityAt', { force = false } = {}) {
    const currentMs = Date.now()
    if (!force && currentMs - (lastTouchMs.get(id) || 0) < 2000) return null
    lastTouchMs.set(id, currentMs)
    const store = loadStore()
    const idx = store.sessions.findIndex(s => s.id === id)
    if (idx === -1) return null
    const session = { ...store.sessions[idx], [field]: now(), lastActivityAt: now() }
    store.sessions[idx] = session
    saveStore(store)
    return session
  }

  function killSession(id, { remove = false } = {}) {
    const session = getSession(id)
    if (tmuxSessionExists(session.tmuxSession)) {
      runTmux(['kill-session', '-t', session.tmuxSession])
    }
    const store = loadStore()
    const sessions = remove
      ? store.sessions.filter(s => s.id !== id)
      : store.sessions.map(s => s.id === id ? { ...s, lastActivityAt: now() } : s)
    saveStore({ sessions })
    return { ok: true }
  }

  function attachWebSocket(ws, id, params = new URLSearchParams()) {
    const session = getSession(id)
    if (!tmuxSessionExists(session.tmuxSession)) {
      ws.send(JSON.stringify({ type: 'error', error: 'Terminal session is not running.' }))
      ws.close()
      return
    }

    touchSession(id, 'lastAttachedAt', { force: true })
    // Ensure OSC 52 clipboard export is on for the whole tmux server, including sessions
    // created before this option existed and after a tmux server restart. Idempotent.
    try { runTmux(['set-option', '-s', 'set-clipboard', 'on']) } catch {}
    const cols = Math.max(20, Math.min(500, parseInt(params.get('cols') || '100', 10) || 100))
    const rows = Math.max(8, Math.min(200, parseInt(params.get('rows') || '30', 10) || 30))
    const proc = pty.spawn('tmux', ['attach-session', '-t', session.tmuxSession], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: session.cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    })
    activePtys.add(proc)

    proc.onData(data => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }))
    })
    proc.onExit(event => {
      activePtys.delete(proc)
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'exit', code: event.exitCode }))
        ws.close()
      }
    })

    ws.send(JSON.stringify({ type: 'ready', session: enrich(session) }))
    ws.on('message', raw => {
      let message = null
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (message?.type === 'input' && typeof message.data === 'string') {
        proc.write(message.data)
        touchSession(id)
      } else if (message?.type === 'resize') {
        const nextCols = Math.max(20, Math.min(500, Number(message.cols) || cols))
        const nextRows = Math.max(8, Math.min(200, Number(message.rows) || rows))
        try { proc.resize(nextCols, nextRows) } catch {}
      }
    })
    ws.on('close', () => {
      try { proc.kill() } catch {}
      activePtys.delete(proc)
      touchSession(id)
    })
    ws.on('error', err => {
      console.error(`[terminal] websocket error for ${id}: ${err.message}`)
      try { proc.kill() } catch {}
      activePtys.delete(proc)
      touchSession(id)
    })
  }

  // Persist an image (dragged/pasted into the terminal UI) to a temp file ON THE
  // SERVER, so the path is reachable by the pty/CLI running here — which on a
  // remote backend is a different machine than the Electron client. Returns the
  // absolute server-side path to insert at the prompt.
  function saveImage(id, buffer, ext) {
    getSession(id) // authorize: throws if the session doesn't exist
    if (!buffer || !buffer.length) throw new Error('Empty image payload')
    const dir = path.join(os.tmpdir(), 'qalatra-terminal-images')
    fs.mkdirSync(dir, { recursive: true })
    const safeExt = /^[a-z0-9]{1,5}$/i.test(String(ext || '')) ? ext : 'png'
    const file = path.join(dir, `paste-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${safeExt}`)
    fs.writeFileSync(file, buffer)
    return { path: file }
  }

  function close() {
    for (const proc of activePtys) {
      try { proc.kill() } catch {}
    }
    activePtys.clear()
  }

  return {
    status: tmuxAvailable,
    listSessions,
    createSession,
    updateSession,
    killSession,
    attachWebSocket,
    saveImage,
    close,
  }
}
