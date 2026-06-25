import type { Terminal } from '@xterm/xterm'

// Touch-drag scrolling. xterm ignores touch swipes, so we translate a single-finger
// drag into wheel events and dispatch them at xterm — exactly what a trackpad does.
//
// Why wheel and not term.scrollLines(): the terminal almost always runs tmux / a
// full-screen TUI, which lives in the *alternate* screen buffer. That buffer has no
// xterm scrollback, so scrollLines() has nothing to move (it silently does nothing).
// A wheel event instead goes through xterm's own wheel handler, which forwards it to
// the app's mouse mode (tmux scrolls its history) — and falls back to scrollback when
// there's no mouse mode. So dispatching wheel works for BOTH plain shells and tmux,
// and matches the trackpad behavior that already worked. Verified on the iOS Simulator.
//
// Returns a disposer for tests.
export function attachTouchScroll(root: HTMLElement, term: Terminal): () => void {
  let lastY = 0
  let active = false
  const SPEED = 2 // wheel pixels per finger pixel (tuned on-device)

  // The element xterm listens to for wheel; fall back outward if not found yet.
  function wheelTarget(): Element {
    return (
      root.querySelector('.xterm-viewport') ||
      root.querySelector('.xterm-screen') ||
      term.element ||
      root
    )
  }

  function onTouchStart(e: TouchEvent) {
    active = e.touches.length === 1
    if (active) lastY = e.touches[0].clientY
  }
  function onTouchMove(e: TouchEvent) {
    if (!active || e.touches.length !== 1) return
    // Own the single-finger gesture so the WebView never scrolls/bounces the frame.
    if (e.cancelable) e.preventDefault()
    const y = e.touches[0].clientY
    const dy = y - lastY
    lastY = y
    if (dy === 0) return
    // Finger down (dy>0) reveals older output => scroll up => negative deltaY.
    wheelTarget().dispatchEvent(
      new WheelEvent('wheel', { deltaY: -dy * SPEED, deltaMode: 0, bubbles: true, cancelable: true }),
    )
  }
  function onTouchEnd() { active = false }

  root.addEventListener('touchstart', onTouchStart, { passive: true })
  root.addEventListener('touchmove', onTouchMove, { passive: false })
  root.addEventListener('touchend', onTouchEnd, { passive: true })
  return () => {
    root.removeEventListener('touchstart', onTouchStart)
    root.removeEventListener('touchmove', onTouchMove)
    root.removeEventListener('touchend', onTouchEnd)
  }
}
