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
  agent_job_status?: 'queued' | 'running' | 'done' | 'failed' | null
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
