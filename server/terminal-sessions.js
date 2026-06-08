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
    runTmux(['new-session', '-d', '-s', tmuxSession, '-c', cwd])

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
    close,
  }
}
