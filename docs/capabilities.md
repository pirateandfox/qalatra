# Qalatra Capabilities

Capabilities are Qalatra's structured registry of what the workspace can do.

They answer questions a top-level assistant needs before it acts:

- Which agent, skill, workflow, or knowledge source is relevant to this request?
- What is it for?
- What context or project does it belong to?
- Can it be delegated to directly?
- What files should be loaded with it?
- What actions are allowed, require confirmation, or are never allowed?

Phase 1 keeps the model deliberately simple: Qalatra still scans the filesystem for `agent.config` files, and every scanned agent is also registered as one capability.

## Mental Model

`agents` are runtime records.

They are for launching work:

- folder path
- command
- context/project assignment
- coding flag
- UI task assignment and job dispatch

`capabilities` are discovery and routing records.

They are for another AI deciding what exists and what fits:

- name and description
- kind
- aliases and trigger phrases
- permission profile
- delegation mode and target
- owned files and loadable context

In Phase 1, agents and capabilities are usually 1:1. That does not mean they are the same concept. Later, capabilities may also represent non-runnable things: workflows, skills, knowledge packs, MCP tools, external APIs, or manual processes.

## Source Of Truth

For now, `agent.config` remains the source of truth.

Qalatra scans the configured agents root, finds every folder containing `agent.config`, writes the existing `agents` table, then derives and writes the `capabilities` and `capability_files` tables.

Existing configs still work:

```json
{
  "name": "Research Agent",
  "description": "Researches a topic and produces a markdown report",
  "context": "internal",
  "command": "claude --dangerously-skip-permissions"
}
```

Agents can also define process environment overrides for Qalatra-launched jobs:

```json
{
  "name": "Remote Coder",
  "description": "Starts a Claude remote session and registers it externally.",
  "command": "flightdesk register --title '{title}' --prompt '{description}'",
  "env": {
    "ANTHROPIC_CONFIG_DIR": "$HOME/.claude"
  }
}
```

Values support `~`, `$VAR`, and `${VAR}` expansion against the worker process environment. Set a value to `null` to unset it. The server settings file may also contain a top-level `agentEnv` object for defaults shared by every agent; `agent.config.env` wins for a specific agent.

Qalatra infers a default capability from that:

