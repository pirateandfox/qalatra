/** Task links are stored as a JSON array of strings or { url, label } objects —
 *  this mirrors the desktop DetailPanel's parsing and `.md` detection so the two
 *  clients treat the same data identically. */
export interface TaskLink {
  url: string
  label?: string
}

export function parseLinks(raw: string | null | undefined): TaskLink[] {
  try {
    const arr = JSON.parse(raw ?? '[]')
    if (!Array.isArray(arr)) return []
    return arr
      .map(l => (typeof l === 'string' ? { url: l } : (l as TaskLink)))
      .filter(l => l && typeof l.url === 'string' && l.url.length > 0)
  } catch {
    return []
  }
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** A markdown file we can render natively in the in-app reader. */
export function isMarkdownLink(url: string): boolean {
  return /\.md$/i.test(url)
}

/** A short, tappable label: the explicit label, the host+path for URLs, or the
 *  filename for file paths. */
export function linkLabel(link: TaskLink): string {
  if (link.label) return link.label
  if (isHttpUrl(link.url)) return link.url.replace(/^https?:\/\//i, '')
  return link.url.split(/[\\/]/).filter(Boolean).pop() || link.url
}
