# FlightDesk integration

FlightDesk is an *integration*, not a dependency: standalone Qalatra runs identically with no
FlightDesk code active. Design record and decisions (D1–D28):
`flightdesk/docs/2026-09-17-orchestration-plan-shared.md`.

## What it does

FlightDesk decides **when** an agent should run and records that as a dispatch request addressed
to one agent user. Qalatra Server polls for those requests on its 30 s tick, turns each into an
agent job, and reports the job's lifecycle back. Nothing calls into the box; the only network
traffic is outbound HTTPS to FlightDesk. An empty poll costs no model tokens.

```
FlightDesk dispatch  ──poll──▶  Qalatra job  ──run──▶  agent  ──flightdesk CLI──▶  FlightDesk
      (REQUESTED)      (ACKNOWLEDGED → RUNNING → DONE | FAILED)
```

## Binding a folder

FlightDesk binds one AGENT user per agent folder, so the credential *is* the folder's identity.
Put a `.flightdeskrc` in the folder:

```json
{ "apiKey": "<that agent user's FlightDesk API key>", "apiUrl": "https://api.flightdesk.dev" }
```

`apiUrl` is optional (`FLIGHTDESK_API_URL` in the server environment overrides the default).
Folders without the file are not polled. There is deliberately no fallback to `~/.flightdeskrc`:
that would make every folder poll as the same user and hand one folder's dispatches to whichever
polled first. Add `.flightdeskrc` to the folder's `.gitignore`.

## What the agent sees

- The prompt is FlightDesk's, verbatim, plus — for a `RESUME` — an `## Answers` block Qalatra
  renders from the consumed answers, headed by a treat-as-data line.
- Environment: `FLIGHTDESK_TASK_ID`, `FLIGHTDESK_DISPATCH_ID`, `FLIGHTDESK_DISPATCH_KIND`, and
  when FlightDesk supplies them `FLIGHTDESK_TASK_URL`, `FLIGHTDESK_PREAMBLE_VERSION` — next to the
  usual `QALATRA_*` names.
- `FLIGHTDESK_API_KEY`, `FLIGHTDESK_API_URL` and (when the rc has `organizationId`)
  `FLIGHTDESK_ORGANIZATION_ID` from the folder's `.flightdeskrc`, on every job that runs in a
  bound folder (heartbeats and manual runs included, not only dispatches). The CLI honours these
  over any `.flightdeskrc` it would otherwise find by walking up from its cwd, so an agent that
  works from its repo root is still its own folder's agent user. They are set before
  `agent.config.env` / `settings.agentEnv` expand — so an entry can reference them, e.g.
  `"CLAUDE_MCP_FLIGHTDESK_AUTHORIZATION": "Bearer ${FLIGHTDESK_API_KEY}"` — and re-applied after,
  so those layers cannot replace them. A dispatch's `external_meta.env` may not set them either.
- One Qalatra task per FlightDesk task, created on first dispatch and bound through
  `tasks.orchestrator = 'flightdesk'` / `orchestrator_ref = <FlightDesk task id>`. `source` and
  `source_url` keep saying where the task was born.
- `resumeSession: false` on a dispatch starts the turn on a fresh session; otherwise the task's
  latest session resumes.

## Lifecycle reporting

| Qalatra | FlightDesk |
|---|---|
| job queued | `ACKNOWLEDGED` + `qalatraJobId` |
| process up | `RUNNING` |
| `done` | `DONE` + `resultTail` (8 KB), `resultLength`, `resumable` |
| `failed` / `timed_out` / `orphaned` | `FAILED` + `diagnostics { kind, text }`, `resumable` |

`diagnostics.kind` ∈ `error | timed_out | orphaned | launch_failed | dependency_down`. Only `error`
is the agent's own failure. FlightDesk's ladder cannot step backwards, so reporting always walks
it to the target and treats "already past that" as success — a lost ack or a restart between
steps is harmless, and the next poll reconciles anything FlightDesk still holds open. Jobs that
were running when the server restarted are reported `FAILED / orphaned` at boot.

