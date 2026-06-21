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
