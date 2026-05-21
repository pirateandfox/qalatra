import { offsetDate, today as todayStr } from '../lib/constants'
import type { NavSection } from './Sidebar'
import './Header.css'

interface Props {
  date: string
  nav: NavSection
  onDateChange: (d: string) => void
  onTerminalToggle: () => void
  onRefresh: () => void
}

const DATE_VIEWS: NavSection[] = ['priority', 'daily', 'habits']

export default function Header({ date, nav, onDateChange, onTerminalToggle, onRefresh }: Props) {
  const today = todayStr()
  const prev = offsetDate(date, -1)
  const next = offsetDate(date, 1)
  const showDateNav = DATE_VIEWS.includes(nav)

  return (
    <header className="header">
      {showDateNav && (
        <div className="date-nav">
          {date !== today && (
            <button className="today-link" onClick={() => onDateChange(today)}>Today</button>
          )}
          <button className="nav-btn" onClick={() => onDateChange(prev)}>‹</button>
          <input
            type="date"
            className="date-input"
            value={date}
            onChange={e => onDateChange(e.target.value)}
          />
          <button className="nav-btn" onClick={() => onDateChange(next)}>›</button>
        </div>
      )}
      <div style={{ flex: 1 }} />
      <button className="nav-btn terminal-btn" onClick={onTerminalToggle} title="Toggle Terminal (Ctrl+`)">_$</button>
      <button className="nav-btn" onClick={onRefresh} title="Refresh (R)">↻</button>
    </header>
  )
}
