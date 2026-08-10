# Qalatra — Evolution Notes

## v1.9.34 — August dependency advisory sweep (2026-08-10)

- Cleared the newly published root and UI advisories with patched in-range releases, including
  Electron 41.10.4, DOMPurify 3.4.13, js-yaml 4.3.1, Hono 4.13.1, fast-uri 3.1.5,
  ip-address 10.5.0, nanoid 3.3.18, and the patched 1.x/2.x/5.x brace-expansion lines.
- Updated Expo 56 within its supported release line and cleared every actionable mobile advisory.
  Metro still depends on image-size, whose two high-severity infinite-loop advisories have no
  patched release. That parser runs only against trusted repository assets during mobile builds,
  not remote input in the app. The mobile audit keeps a narrow two-GHSA exception and will fail on
  any other advisory; remove the exception as soon as Expo/Metro takes a patched image-size.
- Rebuilt the shipped Markdown editor bundle so its embedded DOMPurify copy receives the fix.

## v1.9.34 — Release publishing guardrails and changelog repair (2026-08-10)

- Release tags now run a required pre-publish job before any platform packaging begins. The gate
  checks the tag against `package.json`, requires checked-in curated release notes, and runs shared,
  mobile, UI, account, auth, output-rule, and server validation against the tagged source.
- Removed the raw-commit fallback for GitHub release notes. Missing `plan/releases/vX.Y.Z.md` now
  fails the workflow instead of publishing an outward-facing changelog made from commit subjects.
- Repaired the Evolution log against the actual commit-to-tag history from v1.9.22 onward, including
  four releases whose shipped security/API work previously had no entry.

## v1.9.34 — Secure Fleet bootstrap credentials (2026-07-31)

- Added support for a caller-supplied `QALATRA_BOOTSTRAP_TOKEN` during the first headless server
  start, while retaining random local bootstrap tokens when it is absent.
- Stopped printing the raw initial full-access token to server logs. Fleet injects its derived
  per-node credential through a one-time systemd drop-in that Ansible removes after bootstrap.
- Moved native account credentials to the platform secure-store seam and clear revoked or expired
  credentials as soon as the account API reports an unauthenticated response.

## v1.9.34 — Qalatra account entitlement gate (2026-07-30)

- Added a platform-agnostic `@qalatra/shared` account client for qalatra.com GraphQL login,
  two-factor completion, token persistence, and Connect entitlement checks.
- Hosted-web builds can enable the account gate with `VITE_QALATRA_ACCOUNT_AUTH=true`; the free
  Electron build remains ungated. The Expo mobile app now requires an active assigned Connect seat
  before backend onboarding/main navigation.
- Added explicit logged-out, 2FA, unlicensed/seatless, retryable network-error, and valid-license
  states, with recovery links to the Qalatra portal.

## v1.9.33 — Restore agent output rules after the headless-server migration (2026-08-10)

- Restored `agent.config` `output_rules` evaluation for every successful agent job. The evaluator
  was dropped when job execution moved from `ipc-handlers.js` to `server/workers.js` in May, while
  its documentation and `addTaskLink` database method remained, making configured rules silently
  do nothing on all headless-server releases.
- Rules now evaluate the normalized result: command/template jobs use their stdout, while prompt
  agents use the parsed JSON result rather than the prompt or JSON envelope. When output contains
  multiple matches, the final match wins, preventing a Qalatra preamble ID from outranking the
  downstream FlightDesk ID. Invalid rules are logged without blocking later rules or job completion.
- Added regression coverage for plain command output, prompt-agent JSON output, last-match
  selection, malformed-rule isolation, successful link persistence, and failed-job exclusion.

## v1.9.33 — Reorderable instance switcher (2026-08-08)

- Settings → Instances now lets saved remote servers be reordered by drag-and-drop or accessible
  up/down buttons. The order persists in the existing client-side instance list and immediately
  drives the header switcher; Local Server remains fixed first when it is visible.
- Updating an existing instance now preserves its position instead of silently moving it to the end.

## v1.9.32 — Remote terminal sessions survive server restart (2026-07-30)

Restarting `qalatra-server` killed every open remote terminal — and auto-update
restarts on every release, so self-hosted Linux boxes lost all sessions on each
upgrade. Root cause: `createSession()` let tmux's server be started implicitly by
`new-session` from inside the service process, so the tmux server (owning the ptys)
inherited `qalatra-server.service`'s cgroup. With systemd's default
`KillMode=control-group`, stop/restart SIGKILLs everything in that cgroup, tmux
included.

- **Primary fix** (`server/terminal-sessions.js`): new `ensureTmuxServer()`, called at
  the top of `createSession()` before the first tmux call. It starts the tmux server in
  its own transient scope via `systemd-run --user --scope --quiet --collect tmux
  start-server`, so the server lands outside the service cgroup. Attempt-and-fall-back
  for portability: on macOS / non-systemd Linux / no user manager, `systemd-run` fails
  and it drops to a plain `tmux start-server` (previous behaviour). Idempotent
  (`start-server` no-ops if a server runs), so calling it per session is safe. Ships via
  auto-update (pulled JS) and alone satisfies the fix.
  - Known limitation: does not *move* an already-running tmux server out of the wrong
    cgroup — takes effect once that server exits. On the upgrade release specifically,
    the pre-existing server is still in the bad cgroup, so that one restart loses
    sessions a final time; every restart after is clean.
- **Defence in depth** (`scripts/qalatra-server.service` + the inline unit generated by
  `scripts/install-linux-server.sh` — the latter is what actually deploys): add
  `KillMode=process` so systemd signals only the main PID. Reaches boxes on fresh
  reinstall only — auto-update never regenerates the unit — but the scope fix is the
  real one, so this is just a backstop. Tradeoff: a hard crash could orphan the MCP
  child, which the server already restarts itself on normal shutdown.

## v1.9.32 — Restart-orphaned agent jobs get a distinct `orphaned` status (2026-07-29)

When the app restarted mid-job, `resetStuckJobs()` marked the job **`failed`** with
"…exceeded the timeout window" — mislabelling an infrastructure event as an agent
failure. Two costs: it polluted failure counts / the Pipeline Auditor's recurring-infra
detector (indistinguishable from real failures without string-matching `result`), and it
hid whether any partial work had landed (a cloud reply can arrive after the job dies, so a
consumer had to diff PR head SHAs to know what completed before requeueing).

Fix:

- **Distinct terminal status `orphaned` + `terminated_by = 'app_restart'`** (`db-worker.js`).
  Status lets counters/aggregations branch; `terminated_by` carries the precise cause and is
  extensible to future termination causes. Consumers stop string-matching `result`.
- **`terminated_boundary`** column = the `started_at` of the app instance that killed the job
  (`SERVER_STARTED_AT`, threaded server ctx → `workers.js` → `resetStuckJobs`). A consumer can
  compare a late reply's timestamp against it to tell "died before doing anything" from "died
  after its work landed" — no SHA archaeology.
- **No auto-requeue.** The old `<16 min → re-queue` branch was exactly the non-idempotent
  re-injection to avoid (prompts are built at launch; a blind requeue re-runs completed work).
  All orphaned running jobs now terminate as `orphaned`; requeue is the orchestrator's call.
- **Message no longer conflates restart with timeout.**
- **One-time backfill**: existing `failed` rows carrying the old `Job orphaned:%` string are
  reclassified to `orphaned` (+ `terminated_by='app_restart'`), de-polluting historical counts.
  Idempotent.
- Surfaced in the UI: amber `⟳` badge (`TaskRow`) and a distinct "Interrupted by app restart"
  banner with a Resume-session button (`DetailPanel`), separate from the red failure styling.
  `stampAgentJobs` includes `orphaned` in its 24h window. MCP `list_agent_jobs`/`get_agent_job`
  descriptions document the new status/fields for the consuming orchestrator; columns mirrored
  in `mcp/db.js`.

Verified: node syntax + ui tsc; an in-memory SQL harness confirmed both running jobs orphan
(with boundary), the legacy orphan-as-failed reclassifies, a genuine failure stays `failed`,
and the badge query surfaces `orphaned`.

## v1.9.31 — Dependency advisories: electron-updater/builder + postcss + brace-expansion (2026-07-29)

Security-maintenance patch clearing five high Dependabot advisories. None was
runtime-exploitable in the shipped desktop app, but the scan is kept clean.

- **`builder-util-runtime` → 9.7.0** (GHSA-p2f4-r6v6-j797): cross-origin redirect
  could leak `PRIVATE-TOKEN`/`Authorization` creds. Pulled by both electron-builder
  (build) and **electron-updater (runtime)** — the only runtime-touching one. Exploit
  needs a token-authed update feed; Qalatra updates from public GitHub Releases, so
  it was never exposed. Fixed by bumping `electron-updater ^6.8.3 → ^6.8.9` (runtime)
  and adding a `builder-util-runtime ^9.7.0` root override.
- **`app-builder-lib` → 26.15.3** (GHSA-7g7r-gx96-252g): AppImage search-path issue;
  build-time only and AppImage isn't built (macOS DMG). Cleared by
  `electron-builder ^26.8.1 → ^26.15.3`.
- **`postcss` → 8.5.18** (GHSA-r28c-9q8g-f849) in `ui/` + `mobile/` (via vite): source-map
  path traversal, build-time only. Cleared via override.
- **`brace-expansion` → 5.0.8** (GHSA-mh99-v99m-4gvg) in `mobile/` (via minimatch/glob/
  expo-updates): DoS, build/dev-time. Cleared via override.

Verified: root/ui installs resolve the patched versions; `check-imports` + ui build
pass; and an `electron-builder --dir` pack on 26.15.3 (signing disabled) packaged the
macOS arm64 app cleanly — confirming the toolchain major bump is safe for the signed
CI build.

## v1.9.30 — Per-backend tab memory + NULL-context = global capabilities (2026-07-29)

Two small, independent fixes.

**Tab memory per backend (desktop `ui/`).** Switching servers triggers a full
`window.location.reload()`, and on boot `nav` initialized from the backend's
`landing` — so every switch dropped you on Priority regardless of where you'd
been. With ~4 remote boxes in rotation that's a lot of lost place. Now each
backend remembers its last-active tab: `lib/nav.ts` gained a per-backend
localStorage map (`qalatra.lastNavByBackend`, keyed by `activeBackendKey()` like
the sidebar config), `saveLastNav` (skips `settings`, so returning restores your
last *content* view, not the settings panel), and `resolveInitialNav` (returns
the remembered tab when it's still a valid place to land — visible, not hidden,
Tools only when enabled — else the backend's `landing`). `App.tsx` seeds `nav`
from `resolveInitialNav`, persists on every change, and restores on the
reload-free `onInstanceConfigChange` path too. Purely client-local; no server
involvement. New backends (or a since-hidden tab) still fall back to `landing`.

**NULL context/project = global capability (server `capability-registry.js`).**
`listCapabilities`/`searchCapabilities` filtered with strict `context = @context`
(and `project = @project`), so a capability with no context — global in the UI —
was excluded from *every* context-scoped search. Backwards: globals were the one
thing that should surface everywhere. Both filters now use
`(context IS NULL OR context = @context)` / `(project IS NULL OR project = @project)`,
so a scoped search returns its own scope **plus** globals, and a fully global
agent (null context *and* null project) survives both filters. Making a global
agent needs no new field — just omit `context`/`project` in `agent.config`; the
registry already stores unset as `null`. Bonus: `context: null` now lists just
the globals (previously a dead `context = NULL` query that matched nothing).
Server-side, so remote boxes pick it up on deploy; local picks it up on MCP/API
restart.

## v1.9.30 — Configurable navigation: per-backend section visibility + default view (2026-07-23)

Qalatra has two distinct uses — personal vs. remote-server — and remote boxes
rarely use Reading, Backlog, Habits, or Projects. You can now hide sections and
pick which view loads on launch. Config is **stored app-locally but keyed by
backend**: each install holds a map of backend → config, so switching backends
swaps the nav to that backend's view (a personal backend can show everything
while a headless remote box hides what it doesn't use). The active backend is
resolved via `@qalatra/shared`'s `getActiveInstanceId()` (collapsing
`LOCAL_INSTANCE_ID` aliases), and the config re-resolves on `onInstanceConfigChange`.

