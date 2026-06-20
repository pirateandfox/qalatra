// Runtime: instance/backend management, HTTP primitives, access tokens,
// connection testing, and the server-event stream.
//
// This is the platform-agnostic core that the desktop UI's apiRuntime.ts used to
// own. Storage goes through the injected platform adapter (persistent/session KV)
// instead of localStorage/sessionStorage, change notification uses an emitter
// instead of window events, and the local-server fallback is delegated to
// platform.resolveLocalInstance (Electron-only; absent on mobile).

import type { AccessToken, QalatraInstance, ServerEvent } from './types'
import { getPlatform } from './platform'
import { createEmitter } from './emitter'

const INSTANCES_KEY = 'qalatra.instances'
const ACTIVE_INSTANCE_KEY = 'qalatra.activeInstanceId'
const DEFAULT_INSTANCE_KEY = 'qalatra.defaultInstanceId'
const HIDE_LOCAL_INSTANCE_KEY = 'qalatra.hideLocalInstance'
export const LOCAL_INSTANCE_ID = 'local-server'

/** Keys each store owns — used to warm the native storage caches at startup. */
const PERSISTENT_KEYS = [INSTANCES_KEY, DEFAULT_INSTANCE_KEY, HIDE_LOCAL_INSTANCE_KEY, ACTIVE_INSTANCE_KEY] as const
const SESSION_KEYS = [ACTIVE_INSTANCE_KEY] as const

const instanceConfigEmitter = createEmitter()

function persistent() {
  return getPlatform().persistent
}

function session() {
  return getPlatform().session
}

/**
 * Warm the platform storage caches. No-op on web (synchronous storage); mobile
 * must `await` this once at startup before reading instance state synchronously.
 */
export async function hydrateInstances(): Promise<void> {
  const { persistent: p, session: s } = getPlatform()
  await p.hydrate?.(PERSISTENT_KEYS)
  await s.hydrate?.(SESSION_KEYS)
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

function notifyInstanceConfigChanged() {
  instanceConfigEmitter.emit()
}

export function onInstanceConfigChange(listener: () => void) {
  return instanceConfigEmitter.on(listener)
}

let defaultInstanceMigrated = false

function migrateDefaultInstance() {
  if (defaultInstanceMigrated) return
  defaultInstanceMigrated = true

  const p = persistent()
  const legacyActive = p.getItem(ACTIVE_INSTANCE_KEY)
  if (p.getItem(DEFAULT_INSTANCE_KEY) === null && legacyActive !== null) {
    p.setItem(DEFAULT_INSTANCE_KEY, legacyActive || LOCAL_INSTANCE_ID)
  }
  p.removeItem(ACTIVE_INSTANCE_KEY)
}

function storedInstanceValue(id: string | null) {
  return id || LOCAL_INSTANCE_ID
}

function resolveStoredInstanceId(value: string | null, onInvalid?: () => void): string | null {
  if (!value || value === LOCAL_INSTANCE_ID) return null
  if (getInstances().some(instance => instance.id === value)) return value
  onInvalid?.()
  return null
}

export function getInstances(): QalatraInstance[] {
  try {
    const raw = persistent().getItem(INSTANCES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveInstances(instances: QalatraInstance[]) {
  persistent().setItem(INSTANCES_KEY, JSON.stringify(instances))
  notifyInstanceConfigChanged()
}

export function getActiveInstanceId(): string | null {
  migrateDefaultInstance()
  const sessionActive = session().getItem(ACTIVE_INSTANCE_KEY)
  if (sessionActive !== null) {
    const activeId = resolveStoredInstanceId(sessionActive, () => session().removeItem(ACTIVE_INSTANCE_KEY))
    if (activeId || !sessionActive || sessionActive === LOCAL_INSTANCE_ID) return activeId
    return getDefaultInstanceId()
  }
  return getDefaultInstanceId()
}

export function getActiveInstance(): QalatraInstance | null {
  const activeId = getActiveInstanceId()
  if (!activeId) return null
  return getInstances().find(i => i.id === activeId) ?? null
}

export function setActiveInstance(id: string | null) {
  migrateDefaultInstance()
  session().setItem(ACTIVE_INSTANCE_KEY, storedInstanceValue(id))
  notifyInstanceConfigChanged()
}

export function getDefaultInstanceId(): string | null {
  migrateDefaultInstance()
  return resolveStoredInstanceId(
    persistent().getItem(DEFAULT_INSTANCE_KEY),
    () => persistent().removeItem(DEFAULT_INSTANCE_KEY),
  )
}

export function setDefaultInstance(id: string | null) {
  migrateDefaultInstance()
  persistent().setItem(DEFAULT_INSTANCE_KEY, storedInstanceValue(id))
  notifyInstanceConfigChanged()
}

export function getHideLocalInstance() {
  return persistent().getItem(HIDE_LOCAL_INSTANCE_KEY) === 'true'
}

export function setHideLocalInstance(hidden: boolean) {
  if (hidden) persistent().setItem(HIDE_LOCAL_INSTANCE_KEY, 'true')
  else persistent().removeItem(HIDE_LOCAL_INSTANCE_KEY)
  notifyInstanceConfigChanged()
}

export function upsertInstance(input: Partial<QalatraInstance> & { name: string; url: string; token: string }): QalatraInstance {
  const previous = input.id ? getInstances().find(instance => instance.id === input.id) : null
  const instance: QalatraInstance = {
    ...previous,
    id: input.id || newId(),
    name: input.name.trim(),
    url: normalizeUrl(input.url),
    token: input.token.trim(),
    boxWebEnabled: input.boxWebEnabled ?? previous?.boxWebEnabled,
    boxWebLabel: input.boxWebLabel ?? previous?.boxWebLabel,
  }
  const next = getInstances().filter(i => i.id !== instance.id)
  next.push(instance)
  saveInstances(next)
  return instance
}

export function updateInstance(id: string, patch: Partial<QalatraInstance>): QalatraInstance | null {
  let updated: QalatraInstance | null = null
  const next = getInstances().map(instance => {
    if (instance.id !== id) return instance
    updated = { ...instance, ...patch }
    return updated
  })
  if (!updated) return null
  saveInstances(next)
  return updated
}

export function removeInstance(id: string) {
  const wasActive = session().getItem(ACTIVE_INSTANCE_KEY) === id
  const wasDefault = persistent().getItem(DEFAULT_INSTANCE_KEY) === id
  saveInstances(getInstances().filter(i => i.id !== id))
  if (wasActive) session().removeItem(ACTIVE_INSTANCE_KEY)
  if (wasDefault) persistent().removeItem(DEFAULT_INSTANCE_KEY)
  notifyInstanceConfigChanged()
}

async function resolveLocalInstance(): Promise<QalatraInstance | null> {
  const platform = getPlatform()
  if (!platform.resolveLocalInstance) return null
  return platform.resolveLocalInstance()
}

export async function currentServerInstance(): Promise<QalatraInstance> {
  const active = getActiveInstance() ?? (await resolveLocalInstance())
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

export function subscribeServerEvents(onEvent: (event: ServerEvent) => void): () => void {
  const controller = new AbortController()
  let closed = false

  ;(async () => {
    const active = getActiveInstance() ?? (await resolveLocalInstance())
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
      console.warn('[qalatra] server event stream closed:', err)
    }
  })

  return () => {
    closed = true
    controller.abort()
  }
}
