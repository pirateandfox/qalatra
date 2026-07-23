// Per-backend navigation visibility/default config for the mobile app.
//
// Mirrors the desktop sidebar-config idea but adapted to mobile's two-level
// navigation (bottom tabs + a "More" menu). Stored app-locally in AsyncStorage
// (so it's per-device and never leaves the phone), but keyed by backend: the app
// holds a map of backend → config, so switching backends swaps the tab bar and
// More menu to that backend's view. A phone that talks to both a personal
// backend and a headless remote box shows a different set for each.
//
// Storage follows the app's existing hydrate pattern: an in-memory cache warmed
// once at startup (App awaits `hydrateNavConfig()`), read synchronously after,
// with a pub/sub so the navigator and More menu re-render — both when the config
// is edited and when the active backend changes.

import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { getActiveInstanceId, LOCAL_INSTANCE_ID, onInstanceConfigChange } from '@qalatra/shared'
import type { RootTabParamList } from '../navigation/types'

// Bottom-tab sections (the "More" tab is structural and always shown) plus the
// "More" menu content rows. Backends / Disconnect / this settings screen live in
// More too but are intentionally NOT toggleable, so you can always reach them to
// switch backends or turn sections back on.
// The "Tools" tab (boxWeb) is NOT a standard toggleable tab — it's an opt-in web
// tool with a custom label, handled by toolsEnabled/toolsLabel below (mirroring
// the desktop). So it's excluded from the standard tab set here.
export type TabSection = 'priority' | 'search' | 'reading'
export type MoreSection = 'dailyNote' | 'habits' | 'backlog' | 'code' | 'terminals' | 'files'
export type NavSection = TabSection | MoreSection

export interface NavConfigItem { key: NavSection; label: string; level: 'tab' | 'more' }

export const NAV_ITEMS: NavConfigItem[] = [
  { key: 'priority',  label: 'Priority',   level: 'tab' },
  { key: 'search',    label: 'Search',     level: 'tab' },
  { key: 'reading',   label: 'Reading',    level: 'tab' },
  { key: 'dailyNote', label: 'Daily Note', level: 'more' },
  { key: 'habits',    label: 'Habits',     level: 'more' },
  { key: 'backlog',   label: 'Backlog',    level: 'more' },
  { key: 'code',      label: 'Code',       level: 'more' },
  { key: 'terminals', label: 'Terminals',  level: 'more' },
  { key: 'files',     label: 'Files',      level: 'more' },
]

export const TAB_SECTIONS: TabSection[] = ['priority', 'search', 'reading']
export const TAB_ROUTE: Record<TabSection, keyof RootTabParamList> = {
  priority: 'PriorityTab',
  search: 'SearchTab',
  reading: 'ReadingTab',
}

const VALID = new Set<NavSection>(NAV_ITEMS.map(i => i.key))
const VALID_TABS = new Set<TabSection>(TAB_SECTIONS)
const DEFAULT_LANDING: TabSection = 'priority'
// Keyed-by-backend map (v2). Distinct from any earlier single-config key so a
// stale value can never be misread as a backend map.
const STORAGE_KEY = 'qalatra.navConfigByBackend'

export interface NavConfig {
  /** Sections hidden from the tab bar / More menu. Never contains `landing`. */
  hidden: NavSection[]
  /** Bottom tab that loads on launch. Always visible. */
  landing: TabSection
  /** Whether the opt-in "Tools" (boxWeb) tab is shown. */
  toolsEnabled: boolean
  /** Label for the Tools tab. Default "Tools". */
  toolsLabel: string
}

// Coerce any (possibly stale or hand-edited) config into a coherent one:
// only known sections in `hidden`, a valid tab for `landing`, and the landing
// forced visible so the app can never launch into a hidden tab.
//
// toolsEnabled defaults to TRUE on mobile to preserve the historical behavior
// (the Tools tab was always shown here), unlike desktop where boxWeb was opt-in.
export function normalizeNavConfig(raw: Partial<NavConfig> | null | undefined): NavConfig {
  const hidden = new Set<NavSection>(
    Array.isArray(raw?.hidden) ? raw!.hidden.filter((s): s is NavSection => VALID.has(s as NavSection)) : [],
  )
  const landing: TabSection = raw?.landing && VALID_TABS.has(raw.landing) ? raw.landing : DEFAULT_LANDING
  hidden.delete(landing)
  const toolsEnabled = raw?.toolsEnabled === undefined ? true : raw.toolsEnabled === true
  const toolsLabel = typeof raw?.toolsLabel === 'string' ? raw.toolsLabel : 'Tools'
  return { hidden: [...hidden], landing, toolsEnabled, toolsLabel }
}

/** The Tools tab's display label, falling back to "Tools" when unset/blank. */
export function toolsLabelOrDefault(config: NavConfig): string {
  return config.toolsLabel.trim() || 'Tools'
}

type ConfigMap = Record<string, NavConfig>

/** Stable storage key for the active backend, collapsing local-server aliases. */
function backendKey(): string {
  try {
    return getActiveInstanceId() ?? LOCAL_INSTANCE_ID
  } catch {
    return LOCAL_INSTANCE_ID
  }
}

let map: ConfigMap = {}
// `resolved` is the active backend's normalized config, held as a stable
// reference so useSyncExternalStore's snapshot only changes when it actually does.
let resolved: NavConfig = normalizeNavConfig(null)
let hydrated = false
const listeners = new Set<() => void>()
let unsubscribeInstance: (() => void) | null = null

function recompute(): void {
  const next = normalizeNavConfig(map[backendKey()])
  if (JSON.stringify(next) !== JSON.stringify(resolved)) {
    resolved = next
    listeners.forEach(l => l())
  }
}

export async function hydrateNavConfig(): Promise<void> {
  if (hydrated) return
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? 'null')
    map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    map = {}
  }
  hydrated = true
  resolved = normalizeNavConfig(map[backendKey()])
  // Follow backend switches so the tab bar / More menu reflect the active backend.
  if (!unsubscribeInstance) unsubscribeInstance = onInstanceConfigChange(recompute)
}

export function getNavConfig(): NavConfig {
  return resolved
}

export function setNavConfig(next: Partial<NavConfig>): void {
  const key = backendKey()
  map[key] = normalizeNavConfig(next)
  resolved = map[key]
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(map)).catch(err =>
    console.warn('[qalatra] navConfig write failed', err),
  )
  listeners.forEach(l => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reactive hook: re-renders the consumer when the nav config changes. */
export function useNavConfig(): NavConfig {
  return useSyncExternalStore(subscribe, getNavConfig)
}

export function isHidden(config: NavConfig, key: NavSection): boolean {
  return config.hidden.includes(key)
}
