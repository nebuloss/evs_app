#!/bin/sh
# EVS App — update an already-installed appliance to the latest release.
#
# Run ON the appliance (LXC container) as root:
#     sh update.sh
# or one-liner:
#     curl -fsSL https://raw.githubusercontent.com/nebuloss/evs_app/master/update.sh | sh
#
# It downloads the latest pre-built release tarball, swaps in the new build,
# refreshes production dependencies, and restarts the service. It does NOT
# reinstall Node, recreate the user, or rewrite the service — use install.sh
# for a first-time install.
#
# Override defaults via env: APP_DIR, APP_USER, APP_PORT.

set -eu

# ── Configuration (must match install.sh) ───────────────────────────────────────
APP_DIR="${APP_DIR:-/opt/evs-app}"
APP_USER="${APP_USER:-evs}"
SERVICE_NAME="evs-app"
REPO="nebuloss/evs_app"
RELEASE_URL="https://github.com/$REPO/releases/latest/download/evs-app.tar.gz"

# ── Colours ─────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[+]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
error() { printf "${RED}[✗]${NC} %s\n" "$*"; exit 1; }

# ── Pre-flight ──────────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || error "Run as root (or prefix with sudo)"
[ -d "$APP_DIR" ] || error "$APP_DIR not found — run install.sh for a first-time install"

# Detect how the service is managed (systemd on Debian, OpenRC on Alpine).
if command -v systemctl >/dev/null 2>&1 && [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
    SVC=systemd
elif command -v rc-service >/dev/null 2>&1 && [ -f "/etc/init.d/$SERVICE_NAME" ]; then
    SVC=openrc
else
    SVC=none
    warn "No '$SERVICE_NAME' service found — files will be updated but not restarted automatically"
fi

# ── Resolve target version ──────────────────────────────────────────────────────
NEW_VER=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
info "Latest release: ${NEW_VER:-unknown}"

# ── Stop service ────────────────────────────────────────────────────────────────
case "$SVC" in
    systemd) info "Stopping service…"; systemctl stop "$SERVICE_NAME" || true ;;
    openrc)  info "Stopping service…"; rc-service "$SERVICE_NAME" stop || true ;;
esac

# ── Download + swap in the new build ────────────────────────────────────────────
info "Downloading latest release…"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$RELEASE_URL" | tar -xz -C "$TMP" \
    || error "Failed to download/extract release from $RELEASE_URL"

[ -d "$TMP/dist" ] && [ -d "$TMP/dist-server" ] || error "Release tarball is missing dist/ or dist-server/"

info "Installing new build into $APP_DIR…"
rm -rf "$APP_DIR/dist" "$APP_DIR/dist-server"
cp -r "$TMP/dist" "$TMP/dist-server" "$APP_DIR/"
cp "$TMP/package.json" "$TMP/package-lock.json" "$APP_DIR/"

# ── Refresh production dependencies ──────────────────────────────────────────────
info "Installing production dependencies…"
cd "$APP_DIR"
npm ci --omit=dev --prefer-offline --quiet 2>&1 | tail -3

# ── Ownership ───────────────────────────────────────────────────────────────────
chown -R "$APP_USER:$APP_USER" "$APP_DIR" 2>/dev/null \
    || chown -R "$APP_USER" "$APP_DIR" 2>/dev/null || true

# ── Restart service ─────────────────────────────────────────────────────────────
case "$SVC" in
    systemd)
        info "Starting service…"
        systemctl start "$SERVICE_NAME"
        sleep 1
        systemctl --no-pager --lines=0 status "$SERVICE_NAME" | head -4 || true
        ;;
    openrc)
        info "Starting service…"
        rc-service "$SERVICE_NAME" start
        ;;
    none)
        warn "Start the app manually: node $APP_DIR/dist-server/server.js"
        ;;
esac

info ""
info "✓ EVS App updated to ${NEW_VER:-latest}"
