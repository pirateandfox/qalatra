// @qalatra/shared — platform-agnostic core for the Qalatra desktop and mobile clients.
//
// This package is the single source of truth for types, the HTTP API client,
// backend/instance management, and domain logic shared between the Electron
// desktop UI (`ui/`) and the Expo mobile app (`mobile/`). It has NO dependency
// on React, the DOM, Electron, `window`, `localStorage`, or Node — all
// platform-specific behavior is reached through an injected platform adapter.
//
// Phase 0 scaffold only: the real surface (types, api, instances, logic) lands
// in Phase 1 of plan/EXPO_MOBILE_ROADMAP.md. Until then this barrel just proves
// the workspace is linked and typechecks.

/** Marker export so the workspace package resolves and typechecks before any
 *  real code is moved in. Removed once the Phase 1 barrels exist. */
export const SHARED_PACKAGE = '@qalatra/shared'
