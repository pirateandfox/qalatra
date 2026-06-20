// Server/desktop infrastructure types: terminals, file browsing, Box Web, backups.
//
// These describe endpoints the mobile client will mostly NOT call (the terminal
// and file browser are desktop/server features), but the types live here so the
// shared API client that returns them can typecheck in one place. Sharing a type
// does not imply the mobile UI uses it.

export interface TerminalSession {
  id: string
  title: string
  cwd: string
  taskId: string | null
  agentPath: string | null
  tmuxSession: string
  createdAt: string
  lastActivityAt: string
  lastAttachedAt: string | null
  status: 'running' | 'exited'
}

export interface TerminalStatus {
  tmux: { ok: boolean; version: string | null; error: string | null }
  sessions: TerminalSession[]
}

export interface WorkspaceRoot {
  path: string
  name: string
  exists: boolean
  isDirectory: boolean
}

export interface DirectoryEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink'
  size: number | null
  modifiedAt: string | null
  extension: string
}

export interface BoxWebSession {
  url: string
  path: string
  expiresAt: string
  target: string
}

export interface BoxWebStatus {
  ok: boolean
  available: boolean
  target: string
  statusCode?: number | null
  error?: string
}

export interface BackupItem {
  key: string
  size: number
  date: string
}
