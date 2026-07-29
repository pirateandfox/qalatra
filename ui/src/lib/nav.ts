// Canonical sidebar navigation vocabulary + per-backend visibility/default config.
//
// Sidebar visibility is client chrome, so the config is stored app-locally
// (localStorage) rather than in the server settings.json — but it is keyed by
// backend. Each install holds a map of backend → config, so switching backends
// swaps the sidebar to that backend's view: a personal backend can show
// everything while a headless remote box hides Reading/Backlog/Habits/etc. The
// active backend is resolved via @qalatra/shared's instance layer.
//
// This is the single per-backend nav-preferences store. The dynamic "Tools"
// (boxWeb) item — an opt-in web tool with a custom label — used to be configured
// separately on the instance record (`boxWebEnabled`/`boxWebLabel`); it now lives
// here too, as `toolsEnabled`/`toolsLabel`, so all nav config is in one place.
// Legacy instance values are seeded in once (see getSidebarConfig).

import { getActiveInstanceId, getInstances, LOCAL_INSTANCE_ID } from '@qalatra/shared'

export type NavSection =
  | 'priority' | 'daily' | 'code' | 'terminals' | 'files' | 'boxWeb'
  | 'reading' | 'project' | 'backlog' | 'habits' | 'heartbeats' | 'settings'

export interface NavItem { key: NavSection; icon: string; label: string }

// The sidebar sections the user can show/hide and choose a default from.
// Excludes the dynamic Tools/boxWeb item and the action buttons (Daily Note,
// Settings, Theme), which are handled separately and are always available.
export const NAV_ITEMS: NavItem[] = [
  { key: 'priority',   icon: '★',  label: 'Priority' },
  { key: 'code',       icon: '⌨',  label: 'Code' },
  { key: 'terminals',  icon: '_$', label: 'Terminals' },
  { key: 'files',      icon: '▤',  label: 'Files' },
  { key: 'reading',    icon: '📖', label: 'Reading' },
  { key: 'project',    icon: '⊞',  label: 'Projects' },
  { key: 'backlog',    icon: '≡',  label: 'Backlog' },
  { key: 'habits',     icon: '◎',  label: 'Habits' },
  { key: 'heartbeats', icon: '⚡', label: 'Heartbeats' },
]

export const TOGGLEABLE_SECTIONS: NavSection[] = NAV_ITEMS.map(i => i.key)
const VALID = new Set<NavSection>(TOGGLEABLE_SECTIONS)

const DEFAULT_LANDING: NavSection = 'priority'
// Keyed-by-backend map (v2). Distinct from any earlier single-config key so a
// stale value can never be misread as a backend map.
const STORAGE_KEY = 'qalatra.sidebarConfigByBackend'

export interface SidebarConfig {
  /** Sections hidden from the sidebar. Never contains `landing`. */
  hidden: NavSection[]
  /** Section that loads on launch. Always visible. */
  landing: NavSection
  /** Whether the opt-in "Tools" (boxWeb) web item is shown. Default off. */
  toolsEnabled: boolean
  /** Label for the Tools item. Default "Tools". */
  toolsLabel: string
}

// Coerce any (possibly stale or hand-edited) config into a coherent one:
//  - `hidden` keeps only known, toggleable sections
//  - `landing` is a known section (falls back to Priority)
//  - the landing is forced visible, so the app can never boot into nothing and
//    the "default is always shown" invariant holds no matter what.
//  - `toolsEnabled` is strictly boolean (default off); `toolsLabel` is non-empty.
export function normalizeSidebarConfig(raw: Partial<SidebarConfig> | null | undefined): SidebarConfig {
  const hidden = new Set<NavSection>(
    Array.isArray(raw?.hidden) ? raw!.hidden.filter((s): s is NavSection => VALID.has(s as NavSection)) : [],
  )
  const landing: NavSection = raw?.landing && VALID.has(raw.landing) ? raw.landing : DEFAULT_LANDING
  hidden.delete(landing)
  // Keep the raw label (even mid-edit empty) so typing stays smooth; callers fall
  // back to "Tools" for display via toolsLabelOrDefault.
  const toolsLabel = typeof raw?.toolsLabel === 'string' ? raw.toolsLabel : 'Tools'
  return { hidden: [...hidden], landing, toolsEnabled: raw?.toolsEnabled === true, toolsLabel }
}

