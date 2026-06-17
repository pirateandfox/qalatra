import type { Task, Attachment } from './types/task'
import { currentServerInstance, enc, httpJson, jsonRequest, v1 } from './apiRuntime'

export {
  createAccessToken,
  currentServerInstance,
  getAccessTokenExpiryLabel,
  getActiveInstance,
  getActiveInstanceId,
  getDefaultInstanceId,
  getHideLocalInstance,
  getInstances,
  getLocalServerServiceStatus,
  getLocalServerStatus,
  installLocalServerService,
  listAccessTokens,
  onInstanceConfigChange,
  removeInstance,
  restartLocalServer,
  restartLocalServerService,
  revokeAccessToken,
  saveInstances,
  setActiveInstance,
  setDefaultInstance,
  setHideLocalInstance,
  startLocalServer,
  startLocalServerService,
  stopLocalServer,
  stopLocalServerService,
  subscribeServerEvents,
  testInstanceConnection,
  tokenIsExpired,
  uninstallLocalServerService,
  updateInstance,
  upsertInstance,
  type AccessToken,
  type LocalServerServiceStatus,
  type LocalServerStatus,
  type QalatraInstance,
} from './apiRuntime'

export interface BoxWebSession {
  url: string
  path: string
  expiresAt: string
  target: string
}

export interface BoxWebStatus {
  ok: boolean
  available: boolean
  target: string
  statusCode?: number | null
  error?: string
}

export async function createBoxWebSession(): Promise<BoxWebSession> {
  const active = await currentServerInstance()
  const data = await httpJson(active, '/api/box-web/session', { method: 'POST' })
  return {
    url: `${active.url}${data.session.path}`,
    path: data.session.path,
    expiresAt: data.session.expiresAt,
    target: data.session.target,
  }
}

export async function getBoxWebStatus(): Promise<BoxWebStatus> {
  const active = await currentServerInstance()
  const data = await httpJson(active, '/api/box-web/status', { method: 'GET' })
  return {
    ok: !!data.ok,
    available: !!data.available,
    target: data.target,
    statusCode: data.statusCode,
    error: data.error,
  }
}

