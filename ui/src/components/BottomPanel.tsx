import './BottomPanel.css'

interface Props {
  title: React.ReactNode
  open: boolean
  fullscreen: boolean
  onClose: () => void
  onToggleFullscreen: () => void
  dockedHeight?: number
  zIndex?: number
  inline?: boolean
  /** Float above a full-screen overlay instead of sitting in the app's flow.
   *  Used when a fixed overlay (markdown/email preview) covers the inline host. */
  floatOverlay?: boolean
  children: React.ReactNode
}

export default function BottomPanel({
  title, open, fullscreen, onClose, onToggleFullscreen,
  dockedHeight = 300, zIndex = 100, inline = false, floatOverlay = false, children,
}: Props) {
  const cls = [
    fullscreen ? 'fullscreen' : open ? 'open' : '',
    inline ? 'inline' : '',
    floatOverlay ? 'float-overlay' : '',
  ].filter(Boolean).join(' ')
  // Inline+docked normally drops out of the z-index stack so it pushes app
  // content up in flow. When floating over an overlay it becomes fixed and
  // needs an explicit z-index to sit above it.
  const needsZIndex = !(inline && !fullscreen) || floatOverlay
  return (
    <div
      className={`bottom-panel ${cls}`}
      style={{ '--bottom-panel-height': `${dockedHeight}px`, zIndex: needsZIndex ? zIndex : undefined } as React.CSSProperties}
    >
      <div className="bottom-panel-toolbar">
        <span className="bottom-panel-title">{title}</span>
        <button className="bottom-panel-btn" title={fullscreen ? 'Restore' : 'Expand'} onClick={onToggleFullscreen}>
          {fullscreen ? '⊡' : '⛶'}
        </button>
        <button className="bottom-panel-btn" title="Close" onClick={onClose}>✕</button>
      </div>
      <div className="bottom-panel-content">
        {children}
      </div>
    </div>
  )
}
