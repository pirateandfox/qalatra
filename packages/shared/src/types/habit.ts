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

/** One day of a habit's range history (GET /api/v1/habits/:id/history). */
export interface HabitHistoryDay {
  date: string
  /** Counted as due: scheduled, not in the future, and on/after the habit existed (or logged). */
  due: boolean
  status: 'done' | 'skipped' | null
  future?: boolean
  notes?: string
}

/** A habit's stats and per-day rows over a date range — backs the year heatmap. */
export interface HabitHistory {
  id: string
  title: string
  recurrence: string
  recurrence_days: string | null
  created_at: string
  start: string
  end: string
  days_due: number
  days_done: number
  days_skipped: number
  days_missed: number
  /** Percent of due days done, or null when nothing was due. */
  completion_rate: number | null
  current_streak: number
  longest_streak: number
  days: HabitHistoryDay[]
}

/** Compact habit shape embedded in the day's TaskData payload. */
export interface HabitSummary {
  id: string
  title: string
  description: string | null
  recurrence: string
  today_log: { status: 'done' | 'skipped'; notes: string | null } | null
}
