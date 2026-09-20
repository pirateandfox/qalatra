# FlightDesk: the folder's credential must reach the job environment

Status: **implemented 2026-09-20** (`buildAgentEnv` / `flightdeskRcEnv` in `server/workers.js`,
9 cases in `npm run test:flightdesk-dispatch`); awaiting on-box verification on shi after the
next release. Origin: shi canary, 2026-09-20. Fleet-side analysis lives in
qalatra-fleet (conversation of the same date); this file is the Qalatra-side change.

## The bug

A bound folder's `.flightdeskrc` is used by the **poller** only. The **job** Qalatra launches in
that folder never sees it: `buildAgentEnv()` in `server/workers.js` copies the server's
`process.env`, layers `settings.agentEnv` and `agent.config.env`, and that is all. The `flightdesk`
CLI inside the job then finds a key by walking up from its cwd
(`flightdesk/apps/cli/src/lib/config.ts:26-38`: `./.flightdeskrc`, then each ancestor, then
`~/.flightdeskrc`; `FLIGHTDESK_API_KEY` / `FLIGHTDESK_API_URL` override all of that).

The pipeline agent on shi is bound at `~/workspaces/pirateandfox.com/agents/pipeline`, but its
first act is `cd` to the repo root — which is *above* the agent folder. The walk never reaches
the folder's rc and lands on `~/.flightdeskrc`, which holds Justin's key. Every `flightdesk turn end`,
`plan submit`, `dispatch list` from inside the repo runs as Justin, not as the Shi agent user. The
integration's own promise — "the credential *is* the folder's identity" (`rc.js` header comment,
`docs/flightdesk-integration.md`) — holds for polling and silently breaks for the job.

This is a Qalatra bug, not a box-config bug: it recurs on every box we bind (drift → bizzy →
monroe are next), and the fleet-side workaround (per-folder `agent.config.env` pointing at a
per-box secret name) is plumbing that would have to be repeated per box and per folder.

## The change

When a job launches in a folder that holds a readable `.flightdeskrc`, inject that rc's
credential into the job environment as the CLI's own override variables:

```
FLIGHTDESK_API_KEY = rc.apiKey
FLIGHTDESK_API_URL = rc.apiUrl      # rc.js already resolves this: file → env → DEFAULT_API_URL
```

The CLI treats those as overriding every file lookup, so it no longer matters what directory the
agent is in. Folders without an rc get nothing — no fallback, same rule as the poller.

### Where

`server/workers.js`, in the launch loop, right after `buildAgentEnv()` and **before** the
reserved-name assignments (`templateEnv`, `externalEnv`). Concretely, around line 661:

```js
import { loadFolderRc } from './integrations/flightdesk/rc.js'
// ...
/**
 * The folder's FlightDesk credential is its identity (integrations/flightdesk/rc.js). The CLI
 * inside the job resolves a key by walking up from its cwd, which an agent that cds into its
 * repo root leaves behind — so the credential goes in as the CLI's own override variables.
 */
export function flightdeskRcEnv(agentPath) {
  const rc = loadFolderRc(agentPath)
  return rc ? { FLIGHTDESK_API_KEY: rc.apiKey, FLIGHTDESK_API_URL: rc.apiUrl } : {}
}
// ...in the launch loop:
const agentEnv = buildAgentEnv(settings, cfg, shellBin)
Object.assign(agentEnv, flightdeskRcEnv(job.agent_path))
```

`rc.js` has no imports from `workers.js`, so this does not create a cycle
(`integrations/flightdesk/index.js` already imports from `workers.js`; `rc.js` is a leaf).

### Precedence, decided

Order in the final env, lowest to highest:

1. server `process.env`
2. `settings.agentEnv`
3. `agent.config.env`
4. **`.flightdeskrc` → `FLIGHTDESK_API_KEY` / `FLIGHTDESK_API_URL`** (new)
5. `templateEnv` (`QALATRA_*`)
6. `externalEnv` (orchestrator-supplied `external_meta.env`)

The rc wins over `agent.config.env` and `settings.agentEnv` on purpose: the file is the binding,
and a stale `agent.config` on a client repo must not be able to re-identify a folder.

**Also add `FLIGHTDESK_API_KEY` and `FLIGHTDESK_API_URL` to the names `externalEnv()` refuses**
(`workers.js:42-55` currently refuses only the `QALATRA_` prefix). Otherwise a dispatch payload
could carry `env.FLIGHTDESK_API_KEY` and swap the job's identity from the outside. Cheapest form:
a small `RESERVED_EXTERNAL` set checked next to the prefix test.

### Scope: every job in the folder, not just dispatches

