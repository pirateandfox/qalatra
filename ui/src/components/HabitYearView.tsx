import { useEffect, useMemo, useState } from 'react'
import { getHabitHistory, type HabitHistory, type HabitHistoryDay } from '../api'
import { offsetDate } from '../lib/constants'
import './HabitYearView.css'

// GitHub-contribution-style year heatmap for one habit: columns are Monday-start weeks, rows are
// Mo..Su (matching the 7-day strip). Clicking a cell drills into that week; clicking a month
// label drills into that month. Stats come from GET /api/v1/habits/:id/history, which shares its
// counting rules with the MCP get_habit_history range mode.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY_LABELS = ['Mo', '', 'We', '', 'Fr', '', '']

function mondayOf(date: string): string {
  const dow = new Date(date + 'T12:00:00Z').getUTCDay()
  return offsetDate(date, -(dow === 0 ? 6 : dow - 1))
}

function fmtDay(date: string): string {
  return new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function cellClass(d: HabitHistoryDay, today: string): string {
  if (d.future) return 'hy-future'
  if (d.status === 'done') return d.due ? 'hy-done' : 'hy-extra'
  if (d.status === 'skipped') return 'hy-skipped'
  if (!d.due) return 'hy-not-due'
  return d.date === today ? 'hy-open' : 'hy-missed'
}

const STATUS_LABEL: Record<string, string> = {
  'hy-future': 'upcoming', 'hy-done': 'done', 'hy-extra': 'done (extra)', 'hy-skipped': 'skipped',
  'hy-not-due': 'not due', 'hy-open': 'due today', 'hy-missed': 'missed',
}

function cellTitle(d: HabitHistoryDay, today: string): string {
  return `${fmtDay(d.date)} — ${STATUS_LABEL[cellClass(d, today)]}${d.notes ? `\n${d.notes}` : ''}`
}

interface Selection {
  start: string
  end: string
  label: string
}

interface Props {
  habitId: string
  today: string
  /** Changes when the row logs/unlogs, so today's cell refetches. */
  refreshKey?: string
}

export default function HabitYearView({ habitId, today, refreshKey }: Props) {
  const thisYear = Number(today.slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const [history, setHistory] = useState<HabitHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)

  useEffect(() => { setSelection(null) }, [habitId, year])

  useEffect(() => {
    let cancelled = false
    setError(null)
    getHabitHistory(habitId, `${year}-01-01`, `${year}-12-31`)
      .then(h => { if (!cancelled) setHistory(h) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [habitId, year, refreshKey])

  // Columns of 7 slots (Mo..Su); slots outside the year stay null.
  const { weeks, monthCols } = useMemo(() => {
    const days = history?.days ?? []
    const byDate = new Map(days.map(d => [d.date, d]))
    const first = mondayOf(`${year}-01-01`)
    const cols: { monday: string; slots: (HabitHistoryDay | null)[] }[] = []
    for (let monday = first; monday <= `${year}-12-31`; monday = offsetDate(monday, 7)) {
      cols.push({ monday, slots: Array.from({ length: 7 }, (_, i) => byDate.get(offsetDate(monday, i)) ?? null) })
    }
    const mCols = MONTHS.map((_, m) => {
      const firstOfMonth = `${year}-${String(m + 1).padStart(2, '0')}-01`
      return cols.findIndex(c => c.monday === mondayOf(firstOfMonth))
    })
    return { weeks: cols, monthCols: mCols }
  }, [history, year])

  const selectedDays = useMemo(() => {
    if (!selection || !history) return []
    return history.days.filter(d => d.date >= selection.start && d.date <= selection.end && !d.future)
  }, [selection, history])

  function selectWeek(monday: string) {
    const start = monday < `${year}-01-01` ? `${year}-01-01` : monday
    const sunday = offsetDate(monday, 6)
    const end = sunday > `${year}-12-31` ? `${year}-12-31` : sunday
    setSelection(s => (s?.start === start && s.end === end ? null : { start, end, label: `Week of ${fmtDay(monday)}` }))
  }

  function selectMonth(m: number) {
    const mm = String(m + 1).padStart(2, '0')
    const start = `${year}-${mm}-01`
    const end = offsetDate(m === 11 ? `${year + 1}-01-01` : `${year}-${String(m + 2).padStart(2, '0')}-01`, -1)
    setSelection(s => (s?.start === start ? null : { start, end, label: `${MONTHS[m]} ${year}` }))
  }

  const selDue = selectedDays.filter(d => d.due).length
  const selDoneDue = selectedDays.filter(d => d.due && d.status === 'done').length

  return (
    <div className="habit-year">
      <div className="hy-header">
        <div className="hy-nav">
          <button className="hy-nav-btn" onClick={() => setYear(y => y - 1)} title="Previous year">‹</button>
          <span className="hy-year">{year}</span>
          <button className="hy-nav-btn" onClick={() => setYear(y => y + 1)} disabled={year >= thisYear} title="Next year">›</button>
        </div>
        {history && (
          <div className="hy-stats">
            <span className="hy-stat-main">{history.completion_rate == null ? '—' : `${history.completion_rate}%`}</span>
            <span>{history.days_done}/{history.days_due} days</span>
            {year === thisYear && <span>streak {history.current_streak}</span>}
            <span>best {history.longest_streak}</span>
          </div>
        )}
      </div>

      {error && <div className="hy-empty">Couldn't load history: {error}</div>}
      {!error && !history && <div className="hy-empty">Loading…</div>}

      {history && (
        <div className="hy-grid-wrap" style={{ ['--hy-cols' as string]: weeks.length }}>
          <div className="hy-months">
            {MONTHS.map((label, m) => (
              <button
                key={label}
                className={`hy-month ${selection?.label === `${label} ${year}` ? 'selected' : ''}`}
                style={{ gridColumn: `${monthCols[m] + 1} / span 3` }}
                onClick={() => selectMonth(m)}
                title={`Show ${label} ${year}`}
              >{label}</button>
            ))}
          </div>
          <div className="hy-body">
            <div className="hy-weekdays">
              {WEEKDAY_LABELS.map((l, i) => <span key={i}>{l}</span>)}
            </div>
            <div className="hy-grid">
              {weeks.map(w => {
                const selected = selection && w.monday <= selection.end && offsetDate(w.monday, 6) >= selection.start
                return (
                  <div key={w.monday} className={`hy-week ${selected ? 'selected' : ''}`} onClick={() => selectWeek(w.monday)}>
                    {w.slots.map((d, i) => d
                      ? <span key={d.date} className={`hy-cell ${cellClass(d, today)}`} title={cellTitle(d, today)} />
                      : <span key={i} className="hy-cell hy-outside" />)}
                  </div>
                )
              })}
            </div>
          </div>
          <div className="hy-legend">
            <span><i className="hy-cell hy-done" /> done</span>
            <span><i className="hy-cell hy-skipped" /> skipped</span>
            <span><i className="hy-cell hy-missed" /> missed</span>
            <span><i className="hy-cell hy-not-due" /> not due</span>
          </div>
        </div>
      )}

      {selection && history && (
        <div className="hy-drill">
          <div className="hy-drill-header">
            <span className="hy-drill-title">{selection.label}</span>
            <span className="hy-drill-stat">{selDue > 0 ? `${selDoneDue}/${selDue} due days done` : 'nothing due'}</span>
            <button className="hy-nav-btn" onClick={() => setSelection(null)} title="Close">✕</button>
          </div>
          {selectedDays.length === 0 && <div className="hy-empty">No days to show yet.</div>}
          {selectedDays.map(d => {
            const cls = cellClass(d, today)
            if (cls === 'hy-not-due' && !d.notes) return null
            return (
              <div key={d.date} className="hy-drill-row">
                <span className={`hy-cell ${cls}`} />
                <span className="hy-drill-date">{fmtDay(d.date)}</span>
                <span className="hy-drill-status">{STATUS_LABEL[cls]}</span>
                {d.notes && <span className="hy-drill-notes">{d.notes}</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
