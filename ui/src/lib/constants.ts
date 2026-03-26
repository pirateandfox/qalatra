export const CONTEXT_COLORS: Record<string, string> = {
  monroe:       '#4f9cf9',
  biztobiz:     '#f9a94f',
  pirateandfox: '#a78bfa',
  flightdesk:   '#f472b6',
  silvermouse:  '#fb7185',
  personal:     '#4fcc8a',
  internal:     '#f472b6',
}

export const CONTEXT_LABELS: Record<string, string> = {
  monroe:       'Monroe Institute',
  biztobiz:     'Biz to Biz',
  pirateandfox: 'Pirate & Fox',
  flightdesk:   'FlightDesk',
  silvermouse:  'Silvermouse',
  personal:     'Personal',
  internal:     'Internal',
}

export const PRIORITY_COLORS: Record<number, string> = {
  1: '#ef4444',
  2: '#f97316',
  3: '#eab308',
  4: '#6b7280',
  5: '#374151',
}

export const ENERGY_ICONS: Record<string, string> = {
  high: '🔥',
  medium: '⚡',
  low: '🌿',
  async: '📬',
}

export const PLATFORMS = [
  { key: 'asana',      pattern: /asana\.com/,            label: 'Asana' },
  { key: 'missive',    pattern: /missiveapp\.com/,        label: 'Missive' },
  { key: 'notion',     pattern: /notion\.so/,             label: 'Notion' },
  { key: 'linear',     pattern: /linear\.app/,            label: 'Linear' },
  { key: 'github',     pattern: /github\.com/,            label: 'GitHub' },
  { key: 'slack',      pattern: /slack\.com/,             label: 'Slack' },
  { key: 'youtube',    pattern: /youtu\.be|youtube\.com/, label: 'YouTube' },
  { key: 'flightdesk', pattern: /flightdesk\.dev/,        label: 'FlightDesk' },
]

export function detectPlatform(url: string) {
  return PLATFORMS.find(p => p.pattern.test(url)) ?? { key: 'link', label: '🔗' }
}

export function today(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function offsetDate(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export function fmtTime(t: string | null): string {
  if (!t) return 'All day'
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}
