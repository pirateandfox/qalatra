import { useState, useEffect } from 'react'
import { RRule } from 'rrule'
import { api } from '../api'
import './RecurrencePicker.css'

interface Props {
  taskId: string
  current: string | null
  onChange?: (rrule: string | null) => void
}

type Freq = '' | 'DAILY' | 'WEEKLY_WEEKDAYS' | 'WEEKLY' | 'MONTHLY'

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
const DAY_LABELS: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }

function parseRecurrence(rruleStr: string | null): { freq: Freq; days: string[]; monthday: number } {
  if (!rruleStr) return { freq: '', days: [], monthday: 1 }
  const map: Record<string, string> = {
    daily: 'FREQ=DAILY',
    weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    weekly: 'FREQ=WEEKLY',
    monthly: 'FREQ=MONTHLY',
  }
  const s = map[rruleStr] ?? rruleStr
  const parts: Record<string, string> = {}
  for (const p of s.split(';')) {
    const [k, v] = p.split('=')
    parts[k] = v
  }
  const freq = parts['FREQ'] ?? ''
  const days = parts['BYDAY'] ? parts['BYDAY'].split(',') : []
  const monthday = parseInt(parts['BYMONTHDAY'] ?? '1', 10)
  const isWeekdays = days.join(',') === 'MO,TU,WE,TH,FR'
  return {
    freq: freq === 'WEEKLY' && isWeekdays ? 'WEEKLY_WEEKDAYS' : (freq as Freq),
    days: isWeekdays ? [] : days,
    monthday,
  }
}

function buildRrule(freq: Freq, days: string[], monthday: number): string | null {
  if (!freq) return null
  if (freq === 'DAILY') return 'FREQ=DAILY'
  if (freq === 'WEEKLY_WEEKDAYS') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
  if (freq === 'WEEKLY') return `FREQ=WEEKLY;BYDAY=${days.length ? days.join(',') : 'MO'}`
  if (freq === 'MONTHLY') return `FREQ=MONTHLY;BYMONTHDAY=${monthday || 1}`
  return null
}

function rrulePreview(rruleStr: string | null): string {
  if (!rruleStr) return ''
  try {
    const rule = RRule.fromString('RRULE:' + rruleStr)
    const text = rule.toText()
    const d = new Date(); d.setHours(12, 0, 0, 0)
    const next = rule.after(d, false)
    const nextStr = next ? ' · next: ' + next.toISOString().slice(0, 10) : ''
    return text + nextStr
  } catch { return rruleStr }
}

export default function RecurrencePicker({ taskId, current, onChange }: Props) {
  const parsed = parseRecurrence(current)
  const [freq, setFreq] = useState<Freq>(parsed.freq)
  const [days, setDays] = useState<string[]>(parsed.days)
  const [monthday, setMonthday] = useState(parsed.monthday)

  useEffect(() => {
    const p = parseRecurrence(current)
    setFreq(p.freq)
    setDays(p.days)
    setMonthday(p.monthday)
  }, [current])

  const rrule = buildRrule(freq, days, monthday)
  const preview = rrulePreview(rrule)

  async function save(newRrule: string | null) {
    await api.updateRecurrence(taskId, newRrule)
    onChange?.(newRrule)
  }

  function toggleDay(day: string) {
    const next = days.includes(day) ? days.filter(d => d !== day) : [...days, day]
    setDays(next)
    save(buildRrule(freq, next, monthday))
  }

  function handleFreqChange(val: Freq) {
    setFreq(val)
    save(buildRrule(val, days, monthday))
  }

  function handleMonthdayChange(val: number) {
    setMonthday(val)
    save(buildRrule(freq, days, val))
  }

  return (
    <div className="recurrence-picker">
      <div className="recurrence-freq-row">
        <select
          className="recurrence-select"
          value={freq}
          onChange={e => handleFreqChange(e.target.value as Freq)}
        >
          <option value="">No recurrence</option>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY_WEEKDAYS">Weekdays (Mon–Fri)</option>
          <option value="WEEKLY">Weekly (choose days)</option>
          <option value="MONTHLY">Monthly (choose day)</option>
        </select>
      </div>

      {freq === 'WEEKLY' && (
        <div className="recurrence-days">
          {DAYS.map(d => (
            <button
              key={d}
              type="button"
              className={`recur-day-btn ${days.includes(d) ? 'active' : ''}`}
              onClick={() => toggleDay(d)}
            >
              {DAY_LABELS[d]}
            </button>
          ))}
        </div>
      )}

      {freq === 'MONTHLY' && (
        <div className="recurrence-monthday-row">
          On day
          <input
            type="number"
            className="recurrence-monthday-input"
            min={1} max={31}
            value={monthday}
            onChange={e => handleMonthdayChange(parseInt(e.target.value, 10))}
          />
          of the month
        </div>
      )}

      {preview && <div className="recurrence-preview">{preview}</div>}
    </div>
  )
}
