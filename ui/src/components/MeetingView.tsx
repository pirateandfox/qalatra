import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchTask, fetchSubtasks, fetchAttachments, api } from '../api'
import type { Task, Attachment } from '../types/task'
import { fmtTime } from '../lib/constants'
import { useContexts } from '../lib/ContextsProvider'
import './MeetingView.css'

interface Props {
  taskId: string
  onBack: () => void
}

export default function MeetingView({ taskId, onBack }: Props) {
  const { getColor } = useContexts()
  const [event, setEvent] = useState<Task | null>(null)
  const [subtasks, setSubtasks] = useState<Task[]>([])
  const [newAgenda, setNewAgenda] = useState('')
  const [newTask, setNewTask] = useState('')
  const [newTaskDate, setNewTaskDate] = useState('')
  const [createdTasks, setCreatedTasks] = useState<string[]>([])
  const [saveStatus, setSaveStatus] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const notesRef = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    const [t, s, atts] = await Promise.all([fetchTask(taskId), fetchSubtasks(taskId), fetchAttachments(taskId)])
    setEvent(t)
    setSubtasks(s as Task[])
    setAttachments(atts)
  }, [taskId])

  useEffect(() => { load() }, [load])

  if (!event) return <div className="meeting-loading">Loading…</div>

  const color = getColor(event.context)
  const done = subtasks.filter(s => s.status === 'done').length
  const pct = subtasks.length ? Math.round(done / subtasks.length * 100) : 0
  const timeStr = fmtTime(event.event_time)

  async function toggleSubtask(sub: Task) {
    const isDone = sub.status === 'done'
    if (isDone) await api.uncomplete(sub.id)
    else await api.complete(sub.id)
    setSubtasks(ss => ss.map(s => s.id === sub.id ? { ...s, status: isDone ? 'active' : 'done' } : s))
  }

  async function addAgendaItem() {
    if (!newAgenda.trim()) return
    const sub = await api.createSubtask(taskId, newAgenda.trim()) as Task
    setSubtasks(s => [...s, sub])
    setNewAgenda('')
  }

  function onNotesInput() {
    setSaveStatus('Unsaved…')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      if (!notesRef.current) return
      await api.updateNotes(taskId, notesRef.current.value)
      setSaveStatus('Saved')
      setTimeout(() => setSaveStatus(''), 2000)
    }, 1200)
  }

  async function createTaskFromMeeting() {
    if (!newTask.trim() || !event) return
    const body: Parameters<typeof api.createTask>[0] = {
      title: newTask.trim(),
      context: event.context,
      project: event.project ?? undefined,
      ai_context: `Created during meeting: ${event.title}`,
    } as any
    if (newTaskDate) (body as any).due_date = newTaskDate
    const task = await api.createTask(body) as Task
    setCreatedTasks(c => [...c, task.title])
    setNewTask('')
    setNewTaskDate('')
  }

  return (
    <div className="meeting-view">
      <div className="meeting-header">
        <button className="meeting-back" onClick={onBack}>← Back</button>
        <span className="meeting-event-title">{event.title}</span>
        <span className="meeting-time" style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}>
          {timeStr}
        </span>
        {subtasks.length > 0 && (
          <div className="meeting-progress-wrap">
            <div className="meeting-progress-bar-outer">
              <div className="meeting-progress-bar-inner" style={{ width: `${pct}%`, background: color }} />
            </div>
            <span className="meeting-progress-label">{done}/{subtasks.length}</span>
          </div>
        )}
      </div>

      <div className="meeting-body">
        <div className="meeting-left">
          <div className="meeting-section-label">Agenda</div>
          <div className="agenda-list">
            {subtasks.length === 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 0' }}>No agenda items yet.</div>
            )}
            {subtasks.map(s => (
              <div key={s.id} className={`meeting-agenda-row ${s.status === 'done' ? 'done' : ''}`}>
                <button
                  className={`meeting-check ${s.status === 'done' ? 'checked' : ''}`}
                  style={s.status === 'done' ? { background: `${color}20`, borderColor: color, color } : undefined}
                  onClick={() => toggleSubtask(s)}
                >
                  {s.status === 'done' ? '✓' : ''}
                </button>
                <span className={`meeting-item-title ${s.status === 'done' ? 'strikethrough' : ''}`}>{s.title}</span>
              </div>
            ))}
          </div>
          <div className="add-agenda-row">
            <input
              className="add-agenda-input"
              placeholder="Add agenda item…"
              value={newAgenda}
              onChange={e => setNewAgenda(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAgendaItem() } }}
            />
            <button className="add-agenda-btn" onClick={addAgendaItem}>+</button>
          </div>

          {attachments.length > 0 && (
            <div className="meeting-tasks">
              <div className="meeting-section-label" style={{ marginTop: 16 }}>Attachments</div>
              {attachments.map(a => (
                <div key={a.id} className="meeting-attachment-row">
                  <a
                    href={a.url ?? `/api/attachment/${a.id}/local`}
                    target="_blank"
                    rel="noreferrer"
                    className="meeting-attachment-link"
                    title={a.filename}
                  >
                    📎 {a.filename}
                  </a>
                </div>
              ))}
            </div>
          )}

          {createdTasks.length > 0 && (
            <div className="meeting-tasks">
              <div className="meeting-section-label" style={{ marginTop: 4 }}>Tasks Created</div>
              {createdTasks.map((t, i) => (
                <div key={i} className="created-task-item">{t}</div>
              ))}
            </div>
          )}
        </div>

        <div className="meeting-right">
          <div className="meeting-notes-label">
            <span className="meeting-section-label" style={{ margin: 0 }}>Notes</span>
            <span className="meeting-save-indicator">{saveStatus}</span>
          </div>
          <textarea
            ref={notesRef}
            className="meeting-notes"
            placeholder="Meeting notes…"
            defaultValue={event.notes ?? ''}
            onInput={onNotesInput}
          />
          <div className="quick-task-row">
            <input
              className="quick-task-input"
              placeholder="Create a task from this meeting…"
              value={newTask}
              onChange={e => setNewTask(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createTaskFromMeeting() } }}
            />
            <input
              type="date"
              className="quick-task-date"
              value={newTaskDate}
              onChange={e => setNewTaskDate(e.target.value)}
              title="Due date (optional)"
            />
            <button className="quick-task-btn" onClick={createTaskFromMeeting}>+ Task</button>
          </div>
        </div>
      </div>
    </div>
  )
}
