# Qalatra — Expo Mobile Roadmap

Plan for shipping native **iPhone / iPad / Android** apps alongside the existing
Electron desktop app, by extracting a shared TypeScript core and building a new
Expo (React Native) client on top of it.

**Core principle (inherited from ARCHITECTURE.md): evolve, don't rewrite.** The
desktop app stays in daily use and untouched in behavior; the mobile app reuses
the proven data + connection layer verbatim and only rebuilds the UI.

---

## Status (as of the initial build-out)

- **Phase 0 — workspace foundation: DONE & verified.** `npm workspaces:
  ["packages/*"]`, empty `@qalatra/shared` linked; `electron-dev`/build intact.
- **Phase 1 — extract `@qalatra/shared`: DONE & verified.** Types, platform
  adapter (`platform.ts`), emitter, runtime (instances/HTTP/tokens/events), the
  full API client, and pure logic helpers (dates, platform-detect) all extracted;
  package typechecks standalone with no web/Electron imports.
- **Phase 2 — desktop UI on the shared core: DONE & verified at build level.**
  `ui/` consumes `@qalatra/shared` via a Vite alias + tsconfig path (bundled as
  source — no install/CI/release-pipeline change). `localServer.ts` holds the
  Electron-only bits; `platform.web.ts` installs the web adapter. `npm run build`
  (tsc + vite), shared typecheck, and check-imports all pass. **Runtime parity
  not yet manually exercised** (launch the app and verify instance switching).
- **Phase 3 — Expo app: SCAFFOLDED, not yet run.** `mobile/` exists with the
  native platform adapter, adaptive shell + `useLayout`, onboarding + today
  screens, and monorepo Metro/tsconfig wiring. Needs `cd mobile && npm install &&
  npx expo install --fix && npx expo start` on a machine with a simulator to
  validate (see `mobile/README.md`). `mobile/` is intentionally NOT a workspace.
- **Phases 4–5 — adaptive parity + push: NOT STARTED.**

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
      note; markdown editor — see "Markdown editor & file links" below).
- [ ] Offline read cache (optional, later) — the data layer is already a clean
      client, so a cache layer can sit under `api.ts` without screen changes.

---

## Explicitly NOT ported to mobile (at least initially)
- **Embedded terminal** (`node-pty` / tmux WebSocket) — desktop/server-only.
- **Local server lifecycle** — mobile is remote-only by design.
- ~~**PDF export / print pipeline**~~ — superseded: the markdown editor (incl. its
  PDF pipeline) IS planned for mobile/iPad via WebView reuse. See the next section.

The first two stay in `ui/` and never enter `@qalatra/shared`.

---

## Markdown editor & file links on mobile

The desktop "markdown editor" is the **mdpdf overlay (`ui/src/mdpdf/MdView.tsx`)**
that opens when you click a `.md` file/link. (Distinct from the plain workspace file
editor, `ui/src/components/WorkspaceFilesView.tsx`.) Two related gaps on mobile:

1. **File links are entirely absent on mobile.** The mobile `TaskDetailScreen`
   renders *attachments* but has no Links section at all — so the desktop "click a
   file link → open it (and `.md` → editor)" flow doesn't exist yet.
2. **No markdown rendering or editor** of any kind on mobile (description/notes are
   plain `TextInput`; raw markdown shows as raw text).

### What the desktop editor actually is (sized by reading the code)

- **Editor pane (`MarkdownEditor.tsx`, ~120 lines): basic.** CodeMirror configured
  minimally — line numbers, markdown syntax coloring, undo/redo, line-wrap, an
  "insert page break" command. Effectively a styled textarea. A native `TextInput`
  replicates ~all of it. **This is not the hard part.**
- **Preview pane (`PreviewPanel.tsx` + `utils/pagination.ts` + `contentStyles.ts`):
  the whole value, and irreducibly web.** It's a small **HTML layout + pagination
  engine**: parses markdown → HTML blocks, *measures their pixel heights in the DOM*
  (`measureBlockHeights`) to decide page breaks, flows them into fixed-size pages
  (Letter/A4 @ 96 DPI) with margins, applies per-page generated CSS (font family
  incl. Google Fonts, size, heading scale, colors, line height), and draws scaled
  page cards with hover-to-insert break zones.
- **PDF export is that same HTML/CSS** sent to print (`utils/printHTML.ts`).

**Key conclusion:** rebuilding the *preview/pagination/PDF* natively in RN means
re-implementing a layout engine against RN primitives — high effort, perpetual
drift, and it **won't match** the desktop/PDF output. That's the one path to avoid.
Reading markdown, by contrast, needs none of that machinery.

### File I/O is already portable (de-risks the WebView path)

`MdView` loads/saves via `readTextFile`/`writeTextFile`, which in `@qalatra/shared`
are plain HTTP calls to `GET`/`PUT /api/files?path=…` — **not** Electron fs. So the
editor already works against a remote backend; a WebView just needs the server URL +
bearer token injected and it behaves exactly like desktop. Phase 1 therefore needs
**almost no RN↔web bridge** — RN just opens the WebView at the right URL with the
token.

### Build order (decided)

1. **Native reader (separate, independent track).** Add the **Links section** to the
   mobile task detail + a native `react-native-markdown-display` viewer for tapping a
   `.md` link to read it. Reading is the common action and native is strictly better
   here (real native scroll/selection/perf, no pagination engine, no WebView). No new
   native build beyond what's already pending.
2. **Hoist the whole `MdView` into a WebView.** Reuse editor + preview + page breaks +
   fonts/colors + PDF verbatim. **Serve the mdpdf bundle from the Qalatra server**
   (it already serves `ui/`) so the WebView loads `https://<server>/mdpdf?path=…`
   with the token — bonus: editor improvements ship server-side, no App Store rebuild.
   This front-loads the only real risk (preview/pagination/PDF/auth inside a WebView)
   and gives full parity on iPad immediately.
3. **Native `TextInput` editor — only if needed, and only then.** The sole reason to
   add it is *editing feel* (caret/selection, keyboard-open scroll, autocorrect can
   feel webby). On **iPad** with a keyboard the WebView editor is likely fine as the
   final answer. On **phone**, evaluate after using #2; if it bugs you, swap the
   editor pane for a native `TextInput` bridged (postMessage) to the WebView preview.
   This is **additive** — the preview/PDF stays in the WebView forever, so nothing
   from #2 is thrown away. Build #2's content load/save as a clean message protocol
   so this swap is a drop-in.

**Why this order:** max reuse, proves the risky pipeline first, no throwaway, and the
complexity (the native-editor bridge + the fiddly page-break zones that live in the
preview but edit the source) is deferred until it's proven necessary.

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
