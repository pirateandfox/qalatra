import { useCallback, useEffect, useRef, useState } from 'react'
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

interface CreateState {
  dirPath: string
  fileName: string
  saving: boolean
}

// { path, n } — n increments each time so the effect fires even for the same dir
interface RefreshTarget {
  path: string
  n: number
}

interface TreeNodeProps {
  entry: DirectoryEntry
  depth: number
  initialExpanded?: boolean
  selectedPath: string | null
  onOpenFile: (path: string) => void
  createState: CreateState | null
  refreshTarget: RefreshTarget | null
  onCreateHere: (dirPath: string) => void
  onCreateNameChange: (name: string) => void
  onCreateConfirm: () => void
  onCreateCancel: () => void
}

function TreeNode({
  entry, depth, initialExpanded = false, selectedPath, onOpenFile,
  createState, refreshTarget,
  onCreateHere, onCreateNameChange, onCreateConfirm, onCreateCancel,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(initialExpanded)
  const [children, setChildren] = useState<DirectoryEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const isDirectory = entry.type === 'directory'
  const isSelected = selectedPath === entry.path
  const isCreatingHere = createState?.dirPath === entry.path

  const loadChildren = useCallback(async () => {
    setLoading(true)
    setTreeError(null)
    try {
      const data = await listDirectory(entry.path)
      setChildren(data.entries)
    } catch (err: any) {
      setTreeError(err?.message ?? String(err))
    } finally {
      setLoading(false)
    }
  }, [entry.path])

  // Auto-load on mount for initially-expanded nodes (workspace roots)
  useEffect(() => {
    if (initialExpanded) loadChildren()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh a specific directory's children after a file is created there
  useEffect(() => {
    if (!refreshTarget || refreshTarget.path !== entry.path || !isDirectory) return
    loadChildren()
  }, [refreshTarget]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-expand + focus input when this dir is targeted for creation
  useEffect(() => {
    if (!isCreatingHere) return
    setExpanded(true)
    if (!children) loadChildren()
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [isCreatingHere]) // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleDirectory() {
    if (expanded) { setExpanded(false); return }
    setExpanded(true)
    if (!children) await loadChildren()
  }

  const childProps = {
    selectedPath, onOpenFile, createState, refreshTarget,
    onCreateHere, onCreateNameChange, onCreateConfirm, onCreateCancel,
  }

  return (
    <div>
      <div
        className={`ide-tree-row-wrap${isDirectory ? ' is-dir' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <button
          className={`ide-tree-row-btn${isSelected ? ' selected' : ''}`}
          onClick={() => isDirectory ? toggleDirectory() : onOpenFile(entry.path)}
          title={entry.path}
        >
          <span className="ide-tree-twist">{isDirectory ? (expanded ? '▾' : '▸') : ''}</span>
          <span className="ide-tree-icon">{isDirectory ? '□' : '·'}</span>
          <span className="ide-tree-name">{entry.name}</span>
        </button>
        {isDirectory && (
          <button
            className="ide-tree-add-btn"
            title={`New file in ${entry.name}`}
            onClick={e => { e.stopPropagation(); onCreateHere(entry.path) }}
          >+</button>
        )}
      </div>
      {expanded && (
        <div>
          {isCreatingHere && (
            <div className="ide-inline-create" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              <div className="ide-inline-create-dir">{entry.path}/</div>
              <input
                ref={inputRef}
                className="ide-input ide-inline-create-input"
                placeholder="filename.txt"
                value={createState?.fileName ?? ''}
                onChange={e => onCreateNameChange(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') onCreateConfirm()
                  if (e.key === 'Escape') onCreateCancel()
                }}
              />
              <div className="ide-button-row" style={{ marginTop: 4 }}>
                <button
                  className="ide-button primary"
                  disabled={!createState?.fileName?.trim() || createState?.saving}
                  onClick={onCreateConfirm}
                >
                  {createState?.saving ? 'Creating...' : 'Create'}
                </button>
                <button className="ide-button" onClick={onCreateCancel}>Cancel</button>
              </div>
            </div>
          )}
          {loading && <div className="ide-tree-status" style={{ paddingLeft: 26 + depth * 14 }}>Loading...</div>}
          {treeError && <div className="ide-tree-error" style={{ paddingLeft: 26 + depth * 14 }}>{treeError}</div>}
          {children?.map(child => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              {...childProps}
            />
          ))}
          {children?.length === 0 && !isCreatingHere && (
            <div className="ide-tree-status" style={{ paddingLeft: 26 + depth * 14 }}>Empty</div>
          )}
        </div>
      )}
    </div>
  )
}

function RootNode({ root, ...rest }: {
  root: WorkspaceRoot
  selectedPath: string | null
  onOpenFile: (path: string) => void
  createState: CreateState | null
  refreshTarget: RefreshTarget | null
  onCreateHere: (dirPath: string) => void
  onCreateNameChange: (name: string) => void
  onCreateConfirm: () => void
  onCreateCancel: () => void
}) {
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
      <button className="ide-tree-row-btn missing" title={root.path}>
        <span className="ide-tree-twist" />
        <span className="ide-tree-icon">!</span>
        <span className="ide-tree-name">{root.name}</span>
      </button>
    )
  }

  return <TreeNode entry={entry} depth={0} initialExpanded={true} {...rest} />
}

export default function WorkspaceFilesView() {
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [treeKey, setTreeKey] = useState(0)
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createState, setCreateState] = useState<CreateState | null>(null)
  const [refreshTarget, setRefreshTarget] = useState<RefreshTarget | null>(null)

  const reloadRoots = useCallback(async () => {
    setError(null)
    try {
      setRoots(await listWorkspaceRoots())
      setTreeKey(k => k + 1) // full tree reset only for explicit Refresh
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

  function startCreateInDir(dirPath: string) {
    setCreateState({ dirPath, fileName: '', saving: false })
  }

  async function confirmCreate() {
    if (!createState?.fileName.trim()) return
    const fullPath = `${createState.dirPath}/${createState.fileName.trim()}`
    setCreateState(s => s ? { ...s, saving: true } : s)
    setError(null)
    try {
      await writeTextFile(fullPath, '')
      const dirPath = createState.dirPath
      setCreateState(null)
      // Refresh only the directory where the file was created — tree expansion is preserved
      setRefreshTarget(prev => ({ path: dirPath, n: (prev?.n ?? 0) + 1 }))
      await openFile(fullPath)
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setCreateState(s => s ? { ...s, saving: false } : s)
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

  const treeProps = {
    selectedPath: openFilePath,
    onOpenFile: openFile,
    createState,
    refreshTarget,
    onCreateHere: startCreateInDir,
    onCreateNameChange: (name: string) => setCreateState(s => s ? { ...s, fileName: name } : s),
    onCreateConfirm: confirmCreate,
    onCreateCancel: () => setCreateState(null),
  }

  return (
    <div className="agent-ide workspace-files">
      <aside className="ide-sidebar file-only-sidebar">
        <div className="ide-section file-tree-section">
          <div className="ide-section-title">Workspace</div>
          <div className="ide-tree" key={treeKey}>
            {roots.map(root => (
              <RootNode key={root.path} root={root} {...treeProps} />
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
