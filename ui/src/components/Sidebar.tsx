import type { ThemeMode } from '../lib/theme'
import { NAV_ITEMS, type NavItem, type NavSection } from '../lib/nav'
import './Sidebar.css'

export type { NavSection }

const THEME_ICONS: Record<ThemeMode, string> = { system: '◑', light: '☀', dark: '☾' }
const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark']

// The dynamic Tools/boxWeb item slots into the "tools" cluster, right after Files
// (matching its original placement). It follows the last still-visible tool-group
// section so it stays put even when some of those sections are hidden.
const TOOL_GROUP: NavSection[] = ['priority', 'code', 'terminals', 'files']

interface Props {
  nav: NavSection
  onNavChange: (n: NavSection) => void
  activeAgentCount: number
  boxWebItem: { label: string } | null
  hiddenSections: NavSection[]
  onNewTask: () => void
  dailyNoteActive: boolean
  onDailyNoteOpen: () => void
  themeMode: ThemeMode
  onThemeModeChange: (m: ThemeMode) => void
}

export default function Sidebar({
  nav, onNavChange, activeAgentCount,
  boxWebItem, hiddenSections,
  onNewTask, dailyNoteActive, onDailyNoteOpen,
  themeMode, onThemeModeChange,
}: Props) {
  function cycleTheme() {
    const idx = THEME_CYCLE.indexOf(themeMode)
    onThemeModeChange(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length])
  }

  const hidden = new Set(hiddenSections)
  const visibleItems = NAV_ITEMS.filter(i => !hidden.has(i.key))

  let navItems: NavItem[] = visibleItems
  if (boxWebItem) {
    let insertAt = 0
    for (let i = 0; i < visibleItems.length; i++) {
      if (TOOL_GROUP.includes(visibleItems[i].key)) insertAt = i + 1
    }
    const boxWebEntry: NavItem = { key: 'boxWeb', icon: '▣', label: boxWebItem.label }
    navItems = [...visibleItems.slice(0, insertAt), boxWebEntry, ...visibleItems.slice(insertAt)]
  }

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
