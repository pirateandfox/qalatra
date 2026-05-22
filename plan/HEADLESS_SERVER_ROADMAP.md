# Qalatra Headless Server Roadmap

## Target Shape

Qalatra becomes one backend with multiple clients:

- **Qalatra Server** owns SQLite, HTTP API, MCP, background workers, agents, heartbeats, settings, backups, and access tokens.
- **Qalatra Desktop** is an Electron client and local server manager. It can start a local server, but its data path should use the same authenticated HTTP API as remote clients.
- **Qalatra Web / Mobile** are future clients that connect to any Qalatra Server URL with a scoped token.

The product can still feel like one app on desktop: the installer includes the UI and the server. The runtime boundary is still real so Linux headless installs do not need Electron.

## Security Model

All API requests require `Authorization: Bearer <token>` except `/health`.

Tokens are:

- random bearer secrets prefixed with `qalatra_`
- stored hashed in SQLite
- scoped with values such as `full_access`, `inbox_write`, `read_only`, and future `agent_run`
- revocable by ID

On first server launch, if no `full_access` token exists, the server creates one and writes it to `admin-token.txt` in the data directory with `0600` permissions.

MCP remains localhost-only by default. Cloudflare Tunnel should proxy local services; the server should not bind public interfaces directly unless there is a specific reason.

## Current Migration Slice

Implemented first:

- `server/index.js`: authenticated HTTP API on port 3456
- `server/auth.js`: token table, bootstrap token, list/create/revoke helpers
- `server/db-client.js`: reusable `db-worker.js` wrapper for headless use
- `server/workers.js`: headless background worker loop for agent jobs, autorun, and heartbeats
- `/api/v1`: named authenticated routes for core UI data operations
- `/api/instance` and `/api/tokens`
- `/api/files`, `/api/files/content`, and `/api/styles/*`: authenticated remote file read/write, byte-range streaming for previews, and Markdown style access under configured roots.
- `/api/attachments`, `/api/attachments/:id`, and `/api/attachments/:id/content`: authenticated binary upload, list/delete, and content streaming for local or remote attachments.
- `/api/events`: authenticated server-sent event stream for agent job completion and future long-running server notifications.
- Server-side attachments, encryption key management, and encrypted backup operations now run without Electron IPC.
- `scripts/install-linux-server.sh`: Linux user-systemd install path
- UI Settings → Instances for adding remote servers and switching the active data source
- UI token management for listing, creating, and revoking server access tokens.
- Electron-managed Local Server that runs against the local DB. Electron starts this server during app bootstrap and lets it own MCP, agent/heartbeat workers, scheduled backups, and data access. The legacy data IPC backend has been removed; Electron IPC remains only for desktop shell capabilities.
- Optional detached local-server mode so Electron can close while Qalatra Server, MCP, and workers keep running.
- OS-managed start-at-login services from Settings → Instances:
  - macOS LaunchAgent: `~/Library/LaunchAgents/com.qalatra.server.plist`
  - Linux user systemd: `~/.config/systemd/user/qalatra-server.service`
  - Windows logon Scheduled Task: `Qalatra Server`
- Linux remote install path now includes:
  - `scripts/bootstrap-linux-server.sh` for one-line clone/update/install from GitHub
  - `scripts/install-linux-server.sh` for Qalatra Server
  - `scripts/install-cloudflare-tunnel.sh` for a Qalatra-only Cloudflare Tunnel service named `qalatra-cloudflared.service`
  - Tunnel ingress points only at the authenticated API (`127.0.0.1:3456` by default), not MCP.
- `electron-dev` ignores installed OS services by default and keeps using a checkout-local child server. Use `QALATRA_DEV_USE_SERVICE=1` only when intentionally testing service behavior.
- The temporary `/api/rpc` bridge has been removed.

## Build Order From Here

1. **Harden the v1 API**
   - Keep all UI data calls in `ui/src/api.ts` and add new operations as named `/api/v1` routes.
   - Add route-level tests/smokes for the core resources before packaging Linux builds.
   - Tighten CORS/origin policy before exposing remote web clients beyond trusted tunnels.

