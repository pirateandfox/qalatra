# Qalatra — Expo Mobile Roadmap

Plan for shipping native **iPhone / iPad / Android** apps alongside the existing
Electron desktop app, by extracting a shared TypeScript core and building a new
Expo (React Native) client on top of it.

**Core principle (inherited from ARCHITECTURE.md): evolve, don't rewrite.** The
desktop app stays in daily use and untouched in behavior; the mobile app reuses
the proven data + connection layer verbatim and only rebuilds the UI.

---

## Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Mobile framework | **Expo (React Native)** | Native feel, real push, Justin has deep Expo experience |
| Repo strategy | **Same repo** (it's already a monorepo: server/ui/mcp/electron) | Atomic cross-cutting changes; matches existing structure |
| Code sharing | **Share the non-visual core, not the UI** | RN can't reuse `<div>`+CSS; desktop vs mobile UX diverge anyway |
| Mobile backend model | **Remote-only client** | Never runs a local server. Always connects to a headless backend by URL + token, exactly like Electron's remote-instance mode — minus the `local-server` instance |
| Feature scope | **Near feature-parity**, iPad-forward | iPad is roomy enough to host the heavier views |
| Phone vs iPad | **One app, adaptive by width** (not two apps) | Less work than two binaries; divergence isolated to one shell |

---

## Target structure

```
qalatra/
├── packages/
│   └── shared/                 ← NEW: platform-agnostic TypeScript core
│       ├── src/
│       │   ├── types/          ← Task, TaskData, Context, Project, Agent, Habit, Note, Heartbeat …
│       │   ├── api.ts          ← all fetch() calls (was ui/src/api.ts)
│       │   ├── instances.ts    ← backend list / switch / token store (was ui/src/apiRuntime.ts, minus local-server)
│       │   ├── platform.ts     ← Platform adapter INTERFACE (storage + capabilities + emitter)
│       │   ├── emitter.ts      ← tiny pub/sub (replaces window.dispatchEvent for change notifications)
│       │   └── logic/          ← date helpers, sort, constants, recurrence text, detectPlatform
│       └── package.json        ← name: "@qalatra/shared"
├── ui/                         ← Electron desktop UI (existing) — consumes @qalatra/shared
│   └── src/platform.web.ts     ← localStorage + { canRunLocalServer: true } + local-server instance
├── mobile/                     ← NEW: Expo app — consumes @qalatra/shared
│   └── src/platform.native.ts  ← AsyncStorage + { canRunLocalServer: false }
├── electron-main.js            ← unchanged
├── server/  db-worker.js  mcp/ ← unchanged (the headless backend mobile talks to)
└── package.json                ← root: add "workspaces": ["packages/*", "ui", "mobile"]
```

`@qalatra/shared` has **zero** dependencies on React, the DOM, Electron, `window`,
`localStorage`, Node, or `fetch`-environment specifics beyond the global `fetch`
(present in browsers, Electron, and RN/Hermes). Everything platform-specific is
reached through the injected platform adapter.

---

## The two hard seams (solve these first)

### 1. Storage: sync `localStorage` → async `AsyncStorage`

`apiRuntime.ts` today calls `localStorage.getItem(...)` **synchronously** all over
(`getInstances()`, `getActiveInstanceId()`, etc.), and 30 call sites assume those
return values immediately. RN's `AsyncStorage` is **promise-based**. We will NOT
sprinkle `await` through everything.

**Pattern: hydrate-once, then serve from an in-memory cache.**

- `platform.storage` interface exposes async `load()` / `save()`.
- On app startup, `instances.ts` calls `await hydrate()` once, pulling persisted
  state into an in-memory object.
- All existing **getters stay synchronous**, reading from that in-memory cache.
- **Writes** update the cache synchronously *and* fire `platform.storage.save()`
  (fire-and-forget, awaited only where correctness needs it).

Web's adapter wraps `localStorage` (so hydrate resolves instantly); native's
wraps `AsyncStorage`. The synchronous public API of `instances.ts` is preserved,
so the 30 call sites don't change.

### 2. Change notification: `window` events → tiny emitter

`apiRuntime.ts` uses `window.dispatchEvent(new Event(...))` +
`window.addEventListener` for `onInstanceConfigChange`. There's no `window` in RN.

Replace with a 15-line `emitter.ts` (subscribe/emit). `onInstanceConfigChange`
becomes `emitter.on('instance-config', cb)`. React (both platforms) subscribes via
`useSyncExternalStore`. No DOM dependency.

---

## The capabilities seam (remote-only mobile)

`platform.capabilities` is a small object the shared core reads:

| Capability | Web (Electron) | Native (mobile) |
|---|---|---|
| `canRunLocalServer` | `true` | `false` |
| `localInstance` | synthetic `local-server` instance injected into the list | **absent** |

- The `local-server` synthetic instance + its lifecycle controls
  (`startLocalServer`, `startLocalServerService`, `stopLocalServerService`) **stay
  in `ui/`** — they never enter `@qalatra/shared`.
- `instances.ts` builds its instance list from persisted remote backends, then
  conditionally prepends `platform.capabilities.localInstance` if present.
- On mobile, the instance switcher therefore shows only remote backends you've
  added a token for. First-run onboarding = "paste a Qalatra server URL + token"
  (QR-paste later), which mirrors how Electron adds a remote instance today.

---

## Phases

### Phase 0 — Workspace foundation (no behavior change)
- [ ] Add `"workspaces": ["packages/*", "ui", "mobile"]` to root `package.json`.
- [ ] Create `packages/shared` with `package.json` (`@qalatra/shared`), `tsconfig`,
      and a build/typecheck script. No code moved yet — just the empty package
      wired into the workspace.
- [ ] Verify `npm run electron-dev` and `npm run build` still work unchanged.
- [ ] Update `scripts/check-imports.mjs` / electron-builder `files:` awareness if
      any root import paths shift (they shouldn't in Phase 0).

### Phase 1 — Extract `@qalatra/shared`
- [ ] **Types first.** Move `ui/src/types/task.ts` + the ~20 inline interfaces
      out of `api.ts` into `packages/shared/src/types/`. Re-export from a barrel.
- [ ] Move `api.ts` → `packages/shared/src/api.ts`. Replace its direct
      `apiRuntime`/`localStorage`/`window` reach-throughs with the platform
      adapter + `instances.ts`.
- [ ] Move `apiRuntime.ts` → `packages/shared/src/instances.ts`. Apply the
      hydrate-once cache pattern; extract `local-server` specifics behind
      `platform.capabilities`.
- [ ] Define `platform.ts` (the adapter interface) + `emitter.ts`.
- [ ] Move portable helpers from `ui/src/lib/constants.ts` (`today`, `offsetDate`,
      `fmtTime`, `detectPlatform`, color/label maps) → `packages/shared/src/logic/`.
- [ ] `@qalatra/shared` typechecks standalone with **no** web/Electron imports.

### Phase 2 — Point Electron UI at the shared core (prove it)
- [ ] Add `ui/src/platform.web.ts`: `localStorage` storage adapter,
      `{ canRunLocalServer: true }`, the `local-server` synthetic instance, and the
      `startLocalServer*` wiring.
- [ ] Replace `ui/src` imports of `./api` / `./apiRuntime` / moved helpers with
      `@qalatra/shared`. Inject `platform.web` at app entry.
- [ ] **Acceptance: desktop app behaves identically.** Manually verify instance
      switching, remote backends, hide-local-instance, token auth, Box Web — zero
      regressions. This phase ships nothing new; it de-risks the extraction by
      proving the shared core against the real, working desktop app.

### Phase 3 — Expo app skeleton
- [ ] `mobile/` Expo app (Expo Router, TypeScript). Set
      `ios.supportsTablet: true` in `app.json`.
- [ ] Add `mobile/src/platform.native.ts`: AsyncStorage adapter,
      `{ canRunLocalServer: false }`, no local instance.
- [ ] Onboarding screen: paste server URL + token → validates against the headless
      API → stores as a remote instance via the shared `instances.ts`.
- [ ] Remote-only instance switcher (reuses shared instance list).
- [ ] Prove the loop: app fetches `getTodaysTasks` from a real backend and renders
      a bare list. (Core layer working end-to-end on device.)

### Phase 4 — Adaptive shell + core screens
- [ ] `useLayout()` hook: `twoPane = width >= ~768` via `useWindowDimensions()`
      (branch on **width, never `Platform.isPad`** — handles iPad Split View).
- [ ] `AppShell`: `twoPane` → master-detail (list + detail pane, mirroring the
      desktop `TaskList` + `DetailPanel`); compact → stacked nav that pushes the
      same detail content as a route.
- [ ] Build leaf screens as layout-agnostic, prop-driven components:
      Today / Waking Up list, task detail + notes, quick capture, triage,
      morning / EOD briefings.

### Phase 5 — Near-parity + push, then iterate
- [ ] Push notifications via Expo for heartbeats/reminders (server already owns the
      schedule; add device-token registration + a send path). This is the headline
      mobile-only win.
- [ ] Port heavier views adapted for tablet (projects dashboard, habits, daily
      note; markdown editor on iPad if worthwhile).
- [ ] Offline read cache (optional, later) — the data layer is already a clean
      client, so a cache layer can sit under `api.ts` without screen changes.

---

## Explicitly NOT ported to mobile (at least initially)
- **Embedded terminal** (`node-pty` / tmux WebSocket) — desktop/server-only.
- **Local server lifecycle** — mobile is remote-only by design.
- **PDF export / print pipeline** — desktop-oriented; revisit for iPad if needed.

These stay in `ui/` and never enter `@qalatra/shared`.

---

## Risks & mitigations
- **Async-storage refactor leaks `await` everywhere** → mitigated by hydrate-once
  in-memory cache preserving the synchronous getter API (seam #1).
- **Extraction regresses the desktop app** → Phase 2 is a dedicated "prove it with
  zero behavior change" gate before any mobile code ships.
- **Inline types in `api.ts` are entangled with fetch code** → Phase 1 pulls types
  out first, in isolation, before moving call logic.
- **"One codebase" ≠ "one UI"** → expected: phone vs iPad still diverge in the
  shell; divergence is deliberately isolated to `AppShell` + `useLayout()`.
- **Expo push on iOS requires APNs setup** → scope into Phase 5 with its own
  spike; not on the critical path to a usable read/triage app.

---

## Definition of done (v1 mobile)
A single Expo app, installable on iPhone / iPad / Android, that connects to one or
more headless Qalatra backends by URL + token, switches between them, and lets
Justin review, triage, capture, and complete tasks — rendering as master-detail on
iPad and stacked navigation on phone — with the entire data/connection layer shared
verbatim with the desktop app via `@qalatra/shared`, and the desktop app unchanged
in behavior.
