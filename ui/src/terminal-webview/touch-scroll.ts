import type { Terminal } from '@xterm/xterm'

// Touch-drag scrolling for xterm on mobile. xterm translates wheel events to
// scrollback but ignores touch swipes, so on a touchscreen there's no way to
// scroll up through history.
//
// IMPORTANT: in xterm v6 the viewport scrolls through an internal
// ScrollableElement — it no longer listens to the DOM element's `scroll` event,
// so setting `.xterm-viewport.scrollTop` is a no-op (it worked in v5). We must
// drive the public `term.scrollLines()` API instead, converting drag pixels to
// whole rows. Only single-finger drags past a small threshold scroll; taps fall
// through to focus, and multi-touch (pinch/zoom) is left alone.
//
// `root` is the element xterm was opened into. Returns a disposer for tests.
export function attachTouchScroll(root: HTMLElement, term: Terminal): () => void {
  let startY = 0
  let lastY = 0
  let touchScrolling = false
  let scrollAccumPx = 0 // leftover sub-line pixels carried between moves
  const TOUCH_SLOP = 6 // px of travel before a drag counts as a scroll, not a tap

  // Pixels per terminal row, measured from the rendered screen (no private API).
  function lineHeightPx(): number {
    const screen = root.querySelector('.xterm-screen') as HTMLElement | null
    if (screen && term.rows > 0 && screen.clientHeight > 0) return screen.clientHeight / term.rows
    return 17 // sane fallback before first layout
  }

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return
    startY = lastY = e.touches[0].clientY
    touchScrolling = false
    scrollAccumPx = 0
  }
  function onTouchMove(e: TouchEvent) {
    if (e.touches.length !== 1) return
    // Claim every single-finger move up front. iOS WKWebView locks the gesture to
    // its own scroll view on the first touchmove and ignores a later preventDefault,
    // so deferring it until we pass the slop threshold lets the frame scroll instead
    // of the terminal. Taps don't move enough to matter; click still fires for focus.
    if (e.cancelable) e.preventDefault()
    const y = e.touches[0].clientY
    if (!touchScrolling && Math.abs(y - startY) < TOUCH_SLOP) { lastY = y; return }
    touchScrolling = true
    scrollAccumPx += lastY - y // finger up => positive => scroll toward newer output
    lastY = y
    const lh = lineHeightPx()
    const lines = Math.trunc(scrollAccumPx / lh)
    if (lines !== 0) {
      term.scrollLines(lines)
      scrollAccumPx -= lines * lh
    }
  }

  root.addEventListener('touchstart', onTouchStart, { passive: true })
  root.addEventListener('touchmove', onTouchMove, { passive: false })
  return () => {
    root.removeEventListener('touchstart', onTouchStart)
    root.removeEventListener('touchmove', onTouchMove)
  }
}
