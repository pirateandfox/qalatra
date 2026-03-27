import { useState, useEffect, useCallback } from 'react'
import { fetchTasks, fetchSettings, type TaskData } from './api'
import { today as todayStr } from './lib/constants'
import { ContextsProvider } from './lib/ContextsProvider'
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
  const [date, setDate]             = useState(todayStr())
  const [view, setView]             = useState<'priority' | 'project'>('priority')
  const [screen, setScreen]         = useState<'main' | 'backlog' | 'habits'>('main')
  const [backlogRefresh, setBacklogRefresh] = useState(0)
  const [taskData, setTaskData]     = useState<TaskData | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null)
  const [previewPath, setPreviewPath]   = useState<string | null>(null)
  const [mdPath, setMdPath]             = useState<string | null>(null)
  const [dailyNoteOpen, setDailyNoteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [meetingId, setMeetingId]   = useState<string | null>(null)
  const [loading, setLoading]       = useState(false)

  const load = useCallback(async (d: string) => {
    setLoading(true)
    try {
      const data = await fetchTasks(d)
      setTaskData(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(date) }, [date, load])

  // Background poll — 30s normally, 5s while agent jobs are running
  useEffect(() => {
    const allTasks = Object.values(taskData ?? {}).flat().filter(t => t && typeof t === 'object' && 'id' in t) as { agent_job_status?: string }[]
    const hasActive = allTasks.some(t => t.agent_job_status === 'queued' || t.agent_job_status === 'running')
    const interval = setInterval(() => load(date), hasActive ? 5000 : 30_000)
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

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '`' && e.ctrlKey) setTerminalOpen(o => !o)
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
        onTerminalToggle={() => setTerminalOpen(o => !o)}
        dailyNoteOpen={dailyNoteOpen}
        onDailyNoteToggle={() => setDailyNoteOpen(o => !o)}
        settingsOpen={settingsOpen}
        onSettingsToggle={() => setSettingsOpen(o => !o)}
        onNewTask={() => setCreateOpen(true)}
        onRefresh={() => screen === 'main' ? load(date) : setBacklogRefresh(n => n + 1)}
      />

      <div className={`layout ${selectedId ? 'panel-open' : ''}`} style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ flex: 1, overflowY: 'auto', minWidth: 0, paddingBottom: terminalOpen ? 300 : 0 }}>
          {screen === 'habits' ? (
            <HabitsView onMutate={() => load(date)} />
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
              {!loading && taskData && (
                <>
                  <TaskList
                    data={taskData}
                    view={view}
                    selectedId={selectedId}
                    onSelect={id => setSelectedId(id)}
                    onMeetingOpen={id => setMeetingId(id)}
                    onMutate={() => load(date)}
                  />
                </>
              )}
            </>
          )}
        </div>

        <DetailPanel
          taskId={selectedId}
          onClose={() => setSelectedId(null)}
          onMutate={() => screen === 'main' ? load(date) : setBacklogRefresh(n => n + 1)}
          onDelete={() => { setSelectedId(null); screen === 'main' ? load(date) : setBacklogRefresh(n => n + 1) }}
          terminalOpen={terminalOpen}
          onPreview={path => path.endsWith('.md') ? setMdPath(path) : setPreviewPath(path)}
        />
      </div>

      <CreateTask
        open={createOpen}
        defaultDate={date}
        onClose={() => setCreateOpen(false)}
        onCreated={id => { screen === 'main' ? load(date) : setBacklogRefresh(n => n + 1); setSelectedId(id) }}
      />
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <DailyNote
        open={dailyNoteOpen}
        onClose={() => setDailyNoteOpen(false)}
        date={date}
      />
      <Terminal
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        pendingCommand={terminalCommand}
        onCommandConsumed={() => setTerminalCommand(null)}
      />
      {previewPath && (
        <EmailPreview
          filePath={previewPath}
          onClose={() => setPreviewPath(null)}
          terminalOpen={terminalOpen}
          onTerminalToggle={() => setTerminalOpen(o => !o)}
          onChatWithDoc={async (fp) => {
            const settings = await fetchSettings().catch(() => ({} as Record<string, string>))
            const agentCmd = settings.defaultAgentCommand || 'claude'
            const dir = fp.substring(0, fp.lastIndexOf('/'))
            const name = fp.split('/').pop() ?? fp
            setTerminalCommand(`cd "${dir}" && ${agentCmd} "I want to work on ${name}"\r`)
            setTerminalOpen(true)
          }}
        />
      )}
      {mdPath && (
        <MdView
          filePath={mdPath}
          onClose={() => setMdPath(null)}
          terminalOpen={terminalOpen}
          onTerminalToggle={() => setTerminalOpen(o => !o)}
          onChatWithDoc={async (fp) => {
            const settings = await fetchSettings().catch(() => ({} as Record<string, string>))
            const agentCmd = settings.defaultAgentCommand || 'claude'
            const dir = fp.substring(0, fp.lastIndexOf('/'))
            const name = fp.split('/').pop() ?? fp
            setTerminalCommand(`cd "${dir}" && ${agentCmd} "I want to work on ${name}"\r`)
            setTerminalOpen(true)
          }}
        />
      )}
    </div>
    </ContextsProvider>
  )
}
