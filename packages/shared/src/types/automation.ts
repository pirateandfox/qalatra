// Agent-job and heartbeat (recurring agent run) types.

export interface AgentJob {
  id: string
  task_id: string | null
  agent_path: string
  prompt: string
  user_message: string | null
  session_id: string | null
  // 'orphaned' = the app instance running the job stopped mid-run (restart/crash);
  // 'timed_out' = Qalatra's own timeout cut off an agent that was still working.
  // Both are resource/infrastructure events, not agent failures, and both keep failure counts
  // clean. See terminated_by/terminated_boundary.
  status: 'queued' | 'running' | 'done' | 'failed' | 'orphaned' | 'timed_out'
  result: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  // Which CLI adapter ran the job ('claude' | 'codex' | 'raw'). Null on jobs that predate the
  // runtime field. Recorded at run time, so it stays accurate if agent.config is later retargeted.
  runtime?: string | null
  // Cause of a non-failure termination (e.g. 'app_restart', 'timeout'); null for normal jobs.
  terminated_by?: string | null
  // started_at of the app instance that killed an orphaned job, so a consumer can tell
  // whether the job's work landed before or after the restart.
  terminated_boundary?: string | null
}

// Timestamps below are ISO-8601 with an explicit offset (`...Z` or `...-04:00`), stamped on the way
// out by withTimestampZones (server/task-logic.js). The stored columns are naive and mix zones by
// design — scheduler columns UTC, day-facing columns local — so always parse these as dates rather
// than comparing the strings, and never write one back into a query
// (docs/bug-heartbeat-timezone-mismatch.md).
export interface Heartbeat {
  id: string
  title: string
  description: string | null
  agent_path: string
  prompt: string
  interval_minutes: number
  run_at_time: string | null
  minute_offset: number | null
  // Cron schedule: a 5-field expression evaluated in an IANA timezone. When set it takes precedence
  // over interval_minutes/run_at_time/minute_offset. Null on interval heartbeats.
  cron_expression?: string | null
  timezone?: string | null
  active: number
  last_run_at: string | null
  next_run_at: string | null
  // Next three cron runs as ISO-8601 UTC; empty for interval heartbeats.
  upcoming_runs?: string[]
  created_at: string
  runs_done: number
  runs_failed: number
  runs_pending: number
}

export interface HeartbeatSchedulePreview {
  interval_minutes: number
  run_at_time: string | null
  minute_offset: number | null
  cron_expression: string | null
  timezone: string | null
  server_timezone: string
  upcoming_runs: string[]
}

export interface HeartbeatJob {
  id: string
  status: string
  result: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}
