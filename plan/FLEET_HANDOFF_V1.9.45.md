# Fleet handoff — Qalatra v1.9.45 (FlightDesk integration)

For the `qalatra-fleet` manager. The question to answer: **does the fleet need an Ansible role for
`.flightdeskrc`, and what else changes on a box?** Short version: yes, a small one — but not yet
fleet-wide, and nothing needs to happen for the upgrade itself to be safe.

Design record (all decisions, both sides): `flightdesk/docs/2026-09-17-orchestration-plan-shared.md`.
Operator doc: `qalatra/docs/flightdesk-integration.md`.

## What v1.9.45 does on a box

1. **Nothing FlightDesk-related activates on its own.** The integration is inert unless an agent
   folder holds a `.flightdeskrc`. Booted with API, MCP and workers: zero bound folders, zero
   outbound calls. The existing pipelines, watchers, and `flightdesk register` dispatch keep
   working exactly as they do today.
2. **One behavioural change everyone gets:** at most one job runs per agent folder at a time
   (`getQueuedJobs`, per `concurrency_key` defaulting to the folder). Two jobs queued on the *same*
   folder now run one after the other. Different folders are unaffected. This is the fix the
   pipeline builder asked for (8.10/D20) and it closes a real collision on shared checkouts.
3. Additive schema only (three columns, two tables, idempotent migrations). No data migration.

So the upgrade is a normal roll. The role below is about *enabling* the integration on chosen
folders, box by box, when FlightDesk's side is ready.

## The `.flightdeskrc` file — what the role would manage

**Placement is per agent folder, never per home directory.** FlightDesk binds one AGENT user per
agent folder, so the credential *is* the folder's identity. Qalatra reads
`<agent folder>/.flightdeskrc` only; there is deliberately no fallback to `~/.flightdeskrc`
(that would make every folder poll as the same user and hand one folder's dispatches to whichever
polled first).

```json
{ "apiKey": "<FlightDesk API key for THAT folder's agent user>", "apiUrl": "https://api.flightdesk.dev" }
```

- `apiUrl` optional; `FLIGHTDESK_API_URL` in the server environment overrides the default.
- Mode `0600`, owned by the service user. The key is a bearer token with that agent user's rights.
- **Which folders:** one *management* folder per repo (D24) — the folder that holds the checkout,
  `gh`, claude-bridge access and the canonical prompt; today's `plan/`, `execute-plan/`,
  `pipeline/` split collapses onto it over time. Initially: only the folders Justin names for the
  Shi canary. Do not template it into every discovered agent folder.
- **Key source:** FlightDesk issues one API key per agent user (`ApiToken`, per user). They come
  from FlightDesk, not from Qalatra; the role needs them as vault variables, e.g.
  `flightdesk_folder_keys: { "/home/shi/projects/foo/pipeline": "fd_…" }`.
- Add `.flightdeskrc` and `.flightdesk-outbox/` to each agent folder's `.gitignore` (agent folders
  live inside git repos). Qalatra's attachment denylist already refuses to upload `.flightdeskrc`
  (`/^\.[^/]*rc$/`), but the gitignore is still the fleet's to keep.

**Coexistence with today's `~/.flightdeskrc`:** boxes already have a home-directory rc for
`flightdesk register` (the CLI reads only home today). That keeps working; the poller ignores it.
Until FlightDesk ships the CLI change that prefers `./.flightdeskrc` (F23), in-job CLI calls
still authenticate as the home rc's user — fine for `register`, wrong for `questions ask` /
`turn end` once those exist. That is FlightDesk's item, not the fleet's, but it gates when a
folder should be bound.

## Proposed role: `flightdesk_binding` (small)

- Inputs: `flightdesk_folder_keys` (folder → key, vault), optional `flightdesk_api_url`.
- Tasks: template `.flightdeskrc` (0600) into each listed folder; ensure the two gitignore lines;
  ensure `.flightdesk-outbox/` exists (0700) so the CLI can write there when FlightDesk is down.
- Removing a folder from the map removes the file — unbinding is just deleting it; the poller
  notices on the next tick (rc is re-read by mtime).
- Idempotent; safe to run before FlightDesk's side exists (a bound folder with no dispatches just
  polls an empty list every 30 s).

Optional, same role or `mcp_hygiene`:
- `CLAUDE_BRIDGE_URL` in the server environment only if a box's bridge is not on
  `http://127.0.0.1:7878/mcp` (default). `SESSION_OP` needs the bridge; a box with no Chrome window
  reports `dependency_down` for those, which is correct and which FlightDesk's circuit breaker
  is meant to act on.
- `settings.flightdeskEnabled: false` in the Qalatra settings file as a kill switch that leaves
  the files in place.

## Rollout order (8.17/D19)

Per box, not fleet-wide: **Shi (P&F/Linear) first**, watcher left running as a cross-check until
N tasks complete end to end; then Moceanic (Drift), Biz to Biz (Bizzy), Monroe (Wisp/Loom/Forge)
last. No box retires its watcher until FlightDesk's gate list is live (intake sync, `end_turn`,
rendered prompts, webhook→dispatch). When it does, the watcher heartbeat becomes a **daily hygiene**
heartbeat (8.13), not deleted.

## Verification on a box

```bash
# integration status: bound folders, last poll, last ok, errors, rejected credentials
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3456/api/v1/integrations | jq .
# force a poll
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3456/api/v1/integrations/flightdesk/poll | jq .
# in the app: Settings → Integrations
```

- `rejectedAt` set = FlightDesk returned 401/403 for that folder's key; Qalatra retries every
  5 min so the attempt stays visible. Fix the key; no restart needed.
- A folder that is bound but never appears = the file is unreadable or has no `apiKey`.
- FlightDesk's side shows `lastPollAt` per binding — a silent box is visible there without any
  fleet plumbing. Nothing to add to the fleet watcher for this release.

## What the fleet does NOT need to do

- No inbound port, tunnel, or Access change: the box only makes outbound HTTPS to FlightDesk.
- No MCP exposure: nothing in this design reaches Qalatra's MCP from FlightDesk.
- No change to slices/cgroups: dispatched jobs are ordinary agent jobs and land in
  `qalatra-agents.slice` like any other. `SESSION_OP` runs inside Qalatra Server itself (a few
  HTTP calls to the local bridge), not as a spawned process.
- No `.flightdeskrc` in `$HOME` for the poller. Leave the existing one alone for `register`.
