import { useState, useEffect, useRef } from 'react'
import './EmailPreview.css'

interface Props {
  filePath: string
  onClose: () => void
}

function injectPlaceholders(html: string): string {
  return html.replace(/<img([^>]*?)>/gi, (match, attrs) => {
    const srcMatch   = attrs.match(/src="([^"]*)"/)
    const widthMatch = attrs.match(/width="(\d+)"/)
    const altMatch   = attrs.match(/alt="([^"]*)"/)
    if (!srcMatch) return match
    const src   = srcMatch[1]
    const w     = widthMatch ? parseInt(widthMatch[1]) : 600
    const label = altMatch ? altMatch[1] : 'Image'
    if (src.includes('[[')) {
      const h = w >= 500 ? w : Math.round(w * 0.28)
      const placeholder = `https://placehold.co/${w}x${h}/e2e2e2/999999?font=open-sans&text=${encodeURIComponent(label || 'Image')}`
      return match.replace(/src="[^"]*"/, `src="${placeholder}"`)
    }
    return match
  })
}

const VIEWPORTS = [
  { label: 'Desktop', w: 600 },
  { label: 'Mobile', w: 375 },
  { label: 'Wide', w: 900 },
]

export default function EmailPreview({ filePath, onClose }: Props) {
  const [width, setWidth] = useState(600)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const blobRef = useRef<string | null>(null)

  useEffect(() => {
    setError(null)
    setBlobUrl(null)
    fetch(`/api/preview/file?path=${encodeURIComponent(filePath)}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.text()
      })
      .then(html => {
        const processed = injectPlaceholders(html)
        const blob = new Blob([processed], { type: 'text/html' })
        if (blobRef.current) URL.revokeObjectURL(blobRef.current)
        const url = URL.createObjectURL(blob)
        blobRef.current = url
        setBlobUrl(url)
      })
      .catch(e => setError(`Could not load file: ${e.message}`))
    return () => { if (blobRef.current) URL.revokeObjectURL(blobRef.current) }
  }, [filePath])

  const filename = filePath.split('/').pop() ?? filePath

  return (
    <div className="ep-overlay">
      <div className="ep-toolbar">
        <span className="ep-filename">{filename}</span>
        <div className="ep-divider" />
        <div className="ep-btn-group">
          {VIEWPORTS.map(v => (
            <button
              key={v.w}
              className={`ep-btn ${width === v.w ? 'active' : ''}`}
              onClick={() => setWidth(v.w)}
            >{v.label} <span className="ep-btn-w">{v.w}</span></button>
          ))}
        </div>
        <span className="ep-width-label">{width}px</span>
        <button className="ep-close-btn" onClick={onClose}>✕ Close</button>
      </div>
      <div className="ep-body">
        {error && <div className="ep-error">{error}</div>}
        {!error && !blobUrl && <div className="ep-loading">Loading…</div>}
        {blobUrl && (
          <iframe
            src={blobUrl}
            className="ep-iframe"
            style={{ width: `${width}px` }}
          />
        )}
      </div>
    </div>
  )
}
