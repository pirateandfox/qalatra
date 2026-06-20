// Agent-job and heartbeat (recurring agent run) types.

export interface AgentJob {
  id: string
  task_id: string | null
  agent_path: string
  prompt: string
  user_message: string | null
  session_id: string | null
  status: 'queued' | 'running' | 'done' | 'failed'
  result: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface Heartbeat {
  id: string
  title: string
  description: string | null
  agent_path: string
  prompt: string
  interval_minutes: number
  run_at_time: string | null
  minute_offset: number | null
  active: number
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  runs_done: number
  runs_failed: number
  runs_pending: number
}

export interface HeartbeatJob {
  id: string
  status: string
  result: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}
