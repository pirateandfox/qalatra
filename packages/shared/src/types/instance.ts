// Connection/instance types: a Qalatra backend you connect to, its access
// tokens, and the server-sent event shape.

/** A Qalatra backend the client can connect to (URL + bearer token). */
export interface QalatraInstance {
  id: string
  name: string
  url: string
  token: string
  /**
   * @deprecated The "Tools" (boxWeb) sidebar item is now a per-backend client nav
   * preference (toolsEnabled/toolsLabel in each client's nav config), not connection
   * config. These fields remain only so existing values can be seeded into that config
   * once; nothing writes them anymore.
   */
  boxWebEnabled?: boolean
  /** @deprecated See boxWebEnabled. */
  boxWebLabel?: string
}

/** A revocable bearer token issued by a backend (Settings → Access Tokens). */
export interface AccessToken {
  id: string
  label: string
  scopes: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  expires_at: string | null
}

/** A frame from the backend's `/api/events` SSE stream. */
export interface ServerEvent {
  type?: string
  taskId?: string
  [key: string]: unknown
}
