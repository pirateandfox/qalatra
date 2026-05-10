# Qalatra — Architecture Spec

## Current State

Qalatra is a battle-tested personal task management system: SQLite database, MCP server, Electron app. It has been in daily use and the schema is proven. This document captures the architecture for **Qalatra v2** — adding remote access, peer-to-peer task passing, digital employee instances, and multi-device support without throwing away what works.

**Core principle: evolve, don't rewrite.**

---

## Core Philosophy

**Instances, not users.** Each Qalatra installation is an instance. Instances have cryptographic identities (Iroh NodeId). You connect to another instance by knowing its NodeId and holding a capability token it issued you. There is no concept of "joining a network" — you just know someone's NodeId.

**Task data never leaves the instance.** No cloud sync layer required. Each instance owns its SQLite database. Coordination happens through direct Iroh connections between instances.

**Team = a social graph of instances.** You don't "join a team" — you exchange NodeIds and capability tokens. The team is just the list of instances you can push work to and receive work from.

---

## Two Categories of Instance

### Personal Instance
- Runs on your Mac (Electron) or a Linux server (headless)
- Your tasks, your agents, your data
- You may issue `inbox_write` capability tokens to others so they can push tasks to you

### Digital Employee Instance
- Runs headlessly on a Linux server (Hetzner CX32/CX42)
- Has a name, avatar, and defined set of agents
- Accepts work from multiple people via `inbox_write` capability tokens
- Runs agent jobs autonomously, pushes status back to the assigning instance
- No personal task management — just inbox, active jobs, status

---

## Transport: Iroh

