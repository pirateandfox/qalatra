# Fleet handoff — Qalatra v1.9.39

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
- `MemoryMax` is finite (currently configured as `3584M`, not `infinity`).
- The live Qalatra-launched agent appears in that slice, not `qalatra-server.service`.
- The supervised job completes normally and Qalatra/MCP health remains green.

Record the exact observations in the fleet change/incident task. If either box fails placement, stop
the rollout investigation there; do not weaken or copy memory limits to make the check pass.
