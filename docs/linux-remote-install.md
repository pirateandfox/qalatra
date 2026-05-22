# Linux Headless Server and Remote Access

This guide installs Qalatra Server on a Linux box without launching the Electron UI. The server owns the SQLite database, background workers, local MCP server, and authenticated HTTP API. Electron, web, or mobile clients connect to the API with a Qalatra bearer token.

## Trust Model

Use two separate Cloudflare channels:

| Channel | Example hostnames | Cloudflare Access | Auth owner |
|---|---|---:|---|
| Operator access | `agent-test.qalatra.com`, `desktop-test.qalatra.com` | On | Cloudflare Access + SSH keys |
| Qalatra API | `api-test.qalatra.com` | Off | Qalatra bearer tokens |

Do not add the Qalatra API hostname to the operator Access app. Electron, web, and mobile clients expect JSON responses from Qalatra and cannot handle a Cloudflare email/login wall.

It is fine if `~/.cloudflared/cert.pem` already exists from the operator setup. The Qalatra tunnel installer reuses that Cloudflare login, creates or reuses its own `qalatra-api` tunnel, and writes a separate user service named `qalatra-cloudflared.service`.

Never expose the MCP port (`3457`) through Cloudflare. MCP stays local to the Linux machine.

## Prerequisites

Run the install as the normal Linux user that should own Qalatra. Do not run the installer with `sudo`.

Required:

- Debian/Ubuntu or another Linux with user systemd
- Node.js 22+
- `git`, `curl`, and `npm`
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
- installs npm dependencies
- rebuilds native modules for system Node
- installs and starts `qalatra-server.service`
- creates or reuses the Cloudflare tunnel `qalatra-api`
- routes the API hostname to `127.0.0.1:3456`
- installs and starts `qalatra-cloudflared.service`

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

## Local MCP Setup

The Linux service starts MCP locally at:

```text
http://127.0.0.1:3457/mcp
```

If Claude Code runs on the Linux machine, add this to that user's `~/.claude.json`:

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

Restart Claude Code after editing the file.

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