Every Qalatra instance runs an [Iroh](https://iroh.computer) node. Iroh provides:
- **Global identity**: each node has an ed25519 keypair; the NodeId (public key) is the stable, permanent address of that instance anywhere in the world
- **NAT traversal**: direct connections where possible, relay where not — handled automatically
- **Encryption**: all traffic is encrypted; n0's relay infrastructure never sees plaintext
- **Self-hostable relay**: n0 runs the default relay infrastructure (~$19-25/mo on their hosted plan); you can run your own if needed
- **Open source**: MIT licensed, escape hatch always available

Iroh handles **all peer-to-peer communication between instances** (task pushing, status updates, identity exchange). It does NOT replace:
- Local Electron IPC (frontend ↔ backend on the same machine) — unchanged
- MCP HTTP server (port 3457, for Claude Code integration) — unchanged
- Cloudflare Tunnel for the "Electron UI connecting to a remote headless backend" management use case

---

## Federated Architecture

```
[Justin's Mac]              [Edgar's Mac]         [Build Agent Server]
 Electron UI                 Electron UI            Headless Linux
 SQLite DB                   SQLite DB              SQLite DB
 MCP server (3457)           MCP server (3457)      MCP server (3457)
 Iroh node (NodeId: abc…)    Iroh node (NodeId: def…)   Iroh node (NodeId: ghi…)
      │                           │                      │
      └──── Iroh P2P (task push, status) ────────────────┘
                    (direct when possible, n0 relay when not)

[Justin's Mac Electron UI]  ←──── Cloudflare Tunnel HTTPS ────→  [Headless Backend]
  (management/remote UI)                                          (api + mcp server)
```

---

## Identity

Every instance has:
- **NodeId** — ed25519 public key, generated on first run, globally unique, permanent. This IS the instance's address.
- **Private key** — stored securely in the local settings DB, never shared
- **Display name** — human-readable ("Justin's Mac", "Build Agent Alpha")
- **Avatar** — URL or initials + color

When you share a capability token with someone, you also share your NodeId and display identity. They see your name and avatar in their Contacts list and on tasks you push to them.

---

## Capability Tokens

Tokens are scoped bearer secrets issued by an instance:

| Scope | What it allows |
|---|---|
| `inbox_write` | Push tasks to this instance's inbox, read status of pushed tasks |
| `full_access` | Full API access — for your own Electron UI connecting to a headless backend |
| `read_only` | Future: dashboards, status views |

Generated in Settings → Security. Copy and share out-of-band (paste, QR code, etc.). Revocable — revoking a token immediately prevents further connections using it.

The token is validated at the **application layer**. Iroh handles transport encryption; the token handles authorization (who is allowed to do what).

---

## Peer-to-Peer Task Passing

**Pairing:**
1. Justin opens Settings → Identity, copies his NodeId + generates an `inbox_write` token
2. Edgar adds Justin as a contact: pastes NodeId + token → Qalatra pings Justin's node, fetches display identity, stores the contact
3. Done — no accounts, no servers, no approval flow

**Sending a task:**
1. Justin assigns a task to "Edgar" (a registered contact)
2. Qalatra opens an Iroh connection to Edgar's NodeId using the stored capability token
3. Sends task payload over the Iroh `task-push` protocol
4. Edgar's Iroh node validates the token scope, creates an inbox task, returns a remote task ID
5. Justin's task records `assigned_to_contact_id` and `remote_task_id`

**Status tracking:**
- Edgar's instance pushes status updates back to Justin's NodeId when the task progresses
- Justin's task row shows Edgar's avatar and last-known status

**MCP tool:**
```
assign_to_peer({ task_id: "...", contact: "Edgar" })
```

---

## Remote Instance Connection (Management)

Your Electron UI can connect to a remote headless backend for management:
- Cloudflare Tunnel exposes the headless instance's HTTP API at a stable URL
- Settings → Instances: enter URL + `full_access` token
- The full Qalatra UI works against the remote instance
- This is separate from Iroh (which handles P2P task routing, not UI management)

**Cloudflare Tunnel setup on the headless box:**
```bash
cloudflared tunnel create employee-alpha
# → stable URL: employee-alpha.yourcompany.com
```
Qalatra API binds to localhost; Cloudflare proxies in. No open ports. TLS handled.

---

## Server Hardware (Digital Employees)

| Employee type | Server | RAM | Cost/mo (server) |
|---|---|---|---|
| Non-code (docs, email, MCP calls) | Hetzner CX32 | 8GB | ~$13 |
| Code agents (builds, git, npm) | Hetzner CX42 | 16GB | ~$27 |

Claude Code is lightweight — it calls Anthropic's servers for AI work. The Hetzner box runs Node.js + Claude Code CLI only. RAM is the real constraint (~1GB per concurrent agent under load). CPU is mostly idle between tool calls.

**Per digital employee cost:**
- Hetzner server: $13-27/mo
- Claude subscription (Pro/Max/Team seat): $20-100/mo
- Iroh infrastructure: shared across all instances via one n0 plan (~$19-25/mo total, not per node)

---

## Browser Auth on Headless Servers

Most MCP servers are API-key based — set once, never touch again.

OAuth-based MCPs (Google, Slack) need a browser for initial setup and periodic re-auth:
1. **Device code flow** — try first; many services give you a URL to open on any device
2. **Copy credentials** — authenticate locally, `scp` credential files to server
3. **noVNC escape hatch** — `apt install xfce4 novnc`; start when needed for a real browser session; stop when done

noVNC doesn't run all the time — just installed and startable on demand.

---

## Server Deployment

### Phase 1: Shell script + Hetzner Snapshots

`scripts/setup-server.sh` — runs on fresh Ubuntu Server:
- Security hardening (SSH key only, ufw firewall)
- Node.js via asdf
- Qalatra repo clone + `pnpm install`
- Systemd services (MCP server, Iroh node, headless API)
- Claude Code CLI install
- Cloudflare Tunnel (`cloudflared`) install and configure
- noVNC + Xfce (installed, not started by default)

Set up once, take a Hetzner snapshot. New employees boot from snapshot. Per-instance `provision.sh` handles variables: instance name, NodeId generation, Cloudflare Tunnel name, which agent repos to clone.

### Phase 2: Ansible (when managing 5+ instances)

Push config updates and Qalatra version upgrades to multiple running instances simultaneously.

---

## Mobile (Future)

Expo / React Native. Stores a list of named connections: `{ name, node_id, capability_token }`. Connects via Iroh (same transport as desktop). Instance switcher. Voice task intake → `create_task`. Receives task pushes via Iroh when app is foregrounded; background notifications via APNs/FCM when needed (future).

---

## Cloud Sync / Turso (Deferred)

Offline access is not a current requirement. SQLite DB backup to S3/R2 on a cron handles disaster recovery for employee instances. Revisit Turso if offline access or real-time multi-device sync becomes a genuine need.

---

## Data Model Additions

```sql
-- Instance's own identity (one row)
CREATE TABLE instance_identity (
  id INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL,           -- Iroh NodeId (public key, hex)
  private_key TEXT NOT NULL,       -- ed25519 private key, never shared
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  color TEXT
);

-- Peers this instance can communicate with
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  node_id TEXT NOT NULL,           -- their Iroh NodeId
  capability_token TEXT NOT NULL,  -- their inbox_write token (issued by them)
  avatar_url TEXT,
  color TEXT,
  last_seen_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tokens this instance has issued to others
CREATE TABLE issued_tokens (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,             -- inbox_write | full_access | read_only
  label TEXT,                      -- human name for the grantee
  peer_node_id TEXT,               -- set after first connection (we learn who used it)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME
);

-- Tasks additions
ALTER TABLE tasks ADD COLUMN assigned_to_contact_id INTEGER REFERENCES contacts(id);
ALTER TABLE tasks ADD COLUMN remote_task_id TEXT;   -- task ID on the peer's instance
ALTER TABLE tasks ADD COLUMN remote_status TEXT;    -- last-known status from peer
```

---

## What Carries Forward from v1

Everything. No rewrite:
- SQLite schema and all migrations
- MCP server and all tools
- All task behaviors: recurrence, surface_after, contexts, projects
- Agent spawning, autorun, heartbeats
- Habits system
- Morning briefing, triage, briefing workflows
- Electron app, UI components, IPC handlers
- Attachment storage (S3/R2)

---

## Premium Features & Monetization

Iroh P2P infrastructure costs real money (~$19-25/mo to n0). This, plus other cloud-dependent features, creates a natural paid tier.

**Free tier — local only:**
- Full Qalatra task management, MCP server, agents, habits, heartbeats
- No peer-to-peer, no remote instances, no Iroh

**Paid tier — connected:**
- Peer-to-peer task routing (Iroh)
- Remote instance management (connect Electron UI to headless backend)
- Digital employee instances
- AI voice transcription (mobile)
- Future: hosted employee instance provisioning (managed Hetzner + setup)

**Payment gating requires a minimal backend.** This is what finally motivates the NestJS backend from the original v2 plan — not sync, but subscription validation. The backend's job:
- User accounts (email + password, or OAuth)
- Stripe subscription management
- License/subscription status endpoint: `GET /api/license?email=...&key=...` → `{ valid: true, tier: "connected" }`
- The Qalatra app checks this on launch and gates premium features

**Gating approach in the app:**
- On launch, if a license key is stored in settings, validate it against the backend
- Gate Iroh node startup, peer features, and remote connection UI behind valid `connected` tier
- Graceful degradation: if validation fails or network is offline, show "subscription required" prompt for gated features — don't break local functionality

**What the backend does NOT need to do (yet):**
- Proxy task data (Iroh is P2P, backend never sees tasks)
- Instance registry (Iroh NodeIds handle addressing)
- Complex billing logic beyond "is this subscription active"

This is a small NestJS/Hono app + Postgres + Stripe. It's infrastructure you run once and forget. The Qalatra app pings it; it says yes or no.

---

## Build Order

### Step 1 — Iroh integration: verify before committing

Before writing any code, verify three things:

**1. Prebuild coverage.** Check `rayhanadev/iroh-ts` (community TS wrapper) or n0's official bindings for prebuild availability across `darwin-arm64`, `darwin-x64`, `linux-x64`. If prebuilds exist for all targets, integration is a normal native-module addition (same path as `better-sqlite3`, which you've already navigated). If Rust toolchain is required at install time, that's a dealbreaker for Electron distribution and pushes you to the sidecar approach.

