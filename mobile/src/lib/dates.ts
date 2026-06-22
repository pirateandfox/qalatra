import { offsetDate, today } from '@qalatra/shared'

/** Next occurrence of a weekday (0=Sun … 6=Sat) as YYYY-MM-DD, always in the
 *  future (today never counts). */
export function nextWeekday(targetDow: number): string {
  const base = new Date(today() + 'T12:00:00')
  const cur = base.getDay()
  let delta = (targetDow - cur + 7) % 7
  if (delta === 0) delta = 7
  return offsetDate(today(), delta)
}

export const tomorrow = () => offsetDate(today(), 1)
export const thisWeekend = () => nextWeekday(6) // Saturday
export const nextWeekStart = () => nextWeekday(1) // Monday

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A short, human label for a YYYY-MM-DD date: "Today", "Tomorrow", or
 *  "Jun 23" / "Jun 23, 2027" when the year differs from the current one. */
export function formatDate(iso: string | null): string | null {
  if (!iso) return null
  if (iso === today()) return 'Today'
  if (iso === tomorrow()) return 'Tomorrow'
  const d = new Date(iso + 'T12:00:00')
  const now = new Date(today() + 'T12:00:00')
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`
}
