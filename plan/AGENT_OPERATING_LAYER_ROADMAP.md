# Qalatra Agent Operating Layer Roadmap

Status: strategic product direction, not an MVP sketch.

Qalatra is becoming an operating layer for AI workers. The personal task manager still matters, but the larger product is a system where Qalatra instances can run agents, receive external work, process messages, escalate decisions to a human, and communicate with other Qalatra instances without routing everything through email, Slack, or a project-management tool.

The key product decision: keep one engine, but support different instance roles and different UI surfaces.

## Product Thesis

Qalatra should not become one overloaded task list.

There are at least two major ways it will be used:

- A personal Qalatra instance where the task list is for Justin or another human.
- A remote agent-node Qalatra instance where the task list, inbox, logs, and queues are mostly for agents.

Those are different operating surfaces on top of the same server, database, agents, MCP tools, capability registry, and future inter-instance messaging model.

The product should make this distinction explicit so autonomous intake and agent work do not pollute a human's personal task list.

## Instance Roles

### Personal Instance

A personal instance is human-first.

The task list is for the human:

- personal priorities
- delegated work the human cares about
- agent requests that need a human response
- projects, notes, habits, and human planning

Agents are helpers. They can be assigned work, but their raw intake queues and internal execution logs should not dominate the main personal task list.

Primary UI surfaces:

- Priority
- Daily Note
- Projects
- Agent Requests
- Delegations
- Agent results worth reviewing

### Agent Node Instance

An agent node is operations-first.

The primary operator may be an executive agent, not a human. It may have:

- its own email account
- Slack user membership
- Notion access
- project-management access
- source-code access
- credentials for external APIs and MCP servers

Its inbox is for machine processing, not human triage. External messages and events should enter as normalized intake records, not as personal tasks.

Primary UI surfaces:

- External Inbox
- Agent Runs
- Action Log
- Approval Queue
- Handoffs
- Connector Health
- Prompt and session history
- Retry/replay tools
- Capability and agent management

### Managed Remote Instance

A managed remote instance is any Qalatra Server that a desktop, web, or mobile client can connect to with a `full_access` token.

It may be personal or agent-node. Remote management is the transport and administration model; instance role is the product mode.

### Specialist Agent Folders

An agent folder is not the same thing as an instance.

Specialist agents live under an agents root and are discovered through `agent.config` and the capability registry. They are capabilities inside an instance.

The executive agent is one specialist agent that knows how to search capabilities, search memory, and decide whether to answer, delegate, or escalate.

## Data Boundaries

The main separation:

- `tasks`: human-visible or explicitly assigned work items.
- `external_items`: raw intake from email, Slack, Notion, Linear, Missive, webhooks, and similar sources.
- `agent_jobs`: execution records for agents.
- `agent_actions`: proposed or executed actions against Qalatra or external systems.
- `handoff_requests`: things an agent needs a human or another instance to answer, approve, decide, or review.
- `instance_messages`: Qalatra-to-Qalatra communication records.

Raw intake should not automatically become a personal task. It should first be processed, classified, and routed.

## External Intake Model

External services should be connectors into Qalatra, not just ad hoc tools an agent calls whenever it wakes up.

Connector examples:

- email inbox
- Slack user or bot membership
- Missive conversations
- Notion pages, comments, or databases
- Linear, Asana, GitHub, or other PM/development systems
- signed webhooks from external systems

Connectors should normalize events into durable records:

```sql
CREATE TABLE external_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread_id TEXT,
  sender_name TEXT,
  sender_address TEXT,
  received_at TEXT,
  subject TEXT,
  body TEXT,
  summary TEXT,
  source_url TEXT,
  context_guess TEXT,
  project_guess TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  raw_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, external_id)
);
```

Important statuses:

- `new`
- `queued`
- `processing`
- `processed`
- `ignored`
- `needs_approval`
- `needs_handoff`
- `failed`

The unique source/external ID pair gives idempotency. Re-processing should be intentional, not accidental.

## Agent Action Model

Agents should not perform meaningful external actions invisibly.

Actions should be stored whether they are proposed, approved, executed, or failed:

```sql
CREATE TABLE agent_actions (
  id TEXT PRIMARY KEY,
  external_item_id TEXT REFERENCES external_items(id),
  agent_job_id TEXT REFERENCES agent_jobs(id),
  capability_id TEXT,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  risk_level TEXT NOT NULL DEFAULT 'low',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT
);
```

