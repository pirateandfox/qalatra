import { useEffect, useState, useRef, useCallback } from 'react'
import type { Task, Subtask } from '../types/task'
import RecurrencePicker from './RecurrencePicker'
import PlatformIcon from './PlatformIcon'
import { api, updateTask, fetchTask, fetchSubtasks, fetchAttachments, fetchAgents, deleteAttachment, queueAgentJob, fetchAgentJobs, fetchNotes, addNote, type Agent, type AgentJob, type Note } from '../api'
import type { Attachment } from '../types/task'
import { PRIORITY_COLORS } from '../lib/constants'
import { useContexts } from '../lib/ContextsProvider'
import './DetailPanel.css'

function TimePicker({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const parts = value.split(':')
  const hStr = (parts[0] ?? '09').padStart(2, '0')
  const mStr = (parts[1] ?? '00').padStart(2, '0')
  const mSnap = ['00', '15', '30', '45'].includes(mStr) ? mStr : '00'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <select
        className="detail-select"
        disabled={disabled}
        value={hStr}
        onChange={e => onChange(`${e.target.value}:${mSnap}`)}
      >
        {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map(h => (
          <option key={h} value={h}>{h}h</option>
        ))}
      </select>
      <select
        className="detail-select"
        disabled={disabled}
        value={mSnap}
        onChange={e => onChange(`${hStr}:${e.target.value}`)}
      >
        {['00', '15', '30', '45'].map(m => (
          <option key={m} value={m}>{m}m</option>
        ))}
      </select>
    </span>
  )
}

interface Props {
  taskId: string | null
  onClose: () => void
  onMutate?: () => void
  onDelete?: () => void
  terminalOpen?: boolean
  onPreview?: (filePath: string) => void
}

function previewType(url: string): 'email' | 'md' | null {
  if (url.includes('/agents/email/output/')) return 'email'
  if (url.endsWith('.md')) return 'md'
  return null
}

interface Link {
  url: string
  label?: string
}

import { detectPlatform } from '../lib/constants'

const ENERGY_OPTIONS = ['high', 'medium', 'low', 'async'] as const
const ENERGY_LABELS: Record<string, string> = { high: '🔥 High', medium: '⚡ Med', low: '🌿 Low', async: '📬 Async' }