- `kind = "agent"`
- `delegation_mode = "qalatra_agent"`
- `delegation_target = the agent folder`
- search triggers from `name`, `description`, `context`, `project`, and folder path
- known files are registered when present: `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `context.md`, `project-details.md`, `contacts.md`, and `knowledge/*.md`

## When To Add Capability Metadata

Add a `capability` block when the default name and description are not enough for an AI to reliably pick the right thing.

Good reasons to enrich a capability:

- The agent has a specific job that users describe in several different ways.
- The agent can take risky actions, such as file movement, deletion, sending email, publishing, purchases, or updating external systems.
- The agent owns important instruction or knowledge files.
- The top-level assistant should prefer it only inside a context or project.
- The agent should be discoverable by intent, not just by its folder name.

Example:

```json
{
  "name": "Filer",
  "description": "Audits Desktop and local folders, recommends where files should go, then files them after confirmation.",
  "context": "internal",
  "command": "claude --dangerously-skip-permissions",
  "capability": {
    "kind": "agent",
    "aliases": ["filing", "file organization", "desktop cleanup"],
    "triggers": [
      "file this invoice",
      "where should this go",
      "clean up my Desktop",
      "organize these files"
    ],
    "provider_support": ["claude", "codex"],
    "delegation": {
      "mode": "qalatra_agent",
      "target": "."
    },
    "permissions": {
      "read_files": "allowed",
      "move_files": "confirm",
      "delete_files": "double_confirm",
      "upload_to_drive": "confirm",
      "send_email": "never"
    },
    "files": [
      {
        "path": "AGENTS.md",
        "role": "instructions",
        "readable": true,
        "writable": false,
        "include_in_bundle": true
      },
      {
        "path": "knowledge/routing-rules.md",
        "role": "routing_rules",
        "readable": true,
        "writable": true,
        "include_in_bundle": true
      }
    ]
  }
}
```

## Field Guide

`kind`

What type of capability this is. Current rows usually use `agent`. Valid useful values include:

- `agent`: a runnable local agent folder
- `skill`: a reusable procedure or instruction set
- `workflow`: a multi-step process
- `knowledge`: a reference source that may not run anything
- `external_tool`: an external service or API-backed capability

`aliases`

Short alternate names people or agents might use. Use nouns and labels:

```json
["filing", "desktop cleanup", "invoice filing"]
```

`triggers`

Intent phrases the top-level assistant might see in a user request. Use verb phrases and realistic requests:

```json
[
  "file this invoice",
  "organize these files",
  "triage this request",
  "turn this into tasks"
]
```

In Phase 1, search is metadata search. Put discoverability language in `description`, `aliases`, or `triggers`. Do not assume `AGENTS.md` text is searchable yet.

`provider_support`

Which model/runtime families can reasonably use or run this capability. This is informational in Phase 1:

```json
["claude", "codex"]
```

`delegation`

How work should be handed off:

```json
{
  "mode": "qalatra_agent",
  "target": "."
}
```

Useful modes:

- `qalatra_agent`: delegate by queueing a Qalatra agent job
- `mcp_tool`: call an MCP tool directly
- `manual`: suggest a human action
- `none`: discoverable but not directly delegable

`permissions`

The capability's action policy. This is the registry's most important guardrail. Use simple values:

- `allowed`: can do directly
- `confirm`: ask before doing
- `double_confirm`: ask with extra care before doing
- `never`: do not do this action

Examples:

```json
{
  "read_files": "allowed",
  "move_files": "confirm",
  "delete_files": "double_confirm",
  "send_email": "never",
  "purchase": "never",
  "publish": "confirm"
}
```

Permissions should be conservative. A memory file or agent instruction should never override a stricter permission in the capability registry.

`files`

Files the capability owns, reads, writes, or should include in future context bundles.

Useful roles:

- `instructions`: standing agent instructions, usually `AGENTS.md` or `CLAUDE.md`
- `adapter_skill`: `SKILL.md` or runtime-specific adapter instructions
- `project_context`: project-level context
- `contacts`: authoritative contact/reference information
- `project_details`: durable project metadata
- `knowledge`: general capability knowledge
- `routing_rules`: rules for classification, routing, or filing
- `naming_conventions`: naming and formatting rules
- `examples`: examples the agent can imitate
- `output`: generated output folder
- `writeback_target`: where durable memory should be written

Use relative paths for files inside the agent folder. Qalatra resolves them to absolute paths during scan.

```json
{
  "path": "knowledge/routing-rules.md",
  "role": "routing_rules",
  "readable": true,
  "writable": true,
  "index_for_search": true,
  "include_in_bundle": true
}
```

Phase 1 registers these files. It does not yet index their contents.

## What Belongs In Capabilities

Put routing metadata here:

- what this thing does
- how a user might ask for it
- alternate names
- context/project scope
- delegation target
- action permissions
- files that define or support the capability

Put execution details in the normal agent fields:

- `command`
- `coding`
- runtime-specific behavior
- output rules

Put long-form instructions in files:

- `AGENTS.md`
- `CLAUDE.md`
- `SKILL.md`
- `knowledge/*.md`

Put task state in Qalatra tasks and notes:

- current priorities
- status
- task-specific context
- decisions from active work

Put durable memory in the future memory index sources:

- daily notes
- project docs
- task notes
- agent outputs
- structured records

## What Not To Put In Capabilities

Do not put secrets or credentials in capability metadata.

Do not put long prompts directly in the `capability` block. Use `AGENTS.md`, `CLAUDE.md`, or `SKILL.md`.

Do not put live task state in capabilities. Use tasks, notes, and agent jobs.

Do not put detailed client/project facts in a global capability unless the capability is scoped with `context` or `project`.

Do not use capability search as permission to act. Search only finds candidates. Permissions decide what can happen.

## How A Top-Level Assistant Should Use Capabilities

For a request like:

> File this invoice and send Sarah a note.

The assistant should:

1. Call `search_capabilities` with the request text.
2. Inspect likely matches, such as Filer and email/communications capabilities.
3. Call `get_capability` for any candidate that may be used.
4. Check `context`, `project`, permissions, delegation mode, and files.
5. Ask for clarification if multiple scopes could match.
6. Confirm before risky actions based on the permission profile.
7. Delegate only when the capability's `delegation_mode` supports it.

The assistant should not:

- pick an agent only because its folder name vaguely matches
- use fuzzy memory as authority for permissions
- send email, move files, delete files, spend money, or publish without checking the capability's permission profile
- cross contexts/projects without an explicit reason

## MCP Tools

Capabilities are exposed through MCP:

- `list_capabilities`: list registered capabilities, optionally filtered by `context`, `project`, `kind`, or `active`
- `get_capability`: fetch one capability by id or path, including files and permission profile
- `search_capabilities`: keyword search over name, description, aliases, triggers, context, project, and path
- `rescan_capabilities`: rerun the filesystem scan and refresh registry rows

Example flow:

```text
search_capabilities({ "query": "file this invoice" })
get_capability({ "id": "cap_..." })
```

## HTTP API

The authenticated HTTP API mirrors the MCP surface:

- `GET /api/v1/capabilities`
- `GET /api/v1/capabilities?query=file%20this%20invoice`
- `GET /api/v1/capabilities/:id`
- `POST /api/v1/capabilities/search`
- `POST /api/v1/capabilities/rescan`

## Authoring Checklist

For every important agent, ask:

- Is the `name` human-readable?
- Does the `description` say what the agent actually does?
- Would a top-level assistant find it from normal user wording?
- Are `aliases` and `triggers` present for common phrasing?
- Is `context` or `project` set if this should not be global?
- Are risky actions represented in `permissions`?
- Are important instruction and knowledge files listed or inferable?
- Is the delegation mode correct?

## Current Limits

Phase 1 does not include embeddings.

Phase 1 does not index arbitrary markdown or daily notes.

Phase 1 does not build context bundles.

Phase 1 does not make `AGENTS.md` searchable. The scanner registers known files so later phases can index and bundle them.

The first win is reliable capability discovery: Qalatra knows what exists, what it is for, where it lives, and what guardrails apply.
