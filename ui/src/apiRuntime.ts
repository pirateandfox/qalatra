const INSTANCES_KEY = 'qalatra.instances'
const ACTIVE_INSTANCE_KEY = 'qalatra.activeInstanceId'

interface ElectronBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export interface QalatraInstance {
  id: string
  name: string
  url: string
  token: string
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
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
  if (!localServerInstancePromise) {
    localServerInstancePromise = getElectronAPI('start the local server').invoke('server:start')
      .then(raw => {
        const status = raw as LocalServerStatus & { ok?: boolean }
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

export async function currentServerInstance(): Promise<QalatraInstance> {
  const active = activeHttpInstance() ?? await getDefaultLocalServerInstance()
  if (!active) throw new Error('No Qalatra server is available')
  return active
}

export async function httpJson(instance: QalatraInstance, path: string, init: RequestInit = {}) {
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

export async function v1(path: string, init: RequestInit = {}) {
  const active = await currentServerInstance()
  return httpJson(active, `/api/v1${path}`, init)
}

export function jsonRequest(method: string, body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) }
}

export function enc(value: string) {
  return encodeURIComponent(value)
}

function getElectronAPI(action = 'use Electron APIs'): ElectronBridge {
  const electronAPI = (window as Window & { electronAPI?: ElectronBridge }).electronAPI
  if (!electronAPI?.invoke) throw new Error(`Electron API is not available to ${action}`)
  return electronAPI
}

async function nativeElectronInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return getElectronAPI().invoke(channel, ...args) as Promise<T>
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
  return nativeElectronInvoke<LocalServerStatus>('server:status')
}

export function startLocalServer(): Promise<LocalServerStatus & { ok: boolean }> {
  localServerInstancePromise = null
  return nativeElectronInvoke<LocalServerStatus & { ok: boolean }>('server:start')
}

export function stopLocalServer(): Promise<{ ok: boolean }> {
  localServerInstancePromise = null
  return nativeElectronInvoke<{ ok: boolean }>('server:stop')
}

export function restartLocalServer(): Promise<LocalServerStatus & { ok: boolean }> {
  localServerInstancePromise = null
  return nativeElectronInvoke<LocalServerStatus & { ok: boolean }>('server:restart')
}

export function getLocalServerServiceStatus(): Promise<LocalServerServiceStatus> {
  return nativeElectronInvoke<LocalServerServiceStatus>('server:service-status')
}

export function installLocalServerService(): Promise<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }> {
  localServerInstancePromise = null
  return nativeElectronInvoke<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }>('server:service-install')
}

export function uninstallLocalServerService(): Promise<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }> {
  localServerInstancePromise = null
  return nativeElectronInvoke<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }>('server:service-uninstall')
}

export function startLocalServerService(): Promise<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }> {
  localServerInstancePromise = null
  return nativeElectronInvoke<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }>('server:service-start')
}

export function stopLocalServerService(): Promise<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }> {
  localServerInstancePromise = null
  return nativeElectronInvoke<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }>('server:service-stop')
}

export function restartLocalServerService(): Promise<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }> {
  localServerInstancePromise = null
  return nativeElectronInvoke<{ ok: boolean; status?: LocalServerServiceStatus; error?: string }>('server:service-restart')
}

export async function testInstanceConnection(instance: Pick<QalatraInstance, 'url' | 'token'>): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const url = normalizeUrl(instance.url)
    const res = await fetch(`${url}/api/instance`, { headers: { Authorization: `Bearer ${instance.token}` } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) return { ok: false, error: data.error || `HTTP ${res.status}` }
    return { ok: true, name: data.name }
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) }
  }
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

function parseServerDate(value: string | null) {
  if (!value) return null
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

export function tokenIsExpired(token: AccessToken) {
  const expiresAt = parseServerDate(token.expires_at)
  return !!expiresAt && expiresAt.getTime() <= Date.now()
}

export function getAccessTokenExpiryLabel(token: AccessToken) {
  const expiresAt = parseServerDate(token.expires_at)
  if (!expiresAt) return 'No expiry'
  return expiresAt.getTime() <= Date.now()
    ? `Expired ${token.expires_at}`
    : `Expires ${token.expires_at}`
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

export interface ServerEvent {
  type?: string
  taskId?: string
  [key: string]: unknown
}

export function subscribeServerEvents(onEvent: (event: ServerEvent) => void): () => void {
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
          try {
            onEvent(JSON.parse(data))
          } catch {
            // Ignore malformed event frames; the stream can continue.
          }
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
