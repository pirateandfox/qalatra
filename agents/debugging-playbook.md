# Qalatra Debugging Playbook

Mined from the full git history (229 commits, `74c228f` initial → `cc8b433` v1.9.21) on 2026-07-11.
Every claim below cites a real commit. Use `git show <hash>` to read the full fix.

Repo shape (see AGENTS.md for detail): Electron app (`electron-main.js`) + headless HTTP API
(`server/`, port 3456) + SQLite via worker thread (`db-worker.js`) + MCP HTTP server
(`mcp/http-server.js`, port 3457) + Vite/React UI (`ui/`) + Expo mobile (`mobile/`) that reaches
the terminal/markdown editor through server-served WebView shells (`/terminal`, `/mdpdf`).

Churn hot-spots (fix-commit file frequency): `electron-main.js`, `db-worker.js`,
`ui/src/components/DetailPanel.tsx`, `mcp/tools/tasks.js`, `ui/src/components/Terminal.tsx` /
`TerminalManagerView.tsx`, `.github/workflows/release.yml`, `electron-builder.yml`, `mcp/db.js`.
If your change touches any of these, read the relevant landmine section first.

---

## 1. Architecture landmines

### 1.1 `electron-builder.yml` has an EXPLICIT `files:` list — new root-level JS files crash the packaged app
Any new root-level file imported by an Electron entry point must be added to `electron-builder.yml`
or the packaged app dies on launch with `ERR_MODULE_NOT_FOUND` while dev works fine.
- `7f9dd13` — v1.5.0 shipped a startup crash because `crypto.js` wasn't in the files list. Fix added
  `scripts/check-imports.mjs` (walks all relative imports from entry points, fails if any file is
  missing from the list) and wired it into CI and `npm run dist`.
- `278ffad` — `scripts/install-services.mjs` missing from the list → launch crash; code was inlined
  into `electron-main.js` to remove the packaging dependency.
- `3a88953` — `ipc-handlers.js` missing from packaged app (v1.0.42).
Guard: run `npm run check-imports` before any packaging-affecting change. Windows note: the parser
needed CRLF normalization (`5a4e818`) and path normalization (`5c13faa`).

### 1.2 asar is intentionally OFF — do not re-enable it
Node's ESM `import()` cannot resolve npm packages across the asar boundary (require() is patched
for asar transparency; dynamic import is not). This made the entire backend exit code 1 in every
production build until `740cfc5` (asarUnpack band-aid) and `9494051` (`asar: false`, the fix that
stuck). Re-enabling asar re-introduces the whole 1.0.10–1.0.15 startup-failure saga.

### 1.3 Two parallel SQLite schemas: `db-worker.js` AND `mcp/db.js`
Schema is managed via inline idempotent migrations in BOTH files. They drift, and drift = runtime
failures on production DBs that dev never sees:
- `9531620` — `mcp/db.js` was missing whole tables (`agent_jobs`, `habits`, `habit_logs`) and many
  task columns; `create_context` wrote the wrong column.
- `01476e1` — `contexts.display_name TEXT NOT NULL` in one schema vs writes that only set `label`
  → NOT NULL constraint failures on production DBs; needed a backfill migration.
Rule: any schema change must be made in both `db-worker.js` and `mcp/db.js`, and any INSERT/UPDATE
must satisfy the strictest of the two column definitions.

### 1.4 SQLite is a single-writer WAL DB shared by two processes (API + MCP)
The startup window where both processes run migrations is the classic hang/failure zone:
- `fbedf3e` (1.0.20) — per-request `openDb()` + `migrate()` (15+ writes per request) caused WAL
  write-lock contention that stalled the event loop indefinitely. Fix: module-level singleton `getDb()`.
- `1140cd2` (1.0.23) — `busy_timeout` was set AFTER `journal_mode`/`initSchema`, so simultaneous
  API+MCP startup hit SQLITE_BUSY with timeout=0, the loser silently swallowed the error, `_db=null`,
  every later request failed. `busy_timeout` must be the FIRST pragma in `openDb()`.
- `71b088e` (1.0.22) — `server.listen()` after `getDb()` blocked port binding for up to 60s
  (busy_timeout × 12+ ALTERs while MCP held locks); Electron's readiness poll expired. Fix: bind the
  port first, run DB init in `setImmediate()`.
