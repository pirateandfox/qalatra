// Standalone xterm.js terminal for the mobile/iPad WebView. The pty is
// server-side (tmux over a WebSocket); the RN host computes the authenticated
// socket URL (token embedded) and injects it as window.__QALATRA_TERM__.wsUrl
// before load. This page just wires xterm <-> that socket — same protocol the
// desktop ServerTerminal uses ({type:'input'|'resize'} up, {type:'output'|...}
// down). A bottom key bar sends control sequences a soft keyboard can't.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'

declare global {
  interface Window {
    __QALATRA_TERM__?: { wsUrl: string }
    ReactNativeWebView?: { postMessage: (m: string) => void }
  }
}

type ServerMessage = { type?: string; data?: string; error?: string; code?: number }

const cfg = window.__QALATRA_TERM__ ?? { wsUrl: '' }

const term = new Terminal({
  theme: { background: '#0d1117', foreground: '#e2e8f0', cursor: '#4f9cf9', selectionBackground: '#4f9cf940' },
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 13,
  lineHeight: 1.3,
  cursorBlink: true,
  // Long Claude Code sessions need a deep buffer to scroll back through.
  scrollback: 10000,
})
const fit = new FitAddon()
term.loadAddon(fit)
const root = document.getElementById('root') as HTMLDivElement
term.open(root)
try { fit.fit() } catch { /* not yet laid out */ }

let ws: WebSocket | null = null
let retry = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const MAX_RETRIES = 8

function send(data: string) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
}
function sendResize() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
}

function connect() {
  if (!cfg.wsUrl) {
    term.write('\r\n\x1b[31mNo terminal session URL.\x1b[0m\r\n')
    return
  }
  if (retry > 0) term.write('\r\n\x1b[2mReconnecting…\x1b[0m\r\n')
  const sock = new WebSocket(cfg.wsUrl)
  ws = sock
  sock.onopen = () => { retry = 0; sendResize() }
  sock.onmessage = ev => {
    let msg: ServerMessage = {}
    try { msg = JSON.parse(String(ev.data)) } catch { return }
    if (msg.type === 'output' && typeof msg.data === 'string') term.write(msg.data)
    else if (msg.type === 'error') term.write(`\r\n\x1b[31m${msg.error ?? 'Terminal error'}\x1b[0m\r\n`)
    else if (msg.type === 'exit') term.write(`\r\n\x1b[33mSession exited (${msg.code ?? 0}). It may still be running in tmux.\x1b[0m\r\n`)
  }
  sock.onclose = () => {
    if (retry < MAX_RETRIES) {
      retry++
      reconnectTimer = setTimeout(connect, Math.min(500 * retry, 4000))
    } else {
      term.write('\r\n\x1b[31mDisconnected. Reopen Terminal to retry.\x1b[0m\r\n')
    }
  }
  sock.onerror = () => { /* surfaced via onclose */ }
}

term.onData(send)
term.onResize(sendResize)

const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* ignore */ } sendResize() })
ro.observe(root)
root.addEventListener('click', () => term.focus())

// Touch-drag scrolling: xterm translates wheel events to scrollback but ignores
// touch swipes, so on mobile there's no way to scroll up through history. We drag
// the .xterm-viewport's scrollTop directly (the same element wheel scrolling drives,
// so xterm re-renders the visible rows in response). Only single-finger drags that
// actually move past a small threshold scroll; taps still fall through to focus, and
// multi-touch (pinch/zoom) is left alone.
let touchY = 0
let touchScrolling = false
const TOUCH_SLOP = 4 // px before a drag counts as a scroll, not a tap
function viewport(): HTMLElement | null {
  return root.querySelector('.xterm-viewport')
}
root.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) return
  touchY = e.touches[0].clientY
  touchScrolling = false
}, { passive: true })
root.addEventListener('touchmove', e => {
  if (e.touches.length !== 1) return
  const vp = viewport()
  if (!vp) return
  const y = e.touches[0].clientY
  const dy = touchY - y
  if (!touchScrolling && Math.abs(dy) < TOUCH_SLOP) return
  touchScrolling = true
  touchY = y
  vp.scrollTop += dy
  e.preventDefault() // we own the gesture; stop the page/keyboard from also moving
}, { passive: false })

// Mobile key bar: buttons carry data-key; map to the bytes a terminal expects.
const KEYS: Record<string, string> = {
  esc: '\x1b', tab: '\x09', 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'ctrl-z': '\x1a',
  up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
}
document.querySelectorAll<HTMLElement>('[data-key]').forEach(btn => {
  btn.addEventListener('click', e => {
    e.preventDefault()
    send(KEYS[btn.dataset.key ?? ''] ?? '')
    term.focus()
  })
})

connect()
window.addEventListener('beforeunload', () => { if (reconnectTimer) clearTimeout(reconnectTimer); ws?.close() })