- **Desktop** (`ui/`): new `lib/nav.ts` — section vocabulary + a localStorage map
  `Record<backendKey, SidebarConfig>`; `getSidebarConfig`/`saveSidebarConfig`
  default to the active backend. New Settings → Sidebar tab
  (`components/settings/SidebarSettings.tsx`, names the backend it's editing) with
  a Show checkbox + Default radio per section. `Sidebar.tsx` filters `NAV_ITEMS`
  by the hidden set (preserving the dynamic Tools/boxWeb placement); `App.tsx`
  seeds initial `nav` from the default, re-resolves on backend switch, and bounces
  off a hidden active view.
- **Mobile** (`mobile/`): new `src/lib/navConfig.ts` — AsyncStorage map keyed by
  backend, hydrated at startup (awaited in `App.tsx` alongside `hydrateInstances`),
  a `useSyncExternalStore` pub/sub, and an `onInstanceConfigChange` subscription
  that re-resolves the active backend's config. `RootNavigator` conditionally
  renders the bottom tabs and sets `initialRouteName` from the default;
  `MoreScreen` filters its content rows; new `NavigationSettingsScreen` (More →
  App → Navigation) provides the Show/Default controls.

Deliberately **client-local, not server-side** for storage (nav is client chrome
and stays on the device), but **per-backend** so the different-view-per-backend
behavior works — that reshuffle-on-switch is the point. Config is normalized
centrally so the default view (desktop) / default tab (mobile) is always visible;
the app can never launch into a hidden section. Structural entry points stay
non-hideable: desktop Settings + Daily Note action buttons; mobile More tab +
Backends + Disconnect + the Navigation settings row — so you can always turn
sections back on, and backend-switching itself always happens from a non-hideable
surface (desktop Settings, mobile More tab).

**boxWeb ("Tools") folded into this one model.** The pre-existing show/hide "Tools"
item was configured separately on the instance record (`boxWebEnabled`/`boxWebLabel`,
set in Settings → Instances) — a second, parallel per-backend visibility mechanism.
It's now a client nav preference like the rest: `toolsEnabled`/`toolsLabel` live in
the same per-backend nav config, configured in the same settings surface (desktop
Settings → Sidebar; mobile More → Navigation), and the instance record goes back to
pure connection config. The instance `boxWeb*` fields are `@deprecated` and read
once to seed the nav config (desktop), then the map is authoritative. This also
fixed a mobile bug: the Tools tab was always shown regardless of any toggle; it now
honors `toolsEnabled` (defaulted `true` on mobile to preserve the always-shown
behavior; opt-in/off on desktop as before). Storing the nav config *on* the instance
record was rejected because the desktop local backend is a synthesized instance not
present in `getInstances()`, so `updateInstance` can't persist to it — the client map
(keyed by backend id, incl. `local-server`) is the correct single store.

Verified: desktop tsc+vite build, mobile + shared tsc, config-normalizer invariant
tests on both (incl. tools defaults/label). Mobile not yet run in the iOS Simulator
— do that before cutting a release.

## v1.9.30 — REST `createTask` honors task type, source, and event times (2026-07-23)

The `/api/v1` `createTask` route hardcoded `task_type = 'task'` and
`source = 'manual'` and dropped the event-time columns (`event_time`/`end_time`)
plus most other fields on insert, while MCP `create_task` and REST `updateTask`
all supported them — so any external integration creating an event or tagging a
source had to POST and then immediately PATCH. Rebuilt as a dynamic insert
honoring the same field set as MCP `create_task`, using REST conventions
(booleans as 1/0, `links` stored as JSON text, `ai_context` via
`appendAiContext`), with the original defaults preserved
(task/manual/active/personal) and schema defaults covering unset columns. Kept
deliberately aligned with the `mcp/tools/tasks.js` `create_task` copy — the two
inserts are parallel implementations and drift between them is what caused this.
Verified with a worker-thread functional test against a temp DB.

## v1.9.29 — `@hono/node-server` advisory cleared via override (2026-07-23)

The last outstanding dependency advisory: GHSA-frvp-7c67-39w9, a Windows-only
`serve-static` path traversal in the library backing the MCP server transport.
The Model Context Protocol SDK still pins the 1.x line even in its latest
release, so the patched 2.x was forced in with an npm `override`. The transport
uses exactly one export (`getRequestListener`), unchanged across the major
version; 2.x needs Node ≥20 and hono ^4, both already satisfied. Verified with a
full connect → list-tools → tool-call handshake against the updated library
before release. Desktop, web, and mobile all scan clean after this.

Future note: MCP SDK v2 (the `@modelcontextprotocol/server` / `client` packages)
drops this dependency entirely, but is a beta with an unstable API. When it goes
stable the transport should migrate and this override should be removed.

## v1.9.28 — Ten dependency advisories patched (2026-07-22)

Security maintenance sweep after v1.9.27, all targeted in-place bumps with no
functional change: `fast-uri` 3.1.2 → 3.1.4 (server, DoS); `js-yaml` 4.2.0 →
4.3.0 (desktop/web/mobile, quadratic-CPU DoS via merge-key chains — forced past
`@mdxeditor/editor`'s pin in the web build via override); `shell-quote` 1.8.4 →
1.10.0 (desktop/mobile, forced past `concurrently`'s pin via override); `tar`
7.5.16 → 7.5.21 (build tooling); `dompurify` 3.4.11 → 3.4.12 (web — the bundled
Markdown-to-PDF overlay was rebuilt so its embedded copy is patched too);
`sharp` 0.34.5 → 0.35.3 (icon build tooling). The Markdown editor (js-yaml) and
PDF export (dompurify) were exercised against the updated libraries before
release. `@hono/node-server` was deliberately deferred here — its only patched
version is a major bump outside the MCP SDK's range, so it needed the coordinated
override tested separately (shipped in v1.9.29).

## v1.9.27 — brace-expansion + body-parser advisories (2026-07-22)

Cleared the four open Dependabot alerts with lockfile-only updates —
`brace-expansion` 5.0.6 → 5.0.7 (DoS, GHSA-3jxr-9vmj-r5cp, high) across the
root, `ui`, and `mobile` lockfiles, and `body-parser` 2.2.2 → 2.3.0
(GHSA-v422-hmwv-36x6, low) in the root. No `package.json` range changes and no
unrelated tree churn.

## v1.9.27 — Release workflow: assert full asset set before un-drafting (2026-07-20)

The v1.9.26 release exposed a silent-failure mode in `.github/workflows/release.yml`.
electron-builder treats an upload to a pre-existing GitHub release that's more than
2 hours old as a no-op ("skipped publishing") and still exits 0. So when a first
release run partially uploads assets and then fails (e.g. a GitHub 503 mid-upload),
a later re-run skips every remaining upload and all three platform jobs go green —
leaving a release with only the assets from the first attempt and, critically,
missing the `latest*.yml` auto-updater manifests. The workflow reported success
while shipping a release the in-app updater couldn't read. The `publish-release`
job now verifies every required platform binary and updater manifest is present on
the release before it flips `--draft=false`, and fails the workflow with the exact
missing files (and the delete-release-then-re-run remedy) if any are absent. An
incomplete release is left as a draft, which the updater ignores, rather than
advertised. Recovery when it fires: `gh release delete <tag> --yes` (keep the tag),
then re-run the workflow.

## v1.9.27 — Auto-attach denylist: home-root dotfiles + rc files (2026-07-21)

Follow-up to the denylist below. `.flightdeskrc` — a bare credential dotfile in
`$HOME` — matched none of the filename patterns (`token`/`secret`/`key`/`.pem`/…)
nor a denied directory segment, so a note naming it by path auto-attached the
credential file. Impact was contained (only a local-path reference was stored, no
bytes uploaded; the row was deleted), but it exposed that enumerating credential
dotfile names is a losing game. `isSensitivePath` now also denies (a) any dotfile
ending in `rc` (`/^\.[^/]*rc$/i` — `.flightdeskrc`, `.myservicerc`, anywhere), and
(b) **any** bare dotfile located directly in `$HOME`, regardless of name — that's
almost always user/app config that may hold credentials, and legit agent outputs
live under `<agent_path>/output/`, never as a home-root dotfile. Verified against
both a home-root `.flightdeskrc` and a plainly-named home-root dotfile in the test
harness. Remote nodes (e.g. `/home/ansible/qalatra`) pick this up on their next
pull/release.

## v1.9.26 — Auto-attach secret denylist (2026-07-19)

Note auto-attach (`server/mentioned-files.js`, used by `add_task_note` for
non-user authors and by agent-job results in `db-worker.js`) attached any
path-looking string that resolved to a real file — so an agent note mentioning
`~/.config/qalatra/github-token` or a `.env` file silently attached the live
secret to the task. With `bucket`/`key`/`url` columns already on the
attachments table, a future attachment-sync feature could have shipped secrets
off-box. `resolveCandidate` now skips: (1) paths with sensitive directory
segments (`.ssh`, `.aws`, `.config`, `.gnupg`, `.kube`, etc.), (2) filenames
matching secret patterns (`token`, `secret`, `credential`, `password`,
`api-key`, `.env*`, `id_rsa`, `.pem`/`.key`/keystore extensions, `.netrc`,
shell history), and (3) any file whose first 1KB contains a PEM
`-----BEGIN ... PRIVATE KEY-----` header — checked against both the mentioned
path and its symlink-resolved realpath. False positives just mean manual
attachment; that's the right trade. Normal agent outputs (pdf/csv/md/json/png)
still attach.

## v1.9.25 — idempotent heartbeat enable/disable (2026-07-15)

`toggle_heartbeat` was the only affordance for pausing a heartbeat, and it's a
blind flip: an agent following "disable the heartbeat on failure" would re-arm
a heartbeat another agent (or Justin) had already disabled. `update_heartbeat`
now accepts an `active` field (both `mcp/tools/heartbeats.js` and
`db-worker.js`, so the `/api/v1` PATCH route gets it too): `active: false`
pauses, `active: true` resumes and schedules the next run, and repeating either
is a no-op. Tool descriptions steer agents to `update_heartbeat { active }` for
"ensure on/off" and warn that `toggle_heartbeat` is a blind flip. Covered in
`scripts/test-mcp-heartbeats.mjs`. Qalatra task 13b6d394. Note: any canonical
agent prompts that say "call toggle_heartbeat to disable" (e.g. the pipeline
circuit-breaker protocol on remote nodes) should be updated to the idempotent
call, and remote servers need a restart to pick up the new tool schema.

## v1.9.24 — heartbeat `last_run_at` timezone fix (2026-07-13)

`markHeartbeatRun` wrote `last_run_at` with local `nowIso()` (a side effect of
the C10 local-time convention) while `next_run_at` and `agent_jobs.created_at`
are UTC, so the two scheduler columns disagreed by the box's UTC offset and the
UI's "Last: Xh ago" (which parses as UTC) was off by the same amount. Now
written with `utcNowIso()`, a new shared helper in `server/task-logic.js`.
Scheduler firing was never affected (`next_run_at` vs `datetime('now')` was
already UTC-vs-UTC). Existing rows self-correct on their next run. Full
write-up: `docs/bug-heartbeat-timezone-mismatch.md`.

## v1.9.23 — C15 straggler: briefing.js rollover field preservation (2026-07-13)

The C15 fix (time_estimate + inbox preserved on recurring respawn) covered two
of the three spawn paths but missed `mcp/tools/briefing.js` spawnRecurrence, so
recurring tasks rolling over via `morning_briefing` silently lost their time
estimate (breaking the briefing's own capacity math) and inbox flag. Fixed to
field-for-field parity with db-worker; `test-mcp-rollover-guard.mjs` now
asserts preservation through the briefing path (verified red pre-fix, green
post-fix). All three spawn paths are now aligned.

## v1.9.22 — Correctness sweep C1–C26 + task-logic single-sourcing (2026-07-13)

A git-history-mined debugging pass (see `docs/` playbook) found and fixed 26
bugs across the recurrence engine, MCP tools, db-worker, and HTTP API:

- Recurrence: weekly/monthly rules no longer collapse to next-day (C1); the
  recurrence chain and task fields survive respawn (C9/C15); completing via
  `status: done` spawns the next occurrence like `complete_task` (C14);
  concurrent rollovers can't duplicate tasks (C12).
- MCP: `read_only` token scope enforced on all mutating tools (C7); NULL
  clears fields instead of being ignored and rollover preserves fields
  (C3/C4); projects upsert + chronological `ai_context` (C22/C24).
- Server/db-worker: `nowIso()` uses local time not UTC (C10); pending DB
  restore applied on headless startup (C11); per-job spec files stop batched
  same-agent jobs clobbering each other (C13); heartbeat `next_run_at`
  recomputed on schedule edits (C8/C18); `sync_log` created in db-worker and
  `deleteTask` made transactional (C19); event auto-complete no longer fires
  before a late-night event (C20); pre-spawn `dbCall` rejection no longer
  leaks a concurrency slot (C21).
- HTTP API: date-default fix, snooze validation, GET returns 404 for missing
  tasks (C23/C25/C26).
- Refactor (Q1): pure task logic single-sourced in `server/task-logic.js`,
  shared by the server and db-worker so the copies can't drift.
- New standalone regression suite: `scripts/test-*.mjs` (10 scripts — run
  with `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron <script>` on a
  dev box where native modules are built for Electron).

## Server idle-crash hardening (2026-07-06)

Qalatra Server now guards the idle/background paths that could terminate the
process with code 1 after unattended use:

- Terminal WebSocket attaches now register an `error` listener and clean up the
  backing tmux attach pty on socket errors, so sleep/network drops do not become
  uncaught exceptions.
- Agent worker child-process `close`/`error` handlers no longer leave async DB
  writes as unhandled promise rejections. Job completion, note insertion,
  auto-attach, and event publish failures are logged without taking down the
  server.
- Agent result auto-attachment is non-fatal after the note has been written; a
  bad filesystem mention reports `auto_attach_error` instead of failing the
  whole `insertAgentNote` call.
- The API server writes unhandled rejection/exception details to
  `server-crash.log` in the data directory, and explicitly handles HTTP listen
  errors including retrying `EADDRINUSE`.
- When Electron owns the local API child process, unexpected exits now schedule
  a restart after 2 seconds instead of leaving the UI connected to a dead server.
- `scripts/smoke-server.mjs` now records early child-process exits before
  cleanup, so a server that dies during boot reports the failure instead of
  accidentally letting Node finish with exit code 0.

## Mobile: terminal scrollback scrolling (2026-06-24)

The mobile terminal (`/terminal` WebView) couldn't be scrolled by touch — xterm.js
translates wheel events to scrollback but ignores finger swipes, so on the phone
there was no way to read back through a long Claude Code conversation (the keybar
arrows send escape sequences to the shell, not the scrollback). Fix in
`ui/src/terminal-webview/main.ts` + `terminal.css`: single-finger touch-drag now
scrolls `.xterm-viewport.scrollTop` directly (the same element wheel scrolling
drives, so xterm re-renders the visible rows), with a small slop threshold so taps
still fall through to focus and pinch/multi-touch is left alone; `#root` gets
`touch-action: none` so the browser's own gestures don't fight the drag. Scrollback
also raised from the 1000-line default to 10000 so long sessions stay in buffer.
Rebuild with `npm run build:terminal` (regenerates the committed
`server/static/terminal.html`).

## Mobile: workspace file browser (2026-06-23)

A native file manager over the existing /api/files endpoints (no server change).
More → Box → Files lists workspace roots, then browses directories (`listDirectory`).
Folders push deeper; `.md` files open in the in-app reader/editor; any other file
downloads (`/api/files/content`, bearer auth) and opens in the iOS share/preview
sheet (QuickLook). Reuses expo-file-system + expo-sharing (already added for
attachments) — pure JS, no native rebuild.

## Mobile: terminal via WebView (2026-06-23)

A real shell on the backend from the phone/iPad — for troubleshooting box-local
services (e.g. the Box Web tool) on the go. Same WebView pattern as the mdpdf
editor: xterm.js bundled to one self-contained HTML (vite.terminal.config.ts,
`npm run build:terminal` → server/static/terminal.html), served at GET /terminal
(unauth shell; the pty WebSocket carries the token in its URL). The RN
TerminalScreen reuses a running tmux session (or creates one) via the shared
terminal API, computes `terminalSocketUrl`, and injects it; the bundle wires
xterm to that socket with reconnect + a mobile key bar (esc/tab/^C/^D/^Z/arrows)
for keys a soft keyboard can't send. Reached via More → Box → Terminal. Uses the
already-present react-native-webview, so no native rebuild — JS/OTA only.

## Mobile: full markdown editor via WebView + attachment upload (2026-06-23)

**Full mdpdf editor on mobile/iPad (step 2 of the markdown plan).** Rather than
rebuild the desktop editor's paginated preview + PDF natively (an inherently-web
layout engine), the exact `MdView` is reused inside a WebView:
- `ui/src/mdpdf-webview/main.tsx` is a standalone entry that mounts only `MdView`,
  seeds the active backend (URL + token, injected by the RN host) into the shared
  API client so `/api/files` calls authenticate, and posts page errors/close back
  to the host. Built to ONE self-contained HTML via `vite-plugin-singlefile`
  (`vite.mdpdf.config.ts`, `npm run build:mdpdf`).
- The server serves it at `GET /mdpdf` (unauthenticated shell; data calls carry the
  bearer token). The built artifact is committed at `server/static/mdpdf.html` so a
  headless server serves it after `git pull` with no UI build step.
- Mobile `MarkdownEditorScreen` loads `${backend}/mdpdf` in a WebView, injecting
  `{ serverUrl, token, path }` before load — same-origin, so it works against local
  or remote backends. Reached via an "⤢ Editor" button in the native reader; the
  native reader/editor stays the fast default. Build-verified; device test pending.

**Attachment upload + delete on mobile.** The Attachments section was read-only;
it now has "＋ File" (expo-document-picker) and "📷 Photo" (expo-image-picker,
camera roll) actions that read the picked file's bytes (`expo-file-system` `new
File(uri).arrayBuffer()`) and POST to the existing `uploadAttachment` endpoint,
plus per-item delete (`deleteAttachment`). app.json gains the image-picker
photo-permission plugin.

## Mobile: file links + native markdown reader (2026-06-23)

Step 1 of the mobile markdown plan (see EXPO_MOBILE_ROADMAP.md → "Markdown editor
& file links"). The mobile task detail had no Links section at all; now:

- **Links section** on `TaskDetailScreen` — parses `task.links` (same JSON
  string-or-`{url,label}` model as the desktop DetailPanel, via `lib/links.ts`)
  and lists each as a tappable row.
- **Native markdown reader** (`MarkdownViewerScreen`) — tapping a server-side
  `.md` link opens it in-app, rendered natively with `react-native-markdown-
  display` (pure JS, no native rebuild). Content loads over the shared
  `/api/files` endpoint, so it works against any backend.
- Routing: server `.md` paths → native reader; URLs and remote `.md` → system
  browser. Registered `MarkdownViewer` in the Task and More stacks.

The full editor/PDF (WebView reuse of `MdView`) remains step 2; this reader is
deliberately the read-only front door and is not throwaway toward it.

## Mobile task detail redesign — summary card + sheet pickers (2026-06-22)

The mobile (Expo) `TaskDetailScreen` was a wall of seven stacked, horizontally
scrolling chip rows (Priority, Energy, Context, Project, Recurrence, Due, Snooze)
that buried the task content and made every value a hunt-and-peck. Reworked into a
compact, scannable summary:

- **Summary card (`MetaCard`/`MetaRow`):** one tappable line per field showing the
  current value + a chevron. Priority/Energy/Context/Project/Due/Start/Recurrence
  all live in a single grouped card. `start_date` is now editable on mobile for the
  first time (desktop already had it).
- **Bottom-sheet pickers (`SelectSheet`):** tapping a row opens a styled bottom
  sheet single-select — the mobile equivalent of the desktop dropdown — replacing
  the inline chip rows for Priority/Energy/Context/Project/Recurrence.
- **Native date picker (`DateSheet`):** Due/Start open a sheet with Today/Tomorrow/
  Weekend/Next-wk quick chips above a native calendar (`@react-native-community/
  datetimepicker`, added as a dependency — requires a native rebuild). iOS uses the
  inline calendar; Android uses the system date dialog. Quick chips show a selected
  state, fixing the "tapping Tomorrow does nothing" feedback gap (the value was
  saving, but nothing near the button confirmed it).
- **Snooze** stays as the quick-button `ButtonRow`. The redundant read-only pill row
  at the top was removed; status is now a single small badge under the title.

`ChipRow`/`ButtonRow` remain in use by `CreateTaskScreen`.

## 1.9.11 — Markdown editor: panel fixes + font picker (2026-06-22)

- **Style panel is interactive again.** A global `.sidebar` rule (the app's main
  nav) leaked `-webkit-app-region: drag` into the markdown editor's style sidebar,
  turning the whole region into a window-drag area that swallowed every click and
  edit. Reset to `no-drag` on the scoped `.mdview-overlay .sidebar`.
- **Terminal/Chat slide-up panel renders correctly.** The shared global terminal is
  an inline (in-flow) bottom panel that sat *behind* the z-1000 markdown overlay, so
  the reserved 300px showed only the overlay's black background. It now floats above
  the overlay when docked, and the overlay closes a terminal it opened (but leaves a
  terminal that was already open).
- **Font picker overhaul** (Style → Typography): the picker is now an autocomplete
  field — fonts are sorted alphabetically, you can type ANY custom font name, your
  real installed system fonts are enumerated (Local Font Access API), and the full
  Google Fonts catalog (~1500 families) is fetched in the Electron main process
  (no renderer CORS) and cached. Font files still load lazily only when selected.
- **Under the hood:** the data layer (types, API client, instance/backend
  management) was extracted into a new `@qalatra/shared` package now consumed by the
  desktop UI with no behavior change — groundwork for the in-progress Expo mobile
  app. See the entry below + `plan/EXPO_MOBILE_ROADMAP.md`.

## Shared core extraction + Expo mobile groundwork (2026-06-20)

- Introduced npm workspaces and a new `@qalatra/shared` package: the
  platform-agnostic core (types, instance/backend management, HTTP runtime, full
  API client, pure date/platform-detect helpers) shared between the Electron
  desktop UI and a future Expo app. No React/DOM/Electron/Node deps — host
  specifics are injected through a small platform adapter (synchronous storage KV
  + capabilities + optional local-server resolver) and a tiny emitter replaces
  the window-event change notifications.
- Switched the desktop UI onto `@qalatra/shared` with no behavior change. The old
  `apiRuntime.ts` split into the shared `runtime.ts` plus `ui/src/localServer.ts`
  (Electron-only server lifecycle + the desktop attachment opener); `platform.web.ts`
  installs a localStorage/sessionStorage pass-through adapter. `ui/` resolves the
  package as source via a Vite alias + tsconfig path, so the install/CI/release
  pipeline is unchanged. Verified by `npm run build`, shared typecheck, and
  check-imports. Runtime parity still to be exercised in the running app.
- Scaffolded the Expo app under `mobile/` (native AsyncStorage adapter with a
  hydrate-once cache, remote-only — no local server; adaptive tablet/phone shell;
  onboarding + today screens). Not yet installed or run on a device. `mobile/` is
  deliberately not a workspace so the desktop `npm ci` never pulls Expo/RN.
- Plan: `plan/EXPO_MOBILE_ROADMAP.md`.

## 1.9.10 — Agent worker diagnostics and template quoting (2026-06-18)

- Fixed templated agent command substitution for shell-sensitive task text. `{title}` and `{description}` are now shell-quoted as full arguments, so apostrophes and spaces in task titles/descriptions no longer break commands like `flightdesk register --title '{title}' --prompt '{description}'`.
- Failed agent jobs now append sanitized launch diagnostics: cwd, worker user/home/shell, PATH, Claude config directory presence, `~/.claude.json` presence, selected Claude/FlightDesk/script binary paths, Claude version, and whether Claude/Anthropic marker env vars are present. Token values are not printed.
- Agent launches now derive the shell from `SHELL` or the OS user shell before falling back to `/bin/zsh` or `/bin/bash`, which makes Linux user services less dependent on systemd exporting `SHELL`.
- Added optional `agentEnv` server setting and per-agent `agent.config.env` overrides. Values support `~`, `$VAR`, and `${VAR}` expansion, allowing service-run workers to point Claude at the intended `ANTHROPIC_CONFIG_DIR` without editing the systemd unit.

## 1.9.9 — Box Web runtime API routing (2026-06-17)

- Fixed dynamic Box Web apps whose JavaScript calls root-absolute API paths such as `fetch('/api/inbox')`. The iframe now injects a small runtime shim that rewrites `fetch`, `XMLHttpRequest`, `EventSource`, and `navigator.sendBeacon` calls back through the ticketed `/api/box-web/proxy/<ticket>/...` path.
- The fix keeps Qalatra's own `/api/*` routes protected: bare `/api/*` requests still require bearer auth unless they originate inside the Box Web page and are rewritten to the session-scoped proxy path.

## 1.9.8 — Box Web App private proxy (2026-06-17)

- Added V1 Box Web Apps for remote-first workflows: each saved remote instance can opt into one sidebar-pinned web surface, with a configurable label that defaults to "Tools".
- Added Settings -> Instances -> Box Web Apps controls. The sidebar item appears only when the active remote instance has Box Web enabled, keeping local and unused boxes uncluttered.
- Added an authenticated Qalatra Server proxy for the box-local web app at `http://127.0.0.1:8080`. The desktop client creates a short-lived session ticket using the existing bearer token, then embeds `/api/box-web/proxy/<ticket>/...` without exposing the permanent token to the iframe.
- The proxy is intentionally not a general URL proxy: V1 only forwards to loopback port 8080 on the active Qalatra server. It rewrites root-relative HTML links/assets and CSS `url(/...)` references so simple static dashboards served from a box `www` root work inside Qalatra without Cloudflare Access.

## 1.9.7 — Instance startup default and server-backed slide-up terminal (2026-06-15)

- Added an explicit Settings -> Instances -> Startup Default selector. The previous persisted active-instance value migrates into this default once, so users who already defaulted to a remote box keep that behavior.
- Active instance switching is now scoped to the current app session; after a full restart Qalatra uses the configured startup default, falling back to Local Server if the saved remote is removed or missing.
- Added a "Hide Local Server in the header instance switcher" checkbox. Local Server cannot be removed and remains available in Settings, but the header can stay focused on remote instances when local is not part of the normal workflow.
- Reworked the slide-up document terminal to use the same server-backed tmux/WebSocket transport as the Terminals view. Terminal/Chat from document previewers now opens on the active Qalatra server, so remote-default workflows run in the same filesystem as the document instead of trying to spawn a local Electron PTY. Plain document Terminal opens in the document folder; Chat starts the configured agent command there.

## 1.9.6 — Terminal copy actually fixed (sandboxed preload clipboard) (2026-06-14)

- **Root cause of every prior failed "terminal copy" fix:** the preload runs sandboxed, where `require('electron')` does **not** expose the `clipboard` module. `preload.cjs`'s `writeClipboard: (text) => clipboard.writeText(text)` therefore threw `Cannot read properties of undefined (reading 'writeText')` on every call — silently breaking copy-on-select, Cmd+C, *and* OSC 52 alike. The 1.9.1/1.9.2 "terminal copy-out" entries never actually worked in the packaged/sandboxed app.
- **Fix (client):** clipboard writes now go through IPC — `preload.cjs` does `ipcRenderer.send('clipboard:write', text)`, handled in `electron-main.js` by `clipboard.writeText` in the main process (which has the module). Verified end-to-end via CDP: a tmux selection now lands on the macOS clipboard.
- **Remote terminal copy (`TerminalManagerView.tsx`):** registered an OSC 52 handler (`term.parser.registerOscHandler(52, …)`) that base64-decodes (UTF-8 safe) and writes to the clipboard. With tmux `set-clipboard on`, a normal mouse drag-release in a remote/agent terminal now copies to the local Mac clipboard over the wire. Added a Cmd+C / Ctrl+Shift+C handler for Shift+drag xterm selections; plain Ctrl+C still sends SIGINT. Replaced the old (non-functional) copy-on-select.
- **Server (`server/terminal-sessions.js`):** set tmux `set-clipboard on` (server option) on both session create and attach, so tmux emits OSC 52 on copy. `TERM=xterm-256color` advertises the `clipboard` feature, so this works without extra terminal-overrides. Fleet boxes pick this up on the next deploy (bootstrap `git reset --hard origin/develop` + service restart).
- **Bottom-panel terminal (`Terminal.tsx`):** added copy-on-select (it had no clipboard handling at all); now works thanks to the preload IPC fix.

## 1.9.5 — MCP bearer-token authentication (2026-06-12)

- **MCP auth**: `mcp/http-server.js` now validates the same tokens as the API server (`server/auth.js`, `auth_tokens` table, sha256 hash, revocation, expiry, `last_used_at` bump). Any token created in Settings → Instances → Access Tokens works for both API and MCP calls.
- **Three modes via `QALATRA_MCP_AUTH` env var:**
  - `local-bypass` *(default)* — loopback requests skip auth; back-compat for the desktop app and any Claude Code running on the same box.
  - `required` — every request needs a valid token. **Required on any box with an MCP tunnel hostname.**
  - `off` — no auth (explicit opt-out).
- **⚠️ Tunnel warning**: behind a Cloudflare tunnel, traffic arrives from `127.0.0.1` (the local cloudflared daemon) and looks like loopback. `local-bypass` is NOT safe on a tunneled box. Any box with an MCP ingress hostname must add `Environment=QALATRA_MCP_AUTH=required` to its systemd service.
- `Authorization` added to MCP server's `Access-Control-Allow-Headers`.
- `docs/linux-remote-install.md` updated with MCP tunnel setup guide and the `required` warning.
- Tokens now work at: `npx -y mcp-remote https://mcp-<box>.qalatra.com/mcp --header "Authorization: Bearer <token>"`

## 1.9.4 — Terminal scroll, keepalive, headless auto-update (2026-06-12)

- **Terminal scroll restored**: re-enabled tmux mouse mode on Qalatra-managed sessions. Mouse wheel now scrolls through terminal history via tmux copy mode. Trade-off: normal click-drag no longer auto-selects (tmux intercepts it). Use **Shift+drag** to select text — xterm bypasses mouse forwarding on Shift, `onSelectionChange` still fires, copy-on-select still works. Existing sessions need to be killed/recreated to pick up the change.
- **Terminal WebSocket keepalive**: client sends a `{ type: 'ping' }` frame every 25 seconds. Prevents proxy/NAT idle-timeout from silently dropping connections when the app is backgrounded or inactive.
- **Terminal auto-reconnect**: on unexpected WebSocket close (network blip, server restart), the terminal automatically retries up to 8 times with exponential backoff (500ms → 4s). No more manual "Reconnect" clicks for transient drops. Intentional disconnects (switching sessions, PTY exit) are not retried.
- **Headless auto-update**: new `scripts/auto-update.sh` + systemd timer (`qalatra-updater.timer`) installed by `install-linux-server.sh`. Checks GitHub releases every 6 hours; if a newer version is published, runs `git reset --hard v<tag>`, `npm ci`, `npm run rebuild:node`, then restarts `qalatra-server.service`. Logs to journald. Existing servers can bootstrap the updater by re-running `install-linux-server.sh` from the 1.9.4 checkout.

## 1.9.3 — CI fix (2026-06-10)

- Bumped `concurrently` dev dependency from 9.x to 10.x. The old version pulled in `shell-quote` with a critical advisory that was failing CI on every commit without affecting the release build.

## 1.9.2 — Terminal copy-out working (2026-06-10)

- Fixed copy-out from remote terminals. Root cause: if the remote server's `~/.tmux.conf` has `set -g mouse on`, tmux intercepts mouse selection events on the server and copies to its own paste buffer — xterm on the Mac never sees the selection. Qalatra now disables mouse mode on every tmux session it creates (`tmux set-option -t session mouse off`) so xterm handles selection natively.
- Switched terminal copy mechanism to copy-on-select: `onSelectionChange` writes selected text to the Mac clipboard via `electronAPI.writeClipboard` (Electron native clipboard, synchronous). No Cmd+C needed — select text, paste anywhere. Previous approaches using `attachCustomKeyEventHandler` and `document 'copy'` event both failed because Electron's menu accelerator intercepts Cmd+C before JavaScript sees it.
- Existing terminal sessions need to be killed and recreated to pick up the mouse mode change.

## 1.9.1 — Heartbeat resume fix, terminal copy-out (2026-06-08)

- Fixed `toggle_heartbeat` MCP tool crashing with ReferenceError on resume. `addMinutesFromNow` was referenced but never defined; replaced with the correct `nextRunAt(interval, run_at_time, minute_offset)` call. Also fetches `run_at_time` and `minute_offset` from the row so clock-aligned offsets are respected when resuming a paused heartbeat.
- Fixed copy-out from the remote terminal on Mac. Added `attachCustomKeyEventHandler` in `RemoteTerminal`: Cmd+C (or Ctrl+C) with selected text writes to the clipboard and swallows the keystroke instead of sending an interrupt to the shell. With no selection the key passes through normally.

## 1.9.0 — Remote terminal UX, workspace file creation, instance tabs (2026-06-08)

- WorkspaceFilesView: replaced the global `+` / full-path input with a per-folder hover `+` button and an inline create form. The form shows the parent directory path as a read-only label and accepts only the filename; creates the file and opens it in the editor. File creation now does a targeted directory refresh (`refreshTarget` mechanism) instead of remounting the whole tree — expansion state is fully preserved.
- WorkspaceFilesView: workspace root nodes auto-expand on mount (`initialExpanded` prop triggers `loadChildren()` immediately), so the first level of the file tree is always visible without a manual click.
- Header: replaced the `_` terminal toggle button with instance switcher tabs (Local + each saved remote). Clicking a tab calls `setActiveInstance(id)` and reloads the app. Tabs only render when there is at least one saved remote instance.
- TerminalManagerView: inline session rename. A Rename button in the actions row puts the toolbar title into edit mode; Enter or blur saves, Escape cancels. Sends a `PATCH /api/v1/terminal-sessions/:id` call and reloads the session list.
- TerminalManagerView: Reconnect button in the terminal toolbar. Incrementing `reconnectKey` forces the `useEffect` to close the dead WebSocket and open a new one — no navigation required to wake a dormant session.
- TerminalManagerView: `term.focus()` called on session selection so xterm captures keypresses immediately without the user clicking inside the terminal first.
- App.tsx: keyboard shortcut guard extended to `.ide-terminal-xterm` — inputs inside the terminal pane no longer trigger the global `d` shortcut and redirect to the daily note.
- server/terminal-sessions.js: tmux ENOENT error now shows a platform-specific install message: `brew install tmux` on macOS, `sudo apt install tmux` on Linux, instead of the raw Node spawn error.
- EventCard.tsx/css: done events render a static `✓` span (not a clickable button). Added `.event-card.event-done` with 45% opacity and a strikethrough title so completed calendar events visually recede without disappearing.
- db-worker.js: `doneToday` query excludes events (`AND task_type != 'event'`) so the "done today" count reflects tasks, not calendar events. Events query removes the `AND status != 'done'` filter so done events are visible in the events list.
- mcp/tools/triage.js: triage tool excludes both events and reading tasks (`task_type NOT IN ('event', 'reading')`); previously only excluded events.
- settings/InstancesSettings.tsx: "Use Local Server" button no longer requires `localServer.token` to be present — calls `setActiveInstance(null)` and reloads immediately, fixing a case where the button appeared disabled after clearing tokens.

## 1.8.0 — Time estimates and daily capacity (2026-06-03)

- Added `time_estimate INTEGER` column (minutes) to the tasks table. Migration runs in both `mcp/db.js` and `db-worker.js`.
- Added `time_estimate` to `create_task` and `update_task` MCP schemas so agents can set/clear estimates.
- Fixed MCP `create_task` and `update_task` handlers to persist `time_estimate` instead of only exposing it in tool schemas.
- `morning_briefing` now returns a `capacity` object: `{ estimated_minutes, tasks_with_estimate, tasks_without_estimate }` summed across overdue + due_today workable tasks. Gives agents a direct answer to "how loaded is today?"
- `get_overdue_tasks`, `get_todays_tasks`, `morning_briefing`, and `afternoon_briefing` all include `time_estimate` in their SELECT outputs.
- Also on this date: excluded `task_type = 'reading'` from all operational briefing outputs (`morning_briefing`, `afternoon_briefing`, `get_overdue_tasks`) — reading-lane tasks were polluting daily briefings and confusing agents. Added `task_type` and `tags` to all compact SELECTs so agents can filter edge cases.
- UI: time estimate pill picker in DetailPanel (presets: 15m, 30m, 1h, 1.5h, 2h, 4h; click active preset to clear).
- UI: `⏱ Xh Ym` badge on TaskRow next to energy indicator.
- UI: capacity banner above the Tasks section in the today view — shows total estimated time for actionable tasks plus a count of unestimated tasks.

## 1.7.0 — Task search (2026-05-29)

- Added full-text task search to the Priority view. A search bar at the top of the screen filters the current view in real time across title, description, notes, ai_context, context, project, tags, source, and source_url.
- Added "Search all" mode: toggling from "This screen" to "Search all" hits the new `/tasks/search` backend endpoint and returns matches across every task status (active, backlog, snoozed, done, archived), grouped by status in the results pane.
- Added `searchTasks` to `db-worker.js` with status-first ordering (active → backlog → snoozed → done → archived), then task_type (tasks before reminders/events), then sort_order / priority / recency. Configurable scope and limit with a 200-row cap.
- Added `/api/v1/tasks/search` HTTP endpoint to `server/v1.js` accepting `query`, `scope`, and `limit` params.
- Added `searchTasks` API client function in `ui/src/api.ts`.
- Added `/` keyboard shortcut to focus the search bar from anywhere in the Priority view. Documented in the ShortcutsHelp overlay.
- Updated the Project Dashboard to surface context-level agents (agents that have a context but no specific project) alongside their context's project list. Context groups now sort by the registered context order.

## 1.6.0 — Agent IDE and persistent remote terminals (2026-05-27)

- Added first-class Files and Terminals surfaces in the main sidebar. Files handles server-backed workspace browsing plus Monaco file editing/saving; Terminals handles persistent terminal sessions with a full xterm pane.
- Added authenticated workspace APIs for allowed roots and one-level directory listing. The allowed root set now includes `workspaceRoot`, `fileRoots`, `agentsRoot`, `terminalCwd`, attachment cache, `~/workspaces`, and `~/IdeaProjects`; file browsing/editing stays behind existing `full_access` API tokens.
- Added persistent server-side terminal session management backed by `tmux`. Qalatra stores terminal metadata in the server data directory, can list/create/update/kill/remove sessions, and exposes a WebSocket attach endpoint so browser/Electron clients can disconnect and reconnect without killing the underlying shell.
- Added remote terminal UI transport using xterm.js over the new WebSocket endpoint. The existing local bottom terminal remains available, while the Terminals view attaches to the active Qalatra server instance.
- Added Monaco as the general-purpose code editor for workspace files, with syntax highlighting by extension, dirty tracking, and authenticated save through the existing file write API.
- Added a registered-agent picker to terminal session creation so Qalatra can start a shell or Claude session directly in a known agent folder.
- Added Settings fields for `workspaceRoot` and additional `fileRoots` so headless boxes can keep Agent IDE access scoped to a normal-user workspace instead of the whole machine.
- Updated the Linux bootstrap/server install path to require `tmux`, create a normal-user workspace at `~/workspaces` by default, and seed first-install settings for `workspaceRoot`, `agentsRoot`, and `terminalCwd`.

## 1.6.0 — Trust signal improvements (2026-05-25)

- Added task-level trust signals: `hard_deadline`, `last_reviewed_at`, and `task_dependencies`, with idempotent migrations in both the Electron/server worker and MCP DB paths.
- Extended MCP task tools so `create_task`/`update_task` accept `hard_deadline`, `get_task` and `get_todays_tasks` include `blocked`, `blocked_by`, and dependency summaries, and new tools cover `mark_reviewed`, `get_stale_tasks`, `add_dependency`, `remove_dependency`, and `get_dependencies`.
- Added authenticated API support for stale task listing, marking a task reviewed, and adding/removing/listing dependencies through `/api/v1/tasks`.
- Updated the desktop UI so hard deadlines use a red locked due-date chip, stale tasks show a review-age indicator with a detail-panel “Mark reviewed” action, and dependency-blocked tasks are de-emphasized and grouped under “Waiting” in the priority view.
- Added detail-panel dependency links for both “Blocked by” and “Blocking” relationships, plus hard-deadline editing during task creation and in the detail panel.
- Added automatic attachment recovery for agent comments: when a background agent result or non-user MCP task note mentions an existing local file path, Qalatra now creates a local attachment row for that task and deduplicates by task/path. Relative paths are resolved against the task/agent folder, and oversized or missing files are ignored.
- Removed arbitrary attachment/link chips from task rows so large link sets no longer distort the overview list. Rows now show only a single compact non-clickable source icon when the task has a real external `source` and `source_url`; all attached files and reference links remain available in the detail panel.

## 1.6.0 — Agent operating layer product roadmap (2026-05-25)

- Added `plan/AGENT_OPERATING_LAYER_ROADMAP.md` to capture the larger product direction beyond the initial MVP: Qalatra as one engine with personal and agent-node instance roles, separate UI surfaces, durable external intake, agent action logs, handoff requests, and Qalatra-to-Qalatra messaging.
- Documented the core boundary that raw email/Slack/Notion/PM intake should become `external_items`, not automatic personal tasks. Personal Qalatra stays human-first; agent-node Qalatra gets the External Inbox, Agent Runs, Action Log, Approval Queue, Handoffs, connector health, prompt/session history, and retry/replay tools.
- Captured the first-class handoff model so remote agents can ask Justin or another Qalatra instance for decisions, approvals, missing context, or review without using email or Slack as the coordination layer.
- Captured the Qalatra-to-Qalatra messaging direction: API-to-API delivery first, Iroh peer transport later, with a transport-independent `instance_messages` model for questions, answers, approvals, task pushes, status updates, and agent results.
- Added the strategic build sequence: instance roles and UI surfaces, handoff requests, external intake core, agent actions and approvals, first real connector, inter-instance messaging, Agent Ops console, Iroh transport, and policy engine.

## 1.6.0 — Capability Registry MVP (2026-05-23)

- Added the Phase 1 capability registry for Qalatra's agent operating layer: scanned `agent.config` folders now also upsert structured `capabilities` and `capability_files` rows while preserving the existing `agents` table and dispatch behavior.
- Extended the agent scanner to parse an optional `capability` block with kind, aliases, trigger phrases, provider support, delegation target, permissions, and owned files. Existing `agent.config` files require no changes; Qalatra infers default capability metadata and instruction/knowledge files from the folder.
- Added capability registry schema initialization to both DB access paths (`db-worker.js` and `mcp/db.js`) so Electron/server APIs and MCP tools see the same registry tables.
- Added MCP tools `list_capabilities`, `get_capability`, `search_capabilities`, and `rescan_capabilities` so a top-level assistant can discover what agents/skills exist, what they are for, where they live, and how they can be delegated.
- Added minimal authenticated HTTP endpoints under `/api/v1/capabilities` for listing, search, detail, and rescan.
- Added `docs/capabilities.md` as the authoring and usage guide for capability metadata: agents vs capabilities, field meanings, permission conventions, examples, MCP/API usage, and current Phase 1 limits.
- Added `docs/executive-agent-rollout.md` as the handoff for enriching real Project-folder agents and building the single Qalatra executive-assistant workflow around `search_capabilities`, `search_daily_notes`, task search, and careful entity boundaries.
- Added FTS-backed daily-note memory search via MCP `search_daily_notes` and authenticated `/api/v1/daily-notes` search routes. Search returns compact excerpts by default; `get_daily_note` remains the full-note loader.
- Kept embeddings, memory document/chunk indexing, and context bundles out of this phase. Those remain later implementation slices after the registry and daily-note search prove useful.

## 1.6.0 — Headless server foundation and remote instance switcher (2026-05-20)

- Added a first `server/` runtime that can run without Electron: authenticated HTTP API, bootstrap `full_access` token, reusable `db-worker.js` client, background workers for agent jobs/autorun/heartbeats, and token list/create/revoke helpers.
- Added stable `/api/v1` routes for the core UI data surface: tasks, notes, daily notes, contexts, projects, agents, habits, heartbeats, settings, MCP config, S3 test, key management, backups, and attachment sync.
- Removed the temporary `/api/rpc` bridge; the UI now calls named authenticated HTTP endpoints instead of channel-based RPC.
- Added Settings → Instances to save remote Qalatra Server URLs + tokens and switch the active UI data source between the local server and remote servers.
- Added an Electron-managed Local Server in Settings → Instances. It starts `server/index.js` with Electron's Node runtime against the same local DB, and the UI uses this authenticated HTTP path by default.
- Added local server lifecycle management in Settings → Instances:
  - "Keep local server and MCP running after Electron quits" still supports detached child mode.
  - "Start at Login" installs and controls an OS-managed service: macOS LaunchAgent (`com.qalatra.server`), Linux user systemd service (`qalatra-server.service`), or Windows logon Scheduled Task (`Qalatra Server`).
  - Electron now detects an installed service on startup and connects to it instead of spawning its own child process.
  - In `electron-dev`, service management is disabled by default so dev always runs the server from the current checkout. Set `QALATRA_DEV_USE_SERVICE=1` only for dedicated service testing.
- When installing the service from Electron, Qalatra migrates any existing Electron `safeStorage` encryption key into the server keystore (`server-keystore`, `0600`) so a login service can run without storing secrets in launchd/systemd/task definitions.
- Moved attachments onto the server path: upload, list, delete, pending sync, encrypted download/decrypt/cache, and authenticated blob opening now work through Qalatra Server.
- Added direct binary attachment endpoints so remote uploads no longer need JSON-encoded byte arrays through compatibility RPC.
- Added headless server encryption key management and encrypted backup run/list/restore support. Server keys are stored in the data directory as `server-keystore` with `0600` permissions, or can be supplied with `QALATRA_ENCRYPTION_KEY` / `QALATRA_KEY_FILE`.
- When Electron starts the Local HTTP Bridge, it passes the existing Electron `safeStorage` encryption key through `QALATRA_ENCRYPTION_KEY` so current encrypted attachments/backups keep working while the UI moves to HTTP.
- Added authenticated file APIs for remote editing and previewing: text read/write for Markdown/email editors, style read/write, and `/api/files/content` streaming with byte-range support for browser previews.
- Changed MCP HTTP binding to localhost by default (`QALATRA_MCP_HOST` override) so it is safer to run alongside Cloudflare Tunnel for the authenticated API.
- Hardened `scripts/install-linux-server.sh` for Linux headless/server installs: verifies Node 22+/curl/systemd user availability, rebuilds native modules for system Node, writes the user service, starts it, waits for `/health`, and prints API/MCP/token smoke commands.
- Added `scripts/bootstrap-linux-server.sh` as the one-line Linux bootstrap entry point. It installs missing git/curl/Node 22 dependencies on Debian/Ubuntu hosts, clones or updates the repo, runs the Linux server installer, and optionally runs the Qalatra Cloudflare Tunnel installer when `QALATRA_TUNNEL_HOSTNAME` is set.
- Added `scripts/install-cloudflare-tunnel.sh` for a Qalatra-owned Cloudflare Tunnel. It creates or reuses a named tunnel, routes a public hostname to only `http://127.0.0.1:3456`, and installs a separate `qalatra-cloudflared.service` user service so it does not clobber an existing admin/SSH tunnel.
- Documented the two-channel Cloudflare model: SSH/noVNC operator hostnames stay behind Cloudflare Access, while the Qalatra API hostname stays outside Access and relies on Qalatra bearer tokens for Electron/web/mobile clients.
- Hardened Linux user systemd unit generation by writing plain literal service values, removing brittle `network-online.target` ordering from user units, and including the configured MCP port in Electron-managed Linux services.
- Added a dedicated `rebuild:node` helper that removes stale native build output, rebuilds `better-sqlite3` and `node-pty` for system Node, and verifies they load before the Linux service starts. Linux installs now run `npm ci --ignore-scripts` to avoid Electron's postinstall ABI rebuild on headless servers.
- Changed Qalatra Cloudflare DNS routing to target the tunnel UUID with `--overwrite-dns`, so an existing operator/wildcard DNS record cannot silently keep the API hostname on the wrong tunnel.
- Verified the first real Linux headless install on `qalatra-dev-01`: local `/health`, local authenticated `/api/instance`, and public Cloudflare Tunnel access through `https://api-test.qalatra.com/api/instance` all returned successfully. The install surfaced and fixed two production-readiness issues: systemd user-unit generation and Electron-vs-system-Node native module ABI rebuilds.
- Added a systemd service template for Linux headless/server installs.
- Electron now starts Qalatra Server during app bootstrap and lets the server own MCP, agent/heartbeat workers, and scheduled backups. The legacy data IPC backend has been removed.
- Removed `ipc-handlers.js` and the UI's Electron data fallback; Electron IPC is now reserved for desktop-native shell work such as server lifecycle, terminal, updater, menu, and file-open events.
- `npm run kill` now clears both the API port (`3456`) and MCP port (`3457`) so dev restarts do not leave stale local server processes behind.
- Added authenticated `/api/events` streaming. Agent job completion notifications now come from Qalatra Server, so local Electron and future remote clients share the same event path.
- Moved periodic pending attachment sync into the server worker loop.
- Added token management to Settings → Instances: list current tokens, create a full-access token, show the new secret once, and revoke tokens by ID.
- Added token expiration support. Tokens now store optional `expires_at`, expired tokens are rejected during authentication, and Settings → Instances can create expiring client tokens.
- Added public API body-size limits for JSON and raw upload endpoints to keep the token-authenticated server from accepting unbounded request bodies.
- Added `server/http.js` for shared HTTP/CORS/body/stream helpers so `server/index.js` stays focused on lifecycle and route dispatch.
- Added `plan/HEADLESS_SERVER_ROADMAP.md` to separate the implemented migration slice from the longer-term backend/client architecture.
- Added `docs/linux-remote-install.md` and CI coverage for dependency audits, Linux install script syntax, system-Node native rebuilds, packaging import checks, UI build, and a headless server smoke test.
- Updated root and UI dependency locks to clear npm audit findings, including Electron 41.7, Electron Builder 26.8, AWS SDK 3.1052, MCP SDK 1.29, better-sqlite3 12.10, uuid 14, and UI transitive security fixes.
- Split the frontend API layer into `ui/src/apiRuntime.ts` for server selection, authenticated HTTP, local Electron server controls, and event streaming, leaving `ui/src/api.ts` focused on product-level API operations.
- Split the large Settings screen into per-tab components under `ui/src/components/settings/` so Instances, General, Storage, Encryption/Backup, Contexts, and Agents can be edited independently.
- Replaced the default Vite UI README with Qalatra-specific frontend architecture notes and calibrated UI lint so `npm run lint --prefix ui` exits cleanly in local and CI verification while existing `any` and hook dependency debt remain visible as warnings.

## Unreleased — Full-page Daily Note editor + shared agent guidance (2026-05-18)

### Shared agent guidance

- Added root `AGENTS.md` as the shared source of truth for Codex and Claude.
- Reduced `CLAUDE.md` to `@AGENTS.md` so both agents load the same project context.
- Corrected stale database guidance: UI migrations live in `db-worker.js`; MCP migrations live in `mcp/db.js`.

### Daily Note Markdown editor

- Replaced the slide-up Daily Note bottom drawer with a first-class `nav === 'daily'` screen.
- Daily Note now uses `@mdxeditor/editor`, a WYSIWYG Markdown editor backed by Markdown strings, with toolbar support for headings, bold/italic/underline, inline code, lists, links, tables, code blocks, thematic breaks, and source mode.
- The `d` shortcut now opens Daily Note as a page, and the existing header date picker controls which date's note is loaded.
- Autosave still writes through the existing `daily-note:get` / `daily-note:save` IPC path with debounce plus blur/date-change flushing.
- The editor route is lazy-loaded so MDXEditor does not inflate the initial app screen bundle.

## 1.5.0 — Encrypted backups, tabbed Settings, agent filtering (2026-05-10)

### Encrypted cloud backups

Full backup pipeline built on AES-256-GCM client-side encryption.

**Encryption key management:**
- Key is 32 random bytes stored in macOS Keychain via Electron `safeStorage` — never written to disk unencrypted
- Export as base64 string (for 1Password / recovery drive) in Settings → Encryption & Backup
- Import base64 key on a new machine to restore access to existing backups and attachments

**DB backups to R2:**
- Separate R2 bucket (`qalatra-backups`) from the attachment bucket
- Backups fire hourly (setInterval), on app quit (before-quit with 10s timeout), and on demand via Settings
- Uses better-sqlite3's online backup API — safe under concurrent writes and WAL mode
- Wire format: 12-byte IV + 16-byte GCM auth tag + ciphertext
- 30-day retention — prune runs automatically after every backup
- Restore: downloads and decrypts to `tasks.db.restore`; app applies it on next launch before opening the DB worker
- `_lastBackupTime` / `_lastBackupStatus` persist in-memory and are exposed via `backup:status` IPC

**Attachment encryption:**
- New `encrypted` column on `attachments` table
- Upload path now encrypts with the key if present before sending to R2
- Download path (`attachments:download`) fetches ciphertext from R2, decrypts, saves to local cache, opens with shell
- Presigned URLs are skipped for encrypted attachments (they'd return ciphertext)

**Settings export/import:**
- Full settings JSON export for recovery kit (S3 credentials, bucket names, etc.)
- Import restores all settings from JSON on a new machine

### Settings redesign

Replaced the BottomPanel slide-up overlay with a full-screen tabbed view, accessible via the ⚙ gear button in the sidebar (now navigates to `nav === 'settings'` like any other section):

- **General** — appearance, color tokens, terminal/agent config, MCP server
- **Storage** — S3 endpoint, bucket, credentials, public URL, cache dir, test + sync
- **Encryption & Backup** — key management, backup bucket, run/history/restore, recovery kit export/import
- **Contexts** — contexts list with add/edit/delete
- **Agents** — discovered agents with rescan button

Keyboard shortcut `,` now toggles between Settings and Priority (was toggling a panel overlay).

### Agent filtering fixes

- Detail view agent dropdown now filters strictly by `a.project` (explicit field in agent.config). Previous code fell back to `a.folder` (the top-level scan directory name), which caused agents in a `projects/` folder to appear as project-specific when they should have been context-wide.
- Audited and fixed 17 coderepos agent.config files that were missing the `project` field: biztobiz, flightdesk, muzebook, nestled/nestled-forms/nestled-template/nestledforms.com/nestledjs.com, silvermouse.
- Projects and Agents dropdowns in the detail panel now use `<optgroup>` subheadings ("Code Repos" / "Projects" and "Context-wide" / "Project-specific").

### Heartbeat log expansion

- Heartbeat run results are truncated to 300 chars in the history list
- "Show more" / "Show less" toggle reveals full output inline without leaving the view

### Boolean SQLite binding fix

`update_task` was crashing when called with `inbox: true` (JS boolean). SQLite only accepts numbers, strings, bigints, buffers, and null. Fixed with a coercion step (`typeof v === 'boolean' ? (v ? 1 : 0) : v`) in both `db-worker.js` and `mcp/tools/tasks.js`.

## 1.4.2 — Fix MCP ABI mismatch in dev + recurring task fields (2026-05-08)

## 1.4.1 — Fix MCP ABI mismatch in production (2026-05-08)

The launchd MCP service was using system Node to run the MCP server, but `better-sqlite3` inside the Electron bundle is compiled against Electron's Node ABI — not system Node. These diverge every time Electron or system Node is updated independently, causing all MCP calls to fail with "was compiled against a different Node.js version".

Fix: the launchd plist now uses the Electron binary itself (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1` as the runtime. The Electron binary's Node.js ABI permanently matches the bundled native module regardless of what system Node is installed. The app's entitlements already included `allow-unsigned-executable-memory` and `disable-library-validation`, which are required for this to work with hardened runtime.

Since the plist content changed (different binary path + new env var), the service is automatically reinstalled on next app launch.

## 1.4.0 — Keyboard shortcuts + Play button for agent tasks (2026-05-08)

### Keyboard shortcuts

Full keyboard navigation added across the app via a single global handler in `App.tsx`.

**Navigation:**
- `1`–`7` — jump directly to any sidebar section (Priority, Code, Reading, Projects, Backlog, Habits, Heartbeats)
- `d` — toggle Daily Note panel
- `,` — toggle Settings panel
- `t` / `Ctrl+\`` — toggle terminal

**Task navigation & actions:**
- `j` / `k` — select next / previous task row (DOM-based, works across all views)
- `n` — open New Task dialog
- `c` — complete the selected task and close the panel
- `b` — move selected task to backlog and close the panel
- `r` — refresh current view

**Other:**
- `?` — show/hide the keyboard shortcuts reference overlay
- `Escape` — close shortcuts overlay → close create dialog → close detail panel (priority order)

### Play button for agent tasks

Tasks created with an `agent_path` (code agent assignment) now stay in Priority/Inbox until explicitly launched. A ▶ button appears on hover; clicking it sets `task_type = 'coding'` and queues the agent job, routing the task to the Code view at that point.

- Previously, MCP `create_task` with `task_type=coding` auto-routed tasks immediately — agents would start without any user confirmation
- MCP tool descriptions updated: do not set `task_type=coding` when creating agent tasks; task stays in inbox until ▶ is clicked
- DetailPanel `runAgent()` also sets `task_type=coding` if not already set

## 1.2.3 — Heartbeats: persistent interval-based background agents (2026-05-07)

New **Heartbeats** feature — always-on agent runners that fire on a fixed interval (5 min – 24h) and can be paused/resumed at any time.

### Architecture
- New `heartbeats` table: `id, title, description, agent_path, prompt, interval_minutes, active, last_run_at, next_run_at`
- `agent_jobs.heartbeat_id` column added: heartbeat jobs are regular agent jobs with `task_id = NULL` and a `heartbeat_id` FK
- Scheduler in `ipc-handlers.startBackgroundWorkers`: runs every 60s, calls `getDueHeartbeats()`, creates an agent job + updates `next_run_at` for each due heartbeat. Skips any heartbeat that already has a queued/running job to prevent pile-up
- MCP tools in `mcp/tools/heartbeats.js`: `list_heartbeats`, `create_heartbeat`, `update_heartbeat`, `toggle_heartbeat`, `delete_heartbeat`, `list_heartbeat_jobs`

### UI
- **⚡ Heartbeats** sidebar tab (below Habits)
- Card-based list with pulse indicator (animated blue when running, green when active, gray when paused)
- Play/pause toggle button per card
- Expandable job history showing last 10 runs with status and result preview
- Inline create and edit forms with interval picker (5min → 24h)

## 1.2.0 — Reading view, task type toggle, smart new-task form, Code view idle section (2026-05-06)

### Reading view (`task_type = 'reading'`)

New `task_type` value `'reading'` routes tasks to a dedicated **📖 Reading** sidebar section, keeping them off the Priority view. Same pattern as the Coding view.

- Sidebar nav item added between Code and Projects
- `getReadingTasks()` in `db-worker.js`: queries `task_type = 'reading'`, ordered by priority then created date
- `tasks:reading` IPC handler + `fetchReadingTasks()` in `api.ts`
- `ReadingView.tsx`: simple list, no polling needed (no agent jobs)
- MCP `create_task` / `update_task` / `search_tasks` all accept `reading` as a `task_type` value

### Task type toggle in detail panel

Tasks of type `task` (the default) now show a **Type** row in the detail panel with ⌨ Coding and 📖 Reading pills. Clicking a pill toggles that type on; clicking it again resets back to `task`. Hidden for events and reminders.

Previously, setting `task_type = 'coding'` could only be done via MCP or by assigning an agent with `"coding": true`. Now any task can be manually routed to the Code or Reading view from within the UI.

### Code view: idle tasks now visible

**Bug fix (pre-existing):** `CodeAgentsView` only rendered Running and Queued sections. Tasks with `task_type = 'coding'` but no active agent job (idle between pipeline stages, completed job, failed job) were fetched but never displayed — blank screen with tasks.

Added an **⌨ Idle** section for all coding tasks not currently running or queued. The empty state message also updated from "No active code agents running" to "No coding tasks."

### New task form improvements

- **Project field** is now a combobox (`<input list>` + `<datalist>`) instead of free text. Options are filtered to projects whose `context` matches the selected context (or projects with no context). Free-text entry still works for new project names.
- **Agent dropdown** now filters live by both context **and** project. As context or project changes, the agent list narrows in real time. If the currently-selected agent no longer matches, it's cleared automatically.
- Changing context clears project and agent (since both lists change).

### Files changed

- `ui/src/types/task.ts` — added `'reading'` to `task_type` union
- `db-worker.js` — added `getReadingTasks()`; added to exports
- `ipc-handlers.js` — added `tasks:reading` handler
- `ui/src/api.ts` — added `fetchReadingTasks()`; added `fetchProjectSummaries` import to `CreateTask`
- `ui/src/components/ReadingView.tsx` — new component
- `ui/src/components/Sidebar.tsx` — added `'reading'` to `NavSection`, 📖 Reading nav item
- `ui/src/App.tsx` — routes `nav === 'reading'` to `ReadingView`
- `ui/src/components/DetailPanel.tsx` — added `SPECIAL_TYPES` / `SPECIAL_TYPE_LABELS`; Type row with Coding + Reading pills
- `ui/src/components/CodeAgentsView.tsx` — added Idle section; fixed empty-state message
- `ui/src/components/CreateTask.tsx` — project combobox with context-filtered datalist; agent filter includes project; `handleContextChange` / `handleProjectChange` handlers
- `mcp/tools/tasks.js` — updated all `task_type` descriptions to include `reading`

## 1.1.1 — Sidebar nav, Code view, coding task type, MCP auto-restart (2026-05-05)

### Sidebar navigation

The top tab bar has been replaced with a 160px left sidebar. Nav items:

| Item | Key | Shows |
|------|-----|-------|
| ★ Priority | `priority` | Tasks needing human attention today |
| ⌨ Code | `code` | All tasks with `task_type = 'coding'` |
| ⊞ Projects | `project` | Tasks grouped by context → project |
| ≡ Backlog | `backlog` | Backlog tasks |
| ◎ Habits | `habits` | Daily habits |

The sidebar handles the macOS traffic-light drag zone (top 44px). Utility buttons (New Task, Daily Note, Settings, Theme) moved to the sidebar bottom. The date nav and terminal/refresh controls remain in a slim content-area header above the main panel.

The single `nav: NavSection` state in `App.tsx` replaces the previous `screen` + `view` pair.

### `task_type = 'coding'` and the Code view

**The problem:** Autonomous coding agents run for long periods (15–60+ minutes) with only occasional human review points. They cluttered the Priority view, making it hard to see what actually needed attention.

**The solution:** A new `task_type` value `'coding'` routes tasks to the Code view permanently. Priority view excludes `task_type = 'coding'` entirely. The Code view is the holding area for anything in the coding pipeline.

#### Feedback loop (human review)

When a coding task needs human review, the monitoring agent calls:
```
update_task({ task_id: "...", task_type: "task" })
```
This moves the task from Code → Priority, where it appears like a normal task. Once the human gives feedback and hands it back to the pipeline, the agent sets `task_type` back to `'coding'` to return it to the Code view.

#### Auto-set on agent start

Add `"coding": true` to an agent's `agent.config`. When the Qalatra job runner starts that agent's job, it automatically sets `task_type = 'coding'` on the task:

```json
{
  "name": "FlightDesk Builder",
  "command": "node build-pipeline.js {spec_file}",
  "coding": true
}
```

No AI involvement needed — the runner does the flip as soon as it starts executing.

#### MCP tool changes

- `create_task` and `update_task`: `task_type` now accepts `'coding'` in addition to `task | event | reminder`.
- `search_tasks`: new `task_type` filter parameter. The monitoring agent can find all its work with:
  ```
  search_tasks({ task_type: "coding", status: "active" })
  ```
- `update_task` is the signal for "needs human review" — set `task_type: "task"` to surface in Priority, set `task_type: "coding"` to return to Code view.

#### Key behaviors

- Coding tasks at rest between pipeline stages stay in the Code view (not just when an agent is actively running).
- `agent_job_status` (queued/running/done/failed) still drives the visual spinner within the Code view.
- Completed/archived coding tasks disappear like normal tasks — they don't persist in the Code view.
- The sidebar badge on ⌨ Code shows the count of active agent jobs (`agent_job_status = running | queued`) from today's task data.

#### Files changed

- `ui/src/types/task.ts` — added `'coding'` to `task_type` union
- `ui/src/api.ts` — added `coding` field to `Agent` interface; added `fetchCodingTasks()`
- `db-worker.js` — added `getCodingTasks()` (queries `task_type = 'coding'`, not done/archived)
- `ipc-handlers.js` — added `tasks:coding` IPC handler; `scanAgents` includes `coding` field; job runner auto-sets `task_type = 'coding'` when `cfg.coding === true`
- `ui/src/components/CodeAgentsView.tsx` — new view component, polls every 5s when agents active
- `ui/src/components/TaskList.tsx` — `PriorityView` filters out `task_type === 'coding'`
- `mcp/tools/tasks.js` — updated `task_type` descriptions; added `task_type` filter to `search_tasks`

### MCP server auto-restart via launchd

**The problem:** The Qalatra MCP server (port 3457) had no process supervisor. A crash left it down until manually restarted. Agent tool calls during that window hung for the full timeout (observed: 60+ minutes). The coding pipeline runs every 30 minutes unattended — one crash = one wasted hour.

**The solution:** A launchd plist at `~/Library/LaunchAgents/com.qalatra.mcp.plist` supervises the MCP server process. On crash, launchd restarts it within 5 seconds.

#### Ownership model

launchd starts the MCP server at login. Electron already has an `isPortTaken(3457)` check in `startMcpServer()` — when launchd owns the port, Electron silently skips spawning its own. All requests route through the supervised process.

When Electron is also running (e.g., dev mode), both attempt the port:
- launchd service starts first (at login), takes port 3457
- Electron opens, finds port taken, skips spawning — no conflict

#### Port conflict handling

Previously, `EADDRINUSE` caused `process.exit(1)`, making launchd restart every 5 seconds and spam the log. Fixed: the server now retries internally every 30 seconds on port conflict, staying alive until the port becomes free. Real crashes still exit with code 1, triggering a launchd restart within 5 seconds.

#### Plist location

- Active: `~/Library/LaunchAgents/com.qalatra.mcp.plist`
- Repo copy: `scripts/com.qalatra.mcp.plist`

Key plist settings:
```xml
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>RunAtLoad</key><true/>
```

Node path is hardcoded to the asdf-installed binary (`~/.asdf/installs/nodejs/22.14.0/bin/node`). Update if the Node version changes.

Logs: `~/Library/Logs/qalatra-mcp.log`

To reload after changes: `launchctl kickstart -k gui/$(id -u)/com.qalatra.mcp`

#### `ping` health-check tool

A new `ping` MCP tool returns immediately with `{ ok: true, ts: "..." }`. Agents can call it before starting a pipeline run to verify MCP is reachable in <1s rather than waiting for a tool timeout to discover the server is down.

```
ping({})  →  { "ok": true, "ts": "2026-05-05T13:00:00.000Z" }
```

#### Files changed

- `mcp/tools/health.js` — new file, exports `ping` tool
- `mcp/http-server.js` — imports health tools; `EADDRINUSE` now retries every 30s instead of crashing
- `~/Library/LaunchAgents/com.qalatra.mcp.plist` — launchd service definition
- `scripts/com.qalatra.mcp.plist` — repo copy

## 1.0.73 — Inbox, collapsible sections, agent indicator (2026-04-27)

### Inbox
- Agent-created tasks can now be flagged as `inbox = 1`, placing them in a separate triage area at the top of the today view (open by default).
- Inbox tasks are excluded from the overdue/dueToday/active lists so they don't pollute the main task view.
- Each inbox task shows a **Schedule →** button that clears the inbox flag and moves it into the regular task list.
- MCP `create_task` and `update_task` both support the `inbox` boolean field.

### Collapsible Scheduled and Snoozed sections
- The today view now shows **Snoozed** (time-deferred tasks) and **Scheduled** (autorun tasks not yet fired) as collapsible sections at the bottom, collapsed by default.
- Collapse state persists across page loads via localStorage.
- Scheduled tasks (autorun with no job yet) are filtered out of the main task list and shown only in the Scheduled section.

### Agent running indicator redesign
- Replaced the tiny spinning `⟳` with a 10px amber pulsing circle for running jobs, and a hollow muted circle for queued jobs.
- The green ★ (done) and red ✕ (failed) indicators are unchanged.

### DeferredSection component
- Extracted reusable `DeferredSection` component used for Inbox, Snoozed, and Scheduled sections.
- Header style matches the Tasks section: 12px, uppercase, bold, with icon and count on the same line.
- Accepts a `defaultOpen` prop (defaults false) with localStorage override.

## 1.0.72 — Autorun timezone fix, snoozed task wake-up, meeting attachments (2026-04-29)

### Autorun timezone fix
- Fixed a bug where agent autorun tasks fired at 8 PM local time instead of their scheduled time for users in negative UTC offsets (e.g. US Eastern).
- **Root cause:** `getAutorunTasks()` in `db-worker.js` used `date('now')` (UTC) for the due-date check but `time('now', 'localtime')` (local) for the time check. For UTC-4 users, after 8 PM local the UTC date had already rolled to the next day, making the next day's task appear immediately eligible.
- **Fix:** changed `date('now')` to `date('now', 'localtime')` so both checks use local time consistently.

### Snoozed task wake-up without restart
- Snoozed tasks with a past `surface_after` are now activated every time the today view loads, not only on app startup.
- Previously the wake-up query only ran once in `migrate()` at launch. Tasks snoozed by the EOD agent overnight would not surface until the app was restarted.

### Meeting view attachments
- Attachments are now listed in the Meeting view panel below the agenda items.
- Event cards show a 📎 indicator when attachments are present.
- `attachSubtasks` now returns `attachment_count` so the indicator is available without a separate fetch.

### MCP update_task accepts `notes` as alias for `description`
- `update_task` now accepts either `description` or `notes` — whichever the agent uses. Normalised server-side before write.

## 1.0.71 — Update banner, terminal layout fix, cascade delete, full agent context (2026-04-17)

### In-app update banner
- Replaced the native `dialog.showMessageBox` update flow with a slim 32px banner at the bottom of the app.
- `autoDownload` is now `false` — finding an update never triggers a background download automatically.
- On launch and every 4 hours, the app silently polls for a new version. If one is found, the banner appears with a **Download** button.
- Manual "Check for Updates…" from the menu shows all states: checking (spinner), up to date (auto-dismisses after 3s), and error.
- Download progress shows a progress bar in the banner. Once downloaded, the banner turns green with a **Restart & Install** button.
- All states can be dismissed with ✕ except checking/downloading (which transition automatically).

### Terminal no longer overlays task list
- The docked terminal panel now participates in the flex column layout instead of floating as a fixed overlay over the content.
- Added `inline` prop to `BottomPanel` — when set, the panel is `position: relative` and pushes the layout up rather than covering it. Settings and DailyNote retain their fixed-overlay behavior.
- Removed the `paddingBottom` hack in `App.tsx` that was compensating for the overlay.

### Cascade delete fix
- Deleting a task now correctly removes all dependent records first: `notes`, `agent_jobs`, `attachments`, and `sync_log`, for both the task and any subtasks.
- Fixed in both `db-worker.js` (UI path) and `mcp/tools/tasks.js` (MCP/Claude path). Previously the UI path only cleaned `agent_jobs`, leaving notes and attachments behind and causing silent failures when FK constraints were enforced.

### Full context passed to agents
- Agent jobs now include the full task context in the prompt: title, description, attached links, attached files, and the full existing notes/conversation history.
- Applied to all three launch paths: MCP `queue_agent_job` tool, UI "Run Agent" button (`createAgentJob` in db-worker), and the autorun scheduler (`autoRunAgents` in ipc-handlers).
- `autoRunAgents` now calls `createAgentJob` directly instead of building its own minimal prompt, ensuring consistent context across all launch paths.

## 1.0.70 — Terminal & MCP stability fixes (2026-04-16)

### Terminal reopen fix
- Closing and reopening the terminal panel now works reliably every time.
- **Root cause:** the old pty's `onExit` callback fired asynchronously after the new pty was already spawned, nulling out `ptyProcess` and sending a spurious `terminal:exit` event to the renderer. This left the new pty unreachable (input silently dropped) and showed a false "Process exited" message.
- **Fix:** each `onExit` closure now captures its own `thisPty` reference and only clears `ptyProcess` / notifies the renderer if it's still the active process.

### MCP HTTP server crash fix
- The MCP HTTP server no longer crashes with `ERR_HTTP_HEADERS_SENT` when a long-lived SSE connection hits the 30-second timeout.
- **Root cause:** the timeout handler called `res.writeHead(504)` without checking `res.headersSent`. For SSE (GET) connections, headers are sent immediately when the event stream opens, so the timeout fired on a half-open connection and threw.
- **Fix:** added `!res.headersSent` guard — the timeout now just destroys the socket for already-streaming connections instead of trying to write a new status line.

## Unreleased — Project-scoped agent filtering

### agent.config `project` field
- `agent.config` now supports a `project` field alongside `context`.
- Agent picker in the detail panel filters to: global agents (no context, no project) + agents whose context matches the task AND whose project matches the task (or have no project set).
- This allows multiple repos under one context (e.g. `monroe`) to each have their own coding agents without polluting each other's task views.

### Context + project migration
- `nestled` context created. All nestled-* repos (`nestled`, `nestled-template`, `nestledjs.com`, `nestledforms.com`, `nestled-forms`) now use `context: nestled` with a per-repo `project` field in their agent.configs and plan agents.
- `mi-core` agents moved to `context: monroe, project: mi-core`.
- `tmi-shopify-3.0` agents moved to `context: monroe, project: tmi-shopify-3.0`.

## 1.0.67 — Link chips, agent output rules, recurrence + view fixes, HTTP timeout (2026-04-14)

### Link chips with labels
- All attached links now render as chips showing icon + name (e.g. "Asana", "Linear", "FlightDesk") in both the task row and detail panel. Previously icon-only.
- Unknown URLs fall back to the hostname as the label.
- `detectPlatform()` in `constants.ts` is the single source of truth for platform detection and display names.
- Platform icons updated: FlightDesk now uses its real SVG logo instead of a placeholder triangle.

### Agent output rules
- `agent.config` now supports an `output_rules` array. Rules define regex patterns to match against agent stdout and actions to take when they match.
- Currently supported action: `add_link` — extracts a capture group from the output and adds the interpolated URL as a link on the Qalatra task.
- Example: capture a FlightDesk task ID from `flightdesk register` output and attach the FlightDesk task URL automatically.
- Rules are per-agent and live in the agent's own repo — nothing ships globally with Qalatra.
- Rule format:
  ```json
  {
    "output_rules": [
      {
        "pattern": "Task ID: ([a-f0-9-]{36})",
        "action": "add_link",
        "url": "https://yourapp.com/tasks/{1}"
      }
    ]
  }
  ```

### Bug fixes
- **Weekly recurrence cadence**: `nextRecurrenceDate` now uses `baseDate` as `dtstart` with `rule.after(dtstart, false)` (exclusive) instead of day+1 with inclusive. `FREQ=WEEKLY` without `BYDAY` was anchoring to the completion day's weekday rather than the original task day, causing a Monday task completed on Tuesday to recur on Tuesday. Now correctly recurs on the following Monday.
- **Future view showing completed tasks**: The future `scheduled` query now filters `status = 'active'` only. Previously `status != 'snoozed'` allowed done tasks (e.g. tasks previously deferred which had a future `due_date` set) to appear in forward date views after being completed.

### MCP HTTP server timeouts
- Per-request timeout of 30 seconds: if a request hasn't completed, the server sends a `504` JSON-RPC error and destroys the socket. Prevents stale connections from blocking indefinitely.
- `keepAliveTimeout` (65 s) and `headersTimeout` (31 s) added to the server instance.

## 1.0.60 — Habit recurrence_days: specific day scheduling (2026-04-04)

- **New field**: `recurrence_days TEXT` added to the `habits` table (migration runs on startup). Stores comma-separated day abbreviations: `mon,wed,fri` or `tue,thu` etc.
- **Filtering logic**: `isHabitDueOn()` in both `db-worker.js` and `mcp/tools/habits.js` checks `recurrence_days` first — if set, only fires on those days. Existing habits with no `recurrence_days` behave exactly as before.
- **Habits screen shows all habits**: `listHabits` no longer filters by due-today — all active habits are always shown. The task screen inline habits list still filters to due-today only.
- **Day picker UI**: When creating or editing a habit with recurrence = "Weekdays", a row of day chips (Mo Tu We Th Fr Sa Su) appears. Selected days are highlighted green and stored as `recurrence_days`.
- **Inline edit UI**: Each `HabitRow` now has a ✎ button (visible on hover) that expands an inline edit form — title, notes prompt, recurrence + day picker. Also includes an Archive button.
- **Day badge**: Habits with `recurrence_days` show a compact badge (e.g. `Mo We Fr`) next to the title.
- **MCP tools updated**: `create_habit` and `update_habit` both accept `recurrence_days`. Set to empty string to clear.

## Unreleased — Light/dark mode + configurable color tokens

- **Architecture**: Color token system in `ui/src/lib/theme.ts` — 9 named tokens (`bg`, `surface`, `surface2`, `border`, `text`, `muted`, `accent`, `panelBg`, `inputBg`) with full dark and light presets.
- **ThemeProvider** (`ui/src/lib/ThemeProvider.tsx`): React context that reads mode + per-token overrides from `localStorage`, merges with the active preset, and applies all tokens as CSS custom properties on `:root` via `style.setProperty`. Applied synchronously in `main.tsx` before first render to prevent flash.
- **Mode selection**: System (follows OS preference, watches `prefers-color-scheme` changes), Light, or Dark. Persisted in `localStorage`. Header has a ◑/☀/☾ cycle button. Settings panel has a 3-way mode selector.
- **Token editor** in Settings → Appearance: color pickers for each of the 9 tokens, live preview, "Reset to Dark" / "Reset to Light" / "Reset to Preset" buttons.
- **CSS updated**: All hardcoded background/text/border colors in component CSS files replaced with `var(--panel-bg)`, `var(--input-bg)`, `var(--text)`, `var(--muted)` etc. Semantic status colors (red/amber/green for error/warning/success) kept hardcoded since they don't vary by theme.

## 1.0.23 — Fix SQLite busy_timeout on openDb (2026-03-28)

- **Root cause**: `openDb()` in `mcp/db.js` called `db.pragma('journal_mode = WAL')` and `initSchema()` with `busy_timeout = 0` (default). When API and MCP processes start simultaneously, the process that loses the WAL write lock race fails instantly with `SQLITE_BUSY` — no retry, silent error. This left `_db = null` in the API, causing every subsequent request to fail.
- **Fix**: Move `db.pragma('busy_timeout = 5000')` to the top of `openDb()`, before `journal_mode` and `initSchema()`, so both processes wait up to 5s per lock acquisition instead of failing immediately.

## 1.0.22 — Definitive production connectivity fix (2026-03-28)

- **Root cause (final)**: `server.listen()` was called AFTER `getDb()` → `migrate()`. On first launch, `migrate()` blocks the Node.js event loop for up to 60s (each of 12+ `ALTER TABLE` statements waits up to `busy_timeout = 5000` ms for WAL write locks held by the simultaneously-starting MCP process). Electron's 15s poll expired before the port was ever bound.
- **Fix 1**: Move `server.listen()` BEFORE `getDb()` in `api.js`. Wrap DB init in `setImmediate()` so the port binds immediately on startup; migrations run in the background.
- **Fix 2**: Switch production Electron window from `win.loadURL('http://127.0.0.1:3456')` to `win.loadFile('ui/dist/index.html')`. UI now loads from disk — zero dependency on the API being ready for initial render. Eliminates the whole retry loop.
- **Fix 3**: Add `Access-Control-Allow-Origin: *` CORS headers to `api.js` request handler so `file://` origin requests from the renderer are accepted.
- **Fix 4**: Expose `apiBase = 'http://127.0.0.1:3456'` via `preload.cjs` contextBridge so the renderer knows the absolute API URL.
- **Fix 5**: Add `API_BASE` constant to `ui/src/api.ts` and prefix every `fetch()` call and WebSocket URL across all UI files (`api.ts`, `DetailPanel`, `HabitInlineRow`, `HabitRow`, `HabitsView`, `TaskList`, `Terminal`, `Settings`, `EmailPreview`, `MdView`) so all requests use absolute URLs in production.

## 1.0.21 — Production connectivity fix (2026-03-27)

- **Root cause**: API server and MCP server both bound to `127.0.0.1` (IPv4 only). On macOS Monterey+, `/etc/hosts` maps `localhost` to both `127.0.0.1` AND `::1`. Electron's Chromium renderer may resolve `localhost` to `::1` first; with nothing listening on IPv6, connections hang. This caused "Loading..." forever on any machine that wasn't Justin's dev box.
- **Fix 1**: Changed `server.listen(PORT, '127.0.0.1')` → `server.listen(PORT)` in both `api.js` and `mcp/http-server.js`. Node.js now listens on `::` (dual-stack), accepting both IPv4 and IPv6 connections.
- **Fix 2**: Changed `win.loadURL('http://localhost:3456')` → `win.loadURL('http://127.0.0.1:3456')` to force IPv4 directly, eliminating the resolution ambiguity.
- **Fix 3**: Added `did-fail-load` retry loop (up to 20 retries × 500ms). If the API isn't ready when the window first opens, the window retries instead of showing a dead error page.
- **Fix 4**: Extended the API ready-check polling from 20 × 200ms (4s) to 75 × 200ms (15s). First launch on a new machine needs time for DB schema init.

## 1.0.20 — SQLite singleton fix (2026-03-28)

- **Root cause**: `api.js` called `openDb()` on every request, which ran `initSchema()` + `migrate()` (15+ SQL writes) on every `/api/tasks` hit. Multiple simultaneous open DB connections in WAL mode caused write-lock contention that could stall the event loop indefinitely, manifesting as "loading..." forever on the remote x64 machine.
- **Fix**: Replaced all per-request `openDb()` calls with a singleton `getDb()` — one connection opened once, migrations run once at startup. Added `busy_timeout = 5000` pragma.
- **Also fixed**: Hardcoded logos path (`/Users/justinhandley/IdeaProjects/project-manager/logos`) now falls back to `settings.logosDir` or that default path (configurable).
- **Added**: Request logging for `/api/tasks` to help diagnose future hangs.

A running list of ideas, rough edges, and improvements to iterate on as we use the system.

---

## Known Gaps (discovered in first real use)

_All resolved. See Shipped section._

---

## Immediate Next (before / during first real use)

_All resolved._

---

## Web UI Improvements

- **Context registration** (2026-03-20) — `contexts` table in SQLite seeds 7 defaults on first run. `GET/POST/PUT/DELETE /api/contexts` endpoints. `create_context` MCP tool. `list_contexts` upgraded to JOIN against table so it returns `label` + `color` alongside task counts. UI reads contexts from API via `ContextsProvider` React context — dropdowns in CreateTask and DetailPanel are now dynamic. All badge rendering (`TaskRow`, `TaskList`, `BacklogView`, `EventCard`, `MeetingView`) uses `useContexts()`. Settings panel has a full Contexts management section: color picker, edit, delete, add new.
- **Full rrule.js recurrence** (2026-03-10) — replaced simple `daily|weekly|monthly` with full RRULE support via `rrule.js`. Stores `FREQ=MONTHLY;BYMONTHDAY=1` style strings. Backward compatible with legacy shorthands. Picker in detail panel: daily, weekdays, weekly (day checkboxes), monthly (day of month). Preview shows human-readable text + next occurrence date. `nextRecurrenceDate` and `rruleToText` in `mcp/db.js`. First task: Cursor invoices on 1st of month.
- **Editable due date in detail view** — clicking a task title opens the detail panel, but there's no way to set/change `due_date` from there. Should be an inline date input (or datetime-local) directly in the detail view so you don't have to ask Claude to update it.

---

## Tool UX Improvements

- **Bulk triage** — `snooze_all_active` or `defer_context` to mass-push a context's tasks when you know a client is on hold. One call instead of N.
- **`get_tasks_by_source`** ✅ (2026-03-15) — look up tasks by source system + optional context/status/source_id. e.g. "all asana tasks in monroe", or dedup check by exact source_id.
- **`list_tasks`** — a simple paginated list with optional filters, separate from `search_tasks`. Search implies keyword; list implies browse.
- **`get_context_summary`** — count of active/backlog/snoozed per context. Good for "what's the Monroe load right now?" questions.

---

## Shipped

- **Mobile agent assignment** (2026-06-29) — Mobile task detail now has an editable Agent row even when no agent is assigned, backed by a searchable bottom-sheet picker filtered by the task's context/project. Mobile task creation also loads agents and can set `agent_path` at creation time, matching the desktop create/detail assignment path.

- **Tools reconnect replaces stale refresh** (2026-06-29) — Mobile and desktop Tools now use one reconnect action that creates a fresh Box Web proxy session and remaps the current proxied path onto the new ticket. This avoids the previous stale-ticket reload path, which could show 401/Unauthorized after server restarts or expired sessions. The WebView/iframe remains no-store so cached tool shells do not survive releases.

- **Done events stay in Events section** (2026-06-04) — When an event is auto-completed (or manually marked done), it stays pinned in the Events section at the top of Today view rather than falling into "Done Today" with regular tasks. Done events are rendered grayed out (45% opacity) with a strikethrough title and a green ✓ check instead of the mark-done button. The `doneToday` query now excludes events (`task_type != 'event'`); the `events` query no longer filters by `status != 'done'`.

- **Events are records, not tasks** (2026-03-13) — Events (`task_type = 'event'`) are treated as permanent dated records, not action items. `task_type != 'event'` is now applied universally across all active task queries: overdue, due_today, active_count, by_context, still_active, get_todays_tasks, get_overdue_tasks, end_of_day_triage. Events stay pinned to their date indefinitely with no status transitions needed. Added `end_time` (HH:MM) field to schema for start/end metadata and future calendar-sync readiness.

- **`delete_task` + `list_contexts` MCP tools** (2026-03-15) — `delete_task` permanently removes a task and its subtasks (mirrors the existing HTTP DELETE endpoint). `list_contexts` returns all contexts with active/snoozed/backlog/done counts — useful at session start and briefings.

- **`create_task` accepts `status`** — already implemented; `status` defaults to `active`.

- **Events excluded from overdue** (2026-03-13) — `morning_briefing` and `afternoon_briefing` overdue queries now filter out `task_type = 'event'`. Past events stay pinned to the day they occurred in the UI; they should never surface as overdue items in briefings.

- **Parent/child task support in briefings** (2026-03-13) — `overdue` and `due_today` now include `parent_id` in results. AI should format child tasks with `--` prefix instead of `-` and not treat them as duplicates of their parent. `update_task` now accepts `parent_id`.

- **`recurrence`** (2026-03-08) — `daily | weekdays | weekly | monthly`. Added to schema, `create_task`, `update_task`. `complete_task` now auto-spawns the next occurrence with `start_date` set to the next recurrence date. Habit tasks created: TryHackMe (weekdays), Vimified (weekdays), Instrument practice x2 (daily).

## Schema Candidates

- **`estimate`** (number, hours) — mirrors Asana's AI-enabled estimation model (1hr = Claude handles it, 2hr = some complexity, 8/16/24 = multi-day). Would make daily load planning much easier.
- **`assigned_to`** (text) — Justin vs. Valentin vs. Dillon. Would enable filtering "what's mine today" vs. "what's waiting on someone else."
- **`blocked_by`** (text, task_id or freeform) — flag tasks that can't move until something else resolves.
- **`linked_url`** — separate from `source_url`. For tasks that are manual but have a related Slack thread, email, or doc.

---

## Daily Rhythm Observations (to be filled in as we use it)

_Add notes here after real sessions — what felt clunky, what was missing, what worked better than expected._

- ...

---

## Bigger Picture Ideas

- **`assigned_to`** — Justin vs. Valentin vs. Dillon. Only relevant once other people's tasks are in the system (via Asana sync or manual entry). Depends on sync layer landing first.
- **Weekly review** — `week_in_review` MCP tool or just a prompt pattern: what was completed, what slipped, what's been in backlog too long. Probably just a good system prompt, not a code change.

_Sync layer, Reflect integration, and Slack/Missive intake were originally deferred to FUTURE_IDEAS.md. The newer agent operating layer roadmap supersedes the "MCP is enough" assumption for high-volume autonomous intake: external systems should feed durable intake records, actions, and handoffs instead of polluting the personal task list._
