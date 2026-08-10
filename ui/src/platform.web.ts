// Web/Electron platform adapter for @qalatra/shared.
//
// Importing this module configures the shared core's platform seam. It is a thin
// pass-through to the browser's synchronous localStorage / sessionStorage (so
// instance/backend behavior is identical to the pre-extraction desktop app), and
// it wires the Electron-managed local server in as the local-instance fallback.
//
// ui/src/api.ts imports this for its side effect so the platform is configured
// before any shared API call runs.

import { configurePlatform, type Platform, type PlatformKV } from '@qalatra/shared'
import { resolveLocalServerInstance } from './localServer'

const localStorageKV: PlatformKV = {
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: key => localStorage.removeItem(key),
}

const sessionStorageKV: PlatformKV = {
  getItem: key => sessionStorage.getItem(key),
  setItem: (key, value) => sessionStorage.setItem(key, value),
  removeItem: key => sessionStorage.removeItem(key),
}

const requiresAccountAuth = import.meta.env.VITE_QALATRA_ACCOUNT_AUTH === 'true'

const webPlatform: Platform = {
  persistent: localStorageKV,
  session: sessionStorageKV,
  capabilities: {
    canManageLocalServer: !requiresAccountAuth,
    requiresAccountAuth,
  },
  account: requiresAccountAuth
    ? {
        graphqlUrl: import.meta.env.VITE_QALATRA_ACCOUNT_GRAPHQL_URL || 'https://api.qalatra.com/graphql',
        portalUrl: import.meta.env.VITE_QALATRA_PORTAL_URL || 'https://qalatra.com',
        productKey: import.meta.env.VITE_QALATRA_PRODUCT_KEY || 'connect',
      }
    : undefined,
  resolveLocalInstance: requiresAccountAuth ? undefined : resolveLocalServerInstance,
}

configurePlatform(webPlatform)
