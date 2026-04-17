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
  children: React.ReactNode
}

export default function BottomPanel({
  title, open, fullscreen, onClose, onToggleFullscreen,
  dockedHeight = 300, zIndex = 100, inline = false, children,
}: Props) {
  const cls = [fullscreen ? 'fullscreen' : open ? 'open' : '', inline ? 'inline' : ''].filter(Boolean).join(' ')
  return (
    <div
      className={`bottom-panel ${cls}`}
      style={{ '--bottom-panel-height': `${dockedHeight}px`, zIndex: inline && !fullscreen ? undefined : zIndex } as React.CSSProperties}
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
