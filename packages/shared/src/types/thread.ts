// Agent-to-agent threads (docs/agent-to-agent-threads.md).

export type ThreadStatus = 'open' | 'frozen' | 'closed'
export type ThreadParticipantKind = 'agent' | 'instance' | 'external' | 'human'

export interface ThreadPolicy {
  max_messages?: number | null
  max_message_bytes?: number | null
  expires_at?: string | null
}

export interface Thread {
  id: string
  subject: string
  task_id: string | null
  project: string | null
  context: string
  status: ThreadStatus
  opened_by: string | null
  home_url: string | null
  authority: string | null
  policy: ThreadPolicy
  decision: string | null
  decision_note_id: string | null
  closed_reason: string | null
  message_count: number
  last_message_at: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
  /** list only */
  participant_names?: string | null
  /** list only */
  unread_for_human?: number
}

export interface ThreadParticipant {
  id: string
  kind: ThreadParticipantKind
  display_name: string
  agent_path: string | null
  instance_url: string | null
  role: 'owner' | 'member' | 'observer'
  state: string
  last_read_seq: number
  invited_at: string
  joined_at: string | null
}

export interface ThreadMessage {
  id: string
  seq: number | null
  kind: 'message' | 'system' | 'decision'
  body: string
  redacted_count: number
  origin: 'local' | 'remote'
  created_at: string
  participant_id: string
  author: string
  author_kind: ThreadParticipantKind
}

export interface ThreadDetail {
  thread: Thread
  participants: ThreadParticipant[]
  recent_messages: ThreadMessage[]
}

export interface ThreadMessagePage {
  thread_id: string
  status: ThreadStatus
  messages: ThreadMessage[]
  next_since_seq: number
  has_more: boolean
}

export interface OpenThreadInput {
  subject: string
  task_id?: string | null
  participants: Array<{ kind: 'agent'; agent: string } | { kind: 'human'; name?: string }>
}
