// Pure date/time helpers shared across desktop and mobile.

/** Today as a local `YYYY-MM-DD` string. */
export function today(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Shift a `YYYY-MM-DD` date by `days` (noon-anchored to avoid DST edge cases). */
export function offsetDate(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Format a `HH:MM` time as `h:MM AM/PM`; null → "All day". */
export function fmtTime(t: string | null): string {
  if (!t) return 'All day'
  const [h = 0, m = 0] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}
