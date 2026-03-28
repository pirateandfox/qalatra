import { useEffect, useRef, useCallback } from 'react'
import { API_BASE } from '../api'
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

export default function Terminal({ open, onClose, pendingCommand, onCommandConsumed }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const initializedRef = useRef(false)

  const connect = useCallback(async () => {
    const wsBase = API_BASE ? API_BASE.replace(/^http/, 'ws') : `ws://localhost:3456`
    const ws = new WebSocket(wsBase)
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'output') termRef.current?.write(msg.data)
        if (msg.type === 'exit') ws.close()
      } catch { /* ignore */ }
    }
    ws.onerror = () => {
      termRef.current?.write('\r\n\x1b[31mCould not connect to terminal service.\x1b[0m\r\n')
      termRef.current?.write('\x1b[33mThe backend API may not be running. Try restarting the app.\x1b[0m\r\n')
    }
    ws.onclose = () => { wsRef.current = null }

    // Send auto-run command if configured
    const settings: Record<string, string> = await fetch(`${API_BASE}/api/settings`).then(r => r.json()).catch(() => ({}))
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

  // Fire a one-shot command when the terminal opens with a pending command
  useEffect(() => {
    if (!open || !pendingCommand) return
    const send = () => {
      wsRef.current?.send(JSON.stringify({ type: 'input', data: pendingCommand }))
      onCommandConsumed?.()
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setTimeout(send, 400)
    } else {
      // Terminal not connected yet — wait for it
      const interval = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          clearInterval(interval)
          setTimeout(send, 200)
        }
      }, 100)
      return () => clearInterval(interval)
    }
  }, [open, pendingCommand])

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
