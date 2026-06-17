import type { ThemeMode } from '../lib/theme'
import './Sidebar.css'

export type NavSection = 'priority' | 'daily' | 'code' | 'terminals' | 'files' | 'boxWeb' | 'reading' | 'project' | 'backlog' | 'habits' | 'heartbeats' | 'settings'

const THEME_ICONS: Record<ThemeMode, string> = { system: '◑', light: '☀', dark: '☾' }
const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark']

const NAV_ITEMS: { key: NavSection; icon: string; label: string }[] = [
  { key: 'priority', icon: '★', label: 'Priority' },
  { key: 'code',     icon: '⌨', label: 'Code' },
  { key: 'terminals', icon: '_$', label: 'Terminals' },
  { key: 'files',    icon: '▤', label: 'Files' },
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
  boxWebItem: { label: string } | null
  onNewTask: () => void
  dailyNoteActive: boolean
  onDailyNoteOpen: () => void
  themeMode: ThemeMode
  onThemeModeChange: (m: ThemeMode) => void
}

export default function Sidebar({
  nav, onNavChange, activeAgentCount,
  boxWebItem,
  onNewTask, dailyNoteActive, onDailyNoteOpen,
  themeMode, onThemeModeChange,
}: Props) {
  function cycleTheme() {
    const idx = THEME_CYCLE.indexOf(themeMode)
    onThemeModeChange(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length])
  }

  const navItems = boxWebItem
    ? [
        ...NAV_ITEMS.slice(0, 4),
        { key: 'boxWeb' as NavSection, icon: '▣', label: boxWebItem.label },
        ...NAV_ITEMS.slice(4),
      ]
    : NAV_ITEMS

  return (
    <aside className="sidebar">
      <div className="sidebar-drag" />
      <nav className="sidebar-nav">
        {navItems.map(item => (
          <button
            key={item.key}
            className={`sidebar-item${nav === item.key ? ' active' : ''}`}
            onClick={() => onNavChange(item.key)}
          >
            <span className="sidebar-icon">{item.icon}</span>
            <span className="sidebar-label">{item.label}</span>
            {item.key === 'priority' && activeAgentCount > 0 && (
              <span className="sidebar-badge">{activeAgentCount}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="sidebar-actions">
        <button className="sidebar-action-btn new-btn" onClick={onNewTask} title="New Task (N)">
          <span>+</span><span>New Task</span>
        </button>
        <button className={`sidebar-action-btn${dailyNoteActive ? ' active' : ''}`} onClick={onDailyNoteOpen} title="Daily Note">
          <span>✎</span><span>Daily Note</span>
        </button>
        <button className={`sidebar-action-btn${nav === 'settings' ? ' active' : ''}`} onClick={() => onNavChange('settings')} title="Settings">
          <span>⚙</span><span>Settings</span>
        </button>
        <button className="sidebar-action-btn" onClick={cycleTheme} title={`Theme: ${themeMode}`}>
          <span>{THEME_ICONS[themeMode]}</span><span>Theme</span>
        </button>
      </div>
    </aside>
  )
}
