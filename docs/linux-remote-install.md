# Linux Headless Server and Remote Access

This guide installs Qalatra Server on a Linux box without launching the Electron UI. The server owns the SQLite database, background workers, local MCP server, and authenticated HTTP API. Electron, web, or mobile clients connect to the API with a Qalatra bearer token.

## Trust Model

Use two separate Cloudflare channels:

| Channel | Example hostnames | Cloudflare Access | Auth owner |
|---|---|---:|---|
| Operator access | `agent-test.qalatra.com`, `desktop-test.qalatra.com` | On | Cloudflare Access + SSH keys |
| Qalatra API | `api-test.qalatra.com` | Off | Qalatra bearer tokens |
| Qalatra MCP | `mcp-test.qalatra.com` | Off | Qalatra bearer tokens (requires `QALATRA_MCP_AUTH=required`) |

Do not add the Qalatra API or MCP hostnames to the operator Access app. Clients expect JSON/MCP responses from Qalatra and cannot handle a Cloudflare email/login wall.

It is fine if `~/.cloudflared/cert.pem` already exists from the operator setup. The Qalatra tunnel installer reuses that Cloudflare login, creates or reuses its own `qalatra-api` tunnel, and writes a separate user service named `qalatra-cloudflared.service`.

## Prerequisites

Run the install as the normal Linux user that should own Qalatra. Do not run the installer with `sudo`.

Required:

- Debian/Ubuntu or another Linux with user systemd
- Node.js 22+
- `git`, `curl`, `tmux`, and `npm`
- `cloudflared` if installing the public API tunnel
- a Cloudflare zone that contains the API hostname parent domain

The bootstrap script can install `git`, `curl`, and Node.js 22 on Debian/Ubuntu hosts. It does not install `cloudflared`.

## One-Line Install

Set the API hostname, then run the bootstrap script:

```bash
export QALATRA_TUNNEL_HOSTNAME=api-test.qalatra.com

curl -fsSL https://raw.githubusercontent.com/pirateandfox/qalatra/develop/scripts/bootstrap-linux-server.sh | bash
```

Replace `api-test.qalatra.com` with the hostname for this machine.

The bootstrap script:

- clones or updates Qalatra in `~/qalatra`
- creates a normal-user workspace at `~/workspaces` unless `QALATRA_WORKSPACE_ROOT` is set
- installs npm dependencies
- rebuilds native modules for system Node
- installs and starts `qalatra-server.service`
- creates or reuses the Cloudflare tunnel `qalatra-api`
- routes the API hostname to `127.0.0.1:3456`
- installs and starts `qalatra-cloudflared.service`

For a dedicated agent box, keep the workspace under the normal service user, not `/root`:

```bash
export QALATRA_WORKSPACE_ROOT=$HOME/workspaces
```

That workspace is used as the default Agent IDE root, terminal working directory, and agent scan root on first install.

If you want to install the server first and add the tunnel later:

```bash
curl -fsSL https://raw.githubusercontent.com/pirateandfox/qalatra/develop/scripts/bootstrap-linux-server.sh | bash

cd ~/qalatra
QALATRA_TUNNEL_HOSTNAME=api-test.qalatra.com ./scripts/install-cloudflare-tunnel.sh
```

## Reboot Survival

Enable lingering once so the user services can start before an interactive login:

```bash
loginctl enable-linger "$USER"
```

Check the services:

```bash
systemctl --user status qalatra-server.service --no-pager -l
systemctl --user status qalatra-cloudflared.service --no-pager -l
```

## Updating an Existing Headless Install

### Automatic updates (1.9.4+)

Fresh installs from 1.9.4 onward install a `qalatra-updater.timer` that checks GitHub releases every 6 hours. No manual action needed — the box will update itself.

Check the timer status:
```bash
systemctl --user status qalatra-updater.timer
journalctl --user -u qalatra-updater.service -n 40 --no-pager
```

### Manual update / bootstrap the auto-updater on older installs

Run as the Qalatra service user (not `sudo`):

```bash
cd ~/qalatra
git fetch --tags origin
git reset --hard v1.9.4     # or latest tag
npm ci --ignore-scripts
npm run rebuild:node
./scripts/install-linux-server.sh   # also installs qalatra-updater.timer
systemctl --user restart qalatra-server.service
```

The installer is safe to rerun. It refreshes npm dependencies, rebuilds native modules for system Node, rewrites the user service and installs the auto-updater timer.

If this is the first update to the Agent IDE build, verify `tmux` exists and keep the workspace under the normal user account:

```bash
command -v tmux
mkdir -p ~/workspaces
```

Smoke test after the restart:

```bash
curl -fsS http://127.0.0.1:3456/health

TOKEN=$(cat ~/.local/share/qalatra/db/admin-token.txt)

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3456/api/instance
```

If the machine uses a public API tunnel, check that service too:

```bash
systemctl --user status qalatra-cloudflared.service --no-pager -l
```

## Smoke Tests

Run these on the Linux server:

```bash
curl -fsS http://127.0.0.1:3456/health

TOKEN=$(cat ~/.local/share/qalatra/db/admin-token.txt)

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3456/api/instance
```

Run the remote API test from the Linux server or another machine:

```bash
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  https://api-test.qalatra.com/api/instance
```

Expected response:

```json
{"ok":true,"name":"Qalatra","started_at":"..."}
```

