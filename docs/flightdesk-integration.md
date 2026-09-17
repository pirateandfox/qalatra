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
`RESUME`/`ANSWER` runs before older kinds on the same task; a `SESSION_OP` is left unacked (not
built yet). At most one job runs per agent folder at a time (`concurrency_key`).

## Operating

- `GET /api/v1/integrations` — per-folder status: last poll, last success, last error, whether
  the credential was rejected, open request count.
- `POST /api/v1/integrations/flightdesk/poll` — poll now.
- A rejected credential (401) is retried every 5 minutes so the attempt stays visible.
- `settings.flightdeskEnabled = false` turns the integration off without removing any file.
- Tests: `npm run test:flightdesk-dispatch`, `npm run test:job-concurrency`.

## Layers (the boundary rule)

Generic core, in `db-worker.js` / `server/workers.js`: `queueExternalJob`, `external_ref` /
`external_meta` / `resume_session` on jobs, `orchestrator` / `orchestrator_ref` on tasks,
`onJobStarted` / `onJobFinished` / `orphanedAtBoot` hooks, `externalEnv`, `diagnosticsKindFor`.
FlightDesk-specific, in `server/integrations/flightdesk/`: the rc loader, the GraphQL client, the
dispatcher, and the tick. A second orchestrator would use the same core surface.
