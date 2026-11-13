# Bug: a fresh install scans the whole home folder for agents (and walks cloud-storage mounts)

_Found 2026-11-12 on the Mac dev build (`npm run dev`, v1.9.71, fresh `db/`) while setting up a demo workspace. Status: fixed 2026-11-13 (see plan/EVOLUTION.md); the proposal below is kept as written. Differences from it: the depth limit is 10 and the folder cap 50,000 (the largest fleet box visits about 7k folders once dot-folders are skipped); the agents API keeps its response shape and returns an empty list with no root, and Settings says what to set; there is no Terminal panel component test, because the UI has no test runner._

## What happened

1. On a fresh database, Justin opened Settings and set **Workspace root** to `/Users/justinhandley/qalatra-demo`. That field is the first path in the "Terminal & Agents" section, and the README calls the working directory "the root Qalatra scans for agents".
2. The agent scan does not read `workspaceRoot`. With `agentsRoot` and `terminalCwd` both empty, it fell back to `process.env.HOME` and walked the entire home folder.
3. The walk went into `~/Library/CloudStorage/GoogleDrive-…/My Drive/…`. `lsof` on the server process showed it deep inside an old Drive archive folder. On macOS, Google Drive for Desktop mounts in streaming mode, and walking those mounts makes the File Provider hydrate packages (`.logicx`, `.photoslibrary`, `.app`), which starts multi-GB downloads. A machine-wide walk in this workspace once cycled six Logic projects (3–12 GB each) through the Drive cache.
4. `GET /api/v1/agents` never returned. The Terminal panel loads its sessions, agents and roots in one `Promise.all` (`ui/src/components/TerminalManagerView.tsx:86`), so the whole panel hung: it showed "No terminal sessions yet", and **New shell** and **New Claude** did nothing. The terminal server itself was healthy (`/api/terminal/sessions` returned 200, and a WebSocket attach worked).
5. The partial scan upserted real agents from across the home folder (for example `~/IdeaProjects/projects/shi/agents/accounting`) into the agents table of what was meant to be a clean demo instance.

Workaround used: set `agentsRoot` and `terminalCwd` to the demo folder in `db/settings.json`, then kill the server process.

## Causes (code as of 1.9.71)

| # | Problem | Where |
|---|---|---|
| 1 | The scan root is `agentsRoot \|\| terminalCwd \|\| HOME`. `workspaceRoot`, the field users set first, is never consulted. The same expression is copied in three places. | `server/v1.js:85`, `server/workers.js:756` (`agentsRootFor`), `mcp/tools/capabilities.js:27` (uses `os.homedir()`) |
| 2 | Falling back to the whole home folder is a dangerous default. A missing setting should mean "no scan" or "scan a known projects folder", not "scan everything". | same |
| 3 | `scanAgents` skips only `node_modules`, `.git`, `dist` and `.qalatra-worktrees`, plus the user's `agentExcludeFolders`. It has no depth limit and doesn't skip `Library`, `CloudStorage`, `.Trash`, mounted volumes, or dot-folders such as `.cache` and `.npm`. | `server/agents.js:29` |
| 4 | Nothing bounds the scan. With no timeout or progress, a request can hang forever, and the UI has no way to tell "scanning" from "broken". | `server/v1.js` `agentsForSettings`, `server/agents.js` `walk` |
| 5 | One slow request takes down the whole Terminal panel, because the agents list is needed only for the New Claude/agent picker and should not block shells. | `ui/src/components/TerminalManagerView.tsx:86` |
| 6 | The docs disagree with the UI. The README's "Working directory" setup step describes one field that sets both the terminal cwd and the scan root, but the UI has three fields (Workspace root, Terminal working directory, Agents scan root), and the one the README implies is the first one, which the scan ignores. | `README.md:176`, `ui/src/components/settings/GeneralSettings.tsx:135-181` |
| 7 | `agentsRoot` is not `~`-expanded, though `files.js` expands file roots with `expandHome`. Typing `~/qalatra-demo` into "Agents scan root" would fail to find anything. | `server/agents.js`, compare `server/files.js:30` |

## Proposed fix

1. **One resolver.** Add `resolveAgentsRoot(settings)` in one module and use it in all three call sites. Order: `agentsRoot` → `workspaceRoot` → `terminalCwd` → **none**. Run each value through `expandHome`.
2. **Remove the HOME fallback.** With no root configured, skip the scan, return `[]` with a `needsSetup: true` flag (or equivalent), and have the UI prompt the user to pick a folder. If a default is wanted for first run, use an explicit, shallow one (such as `~/IdeaProjects` if it exists), never `~` itself.
3. **Hard skips in `scanAgents`**, applied whatever the root:
   - `Library` (directly under any home folder), `CloudStorage`, `Mobile Documents`, `.Trash`, `/Volumes`, `/proc`, `/sys`.
   - Any dot-folder except `.claude`, if agents can live there (check first).
   - macOS package directories (`*.app`, `*.logicx`, `*.photoslibrary`, `*.band`, `*.scriv`, and so on). A test on the extension is enough; agents never live inside a package.
   - Symlinked directories: they're already skipped, because `Dirent.isDirectory()` is false for a symlink. Keep that, and add a test so it stays that way.
4. **Bound the walk.** Set a max depth (6–8 is plenty for `project/agents/type/`) and a visited-directory cap (about 20k). Log a warning naming the root when either is hit, so a too-wide root shows up in the logs instead of as a hang.
5. **Decouple the Terminal panel.** Load sessions and roots first and render them; fetch agents separately and show the picker as loading or failed. **New shell** should never wait on the agent scan.
6. **Fix the README setup step** so it matches the three fields, or collapse the UI to one primary field with the other two under "Advanced". If `workspaceRoot` becomes part of the resolver chain (step 1), the README's description becomes true.

## Tests

- `resolveAgentsRoot` covers each combination of the three settings, with `~` expansion, and returns `null` when all are empty.
- `scanAgents` on a temp tree containing `Library/CloudStorage/x/agent.config`, `Foo.app/agent.config`, a symlinked directory and a depth-10 folder registers none of them. A normal `proj/agents/a/agent.config` is still found.
- Agents API with no root configured returns immediately with the needs-setup signal, and never calls `readdir` on `$HOME`.
- Terminal panel: with `fetchAgents` never resolving, the session list and **New shell** still work (component test).

## Related cleanup on an affected install

A scan that ran against `$HOME` leaves agents from unrelated folders in the agents table. After the fix, a rescan with the correct root should prune them: `upsertAgents(…, { root })` prunes only rows under the scanned root, so check that rows outside every configured root are dropped too, or provide a "reset agent registry" action.
