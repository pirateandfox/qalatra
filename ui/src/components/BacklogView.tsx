import { useState, useEffect, useCallback } from 'react'
import { fetchBacklog } from '../api'
import type { Task } from '../types/task'
import { useContexts } from '../lib/ContextsProvider'
import TaskRow from './TaskRow'
import './TaskList.css'
import './BacklogView.css'

interface Props {
  refreshToken?: number
  selectedId?: string | null
  onSelect: (id: string) => void
  onMutate: () => void
}

export default function BacklogView({ refreshToken, selectedId, onSelect, onMutate }: Props) {
  const { getColor, getLabel } = useContexts()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchBacklog()
      setTasks(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, refreshToken])

  function handleMutate() {
    load()
    onMutate()
  }

  // Group: context -> project|_none -> tasks
  const byContext: Record<string, Record<string, Task[]>> = {}
  for (const t of tasks) {
    if (!byContext[t.context]) byContext[t.context] = {}
    const proj = t.project ?? '_none'
    if (!byContext[t.context][proj]) byContext[t.context][proj] = []
    byContext[t.context][proj].push(t)
  }

  if (loading) return (
    <div className="task-list-container">
      <div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center' }}>Loading…</div>
    </div>
  )

  return (
    <div className="task-list-container backlog-view">
      {tasks.length === 0 && (
        <div className="empty-state">Backlog is empty.</div>
      )}
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
              if (proj === '_none') return (
                <div key={proj}>
                  {projTasks.map(t => (
                    <TaskRow key={t.id} task={t} showContext={false} selected={selectedId === t.id} onSelect={onSelect} onMutate={handleMutate} />
                  ))}
                </div>
              )
              return (
                <div key={proj} className="project-group">
                  <div className="project-subheader">
                    <span className="project-name">{proj}</span>
                    <span className="ctx-count">{projTasks.length}</span>
                  </div>
                  <div>
                    {projTasks.map(t => (
                      <TaskRow key={t.id} task={t} showContext={false} selected={selectedId === t.id} onSelect={onSelect} onMutate={handleMutate} />
                    ))}
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
