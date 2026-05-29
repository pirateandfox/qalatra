import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { api, searchTasks, type TaskData } from '../api'
import type { Task } from '../types/task'
import { useContexts } from '../lib/ContextsProvider'
import TaskRow from './TaskRow'
import TaskSection from './TaskSection'
import EventCard from './EventCard'
import HabitInlineRow from './HabitInlineRow'
import './TaskList.css'

interface Props {
  data: TaskData
  view: 'priority' | 'project'
  selectedId?: string | null
  onSelect: (id: string) => void
  onMeetingOpen: (id: string) => void
  onMutate: () => void
}

type SearchMode = 'current' | 'all'
type TaskArrayKey = 'inbox' | 'overdue' | 'dueToday' | 'active' | 'wakingUp' | 'doneToday' | 'scheduled' | 'timeSnoozed' | 'completed' | 'wasDue' | 'events' | 'reminders'

const TASK_ARRAY_KEYS: TaskArrayKey[] = [
  'inbox', 'overdue', 'dueToday', 'active', 'wakingUp', 'doneToday',
  'scheduled', 'timeSnoozed', 'completed', 'wasDue', 'events', 'reminders',
]

const STATUS_LABELS: Record<Task['status'], string> = {
  active: 'Active',
  backlog: 'Backlog',
  snoozed: 'Snoozed',
  done: 'Done',
  archived: 'Archived',
}

function normalizedText(value: unknown) {
  return String(value ?? '').toLowerCase()
}

function taskMatches(task: Task, query: string) {
  const q = query.toLowerCase()
  const subtasks = (task as Task & { subtasks?: Task[] }).subtasks ?? []
  const values = [
    task.title,
    task.description,
    task.notes,
    task.ai_context,
    task.context,
    task.project,
    task.tags,
    task.source,
    task.source_url,
    task.due_date,
    task.status,
    task.task_type,
    task.energy_required,
    task.my_priority ? `p${task.my_priority}` : '',
    ...subtasks.map(s => s.title),
  ]
  return values.some(value => normalizedText(value).includes(q))
}

function habitMatches(habit: NonNullable<TaskData['habits']>[number], query: string) {
  const q = query.toLowerCase()
  return [habit.title, habit.description, habit.recurrence].some(value => normalizedText(value).includes(q))
}

function filterTaskData(data: TaskData, query: string): TaskData {
  if (!query.trim()) return data
  const next: TaskData = { ...data }
  const mutable = next as TaskData & Partial<Record<TaskArrayKey, Task[]>>
  for (const key of TASK_ARRAY_KEYS) {
    const tasks = data[key]
    if (tasks) mutable[key] = tasks.filter(task => taskMatches(task, query))
  }
  if (data.habits) next.habits = data.habits.filter(habit => habitMatches(habit, query))
  return next
}

function countTaskData(data: TaskData) {
  let count = 0
  for (const key of TASK_ARRAY_KEYS) count += data[key]?.length ?? 0
  count += data.habits?.length ?? 0
  return count
}

function SearchToolbar({
  query,
  mode,
  currentCount,
  allCount,
  allLoading,
  onQueryChange,
  onModeChange,
}: {
  query: string
  mode: SearchMode
  currentCount: number | null
  allCount: number | null
  allLoading: boolean
  onQueryChange: (query: string) => void
  onModeChange: (mode: SearchMode) => void
}) {
  const hasQuery = query.trim().length > 0
  return (
    <div className="task-search-bar">
      <input
        data-task-search-input
        className="task-search-input"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        placeholder="Search this screen..."
        aria-label="Search tasks"
      />
      {hasQuery && (
        <button className="task-search-clear" onClick={() => onQueryChange('')} title="Clear search">
          Clear
        </button>
      )}
      <button
        className={`task-search-scope ${mode === 'current' ? 'active' : ''}`}
        onClick={() => onModeChange('current')}
        disabled={!hasQuery}
      >
        This screen{hasQuery && currentCount !== null ? ` (${currentCount})` : ''}
      </button>
      <button
        className={`task-search-scope ${mode === 'all' ? 'active' : ''}`}
        onClick={() => onModeChange('all')}
        disabled={!hasQuery}
      >
        {allLoading ? 'Searching...' : `Search all${allCount !== null ? ` (${allCount})` : ''}`}
      </button>
    </div>
  )
}

