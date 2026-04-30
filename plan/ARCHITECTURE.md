# Qalatra — Architecture Spec

## Current State

The existing Qalatra is a working, battle-tested personal tool: SQLite database, MCP server, Electron app. It has been in daily use and the schema is proven. This document captures the architecture for **Qalatra v2** — adding sync, multi-device, multi-instance, and external integration support without throwing away what works.

**Core principle: evolve, don't rewrite.**

---

## Core Philosophy

**Instances, not users.** You authenticate to an instance, not to an account within a system. Each Qalatra installation is an instance. You can have multiple instances (personal Mac, work cloud VM) and access them all from a single web or mobile app. Teammates access a shared instance by being granted access to it — no per-user data partitioning within an instance.

**Task data never touches the NestJS backend.** NestJS is the auth, billing, and instance registry layer only. All task data lives in per-user Turso databases and syncs directly between instances and clients.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  NestJS Backend                      │
│  Postgres: users, orgs, billing, instance registry  │
│  NO task data stored here                           │
└──────────────┬──────────────────────────────────────┘
               │ auth + instance lookup
    ┌──────────┼────────────────────┐
    ▼          ▼                    ▼
[Your Mac]  [Cloud VM]         [Web / Mobile]
Qalatra       Qalatra              thin client
Electron     Electron            React / React Native
    │            │                    │
    └────────────┴────────────────────┘
                 │
         ┌───────▼────────┐
         │  Turso (cloud) │  ← per-user SQLite, always accessible
         │  your task DB  │
         └────────────────┘
```

### NestJS Backend (auth + registry only)

- User accounts, orgs, billing (Stripe)
- Instance registry: each Qalatra install registers with a UUID, last-heartbeat timestamp, human name ("Justin's Mac", "Work Cloud VM")
- On login, returns: Turso DB credentials + list of registered instances + their online status
- **Does not store or proxy task data**

### Turso (per-user task database)

- Each user gets one Turso SQLite database provisioned on signup
- Schema is identical to the existing local SQLite — no translation layer
- Turso embedded replica on desktop: local reads stay fast, writes sync to cloud automatically
- Web/mobile connect directly to Turso using credentials from NestJS
- Works as the "always-on" store — accessible even when all local machines are offline

### Desktop (Electron — unchanged)

- Swaps `better-sqlite3` for Turso embedded replica client
- Local file path for the replica; schema and all queries stay the same
- MCP server hits local replica — zero latency for Claude sessions
- Works fully offline; syncs when connectivity returns
- Registers heartbeat with NestJS every few minutes

### Web App (thin client)

- Hosted static React app (same UI codebase)
- Login via NestJS → get Turso credentials + instance list
- Reads/writes directly to Turso
- Instance switcher: pick which instance's data to view (if you have multiple)
- Shows instance online status from NestJS heartbeat data

### Mobile (Expo / React Native)

- Same pattern as web: login via NestJS, read/write Turso directly
- No local database — always-online acceptable for phone
- Offline: queue writes, flush on reconnect

---

## Cloud VM Instances

Qalatra runs on Linux identically to Mac — the Electron app has a Linux build. A cloud VM instance is just Qalatra installed on a Linux server.

**Recommended stack for a cloud instance:**
- Hetzner CX22 (~$5-6/mo) or any Linux VPS
- Tailscale for private network access (no public exposure needed)
- noVNC + Xfce for browser-based desktop access (OAuth re-auth, MCP setup, etc.)
- Cloudflare Tunnel if the API needs to be reachable from external services (e.g. Slack)
- Qalatra Linux build installed and running

**Use cases for cloud instances:**
- Company shared instance: teammates connect via Tailscale, shared contexts/agents
- Always-on personal instance: agents run even when your Mac is closed
- Proof of concept: existing cloud Linux box + Linux release + noVNC = running today

**Agent considerations:** Cloud agents often need MCP servers with OAuth (Shopify, etc.) and occasional browser re-authentication. noVNC provides the desktop access for this. Qalatra does not try to abstract or containerize the execution environment — the machine is the machine.

---

## Multi-Instance Model

The web and mobile apps maintain a list of instances associated with your account. Instances are registered by NestJS when the Qalatra app authenticates. You switch between instances like switching workspaces.

```
Web/Mobile instance switcher:
  • Justin's Mac          (last seen 2 min ago — online)
  • Work Cloud VM         (last seen 1 min ago — online)
  • Justin's MacBook Air  (last seen 6 hours ago — offline)
```

All instances share the same Turso DB (same task data). "Online" means agents can be triggered on that machine right now. Offline instances still show current task data (from Turso) but agent jobs queue until the instance comes back online.

---

## External Integrations (Slack, etc.)

### Incoming: Slack → Qalatra

- Slack Block Kit modal mirrors the task creation form
- User submits → Slack POSTs to a webhook endpoint (NestJS or Cloudflare Worker)
- Webhook creates task via Qalatra API

### Thread-as-conversation

```
User submits Slack form
  → task created in Qalatra
  → bot posts confirmation message in Slack channel

