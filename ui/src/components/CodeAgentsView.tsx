import { useState, useEffect, useCallback } from 'react'
import { fetchCodingTasks } from '../api'
import type { Task } from '../types/task'
import TaskRow from './TaskRow'
import './TaskList.css'

interface Props {
  selectedId: string | null
  onSelect: (id: string) => void
  onMutate: () => void
  refreshToken?: number
}

export default function CodeAgentsView({ selectedId, onSelect, onMutate, refreshToken }: Props) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const data = await fetchCodingTasks()
      setTasks(data)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (refreshToken) load(true) }, [refreshToken, load])

  useEffect(() => {
    const hasActive = tasks.some(t => t.agent_job_status === 'queued' || t.agent_job_status === 'running')
    const interval = setInterval(() => load(true), hasActive ? 5000 : 30_000)
    return () => clearInterval(interval)
  }, [tasks, load])

  const running = tasks.filter(t => t.agent_job_status === 'running')
  const queued  = tasks.filter(t => t.agent_job_status === 'queued')
  const idle    = tasks.filter(t => t.agent_job_status !== 'running' && t.agent_job_status !== 'queued')

  if (loading) return <div style={{ color: 'var(--muted)', padding: '40px', textAlign: 'center' }}>Loading…</div>

  if (!tasks.length) return (
    <div className="task-list-container">
      <div className="empty-state">No coding tasks.</div>
    </div>
  )

  return (
    <div className="task-list-container">
      {running.length > 0 && (
        <section className="task-section">
          <h2>⚙ Running <span className="count">{running.length}</span></h2>
          {running.map(t => (
            <TaskRow key={t.id} task={t} selected={selectedId === t.id} onSelect={onSelect} onMutate={() => { load(true); onMutate() }} />
          ))}
        </section>
      )}
      {queued.length > 0 && (
        <section className="task-section">
          <h2>⏳ Queued <span className="count">{queued.length}</span></h2>
          {queued.map(t => (
            <TaskRow key={t.id} task={t} selected={selectedId === t.id} onSelect={onSelect} onMutate={() => { load(true); onMutate() }} />
          ))}
        </section>
      )}
      {idle.length > 0 && (
        <section className="task-section">
          <h2>⌨ Idle <span className="count">{idle.length}</span></h2>
          {idle.map(t => (
            <TaskRow key={t.id} task={t} selected={selectedId === t.id} onSelect={onSelect} onMutate={() => { load(true); onMutate() }} />
          ))}
        </section>
      )}
    </div>
  )
}
