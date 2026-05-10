import { useState, useEffect, useRef } from 'react'
import { api, fetchAgents, fetchProjectSummaries, type Agent, type ProjectSummary } from '../api'
import { PRIORITY_COLORS } from '../lib/constants'
import { useContexts } from '../lib/ContextsProvider'
import ComboBox, { type ComboOption } from './ComboBox'
import './CreateTask.css'

interface Props {
  open: boolean
  defaultDate?: string
  onClose: () => void
  onCreated: (id: string) => void
}

export default function CreateTask({ open, defaultDate, onClose, onCreated }: Props) {
  const { contexts, getColor } = useContexts()
  const [title, setTitle] = useState('')
  const [context, setContext] = useState('personal')
  const [priority, setPriority] = useState<number | null>(null)
  const [dueDate, setDueDate] = useState('')
  const [project, setProject] = useState('')
  const [agentPath, setAgentPath] = useState('')
  const [agents, setAgents] = useState<Agent[]>([])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      fetchAgents().then(setAgents)
      fetchProjectSummaries().then(setProjects)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      setTitle('')
      setContext('personal')
      setPriority(null)
      setDueDate(defaultDate ?? '')
      setProject('')
      setAgentPath('')
      setTimeout(() => titleRef.current?.focus(), 50)
    }
  }, [open, defaultDate])

  function handleContextChange(newContext: string) {
    setContext(newContext)
    setProject('')
    setAgentPath('')
  }

  function handleProjectChange(newProject: string) {
    setProject(newProject)
    if (agentPath) {
      const agent = agents.find(a => a.path === agentPath)
      if (agent && agent.project && newProject && agent.project !== newProject) {
        setAgentPath('')
      }
    }
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      const data = await api.createTask({
        title: title.trim(),
        context,
        my_priority: priority ?? undefined,
        due_date: dueDate || undefined,
        project: project || undefined,
        agent_path: agentPath || undefined,
      } as any)
      onCreated(data.id)
      onClose()
    } catch (err: any) {
      console.error('[CreateTask] submit failed:', err?.message ?? err)
      alert(`Failed to create task: ${err?.message ?? 'Unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const contextOptions: ComboOption[] = contexts.map(c => ({
    value: c.slug,
    label: c.label,
    color: getColor(c.slug),
  }))

  const projectOptions: ComboOption[] = projects
    .filter(p => !p.context || p.context === context)
    .map(p => ({ value: p.name, label: p.name }))

  const filteredAgents = agents.filter(a =>
    (!a.context || a.context === context) &&
    (!a.project || !project || a.project === project)
  )
  const agentOptions: ComboOption[] = filteredAgents.map(a => ({
    value: a.path,
    label: a.name,
    sublabel: (!a.context && a.folder) ? a.folder : undefined,
  }))

  return (
    <div className="create-task-overlay" onClick={onClose}>
      <div className="create-task-modal" onClick={e => e.stopPropagation()}>
        <div className="create-task-header">
          <span className="create-task-title">New Task</span>
          <button className="create-task-close" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit} className="create-task-form">
          <input
            ref={titleRef}
            className="create-task-input"
            placeholder="Task title…"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') onClose() }}
          />

          <div className="create-task-field">
            <span className="create-task-label">Context</span>
            <ComboBox
              options={contextOptions}
              value={context}
              onChange={handleContextChange}
            />
          </div>

          <div className="create-task-field">
            <span className="create-task-label">Priority</span>
            <div className="create-task-pills">
              {[1,2,3,4,5].map(p => (
                <button
                  key={p}
                  type="button"
                  className={`ct-pill ct-pill-p ${priority === p ? 'active' : ''}`}
                  style={priority === p ? { background: `${PRIORITY_COLORS[p]}20`, color: PRIORITY_COLORS[p], borderColor: `${PRIORITY_COLORS[p]}60` } : {}}
                  onClick={() => setPriority(priority === p ? null : p)}
                >P{p}</button>
              ))}
            </div>
          </div>

          <div className="create-task-row">
            <div className="create-task-field">
              <span className="create-task-label">Due date</span>
              <input
                type="date"
                className="create-task-date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
              />
            </div>
            <div className="create-task-field">
              <span className="create-task-label">Project</span>
              <ComboBox
                options={projectOptions}
                value={project}
                onChange={handleProjectChange}
                placeholder="None"
                nullable
                emptyText="No projects in this context"
              />
            </div>
          </div>

          {agentOptions.length > 0 && (
            <div className="create-task-field">
              <span className="create-task-label">Agent</span>
              <ComboBox
                options={agentOptions}
                value={agentPath}
                onChange={setAgentPath}
                placeholder="None"
                nullable
              />
            </div>
          )}

          <div className="create-task-actions">
            <button type="button" className="ct-cancel" onClick={onClose}>Cancel</button>
            <button type="submit" className="ct-submit" disabled={!title.trim() || saving}>
              {saving ? 'Creating…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
