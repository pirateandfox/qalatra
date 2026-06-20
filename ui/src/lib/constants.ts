// Pure date/time + platform-detection helpers now live in @qalatra/shared so the
// mobile app can reuse them; re-exported here so existing `./lib/constants`
// imports keep working. The colour/label/icon maps below are presentation and
// stay desktop-local.
export { PLATFORMS, detectPlatform, today, offsetDate, fmtTime } from '@qalatra/shared'

export const CONTEXT_COLORS: Record<string, string> = {}

export const CONTEXT_LABELS: Record<string, string> = {}

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
