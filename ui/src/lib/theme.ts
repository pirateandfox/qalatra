export const TOKEN_KEYS = [
  'bg', 'surface', 'surface2', 'border', 'text', 'muted', 'accent', 'panelBg', 'inputBg',
] as const

export type TokenKey = typeof TOKEN_KEYS[number]
export type ThemeTokens = Record<TokenKey, string>
export type ThemeMode = 'system' | 'light' | 'dark'

export const TOKEN_LABELS: Record<TokenKey, string> = {
  bg: 'Background',
  surface: 'Surface',
  surface2: 'Surface Alt',
  border: 'Border',
  text: 'Text',
  muted: 'Muted Text',
  accent: 'Accent',
  panelBg: 'Panel Background',
  inputBg: 'Input Background',
}

export const DARK_TOKENS: ThemeTokens = {
  bg: '#0f1117',
  surface: '#1a1d27',
  surface2: '#22263a',
  border: '#2e3250',
  text: '#e2e8f0',
  muted: '#64748b',
  accent: '#4f9cf9',
  panelBg: '#0d1117',
  inputBg: '#161b22',
}

export const LIGHT_TOKENS: ThemeTokens = {
  bg: '#f4f5f7',
  surface: '#ffffff',
  surface2: '#f0f2f5',
  border: '#d1d5db',
  text: '#111827',
  muted: '#6b7280',
  accent: '#2563eb',
  panelBg: '#f8fafc',
  inputBg: '#ffffff',
}

export function getPresetTokens(mode: 'light' | 'dark'): ThemeTokens {
  return mode === 'dark' ? { ...DARK_TOKENS } : { ...LIGHT_TOKENS }
}

export function getSystemMode(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function buildTokens(mode: ThemeMode, overrides: Partial<ThemeTokens>): ThemeTokens {
  const effective = mode === 'system' ? getSystemMode() : mode
  return { ...getPresetTokens(effective), ...overrides }
}

export function applyTokens(tokens: ThemeTokens) {
  const root = document.documentElement
  root.style.setProperty('--bg', tokens.bg)
  root.style.setProperty('--surface', tokens.surface)
  root.style.setProperty('--surface2', tokens.surface2)
  root.style.setProperty('--border', tokens.border)
  root.style.setProperty('--text', tokens.text)
  root.style.setProperty('--muted', tokens.muted)
  root.style.setProperty('--accent', tokens.accent)
  root.style.setProperty('--panel-bg', tokens.panelBg)
  root.style.setProperty('--input-bg', tokens.inputBg)
}

const MODE_KEY = 'task-os-theme-mode'
const OVERRIDES_KEY = 'task-os-theme-overrides'

export function loadThemeFromStorage(): { mode: ThemeMode; overrides: Partial<ThemeTokens> } {
  const mode = (localStorage.getItem(MODE_KEY) as ThemeMode | null) ?? 'system'
  let overrides: Partial<ThemeTokens> = {}
  try { overrides = JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? '{}') } catch { /* ignore invalid JSON */ }
  return { mode, overrides }
}

export function saveModeToStorage(mode: ThemeMode) {
  localStorage.setItem(MODE_KEY, mode)
}

export function saveOverridesToStorage(overrides: Partial<ThemeTokens>) {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides))
}
