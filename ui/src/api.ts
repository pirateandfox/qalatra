import type { Task, Attachment } from './types/task'

// All data operations go through Electron IPC — no HTTP server needed.
// window.electronAPI.invoke(channel, ...args) is exposed by preload.cjs.
const ipc = (channel: string, ...args: unknown[]) =>
  (window as any).electronAPI.invoke(channel, ...args)

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
  return ipc('tasks:list', date)
}

export async function fetchTask(id: string): Promise<Task> {
  return ipc('task:get', id)
}

export async function fetchSubtasks(id: string): Promise<Task[]> {
  return ipc('task:subtasks', id)
}

export async function fetchBacklog(): Promise<Task[]> {
  return ipc('task:backlog')
}

export async function fetchDailyNote(date: string): Promise<{ date: string; content: string }> {
  return ipc('daily-note:get', date)
}

export async function saveDailyNote(date: string, content: string): Promise<void> {
  await ipc('daily-note:save', date, content)
}

export interface Context {
  slug: string
  label: string
  color: string
  sort_order: number | null
}

export async function fetchContexts(): Promise<Context[]> {
  return ipc('contexts:list')
}

export async function createContext(slug: string, label: string, color: string): Promise<void> {
  await ipc('contexts:create', slug, label, color)
}

export async function updateContext(slug: string, fields: Partial<Pick<Context, 'label' | 'color' | 'sort_order'>>): Promise<void> {
  await ipc('contexts:update', slug, fields)
}

export async function deleteContext(slug: string): Promise<void> {
  await ipc('contexts:delete', slug)
}

export interface Agent {
  name: string
  description: string | null
  command: string | null
  path: string
  relativePath: string
}

export async function fetchAgents(): Promise<Agent[]> {
  return ipc('agents:list')
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
  return ipc('agent-jobs:create', taskId, userMessage ?? null)
}

export async function fetchNotes(taskId: string): Promise<Note[]> {
  return ipc('notes:list', taskId)
}

export async function addNote(taskId: string, body: string): Promise<{ id: string }> {
  return ipc('notes:add', taskId, body)
}

export async function fetchAgentJobs(taskId: string): Promise<AgentJob[]> {
  return ipc('agent-jobs:list', taskId)
}

export async function fetchAttachments(taskId: string): Promise<Attachment[]> {
  return ipc('attachments:list', taskId)
}

export async function deleteAttachment(id: string): Promise<void> {
  await ipc('attachments:delete', id)
}

export async function updateTask(id: string, fields: Record<string, unknown>): Promise<void> {
  await ipc('task:update', id, fields)
}

export async function fetchSettings(): Promise<Record<string, string>> {
  return ipc('settings:get')
}

export async function saveSettings(data: Record<string, string>): Promise<void> {
  await ipc('settings:save', data)
}

export async function syncAttachments(): Promise<{ ok: boolean; synced?: number; failed?: number; total?: number; error?: string }> {
  return ipc('attachments:sync')
}

export async function getMcpStatus(): Promise<{ port: number; isHttpConfigured: boolean; currentEntry: unknown }> {
  return ipc('mcp:status')
}

export async function applyMcpPort(port: number): Promise<{ ok: boolean; port: number; url: string; error?: string }> {
  return ipc('mcp:apply', port)
}

export const api = {
  complete:             (taskId: string) => ipc('task:complete', taskId),
  completeWithSubtasks: (taskId: string) => ipc('task:complete-with-subtasks', taskId),
  uncomplete:           (taskId: string) => ipc('task:uncomplete', taskId),
  skip:                 (taskId: string) => ipc('task:skip', taskId),
  activate:             (taskId: string) => ipc('task:activate', taskId),
  snooze:               (taskId: string, until: string) => ipc('task:snooze', taskId, until),
  updateTitle:          (taskId: string, title: string) => ipc('task:update-title', taskId, title),
  updateDescription:    (taskId: string, description: string) => ipc('task:update-description', taskId, description),
  updateDueDate:        (taskId: string, due_date: string | null) => ipc('task:update-due-date', taskId, due_date),
  updateRecurrence:     (taskId: string, recurrence: string | null) => ipc('task:update-recurrence', taskId, recurrence),
  addLink:              (taskId: string, url: string) => ipc('task:add-link', taskId, url),
  reorder:              (ids: string[]) => ipc('task:reorder', ids),
  createSubtask:        (parentId: string, title: string) => ipc('task:create-subtask', parentId, title),
  createTask:           (body: Partial<Task> & { title: string }) => ipc('task:create', body),
  deleteTask:           (taskId: string) => ipc('task:delete', taskId),
  updateNotes:          (taskId: string, notes: string) => ipc('task:update', taskId, { notes }),
}