- `b6fbe87` (1.0.43) — better-sqlite3 is synchronous; running it on the main thread froze the UI on
  every write on slower machines. That is WHY `db-worker.js` exists. Never move DB calls back onto
  the server/Electron main thread.

### 1.5 Native module ABI: everything must run on the SAME Node runtime
`better-sqlite3` and `node-pty` are compiled per-ABI. Desktop: everything (server, db-worker, MCP)
runs on the Electron binary via `process.execPath + ELECTRON_RUN_AS_NODE=1`. Linux servers:
`npm run rebuild:node` for system Node.
- `60e3f05` — launchd MCP service ran Electron-ABI better-sqlite3 under system Node → all DB calls
  broke after any Electron update.
- `fe6b1ef` — same mismatch in dev; dev MCP switched to the Electron binary too.
- `c1893ba` — Linux install rebuilds native modules for system Node.
Symptom signature: `NODE_MODULE_VERSION` mismatch errors, or all DB calls failing right after an
Electron upgrade → rebuild for the runtime that actually executes the code.

### 1.6 `server/index.js` routes that run BEFORE `authenticate()` can crash-loop the whole fleet
`e6c28f7` (1.9.13 regression): `/mdpdf` and `/terminal` static-shell routes called `fs.existsSync`
but `index.js` never imported `fs`. Any GET to those routes (exactly what the mobile WebView opens)
threw an uncaught ReferenceError that killed the Node process; systemd restarted it; next hit killed
it again → crash-loop → Cloudflare 502 fleet-wide. `/health` stayed green because it returns before
those routes. `node --check` and the health-only CI smoke never caught it. `8f2cec7` added
`/terminal` + `/mdpdf` probes to `scripts/smoke-server.mjs`. If you add an unauthenticated route,
add it to the smoke probe.

### 1.7 The terminal stack is a four-layer trap (xterm.js + tmux + server pty + WebView)
Highest-churn feature in the repo (~17 fixes each on `Terminal.tsx`/`TerminalManagerView.tsx`).
Every layer has its own input path: trackpad wheel ≠ touch drag ≠ keyboard, and tmux's alternate
screen buffer has no xterm scrollback. See bug classes 2.4/2.5 and do-not-do items 4.2/4.3 before
touching terminal copy or scroll. Also: pty lifecycle closures go stale — `2f6cee2` (old pty's
`onExit` nulled the NEW pty reference on reopen; capture `thisPty` per closure) and `ef6b716`
(reset xterm state on reconnect after unclean exits leave alternate-screen/raw mode).

### 1.8 Recurrence engine (`mcp/db.js` recurrence logic + rollover in db-worker)
At least 8 separate fixes; every date-math change here has caused drift or duplication somewhere
else. See bug class 2.3. Anchor rule that finally stuck: always advance from the task's own
`due_date`/baseDate (never "today"), and advance all the way to today-or-future in one shot.

### 1.9 CI gate ordering can MASK errors
`a2406bf` — 7 UI lint errors were invisible for a long stretch because CI always failed at the
earlier npm-audit step, so lint never ran. When you fix an early CI gate, expect the next gate to
surface pre-existing failures; they are not your regression. (`93a0da1` is the audit fix that
un-masked them.)

---

## 2. Recurring bug classes

### 2.1 "Works in dev, dead in production build"
- Symptom: packaged app crashes at launch or backend silently absent; dev is fine.
- Examples: `7f9dd13` (crypto.js), `278ffad` (install-services.mjs), `3a88953` (ipc-handlers.js),
  `740cfc5`/`9494051` (asar vs ESM import), `3658c6d` (`%20` in path — use `fileURLToPath()`, never
  `new URL().pathname`, app paths contain spaces: `/Applications/Task OS.app`).
- Fix pattern that stuck: `scripts/check-imports.mjs` gate + asar off + explicit files list
  discipline. First move for any launch crash: `npm run check-imports`, then read main.log.

