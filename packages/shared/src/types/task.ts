// Task domain types — the core of the data model.

import type { HabitSummary } from './habit'

export interface Task {
  id: string
  title: string
  description: string | null
  status: 'active' | 'snoozed' | 'backlog' | 'done' | 'archived'
  context: string
  project: string | null
  tags: string | null
  source: string | null
  source_url: string | null
  source_id: string | null
  due_date: string | null
  hard_deadline: boolean | 0 | 1
  start_date: string | null
  surface_after: string | null
  last_reviewed_at: string | null
  stale?: boolean
  stale_days?: number | null
  review_threshold_days?: number | null
  blocked?: boolean
  blocked_by?: RelatedTask[]
  blocks?: RelatedTask[]
  my_priority: number | null
  energy_required: 'high' | 'medium' | 'low' | 'async' | null
  time_estimate: number | null
  task_type: 'task' | 'event' | 'reminder' | 'coding' | 'reading'
  event_time: string | null
  recurrence: string | null
  links: string // JSON array string
  ai_context: string | null
  created_at: string
  updated_at: string
  parent_id: string | null
  agent_path: string | null
  agent_resume: 1 | 0
  agent_autorun: 1 | 0
  agent_autorun_time: string | null
  agent_job_status?: 'queued' | 'running' | 'done' | 'failed' | 'orphaned' | null
  inbox: 0 | 1
  notes: string | null
}

export interface RelatedTask {
  id: string
  title: string
  status: string
  context: string | null
  project: string | null
  due_date: string | null
  hard_deadline?: boolean | 0 | 1
  completed?: boolean
  dependency_created_at?: string | null
}

export interface Attachment {
  id: string
  task_id: string
  filename: string
  mimetype: string | null
  size_bytes: number | null
  bucket: string | null
  key: string | null
  url: string | null
  local_path: string | null
  created_at: string
}

export interface Subtask {
  id: string
  title: string
  status: string
  parent_id: string
}

/** A free-text note attached to a task, authored by the user or an agent. */
export interface Note {
  id: string
  task_id: string
  body: string
  author: 'user' | 'agent'
  agent_job_id: string | null
  created_at: string
}

/** The grouped task payload for a given day/view, returned by `fetchTasks`. */
export interface TaskData {
  view: 'today' | 'future' | 'past'
  date: string
  inbox?: Task[]
  overdue?: Task[]
  dueToday?: Task[]
  active?: Task[]
  wakingUp?: Task[]
  doneToday?: Task[]
  scheduled?: Task[]
  timeSnoozed?: Task[]
  completed?: Task[]
  wasDue?: Task[]
  events?: Task[]
  reminders?: Task[]
  habits?: HabitSummary[]
}
