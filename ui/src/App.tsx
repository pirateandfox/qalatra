import { lazy, Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  fetchTasks, fetchSettings, updateTask, api,
  onInstanceConfigChange,
  type TaskData,
} from './api'
import { today as todayStr } from './lib/constants'
import { ContextsProvider } from './lib/ContextsProvider'
import { ThemeProvider, useTheme } from './lib/ThemeProvider'
import Sidebar, { type NavSection } from './components/Sidebar'
import { getSidebarConfig, saveSidebarConfig, saveLastNav, resolveInitialNav, toolsLabelOrDefault, type SidebarConfig } from './lib/nav'
import Header from './components/Header'
import TaskList from './components/TaskList'
import BacklogView from './components/BacklogView'
import CodeAgentsView from './components/CodeAgentsView'
import ReadingView from './components/ReadingView'
import ProjectDashboardView from './components/ProjectDashboardView'
import DetailPanel from './components/DetailPanel'
import Terminal, { type TerminalLaunch } from './components/Terminal'
import SettingsView from './components/SettingsView'
import MeetingView from './components/MeetingView'
import CreateTask from './components/CreateTask'
import HabitsView from './components/HabitsView'
import HeartbeatsView from './components/HeartbeatsView'
import ShortcutsHelp from './components/ShortcutsHelp'
import EmailPreview from './components/EmailPreview'
import { AccountGate } from './components/AccountGate'
import MdView from './mdpdf/MdView'
import './index.css'

const DailyNote = lazy(() => import('./components/DailyNote'))
const TerminalManagerView = lazy(() => import('./components/TerminalManagerView'))
const WorkspaceFilesView = lazy(() => import('./components/WorkspaceFilesView'))
const BoxWebView = lazy(() => import('./components/BoxWebView'))

function dirname(filePath: string) {
  const idx = filePath.lastIndexOf('/')
  return idx > 0 ? filePath.slice(0, idx) : undefined
}

function basename(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}


export default function App() {
  return (
    <ThemeProvider>
      <AccountGate>
        <AppInner />
      </AccountGate>
    </ThemeProvider>
  )
}

