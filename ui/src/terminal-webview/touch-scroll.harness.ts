// Test harness for attachTouchScroll: a terminal pre-filled with scrollback,
// exposing its scroll position so a Playwright script can fire touch events and
// verify the buffer actually moves. Not shipped — built by vite.harness.config.ts.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { attachTouchScroll } from './touch-scroll'

const term = new Terminal({ fontSize: 13, lineHeight: 1.3, scrollback: 10000 })
const fit = new FitAddon()
term.loadAddon(fit)
const root = document.getElementById('root') as HTMLDivElement
term.open(root)
try { fit.fit() } catch { /* not yet laid out */ }

// Fill scrollback well past one screen so there's history to scroll into.
for (let i = 1; i <= 400; i++) term.write(`line ${String(i).padStart(4, '0')} ${'.'.repeat(20)}\r\n`)
term.scrollToBottom()

attachTouchScroll(root, term)

// Hooks for the Playwright driver.
;(window as unknown as { __h: unknown }).__h = {
  viewportY: () => term.buffer.active.viewportY,
  baseY: () => term.buffer.active.baseY,
  rows: () => term.rows,
  screenHeight: () => (root.querySelector('.xterm-screen') as HTMLElement | null)?.clientHeight ?? 0,
}
;(window as unknown as { __ready: boolean }).__ready = true
