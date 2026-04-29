import { useState } from 'react'
import type React from 'react'
import { api, type TaskData } from '../api'
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
  const allRaw = [...(data.overdue ?? []), ...(data.dueToday ?? []), ...(data.active ?? [])]
  // Scheduled = autorun tasks that haven't fired yet (no agent job)
  const scheduledTasks = allRaw.filter(t => t.agent_autorun === 1 && !t.agent_job_status)
  const scheduledIds = new Set(scheduledTasks.map(t => t.id))
  const allTasks = allRaw.filter(t => !scheduledIds.has(t.id))

  async function clearInbox(id: string) {
    await api.clearInbox(id)
    onMutate()
  }

  if (data.view === 'today') return (
    <>
      <DeferredSection title="Inbox" icon="📥" count={data.inbox?.length ?? 0} storageKey="section-inbox" defaultOpen>
        {(data.inbox ?? []).map(t => (
          <TaskRow key={t.id} task={t} selected={selectedId === t.id} onSelect={onSelect} onMutate={onMutate} onClearInbox={() => clearInbox(t.id)} />
        ))}
      </DeferredSection>
      {(data.events?.length ?? 0) > 0 && (
        <section className="task-section">
          <h2>📅 Events <span className="count">{data.events!.length}</span></h2>
          {data.events!.map(e => <EventCard key={e.id} event={e} onSelect={onSelect} onMeetingOpen={onMeetingOpen} />)}
        </section>
      )}
      {(data.reminders?.length ?? 0) > 0 && (
        <section className="task-section">
          <h2>🔔 Reminders <span className="count">{data.reminders!.length}</span></h2>
          {data.reminders!.map(r => <ReminderRow key={r.id} task={r} onSelect={onSelect} onMutate={onMutate} />)}
        </section>
      )}
      {(data.habits?.length ?? 0) > 0 && (
        <section className="task-section">
          <h2>🌱 Habits <span className="count">{data.habits!.length}</span></h2>
          {data.habits!.map(h => <HabitInlineRow key={h.id} habit={h} onMutate={onMutate} />)}
        </section>
      )}
      {allTasks.length > 0 && (
        <TaskSection title="Tasks" icon="📋" tasks={allTasks} draggable groupKey="priority" selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      )}
      <DeferredSection title="Snoozed" icon="💤" count={data.timeSnoozed?.length ?? 0} storageKey="section-snoozed">
        <TaskSection title="" icon="" tasks={data.timeSnoozed ?? []} hideHeader selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      </DeferredSection>
      <DeferredSection title="Scheduled" icon="🤖" count={scheduledTasks.length} storageKey="section-scheduled">
        <TaskSection title="" icon="" tasks={scheduledTasks} hideHeader selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      </DeferredSection>
      <TaskSection title="Done Today" icon="✅" tasks={data.doneToday ?? []} selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      {allTasks.length === 0 && scheduledTasks.length === 0 && !data.events?.length && <div className="empty-state">Nothing to show for today.</div>}
    </>
  )

  if (data.view === 'future') return (
    <FutureView data={data} selectedId={selectedId} onSelect={onSelect} onMeetingOpen={onMeetingOpen} onMutate={onMutate} />
  )

  return (
    <>
      {(data.events?.length ?? 0) > 0 && (
        <section className="task-section">
          <h2>📅 Events <span className="count">{data.events!.length}</span></h2>
          {data.events!.map(e => <EventCard key={e.id} event={e} onSelect={onSelect} onMeetingOpen={onMeetingOpen} />)}
        </section>
      )}
      <TaskSection title="Completed" icon="✅" tasks={data.completed ?? []} selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      <TaskSection title="Was Due" icon="📅" tasks={data.wasDue ?? []} selectedId={selectedId} onSelect={onSelect} onMutate={onMutate} />
      {!data.events?.length && !data.completed?.length && !data.wasDue?.length && <div className="empty-state">No records for this date.</div>}
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