Action examples:

- `classify`
- `create_task`
- `draft_reply`
- `send_reply`
- `post_slack_message`
- `update_notion_page`
- `update_linear_issue`
- `assign_agent`
- `archive_external_item`
- `request_handoff`

This is the audit log for the agentic system. It is how a human can inspect what happened, why, and whether it should be retried.

## Permission And Approval Model

Capability metadata should drive what can run automatically.

Low-risk actions can usually be automatic:

- classify an item
- summarize a thread
- create a Qalatra task
- add a task note
- draft a reply
- route work to a specialist agent

Medium-risk actions may be automatic only for trusted contexts:

- mark an external item processed
- update a Notion page
- update PM task status
- post a low-risk Slack update

High-risk actions should require approval until the workflow has been proven:

- send email
- send Slack messages as a real user
- delete or move files
- change billing/payment details
- publish content
- commit, deploy, or modify production systems
- change external permissions

The capability registry should expose these permissions so the executive agent can decide whether to act, draft, or ask.

## Executive Agent Runtime Pattern

The executive agent is a normal Qalatra agent, but it has an orchestration role.

Expected loop:

1. Receive a user message, external item, handoff response, or scheduled check.
2. Identify the entity boundary: personal, client, project, repo, or external system.
3. Search capabilities with `search_capabilities`.
4. Search memory with `search_daily_notes`, task search, and source-specific lookups.
5. Decide whether to answer, delegate, draft, execute, or ask.
6. Record proposed and executed actions.
7. Escalate through a handoff request when a human decision is needed.

The executive should not carry the whole world in context. It should know how to find the right context.

## Handoff Requests

Handoff requests are first-class objects. They are not personal tasks unless the user converts them into tasks.

They represent an agent asking for:

- a decision
- approval
- missing context
- a choice among options
- confirmation before risky action
- review of a draft or result

Proposed shape:

```sql
CREATE TABLE handoff_requests (
  id TEXT PRIMARY KEY,
  from_instance_id TEXT,
  to_instance_id TEXT,
  external_item_id TEXT REFERENCES external_items(id),
  agent_job_id TEXT REFERENCES agent_jobs(id),
  action_id TEXT REFERENCES agent_actions(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  choices TEXT NOT NULL DEFAULT '[]',
  response TEXT,
  urgency TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);
```

Types:

- `question`
- `approval_request`
- `review_request`
- `task_offer`
- `status_update`
- `result`

A personal instance should show these in an Agent Requests surface, separate from the main task list.

## Qalatra-to-Qalatra Messaging

Qalatra needs a direct communication path between instances.

This should not require the agent to email Justin or send Slack messages just to ask a question. Qalatra should be able to send a structured message from an agent-node instance to a personal instance and carry the answer back.

Message shape:

```sql
CREATE TABLE instance_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_instance_id TEXT NOT NULL,
  to_instance_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  related_handoff_id TEXT,
  related_external_item_id TEXT,
  related_agent_job_id TEXT,
  body TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  read_at TEXT
);
```

Message types:

- `question`
- `answer`
- `approval_request`
- `approval_response`
- `task_push`
- `task_status`
- `agent_result`
- `heartbeat`

Transport can evolve:

1. API-to-API delivery over authenticated Qalatra Server URLs for the first useful version.
2. Iroh peer-to-peer transport once instance identity and contact pairing are ready.
3. Push notifications for mobile or offline human attention later.

The data model should not depend on the transport.

## Personal UI Surface

The personal UI should stay human-centered.

Add or refine:

- Agent Requests: questions, approvals, review requests, and results waiting on the human.
- Delegations: work assigned to agent nodes or specialist agents.
- Agent Activity: compact, filterable visibility into recent runs without flooding Priority.
- Source Threads: link back to external email/Slack/Notion/PM context only when relevant.

Default behavior:

- External intake from agent nodes does not appear in Priority.
- Agent internal tasks do not appear in Priority.
- Only explicit handoffs or user-owned tasks appear in the human task flow.

## Agent Ops UI Surface

Agent-node instances need a different operational view.

Add:

- External Inbox: normalized items from connectors.
- Processing Queue: items waiting on the executive agent.
- Runs: active and recent `agent_jobs`.
- Actions: proposed, approved, executed, and failed actions.
- Handoffs: open questions and approvals sent to humans or other instances.
- Connector Health: last poll, last webhook, token/auth status, failure counts.
- Replay/Retry: rerun failed intake or agent jobs with controlled inputs.
- Prompt and Context Inspector: see what the agent was given and what tools/files it loaded.

