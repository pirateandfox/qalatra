# Fleet handoff — Qalatra v1.9.39

> **Executed 2026-09-02. All four sections complete.** Three corrections were needed and are
> marked **CORRECTED** inline below: the §2 rollout command does not work on already-provisioned
> boxes, §3's target list left three boxes on a stale watcher, and §4's expected `MemoryMax` was
> stale. Fleet result: all six boxes on v1.9.39, agents placed in bounded slices, all five
> deployed watchers alerting on timeouts.

## Outcome

Roll v1.9.39 to the Linux fleet, teach the independent fleet watcher to alert immediately on a
`timed_out` pipeline job, and verify that Loom and Forge actually place Qalatra-spawned agents in
their bounded slice. Do not replace these with hand-edits on individual boxes: make the alert change
once in its canonical source and deploy it through `qalatra-fleet`.

## 1. Confirm the release is ready

Wait for the GitHub release workflow for `v1.9.39` to finish successfully. The fleet checks out
`origin/develop`, not release assets, so also confirm that the tag is contained by the remote branch:

```bash
git -C ~/IdeaProjects/qalatra fetch origin --tags
git -C ~/IdeaProjects/qalatra merge-base --is-ancestor v1.9.39 origin/develop
gh release view v1.9.39 --repo pirateandfox/qalatra
```

Do not roll while the release workflow is red or while the ancestry check fails.

## 2. Canary Qalatra on Shi, then roll the fleet

> **CORRECTED — do not use `-e qalatra_run_bootstrap=true` on an already-provisioned box.**
> The bootstrap script does not stop at Qalatra: it continues into
> `install-cloudflare-tunnel.sh`, which runs `cloudflared tunnel login`, prints a browser URL
> and blocks. On Shi it waited 8 minutes and died with "Failed to write the certificate",
> producing `failed=1` and aborting the role before its post-bootstrap tasks (including a
> credential-removal step). It is also redundant: these boxes are served by a Fleet-worker
> managed *system* `cloudflared.service`, not the user tunnel bootstrap installs. Run
> fleet-wide it would mean six failures and ~8 wasted minutes each.
>
> It also moved Shi from detached-at-tag onto the `develop` branch. Every box otherwise sits
> detached at its release tag, because the `qalatra-updater` that actually maintains them
> follows **published GitHub Releases** (`/releases/latest` → `git reset --hard v<version>`),
> not `origin/develop`. The "fleet checks out origin/develop" note above describes the
> bootstrap path only; the two mechanisms disagree, and the updater is the one in force.
>
> **Use the updater instead** — proven on 1.9.38 and 1.9.39, ~90s per box, no interactive step,
> and it keeps every box detached at the release tag:
>
> ```bash
> # check for in-flight agents first: the update restarts qalatra-server and kills them
> ssh <box> 'ps -eo cmd | grep -c "[c]laude --dangerously-skip-permissions -p"'
> ssh <box> 'systemctl --user start qalatra-updater.service'
> ```
>
> Canary one box, verify, then the rest. The verification commands below are still correct and
> the watchdog regression (`node scripts/test-agent-watchdog.mjs`) is still the right gate — it
> passed on Shi.

Run every Ansible command through the fleet wrapper; bare `ansible-playbook` does not load the
dedicated SSH agent or the live dynamic-inventory database.

```bash
cd ~/IdeaProjects/qalatra-fleet
scripts/with_fleet_ssh_key.sh ansible-playbook playbooks/site.yml \
  --tags qalatra -e qalatra_run_bootstrap=true \
  --limit agent-shi.qalatra.com

curl -fsS https://api-shi.qalatra.com/health
scripts/with_fleet_ssh_key.sh ansible agent-shi.qalatra.com \
  -m ansible.builtin.shell \
  -a 'cd ~/qalatra && node -p "require(\"./package.json\").version"'
scripts/with_fleet_ssh_key.sh ansible agent-shi.qalatra.com \
  -m ansible.builtin.shell \
  -a 'cd ~/qalatra && node scripts/test-agent-watchdog.mjs'
```

The version must be `1.9.39`, health must be green, and the watchdog regression must pass. Then:

