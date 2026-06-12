import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  createTerminalSession,
  fetchAgents,
  fetchSettings,
  killTerminalSession,
  listTerminalSessions,
  listWorkspaceRoots,
  removeTerminalSession,
  terminalSocketUrl,
  updateTerminalSession,
  type Agent,
  type TerminalSession,
  type TerminalStatus,
} from '../api'
import ComboBox, { type ComboOption } from './ComboBox'
import './AgentIdeView.css'

function basename(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

function agentLabel(agent: Agent) {
  return [
    agent.context || 'No context',
    agent.project || 'No project',
    agent.name,
  ].join(' / ')
}

function agentSessionTitle(agent: Agent) {
  return [
    agent.project || agent.context || 'Agent',
    agent.name,
  ].join(' / ')
}

function compareNullable(a: string | null | undefined, b: string | null | undefined) {
  const left = a?.trim() || 'zzzzzz'
  const right = b?.trim() || 'zzzzzz'
  return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

function timeLabel(value: string | null) {
  if (!value) return 'never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function RemoteTerminal({ session, reconnectKey }: { session: TerminalSession | null; reconnectKey: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  const sendResize = useCallback(() => {
    const term = termRef.current
    const ws = wsRef.current
    if (!term || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  }, [])

  useEffect(() => {
    if (!containerRef.current || termRef.current) return
    const term = new XTerm({
      theme: {
        background: '#0d1117',
        foreground: '#e2e8f0',
        cursor: '#4f9cf9',
        selectionBackground: '#4f9cf940',
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    term.onData(data => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })
    // Copy-on-select: whenever selection changes, write it to clipboard immediately.
    // This sidesteps all Cmd+C / accelerator interception issues in Electron.
    term.onSelectionChange(() => {
      if (!term.hasSelection()) return
      const api = (window as any).electronAPI
      if (api?.writeClipboard) api.writeClipboard(term.getSelection())
    })
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })
    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      sendResize()
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      wsRef.current?.close()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sendResize])

  useEffect(() => {
    if (!termRef.current) return
    const term: XTerm = termRef.current
    wsRef.current?.close()
    wsRef.current = null
    term.reset()

    if (!session) {
      term.write('\x1b[2mCreate or select a terminal session.\x1b[0m')
      return
    }

    term.focus()

    let cancelled = false
    let ptyExited = false
    let retryCount = 0
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    const MAX_RETRIES = 8

    function connect() {
      if (cancelled) return
      const isRetry = retryCount > 0
      term.write(`\x1b[2m${isRetry ? 'Reconnecting...' : `Connecting to ${session!.title}...`}\x1b[0m\r\n`)
      terminalSocketUrl(session!.id, term.cols || 100, term.rows || 30)
        .then(url => {
          if (cancelled) return
          const ws = new WebSocket(url)
          wsRef.current = ws
          ws.onopen = () => {
            retryCount = 0
            ptyExited = false
            term.write(`\x1b[2m${isRetry ? 'Reconnected.' : 'Connected.'}\x1b[0m\r\n`)
            sendResize()
            pingInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
            }, 25000)
          }
          ws.onmessage = event => {
            let message: { type?: string; data?: string; error?: string; code?: number } = {}
            try {
              message = JSON.parse(String(event.data))
            } catch {
              message = { type: 'error', error: 'Received an unreadable terminal message.' }
            }
            if (message.type === 'output' && typeof message.data === 'string') term.write(message.data)
            if (message.type === 'error') term.write(`\r\n\x1b[31m${message.error ?? 'Terminal error'}\x1b[0m\r\n`)
            if (message.type === 'exit') {
              ptyExited = true
              term.write(`\r\n\x1b[33mAttach process exited (${message.code ?? 0}). Session may still be running in tmux.\x1b[0m\r\n`)
            }
          }
          ws.onclose = () => {
            if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
            if (cancelled || ptyExited) return
            if (retryCount < MAX_RETRIES) {
              retryCount++
              const delay = Math.min(500 * retryCount, 4000)
              reconnectTimer = setTimeout(connect, delay)
            } else {
              term.write('\r\n\x1b[31mFailed to reconnect. Click Reconnect to try again.\x1b[0m\r\n')
            }
          }
          ws.onerror = () => {
            term.write('\r\n\x1b[31mWebSocket terminal connection failed.\x1b[0m\r\n')
          }
        })
        .catch(err => {
          if (!cancelled) term.write(`\r\n\x1b[31m${err?.message ?? String(err)}\x1b[0m\r\n`)
        })
    }

    connect()

    return () => {
      cancelled = true
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [session?.id, sendResize, reconnectKey])

  return <div ref={containerRef} className="ide-terminal-xterm" />
}

export default function TerminalManagerView() {
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedAgentPath, setSelectedAgentPath] = useState('')
  const [cwdInput, setCwdInput] = useState('')
  const [titleInput, setTitleInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameInput, setRenameInput] = useState('')
  const [reconnectKey, setReconnectKey] = useState(0)

  const sessions = terminalStatus?.sessions ?? []
  const selectedSession = useMemo(
    () => sessions.find(session => session.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  )

  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => (
      compareNullable(a.context, b.context) ||
      compareNullable(a.project, b.project) ||
      compareNullable(a.name, b.name)
    )),
    [agents],
  )
  const agentOptions = useMemo<ComboOption[]>(
    () => sortedAgents.map(agent => ({
      value: agent.path,
      label: agentLabel(agent),
    })),
    [sortedAgents],
  )

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [nextTerminalStatus, nextAgents, roots] = await Promise.all([
        listTerminalSessions(),
        fetchAgents(),
        listWorkspaceRoots(),
      ])
      setTerminalStatus(nextTerminalStatus)
      setAgents(nextAgents)
      setCwdInput(current => current || roots.find(root => root.exists && root.isDirectory)?.path || '')
      setSelectedSessionId(current => {
        if (current && nextTerminalStatus.sessions.some(session => session.id === current)) return current
        return nextTerminalStatus.sessions[0]?.id ?? null
      })
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  function chooseAgent(path: string) {
    setSelectedAgentPath(path)
    const agent = agents.find(item => item.path === path)
    if (!agent) return
    setCwdInput(agent.path)
    setTitleInput(agentSessionTitle(agent))
  }

  async function createSession(command?: string) {
    setError(null)
    try {
      const cwd = cwdInput.trim()
      const session = await createTerminalSession({
        cwd,
        title: titleInput.trim() || basename(cwd),
        agentPath: selectedAgentPath || null,
        command,
      })
      setTitleInput('')
      await reload()
      setSelectedSessionId(session.id)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }

  async function createClaudeSession() {
    const settings = await fetchSettings().catch(() => ({} as Record<string, string>))
    const command = settings.defaultAgentCommand || 'claude --dangerously-skip-permissions'
    await createSession(command)
  }

  function startRename() {
    if (!selectedSession) return
    setRenameInput(selectedSession.title)
    setRenaming(true)
  }

  async function commitRename() {
    if (!selectedSession) return
    const title = renameInput.trim()
    setRenaming(false)
    if (!title || title === selectedSession.title) return
    setError(null)
    try {
      await updateTerminalSession(selectedSession.id, { title })
      await reload()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }

  async function killSelected(remove = false) {
    if (!selectedSession) return
    setError(null)
    try {
      if (remove) await removeTerminalSession(selectedSession.id)
      else await killTerminalSession(selectedSession.id)
      await reload()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }

  return (
    <div className="agent-ide terminal-manager">
      <aside className="ide-sidebar terminal-sidebar">
        <div className="ide-section">
          <div className="ide-section-title">New Session</div>
          <div className="ide-terminal-form">
            <ComboBox
              options={agentOptions}
              value={selectedAgentPath}
              onChange={chooseAgent}
              placeholder="Search agents..."
              nullable
              nullableLabel="Manual directory"
              emptyText="No agents match"
            />
            <input
              className="ide-input"
              value={cwdInput}
              onChange={event => {
                setCwdInput(event.target.value)
                setSelectedAgentPath('')
              }}
              placeholder="Working directory"
              spellCheck={false}
            />
            <input
              className="ide-input"
              value={titleInput}
              onChange={event => setTitleInput(event.target.value)}
              placeholder="Session title"
              spellCheck={false}
            />
            <div className="ide-button-row">
              <button className="ide-button primary" onClick={() => createSession()}>New shell</button>
              <button className="ide-button" onClick={createClaudeSession}>New Claude</button>
            </div>
          </div>
          {terminalStatus?.tmux && !terminalStatus.tmux.ok && (
            <div className="ide-alert">tmux is required on this server: {terminalStatus.tmux.error}</div>
          )}
          {error && <div className="ide-error">{error}</div>}
        </div>

        <div className="ide-section terminal-tabs-section">
          <div className="ide-section-title">Sessions</div>
          <div className="ide-session-list terminal-tabs">
            {sessions.map(session => (
              <button
                key={session.id}
                className={`ide-session${selectedSessionId === session.id ? ' selected' : ''}`}
                onClick={() => {
                  setSelectedSessionId(session.id)
                  setCwdInput(session.cwd)
                  setSelectedAgentPath(session.agentPath ?? '')
                }}
              >
                <span className={`ide-session-dot ${session.status}`} />
                <span className="ide-session-main">
                  <span className="ide-session-title">{session.title}</span>
                  <span className="ide-session-meta">{basename(session.cwd)} · {timeLabel(session.lastActivityAt)}</span>
                </span>
              </button>
            ))}
            {sessions.length === 0 && <div className="ide-empty">No terminal sessions yet.</div>}
          </div>
          <div className="ide-button-row">
            <button className="ide-button" disabled={!selectedSession} onClick={() => killSelected(false)}>Kill</button>
            <button className="ide-button danger" disabled={!selectedSession} onClick={() => killSelected(true)}>Remove</button>
            <button className="ide-button" disabled={!selectedSession} onClick={startRename}>Rename</button>
            <button className="ide-button" onClick={reload}>Refresh</button>
          </div>
        </div>
      </aside>

      <main className="ide-main terminal-main">
        <section className="ide-terminal-panel terminal-full-panel">
          <div className="ide-terminal-toolbar">
            <div className="ide-terminal-title-area">
              {renaming && selectedSession ? (
                <input
                  className="ide-input ide-terminal-rename-input"
                  autoFocus
                  value={renameInput}
                  onChange={e => setRenameInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenaming(false)
                  }}
                  onBlur={commitRename}
                />
              ) : (
                <span className="ide-terminal-title">{selectedSession?.title ?? 'Terminal'}</span>
              )}
              {selectedSession && !renaming && <span className="ide-terminal-cwd">{selectedSession.cwd}</span>}
            </div>
            {selectedSession && (
              <button
                className="ide-button"
                style={{ flexShrink: 0 }}
                onClick={() => setReconnectKey(k => k + 1)}
                title="Reattach to session"
              >
                Reconnect
              </button>
            )}
          </div>
          <RemoteTerminal session={selectedSession} reconnectKey={reconnectKey} />
        </section>
      </main>
    </div>
  )
}