function AppInner() {
  const { mode, setMode } = useTheme()
  const [date, setDate]             = useState(todayStr())
  const [sidebarConfig, setSidebarConfig] = useState<SidebarConfig>(() => getSidebarConfig())
  const [nav, setNav]               = useState<NavSection>(() => resolveInitialNav(sidebarConfig))
  const [backlogRefresh, setBacklogRefresh] = useState(0)
  const [codeRefresh, setCodeRefresh]       = useState(0)
  const [readingRefresh, setReadingRefresh] = useState(0)
  const [dailyNoteRefresh, setDailyNoteRefresh] = useState(0)
  const [taskData, setTaskData]     = useState<TaskData | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [terminalMode, setTerminalMode] = useState<'closed' | 'docked' | 'fullscreen'>('closed')
  const [terminalLaunch, setTerminalLaunch] = useState<TerminalLaunch | null>(null)
  const [previewPath, setPreviewPath]   = useState<string | null>(null)
  const [mdPath, setMdPath]             = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [meetingId, setMeetingId]   = useState<string | null>(null)
  const [loading, setLoading]       = useState(false)
  const [apiError, setApiError]     = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<{ status: string; version?: string; percent?: number; message?: string } | null>(null)
  // The Tools/boxWeb item is now part of the per-backend nav config (toolsEnabled/
  // toolsLabel), so it derives from sidebarConfig and reacts to config edits and
  // backend switches automatically — no separate state or instance subscription.
  const boxWebItem = sidebarConfig.toolsEnabled ? { label: toolsLabelOrDefault(sidebarConfig) } : null

  const handleSidebarConfigChange = useCallback((config: SidebarConfig) => {
    setSidebarConfig(config)
    saveSidebarConfig(config) // persists to the active backend's slot
    // If the section you're currently viewing just got hidden, fall back to the
    // default landing view. Action views (settings/daily/boxWeb) aren't toggleable
    // and never appear in `hidden`, so editing the config from Settings won't bounce you.
    setNav(prev => (config.hidden.includes(prev) ? config.landing : prev))
  }, [])

  // Remember the active tab per backend so switching servers (which reloads the
  // page) and coming back lands you where you left off rather than on Priority.
  useEffect(() => { saveLastNav(nav) }, [nav])

  // Sidebar visibility is per-backend, so re-resolve it whenever the active
  // backend changes (e.g. switching instances in Settings). A user-initiated
  // switch reloads the page (so the remembered tab is restored on boot); this
  // reload-free path restores the new backend's last tab too, for safety.
  useEffect(() => onInstanceConfigChange(() => {
    const next = getSidebarConfig()
    setSidebarConfig(next)
    setNav(resolveInitialNav(next))
  }), [])

  const toggleTerminal = useCallback((launch: TerminalLaunch | null = null) => {
    setTerminalMode(current => {
      if (current === 'closed') {
        setTerminalLaunch(launch)
        return 'docked'
      }
      return 'closed'
    })
  }, [])

  const openTerminal = useCallback((launch: TerminalLaunch | null = null) => {
    setTerminalLaunch(launch)
    setTerminalMode(current => current === 'closed' ? 'docked' : current)
  }, [])

  // A full-screen doc overlay (markdown/email preview) can launch the shared
  // terminal. When the overlay closes we close that terminal too — but only if
  // the overlay was what opened it, so a terminal you already had running in the
  // main view survives. We capture "was a terminal open?" at overlay-open time.
  const overlayOpen = !!(mdPath || previewPath)
  const terminalOpenAtOverlayOpenRef = useRef(false)
  const prevOverlayOpenRef = useRef(false)
  useEffect(() => {
    if (overlayOpen && !prevOverlayOpenRef.current) {
      terminalOpenAtOverlayOpenRef.current = terminalMode !== 'closed'
    }
    prevOverlayOpenRef.current = overlayOpen
  }, [overlayOpen, terminalMode])

  const closeOverlay = useCallback((clear: () => void) => {
    clear()
    if (!terminalOpenAtOverlayOpenRef.current) setTerminalMode('closed')
  }, [])

  function terminalLaunchForFile(filePath: string): TerminalLaunch {
    const name = basename(filePath)
    return { cwd: dirname(filePath), title: name }
  }

  async function chatWithDoc(filePath: string) {
    const settings = await fetchSettings().catch(() => ({} as Record<string, string>))
    const agentCmd = settings.defaultAgentCommand || 'claude --dangerously-skip-permissions'
    const name = basename(filePath)
    openTerminal({
      cwd: dirname(filePath),
      title: `Chat: ${name}`,
      command: `${agentCmd} ${shellQuote(`I want to work on ${name}`)}`,
    })
  }

  const load = useCallback(async (d: string, silent = false) => {
    if (!silent) setLoading(true)
    try {
      const data = await fetchTasks(d)
      setTaskData(data)
      setApiError(null)
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      console.error('[App] fetchTasks failed:', msg)
      if (!silent) setApiError(msg)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { load(date) }, [date, load])

  useEffect(() => {
    if (nav === 'boxWeb' && !boxWebItem) {
      setNav(sidebarConfig.landing)
      setSelectedId(null)
    }
  }, [nav, boxWebItem, sidebarConfig.landing])

  // Background poll — 30s normally, 5s while agent jobs are running
  useEffect(() => {
    const allTasks = Object.values(taskData ?? {}).flat().filter(t => t && typeof t === 'object' && 'id' in t) as { agent_job_status?: string }[]
    const hasActive = allTasks.some(t => t.agent_job_status === 'queued' || t.agent_job_status === 'running')
    const interval = setInterval(() => load(date, true), hasActive ? 5000 : 30_000)
    return () => clearInterval(interval)
  }, [taskData, date, load])

  // Active agent count for sidebar badge (from today's taskData)
  const activeAgentCount = useMemo(() => {
    return Object.values(taskData ?? {})
      .flat()
      .filter(t => t && typeof t === 'object' && 'agent_job_status' in t)
      .filter((t: any) => t.agent_job_status === 'queued' || t.agent_job_status === 'running')
      .length
  }, [taskData])

  // File > Open File… from native menu
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api) return
    api.onOpenFile((filePath: string) => {
      if (filePath.endsWith('.md')) setMdPath(filePath)
      else setPreviewPath(filePath)
    })
  }, [])

  // Update status banner
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.onUpdaterStatus) return
    const unsub = api.onUpdaterStatus((data: { status: string; version?: string; percent?: number; message?: string }) => {
      setUpdateStatus(data)
      if (data.status === 'not-available') {
        setTimeout(() => setUpdateStatus(s => s?.status === 'not-available' ? null : s), 3000)
      }
    })
    return unsub
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const NAV_KEYS: Record<string, NavSection> = {
      '1': 'priority', '2': 'code', '3': 'terminals', '4': 'files', '5': 'reading',
      '6': 'project',  '7': 'backlog', '8': 'habits', '9': 'heartbeats',
    }

    const handler = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isInInput = (target instanceof HTMLInputElement) ||
        (target instanceof HTMLTextAreaElement) ||
        target.isContentEditable ||
        !!target.closest?.('.ide-terminal-xterm, .server-terminal-xterm')

      // Always-active shortcuts (work even in inputs)
      if (e.key === '`' && e.ctrlKey) { toggleTerminal(); return }
      if (e.key === 'Escape') {
        if (shortcutsOpen) { setShortcutsOpen(false); return }
        if (createOpen) { setCreateOpen(false); return }
        if (selectedId) { setSelectedId(null); return }
        if (meetingId) { setMeetingId(null); return }
        return
      }

      if (isInInput || e.metaKey || e.ctrlKey || e.altKey) return

      // Navigation: number keys 1–7
      if (NAV_KEYS[e.key]) {
        setNav(NAV_KEYS[e.key])
        setSelectedId(null)
        return
      }

      // Single-key shortcuts
      switch (e.key) {
        case 'n':
          setCreateOpen(true)
          break
        case 'r':
          if (nav === 'backlog') setBacklogRefresh(n => n + 1)
          else if (nav === 'daily') setDailyNoteRefresh(n => n + 1)
          else load(date)
          break
        case 't':
          toggleTerminal()
          break
        case 'd':
          setNav('daily')
          setSelectedId(null)
          break
        case ',':
          setNav(n => n === 'settings' ? 'priority' : 'settings')
          break
        case '?':
          setShortcutsOpen(o => !o)
          break
        case '/': {
          const searchInput = document.querySelector<HTMLInputElement>('[data-task-search-input]')
          if (searchInput) {
            e.preventDefault()
            searchInput.focus()
          }
          break
        }
        case 'j':
        case 'k': {
          const rows = Array.from(document.querySelectorAll<HTMLElement>('.task-row[data-id]'))
          if (!rows.length) break
          const currentIdx = rows.findIndex(r => r.dataset.id === selectedId)
          const nextIdx = e.key === 'j'
            ? (currentIdx === -1 ? 0 : Math.min(currentIdx + 1, rows.length - 1))
            : (currentIdx === -1 ? rows.length - 1 : Math.max(currentIdx - 1, 0))
          const nextId = rows[nextIdx]?.dataset.id
          if (nextId) {
            setSelectedId(nextId)
            rows[nextIdx].scrollIntoView({ block: 'nearest' })
          }
          break
        }
        case 'c':
          if (selectedId) {
            await api.complete(selectedId)
            setSelectedId(null)
            if (nav === 'backlog') setBacklogRefresh(n => n + 1)
            else load(date, true)
          }
          break
        case 'b':
          if (selectedId) {
            await updateTask(selectedId, { status: 'backlog' })
            setSelectedId(null)
            if (nav === 'backlog') setBacklogRefresh(n => n + 1)
            else load(date, true)
          }
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedId, meetingId, createOpen, shortcutsOpen, nav, date, load, toggleTerminal])

  if (meetingId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <MeetingView taskId={meetingId} onBack={() => setMeetingId(null)} />
      </div>
    )
  }

  return (
    <ContextsProvider>
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar
        nav={nav}
        onNavChange={n => { setNav(n); setSelectedId(null) }}
        activeAgentCount={activeAgentCount}
        boxWebItem={boxWebItem}
        hiddenSections={sidebarConfig.hidden}
        onNewTask={() => setCreateOpen(true)}
        dailyNoteActive={nav === 'daily'}
        onDailyNoteOpen={() => { setNav('daily'); setSelectedId(null) }}
        themeMode={mode}
        onThemeModeChange={setMode}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <Header
          date={date}
          nav={nav}
          onDateChange={d => { setDate(d); setSelectedId(null) }}
          onRefresh={() => {
            if (nav === 'backlog') setBacklogRefresh(n => n + 1)
            else if (nav === 'daily') setDailyNoteRefresh(n => n + 1)
            else load(date)
          }}
        />

        <div className={`layout ${selectedId ? 'panel-open' : ''}`} style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: nav === 'settings' || nav === 'daily' || nav === 'terminals' || nav === 'files' || nav === 'boxWeb' ? 'hidden' : 'auto', minWidth: 0 }}>
            {nav === 'settings' ? (
              <SettingsView sidebarConfig={sidebarConfig} onSidebarConfigChange={handleSidebarConfigChange} />
            ) : nav === 'daily' ? (
              <Suspense fallback={<div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center' }}>Loading Daily Note...</div>}>
                <DailyNote date={date} refreshToken={dailyNoteRefresh} />
              </Suspense>
            ) : nav === 'heartbeats' ? (
              <HeartbeatsView />
            ) : nav === 'terminals' ? (
              <Suspense fallback={<div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center' }}>Loading terminals...</div>}>
                <TerminalManagerView />
              </Suspense>
            ) : nav === 'files' ? (
              <Suspense fallback={<div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center' }}>Loading files...</div>}>
                <WorkspaceFilesView />
              </Suspense>
            ) : nav === 'boxWeb' ? (
              <Suspense fallback={<div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center' }}>Loading Box Web App...</div>}>
                <BoxWebView label={boxWebItem?.label || 'Tools'} />
              </Suspense>
            ) : nav === 'habits' ? (
              <HabitsView onMutate={() => load(date, true)} />
            ) : nav === 'backlog' ? (
              <BacklogView
                refreshToken={backlogRefresh}
                selectedId={selectedId}
                onSelect={id => setSelectedId(id)}
                onMutate={() => setBacklogRefresh(n => n + 1)}
              />
            ) : nav === 'code' ? (
              <CodeAgentsView
                selectedId={selectedId}
                onSelect={id => setSelectedId(id)}
                onMutate={() => { setCodeRefresh(n => n + 1); load(date, true) }}
                refreshToken={codeRefresh}
              />
            ) : nav === 'reading' ? (
              <ReadingView
                selectedId={selectedId}
                onSelect={id => setSelectedId(id)}
                onMutate={() => { setReadingRefresh(n => n + 1); load(date, true) }}
                refreshToken={readingRefresh}
              />
            ) : nav === 'project' ? (
              <ProjectDashboardView
                selectedId={selectedId}
                onSelect={id => setSelectedId(id)}
                onMutate={() => load(date, true)}
              />
            ) : (
              <>
                {loading && <div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center' }}>Loading…</div>}
                {!loading && apiError && (
                  <div style={{ padding: '40px', color: '#e55', fontFamily: 'monospace', fontSize: 13 }}>
                    <div style={{ marginBottom: 8, fontWeight: 600 }}>Could not load tasks</div>
                    <div style={{ marginBottom: 12, opacity: 0.8 }}>Error: {apiError}</div>
                    <button onClick={() => load(date)} style={{ padding: '6px 14px', cursor: 'pointer' }}>Retry</button>
                  </div>
                )}
                {!loading && !apiError && taskData && (
                  <TaskList
                    data={taskData}
                    view="priority"
                    selectedId={selectedId}
                    onSelect={id => setSelectedId(id)}
                    onMeetingOpen={id => setMeetingId(id)}
                    onMutate={() => load(date, true)}
                  />
                )}
              </>
            )}
          </div>

          <DetailPanel
            taskId={selectedId}
            onClose={() => setSelectedId(null)}
            onMutate={() => {
              if (nav === 'backlog') setBacklogRefresh(n => n + 1)
              else if (nav === 'code') setCodeRefresh(n => n + 1)
              else if (nav === 'reading') setReadingRefresh(n => n + 1)
              else load(date, true)
            }}
            onDelete={() => {
              setSelectedId(null)
              if (nav === 'backlog') setBacklogRefresh(n => n + 1)
              else if (nav === 'code') setCodeRefresh(n => n + 1)
              else if (nav === 'reading') setReadingRefresh(n => n + 1)
              else load(date, true)
            }}
            onSelectTask={id => setSelectedId(id)}
            terminalOpen={terminalMode !== 'closed'}
            onPreview={path => path.endsWith('.md') ? setMdPath(path) : setPreviewPath(path)}
            onRunInTerminal={cmd => openTerminal({ command: cmd, title: 'Task terminal' })}
          />
        </div>

        <Terminal
          mode={terminalMode}
          onClose={() => setTerminalMode('closed')}
          onToggleFullscreen={() => setTerminalMode(m => m === 'fullscreen' ? 'docked' : 'fullscreen')}
          pendingLaunch={terminalLaunch}
          onCommandConsumed={() => setTerminalLaunch(null)}
          floatOverlay={!!(mdPath || previewPath)}
        />
      </div>

      <CreateTask
        open={createOpen}
        defaultDate={date}
        onClose={() => setCreateOpen(false)}
        onCreated={id => { load(date); setSelectedId(id) }}
      />
      {previewPath && (
        <EmailPreview
          filePath={previewPath}
          onClose={() => closeOverlay(() => setPreviewPath(null))}
          terminalOpen={terminalMode !== 'closed'}
          onTerminalToggle={(fp) => toggleTerminal(terminalLaunchForFile(fp))}
          onChatWithDoc={chatWithDoc}
        />
      )}
      {mdPath && (
        <MdView
          filePath={mdPath}
          onClose={() => closeOverlay(() => setMdPath(null))}
          terminalOpen={terminalMode !== 'closed'}
          onTerminalToggle={(fp) => toggleTerminal(terminalLaunchForFile(fp))}
          onChatWithDoc={chatWithDoc}
        />
      )}
      <UpdateBanner status={updateStatus} onDismiss={() => setUpdateStatus(null)} />
      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
    </div>
    </ContextsProvider>
  )
}

function UpdateBanner({ status, onDismiss }: { status: { status: string; version?: string; percent?: number; message?: string } | null; onDismiss: () => void }) {
  if (!status) return null

  const { status: s, version, percent, message } = status

  const bg: Record<string, string> = {
    checking: 'var(--surface2)',
    'not-available': 'var(--surface2)',
    available: 'var(--surface2)',
    downloading: 'var(--surface2)',
    downloaded: '#1a6b3c',
    error: '#6b2a1a',
  }

  let text = ''
  if (s === 'checking') text = 'Checking for updates…'
  else if (s === 'not-available') text = `Up to date${version ? ` (v${version})` : ''}`
  else if (s === 'available') text = `Update v${version} available`
  else if (s === 'downloading') text = `Downloading update… ${percent ?? 0}%`
  else if (s === 'downloaded') text = `v${version} ready to install`
  else if (s === 'error') text = message ?? 'Update check failed'

  const canDismiss = s === 'not-available' || s === 'error' || s === 'available' || s === 'downloaded'

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 160,
      right: 0,
      height: 32,
      background: bg[s] ?? 'var(--surface2)',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      gap: 8,
      fontSize: 12,
      color: 'var(--text)',
      zIndex: 9999,
    }}>
      {s === 'checking' && (
        <span style={{ width: 12, height: 12, border: '2px solid var(--muted)', borderTopColor: 'var(--text)', borderRadius: '50%', display: 'inline-block', animation: 'agent-spin 0.7s linear infinite' }} />
      )}
      {s === 'downloading' && (
        <div style={{ width: 80, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${percent ?? 0}%`, height: '100%', background: 'var(--accent, #4a9eff)', transition: 'width 0.3s' }} />
        </div>
      )}
      <span style={{ flex: 1 }}>{text}</span>
      {s === 'available' && (
        <button
          onClick={() => (window as any).electronAPI?.downloadUpdate?.()}
          style={{ fontSize: 11, padding: '2px 10px', cursor: 'pointer', borderRadius: 4, background: 'var(--accent, #4a9eff)', color: '#fff', border: 'none' }}
        >
          Download
        </button>
      )}
      {s === 'downloaded' && (
        <button
          onClick={() => (window as any).electronAPI?.installUpdate?.()}
          style={{ fontSize: 11, padding: '2px 10px', cursor: 'pointer', borderRadius: 4, background: '#2d9e5f', color: '#fff', border: 'none' }}
        >
          Restart &amp; Install
        </button>
      )}
      {canDismiss && (
        <button
          onClick={onDismiss}
          style={{ fontSize: 11, padding: '2px 6px', cursor: 'pointer', borderRadius: 4, background: 'transparent', color: 'var(--muted)', border: 'none', lineHeight: 1 }}
          aria-label="Dismiss"
        >
          ✕
        </button>
      )}
    </div>
  )
}
