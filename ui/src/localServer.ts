// Electron-only local-server management and the desktop attachment opener.
//
// This is the platform-specific half of the old apiRuntime.ts — everything that
// talks to the Electron main process (server lifecycle IPC) or the browser
// window object. The portable client now lives in @qalatra/shared; this module
// stays in the desktop UI and is wired into the shared platform adapter via
// platform.web.ts.

import { fetchAttachmentBlob, type QalatraInstance } from '@qalatra/shared'

interface ElectronBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
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

let localServerInstancePromise: Promise<QalatraInstance> | null = null

/**
 * Resolve (lazily starting if needed) the Electron-managed local server as a
 * QalatraInstance. Installed into the shared platform adapter as
 * resolveLocalInstance on desktop, so the shared client can fall back to the
 * local server when no remote instance is active.
 */
export async function resolveLocalServerInstance(): Promise<QalatraInstance> {
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

/**
 * Open an attachment's bytes in a new browser window (desktop UX). Uses the
 * portable fetchAttachmentBlob primitive from the shared client; the window.open
 * presentation is what makes this desktop-only.
 */
export async function openAttachmentFile(id: string): Promise<void> {
  const blob = await fetchAttachmentBlob(id)
  const blobUrl = URL.createObjectURL(blob)
  window.open(blobUrl, '_blank', 'noopener,noreferrer')
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
}
