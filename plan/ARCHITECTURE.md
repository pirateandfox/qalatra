# Task OS — Architecture Spec

## Current State

The existing `~/task-os/` is a working prototype: SQLite database, MCP server, Node.js scripts. It proved the concept and works well as a personal tool. It is not distribution-ready. This document captures the architecture for **Task OS v2** — a clean rebuild designed for open source distribution, with sync and multi-platform support built in from day one.

The current implementation serves as the product requirements reference. Every tool, field, and behavior already built is the spec.

---

## Core Philosophy

**Local-first.** The app is fast because it runs against a local database. That speed is a feature, not an accident. The goal is to preserve it while enabling optional sync and collaboration.

- Personal tasks: fully local, never leave the device
- Collaborative projects: selectively synced with specific people
- No central authority required
- Your data lives on your device

---

## Architecture Overview

### Data Layer

**Automerge** as the primary store (not SQLite + sync bolted on).

- CRDT documents handle conflict resolution natively — concurrent edits from multiple devices reconcile automatically
- Best-in-class conflict resolution, mature JavaScript bindings
- Local persistence via Automerge's built-in storage adapters
- Each "project" is an Automerge document; personal tasks are a local-only document

The MCP server reads/writes Automerge documents directly. SQLite is not part of v2.

### Sync Layer

**Automerge sync server** — a persistent relay that stores CRDT document state.

- Not a traditional database — stores encrypted CRDT blobs
- Solves the offline problem: when a device comes back online, it syncs from the server's stored state. Both devices do not need to be online simultaneously.
- Data is end-to-end encrypted — the relay cannot read user content
- Stateless from the user's perspective: if the relay goes down, your data is still on your device

