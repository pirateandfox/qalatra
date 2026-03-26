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

### Identity

Keypair per user — no username/password accounts. Sharing a collaborative project means sharing the project's encryption key with a collaborator's public key.

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

## Platform Targets

```
taskos/
  packages/
    core/        ← Automerge documents, data model, sync logic
    mcp/         ← MCP server (Claude integration)
    desktop/     ← Electron or Tauri app
    web/         ← Web UI (manual input, not Claude-connected)
    mobile/      ← React Native (manual input)
    sync-server/ ← Hosted relay
```

**Desktop** is the primary environment — full MCP integration, Claude talks to the local Automerge store directly. Fast, local, AI-native. Desktop app is built with **Tauri** (Rust + web frontend):

- Distributable is 3-10MB vs Electron's 80-150MB
- Auto-updater built in
- MCP server runs as a Tauri sidecar — bundled with the app, auto-started alongside it
- Frontend stays React/TypeScript; Rust surface area is minimal (thin glue, existing plugins)
- SQLite support built in via `tauri-plugin-sql`, used by Automerge's storage adapter internally

**Note on SQLite:** SQLite does not go away in v2 — it drops down a layer. Automerge uses it internally as its local persistence mechanism via a storage adapter. Your application code never writes SQL directly; you interact only with the Automerge API. Same file format, completely different relationship to your code.

**Web and mobile** are secondary — for manual input and visibility when away from the desktop. They hit the sync server's API. No MCP/Claude integration in these environments.

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

### File Storage (hosted tier)

If offering hosted storage: use Cloudflare R2 on the backend (zero egress fees). Start with BYOS-only — it sidesteps GDPR/data retention complexity. Add hosted storage as an upsell once operationally ready.

---

## Open Source Strategy

- App is open source (MIT or Apache 2)
- Self-hosters run their own sync relay (documented, simple to deploy)
- Hosted relay is the commercial offering — sell convenience, not the software
- Self-hosters are free marketing to technical users who refer paying friends

This is the Obsidian model: free local app, paid sync.

---

## Open Questions

- **Compaction strategy** — how often to squash Automerge history to keep storage flat
- **Buffer window** — how long the hosted relay retains state for offline devices
- **Mobile framework** — React Native (shared JS with web) vs Flutter

---

## What Carries Forward from v1

- All MCP tool names and behaviors (current tools are the product spec)
- Task schema: context, source_url, due_date, surface_after, recurrence (RRULE)
- Recurring task logic (spawn next on complete/skip)
- Morning briefing, end-of-day, stale backlog review workflows
- The concept of Task OS as Claude's task interface — that stays central
