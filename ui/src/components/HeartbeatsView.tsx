import { useState, useEffect, useCallback } from 'react'
import { fetchAgents, type Agent } from '../api'
import { useContexts } from '../lib/ContextsProvider'
import './HeartbeatsView.css'

const INTERVAL_OPTIONS = [
  { value: 5,    label: 'Every 5 min' },
  { value: 10,   label: 'Every 10 min' },
  { value: 15,   label: 'Every 15 min' },
  { value: 30,   label: 'Every 30 min' },
  { value: 60,   label: 'Every hour' },
  { value: 120,  label: 'Every 2 hours' },
  { value: 240,  label: 'Every 4 hours' },
  { value: 1440, label: 'Every day' },
]

function intervalLabel(minutes: number, runAtTime?: string | null) {
  if (minutes === 1440 && runAtTime) return `Daily at ${runAtTime}`
  const opt = INTERVAL_OPTIONS.find(o => o.value === minutes)
  if (opt) return opt.label
  if (minutes < 60) return `Every ${minutes} min`
  if (minutes === 60) return 'Every hour'
  return `Every ${minutes / 60}h`
}

function relativeTime(isoStr: string | null): string {
  if (!isoStr) return '—'
  const d = new Date(isoStr.includes('T') ? isoStr : isoStr.replace(' ', 'T') + 'Z')
  const diffMs = d.getTime() - Date.now()
  const diffSec = Math.round(diffMs / 1000)
  const absSec = Math.abs(diffSec)
  if (absSec < 60) return diffSec < 0 ? `${absSec}s ago` : `in ${absSec}s`
  const absMins = Math.round(absSec / 60)
  if (absMins < 60) return diffSec < 0 ? `${absMins}m ago` : `in ${absMins}m`
  const absHrs = Math.round(absSec / 3600)
  if (absHrs < 24) return diffSec < 0 ? `${absHrs}h ago` : `in ${absHrs}h`
  const absDays = Math.round(absSec / 86400)
  return diffSec < 0 ? `${absDays}d ago` : `in ${absDays}d`
}

function agentDisplayName(a: Agent) {
  return (!a.context && a.folder) ? `${a.folder} / ${a.name}` : a.name
}

