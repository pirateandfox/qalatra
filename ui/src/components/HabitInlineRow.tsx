import { useState } from 'react'
import { today as todayStr } from '../lib/constants'
import type { HabitSummary } from '../api'
import './HabitInlineRow.css'

interface Props {
  habit: HabitSummary
  onMutate: () => void
}

export default function HabitInlineRow({ habit, onMutate }: Props) {
  const today = todayStr()
  const log = habit.today_log
  const isDone    = log?.status === 'done'
  const isSkipped = log?.status === 'skipped'
  const [notesOpen, setNotesOpen] = useState(false)
  const [notes, setNotes] = useState('')

  async function toggle() {
    if (isDone) {
      await fetch('/api/habits/unlog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ habit_id: habit.id, date: today }),
      })
      setNotesOpen(false)
      onMutate()
    } else {
      await fetch('/api/habits/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ habit_id: habit.id, date: today, status: 'done', notes: null }),
      })
      setNotes(log?.notes ?? '')
      setNotesOpen(true)
      onMutate()
    }
  }

  async function saveNotes() {
    await fetch('/api/habits/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ habit_id: habit.id, date: today, status: 'done', notes: notes || null }),
    })
    setNotesOpen(false)
    onMutate()
  }

  return (
    <div className={`habit-inline-row ${isDone ? 'done' : ''} ${isSkipped ? 'skipped' : ''}`}>
      <div className="habit-inline-main">
        <button
          className={`habit-inline-check ${isDone ? 'checked' : ''}`}
          onClick={toggle}
          title={isDone ? 'Undo' : 'Mark done'}
        >✓</button>
        <span className="habit-inline-title" onClick={() => isDone && setNotesOpen(o => !o)}>
          {habit.title}
        </span>
        {isDone && log?.notes && !notesOpen && (
          <span className="habit-inline-notes-preview" onClick={() => setNotesOpen(true)}>
            {log.notes}
          </span>
        )}
      </div>
      {notesOpen && (
        <div className="habit-inline-notes">
          <textarea
            className="habit-inline-textarea"
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
          <div className="habit-inline-notes-actions">
            <button className="habit-inline-save" onClick={saveNotes}>Save</button>
            <button className="habit-inline-cancel" onClick={() => setNotesOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
