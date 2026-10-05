// Qalatra's @mention source: tasks (remote search, active first), projects and
// contexts (cached lists filtered locally). Inserts plain text per PIR-84 —
// Qalatra has no internal link scheme for tasks yet, so no markdown links.

import { fetchContexts, fetchProjects, searchTasks } from '../../api'
import type { MentionItem, MentionProvider } from './mentionsPlugin'

const STATIC_TTL_MS = 60_000
let staticCache: { at: number; items: Promise<MentionItem[]> } | null = null

function loadStatic(): Promise<MentionItem[]> {
  if (staticCache && Date.now() - staticCache.at < STATIC_TTL_MS) return staticCache.items
  const items = Promise.all([
    fetchProjects().catch(() => []),
    fetchContexts().catch(() => []),
  ]).then(([projects, contexts]) => [
    ...projects.map((p): MentionItem => ({
      kind: 'project',
      id: p.name,
      label: p.name,
      insertText: p.name,
      detail: p.context ?? undefined,
    })),
    ...contexts.map((c): MentionItem => ({
      kind: 'context',
      id: c.slug,
      label: c.slug,
      insertText: c.slug,
      searchText: c.label,
      detail: c.label && c.label !== c.slug ? c.label : undefined,
    })),
  ])
  staticCache = { at: Date.now(), items }
  // Don't cache a failure for a full minute.
  items.then(list => { if (list.length === 0) staticCache = null })
  return items
}

// The server matches descriptions/notes too; the plugin keeps only title
// matches, so over-fetch a little to leave enough of those.
async function search(query: string): Promise<MentionItem[]> {
  const tasks = await searchTasks(query, 'open', 50)
  return tasks.map(t => ({
    kind: 'task',
    id: t.id,
    label: t.title,
    insertText: t.title,
    detail: t.status === 'active' ? (t.project ?? t.context) : t.status,
    rank: t.status === 'active' ? 0 : 1,
  }))
}

export const qalatraMentionProvider: MentionProvider = {
  groups: [
    { kind: 'task', label: 'Tasks', limit: 8 },
    { kind: 'project', label: 'Projects', limit: 5 },
    { kind: 'context', label: 'Contexts', limit: 5 },
  ],
  loadStatic,
  search,
  debounceMs: 150,
}
