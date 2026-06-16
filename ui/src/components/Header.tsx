import { useEffect, useState } from 'react'
import { offsetDate, today as todayStr } from '../lib/constants'
import {
  getActiveInstanceId,
  getHideLocalInstance,
  getInstances,
  onInstanceConfigChange,
  setActiveInstance,
  type QalatraInstance,
} from '../apiRuntime'
import type { NavSection } from './Sidebar'
import './Header.css'

interface Props {
  date: string
  nav: NavSection
  onDateChange: (d: string) => void
  onRefresh: () => void
}

const DATE_VIEWS: NavSection[] = ['priority', 'daily', 'habits']

function readInstanceState() {
  return {
    activeId: getActiveInstanceId(),
    hideLocal: getHideLocalInstance(),
    instances: getInstances(),
  }
}

export default function Header({ date, nav, onDateChange, onRefresh }: Props) {
  const today = todayStr()
  const prev = offsetDate(date, -1)
  const next = offsetDate(date, 1)
  const showDateNav = DATE_VIEWS.includes(nav)

  const [{ activeId, hideLocal, instances }, setInstanceState] = useState<{
    activeId: string | null
    hideLocal: boolean
    instances: QalatraInstance[]
  }>(() => readInstanceState())

  useEffect(() => onInstanceConfigChange(() => setInstanceState(readInstanceState())), [])

  function switchTo(id: string | null) {
    setActiveInstance(id)
    setInstanceState(readInstanceState())
    window.location.reload()
  }

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
      {instances.length > 0 && (
        <div className="instance-tabs">
          {!hideLocal && (
            <button
              className={`instance-tab${!activeId ? ' active' : ''}`}
              onClick={() => switchTo(null)}
            >
              Local
            </button>
          )}
          {instances.map(instance => (
            <button
              key={instance.id}
              className={`instance-tab${activeId === instance.id ? ' active' : ''}`}
              onClick={() => switchTo(instance.id)}
            >
              {instance.name}
            </button>
          ))}
        </div>
      )}
      <button className="nav-btn" onClick={onRefresh} title="Refresh (R)">↻</button>
    </header>
  )
}