This is not a traditional task manager UI. It is an operations console for autonomous work.

## Connector Strategy

Build connectors incrementally, but keep the model consistent.

Each connector should provide:

- source identity and credential storage
- polling and/or webhook intake
- idempotent external IDs
- normalized `external_items`
- source URLs
- raw payload storage for debugging
- a small action adapter for replies/updates where needed
- connector health telemetry

Good first connector candidates:

1. Missive or email, because it naturally creates inbox pressure.
2. Slack, because agent-as-user interaction needs careful handoff and approval handling.
3. Notion, because it is likely to be context and project memory as much as task source.
4. Linear/Asana/GitHub, because they are structured and easier to make idempotent.

## Guardrails

Required guardrails:

- Entity/context boundaries are explicit. Monroe, Silvermouse, personal, and internal data must not bleed together.
- Every external item has source provenance.
- Every action has an audit row.
- Risky actions require approval by default.
- Agent output is attached to the relevant job/action/item.
- Handoffs are explicit and answerable.
- The human personal task list remains clean by default.
- MCP remains local-only unless there is a specific safe transport design.

## Build Sequence

### Phase 1: Role And Surface Foundations

- Add an `instance_role` setting: `personal`, `agent_node`, later `team`.
- Add UI mode defaults based on role.
- Add an Agent Requests nav surface for personal instances.
- Add an Agent Ops nav surface for agent-node instances.
- Keep the same backend and routes where possible.

### Phase 2: Handoff Requests

- Add `handoff_requests` table.
- Add API and MCP tools:
  - `create_handoff_request`
  - `list_handoff_requests`
  - `answer_handoff_request`
  - `close_handoff_request`
- Show open handoffs in personal Qalatra.
- Let agent jobs resume or continue from handoff answers.

### Phase 3: External Intake Core

- Add `external_items` table.
- Add API and MCP tools for listing, claiming, marking processed, and linking to tasks/jobs/actions.
- Add manual/test intake endpoint before real connectors.
- Add idempotency by source/external ID.

### Phase 4: Agent Actions And Approval Queue

- Add `agent_actions` table.
- Let executive agent propose actions instead of executing everything directly.
- Add approval queue UI.
- Add execution adapters for low-risk Qalatra-native actions first.

### Phase 5: First Real Connector

- Pick one connector and build it end to end.
- Preferred first target: Missive/email or Slack, depending on where the strongest daily pain is.
- Ingest into `external_items`.
- Run executive-agent triage.
- Record actions.
- Escalate through handoffs instead of creating personal tasks by default.

### Phase 6: Qalatra-to-Qalatra Messaging

- Implement `instance_messages`.
- Start with API-to-API delivery between configured instances.
- Add message threads and delivery status.
- Route handoff requests and responses across instances.
- Keep transport abstract so Iroh can replace or augment API delivery later.

### Phase 7: Agent Ops Console

- Build the full operational view for agent-node instances.
- Include prompts, loaded context, tool calls, actions, external source records, failures, and retries.
- Make it easy to inspect why an agent acted.

### Phase 8: Iroh / Peer Transport

- Add cryptographic instance identity and contacts.
- Move Qalatra-to-Qalatra delivery to direct peer transport where possible.
- Keep Cloudflare/API remote management separate from peer messaging.

### Phase 9: Policy Engine

- Make capability permissions, connector rules, entity boundaries, and action approvals more declarative.
- Add per-context and per-connector policies.
- Add dry-run and simulation modes for new agent workflows.

## Non-Goals

- Do not turn every external message into a human task.
- Do not force agent-node operations into the personal Priority view.
- Do not rely on Slack/email as the agent-to-human coordination layer.
- Do not make live MCP access the only state of intake processing.
- Do not expose MCP publicly as the integration surface.
- Do not build embeddings before the structured intake, action, and handoff model is solid.

## Success Criteria

This direction is working when:

- Justin's personal Qalatra remains calm even while remote agent nodes process high-volume intake.
- An agent node can receive email/Slack/Notion/PM events, process them, and only escalate what needs human attention.
- Every external action can be audited.
- A remote agent can ask Justin a question directly through Qalatra and resume after the answer.
- The executive agent can find capabilities and memory without broad prompt stuffing.
- The same Qalatra engine supports both personal productivity and autonomous agent operations.

