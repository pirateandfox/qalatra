#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${QALATRA_REPO_URL:-https://github.com/pirateandfox/qalatra.git}"
REF="${QALATRA_REF:-develop}"
INSTALL_DIR="${QALATRA_INSTALL_DIR:-$HOME/qalatra}"
AUTO_INSTALL_DEPS="${QALATRA_AUTO_INSTALL_DEPS:-1}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    echo ""
  elif have sudo; then
    echo "sudo"
  else
    fail "sudo is required to install missing system packages. Install git/curl/Node.js 22 manually, or rerun with QALATRA_AUTO_INSTALL_DEPS=0 after installing them."
  fi
}

install_basic_deps_debian() {
  local sudo_cmd
  sudo_cmd="$(need_sudo)"
  info "Installing git/curl/tmux prerequisites with apt"
  $sudo_cmd apt-get update
  $sudo_cmd apt-get install -y ca-certificates curl git tmux
}

install_node_debian() {
  local sudo_cmd
  sudo_cmd="$(need_sudo)"
  info "Installing Node.js 22 with NodeSource apt packages"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $sudo_cmd -E bash -
  $sudo_cmd apt-get install -y nodejs
}

node_major() {
  node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
}

ensure_dependencies() {
  if ! have git || ! have curl || ! have tmux; then
    if [ "$AUTO_INSTALL_DEPS" = "1" ] && have apt-get; then
      install_basic_deps_debian
    else
      fail "git, curl, and tmux are required. Install them first, or run on a Debian/Ubuntu host with QALATRA_AUTO_INSTALL_DEPS=1."
    fi
  fi

  if ! have node || [ "$(node_major)" -lt 22 ]; then
    if [ "$AUTO_INSTALL_DEPS" = "1" ] && have apt-get; then
      install_node_debian
    else
      fail "Node.js 22+ is required. Install it first, or run on a Debian/Ubuntu host with QALATRA_AUTO_INSTALL_DEPS=1."
    fi
  fi

  have npm || fail "npm is required and should be installed with Node.js."
}

checkout_qalatra() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating Qalatra checkout at $INSTALL_DIR"
  elif [ -e "$INSTALL_DIR" ]; then
    fail "$INSTALL_DIR exists but is not a git checkout. Set QALATRA_INSTALL_DIR to a different path."
  else
    info "Cloning Qalatra into $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  # REF may be a branch, a release tag or a full commit SHA. Fetch it into one ref so all three
  # resolve: `checkout REF` + `reset --hard origin/REF` only worked for a branch, and
  # `clone --branch` refuses a commit. A branch stays a branch; anything else is checked out detached,
  # the way the auto-updater leaves a box on its release tag.
  git -C "$INSTALL_DIR" fetch --tags origin "+$REF:refs/qalatra/requested" \
    || fail "Could not fetch $REF from $REPO_URL. Use a branch, a release tag or a full 40-character commit SHA."
  if git -C "$INSTALL_DIR" ls-remote --exit-code origin "refs/heads/$REF" >/dev/null 2>&1; then
    git -C "$INSTALL_DIR" checkout --force -B "$REF" refs/qalatra/requested
    git -C "$INSTALL_DIR" branch --quiet --set-upstream-to "origin/$REF" "$REF" 2>/dev/null || true
  else
    git -C "$INSTALL_DIR" checkout --force --detach refs/qalatra/requested
  fi
}

main() {
  info "Bootstrapping Qalatra Server"
  echo "Repo:    $REPO_URL"
  echo "Ref:     $REF"
  echo "Install: $INSTALL_DIR"

  ensure_dependencies
  checkout_qalatra

  info "Installing Qalatra Server service"
  "$INSTALL_DIR/scripts/install-linux-server.sh"

  if [ -n "${QALATRA_TUNNEL_HOSTNAME:-}" ]; then
    info "Installing Qalatra Cloudflare Tunnel"
    "$INSTALL_DIR/scripts/install-cloudflare-tunnel.sh"
  else
    echo
    echo "Cloudflare Tunnel not installed. To add it later:"
    echo "  QALATRA_TUNNEL_HOSTNAME=qalatra.example.com $INSTALL_DIR/scripts/install-cloudflare-tunnel.sh"
  fi

  echo
  echo "Bootstrap complete."
}

main "$@"