function AllSearchResults({ tasks, selectedId, onSelect, onMutate }: {
  tasks: Task[]
  selectedId?: string | null
  onSelect: (id: string) => void
  onMutate: () => void
}) {
  const byStatus: Record<Task['status'], Task[]> = {
    active: [],
    backlog: [],
    snoozed: [],
    done: [],
    archived: [],
  }
  for (const task of tasks) byStatus[task.status]?.push(task)
  return (
    <>
      {tasks.length === 0 && <div className="empty-state">No matching tasks.</div>}
      {(Object.keys(byStatus) as Task['status'][]).map(status => {
        const group = byStatus[status]
        if (!group.length) return null
        return (
          <TaskSection
            key={status}
            title={STATUS_LABELS[status]}
            icon=""
            tasks={group}
            selectedId={selectedId}
            onSelect={onSelect}
            onMutate={onMutate}
          />
        )
      })}
    </>
  )
}

function ReminderRow({ task, onSelect, onMutate }: { task: Task; onSelect: (id: string) => void; onMutate: () => void }) {
  async function dismiss() {
    await api.deleteTask(task.id)
    onMutate()
  }
  return (
    <div className="reminder-row">
      <span className="reminder-icon">🔔</span>
      <span className="reminder-title" onClick={() => onSelect(task.id)}>{task.title}</span>
      <button className="dismiss-btn" style={{ marginLeft: 'auto' }} onClick={dismiss}>Dismiss</button>
    </div>
  )
}

function FutureView({ data, selectedId, onSelect, onMeetingOpen, onMutate }: Omit<Props, 'view'>) {
  const [showSnoozed, setShowSnoozed] = useState(false)
  const snoozedCount = data.timeSnoozed?.length ?? 0
  return (
    <>
      {(data.events?.length ?? 0) > 0 && (
        <section className="task-section">
          <h2>📅 Events <span className="count">{data.events!.length}</span></h2>
          {data.events!.map(e => <EventCard key={e.id} event={e} onSelect={onSelect} onMeetingOpen={onMeetingOpen} />)}
        </section>
      )}
      <TaskSection title="Scheduled" icon="📅" tasks={data.scheduled ?? []} draggable selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      {snoozedCount > 0 && (
        <>
          <button
            className="time-snoozed-toggle"
            onClick={() => setShowSnoozed(s => !s)}
          >
            {showSnoozed ? '▾' : '▸'} {snoozedCount} time-deferred task{snoozedCount !== 1 ? 's' : ''}
          </button>
          {showSnoozed && (
            <TaskSection title="" icon="" tasks={data.timeSnoozed ?? []} selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
          )}
        </>
      )}
      {!data.scheduled?.length && !data.events?.length && snoozedCount === 0 && <div className="empty-state">Nothing scheduled for this date.</div>}
    </>
  )
}

function DeferredSection({ title, icon, count, storageKey, defaultOpen = false, children }: {
  title: string; icon: string; count: number; storageKey: string; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem(storageKey)
    return stored !== null ? stored === 'true' : defaultOpen
  })
  if (count === 0) return null
  function toggle() {
    setOpen(o => {
      localStorage.setItem(storageKey, String(!o))
      return !o
    })
  }
  return (
    <div className="deferred-section">
      <button className="deferred-toggle" onClick={toggle}>
        <span className="deferred-arrow">{open ? '▾' : '▸'}</span>
        {icon} {title} <span className="count">{count}</span>
      </button>
      {open && <div className="deferred-body">{children}</div>}
    </div>
  )
}