The relay server is built with **NestleJS** (Justin's own framework) backed by **Postgres** for encrypted blob storage.

### Identity & Auth

**No username/password accounts.** Identity is keypair-based — the desktop is the root of trust.

#### Personal mode (one person, multiple devices)

Pairing flow:
1. Desktop generates a keypair on first launch, stores it in the OS keychain
2. To add a device: desktop displays a QR code / one-time pairing code
3. New device scans it, receives the shared encryption key
4. Both devices sync via the relay — the relay authenticates by key, not by account

Device recovery scenarios:

| Scenario | Solution |
|---|---|
| Add new device | Pair from any existing device (QR/code) |
| Lost phone | Revoke from desktop → relay rejects old key → pair new phone |
| Lost desktop | Pair new desktop, approve from phone |
| Lost everything | Recovery phrase → regenerate root keypair |

**Recovery phrase:** a BIP39-style 24-word mnemonic generated at setup. Written down once, stored safely. If all devices are lost, the phrase regenerates the root keypair and re-accesses encrypted relay data. This is the only credential that needs to exist.

The relay never sees plaintext data. If a device is stolen, it has encrypted blobs it cannot read and a key the relay will reject once revoked.

#### Team mode (shared agent hub, company use)

A different product mode where a company runs a Task OS instance and multiple people connect to dispatch agents and share task pools. This mode benefits from traditional accounts + admin-managed access control. Designed for later — personal mode ships first.

---

## Platform Targets

```
taskos/
  packages/
    core/        ← Automerge documents, data model, sync logic, keypair/crypto
    mcp/         ← MCP server (Claude integration)
    desktop/     ← Electron app
    mobile/      ← React Native app (iOS + Android)
    sync-server/ ← NestleJS relay server
```

**Desktop** is the primary environment — full MCP integration, Claude talks to the local Automerge store directly. Fast, local, AI-native. Desktop app stays **Electron**:

- Already built and working — no rewrite cost
- Auto-updater via electron-updater already in place
- MCP server runs as a utilityProcess alongside the app (current architecture)
- Frontend stays React/TypeScript

**Mobile** is **React Native** (not React Native Web):

- Installed on device — encryption key never leaves the device
- Same trust model as desktop: relay sees only encrypted blobs
- React Native Web rejected: JS served from a web server at runtime, which would require trusting the server not to exfiltrate keys — breaks the E2E encryption guarantee
- No web app for task data for the same reason

**Web** is limited to unauthenticated surfaces: marketing site, public/shared task views (if a user opts to share). Not a home for private task data.

**Note on SQLite:** SQLite does not go away in v2 — it drops down a layer. Automerge uses it internally as its local persistence mechanism via a storage adapter. Your application code never writes SQL directly; you interact only with the Automerge API. Same file format, completely different relationship to your code.

---

## File Attachments

Sync links, not files. The CRDT document stores a reference (file key + metadata). The file itself lives in object storage.

**Default recommendation: Cloudflare R2**
- S3-compatible API
- Zero egress fees (unlike AWS S3 at ~$0.09/GB)
- 10GB free tier — most users never pay anything

**Implementation: one S3-compatible integration covers everything.**
The AWS S3 SDK supports a configurable endpoint URL. Users bring S3, R2, Backblaze B2, Wasabi, MinIO, or DigitalOcean Spaces — the app doesn't change.

```
Settings → Storage
  Endpoint:    [https://your-account.r2.cloudflarestorage.com]
  Bucket:      [my-taskos-files]
  Access Key:  [...]
  Secret Key:  [...]
```

Files upload directly from the client to the user's bucket via presigned URLs. The sync server never touches file content.

---

## Hosting & Business Model

### Sync Relay

Justin hosts a sync relay. Users can connect to it with one button or configure their own.

```
Settings → Sync
  ● Task OS Relay (hosted)   [Connect]
  ○ Self-hosted              [Enter URL: ____________]
  ○ Off (local only)
```

**Cost structure:**
- Relay stores encrypted CRDT state for task data (text fields, dates, status) — tiny per user, negligible storage cost
- A small VPS (~$6-10/month, Hetzner/Fly.io/Railway) handles thousands of users
- Margins are excellent

**Pricing:**
```
Free:     Local only, no sync
$5/mo:    Sync relay (tasks) + BYOS for file attachments
$10/mo:   Sync relay + hosted file storage (Xgb included, R2 under the hood)
```

### Billing & Auth

Billing identity and data identity are fully decoupled — the relay never knows who you are, only whether your token is valid.

**Billing layer (NestleJS, Postgres):**
- Minimal accounts table: `(email, stripe_customer_id, subscription_status)`
- Stripe handles payment, invoicing, and the customer-facing subscription portal
- On active subscription: the billing API issues a signed relay token tied to the user's public key
- Token format: `{ pubkey, valid_until, sig }` — signed with the relay's private key

**Relay layer:**
- Validates token signature and expiry on connection
- Never looks up email or user account
- Rejects connections with expired or missing tokens
- Accepts self-hosters with no token (they own their relay)

**Flow:**
```
1. User subscribes via Stripe Customer Portal (email + card)
2. Billing API issues relay token: { pubkey: "abc...", valid_until: "2027-01-01", sig: "..." }
3. Token stored locally on device
4. Device connects to relay → presents token → relay validates → sync allowed
5. Subscription cancelled → token expires → relay rejects → local data unaffected
```

**Device management:**
- New device paired via QR/code → relay token travels with keypair or re-issued from billing portal
- Lost device revoked from desktop or billing portal → relay rejects that public key
- Billing portal (web, email login) is the only place email is used — purely for subscription management

### File Storage (hosted tier)

If offering hosted storage: use Cloudflare R2 on the backend (zero egress fees). Start with BYOS-only — it sidesteps GDPR/data retention complexity. Add hosted storage as an upsell once operationally ready.

### GDPR & Privacy

Because the relay stores only encrypted blobs it cannot read, data custody obligations are minimal. Users own their data cryptographically — even if the relay is subpoenaed, the data is unreadable without the user's key. Billing data (email, payment history) is standard Stripe-managed PII — well-understood obligations, nothing unusual. This is a strong legal and ethical position.

---

## Open Source Strategy

- App is open source (MIT or Apache 2)
- Self-hosters run their own sync relay (documented, simple to deploy with NestleJS + Postgres)
- Hosted relay is the commercial offering — sell convenience, not the software
- Self-hosters are free marketing to technical users who refer paying friends

This is the Obsidian model: free local app, paid sync.

---

## Open Questions

- **Compaction strategy** — how often to squash Automerge history to keep storage flat
- **Buffer window** — how long the hosted relay retains state for offline devices
- **Team mode auth** — account model for shared/company instances (personal mode ships first)

---

## What Carries Forward from v1

- All MCP tool names and behaviors (current tools are the product spec)
- Task schema: context, source_url, due_date, surface_after, recurrence (RRULE)
- Recurring task logic (spawn next on complete/skip)
- Morning briefing, end-of-day, stale backlog review workflows
- The concept of Task OS as Claude's task interface — that stays central
