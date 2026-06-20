// Platform adapter — the single seam between the platform-agnostic shared core
// and the host (Electron desktop or Expo mobile). The host constructs a Platform
// and calls configurePlatform() once at startup; the shared core reaches all
// platform-specific behavior through it and never touches window/localStorage/
// AsyncStorage/Electron directly.

import type { QalatraInstance } from './types'

/**
 * A key/value store with SYNCHRONOUS reads.
 *
 * - Web: a thin pass-through to localStorage / sessionStorage — `hydrate` is
 *   omitted because reads are already synchronous (behavior identical to the
 *   original desktop code).
 * - Native: wraps AsyncStorage with an in-memory cache. `hydrate(keys)` loads
 *   those keys into the cache once at startup; thereafter getItem reads the
 *   cache synchronously and setItem writes the cache + persists asynchronously.
 */
export interface PlatformKV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Optional async warm-up (native only). Web omits it; callers treat as no-op. */
  hydrate?(keys: readonly string[]): Promise<void>
}

export interface PlatformCapabilities {
  /**
   * Whether this platform can boot/manage a bundled local Qalatra server.
   * True on Electron desktop; false on mobile (which is remote-only and has no
   * `local-server` instance).
   */
  canManageLocalServer: boolean
}

export interface Platform {
  /** Survives app restarts (localStorage / AsyncStorage). */
  persistent: PlatformKV
  /** Cleared on app restart (sessionStorage / in-memory). */
  session: PlatformKV
  capabilities: PlatformCapabilities
  /**
   * Resolve the implicit local-server instance to use when no remote instance is
   * active. Desktop injects the Electron-managed local server here; mobile leaves
   * it undefined so the client reports "no server available" instead.
   */
  resolveLocalInstance?: () => Promise<QalatraInstance>
}

let current: Platform | null = null

/** Install the host platform adapter. Call once, before any API/instance use. */
export function configurePlatform(platform: Platform): void {
  current = platform
}

/** Get the configured platform, throwing if the host forgot to configure it. */
export function getPlatform(): Platform {
  if (!current) {
    throw new Error(
      '@qalatra/shared: platform not configured — call configurePlatform() at app startup.',
    )
  }
  return current
}