Inject on every job whose `agent_path` has an rc — heartbeat runs, manual runs, FlightDesk
dispatches alike. The pipeline folder's *heartbeat* jobs call the CLI too (`flightdesk turn end`
is how the pipeline reports), and they are the ones with no `external_meta` at all. Gating on
`external_meta.orchestrator === 'flightdesk'` would leave exactly the jobs that hit this bug
unfixed.

Do **not** gate on `settings.flightdeskEnabled`. The kill switch stops polling; a folder that is
bound but not polled still has one identity, and a job that runs in it should still be that
identity. If the rc is deleted (the fleet's unbind), `loadFolderRc` returns `null` on the next
launch and nothing is injected — no restart, same as the poller.

### Things that are deliberately not in scope

- **No MCP header handling.** The `flightdesk` MCP server in `~/.claude.json` reads its
  `Authorization` header from `${CLAUDE_MCP_FLIGHTDESK_AUTHORIZATION}` — a fleet-named variable.
  Qalatra should not know that name. The fleet will map it on its side once this lands
  (the value is `Bearer <same key>`).
- **No `~/.flightdeskrc` reading.** Same reason as the poller.
- **No change to `rc.js`.** `loadFolderRc` already returns `{ apiKey, apiUrl, file }` with `apiUrl`
  fully resolved, and caches by mtime; calling it once per launch is free.
- **No new settings.** There is nothing to configure: rc present → identity injected.

## Tests

Extend `scripts/test-flightdesk-dispatch.mjs` (`npm run test:flightdesk-dispatch`) or add a
sibling `scripts/test-flightdesk-job-env.mjs` wired into `package.json`. Cases:

1. Folder with `{ "apiKey": "k1", "apiUrl": "https://x.test" }` → launched env has
   `FLIGHTDESK_API_KEY=k1`, `FLIGHTDESK_API_URL=https://x.test`.
2. Folder with `{ "apiKey": "k1" }` and no `FLIGHTDESK_API_URL` in the server env →
   `FLIGHTDESK_API_URL=https://api.flightdesk.dev` (rc.js `DEFAULT_API_URL`).
3. Folder with no rc → neither variable present, even when `settings.agentEnv` or the server env
   sets an unrelated `FLIGHTDESK_*` name (nothing is stripped, nothing is added).
4. `agent.config.env.FLIGHTDESK_API_KEY = "wrong"` in a bound folder → the rc's key wins.
5. `external_meta.env.FLIGHTDESK_API_KEY = "wrong"` → refused; the rc's key is what the job sees.
6. A job that runs in a bound folder with **no** `external_meta` (a heartbeat) still gets the
   variables — the case the shi canary actually hit.
7. rc deleted between two launches → second launch has no variables (mtime cache miss on a
   missing file, per `rc.js`).

`scripts/test-flightdesk-dispatch.mjs` tests pure exports (`externalEnv`, `buildPrompt`, …), not
the spawn. As built: `flightdeskRcEnv(agentPath)` is the pure helper, and the injection is folded
into `buildAgentEnv(settings, cfg, shellBin, agentPath)`, which is now exported — so case 4 asserts
the real precedence chain rather than a re-implementation of it, and the launch loop changes by one
argument. Case 5 extends the existing `externalEnv refuses reserved and malformed names` check.

## Docs

`docs/flightdesk-integration.md`, "What the agent sees" → the Environment bullet. Add:

> `FLIGHTDESK_API_KEY` and `FLIGHTDESK_API_URL` from the folder's `.flightdeskrc`, on every job
> that runs in a bound folder. The CLI honours these over any `.flightdeskrc` it would otherwise
> find by walking up from its cwd, so an agent that works from its repo root is still its own
> folder's agent user.

`docs/capabilities.md:71` (the `agent.config.env` paragraph): one sentence noting that a bound
folder's FlightDesk credential overrides `env` entries of the same name.

## Verification on shi after release

From **inside the repo checkout** on shi (not the agent folder), as a Qalatra job (heartbeat or
`POST /api/v1/agents/run` with a prompt that runs these) — a hand-run shell will not have the
job env and proves nothing:

```
flightdesk whoami                 # or `flightdesk dispatch list`: must be the Shi agent user, no error
env | grep ^FLIGHTDESK_API_       # both present, URL = https://api.flightdesk.dev
```

If either shows Justin's identity or "not found", the wrong key is still winning. The fleet-side
follow-ups (MCP header var, `GH_TOKEN` refresh, `flightdesk_project_id` in `pipeline-config.md`,
retiring `~/.flightdeskrc` once the watcher heartbeat is gone) are tracked in qalatra-fleet and
are not gated on this change landing, but the MCP header one is only *complete* once this does.

## Release

Additive, no migration, no settings. Ship as a patch on the next release; the fleet updater rolls
it unattended. Nothing on the boxes needs to change for it to take effect — the rc files are
already there.
