import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchProjectSummaries, fetchProjectDetail, fetchAgentsDb, createProjectExplicit, renameProject, setProjectContext, archiveProject, deleteProject, updateProject, rescanAgents, type ProjectSummary, type ProjectDetail, type AgentRecord } from '../api'
import { useContexts } from '../lib/ContextsProvider'
import TaskRow from './TaskRow'
import TaskSection from './TaskSection'
import './ProjectDashboardView.css'

interface Props {
  selectedId: string | null
  onSelect: (id: string) => void
  onMutate: () => void
}

function displayContextLabel(context: string, getLabel: (slug: string) => string) {
  return context === '_none' ? 'No context' : getLabel(context)
}

function ProjectList({ onDrillIn, onShowContextAgents }: {
  onDrillIn: (name: string) => void
  onShowContextAgents: (context: string) => void
  onRefresh?: () => void
}) {
  const [summaries, setSummaries] = useState<ProjectSummary[]>([])
  const [agents, setAgents] = useState<AgentRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [scanning, setScanning] = useState(false)
  const newInputRef = useRef<HTMLInputElement>(null)
  const { contexts, getColor, getLabel } = useContexts()

  const load = useCallback(() => {
    Promise.all([fetchProjectSummaries(), fetchAgentsDb()])
      .then(([nextSummaries, nextAgents]) => {
        setSummaries(nextSummaries)
        setAgents(nextAgents)
        setError(null)
      })
      .catch(e => setError(String(e)))
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (creating) newInputRef.current?.focus() }, [creating])

  async function handleRescan() {
    setScanning(true)
    await rescanAgents().catch(() => {})
    load()
    setScanning(false)
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    await createProjectExplicit(name)
    load()
    setCreating(false)
    setNewName('')
  }

  // Group by context
  const byContext: Record<string, ProjectSummary[]> = {}
  for (const p of summaries) {
    const ctx = p.context ?? '_none'
    if (!byContext[ctx]) byContext[ctx] = []
    byContext[ctx].push(p)
  }
  const contextAgents: Record<string, AgentRecord[]> = {}
  for (const agent of agents) {
    if (agent.project) continue
    const ctx = agent.context ?? '_none'
    if (!contextAgents[ctx]) contextAgents[ctx] = []
    contextAgents[ctx].push(agent)
  }
  const contextOrder = new Map(contexts.map((ctx, index) => [ctx.slug, index]))
  const contextKeys = [...new Set([...Object.keys(byContext), ...Object.keys(contextAgents)])]
    .sort((a, b) => {
      const ai = contextOrder.get(a)
      const bi = contextOrder.get(b)
      if (ai !== undefined || bi !== undefined) return (ai ?? 9999) - (bi ?? 9999)
      return displayContextLabel(a, getLabel).localeCompare(displayContextLabel(b, getLabel))
    })

  if (error) return <div className="empty-state" style={{ color: '#e55', fontFamily: 'monospace', fontSize: 12 }}>Error: {error}</div>

  return (
    <div className="project-list">
      <div className="proj-list-toolbar">
        {creating ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
            <input
              ref={newInputRef}
              className="detail-inline-input"
              style={{ flex: 1 }}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Project name…"
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') { setCreating(false); setNewName('') }
              }}
            />
            <button className="proj-back-btn" onClick={handleCreate}>Add</button>
            <button className="proj-back-btn" onClick={() => { setCreating(false); setNewName('') }}>✕</button>
          </div>
        ) : (
          <>
            <button className="proj-back-btn" onClick={() => setCreating(true)}>+ New Project</button>
            <button className="proj-back-btn" onClick={handleRescan} disabled={scanning} style={{ marginLeft: 'auto' }}>
              {scanning ? 'Scanning…' : '↻ Agents'}
            </button>
          </>
        )}
      </div>

      {!summaries.length && agents.length === 0 && !creating && <div className="empty-state">No projects yet.</div>}

      {contextKeys.map(ctx => {
        const projects = byContext[ctx] ?? []
        const unregisteredAgents = contextAgents[ctx] ?? []
        const color = getColor(ctx)
        const label = displayContextLabel(ctx, getLabel)
        return (
          <div key={ctx} className="project-list-group">
            <div className="project-list-ctx" style={{ color }}>
              {label}
            </div>
            {unregisteredAgents.length > 0 && (
              <button className="project-list-row project-list-agent-row" onClick={() => onShowContextAgents(ctx)}>
                <span className="project-list-name" style={{ borderLeft: `3px solid ${color}` }}>
                  Unregistered agents
                  <span className="proj-unregistered-hint">No project assigned</span>
                </span>
                <span className="project-list-counts">
                  <span className="proj-pill pill-agent">
                    {unregisteredAgents.length} {unregisteredAgents.length === 1 ? 'agent' : 'agents'}
                  </span>
                </span>
                <span className="project-list-arrow">›</span>
              </button>
            )}
            {projects.map(p => (
              <button key={p.name} className="project-list-row" onClick={() => onDrillIn(p.name)}>
                <span className="project-list-name" style={{ borderLeft: `3px solid ${color}` }}>
                  {p.name}
                  {p.isRepo && <span className="proj-repo-badge">&lt;/&gt;</span>}
                </span>
                <span className="project-list-counts">
                  {p.agentCount > 0 && <span className="proj-pill pill-agent">{p.agentCount} {p.agentCount === 1 ? 'agent' : 'agents'}</span>}
                  {p.activeCount > 0 && <span className="proj-pill pill-active">{p.activeCount} active</span>}
                  {p.codingCount > 0 && <span className="proj-pill pill-code">{p.codingCount} code</span>}
                  {p.backlogCount > 0 && <span className="proj-pill pill-backlog">{p.backlogCount} backlog</span>}
                  {p.activeCount === 0 && p.codingCount === 0 && p.backlogCount === 0 && (
                    <span className="proj-pill pill-empty">no open tasks</span>
                  )}
                </span>
                <span className="project-list-arrow">›</span>
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function CollapsibleSection({ title, icon, count, children, defaultOpen = false }: {
  title: string; icon: string; count: number; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (count === 0) return null
  return (
    <div className="proj-detail-section">
      <button className="proj-detail-toggle" onClick={() => setOpen(o => !o)}>
        <span>{open ? '▾' : '▸'}</span>
        <span>{icon} {title}</span>
        <span className="count">{count}</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

function AgentsSection({ agents }: { agents: AgentRecord[] }) {
  return (
    <div className="proj-detail-section">
      <div className="proj-detail-toggle" style={{ cursor: 'default' }}>
        <span>▾</span>
        <span>Agents</span>
        <span className="count">{agents.length}</span>
      </div>
      {agents.length === 0 ? (
        <div style={{ padding: '8px 20px', color: 'var(--muted)', fontSize: 12 }}>No agents configured for this project.</div>
      ) : (
        <div style={{ padding: '4px 0 8px' }}>
          {agents.map(a => (
            <div key={a.path} className="proj-agent-row">
              <span className="proj-agent-name">{a.name}</span>
              {a.coding === 1 && <span className="proj-pill pill-code" style={{ fontSize: 10 }}>coding</span>}
              {a.description && <span className="proj-agent-desc">{a.description}</span>}
              <span className="proj-agent-path" title={a.path}>{a.relative_path ?? a.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ContextAgentsView({ context, onBack }: { context: string; onBack: () => void }) {
  const [agents, setAgents] = useState<AgentRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { getLabel, getColor } = useContexts()

  const load = useCallback(() => {
    fetchAgentsDb()
      .then(rows => {
        setAgents(rows.filter(agent => !agent.project && (agent.context ?? '_none') === context))
        setError(null)
      })
      .catch(e => setError(String(e)))
  }, [context])

  useEffect(() => { load() }, [load])

  const label = displayContextLabel(context, getLabel)
  const color = getColor(context)

  return (
    <div className="proj-detail">
      <div className="proj-detail-header">
        <button className="proj-back-btn" onClick={onBack}>‹ Projects</button>
        <div className="proj-detail-title" style={{ flex: 1 }}>
          <span className="proj-name">Unregistered agents</span>
          <span className="proj-ctx-pill" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
            {label}
          </span>
        </div>
      </div>

      <div className="proj-context-agent-note">
        Agents in this context with no project assigned.
      </div>

      {error ? (
        <div className="empty-state" style={{ color: '#e55', fontFamily: 'monospace', fontSize: 12 }}>Error: {error}</div>
      ) : agents === null ? (
        <div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center' }}>Loading…</div>
      ) : (
        <AgentsSection agents={agents} />
      )}
    </div>
  )
}

function ProjectDetailView({ name, selectedId, onSelect, onMutate, onBack, onRename }: {
  name: string
  selectedId: string | null
  onSelect: (id: string) => void
  onMutate: () => void
  onBack: () => void
  onRename: (newName: string) => void
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameInput, setRenameInput] = useState(name)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const { contexts } = useContexts()

  const load = useCallback(async () => {
    const d = await fetchProjectDetail(name)
    setDetail(d)
  }, [name])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (renaming) { setRenameInput(name); renameInputRef.current?.focus() } }, [renaming, name])

  async function handleRename() {
    const newName = renameInput.trim()
    if (!newName || newName === name) { setRenaming(false); return }
    const result = await renameProject(name, newName)
    setRenaming(false)
    onRename(newName)
    if (result.merged) onMutate()
  }

  async function handleContextChange(ctx: string) {
    await setProjectContext(name, ctx)
    load()
    onMutate()
  }

  async function handleArchive() {
    if (!window.confirm(`Archive project "${name}"? It will be hidden from the list but tasks are kept.`)) return
    await archiveProject(name)
    onBack()
    onMutate()
  }

  async function handleDelete() {
    if (!window.confirm(`Delete project "${name}"? Tasks will remain but lose their project assignment.`)) return
    await deleteProject(name)
    onBack()
    onMutate()
  }

  if (!detail) return <div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center' }}>Loading…</div>

  const total = detail.active.length + detail.coding.length + detail.backlog.length

  return (
    <div className="proj-detail">
      <div className="proj-detail-header">
        <button className="proj-back-btn" onClick={onBack}>‹ Projects</button>
        <div className="proj-detail-title" style={{ flex: 1 }}>
          {renaming ? (
            <input
              ref={renameInputRef}
              className="detail-inline-input"
              style={{ fontSize: 15, fontWeight: 600, flex: 1 }}
              value={renameInput}
              onChange={e => setRenameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(false) }}
              onBlur={handleRename}
            />
          ) : (
            <>
              <span className="proj-name" style={{ cursor: 'pointer' }} onClick={() => setRenaming(true)} title="Click to rename">
                {detail.name}
              </span>
              <button
                className="proj-back-btn"
                style={{ fontSize: 11 }}
                onClick={() => setRenaming(true)}
              >Rename</button>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button
            className="proj-back-btn"
            style={detail.isRepo ? { fontSize: 11, background: 'color-mix(in srgb, var(--accent) 18%, transparent)', color: 'var(--accent)', borderColor: 'var(--accent)' } : { fontSize: 11 }}
            onClick={async () => {
              const next = !detail.isRepo
              await updateProject(name, { is_repo: next ? 1 : 0 })
              setDetail(d => d ? { ...d, isRepo: next } : d)
            }}
          >&lt;/&gt; {detail.isRepo ? 'repo ✓' : 'repo'}</button>
          <select
            className="detail-select"
            style={{ fontSize: 11 }}
            value={detail.context ?? ''}
            onChange={e => handleContextChange(e.target.value)}
          >
            <option value="">No context</option>
            {contexts.map(c => (
              <option key={c.slug} value={c.slug}>{c.label}</option>
            ))}
          </select>
          <button
            className="proj-back-btn"
            style={{ fontSize: 11, color: 'var(--muted)' }}
            onClick={handleArchive}
          >Archive</button>
          <button
            className="proj-back-btn"
            style={{ fontSize: 11, color: '#ef4444', borderColor: '#ef4444' }}
            onClick={handleDelete}
          >Delete</button>
        </div>
      </div>

      <AgentsSection agents={detail.agents} />

      {total === 0 && detail.doneRecent.length === 0 && (
        <div className="empty-state">No open tasks for this project.</div>
      )}

      {detail.active.length > 0 && (
        <section className="task-section">
          <h2>Active <span className="count">{detail.active.length}</span></h2>
          {detail.active.map(t => (
            <TaskRow key={t.id} task={t} selected={selectedId === t.id} onSelect={onSelect} onMutate={() => { load(); onMutate() }} />
          ))}
        </section>
      )}

      {detail.coding.length > 0 && (
        <section className="task-section">
          <h2>⌨ Code <span className="count">{detail.coding.length}</span></h2>
          {detail.coding.map(t => (
            <TaskRow key={t.id} task={t} selected={selectedId === t.id} onSelect={onSelect} onMutate={() => { load(); onMutate() }} />
          ))}
        </section>
      )}

      <CollapsibleSection title="Backlog" icon="≡" count={detail.backlog.length} defaultOpen={detail.active.length === 0 && detail.coding.length === 0}>
        <TaskSection title="" icon="" tasks={detail.backlog} hideHeader selectedId={selectedId} onSelect={onSelect} onMutate={() => { load(); onMutate() }} />
      </CollapsibleSection>

      <CollapsibleSection title="Done recently" icon="✅" count={detail.doneRecent.length}>
        <TaskSection title="" icon="" tasks={detail.doneRecent} hideHeader selectedId={selectedId} onSelect={onSelect} onMutate={() => { load(); onMutate() }} />
      </CollapsibleSection>
    </div>
  )
}

export default function ProjectDashboardView({ selectedId, onSelect, onMutate }: Props) {
  const [drillTarget, setDrillTarget] = useState<
    { type: 'project'; name: string } |
    { type: 'context-agents'; context: string } |
    null
  >(null)

  return (
    <div className="task-list-container">
      {drillTarget?.type === 'project'
        ? <ProjectDetailView
            name={drillTarget.name}
            selectedId={selectedId}
            onSelect={onSelect}
            onMutate={onMutate}
            onBack={() => setDrillTarget(null)}
            onRename={newName => setDrillTarget({ type: 'project', name: newName })}
          />
        : drillTarget?.type === 'context-agents'
          ? <ContextAgentsView
              context={drillTarget.context}
              onBack={() => setDrillTarget(null)}
            />
          : <ProjectList
              onDrillIn={name => setDrillTarget({ type: 'project', name })}
              onShowContextAgents={context => setDrillTarget({ type: 'context-agents', context })}
            />
      }
    </div>
  )
}
