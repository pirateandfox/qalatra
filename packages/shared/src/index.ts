// @qalatra/shared — platform-agnostic core for the Qalatra desktop and mobile clients.
//
// This package is the single source of truth for types, the HTTP API client,
// backend/instance management, and domain logic shared between the Electron
// desktop UI (`ui/`) and the Expo mobile app (`mobile/`). It has NO dependency
// on React, the DOM, Electron, `window`, `localStorage`, or Node — all
// platform-specific behavior is reached through an injected platform adapter.
//
// @qalatra/shared public surface (Phase 1, see plan/EXPO_MOBILE_ROADMAP.md):
// domain types, the platform adapter seam, instance/backend management + HTTP
// runtime, and the API client. The host (Electron desktop or Expo mobile)
// installs a platform adapter via configurePlatform() at startup; `ui/` switches
// over to consuming this package in Phase 2.

export * from './types'
export * from './platform'
export * from './emitter'
export * from './runtime'
export * from './api'
export * from './account'
export * from './logic'
