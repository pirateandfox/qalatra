import { useState, useEffect, useRef } from 'react'
import { HtmlEditor } from './HtmlEditor'
import './EmailPreview.css'

interface Props {
  filePath: string
  onClose: () => void
  terminalOpen: boolean
  onTerminalToggle: () => void
  onChatWithDoc: (filePath: string) => void | Promise<void>
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

async function readFile(path: string): Promise<string> {
  return (window as any).electronAPI.invoke('file:read', path)
}

async function writeFile(path: string, contents: string): Promise<void> {
  await (window as any).electronAPI.invoke('file:write', path, contents)
}

export default function EmailPreview({ filePath, onClose, terminalOpen, onTerminalToggle, onChatWithDoc }: Props) {
  const [width, setWidth] = useState(600)
  const [html, setHtml] = useState('')
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const blobRef = useRef<string | null>(null)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedRef = useRef(false)

  // Load file
  useEffect(() => {
    loadedRef.current = false
    setError(null)
    setIsDirty(false)
    readFile(filePath)
      .then(content => {
        setHtml(content)
        loadedRef.current = true
      })
      .catch(e => setError(`Could not load file: ${e.message}`))
    return () => { if (blobRef.current) URL.revokeObjectURL(blobRef.current) }
  }, [filePath])

  // Rebuild blob URL whenever html changes
  useEffect(() => {
    const processed = injectPlaceholders(html)
    const blob = new Blob([processed], { type: 'text/html' })
    if (blobRef.current) URL.revokeObjectURL(blobRef.current)
    const url = URL.createObjectURL(blob)
    blobRef.current = url
    setBlobUrl(url)
  }, [html])

  // Autosave on html change (1s debounce) — skip until after initial load
  useEffect(() => {
    if (!loadedRef.current) return
    setIsDirty(true)
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = setTimeout(() => {
      writeFile(filePath, html).then(() => setIsDirty(false)).catch(console.error)
    }, 1000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html])

  function handleChatWithDoc() {
    onChatWithDoc(filePath)
  }

  const filename = filePath.split('/').pop() ?? filePath

  return (
    <div className="ep-overlay" style={{ paddingBottom: terminalOpen ? 300 : 0 }}>
      <div className="ep-toolbar">
        <span className="ep-filename">{filename}{isDirty ? ' •' : ''}</span>
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
        <div className="ep-divider" />
        <button
          className={`ep-btn ${showEditor ? 'active' : ''}`}
          onClick={() => setShowEditor(v => !v)}
          title="Toggle HTML editor"
        >Editor</button>
        <div className="ep-divider" />
        <button
          className={`ep-btn ${terminalOpen ? 'active' : ''}`}
          onClick={onTerminalToggle}
          title="Toggle terminal (Ctrl+`)"
        >Terminal</button>
        <button
          className={`ep-btn ${terminalOpen ? 'active' : ''}`}
          onClick={handleChatWithDoc}
          title="Open claude in this file's folder"
        >Chat</button>
        <button className="ep-close-btn" onClick={onClose}>✕ Close</button>
      </div>

      <div className="ep-body">
        {error && <div className="ep-error">{error}</div>}
        {!error && !blobUrl && <div className="ep-loading">Loading…</div>}
        {!error && blobUrl && (
          <>
            {showEditor && (
              <div className="ep-editor-panel">
                <HtmlEditor value={html} onChange={setHtml} />
              </div>
            )}
            <div className="ep-preview-panel">
              <iframe
                src={blobUrl}
                className="ep-iframe"
                style={{ width: `${width}px` }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
