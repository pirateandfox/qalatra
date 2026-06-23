import { useCallback, useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { saveTerminalImage, terminalSocketUrl, type TerminalSession } from '../api'
import './ServerTerminal.css'

interface Props {
  session: TerminalSession | null
  reconnectKey?: number
  className?: string
  emptyText?: string
}

type TerminalElectronAPI = {
  writeClipboard?: (text: string) => void
  getPathForFile?: (file: File) => string
}

function electronAPI(): TerminalElectronAPI | undefined {
  return (window as Window & { electronAPI?: TerminalElectronAPI }).electronAPI
}

async function fileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

/** Single-quote a path for safe insertion at a shell prompt (handles spaces and
 *  embedded quotes), matching how iTerm/Warp insert dragged file paths. */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

function extForType(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/webp') return 'webp'
  return 'png'
}

export default function ServerTerminal({
  session,
  reconnectKey = 0,
  className = 'server-terminal-xterm',
  emptyText = 'Create or select a terminal session.',
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // The xterm mount effect runs once (session is null then), so drop/paste
  // handlers read the live session id from this ref instead of a stale closure.
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = session?.id ?? null

  const sendResize = useCallback(() => {
    const term = termRef.current
    const ws = wsRef.current
    if (!term || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
  }, [])

  /** Type text into the pty as if the user had entered it. */
  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current
    if (!data || ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'input', data }))
  }, [])

  /** Insert one or more file paths at the prompt (space-separated, trailing
   *  space), so a CLI like Claude Code can pick them up as image attachments. */
  const insertPaths = useCallback((paths: string[]) => {
    const usable = paths.filter(Boolean)
    if (!usable.length) return
    sendInput(usable.map(shellQuote).join(' ') + ' ')
    termRef.current?.focus()
  }, [sendInput])

  useEffect(() => {
    if (!containerRef.current || termRef.current) return
    const term = new XTerm({
      theme: {
        background: '#0d1117',
        foreground: '#e2e8f0',
        cursor: '#4f9cf9',
        selectionBackground: '#4f9cf940',
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    try { fit.fit() } catch {}
    termRef.current = term
    fitRef.current = fit

    term.onData(data => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    term.parser.registerOscHandler(52, data => {
      const payload = data.split(';').pop() || ''
      if (!payload || payload === '?') return true
      try {
        const bytes = Uint8Array.from(atob(payload), c => c.charCodeAt(0))
        const text = new TextDecoder().decode(bytes)
        const api = (window as Window & { electronAPI?: { writeClipboard?: (text: string) => void } }).electronAPI
        if (text && api?.writeClipboard) api.writeClipboard(text)
      } catch {
        // Ignore malformed OSC 52 payloads.
      }
      return true
    })

    term.attachCustomKeyEventHandler(event => {
      if (
        event.type === 'keydown' &&
        event.key.toLowerCase() === 'c' &&
        (event.metaKey || (event.ctrlKey && event.shiftKey))
      ) {
        if (term.hasSelection()) {
          const sel = term.getSelection()
          const api = (window as Window & { electronAPI?: { writeClipboard?: (text: string) => void } }).electronAPI
          if (sel && api?.writeClipboard) api.writeClipboard(sel)
          return false
        }
      }
      return true
    })

    // Persist an image to the SERVER (where the pty/CLI runs — a different box on
    // a remote backend) and return its server-side path, or null on failure.
    const uploadImage = async (file: File): Promise<string | null> => {
      const id = sessionIdRef.current
      if (!id) return null
      try {
        return await saveTerminalImage(id, await fileBytes(file), extForType(file.type))
      } catch (err) {
        console.error('[terminal] image upload failed:', err)
        return null
      }
    }

    // Drag an image (or any file) onto the terminal → insert a path at the prompt,
    // like iTerm/Warp. Images upload to the server so the path is reachable by the
    // (possibly remote) pty; other files fall back to their local path (only valid
    // when the backend runs on this machine).
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    }
    const onDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length) return
      e.preventDefault()
      e.stopPropagation()
      const api = electronAPI()
      void (async () => {
        const paths: string[] = []
        for (const file of files) {
          if (file.type.startsWith('image/')) {
            const saved = await uploadImage(file)
            if (saved) paths.push(saved)
          } else {
            const direct = api?.getPathForFile?.(file)
            if (direct) paths.push(direct)
          }
        }
        insertPaths(paths)
      })()
    }
    // Paste a screenshot (clipboard image) → upload to server → insert path.
    // Non-image pastes fall through to xterm so bracketed text paste is preserved.
    const onPaste = (e: ClipboardEvent) => {
      const imageItem = Array.from(e.clipboardData?.items ?? [])
        .find(it => it.kind === 'file' && it.type.startsWith('image/'))
      if (!imageItem) return
      const file = imageItem.getAsFile()
      if (!file) return
      e.preventDefault()
      e.stopPropagation()
      void (async () => {
        const saved = await uploadImage(file)
        if (saved) insertPaths([saved])
      })()
    }
    const dropTarget = containerRef.current
    dropTarget.addEventListener('dragover', onDragOver)
    dropTarget.addEventListener('drop', onDrop)
    dropTarget.addEventListener('paste', onPaste, true) // capture: beat xterm for images

    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })

    const resizeObserver = new ResizeObserver(() => {
      try { fit.fit() } catch {}
      sendResize()
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      dropTarget.removeEventListener('dragover', onDragOver)
      dropTarget.removeEventListener('drop', onDrop)
      dropTarget.removeEventListener('paste', onPaste, true)
      wsRef.current?.close()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [insertPaths, sendResize])

  useEffect(() => {
    if (!termRef.current) return
    const term = termRef.current
    wsRef.current?.close()
    wsRef.current = null
    term.reset()

    if (!session) {
      term.write(`\x1b[2m${emptyText}\x1b[0m`)
      return
    }

    const activeSession = session
    term.focus()

    let cancelled = false
    let ptyExited = false
    let retryCount = 0
    let pingInterval: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    const maxRetries = 8

    function connect() {
      if (cancelled) return
      const isRetry = retryCount > 0
      term.write(`\x1b[2m${isRetry ? 'Reconnecting...' : `Connecting to ${activeSession.title}...`}\x1b[0m\r\n`)
      terminalSocketUrl(activeSession.id, term.cols || 100, term.rows || 30)
        .then(url => {
          if (cancelled) return
          const ws = new WebSocket(url)
          wsRef.current = ws
          ws.onopen = () => {
            retryCount = 0
            ptyExited = false
            term.write(`\x1b[2m${isRetry ? 'Reconnected.' : 'Connected.'}\x1b[0m\r\n`)
            sendResize()
            pingInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
            }, 25000)
          }
          ws.onmessage = event => {
            let message: { type?: string; data?: string; error?: string; code?: number } = {}
            try {
              message = JSON.parse(String(event.data))
            } catch {
              message = { type: 'error', error: 'Received an unreadable terminal message.' }
            }
            if (message.type === 'output' && typeof message.data === 'string') term.write(message.data)
            if (message.type === 'error') term.write(`\r\n\x1b[31m${message.error ?? 'Terminal error'}\x1b[0m\r\n`)
            if (message.type === 'exit') {
              ptyExited = true
              term.write(`\r\n\x1b[33mAttach process exited (${message.code ?? 0}). Session may still be running in tmux.\x1b[0m\r\n`)
            }
          }
          ws.onclose = () => {
            if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
            if (cancelled || ptyExited) return
            if (retryCount < maxRetries) {
              retryCount++
              const delay = Math.min(500 * retryCount, 4000)
              reconnectTimer = setTimeout(connect, delay)
            } else {
              term.write('\r\n\x1b[31mFailed to reconnect. Click Reconnect to try again.\x1b[0m\r\n')
            }
          }
          ws.onerror = () => {
            term.write('\r\n\x1b[31mWebSocket terminal connection failed.\x1b[0m\r\n')
          }
        })
        .catch(err => {
          if (!cancelled) term.write(`\r\n\x1b[31m${err?.message ?? String(err)}\x1b[0m\r\n`)
        })
    }

    connect()

    return () => {
      cancelled = true
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [emptyText, reconnectKey, sendResize, session])

  useEffect(() => {
    setTimeout(() => {
      try { fitRef.current?.fit() } catch {}
      sendResize()
      termRef.current?.focus()
    }, 100)
  }, [reconnectKey, sendResize, session?.id])

  return <div ref={containerRef} className={className} />
}
