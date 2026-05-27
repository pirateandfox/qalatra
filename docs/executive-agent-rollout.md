# Qalatra Executive Agent Rollout

This document is the handoff for enriching the agents in Justin's Projects folder so Qalatra can support a single executive assistant: one normal chat surface that knows what agents exist, what context exists, where that context lives, and what to load or delegate at the right time.

The goal is not to build one giant prompt containing everything. The goal is to make Qalatra the operating layer that lets one executive agent discover the right capability and retrieve the right memory on demand.

## Target Model

The executive agent should be able to answer or route requests like:

- "What do we know about this Monroe client issue?"
- "Which agent should handle this Missive thread?"
- "File this invoice."
- "What was I trying to do with Silvermouse last week?"
- "Spin up the right agent for this repo task."
- "Do we already have context for this person or project?"

It should do that by querying Qalatra first, not by guessing from whatever happens to be in its current prompt.

## Core Tools

### `search_capabilities`

Use this first when the request is about who or what can do something.

Examples:

```json
{ "query": "file this invoice", "context": "monroe" }
```

```json
{ "query": "triage Missive thread and create follow-up tasks" }
```

The tool searches Qalatra's capability registry. In Phase 1, capabilities are derived from `agent.config` files. Each scanned agent remains an agent, but it is also indexed as a capability so another AI can discover it.

Useful fields returned by capability search:

- `name`: human-readable capability name
- `description`: what it does
- `context`: entity or operating area, such as `monroe`, `personal`, or `internal`
- `project`: optional narrower project or repo
- `kind`: usually `agent` for now
- `delegation_mode`: how the executive should use it
- `delegation_target`: folder or path to run/load
- `trigger_phrases`: phrases that should cause this capability to be considered
- `permission_profile`: what is safe, risky, or forbidden

Use `get_capability` after search when you need the full record, including files and permissions.

### `search_daily_notes`

Use this when the request depends on remembered context, past decisions, recent work, or cross-day continuity.

Examples:

```json
{ "query": "Monroe billing decision", "limit": 5 }
```

```json
{ "query": "Silvermouse", "date_from": "2026-05-01", "date_to": "2026-05-24" }
```

```json
{ "date_from": "2026-05-17", "date_to": "2026-05-24", "limit": 7 }
```

The tool searches daily-note content and returns compact results by date. Search results should be treated as pointers. Use `get_daily_note` for a specific date when the executive needs the full note.

Daily notes are indexed memory. They are not just scratchpads. During cleanup, assume important context may be in daily notes and make the executive agent check them when the user is asking "what did we decide," "where did we leave off," or "what do we know."

### Supporting Tools

Use these as needed after capability or memory search:

- `list_capabilities`: inventory capabilities by context/project/kind.
- `get_capability`: load one full capability record.
- `rescan_capabilities`: refresh Qalatra after changing agent configs.
- `search_tasks`: find active or historical task context.
- `get_task`: load a specific task.
- `get_task_notes`: load a task thread and agent results.
- `get_daily_note`: load a full daily note by date.
- `get_week_notes`: load recent daily notes when the date range matters more than keyword search.

## Executive Agent Decision Loop

Use this loop for the executive assistant:

1. Classify the request.
   - Is this asking for memory?
   - Is this asking for an action?
   - Is this asking which agent should handle something?
   - Is this scoped to a context, client, project, repo, person, or external tool?

2. Identify the entity boundary.
   - Prefer explicit user context.
   - If unclear, infer cautiously from names, project, task, URL, or thread.
   - Do not mix client/entity memory unless the user explicitly asks for cross-context comparison.

3. Search capabilities when action or delegation is possible.
   - Start with `search_capabilities`.
   - Apply `context` and `project` filters whenever they are known.
   - Use `get_capability` before delegation if permissions, files, or expected inputs matter.

4. Search memory when continuity matters.
   - Use `search_daily_notes` for "what happened/decided/mentioned" questions.
   - Use `search_tasks` for task state and work history.
   - Use exact date tools when the date is known.