function PriorityView({ data, selectedId, onSelect, onMeetingOpen, onMutate }: Omit<Props, 'view'>) {
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('current')
  const [allResults, setAllResults] = useState<Task[] | null>(null)
  const [allLoading, setAllLoading] = useState(false)
  const [allError, setAllError] = useState<string | null>(null)
  const trimmedQuery = query.trim()
  const filteredData = useMemo(
    () => trimmedQuery ? filterTaskData(data, trimmedQuery) : data,
    [data, trimmedQuery],
  )
  const currentMatchCount = trimmedQuery ? countTaskData(filteredData) : null
  const activeData = searchMode === 'current' ? filteredData : data

  useEffect(() => {
    if (!trimmedQuery) {
      setSearchMode('current')
      setAllResults(null)
      setAllError(null)
      return
    }
    if (searchMode !== 'all') return
    let cancelled = false
    setAllLoading(true)
    setAllError(null)
    const handle = window.setTimeout(() => {
      searchTasks(trimmedQuery, 'all', 100)
        .then(tasks => { if (!cancelled) setAllResults(tasks) })
        .catch(err => { if (!cancelled) setAllError(err?.message ?? String(err)) })
        .finally(() => { if (!cancelled) setAllLoading(false) })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [trimmedQuery, searchMode])

  const searchToolbar = (
    <SearchToolbar
      query={query}
      mode={searchMode}
      currentCount={currentMatchCount}
      allCount={allResults?.length ?? null}
      allLoading={allLoading}
      onQueryChange={next => {
        setQuery(next)
        if (!next.trim()) setSearchMode('current')
        else if (searchMode === 'all') setAllResults(null)
      }}
      onModeChange={mode => setSearchMode(mode)}
    />
  )

  if (searchMode === 'all' && trimmedQuery) {
    return (
      <>
        {searchToolbar}
        {allError && <div className="task-search-error">Search failed: {allError}</div>}
        {!allError && allLoading && allResults === null && <div className="empty-state">Searching all tasks...</div>}
        {!allError && allResults !== null && (
          <AllSearchResults tasks={allResults} selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
        )}
      </>
    )
  }

  const allRaw = [...(activeData.overdue ?? []), ...(activeData.dueToday ?? []), ...(activeData.active ?? [])]
  // Scheduled = autorun tasks that haven't fired yet (no agent job)
  const scheduledTasks = allRaw.filter(t => t.agent_autorun === 1 && !t.agent_job_status)
  const scheduledIds = new Set(scheduledTasks.map(t => t.id))
  // Coding tasks live in the Code view, not Priority
  const allTasks = allRaw.filter(t => !scheduledIds.has(t.id) && t.task_type !== 'coding')
  const waitingTasks = allTasks.filter(t => !!t.blocked)
  const actionableTasks = allTasks.filter(t => !t.blocked)
  const noCurrentMatches = !!trimmedQuery && currentMatchCount === 0

  async function clearInbox(id: string) {
    await api.clearInbox(id)
    onMutate()
  }

  if (activeData.view === 'today') return (
    <>
      {searchToolbar}
      <DeferredSection title="Inbox" icon="📥" count={activeData.inbox?.length ?? 0} storageKey="section-inbox" defaultOpen>
        {(activeData.inbox ?? []).map(t => (
          <TaskRow key={t.id} task={t} selected={selectedId === t.id} onSelect={onSelect} onMutate={onMutate} onClearInbox={() => clearInbox(t.id)} />
        ))}
      </DeferredSection>
      {(activeData.events?.length ?? 0) > 0 && (
        <section className="task-section">
          <h2>📅 Events <span className="count">{activeData.events!.length}</span></h2>
          {activeData.events!.map(e => <EventCard key={e.id} event={e} onSelect={onSelect} onMeetingOpen={onMeetingOpen} />)}
        </section>
      )}
      {(activeData.reminders?.length ?? 0) > 0 && (
        <section className="task-section">
          <h2>🔔 Reminders <span className="count">{activeData.reminders!.length}</span></h2>
          {activeData.reminders!.map(r => <ReminderRow key={r.id} task={r} onSelect={onSelect} onMutate={onMutate} />)}
        </section>
      )}
      {(activeData.habits?.length ?? 0) > 0 && (
        <section className="task-section">
          <h2>🌱 Habits <span className="count">{activeData.habits!.length}</span></h2>
          {activeData.habits!.map(h => <HabitInlineRow key={h.id} habit={h} onMutate={onMutate} />)}
        </section>
      )}
      {actionableTasks.length > 0 && (
        <TaskSection title="Tasks" icon="📋" tasks={actionableTasks} draggable groupKey="priority" selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      )}
      <DeferredSection title="Waiting" icon="⏸" count={waitingTasks.length} storageKey="section-waiting">
        <TaskSection title="" icon="" tasks={waitingTasks} hideHeader selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      </DeferredSection>
      <DeferredSection title="Snoozed" icon="💤" count={activeData.timeSnoozed?.length ?? 0} storageKey="section-snoozed">
        <TaskSection title="" icon="" tasks={activeData.timeSnoozed ?? []} hideHeader selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      </DeferredSection>
      <DeferredSection title="Scheduled" icon="🤖" count={scheduledTasks.length} storageKey="section-scheduled">
        <TaskSection title="" icon="" tasks={scheduledTasks} hideHeader selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      </DeferredSection>
      <TaskSection title="Done Today" icon="✅" tasks={activeData.doneToday ?? []} selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      {noCurrentMatches && <div className="empty-state">No matches on this screen.</div>}
      {!noCurrentMatches && allTasks.length === 0 && scheduledTasks.length === 0 && !activeData.events?.length && <div className="empty-state">Nothing to show for today.</div>}
    </>
  )

  if (activeData.view === 'future') return (
    <>
      {searchToolbar}
      {noCurrentMatches
        ? <div className="empty-state">No matches on this screen.</div>
        : <FutureView data={activeData} selectedId={selectedId} onSelect={onSelect} onMeetingOpen={onMeetingOpen} onMutate={onMutate} />
      }
    </>
  )

  return (
    <>
      {searchToolbar}
      {(activeData.events?.length ?? 0) > 0 && (
        <section className="task-section">
          <h2>📅 Events <span className="count">{activeData.events!.length}</span></h2>
          {activeData.events!.map(e => <EventCard key={e.id} event={e} onSelect={onSelect} onMeetingOpen={onMeetingOpen} />)}
        </section>
      )}
      <TaskSection title="Completed" icon="✅" tasks={activeData.completed ?? []} selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      <TaskSection title="Was Due" icon="📅" tasks={activeData.wasDue ?? []} selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      {noCurrentMatches && <div className="empty-state">No matches on this screen.</div>}
      {!noCurrentMatches && !activeData.events?.length && !activeData.completed?.length && !activeData.wasDue?.length && <div className="empty-state">No records for this date.</div>}
    </>
  )
}

function ProjectView({ data, selectedId, onSelect, onMutate }: Omit<Props, 'view' | 'onMeetingOpen'>) {
  const { getColor, getLabel } = useContexts()
  let tasks: Task[] = []
  if (data.view === 'today') tasks = [...(data.overdue ?? []), ...(data.dueToday ?? []), ...(data.active ?? [])]
  else if (data.view === 'future') tasks = data.scheduled ?? []
  else tasks = data.wasDue ?? []

  // Group: context -> project|_none -> tasks
  const byContext: Record<string, Record<string, Task[]>> = {}
  for (const t of tasks) {
    if (!byContext[t.context]) byContext[t.context] = {}
    const proj = t.project ?? '_none'
    if (!byContext[t.context][proj]) byContext[t.context][proj] = []
    byContext[t.context][proj].push(t)
  }

  return (
    <>
      {data.view === 'today' && (data.habits?.length ?? 0) > 0 && (
        <section className="task-section">
          <h2>🌱 Habits <span className="count">{data.habits!.length}</span></h2>
          {data.habits!.map(h => <HabitInlineRow key={h.id} habit={h} onMutate={onMutate} />)}
        </section>
      )}
      {Object.keys(byContext).length === 0 && <div className="empty-state">Nothing to show for this date.</div>}
      {Object.entries(byContext).map(([ctx, projects]) => {
        const color = getColor(ctx)
        const ctxLabel = getLabel(ctx)
        const ctxTotal = Object.values(projects).reduce((n, ts) => n + ts.length, 0)

        return (
          <section key={ctx} className="task-section context-section" style={{ borderLeft: `3px solid ${color}`, paddingLeft: 12 }}>
            <h2 style={{ color, fontSize: 13, textTransform: 'none', letterSpacing: 0 }}>
              {ctxLabel} <span className="count">{ctxTotal}</span>
            </h2>
            {Object.entries(projects).map(([proj, projTasks]) => {
              const groupKey = `proj:${ctx}:${proj}`
              if (proj === '_none') return (
                <div key={proj} data-group={groupKey}>
                  {projTasks.map(t => (
                    <TaskRow key={t.id} task={t} draggable showContext={false} selected={selectedId === t.id} onSelect={onSelect} onMutate={onMutate} />
                  ))}
                </div>
              )
              return (
                <div key={proj} className="project-group">
                  <div className="project-subheader">
                    <span className="project-name">{proj}</span>
                    <span className="ctx-count">{projTasks.length}</span>
                  </div>
                  <div data-group={groupKey}>
                    {projTasks.map(t => (
                      <TaskRow key={t.id} task={t} draggable showContext={false} selected={selectedId === t.id} onSelect={onSelect} onMutate={onMutate} />
                    ))}
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}
      {data.view === 'today' && (
        <TaskSection title="Done Today" icon="✅" tasks={data.doneToday ?? []} selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      )}
      {data.view === 'past' && (
        <TaskSection title="Completed" icon="✅" tasks={data.completed ?? []} selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      )}
    </>
  )
}

export default function TaskList(props: Props) {
  return (
    <div className="task-list-container">
      {props.view === 'priority'
        ? <PriorityView {...props} />
        : <ProjectView {...props} />
      }
    </div>
  )
}
