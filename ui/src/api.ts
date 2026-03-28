import type { Task, Attachment } from './types/task'

// In production the UI loads from disk (file://) so fetch needs absolute URLs.
// preload.cjs exposes apiBase = 'http://127.0.0.1:3456' in production, '' in dev.
export const API_BASE: string = (window as any).electronAPI?.apiBase ?? ''

export interface HabitSummary {
  id: string
  title: string
  description: string | null
  recurrence: string
  today_log: { status: 'done' | 'skipped'; notes: string | null } | null
}

export interface TaskData {
  view: 'today' | 'future' | 'past'
  date: string
  overdue?: Task[]
  dueToday?: Task[]
  active?: Task[]
  wakingUp?: Task[]
  doneToday?: Task[]
  scheduled?: Task[]
  timeSnoozed?: Task[]
  completed?: Task[]
  wasDue?: Task[]
  events?: Task[]
  reminders?: Task[]
  habits?: HabitSummary[]
}

export async function fetchTasks(date: string): Promise<TaskData> {
  const res = await fetch(`${API_BASE}/api/tasks?date=${date}`)
  return res.json()
}

export async function fetchTask(id: string): Promise<Task> {
  const res = await fetch(`${API_BASE}/api/task/${id}`)
  return res.json()
}

export async function fetchSubtasks(id: string): Promise<Task[]> {
  const res = await fetch(`${API_BASE}/api/task/${id}/subtasks`)
  return res.json()
}

export async function fetchBacklog(): Promise<Task[]> {
  const res = await fetch(`${API_BASE}/api/backlog`)
  return res.json()
}

export async function fetchDailyNote(date: string): Promise<{ date: string; content: string }> {
  const res = await fetch(`${API_BASE}/api/daily-note/${date}`)
  return res.json()
}

export async function saveDailyNote(date: string, content: string): Promise<void> {
  await fetch(`${API_BASE}/api/daily-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, content }),
  })
}

export interface Context {
  slug: string
  label: string
  color: string
  sort_order: number | null
}

export async function fetchContexts(): Promise<Context[]> {
  const res = await fetch(`${API_BASE}/api/contexts`)
  return res.json()
}

export async function createContext(slug: string, label: string, color: string): Promise<void> {
  await fetch(`${API_BASE}/api/contexts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, label, color }),
  })
}

export async function updateContext(slug: string, fields: Partial<Pick<Context, 'label' | 'color' | 'sort_order'>>): Promise<void> {
  await fetch(`${API_BASE}/api/contexts/${slug}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
}

export async function deleteContext(slug: string): Promise<void> {
  await fetch(`${API_BASE}/api/contexts/${slug}`, { method: 'DELETE' })
}

export interface Agent {
  name: string
  description: string | null
  command: string | null
  path: string
  relativePath: string
}

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch(`${API_BASE}/api/agents`)
  return res.json()
}

export interface AgentJob {
  id: string
  task_id: string | null
  agent_path: string
  prompt: string
  user_message: string | null
  session_id: string | null
  status: 'queued' | 'running' | 'done' | 'failed'
  result: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface Note {
  id: string
  task_id: string
  body: string
  author: 'user' | 'agent'
  agent_job_id: string | null
  created_at: string
}

export async function queueAgentJob(taskId: string, userMessage?: string): Promise<AgentJob> {
  const res = await fetch(`${API_BASE}/api/agent-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, user_message: userMessage ?? null }),
  })
  return res.json()
}

export async function fetchNotes(taskId: string): Promise<Note[]> {
  const res = await fetch(`${API_BASE}/api/task/${taskId}/notes`)
  return res.json()
}

export async function addNote(taskId: string, body: string): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/api/task/${taskId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  return res.json()
}

export async function fetchAgentJobs(taskId: string): Promise<AgentJob[]> {
  const res = await fetch(`${API_BASE}/api/agent-jobs?task_id=${taskId}`)
  return res.json()
}

export async function fetchAttachments(taskId: string): Promise<Attachment[]> {
  const res = await fetch(`${API_BASE}/api/task/${taskId}/attachments`)
  return res.json()
}

export async function deleteAttachment(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/attachment/${id}`, { method: 'DELETE' })
}

export async function updateTask(id: string, fields: Record<string, unknown>): Promise<void> {
  await fetch(`${API_BASE}/api/task/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
}

export async function fetchSettings(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/settings`)
  return res.json()
}

export async function saveSettings(data: Record<string, string>): Promise<void> {
  await fetch(`${API_BASE}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function syncAttachments(): Promise<{ ok: boolean; synced?: number; failed?: number; total?: number; error?: string }> {
  const res = await fetch(`${API_BASE}/api/attachments/sync`, { method: 'POST' })
  return res.json()
}

export async function getMcpStatus(): Promise<{ port: number; isHttpConfigured: boolean; currentEntry: unknown }> {
  const res = await fetch(`${API_BASE}/api/mcp/status`)
  return res.json()
}

export async function applyMcpPort(port: number): Promise<{ ok: boolean; port: number; url: string; error?: string }> {
  const res = await fetch(`${API_BASE}/api/mcp/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port }),
  })
  return res.json()
}

function post(path: string, body: Record<string, unknown>, json = true) {
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString(),
  })
}

export const api = {
  complete:             (taskId: string) => post('/complete', { task_id: taskId }, false),
  completeWithSubtasks: (taskId: string) => post('/complete-with-subtasks', { task_id: taskId }, false),
  uncomplete:      (taskId: string) => post('/uncomplete', { task_id: taskId }, false),
  skip:            (taskId: string) => post('/skip', { task_id: taskId }, false),
  activate:        (taskId: string) => post('/activate', { task_id: taskId }, false),
  snooze:          (taskId: string, until: string) => post('/snooze', { task_id: taskId, until }, false),
  updateTitle:     (taskId: string, title: string) => post('/update-title', { task_id: taskId, title }),
  updateDescription: (taskId: string, description: string) => post('/update-description', { task_id: taskId, description }),
  updateDueDate:   (taskId: string, due_date: string | null) => post('/update-due-date', { task_id: taskId, due_date: due_date ?? '' }),
  updateRecurrence:(taskId: string, recurrence: string | null) => post('/update-recurrence', { task_id: taskId, recurrence: recurrence ?? '' }),
  addLink:         (taskId: string, url: string) => post('/add-link', { task_id: taskId, url }),
  reorder:         (ids: string[]) => post('/reorder', { ids }),
  createSubtask:   (parentId: string, title: string) => post('/create-subtask', { parent_id: parentId, title }),
  createTask:      (body: Partial<Task> & { title: string }) => post('/create-task-json', body as Record<string, unknown>),
  deleteTask:      (taskId: string) => fetch(`${API_BASE}/api/task/${taskId}`, { method: 'DELETE' }),
  updateNotes:     (taskId: string, notes: string) => post(`/api/task/${taskId}`, { notes }),
}
