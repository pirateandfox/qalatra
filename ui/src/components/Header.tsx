import { offsetDate, today as todayStr } from '../lib/constants'
import './Header.css'

interface Props {
  date: string
  view: 'priority' | 'project'
  screen: 'main' | 'backlog' | 'habits'
  onDateChange: (d: string) => void
  onViewChange: (v: 'priority' | 'project') => void
  onScreenChange: (s: 'main' | 'backlog' | 'habits') => void
  onTerminalToggle: () => void
  dailyNoteOpen: boolean
  onDailyNoteToggle: () => void
  settingsOpen: boolean
  onSettingsToggle: () => void
  onNewTask: () => void
  onRefresh: () => void
}

export default function Header({ date, view, screen, onDateChange, onViewChange, onScreenChange, onTerminalToggle, dailyNoteOpen, onDailyNoteToggle, settingsOpen, onSettingsToggle, onNewTask, onRefresh }: Props) {
  const today = todayStr()
  const prev = offsetDate(date, -1)
  const next = offsetDate(date, 1)

  const viewLabels: Record<string, string> = { priority: 'priority', project: 'project', backlog: 'backlog', habits: 'habits' }
  const activeLabel = screen === 'backlog' ? 'backlog' : screen === 'habits' ? 'habits' : view

  return (
    <header className="header">
      <span className={`view-label view-${activeLabel}`}>{viewLabels[activeLabel]}</span>

      <button className="nav-btn new-task-btn" onClick={onNewTask} title="New Task (N)">+</button>
      <button className="nav-btn terminal-btn" onClick={onTerminalToggle} title="Toggle Terminal (Ctrl+`)">_$</button>
      <button className={`nav-btn note-btn${dailyNoteOpen ? ' note-btn-active' : ''}`} onClick={onDailyNoteToggle} title="Toggle Daily Note">✎</button>
      <button className={`nav-btn${settingsOpen ? ' note-btn-active' : ''}`} onClick={onSettingsToggle} title="Settings">⚙</button>
      <button className="nav-btn" onClick={onRefresh} title="Refresh (R)">↻</button>

      <div className="view-toggle">
        <a
          className={screen === 'main' && view === 'priority' ? 'active' : ''}
          onClick={e => { e.preventDefault(); onScreenChange('main'); onViewChange('priority') }}
          href="#"
        >Priority</a>
        <a
          className={screen === 'main' && view === 'project' ? 'active' : ''}
          onClick={e => { e.preventDefault(); onScreenChange('main'); onViewChange('project') }}
          href="#"
        >Project</a>
        <a
          className={screen === 'backlog' ? 'active backlog-active' : ''}
          onClick={e => { e.preventDefault(); onScreenChange('backlog') }}
          href="#"
        >Backlog</a>
        <a
          className={screen === 'habits' ? 'active' : ''}
          onClick={e => { e.preventDefault(); onScreenChange('habits') }}
          href="#"
        >Habits</a>
      </div>

      {(screen === 'main' || screen === 'habits') && (
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
    </header>
  )
}