/** The Tools item's display label, falling back to "Tools" when unset/blank. */
export function toolsLabelOrDefault(config: SidebarConfig): string {
  return config.toolsLabel.trim() || 'Tools'
}

type ConfigMap = Record<string, SidebarConfig>

/** Stable storage key for the active backend, collapsing local-server aliases. */
export function activeBackendKey(): string {
  try {
    return getActiveInstanceId() ?? LOCAL_INSTANCE_ID
  } catch {
    return LOCAL_INSTANCE_ID
  }
}

function loadMap(): ConfigMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ConfigMap) : {}
  } catch {
    return {}
  }
}

function saveMap(map: ConfigMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* localStorage unavailable or over quota — non-fatal, config just won't persist */
  }
}

/** The normalized sidebar config for a backend (defaults to the active one). */
export function getSidebarConfig(backendKey: string = activeBackendKey()): SidebarConfig {
  const stored = loadMap()[backendKey]
  // One-time seed: adopt the legacy per-instance boxWeb toggle/label the first
  // time we resolve a backend with no Tools setting stored yet, so an existing
  // "Tools" sidebar item survives boxWeb moving off the instance record. Once the
  // config is saved back (below), the map is the sole source of truth.
  if (stored?.toolsEnabled === undefined) {
    const legacy = getInstances().find(i => i.id === backendKey)
    if (legacy?.boxWebEnabled !== undefined) {
      return normalizeSidebarConfig({ ...stored, toolsEnabled: legacy.boxWebEnabled, toolsLabel: legacy.boxWebLabel })
    }
  }
  return normalizeSidebarConfig(stored)
}

/** Persist the sidebar config for a backend (defaults to the active one). */
export function saveSidebarConfig(config: SidebarConfig, backendKey: string = activeBackendKey()): void {
  const map = loadMap()
  map[backendKey] = normalizeSidebarConfig(config)
  saveMap(map)
}

// --- Per-backend last-active tab -------------------------------------------
//
// Switching backends triggers a full page reload, which would otherwise always
// drop you on the backend's landing tab. To let each backend remember where you
// left off, we persist the last-active nav section per backend (same keying as
// the sidebar config) and restore it on boot. Settings is intentionally never
// remembered, so returning to a backend restores your last *content* view.

const LAST_NAV_KEY = 'qalatra.lastNavByBackend'

function loadNavMap(): Record<string, NavSection> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_NAV_KEY) ?? 'null')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, NavSection>) : {}
  } catch {
    return {}
  }
}

/**
 * Whether a nav section is a valid place to land for a given backend config:
 * a visible toggleable section, the Tools item when enabled, or the Daily Note.
 * Settings and unknown/hidden sections are not landable (fall back to landing).
 */
function isLandable(nav: NavSection, config: SidebarConfig): boolean {
  if (nav === 'daily') return true
  if (nav === 'boxWeb') return config.toolsEnabled
  return VALID.has(nav) && !config.hidden.includes(nav)
}

/** Remember the last-active tab for a backend. 'settings' is never persisted. */
export function saveLastNav(nav: NavSection, backendKey: string = activeBackendKey()): void {
  if (nav === 'settings') return
  try {
    const map = loadNavMap()
    map[backendKey] = nav
    localStorage.setItem(LAST_NAV_KEY, JSON.stringify(map))
  } catch {
    /* localStorage unavailable or over quota — non-fatal, tab just won't persist */
  }
}

/**
 * The tab a backend should open on: its remembered last-active tab when that's
 * still a valid place to land, otherwise the backend's configured landing tab.
 */
export function resolveInitialNav(config: SidebarConfig, backendKey: string = activeBackendKey()): NavSection {
  const last = loadNavMap()[backendKey]
  return last && isLandable(last, config) ? last : config.landing
}
