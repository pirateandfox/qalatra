// Desktop UI API surface.
//
// The portable client (types, instance/backend management, HTTP, endpoints) now
// lives in @qalatra/shared. This module re-exports it together with the
// Electron-only local-server controls and attachment opener, so existing UI
// imports from './api' keep working unchanged.
//
// The side-effect import below configures the shared platform adapter (storage +
// local-server fallback) before any re-exported API function is called.
import './platform.web'

export * from '@qalatra/shared'
export * from './localServer'
