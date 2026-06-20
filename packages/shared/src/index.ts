// @qalatra/shared — platform-agnostic core for the Qalatra desktop and mobile clients.
//
// This package is the single source of truth for types, the HTTP API client,
// backend/instance management, and domain logic shared between the Electron
// desktop UI (`ui/`) and the Expo mobile app (`mobile/`). It has NO dependency
// on React, the DOM, Electron, `window`, `localStorage`, or Node — all
// platform-specific behavior is reached through an injected platform adapter.
//
// Phase 1 (in progress, see plan/EXPO_MOBILE_ROADMAP.md): domain types are
// extracted here first. The API client, instance/backend management, platform
// adapter, and logic helpers land in the following sub-steps. `ui/` does not yet
// consume this package — that switch-over is Phase 2.

export * from './types'
