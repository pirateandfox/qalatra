import { useState } from 'react'
import { logHabit, unlogHabit, updateHabit } from '../api'
import './HabitRow.css'

const DAY_LABELS: Record<string, string> = { mon: 'Mo', tue: 'Tu', wed: 'We', thu: 'Th', fri: 'Fr', sat: 'Sa', sun: 'Su' }
const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

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
  recurrence_days: string | null
  today_log: HabitLog | null
  week: WeekDay[]
}

interface Props {
  habit: Habit
  today: string
  onMutate: () => void
}

export default function HabitRow({ habit, today, onMutate }: Props) {
  const log = habit.today_log
  const isDone    = log?.status === 'done'
  const isSkipped = log?.status === 'skipped'
  const [notesOpen, setNotesOpen] = useState(false)
  const [notes, setNotes] = useState(log?.notes ?? '')
  const [editing, setEditing] = useState(false)

  // Edit state
  const [editTitle, setEditTitle] = useState(habit.title)
  const [editDesc, setEditDesc] = useState(habit.description ?? '')
  const [editRecurrence, setEditRecurrence] = useState(habit.recurrence)
  const [editDays, setEditDays] = useState<string[]>(
    habit.recurrence_days ? habit.recurrence_days.split(',') : []
  )

  async function handleDone() {
    if (isDone) {
      await unlogHabit(habit.id, today)
    } else {
      await logHabit(habit.id, today, 'done', notes || null)
      setNotesOpen(true)
    }
    onMutate()
  }

  async function handleSkip() {
    if (isSkipped) {
      await unlogHabit(habit.id, today)
    } else {
      await logHabit(habit.id, today, 'skipped', null)
      setNotesOpen(false)
    }
    onMutate()
  }

  async function saveNotes() {
    await logHabit(habit.id, today, 'done', notes || null)
    setNotesOpen(false)
    onMutate()
  }

  async function saveEdit() {
    const recurrence_days = editDays.length > 0 ? editDays.join(',') : null
    await updateHabit({
      id: habit.id,
      title: editTitle.trim() || habit.title,
      description: editDesc.trim() || null,
      recurrence: editRecurrence,
      recurrence_days,
    })
    setEditing(false)
    onMutate()
  }

  async function archiveHabit() {
    if (!confirm(`Archive "${habit.title}"?`)) return
    await updateHabit({ id: habit.id, active: false })
    onMutate()
  }

  function toggleEditDay(day: string) {
    setEditDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day])
  }

  if (editing) {
    return (
      <div className="habit-row habit-edit-mode">
        <div className="habit-edit-form">
          <input
            className="habit-edit-input"
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            placeholder="Habit name"
            autoFocus
          />
          <input
            className="habit-edit-input"
            value={editDesc}
            onChange={e => setEditDesc(e.target.value)}
            placeholder="Notes prompt (optional)"
          />
          <div className="habit-edit-recurrence-row">
            <select
              className="habit-recurrence-select"
              value={editRecurrence}
              onChange={e => { setEditRecurrence(e.target.value); setEditDays([]) }}
            >
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            {editRecurrence === 'weekdays' && (
              <div className="habit-day-picker">
                {ALL_DAYS.map(day => (
                  <label key={day} className={`habit-day-chip ${editDays.includes(day) ? 'selected' : ''}`}>
                    <input
                      type="checkbox"
                      checked={editDays.includes(day)}
                      onChange={() => toggleEditDay(day)}
                    />
                    {day.charAt(0).toUpperCase() + day.slice(1, 3)}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="habit-edit-actions">
            <button className="habit-edit-save" onClick={saveEdit}>Save</button>
            <button className="habit-edit-cancel" onClick={() => {
              setEditing(false)
              setEditTitle(habit.title)
              setEditDesc(habit.description ?? '')
              setEditRecurrence(habit.recurrence)
              setEditDays(habit.recurrence_days ? habit.recurrence_days.split(',') : [])
            }}>Cancel</button>
            <button className="habit-edit-archive" onClick={archiveHabit}>Archive</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`habit-row ${isDone ? 'done' : ''} ${isSkipped ? 'skipped' : ''}`}>
      <div className="habit-main">
        <div className="habit-title-row">
          <div className="habit-title-group">
            <span className="habit-title">{habit.title}</span>
            {habit.recurrence_days && (
              <span className="habit-days-label">
                {habit.recurrence_days.split(',').map(d => DAY_LABELS[d.trim()] ?? d).join(' ')}
              </span>
            )}
          </div>
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
            <button
              className="habit-btn habit-edit-btn"
              onClick={() => setEditing(true)}
              title="Edit habit"
            >✎</button>
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
