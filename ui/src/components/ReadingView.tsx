import { useState, useEffect, useCallback } from 'react'
import { fetchReadingTasks } from '../api'
import type { Task } from '../types/task'
import TaskRow from './TaskRow'
import './TaskList.css'

interface Props {
  selectedId: string | null
  onSelect: (id: string) => void
  onMutate: () => void
  refreshToken?: number
}

export default function ReadingView({ selectedId, onSelect, onMutate, refreshToken }: Props) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const data = await fetchReadingTasks()
      setTasks(data)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (refreshToken) load(true) }, [refreshToken, load])

  if (loading) return <div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center' }}>Loading…</div>

  if (!tasks.length) return (
    <div className="task-list-container">
      <div className="empty-state">No reading tasks. Mark a task as Reading in the detail panel to add it here.</div>
    </div>
  )

  return (
    <div className="task-list-container">
      <section className="task-section">
        <h2>📖 To Read <span className="count">{tasks.length}</span></h2>
        {tasks.map(t => (
          <TaskRow
            key={t.id}
            task={t}
            selected={selectedId === t.id}
            onSelect={onSelect}
            onMutate={() => { load(true); onMutate() }}
          />
        ))}
      </section>
    </div>
  )
}
