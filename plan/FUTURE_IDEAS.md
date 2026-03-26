# Future Ideas

Low-priority or speculative ideas that aren't worth building yet but shouldn't be forgotten.

---

## Sync layer (Asana / Linear / Notion)

Automated two-way state sync: pull tasks in, push completions back. Originally planned but made redundant by having Asana/Linear/Notion MCP connections available in chat. Current workflow (triage in chat → create task with source_url → complete both in same conversation) covers the need without the complexity of webhooks, polling, and token storage. Only worth revisiting if closing tasks in two places becomes consistently annoying in practice.

---

## `defer_context` / bulk triage

A single MCP call to snooze all active tasks in a context by N days (e.g. "Monroe is on hold for 2 weeks"). Currently solvable via chat — just say "snooze all active Monroe tasks until X" and Claude loops through them. Only worth building if the one-by-one approach becomes noticeably burdensome in practice.

---

## Agent job queue

Fire-and-forget automated agent tasks — dispatch a prompt to a folder-agent and let it run without a human in the loop. The folder-as-agent architecture is already built; this is the async execution layer on top of it.

**Schema addition:**
```sql
CREATE TABLE agent_jobs (
  id INTEGER PRIMARY KEY,
  agent_path TEXT,           -- resolved from agent.config scan
  prompt TEXT,               -- the task instruction
  status TEXT,               -- queued | running | done | failed
  result TEXT,               -- stdout summary from agent
  output_path TEXT,          -- where the artifact was written
  priority INTEGER DEFAULT 5,
  created_at DATETIME,
  started_at DATETIME,
  completed_at DATETIME
);
```

**Worker:** polls every 2 seconds, respects a concurrency cap (recommended: 3-4 simultaneous Claude Code instances). Runs `claude -p '{prompt}' --output-format json` in the agent's folder via `exec()`.

**When to build:** when the pattern of "open terminal → navigate to agent folder → run Claude manually" becomes the bottleneck. The terminal is currently sufficient for interactive use.
