import { useState, useEffect } from 'react'
import { RRule } from 'rrule'

interface Props {
  current: string | null
  onChange: (rrule: string | null) => void
}

type Freq = '' | 'DAILY' | 'WEEKLY_WEEKDAYS' | 'WEEKLY' | 'MONTHLY'

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
const DAY_LABELS: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }

function parseSchedule(rruleStr: string | null): { freq: Freq; days: string[]; monthday: number; hour: number; minute: number } {
  if (!rruleStr) return { freq: '', days: [], monthday: 1, hour: 9, minute: 0 }
  const parts: Record<string, string> = {}
  for (const p of rruleStr.split(';')) {
    const [k, v] = p.split('=')
    parts[k] = v
  }
  const freq = parts['FREQ'] ?? ''
  const days = parts['BYDAY'] ? parts['BYDAY'].split(',') : []
  const monthday = parseInt(parts['BYMONTHDAY'] ?? '1', 10)
  const hour = parseInt(parts['BYHOUR'] ?? '9', 10)
  const minute = parseInt(parts['BYMINUTE'] ?? '0', 10)
  const isWeekdays = days.join(',') === 'MO,TU,WE,TH,FR'
  return {
    freq: freq === 'WEEKLY' && isWeekdays ? 'WEEKLY_WEEKDAYS' : (freq as Freq),
    days: isWeekdays ? [] : days,
    monthday,
    hour,
    minute,
  }
}

function buildRrule(freq: Freq, days: string[], monthday: number, hour: number, minute: number): string | null {
  if (!freq) return null
  const timePart = `;BYHOUR=${hour};BYMINUTE=${minute}`
  if (freq === 'DAILY') return `FREQ=DAILY${timePart}`
  if (freq === 'WEEKLY_WEEKDAYS') return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR${timePart}`
  if (freq === 'WEEKLY') return `FREQ=WEEKLY;BYDAY=${days.length ? days.join(',') : 'MO'}${timePart}`
  if (freq === 'MONTHLY') return `FREQ=MONTHLY;BYMONTHDAY=${monthday || 1}${timePart}`
  return null
}

function schedulePreview(rruleStr: string | null): string {
  if (!rruleStr) return ''
  try {
    const rule = RRule.fromString('RRULE:' + rruleStr)
    const text = rule.toText()
    const next = rule.after(new Date(), false)
    const nextStr = next ? ' · next: ' + next.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
    return text + nextStr
  } catch { return rruleStr }
}

export default function AgentSchedulePicker({ current, onChange }: Props) {
  const parsed = parseSchedule(current)
  const [freq, setFreq] = useState<Freq>(parsed.freq)
  const [days, setDays] = useState<string[]>(parsed.days)
  const [monthday, setMonthday] = useState(parsed.monthday)
  const [hour, setHour] = useState(parsed.hour)
  const [minute, setMinute] = useState(parsed.minute)

  useEffect(() => {
    const p = parseSchedule(current)
    setFreq(p.freq)
    setDays(p.days)
    setMonthday(p.monthday)
    setHour(p.hour)
    setMinute(p.minute)
  }, [current])

  function emit(f: Freq, d: string[], md: number, h: number, m: number) {
    onChange(buildRrule(f, d, md, h, m))
  }

  function handleFreqChange(val: Freq) {
    setFreq(val)
    emit(val, days, monthday, hour, minute)
  }

  function toggleDay(day: string) {
    const next = days.includes(day) ? days.filter(d => d !== day) : [...days, day]
    setDays(next)
    emit(freq, next, monthday, hour, minute)
  }

  function handleTime(h: number, m: number) {
    setHour(h)
    setMinute(m)
    emit(freq, days, monthday, h, m)
  }

  const rrule = buildRrule(freq, days, monthday, hour, minute)
  const preview = schedulePreview(rrule)

  const timeValue = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

  return (
    <div className="recurrence-picker">
      <div className="recurrence-freq-row">
        <select
          className="recurrence-select"
          value={freq}
          onChange={e => handleFreqChange(e.target.value as Freq)}
        >
          <option value="">Manual only</option>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY_WEEKDAYS">Weekdays (Mon–Fri)</option>
          <option value="WEEKLY">Weekly (choose days)</option>
          <option value="MONTHLY">Monthly (choose day)</option>
        </select>
        {freq && (
          <input
            type="time"
            className="recurrence-monthday-input"
            style={{ width: 90 }}
            value={timeValue}
            onChange={e => {
              const [h, m] = e.target.value.split(':').map(Number)
              handleTime(h, m)
            }}
          />
        )}
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
            onChange={e => {
              const val = parseInt(e.target.value, 10)
              setMonthday(val)
              emit(freq, days, val, hour, minute)
            }}
          />
          of the month
        </div>
      )}

      {preview && <div className="recurrence-preview">{preview}</div>}
    </div>
  )
}
