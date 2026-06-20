// Habit domain types.

export interface HabitLog {
  status: 'done' | 'skipped'
  notes: string | null
}

export interface HabitWeekDay {
  date: string
  due: boolean
  log: HabitLog | null
}

export interface Habit {
  id: string
  title: string
  description: string | null
  recurrence: string
  recurrence_days: string | null
  today_log: HabitLog | null
  week: HabitWeekDay[]
}

/** Compact habit shape embedded in the day's TaskData payload. */
export interface HabitSummary {
  id: string
  title: string
  description: string | null
  recurrence: string
  today_log: { status: 'done' | 'skipped'; notes: string | null } | null
}
