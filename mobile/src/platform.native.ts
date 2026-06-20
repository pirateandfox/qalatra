// React Native platform adapter for @qalatra/shared.
//
// Importing this module configures the shared core's platform seam for mobile.
// Two differences from the desktop (web) adapter:
//
//  1. Storage is asynchronous (AsyncStorage), so the persistent store wraps it in
//     an in-memory cache. `hydrate(keys)` warms the cache once at startup; the
//     shared instance logic then reads synchronously exactly as on desktop. The
//     app MUST `await hydrateInstances()` before rendering instance-dependent UI.
//  2. capabilities.canManageLocalServer is false and resolveLocalInstance is
//     omitted — mobile is remote-only and never runs a local server.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { configurePlatform, type Platform, type PlatformKV } from '@qalatra/shared'

/** Persistent KV backed by AsyncStorage, served synchronously from a warmed cache. */
function asyncStorageKV(): PlatformKV {
  const cache = new Map<string, string>()
  let hydrated = false
  return {
    getItem: key => (cache.has(key) ? cache.get(key)! : null),
    setItem: (key, value) => {
      cache.set(key, value)
      void AsyncStorage.setItem(key, value).catch(() => {})
    },
    removeItem: key => {
      cache.delete(key)
      void AsyncStorage.removeItem(key).catch(() => {})
    },
    hydrate: async keys => {
      if (hydrated) return
      const pairs = await AsyncStorage.multiGet(keys as string[])
      for (const [key, value] of pairs) {
        if (value != null) cache.set(key, value)
      }
      hydrated = true
    },
  }
}

/** Session KV: in-memory only, cleared each app launch (mirrors web sessionStorage). */
function inMemoryKV(): PlatformKV {
  const cache = new Map<string, string>()
  return {
    getItem: key => (cache.has(key) ? cache.get(key)! : null),
    setItem: (key, value) => {
      cache.set(key, value)
    },
    removeItem: key => {
      cache.delete(key)
    },
  }
}

const nativePlatform: Platform = {
  persistent: asyncStorageKV(),
  session: inMemoryKV(),
  capabilities: { canManageLocalServer: false },
  // No resolveLocalInstance: mobile is remote-only.
}

configurePlatform(nativePlatform)
