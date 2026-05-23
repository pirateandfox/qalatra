# Draft Release Notes: Headless Server and Remote Instances

Status: draft for the next release. Written from `develop` at `7704b00`.

This release turns Qalatra from an Electron app with local backend behavior into a real server/client system. Desktop still feels like one app, but the backend is now Qalatra Server: an authenticated HTTP API that owns SQLite, MCP, background workers, agents, attachments, encryption keys, backups, and access tokens.

## Headline Changes

- Added Qalatra Server as a headless runtime under `server/`.
- Moved the UI data path to authenticated HTTP endpoints instead of Electron data IPC.
- Added Settings -> Instances so the Electron UI can switch between a local server and remote Qalatra Server instances.
- Added Linux headless install and Cloudflare Tunnel setup for public token-authenticated API access.
- Added token management, optional token expiry, and a clear two-channel Cloudflare trust model.
- Removed the legacy Electron data IPC backend. Electron IPC now remains only for desktop shell functions: local server lifecycle, terminal, updater, app menu, and file-open events.

## Server and API

- Added authenticated HTTP API on port `3456`.
- Added `/health` as the unauthenticated health endpoint.
- Added `/api/instance` for smoke testing and remote client identification.
- Added stable `/api/v1` routes for the current UI data surface:
  - tasks and task actions
  - notes and agent job history
  - daily notes
  - contexts
  - projects and project summaries
  - agents and agent rescans
  - habits
  - heartbeats
  - settings
  - MCP config
  - S3/R2 connection test
  - encryption key management
  - encrypted backups
  - attachment sync
- Removed the temporary `/api/rpc` bridge.
- Added shared HTTP helpers in `server/http.js` so route dispatch is cleaner and public request body limits are centralized.
- Added authenticated server-sent events at `/api/events`; agent job completion now uses the same event path for local and future remote clients.

## Desktop App Changes

- Electron starts Qalatra Server during app bootstrap and connects to it over the same HTTP API path used by remote clients.
- The server runs through Electron's Node runtime in desktop mode so native modules match Electron's ABI.
- The UI can save remote server URLs and bearer tokens in Settings -> Instances.
- The active UI data source can switch between the local server and any saved remote instance.
- Settings -> Instances can:
  - start or restart the local HTTP bridge
  - keep the local server and MCP running after Electron quits
  - install/remove/start/stop/restart an OS-managed start-at-login service
  - list/create/revoke access tokens
  - create expiring full-access tokens
- OS service support:
  - macOS LaunchAgent: `~/Library/LaunchAgents/com.qalatra.server.plist`
  - Linux user systemd: `~/.config/systemd/user/qalatra-server.service`
  - Windows logon Scheduled Task: `Qalatra Server`
- In `electron-dev`, installed services are ignored by default so dev always tests the current checkout. Use `QALATRA_DEV_USE_SERVICE=1` only for explicit service testing.

## MCP

- Qalatra Server owns MCP startup.
- MCP HTTP defaults to localhost on port `3457`.
- MCP should not be exposed through Cloudflare Tunnel.
- Claude Code still connects locally with:

```json
{
  "mcpServers": {
    "qalatra": {
      "type": "http",
      "url": "http://localhost:3457/mcp"
    }
  }
}
```

## Attachments, Files, Backups, and Encryption

- Moved attachment upload/list/delete/download through Qalatra Server.
- Added direct binary upload and content endpoints so remote clients do not need JSON-encoded file bytes.
- Added authenticated file APIs for remote Markdown/email editing and previews:
  - text read/write
  - style read/write
  - `/api/files/content` streaming with byte-range support
- Moved pending attachment sync into the server worker loop.
- Added headless encryption key management.
- Added encrypted backup run/list/restore from the server.
- Server keys are stored as `server-keystore` with `0600` permissions, or supplied by `QALATRA_ENCRYPTION_KEY` / `QALATRA_KEY_FILE`.
- Electron passes the existing safeStorage key to the local server so current encrypted attachments and backups continue to work after the HTTP migration.
- Electron service install migrates an existing safeStorage key into the server keystore so login services do not need plaintext secrets in launchd/systemd/task definitions.

## Security Model

- All API requests require `Authorization: Bearer <token>` except `/health`.
- Bootstrap creates an initial `full_access` token if none exists and writes it to `admin-token.txt` in the data directory with restricted permissions.
- Tokens are stored hashed in SQLite.
- Tokens can be listed, created, revoked, and optionally expired.
- Token scopes exist in the model; route-level scope enforcement is still future work beyond `full_access`.
- Public API request body limits were added for JSON and raw uploads.
- MCP binds localhost by default.
- Cloudflare Access should protect only operator channels, not the Qalatra API hostname.

Cloudflare trust model:

| Channel | Example hostnames | Cloudflare Access | Auth owner |
|---|---|---:|---|
| Operator access | `agent-test.qalatra.com`, `desktop-test.qalatra.com` | On | Cloudflare Access + SSH keys |
| Qalatra API | `api-test.qalatra.com` | Off | Qalatra bearer tokens |

Do not add the Qalatra API hostname to the operator Cloudflare Access app. Web, mobile, and Electron clients expect JSON API responses and authenticate with Qalatra bearer tokens.

## Linux Headless Install

New scripts:

- `scripts/bootstrap-linux-server.sh`
- `scripts/install-linux-server.sh`
- `scripts/install-cloudflare-tunnel.sh`
- `scripts/rebuild-node-native.mjs`
- `scripts/smoke-server.mjs`

One-line install:

