import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createTerminalSession,
  fetchSettings,
  listWorkspaceRoots,
  removeTerminalSession,
  type TerminalSession,
} from '../api'
import BottomPanel from './BottomPanel'
import ServerTerminal from './ServerTerminal'

export interface TerminalLaunch {
  cwd?: string
  command?: string
  title?: string
}

interface Props {
  mode: 'closed' | 'docked' | 'fullscreen'
  onClose: () => void
  onToggleFullscreen: () => void
  pendingLaunch?: TerminalLaunch | null
  onCommandConsumed?: () => void
}

function basename(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

function normalizeCommand(command: string | undefined) {
  const trimmed = command?.trim()
  return trimmed || undefined
}

async function terminalDefaults() {
  const settings = await fetchSettings().catch(() => ({} as Record<string, string>))
  if (settings.terminalCwd?.trim()) {
    return { cwd: settings.terminalCwd.trim(), autoRun: normalizeCommand(settings.terminalAutoRun) }
  }
  const roots = await listWorkspaceRoots().catch(() => [])
  return {
    cwd: roots.find(root => root.exists && root.isDirectory)?.path,
    autoRun: normalizeCommand(settings.terminalAutoRun),
  }
}

export default function Terminal({ mode, onClose, onToggleFullscreen, pendingLaunch, onCommandConsumed }: Props) {
  const open = mode !== 'closed'
  const [session, setSession] = useState<TerminalSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reconnectKey, setReconnectKey] = useState(0)
  const sessionRef = useRef<TerminalSession | null>(null)
  const launchTokenRef = useRef(0)

  const cleanupSession = useCallback(async (target: TerminalSession | null) => {
    if (!target) return
    try { await removeTerminalSession(target.id) } catch {}
  }, [])

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  useEffect(() => {
    if (open) return
    launchTokenRef.current++
    const current = sessionRef.current
    sessionRef.current = null
    setSession(null)
    setError(null)
    setLoading(false)
    cleanupSession(current)
  }, [cleanupSession, open])

  useEffect(() => {
    if (!open) return
    if (!pendingLaunch && sessionRef.current) return

    const token = ++launchTokenRef.current
    const previous = sessionRef.current
    sessionRef.current = null
    setSession(null)
    setError(null)
    setLoading(true)
    cleanupSession(previous)

    async function start() {
      try {
        const defaults = await terminalDefaults()
        const cwd = pendingLaunch?.cwd?.trim() || defaults.cwd
        const command = normalizeCommand(pendingLaunch?.command) || (!pendingLaunch ? defaults.autoRun : undefined)
        const title = pendingLaunch?.title?.trim() || (command ? 'Command' : cwd ? basename(cwd) : 'Terminal')
        const created = await createTerminalSession({ cwd, title, command })
        if (launchTokenRef.current !== token) {
          cleanupSession(created)
          return
        }
        sessionRef.current = created
        setSession(created)
        setReconnectKey(key => key + 1)
        if (command) onCommandConsumed?.()
      } catch (err: any) {
        if (launchTokenRef.current === token) {
          setError(err?.message ?? String(err))
          onCommandConsumed?.()
        }
      } finally {
        if (launchTokenRef.current === token) setLoading(false)
      }
    }

    start()
  }, [cleanupSession, onCommandConsumed, open, pendingLaunch])

  useEffect(() => {
    return () => {
      launchTokenRef.current++
      const current = sessionRef.current
      sessionRef.current = null
      cleanupSession(current)
    }
  }, [cleanupSession])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === '`' && e.ctrlKey) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const emptyText = loading
    ? 'Starting terminal...'
    : error
      ? `Terminal failed to start: ${error}`
      : 'Starting terminal...'

  return (
    <BottomPanel
      title={session?.title ?? 'Terminal'}
      open={mode !== 'closed'}
      fullscreen={mode === 'fullscreen'}
      onClose={onClose}
      onToggleFullscreen={onToggleFullscreen}
      dockedHeight={300}
      zIndex={1200}
      inline
    >
      <ServerTerminal session={session} reconnectKey={reconnectKey} emptyText={emptyText} />
    </BottomPanel>
  )
}
