# Agent concurrency and memory diagnostics

Implements the first-release scope of
[`qalatra-fleet/docs/qalatra-memory-scheduling-change-request.md`](../../qalatra-fleet/docs/qalatra-memory-scheduling-change-request.md).
Memory reservations remain a separate follow-up. This change does not resize host slices.

## Operator interface

All endpoints below require Qalatra's existing `full_access` bearer token.

- `PATCH /api/v1/settings` with `{"maxConcurrentJobs":2}` changes only that property.
  The merge and save occur together on the server, after request parsing, so unrelated
  settings are preserved. This is the preferred fleet interface.
- `PUT /api/v1/settings` and `POST /api/v1/settings/import` still replace the entire
  document. Do not send a one-key PUT unless discarding all other settings is intended.
- `GET /api/v1/settings/worker` returns, for example:
  `{"ok":true,"worker":{"maxConcurrentJobs":2,"admittedJobs":3,"paused":false}}`.
  This is a probe of the running server's support and current policy. A successful settings
  write to an older server does not prove support: older versions accept unknown properties.

`maxConcurrentJobs` must be a JSON number representing a nonnegative safe integer
(0 through 9007199254740991). Strings, null, booleans, fractions, negative numbers and
non-finite/unsafe numbers are rejected with HTTP 400, including imports. An omitted
property retains the default of **3**. An invalid value already on disk logs a diagnostic
and uses **3**, never an unbounded value or an accidental pause.

The scheduler rereads the setting on each normal 30-second pass and between admissions
in a slow batch. One pass owns admission at a time. It reserves a slot before claiming a
job and preparing its worktree; successful runs retain it through process/scope cleanup.
All job sources use this same path. Existing atomic claims, per-key exclusion, queue order,
worktree selection and startup orphan handling remain in place.

Lowering 3 to 2 keeps all three current jobs alive. No replacement starts until fewer
than two are admitted. **0 pauses new admissions and drains existing runs**; restoring a
positive value resumes on the next pass without restarting. An admitted job can still be
preparing its worktree, so this count may exceed the number of spawned CLI processes.
The status endpoint may temporarily show more admitted jobs than the new limit during a
drain. Logs report policy/count changes under `[workers] admission`.

## OOM evidence

The worker captures scope and slice `memory.high`, `memory.max`, `memory.events` and
`memory.events.local` during the run and before cleanup. It retains the last readable
scope snapshot if systemd collects the transient cgroup. Evidence includes requested
per-run limits, observed limits (bytes or `max`), scope local counts since creation,
and slice counter deltas since launch. These are cgroup-level configured limits; they
are not a calculation of every ancestor's available headroom.

A positive scope `oom_kill` count confirms an OOM victim in that run. It does **not**
identify the constraining cgroup. The kernel defines `oom_kill` as victims of any OOM
killer, and hierarchical slice counters include descendants. See the
[kernel cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files).

At an OOM or abrupt exit the worker makes a bounded, unprivileged kernel-journal query
(1.5-second timeout, 256 KiB output cap). Only `oom-kill` records from this run's time
window whose `task_memcg` matches this job's scope or a descendant can attribute the
constraint through `oom_memcg`. No sudo or journal permission change is required.
Scope and shared-slice matches get specific advice; another ancestor, conflicting
matches or no accessible evidence leave the constraint **unknown**. Local allocation
failure counters are retained as evidence but cannot disambiguate concurrent events.

A sibling's hierarchical OOM counter increase plus this job's SIGKILL/exit 137 is only
**possible OOM**, never confirmation. With missing evidence an abrupt exit explicitly
reports that an OOM kill could not be confirmed. Sampling can miss a scope created and
collected between observations; unavailable journal access also leaves uncertainty.
Completion and cleanup continue in both cases.

Confirmed OOMs keep `status=failed`, `terminated_by=oom` and `diagnostics.kind=oom`.
Unknown constraints get no unconditional recommendation to raise the per-run cap.
Unconfirmed kills remain ordinary failures. Result text retains the evidence, partial
output and session ID; lifecycle hooks additionally receive `diagnostics.memory`.
Timeout classification takes precedence over OOM speculation. Resumable sessions,
whole-scope cleanup and FlightDesk's existing diagnostic mapping are preserved.

## Verification and rollout

Local regression commands:

```sh
npm run test:job-scheduler
npm run test:agent-memory
npm run test:job-concurrency
npm run test:worktrees
npm run test:agent-watchdog
npm run test:worker-command-templates
npm run test:output-rules
npm run test:flightdesk-dispatch
npm run check-imports
```

Scheduler tests cover default/changed limits, drain/resume, overlapping passes, slow
preparation, invalid persisted values, claim/setup failures and duplicate release.
Worker tests launch actual disposable processes and check completion, timeout, cancellation,
spawn errors and retained sessions/output. Memory tests use Linux cgroup-file and kernel-log
fixtures, including collected/missing scopes, denied journal access and sibling OOMs.
DB tests cover per-key/worktree exclusion; watchdog tests exercise actual systemd scopes
when a Linux user manager is available and explicitly skip that part elsewhere.

Fleet owns deployment and host policy. Release supporting code first; plan active-run
handling before any server restart. An old server cannot use the new drain control.
Then apply drift's `qalatra_max_concurrent_jobs: 2` with the `qalatra_worker` tag, which
requires running-server support and uses PATCH without restarting. Other hosts have no
managed setting. See the [fleet rollout runbook](../../qalatra-fleet/docs/qalatra-worker-concurrency-rollout.md).

Linux live validation and the 24-hour production observation are rollout requirements,
not claims made by local fixture tests. Record scope membership/limits and slice-local
OOM deltas, kernel attribution where accessible, PSI, peaks, completed jobs, queue wait,
and timeouts before and after representative overlapping builds. Success requires the
ceiling to hold, zero new shared-slice OOMs, materially reduced stalls and preserved
completed-job throughput. Report scope-limit OOMs separately.
