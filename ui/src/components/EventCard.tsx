import type { Task } from '../types/task'
import { fmtTime } from '../lib/constants'
import { useContexts } from '../lib/ContextsProvider'
import './EventCard.css'

interface Props {
  event: Task
  onSelect: (id: string) => void
  onMeetingOpen: (id: string) => void
}

export default function EventCard({ event, onSelect, onMeetingOpen }: Props) {
  const { getColor, getLabel } = useContexts()
  const color = getColor(event.context)
  const subtasks: Task[] = (event as any).subtasks ?? []
  const done = subtasks.filter(s => s.status === 'done').length
  const pct = subtasks.length ? Math.round(done / subtasks.length * 100) : 0
  const timeStr = fmtTime(event.event_time)

  return (
    <div className="event-card" style={{ borderLeft: `3px solid ${color}` }} data-id={event.id}>
      <div className="event-card-top">
        <div className="event-time">{timeStr}</div>
        <div className="event-body">
          <span className="event-title" onClick={() => onSelect(event.id)}>{event.title}</span>
          <div className="event-meta">
            <span className="badge" style={{
              background: `${color}20`, color, border: `1px solid ${color}40`
            }}>
              {getLabel(event.context)}
            </span>
            {event.project && <span className="project">{event.project}</span>}
            {subtasks.length > 0 && (
              <span className="event-agenda-count">{done}/{subtasks.length} items</span>
            )}
            {event.notes && <span className="has-notes" title="Has notes">●</span>}
          </div>
        </div>
        <button className="meeting-btn" onClick={() => onMeetingOpen(event.id)}>▶ Meeting</button>
      </div>
      {subtasks.length > 0 && (
        <div className="event-progress">
          <div className="event-progress-fill" style={{ width: `${pct}%`, background: color }} />
        </div>
      )}
    </div>
  )
}