## Electron Remote Instance Setup

On your desktop Electron app:

```text
Settings -> Instances -> Add Server

URL:   https://api-test.qalatra.com
Token: contents of ~/.local/share/qalatra/db/admin-token.txt from the Linux server
```

Prefer creating a dedicated expiring token for each client in Settings -> Instances -> Access Tokens. Treat the bootstrap token like an admin password and revoke unused tokens promptly.

## Box Web Apps

Qalatra 1.9.8+ can embed one private web app per remote box in the desktop sidebar. This is intended for box-local tools such as a small dashboard, email console, or root page that links to the other tools running on that same machine.

The server side is deliberately narrow in V1:

- Qalatra Server proxies only `http://127.0.0.1:8080` on the active remote box.
- The desktop client creates a short-lived Box Web session through the existing bearer-token API connection, then loads the iframe through `/api/box-web/proxy/<ticket>/...`.
- The permanent Qalatra token is not sent to the embedded page.
- Root-relative HTML links/assets and CSS `url(/...)` references are rewritten for the proxy. JavaScript that hard-codes absolute paths such as `fetch('/api/...')` may need relative URLs or a later proxy rewrite pass.

Enable it on the desktop:

```text
Settings -> Instances -> Box Web Apps

Check "Show for <box>"
Label: Tools
```

Serve the box tools app on loopback port 8080. For a static `www` root, any normal local-only static server is fine:

```bash
cd ~/www
python3 -m http.server 8080 --bind 127.0.0.1
```

For a persistent service, point nginx, Caddy, or your app server at `127.0.0.1:8080`. Do not bind this private surface to `0.0.0.0` unless you also intend to expose it outside the box.

Smoke test from the Linux box:

```bash
curl -fsS http://127.0.0.1:8080/ >/dev/null

TOKEN=$(cat ~/.local/share/qalatra/db/admin-token.txt)

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3456/api/box-web/status
```

Expected response when the tools app is reachable:

```json
{"ok":true,"available":true,"target":"http://127.0.0.1:8080","statusCode":200}
```

A public Cloudflare hostname for the same tools app, such as `tools-shi.qalatra.com`, remains optional. It is useful when you are away from a machine with Qalatra Desktop. It is not required for the in-app Box Web sidebar, which uses the existing authenticated Qalatra API connection.

## MCP Setup

The Linux service starts MCP locally at `http://127.0.0.1:3457/mcp`.

### Local-only (Claude Code running on the same box)

If Claude Code runs on the Linux machine, add this to `~/.claude.json`:

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

Restart Claude Code after editing the file. No auth is needed — loopback requests bypass token checking by default.

### Remote MCP via Cloudflare Tunnel

To reach MCP from your laptop (or any Claude Code instance on another machine), expose the MCP port through a separate tunnel hostname and enable token auth.

**⚠️ IMPORTANT:** By default (`QALATRA_MCP_AUTH=local-bypass`), the MCP server skips auth for requests that appear to come from loopback. Behind a Cloudflare tunnel, all traffic arrives from the local `cloudflared` daemon at `127.0.0.1`, so it looks like loopback — meaning the default mode offers **no protection** for tunneled traffic. You must set `QALATRA_MCP_AUTH=required` before exposing the port.

1. Add `QALATRA_MCP_AUTH=required` to the server's systemd service:

```bash
# Edit the service file
systemctl --user edit qalatra-server.service
```

Add under `[Service]`:
```ini
[Service]
Environment=QALATRA_MCP_AUTH=required
```

Then reload and restart:
```bash
systemctl --user daemon-reload
systemctl --user restart qalatra-server.service
```

2. Add the MCP hostname to your Cloudflare tunnel config (in `~/.config/qalatra/cloudflared/config.yml`):

```yaml
ingress:
  - hostname: api-test.qalatra.com
    service: http://127.0.0.1:3456
  - hostname: mcp-test.qalatra.com
    service: http://127.0.0.1:3457
  - service: http_status:404
```

Restart the tunnel: `systemctl --user restart qalatra-cloudflared.service`

3. Add a DNS route in Cloudflare for the MCP hostname pointing to the same tunnel UUID.

4. On your laptop, configure Claude Code with `mcp-remote`:

```json
{
  "mcpServers": {
    "qalatra-shi": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://mcp-test.qalatra.com/mcp",
        "--header", "Authorization: Bearer ${QALATRA_MCP_TOKEN}"
      ]
    }
  }
}
```

Set `QALATRA_MCP_TOKEN` in your environment to any valid Qalatra token (create one in Settings → Instances → Access Tokens). The same tokens that work for the API also work for MCP.

## Troubleshooting

API is not healthy:

```bash
systemctl --user status qalatra-server.service --no-pager -l
journalctl --user -u qalatra-server.service -n 160 --no-pager
```

Tunnel returns `404`:

```bash
cat ~/.config/qalatra/cloudflared/config.yml
cloudflared tunnel info qalatra-api
dig +short CNAME api-test.qalatra.com
```

The DNS route should point to the `qalatra-api` tunnel UUID. The installer uses `cloudflared tunnel route dns --overwrite-dns` to prevent an existing operator tunnel route from capturing the API hostname.

Native module ABI errors:

```bash
cd ~/qalatra
npm run rebuild:node
systemctl --user restart qalatra-server.service
```

The rebuild command should print:

```text
Native modules OK for Node ... ABI ...
```
