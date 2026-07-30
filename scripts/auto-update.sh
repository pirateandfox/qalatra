#!/usr/bin/env bash
# Qalatra headless auto-updater.
# Checks GitHub releases; if a newer version exists, checks it out,
# rebuilds native modules, and restarts the qalatra-server service.
set -euo pipefail

REPO="pirateandfox/qalatra"
ROOT_DIR="${QALATRA_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${QALATRA_NODE_BIN:-$(command -v node 2>/dev/null || echo '')}"
SERVICE_NAME="${QALATRA_SERVICE_NAME:-qalatra-server.service}"

log()  { echo "[qalatra-update] $*"; }
fail() { echo "[qalatra-update] ERROR: $*" >&2; exit 1; }

[ -n "$NODE_BIN" ] || fail "node not found"
[ -f "$ROOT_DIR/package.json" ] || fail "package.json not found at $ROOT_DIR"

CURRENT_VERSION=$("$NODE_BIN" -p "require('$ROOT_DIR/package.json').version" 2>/dev/null || echo '')
[ -n "$CURRENT_VERSION" ] || fail "could not read current version"
log "Current version: v$CURRENT_VERSION"

# Fetch latest published release from GitHub
LATEST_JSON=$(curl -sf --max-time 15 "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || echo '{}')
LATEST_TAG=$("$NODE_BIN" -p "try{JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).tag_name||''}catch(e){''}" <<< "$LATEST_JSON" 2>/dev/null || echo '')
LATEST_VERSION="${LATEST_TAG#v}"

if [ -z "$LATEST_VERSION" ]; then
  log "Could not determine latest version — skipping"
  exit 0
fi
log "Latest release: v$LATEST_VERSION"

# Semver comparison via Node
IS_NEWER=$("$NODE_BIN" -e "
const c = '$CURRENT_VERSION'.split('.').map(Number)
const l = '$LATEST_VERSION'.split('.').map(Number)
let newer = false
for (let i = 0; i < 3; i++) {
  if (l[i] > c[i]) { newer = true; break }
  if (l[i] < c[i]) break
}
process.stdout.write(newer ? 'yes' : 'no')
" 2>/dev/null || echo 'no')

if [ "$IS_NEWER" != "yes" ]; then
  log "Already up to date"
  exit 0
fi

log "Updating v$CURRENT_VERSION → v$LATEST_VERSION..."
cd "$ROOT_DIR"

git fetch --tags --quiet origin
git reset --hard "v$LATEST_VERSION"

log "Installing dependencies..."
npm ci --ignore-scripts --quiet

log "Rebuilding native modules..."
npm run rebuild:node 2>&1 | tail -3

# Self-heal the systemd unit: KillMode=process keeps systemd from SIGKILLing a tmux
# server that landed in this service's cgroup (which would kill remote terminals). The
# unit is generated once at install time and never regenerated here, so patch it in
# place if the directive is missing. Doing this *before* the restart means even a
# pre-scope-fix tmux server survives this upgrade — only the main PID is signalled.
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_NAME"
if [ -f "$UNIT_FILE" ] && ! grep -q '^KillMode=' "$UNIT_FILE"; then
  log "Adding KillMode=process to $SERVICE_NAME"
  sed -i '/^\[Service\]/a KillMode=process' "$UNIT_FILE"
  systemctl --user daemon-reload
fi

log "Restarting $SERVICE_NAME..."
systemctl --user restart "$SERVICE_NAME"

log "Successfully updated to v$LATEST_VERSION"
