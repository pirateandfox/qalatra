import { useState } from 'react'
import './HabitRow.css'

interface HabitLog {
  status: 'done' | 'skipped'
  notes: string | null
}

interface WeekDay {
  date: string
  due: boolean
  log: HabitLog | null
}

interface Habit {
  id: string
  title: string
  description: string | null
  recurrence: string
  today_log: HabitLog | null
  week: WeekDay[]
}

interface Props {
  habit: Habit
  today: string
  onMutate: () => void
}

async function apiLog(habit_id: string, date: string, status: 'done' | 'skipped', notes: string | null) {
  await fetch('/api/habits/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ habit_id, date, status, notes }),
  })
}

async function apiUnlog(habit_id: string, date: string) {
  await fetch('/api/habits/unlog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ habit_id, date }),
  })
}

export default function HabitRow({ habit, today, onMutate }: Props) {
  const log = habit.today_log
  const isDone    = log?.status === 'done'
  const isSkipped = log?.status === 'skipped'
  const [notesOpen, setNotesOpen] = useState(false)
  const [notes, setNotes] = useState(log?.notes ?? '')

  async function handleDone() {
    if (isDone) {
      await apiUnlog(habit.id, today)
    } else {
      await apiLog(habit.id, today, 'done', notes || null)
      setNotesOpen(true)
    }
    onMutate()
  }

  async function handleSkip() {
    if (isSkipped) {
      await apiUnlog(habit.id, today)
    } else {
      await apiLog(habit.id, today, 'skipped', null)
      setNotesOpen(false)
    }
    onMutate()
  }

  async function saveNotes() {
    await apiLog(habit.id, today, 'done', notes || null)
    setNotesOpen(false)
    onMutate()
  }

  return (
    <div className={`habit-row ${isDone ? 'done' : ''} ${isSkipped ? 'skipped' : ''}`}>
      <div className="habit-main">
        <div className="habit-title-row">
          <span className="habit-title">{habit.title}</span>
          <div className="habit-actions">
            <button
              className={`habit-btn habit-done-btn ${isDone ? 'active' : ''}`}
              onClick={handleDone}
              title={isDone ? 'Undo' : 'Mark done'}
            >✓</button>
            <button
              className={`habit-btn habit-skip-btn ${isSkipped ? 'active' : ''}`}
              onClick={handleSkip}
              title={isSkipped ? 'Undo skip' : 'Skip'}
            >–</button>
          </div>
        </div>
        <div className="habit-bottom-row">
        <div className="habit-streak">
          {habit.week.map(w => {
            const cls = !w.due ? 'not-due' : w.log?.status === 'done' ? 'dot-done' : w.log?.status === 'skipped' ? 'dot-skipped' : 'dot-empty'
            return (
              <span key={w.date} className={`streak-dot ${cls}`} title={w.date} />
            )
          })}
        </div>
        {habit.description && !isDone && (
          <span className="habit-desc">{habit.description}</span>
        )}
        {isDone && log?.notes && !notesOpen && (
          <span className="habit-notes-preview" onClick={() => setNotesOpen(true)}>{log.notes}</span>
        )}
        </div>
      </div>
      {notesOpen && (
        <div className="habit-notes-row">
          <textarea
            className="habit-notes-input"
            placeholder={habit.description ?? 'Add session notes…'}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            autoFocus
            rows={2}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNotes()
              if (e.key === 'Escape') setNotesOpen(false)
            }}
          />
          <div className="habit-notes-footer">
            <button className="habit-notes-save" onClick={saveNotes}>Save</button>
            <button className="habit-notes-cancel" onClick={() => setNotesOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
