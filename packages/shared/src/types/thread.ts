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
  /** Set on a mirror: the API of the box that hosts (sequences) this thread. */
  home_url: string | null
  /** Set on a mirror: this box's name for the hosting box. */
  home_peer?: string | null
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
  /** Which box the participant is on, by this box's peer name; null = this box. */
  instance_name?: string | null
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
  /** The author's box by this box's peer name; null = this box. */
  author_instance?: string | null
  /** 'session' = posted by the owner's interactive Claude session (MCP, no job), not typed in the app. */
  via?: 'session' | null
  /** Pending messages only: delivery to the home box. */
  delivery_attempts?: number | null
  delivery_error?: string | null
  delivery_failed_at?: string | null
}

export interface ThreadDetail {
  thread: Thread
  participants: ThreadParticipant[]
  recent_messages: ThreadMessage[]
  /** On a mirror: messages written here that the home box has not numbered yet. */
  pending_messages?: ThreadMessage[]
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
  participants: Array<{ kind: 'agent'; agent: string } | { kind: 'instance'; name: string } | { kind: 'human'; name?: string }>
}

/** Another Qalatra box this one can thread with. The key it issued this box is never returned. */
export interface ThreadPeer {
  name: string
  url: string
  has_token: boolean
  last_ok_at: string | null
  last_error: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}

export interface ThreadPeerListing {
  instance_name: string | null
  peers: ThreadPeer[]
  /** Keys this box issued to peers (no secrets). */
  issued: Array<{ peer: string; created_at: string; last_used_at: string | null; expires_at: string | null }>
}