2. **Split core logic**
   - Extract task, recurrence, notes, habits, projects, attachments, and agent job operations out of `db-worker.js`.
   - Keep `db-worker.js` as a transport/worker shell.
   - Make MCP tools, HTTP API, and Electron local mode call the same service modules.

3. **Typed client contracts**
   - Generate or hand-maintain typed request/response contracts for `/api/v1`.
   - Keep business failures such as incomplete subtasks as action results, not HTTP failures.
   - Add scoped-token enforcement per route once `read_only`, `inbox_write`, and `agent_run` are active.

4. **Desktop server management**
   - Add installer polish around the existing launchd/systemd/Scheduled Task manager.
   - Linux headless boxes that need boot without an interactive login should enable user lingering or use a future system-level service.
   - Windows currently uses a per-user logon Scheduled Task; defer a true Windows Service until there is a concrete need for pre-login operation.
   - Electron should create/store a local token and register the local server as the default instance.

5. **Remote management**
   - Cloudflare Tunnel setup in Settings or install script.
   - Token creation UI in Settings → Instances/Security.
   - Connection health indicators and active instance switcher.

6. **True web/mobile clients**
   - Reuse the same API and token model.
   - Add a browser-safe file/attachment model and remote terminal transport before promising full remote administration.

## This Week Linux Goal

Install on a Linux box with the bootstrap script:

```bash
curl -fsSL https://raw.githubusercontent.com/pirateandfox/qalatra/develop/scripts/bootstrap-linux-server.sh | bash
```

Or, manually:

```bash
git clone https://github.com/pirateandfox/qalatra.git
cd qalatra
npm ci
./scripts/install-linux-server.sh
```

The Linux server-only path rebuilds native modules for system Node. Desktop
bundles should run the server with Electron as the Node runtime instead
(`ELECTRON_RUN_AS_NODE=1`) so `better-sqlite3` matches Electron's ABI.

Then:

- read the first token from `~/.local/share/qalatra/db/admin-token.txt`
- check `curl http://127.0.0.1:3456/health`
- add the server in Electron Settings → Instances
- configure Claude against `http://127.0.0.1:3457/mcp` on that machine

For public remote access, install a Qalatra-only Cloudflare Tunnel:

```bash
QALATRA_TUNNEL_HOSTNAME=qalatra.example.com ./scripts/install-cloudflare-tunnel.sh
```

This creates a separate `qalatra-cloudflared.service`, so it can coexist with an admin SSH tunnel. It points only at `127.0.0.1:3456`; do not expose the MCP port publicly.

Keep the Cloudflare trust channels separate:

- SSH/noVNC/operator hostnames should stay behind Cloudflare Access policies.
- The Qalatra API hostname should not be added to the operator Access app. Electron, web, and mobile clients need to reach the API directly and authenticate with Qalatra bearer tokens.

If `~/.cloudflared/cert.pem` already exists from the operator setup, the Qalatra tunnel installer uses it and skips `cloudflared tunnel login`.

### First Linux install verification

Validated on `qalatra-dev-01` with:

- Qalatra Server running as `qalatra-server.service`
- Qalatra Cloudflare Tunnel running as `qalatra-cloudflared.service`
- local health check passing at `http://127.0.0.1:3456/health`
- local authenticated API check passing at `http://127.0.0.1:3456/api/instance`
- remote authenticated API check passing through `https://api-test.qalatra.com/api/instance`

Follow-up issues discovered during the first install and fixed on `develop`:

- Linux systemd user units should use plain literal values and avoid brittle `network-online.target` ordering.
- Linux server installs must skip Electron postinstall native rebuilds and explicitly rebuild `better-sqlite3`/`node-pty` for system Node.
- Cloudflare DNS routing should target the tunnel UUID and use `--overwrite-dns` so operator-tunnel DNS cannot accidentally capture the Qalatra API hostname.
