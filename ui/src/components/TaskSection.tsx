import type { Task } from '../types/task'
import TaskRow from './TaskRow'
import { api } from '../api'
import './TaskSection.css'

interface Props {
  title: string
  icon: string
  tasks: Task[]
  draggable?: boolean
  showContext?: boolean
  groupKey?: string
  hideHeader?: boolean
  selectedId?: string | null
  onSelect: (id: string) => void
  onMutate: () => void
}

export default function TaskSection({ title, icon, tasks, draggable, showContext = true, groupKey, hideHeader, selectedId, onSelect, onMutate }: Props) {
  if (!tasks.length) return null

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault()
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const row = (e.target as HTMLElement).closest('.task-row') as HTMLElement | null
    document.querySelectorAll('.task-row').forEach(r => r.classList.remove('drop-before', 'drop-after'))
    if (!row) return
    const rect = row.getBoundingClientRect()
    row.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after')
  }

  function handleDragLeave(e: React.DragEvent) {
    const container = (e.currentTarget as HTMLElement)
    if (!container.contains(e.relatedTarget as Node)) {
      document.querySelectorAll('.task-row').forEach(r => r.classList.remove('drop-before', 'drop-after'))
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    document.querySelectorAll('.task-row').forEach(r => r.classList.remove('drop-before', 'drop-after'))
    const dragId = e.dataTransfer.getData('text/plain')
    if (!dragId) return

    // Find which row we're dropping onto — fall back to nearest row if between rows
    const container = e.currentTarget as HTMLElement
    const rows = [...container.querySelectorAll('.task-row[draggable="true"]')] as HTMLElement[]
    if (rows.length < 2) return

    let dropRow = (e.target as HTMLElement).closest('.task-row') as HTMLElement | null
    if (!dropRow) {
      // dropped between rows — find nearest by y position
      let closest: HTMLElement | null = null
      let closestDist = Infinity
      for (const r of rows) {
        const rect = r.getBoundingClientRect()
        const mid = rect.top + rect.height / 2
        const dist = Math.abs(e.clientY - mid)
        if (dist < closestDist) { closestDist = dist; closest = r }
      }
      dropRow = closest
    }
    if (!dropRow || dropRow.dataset.id === dragId) return

    const dragIdx = rows.findIndex(r => r.dataset.id === dragId)
    const dropIdx = rows.findIndex(r => r.dataset.id === dropRow!.dataset.id)
    if (dragIdx === -1 || dropIdx === -1) return

    const rect = dropRow.getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    const newRows = [...rows]
    const [dragRow] = newRows.splice(dragIdx, 1)
    const insertAt = before ? dropIdx - (dragIdx < dropIdx ? 1 : 0) : dropIdx + (dragIdx > dropIdx ? 1 : 0)
    newRows.splice(Math.max(0, insertAt), 0, dragRow)

    const ids = newRows.map(r => r.dataset.id!).filter(Boolean)
    await api.reorder(ids)
    onMutate()
  }

  return (
    <section className="task-section">
      {!hideHeader && <h2>{icon} {title} <span className="count">{tasks.length}</span></h2>}
      <div
        data-group={groupKey ?? title}
        onDragEnter={draggable ? handleDragEnter : undefined}
        onDragOver={draggable ? handleDragOver : undefined}
        onDragLeave={draggable ? handleDragLeave : undefined}
        onDrop={draggable ? handleDrop : undefined}
      >
        {tasks.map(t => (
          <TaskRow
            key={t.id}
            task={t}
            draggable={draggable}
            showContext={showContext}
            selected={selectedId === t.id}
            onSelect={onSelect}
            onMutate={onMutate}
          />
        ))}
      </div>
    </section>
  )
}
