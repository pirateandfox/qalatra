import { useState, useEffect, useCallback } from 'react'
import { today as todayStr } from '../lib/constants'
import { createHabit as apiCreateHabit, listHabits } from '../api'
import HabitRow from './HabitRow'
import './HabitsView.css'

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
  onMutate?: () => void
}

export default function HabitsView({ onMutate }: Props) {
  const today = todayStr()
  const [habits, setHabits] = useState<Habit[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newRecurrence, setNewRecurrence] = useState<'daily' | 'weekdays' | 'weekly' | 'monthly'>('daily')
  const [newRecurrenceDays, setNewRecurrenceDays] = useState<string[]>([])

  const load = useCallback(async () => {
    const data = await listHabits(today)
    setHabits(data)
    setLoading(false)
  }, [today])

  useEffect(() => { load() }, [load])

  async function createHabit(e: React.FormEvent) {
    e.preventDefault()
    if (!newTitle.trim()) return
    const recurrence_days = newRecurrenceDays.length > 0 ? newRecurrenceDays.join(',') : null
    await apiCreateHabit({ title: newTitle.trim(), description: newDesc.trim() || null, recurrence: newRecurrence, recurrence_days })
    setNewTitle('')
    setNewDesc('')
    setNewRecurrence('daily')
    setNewRecurrenceDays([])
    setCreating(false)
    load()
  }

  const done    = habits.filter(h => h.today_log?.status === 'done').length
  const pending = habits.filter(h => !h.today_log).length

  return (
    <div className="habits-view">
      <div className="habits-header">
        <div className="habits-summary">
          <span className="habits-done">{done} done</span>
          {pending > 0 && <span className="habits-pending">{pending} remaining</span>}
        </div>
        <button className="habits-add-btn" onClick={() => setCreating(c => !c)}>
          {creating ? '✕' : '+ New habit'}
        </button>
      </div>

      {creating && (
        <form className="habit-create-form" onSubmit={createHabit}>
          <input
            className="habit-create-input"
            placeholder="Habit name (e.g. Instrument practice)"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            autoFocus
          />
          <input
            className="habit-create-input"
            placeholder="Notes prompt (e.g. What did you practice?)"
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
          />
          <div className="habit-create-row">
            <select
              className="habit-recurrence-select"
              value={newRecurrence}
              onChange={e => { setNewRecurrence(e.target.value as typeof newRecurrence); setNewRecurrenceDays([]) }}
            >
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            {newRecurrence === 'weekdays' && (
              <div className="habit-day-picker">
                {(['mon','tue','wed','thu','fri','sat','sun'] as const).map(day => (
                  <label key={day} className={`habit-day-chip ${newRecurrenceDays.includes(day) ? 'selected' : ''}`}>
                    <input
                      type="checkbox"
                      checked={newRecurrenceDays.includes(day)}
                      onChange={e => setNewRecurrenceDays(prev =>
                        e.target.checked ? [...prev, day] : prev.filter(d => d !== day)
                      )}
                    />
                    {day.charAt(0).toUpperCase() + day.slice(1, 3)}
                  </label>
                ))}
              </div>
            )}
            <button type="submit" className="habit-create-submit">Create</button>
            <button type="button" className="habit-create-cancel" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </form>
      )}

      {loading && <div className="habits-empty">Loading…</div>}

      {!loading && habits.length === 0 && (
        <div className="habits-empty">No habits yet. Add one above to start tracking.</div>
      )}

      {!loading && habits.length > 0 && (
        <div className="habits-list">
          {habits.map(h => (
            <HabitRow key={h.id} habit={h} today={today} onMutate={() => { load(); onMutate?.() }} />
          ))}
        </div>
      )}
    </div>
  )
}