export default function DetailPanel({ taskId, onClose, onMutate, onDelete, terminalOpen, onPreview }: Props) {
  const { contexts, getColor } = useContexts()
  const [task, setTask]       = useState<Task | null>(null)
  const [subtasks, setSubtasks] = useState<Subtask[]>([])
  const [loading, setLoading] = useState(false)
  const [description, setDescription] = useState('')
  const [descDirty, setDescDirty] = useState(false)
  const [descSaved, setDescSaved] = useState(false)
  const [latestJob, setLatestJob] = useState<AgentJob | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [noteInput, setNoteInput] = useState('')
  const [sendToAgent, setSendToAgent] = useState(false)
  const [sendingNote, setSendingNote] = useState(false)
  const threadEndRef = useRef<HTMLDivElement>(null)
  const [addingLink, setAddingLink] = useState(false)
  const [linkInput, setLinkInput]   = useState('')
  const [newSubtask, setNewSubtask] = useState('')
  const [agents, setAgents] = useState<Agent[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [editingProject, setEditingProject] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [projectInput, setProjectInput] = useState('')
  const titleRef = useRef<HTMLDivElement>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)
  const projectInputRef = useRef<HTMLInputElement>(null)

  async function patch(fields: Record<string, unknown>) {
    if (!task) return
    await updateTask(task.id, fields)
    setTask(t => t ? { ...t, ...fields } : t)
    onMutate?.()
  }

  async function handleDelete() {
    if (!task) return
    if (!window.confirm(`Delete "${task.title}"? This cannot be undone.`)) return
    await api.deleteTask(task.id)
    onDelete?.()
    onClose()
  }

  useEffect(() => { if (taskId) fetchAgents().then(setAgents) }, [taskId])

  const load = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const [t, s, atts, notesList] = await Promise.all([
        fetchTask(id),
        fetchSubtasks(id),
        fetchAttachments(id),
        fetchNotes(id),
      ])
      setTask(t)
      setSubtasks(s as any)
      setAttachments(atts)
      setNotes(notesList)
      setDescription(t.description ?? '')
      setProjectInput(t.project ?? '')
      setDescDirty(false)
      if (t.agent_path) {
        fetchAgentJobs(id).then(jobs => setLatestJob(jobs[0] ?? null))
      } else {
        setLatestJob(null)
      }
    } catch (_) {
      // backend unreachable — panel will just be empty
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (taskId) load(taskId)
    else setTask(null)
  }, [taskId, load])

  useEffect(() => {
    if (!task?.id || !latestJob || (latestJob.status !== 'queued' && latestJob.status !== 'running')) return
    const interval = setInterval(() => {
      fetchAgentJobs(task.id).then(jobs => {
        const updated = jobs[0] ?? null
        const wasRunning = latestJob.status === 'queued' || latestJob.status === 'running'
        const nowDone = !updated || (updated.status !== 'queued' && updated.status !== 'running')
        setLatestJob(updated)
        if (wasRunning && nowDone) {
          fetchNotes(task.id).then(setNotes)
          clearInterval(interval)
        }
      })
    }, 2000)
    return () => clearInterval(interval)
  }, [task?.id, latestJob?.status])

  useEffect(() => {
    if (addingLink) linkInputRef.current?.focus()
  }, [addingLink])

  useEffect(() => {
    if (editingProject) projectInputRef.current?.focus()
  }, [editingProject])

  async function saveTitle() {
    if (!task) return
    const title = titleRef.current?.innerText.trim()
    if (!title || title === task.title) return
    await api.updateTitle(task.id, title)
    setTask(t => t ? { ...t, title: title } : t)
    onMutate?.()
  }

  async function saveDescription() {
    if (!task || !descDirty) return
    await patch({ description })
    setDescDirty(false)
    setDescSaved(true)
    setTimeout(() => setDescSaved(false), 2000)
  }

  async function runAgent(userMessage?: string) {
    if (!task) return
    const job = await queueAgentJob(task.id, userMessage)
    setLatestJob(job)
  }

  async function sendNote() {
    if (!task || !noteInput.trim()) return
    setSendingNote(true)
    const text = noteInput.trim()
    setNoteInput('')
    await addNote(task.id, text)
    if (sendToAgent && task.agent_path) {
      await runAgent(text)
    }
    const updated = await fetchNotes(task.id)
    setNotes(updated)
    setSendingNote(false)
    setTimeout(() => threadEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  async function updateDueDate(val: string) {
    await patch({ due_date: val || null })
  }

  async function addLink() {
    if (!task || !linkInput.trim()) return
    await api.addLink(task.id, linkInput.trim())
    setLinkInput('')
    setAddingLink(false)
    load(task.id)
  }

  async function addSubtask() {
    if (!task || !newSubtask.trim()) return
    await api.createSubtask(task.id, newSubtask.trim())
    setNewSubtask('')
    load(task.id)
  }

  async function toggleSubtask(sub: Subtask) {
    const isDone = sub.status === 'done'
    if (isDone) {
      await api.uncomplete(sub.id)
    } else {
      await api.complete(sub.id)
    }
    setSubtasks(ss => ss.map(s => s.id === sub.id ? { ...s, status: isDone ? 'active' : 'done' } : s))
  }

  async function handleAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !task) return
    setUploading(true)
    const buffer = await file.arrayBuffer()
    await (window as any).electronAPI.invoke('attachments:upload', task.id, file.name, file.type, Array.from(new Uint8Array(buffer)))
    const atts = await fetchAttachments(task.id)
    setAttachments(atts)
    setUploading(false)
    e.target.value = ''
  }

  async function handleDeleteAttachment(id: string) {
    await deleteAttachment(id)
    setAttachments(a => a.filter(x => x.id !== id))
  }

  function fileIcon(mime: string | null) {
    if (!mime) return '📄'
    if (mime.startsWith('image/')) return '🖼️'
    if (mime === 'application/pdf') return '📄'
    if (mime.includes('spreadsheet') || mime.includes('excel')) return '📊'
    if (mime.includes('word') || mime.includes('document')) return '📝'
    return '📎'
  }

  function formatSize(bytes: number) {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  }

  const links: Link[] = (() => {
    try {
      const raw = JSON.parse(task?.links ?? '[]')
      return (raw as unknown[]).map(l => typeof l === 'string' ? { url: l } : l as Link)
    } catch { return [] }
  })()

  if (!taskId) return null

  return (
    <div className={`detail-panel ${taskId ? 'open' : ''}`}>
      <div className="detail-inner" style={{ paddingBottom: terminalOpen ? 316 : 80 }}>
        <div className="detail-header">
          <button className="detail-close" onClick={onClose}>✕</button>
        </div>

        {loading && <div className="detail-loading">Loading…</div>}

        {!loading && task && (
          <>
            {/* Title */}
            <div
              ref={titleRef}
              className="detail-title"
              contentEditable
              suppressContentEditableWarning
              onBlur={saveTitle}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); titleRef.current?.blur() } }}
            >
              {task.title}
            </div>

            {/* Context */}
            <div className="detail-field-row">
              <span className="detail-field-label">Context</span>
              <select
                className="detail-select"
                value={task.context ?? ''}
                onChange={e => patch({ context: e.target.value })}
                style={{ color: getColor(task.context ?? '') }}
              >
                {contexts.map(c => (
                  <option key={c.slug} value={c.slug}>{c.label}</option>
                ))}
              </select>
            </div>

            {/* Priority */}
            <div className="detail-field-row">
              <span className="detail-field-label">Priority</span>
              <div className="detail-pill-group">
                {[1,2,3,4,5].map(p => (
                  <button
                    key={p}
                    className={`detail-pill detail-pill-priority ${task.my_priority === p ? 'active' : ''}`}
                    style={task.my_priority === p ? { background: `${PRIORITY_COLORS[p]}20`, color: PRIORITY_COLORS[p], borderColor: `${PRIORITY_COLORS[p]}60` } : {}}
                    onClick={() => patch({ my_priority: task.my_priority === p ? null : p })}
                  >P{p}</button>
                ))}
              </div>
            </div>

            {/* Energy */}
            <div className="detail-field-row">
              <span className="detail-field-label">Energy</span>
              <div className="detail-pill-group">
                {ENERGY_OPTIONS.map(e => (
                  <button
                    key={e}
                    className={`detail-pill ${task.energy_required === e ? 'active' : ''}`}
                    onClick={() => patch({ energy_required: task.energy_required === e ? null : e })}
                  >{ENERGY_LABELS[e]}</button>
                ))}
              </div>
            </div>

            {/* Project + Due date row */}
            <div className="detail-field-row">
              <span className="detail-field-label">Project</span>
              {editingProject ? (
                <input
                  ref={projectInputRef}
                  className="detail-inline-input"
                  value={projectInput}
                  onChange={e => setProjectInput(e.target.value)}
                  onBlur={() => { patch({ project: projectInput || null }); setEditingProject(false) }}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { patch({ project: projectInput || null }); setEditingProject(false) } }}
                  placeholder="Project name…"
                />
              ) : (
                <span className="detail-inline-value" onClick={() => setEditingProject(true)}>
                  {task.project || <span style={{ color: 'var(--muted)' }}>None</span>}
                </span>
              )}
            </div>

            {/* Agent */}
            {agents.length > 0 && (
              <div className="detail-field-row">
                <span className="detail-field-label">Agent</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                  <select
                    className="detail-select"
                    style={{ flex: 1 }}
                    value={task.agent_path ?? ''}
                    onChange={e => { patch({ agent_path: e.target.value || null }); setLatestJob(null) }}
                  >
                    <option value="">None</option>
                    {agents.map(a => (
                      <option key={a.path} value={a.path} title={a.description ?? undefined}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  {task.agent_path && (!latestJob?.session_id || !task.agent_resume) && (
                    <button
                      className="detail-run-btn"
                      onClick={() => runAgent()}
                      disabled={latestJob?.status === 'queued' || latestJob?.status === 'running'}
                      title="Run agent with this task"
                    >
                      {latestJob?.status === 'queued' || latestJob?.status === 'running' ? '…' : '▶ Run'}
                    </button>
                  )}
                </div>
              </div>
            )}
            {task.agent_path && (
              <div className="detail-field-row">
                <span className="detail-field-label">Mode</span>
                <select
                  className="detail-select"
                  value={task.agent_resume ? 'conversational' : 'oneoff'}
                  onChange={e => patch({ agent_resume: e.target.value === 'conversational' ? 1 : 0 })}
                >
                  <option value="conversational">Conversational (resume session)</option>
                  <option value="oneoff">One-off (fresh run each time)</option>
                </select>
              </div>
            )}
            {task.agent_path && (
              <div className="detail-field-row">
                <span className="detail-field-label">Auto-run</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={!!task.agent_autorun}
                      onChange={e => patch({ agent_autorun: e.target.checked ? 1 : 0 })}
                    />
                    When due, run at
                  </label>
                  <TimePicker
                    value={task.agent_autorun_time ?? '09:00'}
                    disabled={!task.agent_autorun}
                    onChange={v => patch({ agent_autorun_time: v })}
                  />
                </div>
              </div>
            )}
            {latestJob && (latestJob.status === 'queued' || latestJob.status === 'running') && (
              <div className="detail-agent-job">
                <span className={`detail-job-status detail-job-status--${latestJob.status}`}>
                  {latestJob.status === 'queued' ? '◌ Queued…' : '⟳ Running…'}
                </span>
              </div>
            )}

            {/* Dates */}
            <div className="detail-field-row">
              <span className="detail-field-label">Start</span>
              <div className="detail-meta-item">
                <input
                  type="date"
                  className="detail-due-input"
                  value={task.start_date ?? ''}
                  onChange={e => patch({ start_date: e.target.value || null })}
                />
                {task.start_date && (
                  <button className="detail-due-clear" onClick={() => patch({ start_date: null })}>✕</button>
                )}
              </div>
            </div>
            <div className="detail-field-row">
              <span className="detail-field-label">Due</span>
              <div className="detail-meta-item">
                <input
                  type="date"
                  className="detail-due-input"
                  value={task.due_date ?? ''}
                  onChange={e => updateDueDate(e.target.value)}
                />
                {task.due_date && (
                  <button className="detail-due-clear" onClick={() => updateDueDate('')}>✕</button>
                )}
              </div>
            </div>

            {/* Source link */}
            {task.source_url && (
              <a className="detail-source-link" href={task.source_url} target="_blank" rel="noreferrer">
                ↗ {detectPlatform(task.source_url).label}
              </a>
            )}

            {/* Extra links */}
            {(links.length > 0 || addingLink) && (
              <div className="detail-links-row">
                {links.map((l, i) => {
                  const pt = previewType(l.url)
                  const fileName = l.url.split('/').pop() ?? l.url
                  if (pt === 'email') return (
                    <button
                      key={i}
                      className="detail-preview-btn"
                      onClick={() => onPreview?.(l.url)}
                      title={l.url}
                    >
                      <span className="detail-file-icon">✉</span>
                      <span className="detail-file-name">{fileName}</span>
                    </button>
                  )
                  if (pt === 'md') return (
                    <button
                      key={i}
                      className="detail-preview-btn"
                      onClick={() => onPreview?.(l.url)}
                      title={l.url}
                    >
                      <span className="detail-file-icon">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                          <line x1="16" y1="13" x2="8" y2="13"/>
                          <line x1="16" y1="17" x2="8" y2="17"/>
                          <polyline points="10 9 9 9 8 9"/>
                        </svg>
                      </span>
                      <span className="detail-file-name">{fileName}</span>
                    </button>
                  )
                  return (
                    <a key={i} className="detail-platform-icon" href={l.url} target="_blank" rel="noreferrer"
                      title={l.label ?? detectPlatform(l.url).label}>
                      <PlatformIcon url={l.url} size={16} />
                    </a>
                  )
                })}
              </div>
            )}

            {addingLink ? (
              <div className="detail-links-row">
                <input
                  ref={linkInputRef}
                  className="add-link-input"
                  placeholder="Paste URL…"
                  value={linkInput}
                  onChange={e => setLinkInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addLink(); if (e.key === 'Escape') setAddingLink(false) }}
                />
                <button className="add-link-save" onClick={addLink}>Add</button>
                <button className="add-link-cancel" onClick={() => setAddingLink(false)}>Cancel</button>
              </div>
            ) : (
              <div style={{ marginBottom: 16 }}>
                <button className="detail-add-link-btn" onClick={() => setAddingLink(true)} title="Add link">+</button>
              </div>
            )}

            {/* Description */}
            <div className="detail-section-label">Description</div>
            <textarea
              className="detail-notes-area"
              value={description}
              onChange={e => { setDescription(e.target.value); setDescDirty(true); setDescSaved(false) }}
              onBlur={saveDescription}
              rows={5}
            />
            {descDirty && (
              <button className="detail-save-btn" style={{ display: 'inline-block' }} onClick={saveDescription}>
                Save
              </button>
            )}
            {descSaved && <span className="detail-notes-status">Saved ✓</span>}

            {/* Attachments */}
            <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="detail-section-label" style={{ marginBottom: 0 }}>Attachments</span>
              <button
                className="detail-attach-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Attach file"
              >{uploading ? '…' : '📎'}</button>
            </div>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleAttach} />
            {attachments.length > 0 && (
              <div className="detail-attachments-list">
                {attachments.map(a => (
                  <div key={a.id} className="detail-attachment-row">
                    <a
                      className="detail-attachment-link"
                      href={a.url ?? `/api/attachment/${a.id}/local`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {fileIcon(a.mimetype)} {a.filename}
                      {a.size_bytes != null && (
                        <span className="detail-attachment-size">{formatSize(a.size_bytes)}</span>
                      )}
                      {!a.url && !a.bucket && (
                        <span className="detail-attachment-local" title="Local only — not uploaded to cloud">local</span>
                      )}
                    </a>
                    <button className="detail-due-clear" onClick={() => handleDeleteAttachment(a.id)}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Recurrence */}
            <div className="detail-section-label" style={{ marginTop: 20 }}>Recurrence</div>
            <RecurrencePicker
              taskId={task.id}
              current={task.recurrence}
              onChange={r => setTask(t => t ? { ...t, recurrence: r } : t)}
            />

            {/* Subtasks */}
            {subtasks.length > 0 && (
              <>
                <div className="detail-section-label" style={{ marginTop: 20 }}>Subtasks</div>
                {subtasks.map(sub => (
                  <div key={sub.id} className={`detail-subtask-row ${sub.status === 'done' ? 'done' : ''}`}>
                    <button
                      className={`subtask-check ${sub.status === 'done' ? 'checked' : ''}`}
                      onClick={() => toggleSubtask(sub)}
                    >
                      {sub.status === 'done' ? '✓' : ''}
                    </button>
                    <span className={`subtask-title ${sub.status === 'done' ? 'strikethrough' : ''}`}>
                      {sub.title}
                    </span>
                  </div>
                ))}
              </>
            )}

            {/* Add subtask */}
            <div className="add-subtask-row">
              <input
                className="add-subtask-input"
                placeholder="Add subtask…"
                value={newSubtask}
                onChange={e => setNewSubtask(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addSubtask() }}
              />
              <button className="add-subtask-btn" onClick={addSubtask}>+</button>
            </div>

            {/* Danger zone */}
            <div style={{ marginTop: 32, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <button className="detail-delete-btn" onClick={handleDelete}>Delete task</button>
            </div>

            {/* Unified thread: system events + notes */}
            <div style={{ marginTop: 28, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <div className="detail-section-label">Thread</div>

              {/* System events from ai_context */}
              {task.ai_context && (
                <div className="thread-system-events">
                  {task.ai_context.split('\n').filter(Boolean).map((line, i) => {
                    const match = line.match(/^\[(.+?)\]\s*(.+)$/)
                    if (!match) return null
                    return (
                      <div key={i} className="thread-system-event">
                        <span className="thread-system-date">{match[1]}</span>
                        <span className="thread-system-text">{match[2]}</span>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Notes */}
              {notes.length > 0 && (
                <div className="thread-notes">
                  {notes.map(note => (
                    <div key={note.id} className={`thread-note thread-note--${note.author}`}>
                      <div className="thread-note-meta">
                        <span className="thread-note-author">{note.author === 'agent' ? '🤖 Agent' : 'You'}</span>
                        <span className="thread-note-date">{note.created_at.slice(0, 16).replace('T', ' ')}</span>
                      </div>
                      <div className="thread-note-body">{note.body}</div>
                    </div>
                  ))}
                </div>
              )}

              <div ref={threadEndRef} />

              {/* Chat input */}
              <div className="thread-input-area">
                <textarea
                  className="thread-input"
                  value={noteInput}
                  onChange={e => setNoteInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendNote() }}
                  placeholder="Add a note… (⌘↵ to send)"
                  rows={3}
                />
                <div className="thread-input-actions">
                  {task.agent_path && (
                    <label className="thread-agent-toggle">
                      <input
                        type="checkbox"
                        checked={sendToAgent}
                        onChange={e => setSendToAgent(e.target.checked)}
                      />
                      Run agent
                    </label>
                  )}
                  <button
                    className="thread-send-btn"
                    onClick={sendNote}
                    disabled={!noteInput.trim() || sendingNote}
                  >
                    {sendingNote ? '…' : sendToAgent ? '▶ Send + Run' : 'Send'}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
