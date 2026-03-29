import { useState, useEffect, useCallback, useRef } from 'react'
import { StyleSidebar } from './components/StyleSidebar'
import { MarkdownEditor, type MarkdownEditorHandle } from './components/MarkdownEditor'
import { PreviewPanel } from './components/PreviewPanel'
import { type StyleConfig, type DocumentConfig, DEFAULT_STYLE } from './types'
import { injectPrintContent } from './utils/printHTML'
import './MdView.css'

interface Props {
  filePath: string
  onClose: () => void
  terminalOpen: boolean
  onTerminalToggle: () => void
  onChatWithDoc: (filePath: string) => void | Promise<void>
}

function getConfigPath(filePath: string): string {
  const dotIdx = filePath.lastIndexOf('.')
  const base = dotIdx > -1 ? filePath.slice(0, dotIdx) : filePath
  return base + '.topdf.json'
}

function countWords(text: string): number {
  const stripped = text.replace(/(?:^|\r?\n)[ \t]*<!--\s*pagebreak\s*-->[ \t]*(?:\r?\n|$)/gim, '')
  return stripped.trim().split(/\s+/).filter(Boolean).length
}

async function readFile(path: string): Promise<string> {
  return (window as any).electronAPI.invoke('file:read', path)
}

async function writeFile(path: string, contents: string): Promise<void> {
  await (window as any).electronAPI.invoke('file:write', path, contents)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await (window as any).electronAPI.invoke('file:read', path)
    return true
  } catch {
    return false
  }
}