Rules the poller follows: dedupe by dispatch id (`agent_jobs.external_ref`, unique); skip requests
whose task is blocked; consume answers server-side before queuing a `RESUME`; within one batch a
`RESUME`/`ANSWER` runs before older kinds on the same task. At most one job runs per agent folder
at a time (`concurrency_key`).

## Session operations (`SESSION_OP`, D28)

Some of what a pipeline agent does to a cloud session needs no judgement — relay "CI failed on
PR #12", nudge a rebase, click Create PR, archive after merge, read whether the session is idle.
FlightDesk asks for these as `SESSION_OP` dispatches and **Qalatra Server executes them inline on
the tick through claude-bridge** (`server/session-ops.js`, MCP over HTTP on `localhost:7878`;
`CLAUDE_BRIDGE_URL` overrides). No agent job, no tokens. Only this box can do it: the bridge is a
Chrome window logged into this box's account, so it is never reachable from FlightDesk.

Spec: `{ op: inject | state | archive | create_pr, sessionId, templateId?, prompt?, params? }` —
as fields on the request, under `sessionOp`, or as JSON in `prompt` until FlightDesk has columns.

- `inject` requires a `templateId`: Qalatra never composes an injected prompt and refuses one that
  is not from a FlightDesk-owned template. It does not inspect the text. `DONE` only when the
  bridge verified the prompt landed as a new turn in *that* session; otherwise `FAILED` with
  `inject unverified` and no retry (a retry of an inject that did land double-posts).
- `state` returns `{ state, workerStatus, prUrl, branch, lastTurnAt, lastTurnRole,
  lastTurnEndsWithQuestion }` so "ended asking a human" is visible without an agent.
- Lifecycle is `REQUESTED → DONE | FAILED` directly; on a FlightDesk without that exception the
  reporter falls back to walking the ladder.
- Every executed op is recorded in `external_ops`; a re-delivered request is answered from the
  ledger, never executed twice.
- Deferred, unacked, while any job holds the folder — that agent may be mid-inject itself.
- Bridge unreachable, or the daemon reporting "Chrome not connected", is `FAILED /
  dependency_down`, which FlightDesk's per-box circuit breaker is meant to act on.

## Outbox replay

When the FlightDesk CLI cannot reach FlightDesk from inside a job (`questions ask`, `turn end`,
`task comment`), it writes the GraphQL it failed to send as
`<folder>/.flightdesk-outbox/<ulid>.json` — `{ "query", "variables", "attemptedAt" }`. Each poll
replays that folder's files in name order: sent → deleted; rejected by FlightDesk (deterministic)
→ moved to `failed/` with a reason file; transport failure → left for next time. Counts show in
the status endpoint and the Integrations settings panel.

## Operating

- `GET /api/v1/integrations` — per-folder status: last poll, last success, last error, whether
  the credential was rejected, open request count.
- `POST /api/v1/integrations/flightdesk/poll` — poll now. Bypasses the rejected-credential backoff, so
  a fixed key can be confirmed immediately.
- A rejected credential (401) is retried every 5 minutes on the automatic tick so the attempt stays
  visible; verified on Shi 2026-09-18 (rejected within one tick, recovered at the 5-minute retry).
- `settings.flightdeskEnabled = false` turns the integration off without removing any file.
- Settings → Integrations shows each bound folder's last poll, errors, and counts.
- Tests: `npm run test:flightdesk-dispatch`, `npm run test:job-concurrency`.

## Layers (the boundary rule)

Generic core, in `db-worker.js` / `server/workers.js` / `server/session-ops.js`: `queueExternalJob`,
`external_ref` / `external_meta` / `resume_session` on jobs, `orchestrator` / `orchestrator_ref` on
tasks, the `external_ops` ledger, `onJobStarted` / `onJobFinished` / `orphanedAtBoot` hooks,
`externalEnv`, `diagnosticsKindFor`, and the claude-bridge session-ops client.
FlightDesk-specific, in `server/integrations/flightdesk/`: the rc loader, the GraphQL client, the
dispatcher, and the tick. A second orchestrator would use the same core surface.