### 2.2 Renderer↔backend transport failures (the Chromium networking saga)
- Symptom: GETs work, POSTs hang forever with no error; or infinite "Loading...".
- History: `b0a90ca` (file:// null-origin blocks POST+JSON preflight) → `566e4d4`
  (`webSecurity:false` — did NOT fix it) → `8ed4b4e` (POST via IPC) → `564efce` (full IPC migration,
  v1.0.41) → later REVERSED by the headless-server work (`df7fe48`, `7704b00`): `api.js` and
  `ipc-handlers.js` are deleted; UI now talks token-authenticated HTTP `/api/v1` to `server/`.
- Also in this class: `86804e5` (macOS resolves `localhost` to ::1 first; servers bound only to
  127.0.0.1 → hang; listen dual-stack or use explicit 127.0.0.1 URLs), `d7c6309` (throw on non-ok
  responses so errors surface instead of rendering empty state).
- Current rule: renderer data calls go through `ui/src/api.ts` → authenticated `/api/v1`. Do not
  reintroduce Electron data IPC or direct-fetch workarounds.

### 2.3 Recurrence drift / duplication / zombie tasks
- `f087319` — snoozed tasks un-snoozed on every page load (migration logic ran per-query).
- `f96b428` — runaway cascade duplication: rollover advanced one period per run instead of
  jumping to today-or-future in one shot.
- `b350bf0` — auto-skip anchored the next occurrence to *today* instead of `task.due_date` →
  weekly/monthly tasks drifted off their scheduled day.
- `29ca967` — FREQ=MONTHLY without BYMONTHDAY drifted 1 day per completion; anchor to baseDate's
  day-of-month.
- `75b20ab` — FREQ=WEEKLY drifted to completion day; `nextRecurrenceDate` must use baseDate as
  dtstart (exclusive-after).
- `8524ece` — events were being auto-skipped and respawned; rollover must exclude
  `task_type='event'`.
- `641de8e` — autorun fired early for UTC-negative timezones: SQLite `date('now')` is UTC; use
  `date('now','localtime')` for any user-facing day boundary.
- `fe6b1ef` — recurrence spawn must copy `notes` + `links` from the original (timestamped notes
  history intentionally clears).
- Fix pattern: anchor to the task's own schedule, advance fully in one call, exclude events, use
  localtime. Test any recurrence change against: complete-late, skip, multiple rollover runs in a
  row, and a negative-UTC timezone.

### 2.4 Terminal copy (five attempts before root cause)
- `d4b973d` (Electron clipboard via preload) → `b32e2b2` (document 'copy' event; menu accelerator
  eats keydown) → `f845c49` (copy-on-select) → all still flaky because of the REAL bug:
- `48eabf7` — the preload runs **sandboxed**, where `require('electron')` does not expose
  `clipboard`, so every write threw silently. Fix: clipboard via IPC to main
  (`clipboard:write`), plus OSC 52 handling for tmux copy-mode.
- `a6ad6fb`/`996f565` — tmux `mouse on` intercepts selection; current design: mouse mode ON for
  wheel scroll, Shift+drag for xterm selection, copy-on-select + OSC 52.
- Route: clipboard problem → check preload sandbox constraints FIRST, then tmux mouse mode, then
  xterm handlers.

### 2.5 Terminal / mobile scrolling (mechanism, not gesture detection)
- `2e1b7aa` — WKWebView's UIScrollView grabbed the drag; `scrollEnabled={false}` on the WebView and
  `preventDefault()` on the FIRST touchmove (iOS locks the gesture on first move; a late
  preventDefault is ignored).
- `b826844` — xterm v6 ignores `.xterm-viewport.scrollTop` writes (internal ScrollableElement);
  use public APIs.
- `894dd1e` — `term.scrollLines()` is a silent no-op under tmux (alternate screen buffer has no
  scrollback). Correct mechanism: synthesize **wheel events** at xterm — the same path the trackpad
  uses — so tmux receives SGR mouse scroll.
- `a8369e5` — the fix was right but never reached the device: server sent no cache headers for the
  `/terminal` shell, so the WebView served a stale copy. `Cache-Control: no-store` on `/terminal`
  and `/mdpdf` + cache-busted URL. When a shipped WebView fix "doesn't work", suspect delivery
  (cache) before logic; a Playwright touch harness proved the logic was fine.

### 2.6 Silent failures in the agent-job worker (`server/workers.js` + db-worker)
- `d7e9e8a` — double-finalize on close+error; fixed with a `settled` flag; spawn via login shell so
  PATH/aliases resolve; show error output in UI.
- `701fa43` — validate `agent_path` exists before spawn; orphan stuck jobs on restart
  (`resetStuckJobs` in db-worker re-queues jobs orphaned by an app crash).
- `f4e2671` (1.9.10) — `{title}`/`{description}` template substitution must be shell-quoted
  (`shellQuote` in workers.js); apostrophes in task titles broke commands. Failed jobs now append
  sanitized launch diagnostics (cwd, shell, PATH, binary paths, Claude config presence) — read
  those diagnostics from the job record before re-deriving them yourself.
- `cc8b433` (1.9.21) — async work inside `proc.on('close')`/`on('error')` produced unhandled
  rejections that killed the whole server after idle periods. Pattern that stuck:
  `finishAgentJobSafely()` — every await individually try/caught, auto-attach non-fatal
  (`auto_attach_error` instead of throw), unhandled rejections logged to `server-crash.log`,
  EADDRINUSE retried, Electron restarts a dead API child after 2s.
- Rule: nothing inside a child-process event handler may throw or reject unhandled; job completion,
  note insert, and notify are three separately-guarded steps.

### 2.7 Shell/spawn quoting and environment
- `8017aac` — Windows `shell:true` + argv prompt: cmd.exe joins args unquoted, so the prompt
  truncated at the first space (Claude received "You"). Fix: write prompt to a temp file; pass a
  short quoted instruction. Never pass long/multi-word text as argv through cmd.exe.
- `29ca967` — agent spawn needs an interactive login shell (`-i -l`) for aliases to resolve;
  platform-aware shell fallback (zsh on macOS, bash on Linux) when `SHELL` is unset.
- `f4e2671` — under systemd user services `SHELL` may be missing; derive from `os.userInfo()`.
  `agentEnv` setting + `agent.config.env` (with `~`/`$VAR` expansion) exist for pointing service
  workers at the right `ANTHROPIC_CONFIG_DIR` — use those, don't edit the unit file.

### 2.8 MCP HTTP server hangs and crashes
- `31a226e` — long tool calls hung: `req.destroy()` left the SSE socket alive; must call
  `req.socket.destroy()`. Added `httpServer.setTimeout()` backstop and `/health`.
- `2f6cee2` — timeout handler threw `ERR_HTTP_HEADERS_SENT` on long-lived SSE; guard every
  `writeHead` with `res.headersSent`, destroy the socket instead.
- `75b20ab` — 30s per-request timeout, keepAliveTimeout, headersTimeout.
- `8276593` — `toggle_heartbeat` called an undefined helper (`addMinutesFromNow`) → ReferenceError
  at call time; MCP tool files are not type-checked, so an undefined identifier ships silently.
  When touching `mcp/tools/*`, actually invoke the tool once.
- `92a78be` — MCP auth modes: `local-bypass` is UNSAFE behind a Cloudflare tunnel (requests arrive
  from 127.0.0.1); tunneled boxes need `QALATRA_MCP_AUTH=required`. Never publish port 3457.

### 2.9 Fleet auto-update failures
- `eb377ad` — `auto-update.sh` self-updates via `git reset --hard`, which restores the committed
  file mode; the script was committed 100644, so every successful update stripped its own exec bit
  and the next timer fire died with systemd 203/EXEC. All four fleet boxes silently stuck on 1.9.6.
  Fix that stuck: commit scripts 100755 AND invoke via `ExecStart=/usr/bin/bash script.sh` so
  execution never depends on file mode.
- Class rule: anything self-updated by `git reset --hard` must not rely on file permissions, and
  "updater silently stopped" = check `systemctl --user status` for 203/EXEC first.

### 2.10 CI / release workflow (`.github/workflows/release.yml`, 16 changes)
- `8c89cd2` — electron-builder builds ALL configured arches regardless of `--arm64/--x64` flags;
  two jobs uploading identical filenames → 422 already_exists. One mac job, no arch flag.
- `d4c11dd` — `--arch` is not a valid electron-builder flag.
- `e841e0d` — the git tag MUST match `package.json` version or the release shows the wrong version
  (documented in CLAUDE.md after being hit).
- `dc5483d` — CI must create the release if missing and not assume electron-builder succeeded.
- `65a61de` — release title naming must stay consistent (strip the `v` prefix).

---

## 3. Debugging routes — "if you see X, look at Y first"

| Symptom | Look here first | Precedent |
|---|---|---|
| Packaged app crashes on launch, dev fine | `npm run check-imports`; `electron-builder.yml` files list | `7f9dd13`, `278ffad` |
| Server crash-loop, Cloudflare 502, `/health` green | Unauthenticated routes in `server/index.js` (before `authenticate()`); `scripts/smoke-server.mjs` coverage; `server-crash.log` in data dir | `e6c28f7`, `cc8b433` |
| API hangs / "No tasks" / requests stall on startup | DB singleton + `busy_timeout` ordering in `db-worker.js`/`mcp/db.js`; listen-before-DB-init in `server/index.js` | `fbedf3e`, `1140cd2`, `71b088e` |
| All DB calls fail right after an Electron or Node update | Native ABI mismatch — which runtime executes this process? `rebuild:electron` vs `rebuild:node` | `60e3f05`, `fe6b1ef` |
| MCP tool call hangs or SSE connection errors | `mcp/http-server.js`: `req.socket.destroy()`, `res.headersSent` guards, timeouts | `31a226e`, `2f6cee2`, `75b20ab` |
| MCP tool throws ReferenceError | Undefined helper in `mcp/tools/*.js` — no type-checking there; run the tool | `8276593` |
| MCP writes fail with constraint errors on a production DB | Schema drift between `db-worker.js` and `mcp/db.js` | `9531620`, `01476e1` |
| Agent job stuck "running" / finishes but no note / server dies after idle | `server/workers.js`: `settled` flag, `finishAgentJobSafely`, `resetStuckJobs`; read the sanitized launch diagnostics appended to failed jobs | `d7e9e8a`, `701fa43`, `f4e2671`, `cc8b433` |
| Agent receives truncated/garbled prompt | Shell quoting: `shellQuote` template substitution; Windows temp-file prompt path | `f4e2671`, `8017aac` |
| Agent can't find `claude` / wrong config under systemd | Login shell derivation + `agentEnv`/`agent.config.env` | `29ca967`, `f4e2671` |
| Heartbeat fires at wrong time / resumes wrong | `minute_offset`/`run_at_time` handling in heartbeat tools; localtime vs UTC in SQLite date() | `31a226e`, `8276593`, `641de8e` |
| Recurring task on wrong day / duplicated / event vanished | Rollover + `nextRecurrenceDate` anchoring (see 2.3 checklist) | `f96b428`, `b350bf0`, `29ca967`, `8524ece` |
| Terminal copy broken | Preload sandbox (clipboard via IPC), then tmux mouse/set-clipboard, then xterm selection handlers | `48eabf7`, `a6ad6fb`, `996f565` |
| Terminal scroll broken (esp. mobile/tmux) | Input path: synthesize wheel events; WebView `scrollEnabled={false}` + first-touchmove preventDefault; xterm v6 API only | `894dd1e`, `2e1b7aa`, `b826844` |
| A shipped mobile/WebView fix "does nothing" on device | Stale cache: `Cache-Control: no-store` on the shell route + cache-busted URL | `a8369e5` |
| Terminal input silently dropped after reopen | Stale pty closure (`onExit` from the OLD pty); xterm state reset on reconnect | `2f6cee2`, `ef6b716` |
| Terminal dead on remote box only | Paths are server-side: uploads/temp files must be written on the backend, not the Electron client | `a26e7bc` |
| WebSocket terminal drops after idle | 25s keepalive ping + reconnect backoff (proxy idle timeouts) | `996f565` |
| Fleet boxes stuck on an old version | Updater exec bit / 203-EXEC; `ExecStart=/usr/bin/bash` | `eb377ad` |
| POSTs hang, GETs fine (renderer) | You are re-living the PNA saga — use authenticated `/api/v1` HTTP, check origin & localhost/::1 binding | `b0a90ca`, `86804e5` |
| Snoozed/scheduled tasks reappear or leak into wrong views | Wake-up logic run-site (today-view load, not startup); status filters on scheduled/past queries | `f087319`, `641de8e`, `75b20ab`, `8524ece` |
| ~100 macOS permission popups at launch | Filesystem agent scan triggered at startup instead of on-demand | `5763370` |
| CI suddenly fails on lint/build errors "you didn't cause" | An earlier gate was fixed and un-masked them | `a2406bf`, `93a0da1` |

---

## 4. Do-not-do list (tried and reverted/superseded, with evidence)

1. **Do not route renderer data calls through Electron IPC or Chromium-fetch workarounds.**
   `webSecurity: false` (`566e4d4`) did not fix the POST hang. The full IPC migration
   (`8ed4b4e`, `564efce`) worked but was deliberately dismantled when the headless server landed
   (`df7fe48`, `7704b00`): `api.js` and `ipc-handlers.js` no longer exist. The settled architecture
   is token-authenticated HTTP `/api/v1` served by `server/`. This is the only true architectural
   revert in the history (`8ed4b4e` is literally the only "revert-shaped" commit) — don't relitigate it.
2. **Do not implement terminal copy by intercepting Cmd+C.** Three failed attempts:
   `d4b973d` (navigator.clipboard flakes on focus loss), `b32e2b2` (menu accelerator eats keydown
   before JS), `f845c49` (copy-on-select — right idea, still broken until the sandbox root cause in
   `48eabf7`). Current stack: copy-on-select + OSC 52 + IPC clipboard writes. Extend that; don't add
   keydown handlers.
3. **Do not scroll xterm via `scrollTop` or `scrollLines()` under tmux.** `b826844` (scrollTop is a
   no-op in xterm v6) and `894dd1e` (scrollLines is a no-op in the alternate screen buffer).
   Synthesize wheel events.
4. **Do not blanket-disable tmux mouse mode.** `a6ad6fb` disabled it to fix copy; `996f565`
   re-enabled it because it broke wheel scroll. The stable compromise is mouse ON + Shift+drag
   select + OSC 52 (`48eabf7`).
5. **Do not open a DB connection (or run migrations) per request.** `fbedf3e`. Singleton `getDb()`
   only; migrations run once at process start, `busy_timeout` first (`1140cd2`).
6. **Do not re-enable asar or move backend files inside it.** `9494051` after `740cfc5`'s
   asarUnpack band-aid still failed for npm deps. `asar: false` is load-bearing.
7. **Do not run better-sqlite3 on the main/server event-loop thread.** `b6fbe87` moved it to
   `db-worker.js` because synchronous writes froze the UI.
8. **Do not scan the filesystem for agents at app startup.** `5763370` — recursive home-dir scan on
   mount triggered ~100 macOS TCC permission prompts. Scan lazily, on user action.
9. **Do not pass task text/prompts as raw argv through a shell.** `8017aac` (cmd.exe truncation),
   `f4e2671` (apostrophes broke templated commands). Use `shellQuote()` / temp-file prompts.
10. **Do not rely on exec bits for anything updated by `git reset --hard`.** `eb377ad`. Invoke
    scripts via an interpreter in systemd units.
11. **Do not trust `node --check` or a /health-only smoke as release verification.** `e6c28f7`
    shipped a process-killing ReferenceError past both. Route-level smoke probes (`8f2cec7`) are
    the compensating control — extend `scripts/smoke-server.mjs` when adding routes.
12. **Do not use SQLite `date('now')` for user-facing day logic.** `641de8e` — it's UTC; agents
    autorun early for UTC-negative users. Use `date('now','localtime')`.
13. **Do not hardcode user-specific contexts/labels into startup seeds or UI constants.**
    `01476e1` removed hardcoded Justin-specific known-contexts and `CONTEXT_LABELS`/`CONTEXT_COLORS`
    fallbacks; only `personal` is seeded (INSERT OR IGNORE).
14. **Do not `await` directly inside child-process `close`/`error` handlers.** `cc8b433` — wrap in
    a separately-guarded helper (`finishAgentJobSafely`) so a DB error can't become an unhandled
    rejection that kills the server.
15. **Do not serve the `/terminal` / `/mdpdf` WebView shells cacheable.** `a8369e5` — a cached
    shell makes every subsequent fix invisible on devices. Keep `Cache-Control: no-store`.