interface AgentJob {
  id: string
  status: string
  result: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

interface Heartbeat {
  id: string
  title: string
  description: string | null
  agent_path: string
  prompt: string
  interval_minutes: number
  run_at_time: string | null
  active: number
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  runs_done: number
  runs_failed: number
  runs_pending: number
}

// ── Agent picker sub-form ─────────────────────────────────────────────────────

interface AgentPickerProps {
  agents: Agent[]
  context: string
  project: string
  agentPath: string
  onContextChange: (ctx: string) => void
  onProjectChange: (proj: string) => void
  onAgentChange: (path: string, description: string | null) => void
}

function AgentPicker({ agents, context, project, agentPath, onContextChange, onProjectChange, onAgentChange }: AgentPickerProps) {
  const { contexts } = useContexts()

  // Unique projects among agents filtered by current context
  const projectsForContext = [...new Set(
    agents
      .filter(a => !context || !a.context || a.context === context)
      .map(a => a.project)
      .filter((p): p is string => !!p)
  )].sort()

  // Agents filtered by context + project
  const filteredAgents = agents.filter(a =>
    (!context || !a.context || a.context === context) &&
    (!project || !a.project || a.project === project)
  )

  return (
    <div className="hb-agent-picker">
      <div className="hb-picker-row">
        <select
          className="hb-select"
          value={context}
          onChange={e => { onContextChange(e.target.value); onProjectChange('') }}
        >
          <option value="">Any context</option>
          {contexts.map(c => (
            <option key={c.slug} value={c.slug}>{c.label ?? c.slug}</option>
          ))}
        </select>

        {projectsForContext.length > 0 && (
          <select
            className="hb-select"
            value={project}
            onChange={e => onProjectChange(e.target.value)}
          >
            <option value="">Any project</option>
            {projectsForContext.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}
      </div>

      <select
        className="hb-select hb-agent-select"
        value={agentPath}
        onChange={e => {
          const selected = agents.find(a => a.path === e.target.value) ?? null
          onAgentChange(e.target.value, selected?.description ?? null)
        }}
        required
      >
        <option value="">— Select agent —</option>
        {filteredAgents.map(a => (
          <option key={a.path} value={a.path} title={a.description ?? undefined}>
            {agentDisplayName(a)}
          </option>
        ))}
      </select>

      {agentPath && (
        <div className="hb-selected-path" title={agentPath}>{agentPath}</div>
      )}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

interface Props {
  onMutate?: () => void
}

const BLANK_FORM = { title: '', context: '', project: '', agent_path: '', prompt: '', interval_minutes: 60, run_at_time: '09:00' }

export default function HeartbeatsView({ onMutate }: Props) {
  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([])
  const [loading, setLoading]       = useState(true)
  const [agents, setAgents]         = useState<Agent[]>([])
  const [creating, setCreating]     = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [jobs, setJobs]             = useState<Record<string, AgentJob[]>>({})
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set())
  const [form, setForm]             = useState(BLANK_FORM)
  const [editId, setEditId]         = useState<string | null>(null)
  const [editForm, setEditForm]     = useState(BLANK_FORM)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const data = await (window as any).electronAPI.invoke('heartbeats:list')
    setHeartbeats(data)
    if (!silent) setLoading(false)
  }, [])

  useEffect(() => {
    load()
    fetchAgents().then(setAgents).catch(() => {})
  }, [load])

  useEffect(() => {
    const interval = setInterval(() => load(true), 30_000)
    return () => clearInterval(interval)
  }, [load])

  async function loadJobs(id: string) {
    const data = await (window as any).electronAPI.invoke('heartbeats:jobs', id, 10)
    setJobs(prev => ({ ...prev, [id]: data }))
  }

  function toggleExpand(id: string) {
    if (expandedId === id) { setExpandedId(null) }
    else { setExpandedId(id); loadJobs(id) }
  }

  function toggleJobExpand(jobId: string) {
    setExpandedJobIds(prev => {
      const next = new Set(prev)
      next.has(jobId) ? next.delete(jobId) : next.add(jobId)
      return next
    })
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim() || !form.agent_path || !form.prompt.trim()) return
    await (window as any).electronAPI.invoke('heartbeats:create', {
      title: form.title.trim(),
      agent_path: form.agent_path,
      prompt: form.prompt.trim(),
      interval_minutes: form.interval_minutes,
      run_at_time: form.interval_minutes === 1440 ? form.run_at_time : null,
    })
    setForm(BLANK_FORM)
    setCreating(false)
    load()
    onMutate?.()
  }

  async function handleToggle(id: string) {
    await (window as any).electronAPI.invoke('heartbeats:toggle', id)
    load(true)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this heartbeat and all its job history?')) return
    await (window as any).electronAPI.invoke('heartbeats:delete', id)
    if (expandedId === id) setExpandedId(null)
    load()
    onMutate?.()
  }

  function startEdit(hb: Heartbeat) {
    const agent = agents.find(a => a.path === hb.agent_path)
    setEditId(hb.id)
    setEditForm({
      title: hb.title,
      context: agent?.context ?? '',
      project: agent?.project ?? '',
      agent_path: hb.agent_path,
      prompt: hb.prompt,
      interval_minutes: hb.interval_minutes,
      run_at_time: hb.run_at_time ?? '09:00',
    })
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault()
    if (!editId) return
    await (window as any).electronAPI.invoke('heartbeats:update', editId, {
      title: editForm.title.trim(),
      agent_path: editForm.agent_path,
      prompt: editForm.prompt.trim(),
      interval_minutes: editForm.interval_minutes,
      run_at_time: editForm.interval_minutes === 1440 ? editForm.run_at_time : null,
    })
    setEditId(null)
    load(true)
  }

  const active  = heartbeats.filter(h => h.active === 1)
  const paused  = heartbeats.filter(h => h.active === 0)
  const running = heartbeats.filter(h => h.runs_pending > 0)

  if (loading) return <div className="heartbeats-empty">Loading…</div>

  return (
    <div className="heartbeats-view">
      <div className="heartbeats-header">
        <div className="heartbeats-summary">
          <span className="hb-stat-active">{active.length} active</span>
          {running.length > 0 && <span className="hb-stat-running">{running.length} running</span>}
          {paused.length > 0 && <span className="hb-stat-paused">{paused.length} paused</span>}
        </div>
        <button className="hb-add-btn" onClick={() => setCreating(c => !c)}>
          {creating ? '✕' : '+ New heartbeat'}
        </button>
      </div>

      {creating && (
        <form className="hb-form" onSubmit={handleCreate}>
          <input
            className="hb-input"
            placeholder="Name (e.g. Monitor inbox)"
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            autoFocus
            required
          />

          <AgentPicker
            agents={agents}
            context={form.context}
            project={form.project}
            agentPath={form.agent_path}
            onContextChange={ctx => setForm(f => ({ ...f, context: ctx, project: '', agent_path: '' }))}
            onProjectChange={proj => setForm(f => ({ ...f, project: proj, agent_path: '' }))}
            onAgentChange={(path, desc) => setForm(f => ({
              ...f,
              agent_path: path,
              prompt: f.prompt || desc || '',
            }))}
          />

          <textarea
            className="hb-textarea"
            placeholder="Prompt sent to the agent on each run"
            value={form.prompt}
            onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
            rows={4}
            required
          />

          <div className="hb-form-row">
            <select
              className="hb-select"
              value={form.interval_minutes}
              onChange={e => setForm(f => ({ ...f, interval_minutes: Number(e.target.value) }))}
            >
              {INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {form.interval_minutes === 1440 && (
              <input
                type="time"
                className="hb-input hb-time-input"
                value={form.run_at_time}
                onChange={e => setForm(f => ({ ...f, run_at_time: e.target.value }))}
                required
              />
            )}
            <button type="submit" className="hb-btn-primary" disabled={!form.agent_path}>Create</button>
            <button type="button" className="hb-btn-cancel" onClick={() => { setCreating(false); setForm(BLANK_FORM) }}>Cancel</button>
          </div>
        </form>
      )}

      {heartbeats.length === 0 && !creating && (
        <div className="heartbeats-empty">No heartbeats yet. Add one above to start running background agents on a schedule.</div>
      )}

      {heartbeats.length > 0 && (
        <div className="hb-list">
          {heartbeats.map(hb => (
            <div key={hb.id} className={`hb-card${hb.active === 0 ? ' hb-paused' : ''}`}>
              {editId === hb.id ? (
                <form className="hb-edit-form" onSubmit={handleUpdate}>
                  <input className="hb-input" value={editForm.title} onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))} required />

                  <AgentPicker
                    agents={agents}
                    context={editForm.context}
                    project={editForm.project}
                    agentPath={editForm.agent_path}
                    onContextChange={ctx => setEditForm(f => ({ ...f, context: ctx, project: '', agent_path: '' }))}
                    onProjectChange={proj => setEditForm(f => ({ ...f, project: proj, agent_path: '' }))}
                    onAgentChange={(path, _desc) => setEditForm(f => ({ ...f, agent_path: path }))}
                  />

                  <textarea className="hb-textarea" value={editForm.prompt} onChange={e => setEditForm(f => ({ ...f, prompt: e.target.value }))} rows={4} required />

                  <div className="hb-form-row">
                    <select className="hb-select" value={editForm.interval_minutes} onChange={e => setEditForm(f => ({ ...f, interval_minutes: Number(e.target.value) }))}>
                      {INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {editForm.interval_minutes === 1440 && (
                      <input
                        type="time"
                        className="hb-input hb-time-input"
                        value={editForm.run_at_time}
                        onChange={e => setEditForm(f => ({ ...f, run_at_time: e.target.value }))}
                        required
                      />
                    )}
                    <button type="submit" className="hb-btn-primary" disabled={!editForm.agent_path}>Save</button>
                    <button type="button" className="hb-btn-cancel" onClick={() => setEditId(null)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="hb-card-header">
                    <div className="hb-card-left">
                      <span className={`hb-indicator${hb.runs_pending > 0 ? ' hb-indicator-running' : hb.active ? ' hb-indicator-active' : ' hb-indicator-paused'}`} />
                      <div className="hb-card-info">
                        <span className="hb-title">{hb.title}</span>
                        {hb.description && <span className="hb-desc">{hb.description}</span>}
                      </div>
                    </div>
                    <div className="hb-card-actions">
                      <button className="hb-toggle-btn" onClick={() => handleToggle(hb.id)} title={hb.active ? 'Pause' : 'Resume'}>
                        {hb.active ? '⏸' : '▶'}
                      </button>
                      <button className="hb-icon-btn" onClick={() => startEdit(hb)} title="Edit">✎</button>
                      <button className="hb-icon-btn hb-delete-btn" onClick={() => handleDelete(hb.id)} title="Delete">✕</button>
                    </div>
                  </div>

                  <div className="hb-card-meta">
                    <span className="hb-meta-item">{intervalLabel(hb.interval_minutes, hb.run_at_time)}</span>
                    <span className="hb-meta-sep">·</span>
                    <span className="hb-meta-item" title={hb.last_run_at ?? undefined}>Last: {relativeTime(hb.last_run_at)}</span>
                    {hb.active === 1 && (
                      <>
                        <span className="hb-meta-sep">·</span>
                        <span className="hb-meta-item" title={hb.next_run_at ?? undefined}>Next: {relativeTime(hb.next_run_at)}</span>
                      </>
                    )}
                    {(hb.runs_done > 0 || hb.runs_failed > 0) && (
                      <>
                        <span className="hb-meta-sep">·</span>
                        <span className="hb-meta-item hb-runs-done">{hb.runs_done} done</span>
                        {hb.runs_failed > 0 && <span className="hb-meta-item hb-runs-failed">{hb.runs_failed} failed</span>}
                      </>
                    )}
                    {hb.runs_pending > 0 && (
                      <>
                        <span className="hb-meta-sep">·</span>
                        <span className="hb-meta-item hb-running-badge">running…</span>
                      </>
                    )}
                  </div>

                  <div className="hb-card-path" title={hb.agent_path}>
                    <span className="hb-path-label">path</span> {hb.agent_path}
                  </div>

                  <button className="hb-expand-btn" onClick={() => toggleExpand(hb.id)}>
                    {expandedId === hb.id ? '▴ hide history' : '▾ show history'}
                  </button>

                  {expandedId === hb.id && (
                    <div className="hb-jobs">
                      {!jobs[hb.id] && <div className="hb-jobs-empty">Loading…</div>}
                      {jobs[hb.id]?.length === 0 && <div className="hb-jobs-empty">No runs yet.</div>}
                      {jobs[hb.id]?.map(job => {
                        const isJobExpanded = expandedJobIds.has(job.id)
                        const truncated = job.result && job.result.length > 300
                        return (
                          <div key={job.id} className={`hb-job hb-job-${job.status}`}>
                            <div className="hb-job-header">
                              <span className="hb-job-status">{job.status}</span>
                              <span className="hb-job-time">{relativeTime(job.completed_at ?? job.created_at)}</span>
                            </div>
                            {job.result && (
                              <>
                                <div className="hb-job-result">
                                  {isJobExpanded ? job.result : job.result.slice(0, 300)}{!isJobExpanded && truncated ? '…' : ''}
                                </div>
                                {truncated && (
                                  <button className="hb-job-expand-btn" onClick={() => toggleJobExpand(job.id)}>
                                    {isJobExpanded ? 'show less' : 'show more'}
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