export async function readTextFile(path: string): Promise<string> {
  const active = await currentServerInstance()
  const data = await httpJson(active, `/api/files?path=${encodeURIComponent(path)}`, { method: 'GET' })
  return data.content
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  const active = await currentServerInstance()
  await httpJson(active, `/api/files?path=${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify({ content: contents }) })
}

export async function textFileExists(path: string): Promise<boolean> {
  const active = await currentServerInstance()
  const data = await httpJson(active, `/api/files/exists?path=${encodeURIComponent(path)}`, { method: 'GET' })
  return !!data.exists
}

export interface WorkspaceRoot {
  path: string
  name: string
  exists: boolean
  isDirectory: boolean
}

export interface DirectoryEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink'
  size: number | null
  modifiedAt: string | null
  extension: string
}

export async function listWorkspaceRoots(): Promise<WorkspaceRoot[]> {
  const active = await currentServerInstance()
  const data = await httpJson(active, '/api/workspace/roots', { method: 'GET' })
  return data.roots ?? []
}

export async function listDirectory(path: string): Promise<{ path: string; entries: DirectoryEntry[] }> {
  const active = await currentServerInstance()
  const data = await httpJson(active, `/api/files/list?path=${encodeURIComponent(path)}`, { method: 'GET' })
  return { path: data.path, entries: data.entries ?? [] }
}

export interface TerminalSession {
  id: string
  title: string
  cwd: string
  taskId: string | null
  agentPath: string | null
  tmuxSession: string
  createdAt: string
  lastActivityAt: string
  lastAttachedAt: string | null
  status: 'running' | 'exited'
}

export interface TerminalStatus {
  tmux: { ok: boolean; version: string | null; error: string | null }
  sessions: TerminalSession[]
}

export async function listTerminalSessions(): Promise<TerminalStatus> {
  const active = await currentServerInstance()
  const data = await httpJson(active, '/api/terminal/sessions', { method: 'GET' })
  return { tmux: data.tmux, sessions: data.sessions ?? [] }
}

export async function createTerminalSession(body: { title?: string; cwd?: string; taskId?: string | null; agentPath?: string | null; command?: string }): Promise<TerminalSession> {
  const active = await currentServerInstance()
  const data = await httpJson(active, '/api/terminal/sessions', { method: 'POST', body: JSON.stringify(body) })
  return data.session
}

export async function updateTerminalSession(id: string, body: { title?: string; taskId?: string | null; agentPath?: string | null }): Promise<TerminalSession> {
  const active = await currentServerInstance()
  const data = await httpJson(active, `/api/terminal/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
  return data.session
}

export async function killTerminalSession(id: string): Promise<void> {
  const active = await currentServerInstance()
  await httpJson(active, `/api/terminal/sessions/${encodeURIComponent(id)}/kill`, { method: 'POST' })
}

export async function removeTerminalSession(id: string): Promise<void> {
  const active = await currentServerInstance()
  await httpJson(active, `/api/terminal/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function terminalSocketUrl(id: string, cols: number, rows: number): Promise<string> {
  const active = await currentServerInstance()
  const url = new URL(active.url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/api/terminal/sessions/${encodeURIComponent(id)}/socket`
  url.searchParams.set('token', active.token)
  url.searchParams.set('cols', String(cols))
  url.searchParams.set('rows', String(rows))
  return url.toString()
}

export async function findInheritedStyle(dir: string): Promise<{ foundPath: string; content: string } | null> {
  const active = await currentServerInstance()
  const data = await httpJson(active, `/api/styles/inherited?dir=${encodeURIComponent(dir)}`, { method: 'GET' })
  return data.style ?? null
}

export async function writeUserStyle(contents: string): Promise<void> {
  const active = await currentServerInstance()
  await httpJson(active, '/api/styles/user', { method: 'PUT', body: JSON.stringify({ content: contents }) })
}

export async function writeFolderStyle(dir: string, contents: string): Promise<void> {
  const active = await currentServerInstance()
  await httpJson(active, '/api/styles/folder', { method: 'PUT', body: JSON.stringify({ dir, content: contents }) })
}

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
  inbox?: Task[]
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
  const data = await v1(`/tasks?date=${enc(date)}`, { method: 'GET' })
  return data.data
}

export async function fetchTask(id: string): Promise<Task> {
  const data = await v1(`/tasks/${enc(id)}`, { method: 'GET' })
  return data.task
}

export async function fetchSubtasks(id: string): Promise<Task[]> {
  const data = await v1(`/tasks/${enc(id)}/subtasks`, { method: 'GET' })
  return data.tasks ?? []
}

export async function fetchBacklog(): Promise<Task[]> {
  const data = await v1('/tasks/backlog', { method: 'GET' })
  return data.tasks ?? []
}

export async function fetchCodingTasks(): Promise<Task[]> {
  const data = await v1('/tasks/coding', { method: 'GET' })
  return data.tasks ?? []
}

export async function fetchReadingTasks(): Promise<Task[]> {
  const data = await v1('/tasks/reading', { method: 'GET' })
  return data.tasks ?? []
}

export async function fetchStaleTasks(days?: number): Promise<Task[]> {
  const suffix = days == null ? '' : `?days=${enc(String(days))}`
  const data = await v1(`/tasks/stale${suffix}`, { method: 'GET' })
  return data.tasks ?? []
}

export async function searchTasks(query: string, scope: 'open' | 'all' = 'open', limit = 80): Promise<Task[]> {
  const params = new URLSearchParams({ query, scope, limit: String(limit) })
  const data = await v1(`/tasks/search?${params.toString()}`, { method: 'GET' })
  return data.tasks ?? []
}

export async function fetchDailyNote(date: string): Promise<{ date: string; content: string }> {
  const data = await v1(`/daily-notes/${enc(date)}`, { method: 'GET' })
  return data.note
}

export async function saveDailyNote(date: string, content: string): Promise<void> {
  await v1(`/daily-notes/${enc(date)}`, jsonRequest('PUT', { content }))
}

export interface Context {
  slug: string
  label: string
  color: string
  sort_order: number | null
}

export async function fetchContexts(): Promise<Context[]> {
  const data = await v1('/contexts', { method: 'GET' })
  return data.contexts ?? []
}

export async function createContext(slug: string, label: string, color: string): Promise<void> {
  await v1('/contexts', jsonRequest('POST', { slug, label, color }))
}

export async function updateContext(slug: string, fields: Partial<Pick<Context, 'label' | 'color' | 'sort_order'>>): Promise<void> {
  await v1(`/contexts/${enc(slug)}`, jsonRequest('PATCH', fields))
}

export async function deleteContext(slug: string): Promise<void> {
  await v1(`/contexts/${enc(slug)}`, { method: 'DELETE' })
}

export interface Project {
  name: string
  archived: number
  created_at: string
  is_repo: number
  context: string | null
}

export interface ProjectSummary {
  name: string
  context: string | null
  isRepo: boolean
  activeCount: number
  codingCount: number
  backlogCount: number
  agentCount: number
}

export interface AgentRecord {
  path: string
  name: string
  context: string | null
  project: string | null
  description: string | null
  command: string | null
  coding: number
  relative_path: string | null
  folder: string | null
  last_seen: string
}

export interface ProjectDetail {
  name: string
  context: string | null
  isRepo: boolean
  active: Task[]
  coding: Task[]
  backlog: Task[]
  doneRecent: Task[]
  agents: AgentRecord[]
}

export async function fetchProjects(includeArchived = false): Promise<Project[]> {
  const data = await v1(`/projects?includeArchived=${includeArchived ? '1' : '0'}`, { method: 'GET' })
  return data.projects ?? []
}

export async function fetchProjectSummaries(): Promise<ProjectSummary[]> {
  const data = await v1('/projects/summaries', { method: 'GET' })
  return data.summaries ?? []
}

export async function fetchProjectDetail(name: string): Promise<ProjectDetail> {
  const data = await v1(`/projects/${enc(name)}`, { method: 'GET' })
  return data.project
}

export async function fetchAgentsDb(): Promise<AgentRecord[]> {
  const data = await v1('/agents/db', { method: 'GET' })
  return data.agents ?? []
}

export async function createProjectExplicit(name: string): Promise<void> {
  await v1('/projects', jsonRequest('POST', { name }))
}

export async function updateProject(name: string, fields: { is_repo?: number; archived?: number }): Promise<void> {
  await v1(`/projects/${enc(name)}`, jsonRequest('PATCH', fields))
}

export async function rescanAgents(): Promise<void> {
  await v1('/agents/rescan', { method: 'POST' })
}

export async function renameProject(oldName: string, newName: string): Promise<{ ok: boolean; merged: boolean }> {
  const data = await v1(`/projects/${enc(oldName)}/rename`, jsonRequest('POST', { name: newName }))
  return data.result
}

export async function setProjectContext(name: string, context: string): Promise<void> {
  await v1(`/projects/${enc(name)}/context`, jsonRequest('PUT', { context }))
}

export async function archiveProject(name: string): Promise<void> {
  await v1(`/projects/${enc(name)}/archive`, { method: 'POST' })
}

export async function unarchiveProject(name: string): Promise<void> {
  await v1(`/projects/${enc(name)}/unarchive`, { method: 'POST' })
}

export async function deleteProject(name: string): Promise<void> {
  await v1(`/projects/${enc(name)}`, { method: 'DELETE' })
}

export interface Agent {
  name: string
  context: string | null
  project: string | null
  description: string | null
  command: string | null
  coding: boolean
  path: string
  relativePath: string
  folder: string | null   // top-level project folder name (null for agents at the scan root)
}

export async function fetchAgents(): Promise<Agent[]> {
  const data = await v1('/agents', { method: 'GET' })
  return data.agents ?? []
}

export interface HabitLog {
  status: 'done' | 'skipped'
  notes: string | null
}

export interface HabitWeekDay {
  date: string
  due: boolean
  log: HabitLog | null
}

export interface Habit {
  id: string
  title: string
  description: string | null
  recurrence: string
  recurrence_days: string | null
  today_log: HabitLog | null
  week: HabitWeekDay[]
}

export async function listHabits(date: string): Promise<Habit[]> {
  const data = await v1(`/habits?date=${enc(date)}`, { method: 'GET' })
  return data.habits ?? []
}

export async function createHabit(body: Record<string, unknown>): Promise<void> {
  await v1('/habits', jsonRequest('POST', body))
}

export async function updateHabit(body: Record<string, unknown>): Promise<void> {
  const id = String(body.id ?? '')
  await v1(`/habits/${enc(id)}`, jsonRequest('PATCH', body))
}

export async function logHabit(habitId: string, date: string, status: 'done' | 'skipped', notes: string | null): Promise<void> {
  await v1(`/habits/${enc(habitId)}/log`, jsonRequest('POST', { date, status, notes }))
}

export async function unlogHabit(habitId: string, date: string): Promise<void> {
  await v1(`/habits/${enc(habitId)}/log?date=${enc(date)}`, { method: 'DELETE' })
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
  const data = await v1(`/tasks/${enc(taskId)}/agent-jobs`, jsonRequest('POST', { userMessage: userMessage ?? null }))
  return data.job
}

export async function fetchNotes(taskId: string): Promise<Note[]> {
  const data = await v1(`/tasks/${enc(taskId)}/notes`, { method: 'GET' })
  return data.notes ?? []
}

export async function addNote(taskId: string, body: string): Promise<{ id: string }> {
  const data = await v1(`/tasks/${enc(taskId)}/notes`, jsonRequest('POST', { body }))
  return data.note
}

export async function fetchAgentJobs(taskId: string): Promise<AgentJob[]> {
  const data = await v1(`/tasks/${enc(taskId)}/agent-jobs`, { method: 'GET' })
  return data.jobs ?? []
}

export interface Heartbeat {
  id: string
  title: string
  description: string | null
  agent_path: string
  prompt: string
  interval_minutes: number
  run_at_time: string | null
  minute_offset: number | null
  active: number
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  runs_done: number
  runs_failed: number
  runs_pending: number
}

export interface HeartbeatJob {
  id: string
  status: string
  result: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export async function listHeartbeats(): Promise<Heartbeat[]> {
  const data = await v1('/heartbeats', { method: 'GET' })
  return data.heartbeats ?? []
}

export async function createHeartbeat(body: Record<string, unknown>): Promise<void> {
  await v1('/heartbeats', jsonRequest('POST', body))
}

export async function updateHeartbeat(id: string, fields: Record<string, unknown>): Promise<void> {
  await v1(`/heartbeats/${enc(id)}`, jsonRequest('PATCH', fields))
}

export async function deleteHeartbeat(id: string): Promise<void> {
  await v1(`/heartbeats/${enc(id)}`, { method: 'DELETE' })
}

export async function toggleHeartbeat(id: string): Promise<void> {
  await v1(`/heartbeats/${enc(id)}/toggle`, { method: 'POST' })
}

export async function listHeartbeatJobs(id: string, limit = 10): Promise<HeartbeatJob[]> {
  const data = await v1(`/heartbeats/${enc(id)}/jobs?limit=${limit}`, { method: 'GET' })
  return data.jobs ?? []
}

export async function fetchAttachments(taskId: string): Promise<Attachment[]> {
  const active = await currentServerInstance()
  const data = await httpJson(active, `/api/attachments?taskId=${encodeURIComponent(taskId)}`, { method: 'GET' })
  return data.attachments ?? []
}

export async function deleteAttachment(id: string): Promise<void> {
  const active = await currentServerInstance()
  await httpJson(active, `/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function uploadAttachment(taskId: string, filename: string, mimeType: string, bufferArray: number[]): Promise<void> {
  const active = await currentServerInstance()
  const body = new Uint8Array(bufferArray)
  const qs = new URLSearchParams({ taskId, filename, mimeType: mimeType || 'application/octet-stream' })
  const res = await fetch(`${active.url}/api/attachments?${qs.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
      Authorization: `Bearer ${active.token}`,
    },
    body,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
}

export async function openAttachmentFile(id: string): Promise<void> {
  const active = await currentServerInstance()
  const res = await fetch(`${active.url}/api/attachments/${encodeURIComponent(id)}/content`, {
    headers: { Authorization: `Bearer ${active.token}` },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  const blobUrl = URL.createObjectURL(await res.blob())
  window.open(blobUrl, '_blank', 'noopener,noreferrer')
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
}

export async function updateTask(id: string, fields: Record<string, unknown>): Promise<void> {
  await v1(`/tasks/${enc(id)}`, jsonRequest('PATCH', fields))
}

export async function markReviewed(taskId: string): Promise<void> {
  await v1(`/tasks/${enc(taskId)}/reviewed`, { method: 'POST' })
}

export async function fetchSettings(): Promise<Record<string, string>> {
  const data = await v1('/settings', { method: 'GET' })
  return data.settings ?? {}
}

export async function saveSettings(data: Record<string, string>): Promise<void> {
  await v1('/settings', jsonRequest('PUT', data))
}

export async function syncAttachments(): Promise<{ ok: boolean; synced?: number; failed?: number; total?: number; error?: string }> {
  const data = await v1('/attachments/sync', { method: 'POST' })
  return data.result
}

export async function getMcpStatus(): Promise<{ port: number; isHttpConfigured: boolean; currentEntry: unknown }> {
  return v1('/mcp', { method: 'GET' })
}

export async function applyMcpPort(port: number): Promise<{ ok: boolean; port: number; url: string; error?: string }> {
  return v1('/mcp', jsonRequest('PUT', { port }))
}

export async function testS3Connection(creds: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const data = await v1('/s3/test', jsonRequest('POST', creds))
  return data.result
}

// ── Encryption / Backup / Recovery ───────────────────────────────────────────

export interface BackupItem { key: string; size: number; date: string }

export const getKeyStatus = async (): Promise<{ present: boolean }> => v1('/key', { method: 'GET' })
export const generateKey = async (): Promise<{ ok: boolean }> => {
  const data = await v1('/key', { method: 'POST' })
  return data.result
}
export const exportKey = async (): Promise<{ ok: boolean; key?: string; error?: string }> => {
  const data = await v1('/key/export', { method: 'GET' })
  return data.result
}
export const importKey = async (base64: string): Promise<{ ok: boolean; error?: string }> => {
  const data = await v1('/key/import', jsonRequest('PUT', { base64 }))
  return data.result
}
export const runBackup = async (): Promise<{ ok: boolean; key?: string; size?: number; error?: string }> => {
  const data = await v1('/backup', { method: 'POST' })
  return data.result
}
export const getBackupStatus = async (): Promise<{ lastTime: string | null; lastStatus: string | null }> => v1('/backup/status', { method: 'GET' })
export const listBackups = async (): Promise<{ ok: boolean; items?: BackupItem[]; error?: string }> => {
  const data = await v1('/backup', { method: 'GET' })
  return data.result
}
export const restoreBackup = async (key: string): Promise<{ ok: boolean; message?: string; error?: string }> => {
  const data = await v1('/backup/restore', jsonRequest('POST', { key }))
  return data.result
}
export const exportSettings = (): Promise<{ ok: boolean; json?: string }> => v1('/settings/export', { method: 'GET' })
export const importSettings = (json: string): Promise<{ ok: boolean; error?: string }> => v1('/settings/import', jsonRequest('POST', { json }))

export const api = {
  complete: async (taskId: string) => {
    const data = await v1(`/tasks/${enc(taskId)}/actions/complete`, { method: 'POST' })
    return data.result
  },
  completeWithSubtasks: async (taskId: string) => {
    const data = await v1(`/tasks/${enc(taskId)}/actions/complete-with-subtasks`, { method: 'POST' })
    return data.result
  },
  uncomplete: async (taskId: string) => {
    const data = await v1(`/tasks/${enc(taskId)}/actions/uncomplete`, { method: 'POST' })
    return data.result
  },
  skip: async (taskId: string) => {
    const data = await v1(`/tasks/${enc(taskId)}/actions/skip`, { method: 'POST' })
    return data.result
  },
  activate: async (taskId: string) => {
    const data = await v1(`/tasks/${enc(taskId)}/actions/activate`, { method: 'POST' })
    return data.result
  },
  snooze: async (taskId: string, until: string) => {
    const data = await v1(`/tasks/${enc(taskId)}/actions/snooze`, jsonRequest('POST', { until }))
    return data.result
  },
  updateTitle: async (taskId: string, title: string) => {
    const data = await v1(`/tasks/${enc(taskId)}/title`, jsonRequest('PATCH', { title }))
    return data.result
  },
  updateDescription: async (taskId: string, description: string) => {
    const data = await v1(`/tasks/${enc(taskId)}/description`, jsonRequest('PATCH', { description }))
    return data.result
  },
  updateDueDate: async (taskId: string, due_date: string | null) => {
    const data = await v1(`/tasks/${enc(taskId)}/due-date`, jsonRequest('PATCH', { due_date }))
    return data.result
  },
  updateRecurrence: async (taskId: string, recurrence: string | null) => {
    const data = await v1(`/tasks/${enc(taskId)}/recurrence`, jsonRequest('PATCH', { recurrence }))
    return data.result
  },
  addLink: async (taskId: string, url: string) => {
    const data = await v1(`/tasks/${enc(taskId)}/links`, jsonRequest('POST', { url }))
    return data.result
  },
  reorder: async (ids: string[]) => {
    const data = await v1('/tasks/reorder', jsonRequest('POST', { ids }))
    return data.result
  },
  createSubtask: async (parentId: string, title: string) => {
    const data = await v1(`/tasks/${enc(parentId)}/subtasks`, jsonRequest('POST', { title }))
    return data.task
  },
  createTask: async (body: Partial<Task> & { title: string }) => {
    const data = await v1('/tasks', jsonRequest('POST', body))
    return data.task
  },
  deleteTask: async (taskId: string) => {
    const data = await v1(`/tasks/${enc(taskId)}`, { method: 'DELETE' })
    return data.result
  },
  updateNotes: (taskId: string, notes: string) => updateTask(taskId, { notes }),
  markReviewed,
  clearInbox: (taskId: string) => updateTask(taskId, { inbox: 0 }),
}