**2. Maintenance status.** `rayhanadev/iroh-ts` is community, not n0-official. Check recent commit activity, open issues, and whether it tracks current Iroh versions. A stale wrapper around an actively-developed Rust library is a long-term liability.

**3. API surface.** Confirm the TS bindings expose what you need: NodeId generation, endpoint creation, custom protocol handlers (ALPN-based), ticket-based pairing, basic send/receive. Iroh's Rust API is large; bindings may cover only a subset.

**If native module path checks out:** proceed with `pnpm add iroh-ts` (or equivalent). `electron-rebuild` handles ABI coupling — same as `better-sqlite3`. Budget a few extra days for first-time integration friction (Electron ABI, signing quirks, electron-builder config).

**If prebuilds are missing or wrapper is stale → sidecar approach:**
- Build a standalone Rust binary (`qalatra-iroh`) per platform that wraps the Iroh node
- Qalatra Node.js spawns it as a child process and communicates via stdio or local socket
- No Node ABI coupling, no `electron-rebuild` for Iroh, simpler build pipeline
- electron-builder has first-class sidecar support
- Cross-compiling Rust for each platform (darwin-arm64, darwin-x64, linux-x64) is well-documented
- Slightly more code to write but more durable long-term

The sidecar approach is the fallback, not the default. Try native module first.

