import { useEffect, useRef, useCallback } from 'react'
import { fetchSettings } from '../api'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import BottomPanel from './BottomPanel'

interface Props {
  mode: 'closed' | 'docked' | 'fullscreen'
  onClose: () => void
  onToggleFullscreen: () => void
  pendingCommand?: string | null
  onCommandConsumed?: () => void
}

const eAPI = () => (window as any).electronAPI

export default function Terminal({ mode, onClose, onToggleFullscreen, pendingCommand, onCommandConsumed }: Props) {
  const open = mode !== 'closed'
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const readyRef = useRef(false)
  const xtermInitRef = useRef(false)
  const outputCleanupRef = useRef<(() => void) | null>(null)
  const exitCleanupRef = useRef<(() => void) | null>(null)

  const connect = useCallback(async () => {
    // Clean up previous output listener if any
    outputCleanupRef.current?.()
    exitCleanupRef.current?.()
    readyRef.current = false

    const cols = termRef.current?.cols ?? 80
    const rows = termRef.current?.rows ?? 24

    outputCleanupRef.current = eAPI().onTerminalOutput((data: string) => {
      termRef.current?.write(data)
    })

    exitCleanupRef.current = eAPI().onTerminalExit(() => {
      readyRef.current = false
      termRef.current?.write('\r\n\x1b[33mProcess exited. Reopen terminal to start a new session.\x1b[0m\r\n')
    })

    try {
      await eAPI().terminalStart(cols, rows)
      readyRef.current = true
    } catch (err: any) {
      termRef.current?.write('\r\n\x1b[31mFailed to start terminal: ' + (err?.message ?? err) + '\x1b[0m\r\n')
      return
    }

    try {
      const settings = await fetchSettings()
      const autoRun = settings.terminalAutoRun?.trim()
      if (autoRun) {
        setTimeout(() => { eAPI().terminalInput(autoRun + '\r') }, 300)
      }
    } catch {}
  }, [])

  // Initialize xterm DOM once
  useEffect(() => {
    if (xtermInitRef.current || !containerRef.current) return
    xtermInitRef.current = true

    const term = new XTerm({
      theme: {
        background: '#0d1117',
        foreground: '#e2e8f0',
        cursor: '#4f9cf9',
        selectionBackground: '#4f9cf940',
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.onData(data => { eAPI().terminalInput(data) })
    term.onResize(({ cols, rows }) => { eAPI().terminalResize(cols, rows) })

    const resizeObserver = new ResizeObserver(() => fit.fit())
    resizeObserver.observe(containerRef.current)
    return () => { resizeObserver.disconnect() }
  }, [])

  // Connect/reconnect pty whenever terminal opens
  useEffect(() => {
    if (!open || !xtermInitRef.current) return
    connect()
    return () => {
      outputCleanupRef.current?.()
      exitCleanupRef.current?.()
    }
  }, [open, connect])

  useEffect(() => {
    if (open) {
      setTimeout(() => { fitRef.current?.fit(); termRef.current?.focus() }, 250)
    }
  }, [open])

  // Fire a one-shot command when the terminal opens with a pending command.
  // If the terminal is already running (readyRef = true), kill it and reconnect first
  // so we don't inject the command into an active session (e.g. a running Claude).
  // If the terminal just opened, connect() was already called by the open effect — just wait.
  useEffect(() => {
    if (!open || !pendingCommand) return
    const send = () => { eAPI().terminalInput(pendingCommand); onCommandConsumed?.() }
    if (readyRef.current) {
      // Terminal already has an active session — restart it
      readyRef.current = false
      connect().then(() => {
        const interval = setInterval(() => {
          if (readyRef.current) { clearInterval(interval); setTimeout(send, 200) }
        }, 100)
      })
    } else {
      // Terminal is freshly opening — connect() from the open effect handles the pty
      const interval = setInterval(() => {
        if (readyRef.current) { clearInterval(interval); setTimeout(send, 200) }
      }, 100)
      return () => clearInterval(interval)
    }
  }, [open, pendingCommand])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === '`' && e.ctrlKey) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <BottomPanel
      title="Terminal"
      open={mode !== 'closed'}
      fullscreen={mode === 'fullscreen'}
      onClose={onClose}
      onToggleFullscreen={onToggleFullscreen}
      dockedHeight={300}
      zIndex={1200}
    >
      <div ref={containerRef} id="terminal-container" style={{ flex: 1, minHeight: 0, padding: '4px 8px', overflow: 'hidden' }} />
    </BottomPanel>
  )
}
