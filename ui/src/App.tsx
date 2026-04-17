import { useState, useEffect, useCallback } from 'react'
import { fetchTasks, fetchSettings, type TaskData } from './api'
import { today as todayStr } from './lib/constants'
import { ContextsProvider } from './lib/ContextsProvider'
import { ThemeProvider, useTheme } from './lib/ThemeProvider'
import Header from './components/Header'
import TaskList from './components/TaskList'
import BacklogView from './components/BacklogView'
import DailyNote from './components/DailyNote'
import DetailPanel from './components/DetailPanel'
import Terminal from './components/Terminal'
import Settings from './components/Settings'
import MeetingView from './components/MeetingView'
import CreateTask from './components/CreateTask'
import HabitsView from './components/HabitsView'
import EmailPreview from './components/EmailPreview'
import MdView from './mdpdf/MdView'
import './index.css'

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  )
}

function AppInner() {
  const { mode, setMode } = useTheme()
  const [date, setDate]             = useState(todayStr())
  const [view, setView]             = useState<'priority' | 'project'>('priority')
  const [screen, setScreen]         = useState<'main' | 'backlog' | 'habits'>('main')
  const [backlogRefresh, setBacklogRefresh] = useState(0)
  const [taskData, setTaskData]     = useState<TaskData | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [terminalMode, setTerminalMode] = useState<'closed' | 'docked' | 'fullscreen'>('closed')
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null)
  const [previewPath, setPreviewPath]   = useState<string | null>(null)
  const [mdPath, setMdPath]             = useState<string | null>(null)
  const [dailyNoteOpen, setDailyNoteOpen] = useState(false)
  const [dailyNoteFullscreen, setDailyNoteFullscreen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsFullscreen, setSettingsFullscreen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [meetingId, setMeetingId]   = useState<string | null>(null)
  const [loading, setLoading]       = useState(false)
  const [apiError, setApiError]     = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<{ status: string; version?: string; percent?: number; message?: string } | null>(null)

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

  // Background poll — 30s normally, 5s while agent jobs are running
  // Uses silent=true so TaskList stays mounted and scroll position is preserved
  useEffect(() => {
    const allTasks = Object.values(taskData ?? {}).flat().filter(t => t && typeof t === 'object' && 'id' in t) as { agent_job_status?: string }[]
    const hasActive = allTasks.some(t => t.agent_job_status === 'queued' || t.agent_job_status === 'running')
    const interval = setInterval(() => load(date, true), hasActive ? 5000 : 30_000)
    return () => clearInterval(interval)
  }, [taskData, date, load])

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
    const handler = (e: KeyboardEvent) => {
      if (e.key === '`' && e.ctrlKey) setTerminalMode(m => m === 'closed' ? 'docked' : 'closed')
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !(e.target as HTMLElement).isContentEditable) {
        setCreateOpen(true)
      }
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !(e.target as HTMLElement).isContentEditable) {
        screen === 'main' ? load(date) : setBacklogRefresh(n => n + 1)
      }
      if (e.key === 'Escape') {
        if (createOpen) { setCreateOpen(false); return }
        if (selectedId) setSelectedId(null)
        if (meetingId) setMeetingId(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedId, meetingId, createOpen])

  if (meetingId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <MeetingView taskId={meetingId} onBack={() => setMeetingId(null)} />
      </div>
    )
  }

  return (
    <ContextsProvider>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header
        date={date}
        view={view}
        screen={screen}
        onDateChange={d => { setDate(d); setSelectedId(null) }}
        onViewChange={setView}
        onScreenChange={s => { setScreen(s); setSelectedId(null) }}
        onTerminalToggle={() => setTerminalMode(m => m === 'closed' ? 'docked' : 'closed')}
        dailyNoteOpen={dailyNoteOpen}
        onDailyNoteToggle={() => setDailyNoteOpen(o => !o)}
        settingsOpen={settingsOpen}
        onSettingsToggle={() => setSettingsOpen(o => !o)}
        onNewTask={() => setCreateOpen(true)}
        onRefresh={() => screen === 'main' ? load(date) : setBacklogRefresh(n => n + 1)}
        themeMode={mode}
        onThemeModeChange={setMode}
      />

      <div className={`layout ${selectedId ? 'panel-open' : ''}`} style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
          {screen === 'habits' ? (
            <HabitsView onMutate={() => load(date, true)} />
          ) : screen === 'backlog' ? (
            <BacklogView
              refreshToken={backlogRefresh}
              selectedId={selectedId}
              onSelect={id => setSelectedId(id)}
              onMutate={() => setBacklogRefresh(n => n + 1)}
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
                  view={view}
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
          onMutate={() => screen === 'main' ? load(date, true) : setBacklogRefresh(n => n + 1)}
          onDelete={() => { setSelectedId(null); screen === 'main' ? load(date, true) : setBacklogRefresh(n => n + 1) }}
          terminalOpen={terminalMode !== 'closed'}
          onPreview={path => path.endsWith('.md') ? setMdPath(path) : setPreviewPath(path)}
        />
      </div>

      <Terminal
        mode={terminalMode}
        onClose={() => setTerminalMode('closed')}
        onToggleFullscreen={() => setTerminalMode(m => m === 'fullscreen' ? 'docked' : 'fullscreen')}
        pendingCommand={terminalCommand}
        onCommandConsumed={() => setTerminalCommand(null)}
      />

      <CreateTask
        open={createOpen}
        defaultDate={date}
        onClose={() => setCreateOpen(false)}
        onCreated={id => { screen === 'main' ? load(date) : setBacklogRefresh(n => n + 1); setSelectedId(id) }}
      />
      <Settings
        open={settingsOpen}
        fullscreen={settingsFullscreen}
        onClose={() => { setSettingsOpen(false); setSettingsFullscreen(false) }}
        onToggleFullscreen={() => setSettingsFullscreen(f => !f)}
      />
      <DailyNote
        open={dailyNoteOpen}
        fullscreen={dailyNoteFullscreen}
        onClose={() => { setDailyNoteOpen(false); setDailyNoteFullscreen(false) }}
        onToggleFullscreen={() => setDailyNoteFullscreen(f => !f)}
        date={date}
      />
      {previewPath && (
        <EmailPreview
          filePath={previewPath}
          onClose={() => setPreviewPath(null)}
          terminalOpen={terminalMode !== 'closed'}
          onTerminalToggle={() => setTerminalMode(m => m === 'closed' ? 'docked' : 'closed')}
          onChatWithDoc={async (fp) => {
            const settings = await fetchSettings().catch(() => ({} as Record<string, string>))
            const agentCmd = settings.defaultAgentCommand || 'claude --dangerously-skip-permissions'
            const dir = fp.substring(0, fp.lastIndexOf('/'))
            const name = fp.split('/').pop() ?? fp
            setTerminalCommand(`cd "${dir}" && ${agentCmd} "I want to work on ${name}"\r`)
            setTerminalMode('docked')
          }}
        />
      )}
      {mdPath && (
        <MdView
          filePath={mdPath}
          onClose={() => setMdPath(null)}
          terminalOpen={terminalMode !== 'closed'}
          onTerminalToggle={() => setTerminalMode(m => m === 'closed' ? 'docked' : 'closed')}
          onChatWithDoc={async (fp) => {
            const settings = await fetchSettings().catch(() => ({} as Record<string, string>))
            const agentCmd = settings.defaultAgentCommand || 'claude --dangerously-skip-permissions'
            const dir = fp.substring(0, fp.lastIndexOf('/'))
            const name = fp.split('/').pop() ?? fp
            setTerminalCommand(`cd "${dir}" && ${agentCmd} "I want to work on ${name}"\r`)
            setTerminalMode('docked')
          }}
        />
      )}
      <UpdateBanner status={updateStatus} onDismiss={() => setUpdateStatus(null)} />
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
      left: 0,
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