export default function MdView({ filePath, onClose, terminalOpen, onTerminalToggle, onChatWithDoc }: Props) {
  const [markdown, setMarkdown] = useState('')
  const [style, setStyle] = useState<StyleConfig>(DEFAULT_STYLE)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [editorWidth, setEditorWidth] = useState(420)
  const [showEditor, setShowEditor] = useState(true)
  const [showSidebar, setShowSidebar] = useState(true)
  const [isDirty, setIsDirty] = useState(false)

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorHandle = useRef<MarkdownEditorHandle>(null)
  const loadedRef = useRef(false)

  // Load file on mount
  useEffect(() => {
    loadedRef.current = false
    loadFile(filePath)
  }, [filePath])

  // Autosave on markdown change (1s debounce) — skip until after initial load
  useEffect(() => {
    if (!loadedRef.current) return
    setIsDirty(true)
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = setTimeout(() => {
      saveMarkdown(filePath, markdown)
    }, 1000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown])

  // Save config sidecar when style changes (skip until after initial load)
  useEffect(() => {
    if (!loadedRef.current) return
    saveConfig(filePath, style)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, filePath])

  async function loadFile(path: string) {
    try {
      const content = await readFile(path)
      setMarkdown(content)

      const configPath = getConfigPath(path)
      const exists = await fileExists(configPath)
      if (exists) {
        const configRaw = await readFile(configPath)
        const config: DocumentConfig = JSON.parse(configRaw)
        setStyle(config.style ?? DEFAULT_STYLE)
      } else {
        setStyle(DEFAULT_STYLE)
      }
      setIsDirty(false)
      loadedRef.current = true
    } catch (e) {
      console.error('Failed to load file:', e)
    }
  }

  async function saveMarkdown(path: string, content: string) {
    try {
      await writeFile(path, content)
      setIsDirty(false)
    } catch (e) {
      console.error('Failed to save file:', e)
    }
  }

  async function saveConfig(path: string, s: StyleConfig) {
    const config: DocumentConfig = { filePath: path, pageBreaks: [], style: s }
    const configPath = getConfigPath(path)
    try {
      await writeFile(configPath, JSON.stringify(config, null, 2))
    } catch (e) {
      console.error('Failed to save config:', e)
    }
  }

  async function saveFile() {
    await saveMarkdown(filePath, markdown)
  }

  function exportPDF() {
    const cleanup = injectPrintContent(markdown, style)
    window.print()
    setTimeout(cleanup, 1000)
  }

  function insertBreakAfterBlock(sourceCharEnd: number) {
    setMarkdown((md) => (
      md.slice(0, sourceCharEnd).trimEnd() +
      '\n\n<!-- pagebreak -->\n\n' +
      md.slice(sourceCharEnd).trimStart()
    ))
  }

  function removePageBreak(breakIndex: number) {
    let count = 0
    setMarkdown((md) =>
      md.replace(/(?:^|\r?\n)[ \t]*<!--\s*pagebreak\s*-->[ \t]*(?:\r?\n|$)/gim, (match) => {
        if (count === breakIndex) { count++; return '\n\n' }
        count++
        return match
      })
    )
  }

  function insertPageBreak() {
    editorHandle.current?.insertPageBreak()
    if (!showEditor) setShowEditor(true)
  }

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Resizable panels
  const dragging = useRef<{ which: 'sidebar' | 'editor'; startX: number; startW: number } | null>(null)

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return
    const delta = e.clientX - dragging.current.startX
    if (dragging.current.which === 'sidebar') {
      setSidebarWidth(Math.max(180, Math.min(400, dragging.current.startW + delta)))
    } else {
      setEditorWidth(Math.max(200, Math.min(800, dragging.current.startW + delta)))
    }
  }, [])

  const onMouseUp = useCallback(() => {
    dragging.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [onMouseMove, onMouseUp])

  function startResizeSidebar(e: React.MouseEvent) {
    e.preventDefault()
    dragging.current = { which: 'sidebar', startX: e.clientX, startW: sidebarWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  function startResizeEditor(e: React.MouseEvent) {
    e.preventDefault()
    dragging.current = { which: 'editor', startX: e.clientX, startW: editorWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const wordCount = countWords(markdown)
  const fileName = filePath.split('/').pop() ?? ''

  return (
    <div className="mdview-overlay">
      {/* Toolbar */}
      <div className="mdview-toolbar">
        <button className="mdview-toolbar-btn" onClick={saveFile} title="Save file">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
          Save{isDirty ? ' •' : ''}
        </button>

        <div className="mdview-toolbar-sep" />

        <button className="mdview-toolbar-btn" onClick={insertPageBreak} title="Insert page break at cursor">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="12" x2="21" y2="12" strokeDasharray="4 2"/>
            <line x1="12" y1="5" x2="12" y2="19"/>
          </svg>
          Insert Page Break
        </button>

        <div className="mdview-toolbar-sep" />
        <span className="mdview-file-path" title={filePath}>{fileName}</span>

        <div className="mdview-toolbar-spacer" />

        <button
          className="mdview-toolbar-btn"
          onClick={() => setShowSidebar((v) => !v)}
          title="Toggle style sidebar"
          style={{ color: showSidebar ? '#3b82f6' : undefined }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
          Style
        </button>

        <button
          className="mdview-toolbar-btn"
          onClick={() => setShowEditor((v) => !v)}
          title="Toggle editor"
          style={{ color: showEditor ? '#3b82f6' : undefined }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          Editor
        </button>

        <div className="mdview-toolbar-sep" />

        <button className="mdview-toolbar-btn mdview-toolbar-btn-primary" onClick={exportPDF} title="Open print dialog — use PDF › Save as PDF">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </svg>
          Export PDF
        </button>

        <div className="mdview-toolbar-sep" />

        <button
          className="mdview-toolbar-btn"
          onClick={onTerminalToggle}
          title="Toggle terminal (Ctrl+`)"
          style={{ color: terminalOpen ? '#3b82f6' : undefined }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          Terminal
        </button>

        <button
          className="mdview-toolbar-btn"
          onClick={() => onChatWithDoc(filePath)}
          title="Open claude in this file's folder"
          style={{ color: '#60a5fa' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Chat
        </button>

        <div className="mdview-toolbar-sep" />

        <button className="mdview-toolbar-btn mdview-close-btn" onClick={onClose} title="Close (Esc)">
          ✕ Close
        </button>
      </div>

      {/* Three-panel layout */}
      <div className="mdview-panels" style={{ paddingBottom: terminalOpen ? 300 : 0 }}>
        {showSidebar && (
          <>
            <div style={{ width: sidebarWidth, flexShrink: 0, overflow: 'hidden' }}>
              <StyleSidebar style={style} onChange={setStyle} />
            </div>
            <div className="mdview-resize-handle" onMouseDown={startResizeSidebar} />
          </>
        )}

        {showEditor && (
          <>
            <div style={{ width: editorWidth, flexShrink: 0, overflow: 'hidden' }}>
              <MarkdownEditor
                ref={editorHandle}
                value={markdown}
                onChange={setMarkdown}
                wordCount={wordCount}
              />
            </div>
            <div className="mdview-resize-handle" onMouseDown={startResizeEditor} />
          </>
        )}

        <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
          <PreviewPanel
            markdown={markdown}
            style={style}
            onInsertBreakAfter={insertBreakAfterBlock}
            onRemoveBreak={removePageBreak}
          />
        </div>
      </div>
    </div>
  )
}
