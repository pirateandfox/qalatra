// Project and agent-definition types.

import type { Task } from './task'

export interface Project {
  name: string
  archived: number
  created_at: string
  is_repo: number
  context: string | null
}

export interface ProjectSummary {
  name: string
  context: string | null
  isRepo: boolean
  activeCount: number
  codingCount: number
  backlogCount: number
  agentCount: number
}

/** Agent definition as stored in the DB (raw row shape). */
export interface AgentRecord {
  path: string
  name: string
  context: string | null
  project: string | null
  description: string | null
  command: string | null
  coding: number
  relative_path: string | null
  folder: string | null
  last_seen: string
}

/** Agent definition as discovered on disk / normalized for the UI. */
export interface Agent {
  name: string
  context: string | null
  project: string | null
  description: string | null
  command: string | null
  coding: boolean
  path: string
  relativePath: string
  folder: string | null   // top-level project folder name (null for agents at the scan root)
}

export interface ProjectDetail {
  name: string
  context: string | null
  isRepo: boolean
  active: Task[]
  coding: Task[]
  backlog: Task[]
  doneRecent: Task[]
  agents: AgentRecord[]
}
