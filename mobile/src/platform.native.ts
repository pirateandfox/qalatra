// React Native platform adapter for @qalatra/shared.
//
// Importing this module configures the shared core's platform seam for mobile.
//
//  - Storage is AsyncStorage, wrapped in an in-memory cache so the shared
//    instance logic can read synchronously. `hydrate(keys)` warms the cache once
//    at startup; the app awaits `hydrateInstances()` before rendering.
//  - BOTH the persistent and "session" stores are backed by AsyncStorage here:
//    on a phone you want the active connection to survive app restarts (unlike
//    the desktop, where "active" is intentionally session-scoped). The session
//    store uses a separate key namespace so it doesn't collide with the legacy
//    persistent active key the migration logic touches.
//  - capabilities.canManageLocalServer is false and resolveLocalInstance is
//    omitted — mobile is remote-only and never runs a local server.

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { configurePlatform, type Platform, type PlatformKV } from '@qalatra/shared'

function asyncStorageKV(namespace = ''): PlatformKV {
  const cache = new Map<string, string>()
  let hydrated = false
  const storageKey = (key: string) => `${namespace}${key}`

  return {
    getItem: key => (cache.has(key) ? cache.get(key)! : null),
    setItem: (key, value) => {
      cache.set(key, value)
      AsyncStorage.setItem(storageKey(key), value).catch(err =>
        console.warn('[qalatra] storage write failed for', key, err),
      )
    },
    removeItem: key => {
      cache.delete(key)
      AsyncStorage.removeItem(storageKey(key)).catch(err =>
        console.warn('[qalatra] storage remove failed for', key, err),
      )
    },
    hydrate: async keys => {
      if (hydrated) return
      const pairs = await AsyncStorage.multiGet(keys.map(storageKey))
      for (const [storedKey, value] of pairs) {
        if (value != null) cache.set(storedKey.slice(namespace.length), value)
      }
      hydrated = true
    },
  }
}

function secureStorageKV(namespace = ''): PlatformKV {
  const cache = new Map<string, string>()
  let hydrated = false
  const storageKey = (key: string) => `${namespace}${key}`

  return {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, value) => {
      cache.set(key, value)
      SecureStore.setItemAsync(storageKey(key), value).catch(err =>
        console.warn('[qalatra] secure storage write failed for', key, err),
      )
    },
    removeItem: key => {
      cache.delete(key)
      SecureStore.deleteItemAsync(storageKey(key)).catch(err =>
        console.warn('[qalatra] secure storage remove failed for', key, err),
      )
    },
    hydrate: async keys => {
      if (hydrated) return
      await Promise.all(keys.map(async key => {
        const value = await SecureStore.getItemAsync(storageKey(key))
        if (value != null) cache.set(key, value)
      }))
      hydrated = true
    },
  }
}

const nativePlatform: Platform = {
  persistent: asyncStorageKV(),
  secure: secureStorageKV('qalatra.secure:'),
  session: asyncStorageKV('qalatra.session:'),
  capabilities: { canManageLocalServer: false, requiresAccountAuth: true },
  account: {
    graphqlUrl: process.env.EXPO_PUBLIC_QALATRA_ACCOUNT_GRAPHQL_URL || 'https://api.qalatra.com/graphql',
    portalUrl: process.env.EXPO_PUBLIC_QALATRA_PORTAL_URL || 'https://qalatra.com',
    productKey: process.env.EXPO_PUBLIC_QALATRA_PRODUCT_KEY || 'connect',
  },
  // No resolveLocalInstance: mobile is remote-only.
}

configurePlatform(nativePlatform)
