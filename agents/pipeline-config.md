# Pipeline Config — qalatra

## Repo
| Field | Value |
|---|---|
| `repo_name` | `qalatra` |
| `github_slug` | `pirateandfox/qalatra` |
| `base_branch` | `develop` |
| `repo_path` | resolve at runtime with `git rev-parse --show-toplevel` — portable across Mac (`~/IdeaProjects`) and Linux (`~/workspaces`) hosts; never hardcode |
| `flightdesk_project_id` | `7da928a2-fa73-4a6e-9eac-e5143f620c95` |
| `sdk_command` | `none` |

## Deployment
| Field | Value |
|---|---|
| `auto_merge` | `true` — the adversarial verifier `MERGE` verdict is the approval; the pipeline merges + deploys directly with no human approval gate (dangerous mode) |
| `deploy_command` | `none` — hosting watches `develop` |
| `merge_command` | `gh pr merge <prNumber> --repo pirateandfox/qalatra --merge --delete-branch` |

## Quality Gates
Canonical checks plus the Intelligence Check; no SonarCloud gate is configured for this repo yet.

## Source System

FlightDesk is the source of truth for task state (D23). This folder's agent never writes status,
comments or state changes to Linear; the FlightDesk turn (`flightdesk turn end`) reports the
outcome and FlightDesk advances the task. Linear is not used for this repo.
