// Shared visual tokens for the mobile app — a dark palette aligned with the
// desktop UI (zinc + blue).

export const colors = {
  bg: '#0b0b0d',
  surface: '#18181b',
  surface2: '#1f1f23',
  border: '#27272a',
  borderStrong: '#3f3f46',
  text: '#fafafa',
  textDim: '#e4e4e7',
  muted: '#a1a1aa',
  muted2: '#71717a',
  accent: '#3b82f6',
  accentStrong: '#2563eb',
  danger: '#f87171',
  success: '#34d399',
  selected: '#1e293b',
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }
export const radius = { sm: 6, md: 8, lg: 12 }

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

export function priorityColor(p: number | null): string | null {
  if (p == null) return null
  return PRIORITY_COLORS[p] ?? null
}