```bash
scripts/with_fleet_ssh_key.sh ansible-playbook playbooks/site.yml \
  --tags qalatra -e qalatra_run_bootstrap=true
scripts/with_fleet_ssh_key.sh ansible-playbook playbooks/verify.yml

for h in shi loom wisp forge; do
  curl -fsS -o /dev/null -w "$h: %{http_code}\n" "https://api-$h.qalatra.com/health"
done
```

An `UNREACHABLE` result is not proof that a box is down; follow `qalatra-fleet/AGENTS.md` and verify
one accused host directly before diagnosing it.

## 3. Complete timeout alerting in the independent fleet watcher

Qalatra now records a timeout accurately, but native Qalatra notification is intentionally not the
dead-man's switch: an alert emitted by the frozen service would share the failure mode it watches.
The canonical external watcher is:

```text
~/IdeaProjects/projects/shi/tools/fleet-alerting/fleet-pulse.py
```

Its `assess()` function currently trips immediately only for `status == "failed"`. Add a separate
`timed_out` branch before the stale-age check with these semantics:

- `down: true`
- dedupe key `timeout:<job_id>`
- severity `down_severity`
- event type `agent_timeout`
- summary `<heartbeat name> heartbeat TIMED OUT`
- detail containing the job id, run time, and first result line (which identifies wall-clock versus
  idle timeout and says whether the session is resumable)

Do not fold `timed_out` into `failed`; Qalatra deliberately keeps resource enforcement separate from
agent failure. Add fixture coverage proving a recent `timed_out` row alerts immediately rather than
being reported healthy until `stale_minutes` elapses. Update the fleet-alerting README's “first fail”
wording to include timeout, then commit and push the canonical workspace change.

> **CORRECTED — the target list leaves three boxes on a stale watcher.** Bizzy and Drift also
> run `fleet-pulse.timer`, active and enabled, so scoping the deploy to Wisp/Loom/Forge leaves
> them reporting a timed-out pipeline as healthy until `stale_minutes` — the exact bug this
> change fixes. Shi runs the watcher straight from its own `~/workspaces/projects` checkout, so
> it updates with a `git pull`, not a copy (use `--autostash`; Shi's checkout carries live agent
> output).
>
> **Bizzy and Drift must NOT be added to the monitoring playbook below.** It is Monroe-specific
> despite taking a `fleet_target`: it copies Monroe MCP/Notion/FlightDesk config from Wisp, and
> selects the heartbeat by the literal title `"Code Pipeline"`. Drift's is named
> **"Moceanic Code Pipeline"**, so the `selectattr` matches nothing, a spurious "Code Pipeline"
> heartbeat gets created, and Drift's watcher is repointed off the pipeline it guards.
> `fleet-alerting/install-remote.sh` is no safer — it rewrites `config.json` outright.
>
> For a script-only change use the narrow vehicle added for this, which touches nothing but the
> file (qalatra-fleet `983b616`):
>
> ```bash
> scripts/with_fleet_ssh_key.sh ansible-playbook playbooks/sync_fleet_pulse_script.yml \
>   -e fleet_target='agent-bizzy.qalatra.com:agent-drift.qalatra.com'
> ```

Deploy that one source through the existing monitoring playbook—no direct copies or per-box edits:

```bash
cd ~/IdeaProjects/qalatra-fleet
scripts/with_fleet_ssh_key.sh ansible-playbook \
  playbooks/configure_monroe_pipeline_monitoring.yml \
  -e fleet_target='agent-wisp.qalatra.com:agent-loom.qalatra.com:agent-forge.qalatra.com'
```

Run the watcher self-test/once path on each target and inspect
`~/.config/qalatra/fleet-pulse/run.log`. Do not manufacture a live timed-out database row in a
production Qalatra database; exercise the new branch with the fixture test and use the watcher's
existing notification self-test for delivery.

## 4. Verify bounded agent placement on Loom and Forge

The slice limits are committed in both host-var files, but that does not prove the unit was applied
or that a Qalatra-spawned process entered it. First reapply the owning role:

```bash
cd ~/IdeaProjects/qalatra-fleet
scripts/with_fleet_ssh_key.sh ansible-playbook playbooks/site.yml \
  --tags mcp_hygiene \
  --limit 'agent-loom.qalatra.com:agent-forge.qalatra.com'
```

On each box, require a finite ceiling:

