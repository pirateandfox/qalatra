#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${QALATRA_SERVICE_NAME:-qalatra-server.service}"
ROOT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_ENTRY="$ROOT_DIR/mcp/http-server-entry.cjs"
CURRENT_UID="$(id -u)"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This remediation script is for Qalatra's Linux systemd user service." >&2
  exit 1
fi

if ! systemctl --user cat "$SERVICE_NAME" >/dev/null 2>&1; then
  echo "Cannot find systemd user service: $SERVICE_NAME" >&2
  exit 1
fi

unit_environment="$(systemctl --user show "$SERVICE_NAME" --property=Environment --value)"
unit_env_value() {
  local key="$1"
  tr ' ' '\n' <<<"$unit_environment" | sed -n "s/^${key}=//p" | tail -n 1
}

API_HOST="$(unit_env_value QALATRA_API_HOST)"
API_PORT="$(unit_env_value QALATRA_API_PORT)"
MCP_PORT="$(unit_env_value QALATRA_MCP_PORT)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-3456}"
MCP_PORT="${MCP_PORT:-3457}"

find_mcp_pids() {
  local proc_dir pid owner arg
  local -a argv
  for proc_dir in /proc/[0-9]*; do
    [[ -r "$proc_dir/cmdline" ]] || continue
    owner="$(stat -c '%u' "$proc_dir" 2>/dev/null || true)"
    [[ "$owner" == "$CURRENT_UID" ]] || continue
    pid="${proc_dir##*/}"
    argv=()
    mapfile -d '' -t argv < "$proc_dir/cmdline" || true
    for arg in "${argv[@]}"; do
      if [[ "$arg" == "$MCP_ENTRY" ]]; then
        printf '%s\n' "$pid"
        break
      fi
    done
  done
}

load_mcp_pids() {
  mapfile -t mcp_pids < <(find_mcp_pids)
}

echo "Stopping $SERVICE_NAME before removing MCP processes from older server generations..."
systemctl --user stop "$SERVICE_NAME"

load_mcp_pids
if (( ${#mcp_pids[@]} > 0 )); then
  echo "Terminating ${#mcp_pids[@]} MCP process(es): ${mcp_pids[*]}"
  kill -TERM -- "${mcp_pids[@]}" 2>/dev/null || true
  for _ in {1..30}; do
    sleep 0.1
    load_mcp_pids
    (( ${#mcp_pids[@]} == 0 )) && break
  done
fi

load_mcp_pids
if (( ${#mcp_pids[@]} > 0 )); then
  echo "Force-killing ${#mcp_pids[@]} MCP process(es) that ignored SIGTERM: ${mcp_pids[*]}"
  kill -KILL -- "${mcp_pids[@]}" 2>/dev/null || true
  sleep 0.2
fi

load_mcp_pids
if (( ${#mcp_pids[@]} > 0 )); then
  echo "MCP cleanup failed; matching processes remain: ${mcp_pids[*]}" >&2
  exit 1
fi

if command -v ss >/dev/null 2>&1 && ss -H -ltn "sport = :$MCP_PORT" | grep -q .; then
  echo "TCP port $MCP_PORT is still occupied after MCP cleanup:" >&2
  ss -H -ltnp "sport = :$MCP_PORT" >&2 || true
  exit 1
fi

echo "Starting $SERVICE_NAME with a clean MCP port..."
systemctl --user start "$SERVICE_NAME"

health_url="http://$API_HOST:$API_PORT/health"
health_json=''
for _ in {1..80}; do
  if health_json="$(curl --silent --show-error --fail "$health_url" 2>/dev/null)" \
    && grep -q '"ready":true' <<<"$health_json"; then
    break
  fi
  sleep 0.25
done

if [[ -z "$health_json" ]] || ! grep -q '"ready":true' <<<"$health_json"; then
  echo "Qalatra did not report a ready MCP child at $health_url" >&2
  systemctl --user status "$SERVICE_NAME" --no-pager -l >&2 || true
  exit 1
fi

main_pid="$(systemctl --user show "$SERVICE_NAME" --property=MainPID --value)"
load_mcp_pids
if (( ${#mcp_pids[@]} != 1 )); then
  echo "Expected exactly one MCP process after restart; found ${#mcp_pids[@]}: ${mcp_pids[*]:-none}" >&2
  exit 1
fi

mcp_pid="${mcp_pids[0]}"
mcp_ppid="$(awk '$1 == "PPid:" { print $2 }' "/proc/$mcp_pid/status")"
if [[ "$mcp_ppid" != "$main_pid" ]]; then
  echo "MCP PID $mcp_pid belongs to parent $mcp_ppid, not live Qalatra Server PID $main_pid" >&2
  exit 1
fi

echo "Cleanup complete: Qalatra Server PID $main_pid owns ready MCP child PID $mcp_pid on port $MCP_PORT."
