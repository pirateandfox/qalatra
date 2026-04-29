import { useState } from 'react'
import type { Task } from '../types/task'
import { PRIORITY_COLORS, ENERGY_ICONS } from '../lib/constants'
import { useContexts } from '../lib/ContextsProvider'
import { api } from '../api'
import SnoozePopover from './SnoozePopover'
import PlatformIcon from './PlatformIcon'
import { detectPlatform } from '../lib/constants'
import './TaskRow.css'

interface Props {
  task: Task
  showContext?: boolean
  draggable?: boolean
  selected?: boolean
  onSelect: (id: string) => void
  onMutate: () => void
  onClearInbox?: () => void
}

export default function TaskRow({ task, showContext = true, draggable = false, selected = false, onSelect, onMutate, onClearInbox }: Props) {
  const { getColor, getLabel } = useContexts()
  const [snoozeAnchor, setSnoozeAnchor] = useState<DOMRect | null>(null)
  const isDone = task.status === 'done'
  const isSnoozed = task.status === 'snoozed' || task.status === 'archived'

  function dueDateUrgency(due: string | null | undefined): 'overdue' | 'imminent' | 'soon' | 'normal' | null {
    if (!due) return null
    const today = new Date(); today.setHours(0,0,0,0)
    const d = new Date(due + 'T00:00:00')
    const days = Math.round((d.getTime() - today.getTime()) / 86400000)
    if (days < 0) return 'overdue'
    if (days <= 1) return 'imminent'
    if (days <= 3) return 'soon'
    return 'normal'
  }
  const urgency = isDone ? null : dueDateUrgency(task.due_date)

  const subtasks: Task[] = (task as any).subtasks ?? []
  const incompleteSubtasks = subtasks.filter(s => s.status !== 'done').length
  const blocked = !isDone && subtasks.length > 0 && incompleteSubtasks > 0

  const allLinks: string[] = [
    ...(task.source_url ? [task.source_url] : []),
    ...(() => { try { return JSON.parse(task.links ?? '[]') } catch { return [] } })(),
  ]

  async function handleCheck(e: React.MouseEvent) {
    e.preventDefault()
    if (isDone) {
      await api.uncomplete(task.id)
    } else if (blocked) {
      const yes = window.confirm(`Complete all ${incompleteSubtasks} subtask${incompleteSubtasks > 1 ? 's' : ''} and mark this done?`)
      if (!yes) return
      await api.completeWithSubtasks(task.id)
    } else {
      const result = await api.complete(task.id)
      if (result?.ok === false) {
        if (result.reason === 'subtasks_incomplete') {
          const yes = window.confirm(`Complete all ${result.count} subtask${result.count > 1 ? 's' : ''} and mark this done?`)
          if (!yes) return
          await api.completeWithSubtasks(task.id)
        } else {
          return
        }
      }
    }
    onMutate()
  }

  async function handleSkip() {
    await api.skip(task.id)
    onMutate()
  }

  async function handleActivate() {
    await api.activate(task.id)
    onMutate()
  }

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', task.id)
    e.dataTransfer.effectAllowed = 'move'
    setTimeout(() => (e.target as HTMLElement).classList.add('dragging'), 0)
  }

  const handleDragEnd = (e: React.DragEvent) => {
    (e.target as HTMLElement).classList.remove('dragging')
  }

  return (
    <>
      <div
        className={`task-row ${isDone ? 'done' : ''} ${selected ? 'selected' : ''}`}
        data-id={task.id}
        draggable={draggable && !isDone}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {draggable && !isDone && <span className="drag-handle">⋮⋮</span>}

        <button
          className={`checkbox ${isDone ? 'checked' : ''} ${blocked ? 'blocked' : ''}`}
          onClick={handleCheck}
          title={blocked ? `${incompleteSubtasks} subtask${incompleteSubtasks > 1 ? 's' : ''} remaining` : undefined}
        >
          {isDone ? '✓' : ''}
        </button>

        <div className="task-body" onClick={() => onSelect(task.id)}>
          <span className={`task-title ${isDone ? 'strikethrough' : ''}`}>{task.title}</span>
          <div className="task-meta">
            {showContext && task.context && (
              <span className="badge" style={{
                background: `${getColor(task.context)}20`,
                color: getColor(task.context),
                border: `1px solid ${getColor(task.context)}40`,
              }}>
                {getLabel(task.context)}
              </span>
            )}
            {task.project && <span className="project">{task.project}</span>}
            {task.my_priority && (
              <span className="priority" style={{ color: PRIORITY_COLORS[task.my_priority] ?? '#6b7280' }}>
                P{task.my_priority}
              </span>
            )}
            {task.energy_required && (
              <span className="energy">{ENERGY_ICONS[task.energy_required] ?? ''} {task.energy_required}</span>
            )}
            {task.surface_after && !isDone && (
              <span className="snooze-time" title={`Snoozed until ${task.surface_after}`}>
                💤 {new Date(task.surface_after).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </span>
            )}
            {task.due_date && !isDone && (
              <span className={`due-date due-date--${urgency}`}>
                {urgency === 'overdue' ? '⚠ ' : urgency === 'imminent' ? '● ' : ''}{task.due_date}
              </span>
            )}
            {task.description && <span className="has-notes" title="Has description">●</span>}
            {task.agent_job_status === 'running' && <span className="agent-running" title="Agent running"><span className="agent-running-pip" /></span>}
            {task.agent_job_status === 'queued'  && <span className="agent-queued" title="Agent queued"><span className="agent-queued-pip" /></span>}
            {task.agent_job_status === 'done'    && <span className="agent-done"     title="Agent result ready for review">★</span>}
            {task.agent_job_status === 'failed'  && <span className="agent-failed"   title="Agent job failed">✕</span>}
            {task.recurrence && <span className="recurrence-indicator" title={task.recurrence}>↻</span>}
          </div>

          {subtasks.length > 0 && (
            <div className="subtask-progress-wrap">
              <div className="subtask-progress">
                <div
                  className="subtask-progress-bar"
                  style={{ width: `${Math.round((subtasks.length - incompleteSubtasks) / subtasks.length * 100)}%` }}
                />
              </div>
              {subtasks.filter(s => s.status !== 'done').map(s => (
                <div key={s.id} className={`subtask-row ${s.status === 'done' ? 'done' : ''}`}>
                  <span className="subtask-title">{s.title}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="task-actions">
          {onClearInbox && (
            <button
              className="inbox-clear-btn"
              title="Move to task list"
              onClick={e => { e.stopPropagation(); onClearInbox() }}
            >
              Schedule →
            </button>
          )}
          <div className="task-actions-buttons">
            {!isDone && !task.recurrence && (
              <button
                className="action-btn"
                title="Snooze"
                onClick={e => {
                  e.stopPropagation()
                  setSnoozeAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())
                }}
              >
                💤
              </button>
            )}
            {!isDone && task.recurrence && (
              <button className="action-btn" title="Skip (recurring)" onClick={handleSkip}>⊟</button>
            )}
            {isSnoozed && (
              <button className="action-btn" title="Activate" onClick={handleActivate}>▶</button>
            )}
          </div>
          {allLinks.length > 0 && (
            <div className="task-links">
              {allLinks.map((url, i) => {
                const platform = detectPlatform(url)
                const label = platform.key === 'link'
                  ? (() => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return 'Link' } })()
                  : platform.label
                return (
                  <a
                    key={i}
                    className="platform-icon-link"
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                  >
                    <PlatformIcon url={url} size={13} />
                    <span className="platform-link-label">{label}</span>
                  </a>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {snoozeAnchor && (
        <SnoozePopover
          taskId={task.id}
          anchorRect={snoozeAnchor}
          onClose={() => setSnoozeAnchor(null)}
          onSnoozed={onMutate}
        />
      )}
    </>
  )
}