```bash
export QALATRA_TUNNEL_HOSTNAME=api-test.qalatra.com
curl -fsSL https://raw.githubusercontent.com/pirateandfox/qalatra/develop/scripts/bootstrap-linux-server.sh | bash
```

The bootstrap path:

- installs or verifies Linux prerequisites
- clones or updates Qalatra in `~/qalatra`
- runs `npm ci --ignore-scripts` to avoid Electron ABI postinstall rebuilds
- rebuilds `better-sqlite3` and `node-pty` for system Node
- installs and starts `qalatra-server.service`
- optionally creates/reuses a Qalatra-owned Cloudflare Tunnel named `qalatra-api`
- routes the API hostname to `127.0.0.1:3456`
- installs and starts `qalatra-cloudflared.service`

For boot-before-login behavior:

```bash
loginctl enable-linger "$USER"
```

## Cloudflare Tunnel

- Qalatra installs a separate `qalatra-cloudflared.service` user service.
- The tunnel exposes only the API origin: `http://127.0.0.1:3456`.
- The MCP port `3457` is never published.
- The installer reuses an existing `~/.cloudflared/cert.pem` from operator setup when present.
- DNS routing targets the tunnel UUID with `--overwrite-dns`, preventing an existing operator tunnel from silently capturing the API hostname.

## Real Linux Smoke Test

First real Linux install was verified on `qalatra-dev-01`.

Passing checks:

- `qalatra-server.service` active
- `qalatra-cloudflared.service` active
- local `/health` passed
- local authenticated `/api/instance` passed
- public Cloudflare Tunnel authenticated `/api/instance` passed at `https://api-test.qalatra.com/api/instance`

Issues found during that install and fixed:

- systemd user unit generation had a bad setting
- native modules were compiled for Electron ABI instead of system Node ABI
- Cloudflare DNS initially routed the API hostname to the wrong tunnel

## Frontend Cleanup

- Split `ui/src/apiRuntime.ts` out of `ui/src/api.ts`.
  - `apiRuntime.ts` now handles server selection, local Electron server control, token-authenticated HTTP, and server event streaming.
  - `api.ts` now focuses on product API operations.
- Split the large Settings screen into tab-level components under `ui/src/components/settings/`:
  - `GeneralSettings.tsx`
  - `InstancesSettings.tsx`
  - `StorageSettings.tsx`
  - `EncryptionBackupSettings.tsx`
  - `ContextsSettings.tsx`
  - `AgentsSettings.tsx`
- Replaced the default Vite UI README with Qalatra-specific frontend architecture notes.
- Calibrated UI lint so `npm run lint --prefix ui` exits cleanly while existing `any` and hook dependency debt remains visible as warnings.
- Added UI lint to CI.

## Dependency and CI Work

- Updated root and UI dependency locks to clear local npm audit findings.
- Notable updates included Electron, Electron Builder, AWS SDK, MCP SDK, `better-sqlite3`, `uuid`, and UI transitive fixes.
- Local audits pass:
  - `npm audit --audit-level=moderate`
  - `npm audit --audit-level=moderate --prefix ui`
- GitHub still reports 3 Dependabot alerts on the default branch, but local `develop` audits are clean. Current checks show `hono@4.12.22`, no `@tootallnate/once`, and `brace-expansion` alerts auto-dismissed or patched in the relevant dependency paths.

CI now verifies:

- root dependency audit
- UI dependency audit
- UI lint
- UI build
- Electron packaging import coverage
- Linux script syntax
- system Node native rebuild
- headless server smoke test

## Verification Run Before This Note

These passed locally before the cleanup commit:

```bash
npm run lint --prefix ui
npm run build --prefix ui
npm run check-imports
npm run ci:server
npm audit --audit-level=moderate
npm audit --audit-level=moderate --prefix ui
git diff --check
```

Notes:

- UI lint exits with warnings only.
- Vite still warns about large chunks; this was pre-existing and does not block the release.
- `npm run ci:server` rebuilds native modules for system Node. Running `npm run electron-dev` afterward rebuilds them for Electron again.

## Breaking / Important Behavior Changes

- Legacy Electron data IPC is gone.
- UI data calls now require a running Qalatra Server.
- Desktop normally starts that local server automatically.
- Remote installs are API-only/headless. They do not include a web UI yet.
- Remote clients should connect through Electron Settings -> Instances for now.
- Existing users may need to reinstall or reconfigure rather than rely on a gradual migration path.
- Public API hostnames must not be protected by Cloudflare Access; Qalatra bearer tokens are the application auth layer.
- MCP is local-only and should not be tunneled publicly.

## Release Checklist Still Worth Doing

- Use the current Electron dev workflow locally for a few days.
- Smoke the packaged desktop app, not just `electron-dev`.
- Confirm start-at-login service behavior on macOS after reboot.
- Confirm Windows Scheduled Task path with the existing Windows user.
- Confirm Linux headless reinstall/update path on a clean box.
- Confirm remote Electron -> Linux API instance switching with a non-bootstrap expiring token.
- Confirm attachments, Markdown preview/edit, encrypted backup, and restore against a remote instance.
- Decide whether this release should be versioned as a larger architectural release, likely `1.6.0`, rather than a patch.

## Commit Trail

- `df7fe48` Add headless server and Linux bootstrap
- `03dbe0f` Fix Linux user service installer
- `c1893ba` Rebuild server native modules for system Node
- `d714378` Route Qalatra tunnel DNS by UUID
- `594bb9d` Document first Linux server install
- `b5a0a56` Harden headless server setup
- `7704b00` Refactor frontend API and settings structure
