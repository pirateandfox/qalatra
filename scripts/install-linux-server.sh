#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${QALATRA_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA_DIR="${QALATRA_DATA_DIR:-$HOME/.local/share/qalatra/db}"
WORKSPACE_ROOT="${QALATRA_WORKSPACE_ROOT:-$HOME/workspaces}"
API_HOST="${QALATRA_API_HOST:-127.0.0.1}"
API_PORT="${QALATRA_API_PORT:-3456}"
MCP_HOST="${QALATRA_MCP_HOST:-127.0.0.1}"
MCP_PORT="${QALATRA_MCP_PORT:-3457}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/qalatra-server.service"
NODE_BIN="${QALATRA_NODE_BIN:-$(command -v node || true)}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

systemd_literal() {
  local value="$1"
  if [[ "$value" =~ [[:space:]\"\\] ]]; then
    fail "systemd user service values cannot contain whitespace, quotes, or backslashes: $value"
  fi
  printf '%s' "$value"
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-40}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

mkdir -p "$DATA_DIR" "$SERVICE_DIR" "$WORKSPACE_ROOT"

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tmux >/dev/null 2>&1 || fail "tmux is required for persistent Agent IDE terminal sessions."
[ -n "$NODE_BIN" ] || fail "node is required. Install Node.js 22+ first."

NODE_MAJOR="$("$NODE_BIN" -p "Number(process.versions.node.split('.')[0])")"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22+ is required. Found: $("$NODE_BIN" -v)"

systemctl --user show-environment >/dev/null 2>&1 || fail "systemd --user is not available in this shell. SSH in as the target user without sudo, or enable a user session first."

systemd_literal "$ROOT_DIR" >/dev/null
systemd_literal "$DATA_DIR" >/dev/null
systemd_literal "$WORKSPACE_ROOT" >/dev/null
systemd_literal "$NODE_BIN" >/dev/null

info "Installing Qalatra Server"
echo "Root: $ROOT_DIR"
echo "Data: $DATA_DIR"
echo "Workspace: $WORKSPACE_ROOT"
echo "API:  http://$API_HOST:$API_PORT"
echo "MCP:  http://$MCP_HOST:$MCP_PORT/mcp"

SETTINGS_FILE="$DATA_DIR/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
  cat > "$SETTINGS_FILE" <<SETTINGS
{
  "workspaceRoot": "$WORKSPACE_ROOT",
  "agentsRoot": "$WORKSPACE_ROOT",
  "terminalCwd": "$WORKSPACE_ROOT"
}
SETTINGS
fi

info "Installing npm dependencies"
(cd "$ROOT_DIR" && npm ci --ignore-scripts)

# The desktop app rebuilds native modules for Electron's Node ABI. A pure
# headless Linux server runs under system Node, so force native modules back
# to the current Node ABI before starting the service.
info "Rebuilding native modules for system Node"
(cd "$ROOT_DIR" && npm run rebuild:node)

cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=Qalatra Server

[Service]
Type=simple
WorkingDirectory=$(systemd_literal "$ROOT_DIR")
Environment=NODE_ENV=production
Environment=QALATRA_DATA_DIR=$(systemd_literal "$DATA_DIR")
Environment=QALATRA_API_HOST=$(systemd_literal "$API_HOST")
Environment=QALATRA_API_PORT=$(systemd_literal "$API_PORT")
Environment=QALATRA_MCP_HOST=$(systemd_literal "$MCP_HOST")
Environment=QALATRA_MCP_PORT=$(systemd_literal "$MCP_PORT")
Environment=QALATRA_START_MCP=1
Environment=QALATRA_START_WORKERS=1
Environment=QALATRA_BOOTSTRAP_TOKEN_FILE=1
ExecStart=$(systemd_literal "$NODE_BIN") $(systemd_literal "$ROOT_DIR/server/index.js")
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

info "Starting systemd user service"
systemctl --user daemon-reload
systemctl --user enable --now qalatra-server.service

# Auto-updater: systemd timer that checks GitHub releases every 6 hours
UPDATER_SERVICE="$SERVICE_DIR/qalatra-updater.service"
UPDATER_TIMER="$SERVICE_DIR/qalatra-updater.timer"

cat > "$UPDATER_SERVICE" <<UPDATER_SVC
[Unit]
Description=Qalatra Auto-Updater
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=QALATRA_ROOT=$(systemd_literal "$ROOT_DIR")
Environment=QALATRA_NODE_BIN=$(systemd_literal "$NODE_BIN")
ExecStart=/usr/bin/bash $(systemd_literal "$ROOT_DIR/scripts/auto-update.sh")
StandardOutput=journal
StandardError=journal
UPDATER_SVC

cat > "$UPDATER_TIMER" <<UPDATER_TMR
[Unit]
Description=Qalatra Auto-Updater Timer

[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target
UPDATER_TMR

chmod +x "$ROOT_DIR/scripts/auto-update.sh"
systemctl --user daemon-reload
systemctl --user enable --now qalatra-updater.timer

HEALTH_URL="http://$API_HOST:$API_PORT/health"
if wait_for_url "$HEALTH_URL"; then
  HEALTH_STATUS="ok"
else
  HEALTH_STATUS="not ready"
fi

TOKEN_FILE="$DATA_DIR/admin-token.txt"
echo
echo "Qalatra Server installed."
echo "Service: $SERVICE_FILE"
echo "Health:  $HEALTH_STATUS ($HEALTH_URL)"
echo "API:     http://$API_HOST:$API_PORT"
echo "MCP:     http://$MCP_HOST:$MCP_PORT/mcp"
echo "Data:    $DATA_DIR"
echo "Workspace: $WORKSPACE_ROOT"
echo "Token:   $TOKEN_FILE"
if [ -f "$TOKEN_FILE" ]; then
  echo
  echo "Smoke test:"
  echo "  TOKEN=\$(cat $(printf '%q' "$TOKEN_FILE"))"
  echo "  curl -fsS -H \"Authorization: Bearer \$TOKEN\" http://$API_HOST:$API_PORT/api/instance"
fi
echo
echo "Status:  systemctl --user status qalatra-server.service"
echo "Logs:    journalctl --user -u qalatra-server.service -f"
echo "Updates: systemctl --user status qalatra-updater.timer"
echo
echo "For a truly headless machine that should start before an interactive login,"
echo "enable user lingering once: loginctl enable-linger \"$USER\""
echo
echo "Optional public API tunnel:"
echo "  QALATRA_TUNNEL_HOSTNAME=qalatra.example.com ./scripts/install-cloudflare-tunnel.sh"
