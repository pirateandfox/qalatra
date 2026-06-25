import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createTerminalSession,
  fetchAgents,
  fetchSettings,
  listTerminalSessions,
  listWorkspaceRoots,
  removeTerminalSession,
  updateTerminalSession,
  type Agent,
  type TerminalStatus,
} from '../api'
import ComboBox, { type ComboOption } from './ComboBox'
import ServerTerminal from './ServerTerminal'
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

  async function removeSelected() {
    if (!selectedSession) return
    setError(null)
    try {
      // One action: DELETE kills the tmux process if it's still running and drops
      // the session from the store either way — no separate kill-then-remove step.
      await removeTerminalSession(selectedSession.id)
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
            <button className="ide-button danger" disabled={!selectedSession} onClick={removeSelected}>
              {selectedSession?.status === 'running' ? 'Kill & Remove' : 'Remove'}
            </button>
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
          <ServerTerminal session={selectedSession} reconnectKey={reconnectKey} className="ide-terminal-xterm" />
        </section>
      </main>
    </div>
  )
}
