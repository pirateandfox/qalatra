import { useEffect, useRef } from 'react'
import { offsetDate, today } from '../lib/constants'
import { api } from '../api'
import './SnoozePopover.css'

interface Props {
  taskId: string
  anchorRect: DOMRect
  onClose: () => void
  onSnoozed: () => void
}

function localDatetimeStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function SnoozePopover({ taskId, anchorRect, onClose, onSnoozed }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('click', handler)
    document.addEventListener('keydown', keyHandler)
    return () => { document.removeEventListener('click', handler); document.removeEventListener('keydown', keyHandler) }
  }, [onClose])

  async function snoozeUntil(until: string) {
    await api.snooze(taskId, until)
    onSnoozed()
    onClose()
  }

  function snoozeInHours(h: number) {
    snoozeUntil(localDatetimeStr(new Date(Date.now() + h * 3600000)))
  }

  function snoozeToHour(hour: number) {
    const d = new Date()
    d.setHours(hour, 0, 0, 0)
    if (d <= new Date()) d.setDate(d.getDate() + 1)
    snoozeUntil(localDatetimeStr(d))
  }

  const style: React.CSSProperties = {
    top: anchorRect.bottom + window.scrollY + 6,
    left: Math.max(8, Math.min(anchorRect.left + window.scrollX, window.innerWidth - 260)),
  }

  const tomorrow = offsetDate(today(), 1)
  const daysUntilMonday = (8 - new Date().getDay()) % 7 || 7
  const nextMonday = offsetDate(today(), daysUntilMonday)
  const in2Days = offsetDate(today(), 2)

  return (
    <div className="snooze-popover" ref={ref} style={style} onClick={e => e.stopPropagation()}>
      <div className="snooze-presets">
        <button className="snooze-preset-btn" onClick={() => snoozeToHour(9)}>9am</button>
        <button className="snooze-preset-btn" onClick={() => snoozeToHour(14)}>2pm</button>
        <button className="snooze-preset-btn" onClick={() => snoozeInHours(1)}>1h</button>
        <button className="snooze-preset-btn" onClick={() => snoozeInHours(3)}>3h</button>
        <button className="snooze-preset-btn" onClick={() => snoozeUntil(tomorrow)}>Tomorrow</button>
        <button className="snooze-preset-btn" onClick={() => snoozeUntil(in2Days)}>+2 days</button>
        <button className="snooze-preset-btn" onClick={() => snoozeUntil(nextMonday)}>Next week</button>
      </div>
      <div className="snooze-row">
        <input
          ref={inputRef}
          type="date"
          className="snooze-date-input"
          defaultValue={tomorrow}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              const val = (e.target as HTMLInputElement).value
              if (val) snoozeUntil(val)
            }
          }}
        />
        <button className="snooze-confirm" onClick={e => {
          const input = (e.currentTarget.previousElementSibling as HTMLInputElement)
          if (input?.value) snoozeUntil(input.value)
        }}>Defer</button>
        <button className="snooze-cancel" onClick={onClose}>✕</button>
      </div>
    </div>
  )
}