```bash
systemctl --user show qalatra-agents.slice \
  -p FragmentPath -p MemoryHigh -p MemoryMax -p MemorySwapMax
```

Then queue one supervised, long-enough Qalatra agent job. While it is running, resolve the slice's
control group and inspect its members rather than using a broad `pgrep -f` match:

```bash
cg=$(systemctl --user show qalatra-agents.slice -p ControlGroup --value)
sed 's/^/pid /' "/sys/fs/cgroup${cg}/cgroup.procs"
ps -o pid,ppid,etime,cmd -p "$(paste -sd, "/sys/fs/cgroup${cg}/cgroup.procs")"
```

Pass criteria on both Loom and Forge:

- `FragmentPath` points at the installed `qalatra-agents.slice` unit.
- `MemoryMax` is finite, not `infinity`. **CORRECTED:** `3584M` was the first-pass sizing. A
  re-measure from 24h of observed peaks (qalatra-fleet `514b339`) set per-box values — Loom
  `1792M`, Forge `2048M`, Wisp `2048M`, Bizzy/Drift `2560M`, Shi `4608M`. Check for *finite*,
  not for a specific number, and read the committed host_var rather than this document.
- The live Qalatra-launched agent appears in that slice, not `qalatra-server.service`.
- The supervised job completes normally and Qalatra/MCP health remains green.

Record the exact observations in the fleet change/incident task. If either box fails placement, stop
the rollout investigation there; do not weaken or copy memory limits to make the check pass.

---

## Results — executed 2026-09-02

### §2 Rollout

Shi canaried first: v1.9.39, health green, `node scripts/test-agent-watchdog.mjs` →
`agent watchdog tests passed`. Remaining five rolled via `qalatra-updater`. Loom was held until
its in-flight agent finished rather than killing it.

All six on v1.9.39 (`1d7ba91`), detached at the tag, checkouts clean, zero server errors, and
`api-{shi,wisp,loom,forge}.qalatra.com/health` all 200. MCP answered a real `initialize`
handshake on every box (Shi correctly 401s headerless — it is the only box with a full-access
token provisioned).

### §3 Timeout alerting

`assess()` gained a `timed_out` branch ahead of the stale-age check — `down`, key
`timeout:<job_id>`, severity `down_severity`, event `agent_timeout`, detail carrying job id, run
time and first result line. Kept separate from `failed`.

The status string was confirmed against `server/workers.js:581` rather than taken from this
document. Fixture coverage in `test_fleet_pulse_core.py` (7 tests, matching the repo's existing
`unittest` convention) — and verified to actually catch the regression: with the branch removed
4 of 7 fail, and the recent-timeout case returns `down=False`, which is precisely the
silent-healthy window. Canonical change is `projects` `f23a007`.

Deployed to **all five** boxes that run the watcher (the three in scope, plus Bizzy and Drift via
the new narrow playbook, plus Shi by `git pull`). Deployed sha `c71cb51e0ad6` matches the
canonical source on every box. `--once` exits 0 everywhere; `run.log` shows `healthy — no action`.
Heartbeat bindings confirmed unchanged afterwards: Bizzy `Code Pipeline` 449d9a16, Drift
`Moceanic Code Pipeline` 337a3b81, Shi `Code Pipeline` ac2c6e32.

### §4 Bounded agent placement

Both boxes verified with a **real live Qalatra-launched agent**, not an inferred result.

| | Loom | Forge |
| --- | --- | --- |
| `FragmentPath` | installed unit | installed unit |
| `MemoryMax` | `1792M` (finite) | `2048M` (finite) |
| Live agent cgroup | `…/qalatra.slice/qalatra-agents.slice/run-*.scope` | `…/run-p84551-i16853695.scope` |
| Agents in `qalatra-server.service` | 0 | 0 |
| Supervised job | natural scheduled pipeline agent | `status: done`, `terminated_by: null` |

Forge runs no heartbeats of its own, so its job was created through Forge's own MCP against a
real agent folder and deleted afterwards — no DB rows were written by hand.

Note the slice nests as `user@1001.service/qalatra.slice/qalatra-agents.slice`, under a
`qalatra.slice` parent created by systemd's dash-naming — **not** under `app.slice` where
`qalatra-server.service` lives. That parent is unbounded, which is harmless while everything real
runs in the bounded child, but it is the wrong place to look when verifying.
