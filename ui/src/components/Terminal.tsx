import { useEffect, useRef, useCallback } from 'react'
import { fetchSettings } from '../api'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './Terminal.css'

interface Props {
  open: boolean
  onClose: () => void
  pendingCommand?: string | null
  onCommandConsumed?: () => void
}

const eAPI = () => (window as any).electronAPI

export default function Terminal({ open, onClose, pendingCommand, onCommandConsumed }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const readyRef = useRef(false)
  const initializedRef = useRef(false)
  const cleanupRef = useRef<(() => void) | null>(null)

  const connect = useCallback(async () => {
    const { cols, rows } = fitRef.current
      ? { cols: termRef.current?.cols ?? 80, rows: termRef.current?.rows ?? 24 }
      : { cols: 80, rows: 24 }

    // Listen for output from main process
    const removeListener = eAPI().onTerminalOutput((data: string) => {
      termRef.current?.write(data)
    })
    cleanupRef.current = removeListener

    try {
      await eAPI().terminalStart(cols, rows)
      readyRef.current = true
    } catch (err: any) {
      termRef.current?.write('\r\n\x1b[31mFailed to start terminal: ' + (err?.message ?? err) + '\x1b[0m\r\n')
      return
    }

    // Auto-run command if configured
    try {
      const settings = await fetchSettings()
      const autoRun = settings.terminalAutoRun?.trim()
      if (autoRun) {
        setTimeout(() => { eAPI().terminalInput(autoRun + '\r') }, 300)
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (!open || initializedRef.current || !containerRef.current) return
    initializedRef.current = true

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

    connect()

    const resizeObserver = new ResizeObserver(() => fit.fit())
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      cleanupRef.current?.()
    }
  }, [open, connect])

  useEffect(() => {
    if (open) {
      setTimeout(() => { fitRef.current?.fit(); termRef.current?.focus() }, 250)
    }
  }, [open])

  // Fire a one-shot command when the terminal opens with a pending command
  useEffect(() => {
    if (!open || !pendingCommand) return
    const send = () => { eAPI().terminalInput(pendingCommand); onCommandConsumed?.() }
    if (readyRef.current) {
      setTimeout(send, 400)
    } else {
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
    <div className={`terminal-panel ${open ? 'open' : ''}`}>
      <div className="terminal-toolbar">
        <span className="terminal-title">Terminal</span>
        <button className="terminal-close" onClick={onClose}>✕</button>
      </div>
      <div ref={containerRef} id="terminal-container" />
    </div>
  )
}
