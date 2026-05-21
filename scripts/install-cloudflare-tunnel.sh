#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${QALATRA_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HOSTNAME="${1:-${QALATRA_TUNNEL_HOSTNAME:-}}"
TUNNEL_NAME="${QALATRA_TUNNEL_NAME:-qalatra-api}"
API_HOST="${QALATRA_API_HOST:-127.0.0.1}"
API_PORT="${QALATRA_API_PORT:-3456}"
SERVICE_URL="${QALATRA_TUNNEL_SERVICE:-http://$API_HOST:$API_PORT}"
CLOUDFLARED_BIN="${QALATRA_CLOUDFLARED_BIN:-$(command -v cloudflared || true)}"
CLOUDFLARED_HOME="${QALATRA_CLOUDFLARED_HOME:-$HOME/.cloudflared}"
CONFIG_DIR="${QALATRA_TUNNEL_CONFIG_DIR:-$HOME/.config/qalatra/cloudflared}"
CONFIG_FILE="$CONFIG_DIR/config.yml"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/qalatra-cloudflared.service"

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

tunnel_id_for_name() {
  local tunnel_name="$1"
  local tunnel_json
  tunnel_json="$("$CLOUDFLARED_BIN" tunnel list --output json 2>/dev/null || true)"
  node --input-type=module - "$tunnel_name" "$tunnel_json" <<'NODE'
const name = process.argv[2]
const input = process.argv[3] || '[]'
try {
  const tunnels = JSON.parse(input)
  const match = tunnels.find(t => t.name === name || t.Name === name)
  if (match) console.log(match.id || match.ID || match.uuid || match.UUID)
} catch {}
NODE
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

[ -n "$HOSTNAME" ] || fail "Set QALATRA_TUNNEL_HOSTNAME or pass the hostname as the first argument."
[ -n "$CLOUDFLARED_BIN" ] || fail "cloudflared is required. Install it first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
command -v node >/dev/null 2>&1 || fail "node is required."
command -v curl >/dev/null 2>&1 || fail "curl is required."
systemctl --user show-environment >/dev/null 2>&1 || fail "systemd --user is not available in this shell. SSH in as the target user without sudo, or enable a user session first."
systemd_literal "$CLOUDFLARED_BIN" >/dev/null
systemd_literal "$CONFIG_FILE" >/dev/null

mkdir -p "$CLOUDFLARED_HOME" "$CONFIG_DIR" "$SERVICE_DIR"

if [ ! -f "$CLOUDFLARED_HOME/cert.pem" ]; then
  info "Authenticating cloudflared"
  "$CLOUDFLARED_BIN" tunnel login
fi

TUNNEL_ID="$(tunnel_id_for_name "$TUNNEL_NAME" || true)"
if [ -z "$TUNNEL_ID" ]; then
  info "Creating Cloudflare Tunnel: $TUNNEL_NAME"
  "$CLOUDFLARED_BIN" tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$(tunnel_id_for_name "$TUNNEL_NAME" || true)"
fi
[ -n "$TUNNEL_ID" ] || fail "Could not find Cloudflare Tunnel ID for $TUNNEL_NAME."

CREDENTIALS_FILE="${QALATRA_TUNNEL_CREDENTIALS:-$CLOUDFLARED_HOME/$TUNNEL_ID.json}"
[ -f "$CREDENTIALS_FILE" ] || fail "Could not find tunnel credentials for $TUNNEL_NAME. Set QALATRA_TUNNEL_CREDENTIALS explicitly."

info "Writing Qalatra-only tunnel config"
cat > "$CONFIG_FILE" <<CONFIG
tunnel: $TUNNEL_ID
credentials-file: "$CREDENTIALS_FILE"

ingress:
  - hostname: $HOSTNAME
    service: $SERVICE_URL
    originRequest:
      noTLSVerify: false
  - service: http_status:404
CONFIG
chmod 600 "$CONFIG_FILE"

info "Creating DNS route $HOSTNAME -> $TUNNEL_ID"
if ! ROUTE_OUTPUT="$("$CLOUDFLARED_BIN" tunnel route dns --overwrite-dns "$TUNNEL_ID" "$HOSTNAME" 2>&1)"; then
  if printf '%s' "$ROUTE_OUTPUT" | grep -qiE 'already exists|record exists'; then
    echo "$ROUTE_OUTPUT"
  else
    fail "$ROUTE_OUTPUT"
  fi
fi

cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=Qalatra Cloudflare Tunnel
After=qalatra-server.service

[Service]
Type=simple
ExecStart=$(systemd_literal "$CLOUDFLARED_BIN") --config $(systemd_literal "$CONFIG_FILE") tunnel run $(systemd_literal "$TUNNEL_ID")
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

info "Starting Qalatra cloudflared user service"
systemctl --user daemon-reload
systemctl --user enable --now qalatra-cloudflared.service

LOCAL_HEALTH="http://$API_HOST:$API_PORT/health"
if wait_for_url "$LOCAL_HEALTH"; then
  LOCAL_STATUS="ok"
else
  LOCAL_STATUS="not ready"
fi

echo
echo "Qalatra Cloudflare Tunnel installed."
echo "Tunnel:  $TUNNEL_NAME"
echo "ID:      $TUNNEL_ID"
echo "Host:    https://$HOSTNAME"
echo "Origin:  $SERVICE_URL"
echo "Config:  $CONFIG_FILE"
echo "Service: $SERVICE_FILE"
echo "Local:   $LOCAL_STATUS ($LOCAL_HEALTH)"
echo
echo "Status: systemctl --user status qalatra-cloudflared.service"
echo "Logs:   journalctl --user -u qalatra-cloudflared.service -f"
echo
echo "Remote smoke test:"
echo "  TOKEN=\$(cat $(printf '%q' "${QALATRA_DATA_DIR:-$HOME/.local/share/qalatra/db}/admin-token.txt"))"
echo "  curl -fsS -H \"Authorization: Bearer \$TOKEN\" https://$HOSTNAME/api/instance"
echo
echo "This tunnel exposes only the Qalatra API origin. Do not publish MCP port 3457."
echo "Do not add $HOSTNAME to the operator Cloudflare Access app; Qalatra clients authenticate with bearer tokens."
