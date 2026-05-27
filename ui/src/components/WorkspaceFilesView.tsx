import { useCallback, useEffect, useState } from 'react'
import Editor from '@monaco-editor/react'
import {
  listDirectory,
  listWorkspaceRoots,
  readTextFile,
  writeTextFile,
  type DirectoryEntry,
  type WorkspaceRoot,
} from '../api'
import './AgentIdeView.css'

function basename(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

function languageForPath(filePath: string | null) {
  const ext = (filePath?.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    cjs: 'javascript',
    css: 'css',
    html: 'html',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    mjs: 'javascript',
    py: 'python',
    sh: 'shell',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'plaintext',
    yaml: 'yaml',
    yml: 'yaml',
  }
  return map[ext] ?? 'plaintext'
}

interface TreeNodeProps {
  entry: DirectoryEntry
  depth: number
  selectedPath: string | null
  onOpenFile: (path: string) => void
}

function TreeNode({ entry, depth, selectedPath, onOpenFile }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<DirectoryEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggleDirectory() {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (children) return
    setLoading(true)
    setError(null)
    try {
      const data = await listDirectory(entry.path)
      setChildren(data.entries)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setLoading(false)
    }
  }

  const isDirectory = entry.type === 'directory'
  const isSelected = selectedPath === entry.path

  return (
    <div>
      <button
        className={`ide-tree-row${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => isDirectory ? toggleDirectory() : onOpenFile(entry.path)}
        title={entry.path}
      >
        <span className="ide-tree-twist">{isDirectory ? (expanded ? '▾' : '▸') : ''}</span>
        <span className="ide-tree-icon">{isDirectory ? '□' : '·'}</span>
        <span className="ide-tree-name">{entry.name}</span>
      </button>
      {expanded && (
        <div>
          {loading && <div className="ide-tree-status" style={{ paddingLeft: 26 + depth * 14 }}>Loading...</div>}
          {error && <div className="ide-tree-error" style={{ paddingLeft: 26 + depth * 14 }}>{error}</div>}
          {children?.map(child => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onOpenFile={onOpenFile}
            />
          ))}
          {children?.length === 0 && <div className="ide-tree-status" style={{ paddingLeft: 26 + depth * 14 }}>Empty</div>}
        </div>
      )}
    </div>
  )
}

function RootNode({ root, selectedPath, onOpenFile }: { root: WorkspaceRoot; selectedPath: string | null; onOpenFile: (path: string) => void }) {
  const entry: DirectoryEntry = {
    name: root.name,
    path: root.path,
    type: root.exists && root.isDirectory ? 'directory' : 'file',
    size: null,
    modifiedAt: null,
    extension: '',
  }

  if (!root.exists || !root.isDirectory) {
    return (
      <button className="ide-tree-row missing" title={root.path}>
        <span className="ide-tree-twist" />
        <span className="ide-tree-icon">!</span>
        <span className="ide-tree-name">{root.name}</span>
      </button>
    )
  }

  return <TreeNode entry={entry} depth={0} selectedPath={selectedPath} onOpenFile={onOpenFile} />
}

export default function WorkspaceFilesView() {
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reloadRoots = useCallback(async () => {
    setError(null)
    try {
      setRoots(await listWorkspaceRoots())
    } catch (err: any) {
      setError(err?.message ?? String(err))
    }
  }, [])

  useEffect(() => {
    reloadRoots()
  }, [reloadRoots])

  async function openFile(filePath: string) {
    setLoadingFile(true)
    setError(null)
    setOpenFilePath(filePath)
    try {
      const content = await readTextFile(filePath)
      setFileContent(content)
      setEditorContent(content)
      setDirty(false)
    } catch (err: any) {
      setFileContent('')
      setEditorContent('')
      setDirty(false)
      setError(err?.message ?? String(err))
    } finally {
      setLoadingFile(false)
    }
  }

  async function saveFile() {
    if (!openFilePath) return
    setSaving(true)
    setError(null)
    try {
      await writeTextFile(openFilePath, editorContent)
      setFileContent(editorContent)
      setDirty(false)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="agent-ide workspace-files">
      <aside className="ide-sidebar file-only-sidebar">
        <div className="ide-section file-tree-section">
          <div className="ide-section-title">Workspace</div>
          <div className="ide-tree">
            {roots.map(root => (
              <RootNode key={root.path} root={root} selectedPath={openFilePath} onOpenFile={openFile} />
            ))}
            {roots.length === 0 && <div className="ide-empty">No workspace roots configured.</div>}
          </div>
        </div>
      </aside>

      <main className="ide-main">
        <section className="ide-editor-panel full-height">
          <div className="ide-editor-toolbar">
            <div className="ide-editor-title">
              {openFilePath ? (
                <>
                  <span>{basename(openFilePath)}</span>
                  <span className="ide-editor-path">{openFilePath}</span>
                </>
              ) : (
                <span>No file selected</span>
              )}
            </div>
            <div className="ide-button-row">
              <button className="ide-button" onClick={reloadRoots}>Refresh</button>
              <button className="ide-button primary" disabled={!openFilePath || !dirty || saving} onClick={saveFile}>
                {saving ? 'Saving...' : dirty ? 'Save' : 'Saved'}
              </button>
            </div>
          </div>
          {error && <div className="ide-error">{error}</div>}
          <div className="ide-editor-body">
            {openFilePath ? (
              <Editor
                path={openFilePath}
                language={languageForPath(openFilePath)}
                theme="vs-dark"
                value={editorContent}
                loading={<div className="ide-empty">Loading editor...</div>}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineHeight: 20,
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  automaticLayout: true,
                }}
                onChange={value => {
                  const nextValue = value ?? ''
                  setEditorContent(nextValue)
                  setDirty(nextValue !== fileContent)
                }}
              />
            ) : (
              <div className="ide-editor-empty">{loadingFile ? 'Loading...' : 'Select a file from the workspace tree.'}</div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