### Step 1b — Iroh node wiring (after approach confirmed)
- New `iroh/node.js`: singleton Iroh node, generates keypair on first run, stores NodeId + private key in settings DB
- New `iroh/protocols/task-push.js`: inbound handler — validates capability token, creates inbox task in SQLite
- New `iroh/protocols/status-push.js`: outbound — notifies assigning node of status changes
- `electron-main.js`: start Iroh node alongside MCP server on app launch
- `scripts/setup-server.sh`: start Iroh node as a systemd service on headless instances
- Test: two local Qalatra instances exchange a task push via Iroh

### Step 2 — Identity UI
- Settings → Identity: display this instance's NodeId (copyable), display name, avatar URL, color
- NodeId shown as a human-friendly encoding (or truncated hex with copy button)
- Instance UUID replaced by NodeId everywhere

### Step 3 — Capability token management
- Settings → Security: generate tokens by scope + label, list issued tokens, revoke
- Tokens validated on all inbound Iroh connections before any action is taken
- `issued_tokens` table migration

### Step 4 — Contacts / peer registry
- `contacts` table migration
- Settings → Contacts: add contact by pasting NodeId + their token, auto-fetches their display identity on first ping
- Contact card shows name, avatar, online status (Iroh ping)
- MCP tools: `list_contacts`, `get_contact`

### Step 5 — Peer-to-peer task passing
- `assign_to_peer(task_id, contact_name)` MCP tool
- UI: task detail panel "Assign to" picker (contacts list)
- Task row shows contact avatar when assigned out
- "Assigned Out" filtered view: tasks pushed to peers + their remote status
- Status updates received via `status-push` protocol, stored in `tasks.remote_status`

### Step 6 — Headless Linux validation
- Confirm Iroh node + MCP server + headless HTTP API runs cleanly without Electron on Ubuntu Server
- Write `scripts/setup-server.sh`
- Test: Mac Electron UI assigning a task to a headless Hetzner instance via Iroh

### Step 7 — Remote management connection (Cloudflare Tunnel)
- Settings → Instances: add remote instance by URL + `full_access` token
- `API_BASE` configurable, Electron UI works against remote backend
- Connection status indicator
- `cloudflared` setup documented and included in `setup-server.sh`

### Step 8 — Digital employee mode
- Config flag: `employee_mode: true`
- Employee Dashboard: Inbox + Active Jobs + Recent Output (simplified view)
- Acceptance rules: optional allowlist of contact NodeIds that can push tasks
- Employee identity configured in Settings → Identity

### Step 9 — Hetzner snapshot + deployment docs
- Perfect a CX32 instance, take snapshot
- Document snapshot ID + per-instance provision steps
- Future: Ansible playbook for managing updates to running instances

### Step 10 — Minimal auth/billing backend
- Small NestJS or Hono app + Postgres + Stripe
- User accounts, subscription management, license key issuance
- Single endpoint Qalatra pings on launch to validate subscription tier
- Gates Iroh node startup and all peer features behind `connected` tier
- Does NOT proxy task data — stays out of the data plane entirely

### Step 11 — Mobile app (future)
- Expo / React Native
- Iroh node per device (same transport as desktop)
- Instance switcher, voice intake (AI transcription — premium feature), APNs push (later)
