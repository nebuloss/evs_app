#!/bin/sh
# EVS App — install/deploy script
# Usage: curl -fsSL <raw-url>/install.sh | bash
#        or: GIT_REPO=https://github.com/you/evs-app.git bash install.sh
#
# Supported systems: Alpine Linux (OpenRC), Debian/Ubuntu/Raspbian (systemd)
# Requires: root (or sudo)

set -eu

# ── Configuration (override via env) ─────────────────────────────────────────
APP_DIR="${APP_DIR:-/opt/evs-app}"
APP_USER="${APP_USER:-evs}"
APP_PORT="${APP_PORT:-3000}"
NODE_VERSION="${NODE_VERSION:-22}"
SERVICE_NAME="evs-app"

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { printf "${GREEN}[+]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
error() { printf "${RED}[✗]${NC} %s\n" "$*"; exit 1; }

# ── Root check ────────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || error "Run as root (or prefix with sudo)"

# ── Detect OS ─────────────────────────────────────────────────────────────────
detect_os() {
    if [ -f /etc/alpine-release ]; then
        echo "alpine"
    elif [ -f /etc/debian_version ]; then
        echo "debian"
    else
        error "Unsupported OS — only Alpine and Debian-based systems are supported"
    fi
}

OS=$(detect_os)
info "Detected OS: $OS"

# ── Install system packages ───────────────────────────────────────────────────
install_packages_alpine() {
    info "Installing packages (Alpine)…"
    apk update -q
    apk add --no-cache curl ca-certificates

    # Node.js: Alpine 3.19+ ships Node 20, 3.20+ ships Node 22
    ALPINE_VER=$(cat /etc/alpine-release | cut -d. -f1,2)
    # Try to install node matching desired major version
    if apk info -q nodejs 2>/dev/null | grep -q "^nodejs-${NODE_VERSION}"; then
        apk add --no-cache "nodejs-${NODE_VERSION}" npm
    else
        apk add --no-cache nodejs npm
    fi

    NODE_ACTUAL=$(node --version 2>/dev/null || echo "none")
    info "Node.js installed: $NODE_ACTUAL"
}

install_packages_debian() {
    info "Installing packages (Debian/Ubuntu)…"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates

    # NodeSource — installs requested major version
    info "Installing Node.js ${NODE_VERSION}.x via NodeSource…"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs
    NODE_ACTUAL=$(node --version 2>/dev/null || echo "none")
    info "Node.js installed: $NODE_ACTUAL"
}

case "$OS" in
    alpine) install_packages_alpine ;;
    debian) install_packages_debian ;;
esac

# ── Create app user ───────────────────────────────────────────────────────────
if ! id "$APP_USER" >/dev/null 2>&1; then
    info "Creating system user '$APP_USER'…"
    case "$OS" in
        alpine) adduser -S -D -H -h "$APP_DIR" -s /sbin/nologin "$APP_USER" ;;
        debian) useradd -r -d "$APP_DIR" -s /usr/sbin/nologin "$APP_USER" ;;
    esac
fi

# ── Download pre-built release ────────────────────────────────────────────────
RELEASE_URL="https://github.com/nebuloss/evs_app/releases/latest/download/evs-app.tar.gz"
info "Downloading latest release…"
rm -rf "$APP_DIR/dist" "$APP_DIR/dist-server"
mkdir -p "$APP_DIR"
curl -fsSL "$RELEASE_URL" | tar -xz -C "$APP_DIR"

# ── Install production dependencies ───────────────────────────────────────────
info "Installing production dependencies…"
cd "$APP_DIR"
npm ci --omit=dev --prefer-offline --quiet 2>&1 | tail -3

# ── Set ownership ─────────────────────────────────────────────────────────────
chown -R "$APP_USER:$APP_USER" "$APP_DIR" 2>/dev/null \
    || chown -R "$APP_USER" "$APP_DIR"

# ── Install service ───────────────────────────────────────────────────────────
install_service_alpine() {
    info "Installing OpenRC service…"
    rc-service "$SERVICE_NAME" stop 2>/dev/null || true
    NODE_BIN=$(which node)
    cat > "/etc/init.d/$SERVICE_NAME" << EOF
#!/sbin/openrc-run

name="$SERVICE_NAME"
description="EVS Slot Finder App"
command="$NODE_BIN"
command_args="$APP_DIR/dist-server/server.js"
command_user="$APP_USER"
command_background=yes
pidfile="/run/\${RC_SVCNAME}.pid"
output_log="/var/log/\${RC_SVCNAME}.log"
error_log="/var/log/\${RC_SVCNAME}.log"

depend() {
    need net
    after firewall
}

start_pre() {
    export PORT=$APP_PORT
    export NODE_ENV=production
    touch /var/log/\${RC_SVCNAME}.log
    chown $APP_USER /var/log/\${RC_SVCNAME}.log
}
EOF
    chmod +x "/etc/init.d/$SERVICE_NAME"
    rc-update add "$SERVICE_NAME" default 2>/dev/null || true
    rc-service "$SERVICE_NAME" start
}

install_service_systemd() {
    info "Installing systemd service…"
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF
[Unit]
Description=EVS Slot Finder App
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(which node) $APP_DIR/dist-server/server.js
Restart=on-failure
RestartSec=5s
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
    systemctl start "$SERVICE_NAME"
}

case "$OS" in
    alpine) install_service_alpine ;;
    debian) install_service_systemd ;;
esac

# ── Done ──────────────────────────────────────────────────────────────────────
info ""
info "✓ EVS App deployed successfully!"
info "  URL:     http://localhost:$APP_PORT"
info "  Dir:     $APP_DIR"
info "  User:    $APP_USER"
info ""
case "$OS" in
    alpine)
        info "  Status:  rc-service $SERVICE_NAME status"
        info "  Logs:    tail -f /var/log/$SERVICE_NAME.log"
        ;;
    debian)
        info "  Status:  systemctl status $SERVICE_NAME"
        info "  Logs:    journalctl -u $SERVICE_NAME -f"
        ;;
esac
