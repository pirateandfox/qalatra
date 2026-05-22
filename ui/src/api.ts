import type { Task, Attachment } from './types/task'

const INSTANCES_KEY = 'qalatra.instances'
const ACTIVE_INSTANCE_KEY = 'qalatra.activeInstanceId'

export interface QalatraInstance {
  id: string
  name: string
  url: string
  token: string
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function normalizeUrl(url: string) {
  return url.trim().replace(/\/+$/, '')
}

export function getInstances(): QalatraInstance[] {
  try {
    const raw = localStorage.getItem(INSTANCES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveInstances(instances: QalatraInstance[]) {
  localStorage.setItem(INSTANCES_KEY, JSON.stringify(instances))
}

export function getActiveInstanceId(): string | null {
  return localStorage.getItem(ACTIVE_INSTANCE_KEY)
}

export function getActiveInstance(): QalatraInstance | null {
  const activeId = getActiveInstanceId()
  if (!activeId) return null
  return getInstances().find(i => i.id === activeId) ?? null
}

export function setActiveInstance(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_INSTANCE_KEY, id)
  else localStorage.removeItem(ACTIVE_INSTANCE_KEY)
}

export function upsertInstance(input: Partial<QalatraInstance> & { name: string; url: string; token: string }): QalatraInstance {
  const instance: QalatraInstance = {
    id: input.id || newId(),
    name: input.name.trim(),
    url: normalizeUrl(input.url),
    token: input.token.trim(),
  }
  const next = getInstances().filter(i => i.id !== instance.id)
  next.push(instance)
  saveInstances(next)
  return instance
}

export function removeInstance(id: string) {
  saveInstances(getInstances().filter(i => i.id !== id))
  if (getActiveInstanceId() === id) setActiveInstance(null)
}

function activeHttpInstance() {
  return getActiveInstance()
}

let localServerInstancePromise: Promise<QalatraInstance> | null = null

async function getDefaultLocalServerInstance(): Promise<QalatraInstance> {
  const electronAPI = (window as any).electronAPI
  if (!electronAPI?.invoke) throw new Error('Electron API is not available to start the local server')
  if (!localServerInstancePromise) {
    localServerInstancePromise = electronAPI.invoke('server:start')
      .then((status: LocalServerStatus & { ok?: boolean }) => {
        if (!status?.running || !status.token) throw new Error('Local Qalatra Server did not start')
        return {
          id: 'local-server',
          name: 'Local Server',
          url: status.url,
          token: status.token,
        }
      })
  }
  const promise = localServerInstancePromise
  if (!promise) throw new Error('Local Qalatra Server did not start')
  return promise
}

async function httpJson(instance: QalatraInstance, path: string, init: RequestInit = {}) {
  const res = await fetch(`${instance.url}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${instance.token}`,
      ...(init.headers ?? {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function v1(path: string, init: RequestInit = {}) {
  const active = await currentServerInstance()
  return httpJson(active, `/api/v1${path}`, init)
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) }
}

function enc(value: string) {
  return encodeURIComponent(value)
}

async function nativeElectronInvoke(channel: string, ...args: unknown[]) {
  const electronAPI = (window as any).electronAPI
  if (!electronAPI?.invoke) throw new Error('Electron API is not available')
  return electronAPI.invoke(channel, ...args)
}

export interface LocalServerStatus {
  running: boolean
  port: number
  url: string
  token: string | null
  keepServerRunning?: boolean
  managed?: boolean
  service?: LocalServerServiceStatus
}

export interface LocalServerServiceStatus {
  platform: string
  kind: string
  name: string | null
  label: string
  file: string | null
  supportsAutostart: boolean
  supported: boolean
  installed: boolean
  running: boolean
  enabled: boolean
  disabledInDev?: boolean
  error?: string | null
}

export function getLocalServerStatus(): Promise<LocalServerStatus> {
  return nativeElectronInvoke('server:status')
}

export function startLocalServer(): Promise<LocalServerStatus & { ok: boolean }> {
  localServerInstancePromise = null
  return nativeElectronInvoke('server:start')
}

export function stopLocalServer(): Promise<{ ok: boolean }> {
  localServerInstancePromise = null
  return nativeElectronInvoke('server:stop')
}

export function restartLocalServer(): Promise<LocalServerStatus & { ok: boolean }> {
  localServerInstancePromise = null
  return nativeElectronInvoke('server:restart')
}

export function getLocalServerServiceStatus(): Promise<LocalServerServiceStatus> {
  return nativeElectronInvoke('server:service-status')
}

export function installLocalServerService(): Promise<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }> {
  localServerInstancePromise = null
  return nativeElectronInvoke('server:service-install')
}

export function uninstallLocalServerService(): Promise<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }> {
  localServerInstancePromise = null
  return nativeElectronInvoke('server:service-uninstall')
}

export function startLocalServerService(): Promise<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }> {
  localServerInstancePromise = null
  return nativeElectronInvoke('server:service-start')
}

export function stopLocalServerService(): Promise<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }> {
  localServerInstancePromise = null
  return nativeElectronInvoke('server:service-stop')
}

export function restartLocalServerService(): Promise<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }> {
  localServerInstancePromise = null
  return nativeElectronInvoke('server:service-restart')
}

export async function testInstanceConnection(instance: Pick<QalatraInstance, 'url' | 'token'>): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const url = normalizeUrl(instance.url)
    const res = await fetch(`${url}/api/instance`, { headers: { Authorization: `Bearer ${instance.token}` } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) return { ok: false, error: data.error || `HTTP ${res.status}` }
    return { ok: true, name: data.name }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

async function currentServerInstance(): Promise<QalatraInstance> {
  const active = activeHttpInstance() ?? await getDefaultLocalServerInstance()
  if (!active) throw new Error('No Qalatra server is available')
  return active
}

export interface AccessToken {
  id: string
  label: string
  scopes: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  expires_at: string | null
}

export async function listAccessTokens(): Promise<AccessToken[]> {
  const active = await currentServerInstance()
  const data = await httpJson(active, '/api/tokens', { method: 'GET' })
  return data.tokens ?? []
}

export async function createAccessToken(label: string, scopes = 'full_access', expiresInDays?: number | null): Promise<{ id: string; token: string; label: string; scopes: string; expires_at: string | null }> {
  const active = await currentServerInstance()
  const data = await httpJson(active, '/api/tokens', {
    method: 'POST',
    body: JSON.stringify({ label, scopes, expiresInDays }),
  })
  return data.token
}

export async function revokeAccessToken(id: string): Promise<void> {
  const active = await currentServerInstance()
  await httpJson(active, `/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function subscribeServerEvents(onEvent: (event: any) => void): () => void {
  const controller = new AbortController()
  let closed = false

  ;(async () => {
    const active = activeHttpInstance() ?? await getDefaultLocalServerInstance()
    if (!active || closed) return
    const res = await fetch(`${active.url}/api/events`, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${active.token}`,
      },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`Event stream failed: HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!closed) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = raw
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (data) {
          try { onEvent(JSON.parse(data)) } catch {}
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  })().catch(err => {
    if (!closed && !(err instanceof DOMException && err.name === 'AbortError')) {
      console.warn('[api] server event stream closed:', err)
    }
  })

  return () => {
    closed = true
    controller.abort()
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

export async function listHabits(date: string): Promise<any[]> {
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

export async function listHeartbeats(): Promise<any[]> {
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

export async function listHeartbeatJobs(id: string, limit = 10): Promise<any[]> {
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
  clearInbox: (taskId: string) => updateTask(taskId, { inbox: 0 }),
}