5. Decide the response mode.
   - Answer directly if the available context is enough.
   - Delegate if a matching capability exists and its permissions allow it.
   - Ask a short clarification if entity, project, or action risk is ambiguous.

6. Keep context small.
   - Load search results first.
   - Load full notes, files, or capability records only when needed.
   - Do not load every agent config or every daily note into the prompt.

## Agent Config Enrichment Work

The cleanup work should happen in the Projects folder where the actual agent directories live. For each important `agent.config`, preserve the existing top-level runtime fields and add a `capability` block.

Top-level fields remain for Qalatra's runtime:

```json
{
  "name": "Monroe Invoice Filer",
  "description": "Files Monroe invoice attachments into the correct folders and updates the task.",
  "context": "monroe",
  "project": "billing",
  "command": "claude --dangerously-skip-permissions",
  "timeout_minutes": 30,
  "coding": false
}
```

Capability fields are for AI discovery and routing:

```json
{
  "name": "Monroe Invoice Filer",
  "description": "Files Monroe invoice attachments into the correct folders and updates the task.",
  "context": "monroe",
  "project": "billing",
  "command": "claude --dangerously-skip-permissions",
  "timeout_minutes": 30,
  "coding": false,
  "capability": {
    "kind": "agent",
    "aliases": ["invoice filer", "Monroe AP filing", "billing document filing"],
    "triggers": [
      "file this invoice",
      "save this Monroe invoice",
      "organize billing attachment",
      "attach invoice to the right client folder"
    ],
    "delegation": {
      "mode": "qalatra_agent",
      "target": "."
    },
    "permissions": {
      "auto_run": false,
      "requires_confirmation": ["move_files", "send_email", "modify_external_system"],
      "allowed": ["read_task", "read_attachments", "write_task_note"],
      "forbidden": ["delete_files", "send_payment", "change_bank_details"]
    },
    "files": [
      {
        "path": "AGENTS.md",
        "role": "instructions",
        "include_in_bundle": true
      },
      {
        "path": "knowledge/invoice-filing.md",
        "role": "workflow",
        "include_in_bundle": true
      }
    ],
    "metadata": {
      "owner": "justin",
      "confidence": "production",
      "notes": "Use only for Monroe billing/invoice workflows."
    }
  }
}
```

## What To Capture For Each Capability

For each real agent, add enough metadata that a separate AI could choose it without seeing the folder name.

Capture:

- What the agent does in plain language.
- Trigger phrases a user would naturally say.
- Context/entity boundary.
- Project/repo boundary, if any.
- Inputs it expects: task, URL, attachment, prompt, repo path, daily note date, etc.
- Outputs it produces: task update, markdown report, code change, email draft, file operation, etc.
- Whether it can run automatically.
- Which actions require explicit confirmation.
- Which actions are forbidden.
- Which files contain durable instructions or knowledge.
- Known failure modes or when not to use it.

Avoid:

- Secrets, credentials, tokens, account numbers, or private keys.
- Vague descriptions like "helps with stuff."
- Cross-client capability descriptions that blur entity boundaries.
- Permission profiles that imply destructive action is safe by default.

## Suggested Cleanup Pass

Run the enrichment in passes:

1. Inventory all agent folders and existing `agent.config` files.
2. Group agents by `context` and `project`.
3. Identify duplicates or stale agents, but do not delete anything during this pass.
4. Add capability metadata to the top 10-20 agents used most often.
5. Run `rescan_capabilities`.
6. Use `search_capabilities` with realistic phrases and note false positives/false negatives.
7. Tighten aliases, triggers, descriptions, and context/project fields.
8. Repeat until the executive agent can reliably find the right target.

## Acceptance Criteria

This phase is working when:

- A normal chat agent can ask `search_capabilities` and identify the right specialist agent.
- Daily-note search can recover recent decisions and context without loading every note.
- Capability records make entity boundaries obvious.
- Risky capabilities clearly say what needs confirmation.
- Most routing failures can be fixed by editing `agent.config`, not by changing Qalatra code.
- The executive agent spends most of its time deciding and orchestrating, not scanning folders manually.