User replies in thread
  → Slack sends reply to webhook
  → webhook adds reply as a note on the task
  → agent picks up new context on next run

Agent completes / produces output
  → Qalatra pushes result to Slack thread via bot
  → conversation continues naturally in Slack
```

### API Security

The Qalatra API endpoint must be protected when exposed to external services. Required:
- **API token** on all incoming webhook requests — generated per-integration, stored in NestJS, verified on every request
- **Slack signing secret** verification — Slack signs every outgoing request; verify the signature before processing
- Cloudflare Tunnel handles HTTPS termination; the API itself stays on localhost on the VM

Anyone hitting the port without a valid token gets a 401. The token is configured once in the Slack app settings and in Qalatra settings.

---

## Sync Strategy

**Turso handles sync automatically** via embedded replica. No custom sync worker needed for the desktop↔cloud case.

For the rare conflict case (same task edited on two devices while both offline):
- Last-write-wins on `updated_at`
- Notes/conversation history is append-only — no conflicts possible
- Real conflict rate for single-user across devices is near zero in practice

---

## Data Model

Existing SQLite schema carries forward unchanged into Turso. No migration of the data model — only provisioning a Turso database and copying data on first sync.

Key tables: `tasks`, `habits`, `habit_logs`, `contexts`, `daily_notes`, `attachments`, `agent_jobs`, `notes`, `sync_log`

---

## Platform Targets

```
taskos/
  packages/
    desktop/       ← Electron app (current codebase, evolved)
    mobile/        ← Expo (React Native) — iOS + Android
    web/           ← React thin client (same UI components as desktop)
    backend/       ← NestJS + Postgres (auth, billing, instance registry)
    billing/       ← Stripe integration (private)
    types/         ← Shared TypeScript types
```

**Monorepo:** pnpm workspaces.

---

## Agent Packaging (future)

To share agents between instances:
- Package an agent folder as a zip (agent code + `agent.config`)
- POST to a remote instance's API (authenticated)
- Remote instance unpacks into its `agentsRoot` directory
- Agent immediately available in that instance's Qalatra

---

## File Attachments

Unchanged from current implementation. S3-compatible object storage (Cloudflare R2). Files upload directly from client via presigned URLs. Backend stores metadata only.

---

## Identity & Auth

- Email + password via NestJS. JWT + refresh tokens.
- Desktop: credentials in OS keychain, long-lived token
- Mobile/web: standard login, token in secure storage
- Instance auth: each instance has a UUID + API token stored in NestJS; used for heartbeats and webhook verification

---

## Billing

- Stripe for payments via NestJS
- What you're paying for: Turso database hosting + sync
- Turso cost per user is tiny (personal task data is 1-5MB) — comfortable margin at any reasonable price point

```
Free:      Local only, no sync, no Turso provisioning
$5/mo:     Sync (Turso DB provisioned), web + mobile access
$10/mo:    Sync + hosted file storage (R2)
Cloud VM:  Setup fee + ~$25/mo (we host a Hetzner VM for you, configured with Qalatra + Claude Code + Tailscale + noVNC)
```

---

## Open Source Strategy

- `desktop`, `mobile`, `web`, `backend` packages: MIT licensed
- Self-hosters can run the full stack with their own Turso + Postgres
- `billing` package: private
- Hosted backend is the commercial offering — sell convenience, not software

---

## What Carries Forward from v1

Everything. The entire existing codebase is v2 desktop. No rewrite:

- SQLite schema and all migrations (becomes Turso embedded replica)
- MCP server and all tools
- All task behaviors: recurrence, surface_after, contexts, projects
- Agent spawning and autorun
- Habits system
- Morning briefing, triage, briefing workflows
- Electron app, UI components, IPC handlers
- Attachment storage (S3/R2)

V2 adds: Turso swap, NestJS backend, Expo mobile, React web thin client, instance registry, Slack integration.

---

## Build Order

1. **Linux server mode** — headless `api.js` + MCP server without Electron (for lightweight cloud deployments and background service use)
2. **Turso swap** — replace `better-sqlite3` with Turso embedded replica; schema stays identical
3. **NestJS instance registry** — user accounts, instance registration, heartbeat endpoint
4. **Web thin client** — React app pointing at Turso, instance switcher, login via NestJS
5. **Mobile** — Expo app, same pattern as web
6. **Slack integration** — Block Kit modal, webhook receiver, thread-as-conversation
7. **Agent packaging** — zip/install agents across instances

---

## Open Questions

- **Selective sync** — can you mark a context as local-only (never syncs to Turso)?
- **Context sharing between users** — future; copy a context + its tasks to another user's Turso DB
- **Sync conflict UI** — what does the app show when a conflict is detected and resolved?
