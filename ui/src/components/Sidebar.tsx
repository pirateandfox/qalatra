import type { ThemeMode } from '../lib/theme'
import './Sidebar.css'

export type NavSection = 'priority' | 'code' | 'reading' | 'project' | 'backlog' | 'habits' | 'heartbeats'

const THEME_ICONS: Record<ThemeMode, string> = { system: '◑', light: '☀', dark: '☾' }
const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark']

const NAV_ITEMS: { key: NavSection; icon: string; label: string }[] = [
  { key: 'priority', icon: '★', label: 'Priority' },
  { key: 'code',     icon: '⌨', label: 'Code' },
  { key: 'reading',  icon: '📖', label: 'Reading' },
  { key: 'project',  icon: '⊞', label: 'Projects' },
  { key: 'backlog',  icon: '≡', label: 'Backlog' },
  { key: 'habits',      icon: '◎', label: 'Habits' },
  { key: 'heartbeats',  icon: '⚡', label: 'Heartbeats' },
]

interface Props {
  nav: NavSection
  onNavChange: (n: NavSection) => void
  activeAgentCount: number
  onNewTask: () => void
  dailyNoteOpen: boolean
  onDailyNoteToggle: () => void
  settingsOpen: boolean
  onSettingsToggle: () => void
  themeMode: ThemeMode
  onThemeModeChange: (m: ThemeMode) => void
}

export default function Sidebar({
  nav, onNavChange, activeAgentCount,
  onNewTask, dailyNoteOpen, onDailyNoteToggle,
  settingsOpen, onSettingsToggle, themeMode, onThemeModeChange,
}: Props) {
  function cycleTheme() {
    const idx = THEME_CYCLE.indexOf(themeMode)
    onThemeModeChange(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length])
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-drag" />
      <nav className="sidebar-nav">
        {NAV_ITEMS.map(item => (
          <button
            key={item.key}
            className={`sidebar-item${nav === item.key ? ' active' : ''}`}
            onClick={() => onNavChange(item.key)}
          >
            <span className="sidebar-icon">{item.icon}</span>
            <span className="sidebar-label">{item.label}</span>
            {item.key === 'code' && activeAgentCount > 0 && (
              <span className="sidebar-badge">{activeAgentCount}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="sidebar-actions">
        <button className="sidebar-action-btn new-btn" onClick={onNewTask} title="New Task (N)">
          <span>+</span><span>New Task</span>
        </button>
        <button className={`sidebar-action-btn${dailyNoteOpen ? ' active' : ''}`} onClick={onDailyNoteToggle} title="Daily Note">
          <span>✎</span><span>Daily Note</span>
        </button>
        <button className={`sidebar-action-btn${settingsOpen ? ' active' : ''}`} onClick={onSettingsToggle} title="Settings">
          <span>⚙</span><span>Settings</span>
        </button>
        <button className="sidebar-action-btn" onClick={cycleTheme} title={`Theme: ${themeMode}`}>
          <span>{THEME_ICONS[themeMode]}</span><span>Theme</span>
        </button>
      </div>
    </aside>
  )
}
