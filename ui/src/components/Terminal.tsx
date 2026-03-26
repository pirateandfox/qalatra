import { useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './Terminal.css'

interface Props {
  open: boolean
  onClose: () => void
}

export default function Terminal({ open, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const initializedRef = useRef(false)

  const connect = useCallback(async () => {
    const ws = new WebSocket(`ws://localhost:3456`)
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'output') termRef.current?.write(msg.data)
        if (msg.type === 'exit') ws.close()
      } catch { /* ignore */ }
    }
    ws.onclose = () => { wsRef.current = null }

    // Send auto-run command if configured
    const settings: Record<string, string> = await fetch('/api/settings').then(r => r.json()).catch(() => ({}))
    const autoRun = settings.terminalAutoRun?.trim()
    if (autoRun) {
      ws.addEventListener('open', () => {
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'input', data: autoRun + '\r' }))
        }, 300)
      })
    }
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

    term.onData(data => {
      wsRef.current?.send(JSON.stringify({ type: 'input', data }))
    })
    term.onResize(({ cols, rows }) => {
      wsRef.current?.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    connect()

    const resizeObserver = new ResizeObserver(() => fit.fit())
    resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [open, connect])

  useEffect(() => {
    if (open) {
      setTimeout(() => { fitRef.current?.fit(); termRef.current?.focus() }, 250)
    }
  }, [open])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '`' && e.ctrlKey) onClose()
    }
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
