#!/usr/bin/env bash
# Watch2Gether one-command installer for Ubuntu/Debian.
#
#   sudo ./install.sh                         # app only  -> http://<ip>:3000
#   sudo DOMAIN=watch.example.com ./install.sh  # + Caddy HTTPS + coturn TURN relay
#
# Idempotent: safe to re-run to update. Requires root.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/watch2gether}"
APP_USER="${APP_USER:-watch}"
PORT="${PORT:-3000}"
DOMAIN="${DOMAIN:-}"           # set to enable HTTPS via Caddy + TURN relay
NODE_MAJOR="${NODE_MAJOR:-20}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo ./install.sh)"
. /etc/os-release 2>/dev/null || true
command -v apt-get >/dev/null || die "this installer targets Debian/Ubuntu (apt)"

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg ffmpeg openssl >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  log "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node $(node -v), npm $(npm -v)"

log "Creating service user + app dir"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"

log "Copying application files"
# Copy source (never node_modules/data from the source tree).
for item in src public package.json package-lock.json; do
  [ -e "$SRC_DIR/$item" ] && cp -r "$SRC_DIR/$item" "$APP_DIR/"
done
mkdir -p "$APP_DIR/data/uploads"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "Installing npm dependencies"
if [ -f "$APP_DIR/package-lock.json" ]; then
  ( cd "$APP_DIR" && sudo -u "$APP_USER" npm ci --omit=dev >/dev/null 2>&1 ) \
    || ( cd "$APP_DIR" && sudo -u "$APP_USER" npm install --omit=dev >/dev/null 2>&1 )
else
  ( cd "$APP_DIR" && sudo -u "$APP_USER" npm install --omit=dev >/dev/null 2>&1 )
fi

# ---- optional TURN relay (needed for reliable cross-network calls) ----
TURN_ENV=""
if [ -n "$DOMAIN" ]; then
  log "Installing coturn (TURN relay)"
  apt-get install -y -qq coturn >/dev/null
  PUBIP="$(curl -fsS4 ifconfig.me || echo '')"
  TURN_SECRET="$(openssl rand -hex 24)"
  cat > /etc/turnserver.conf <<EOF
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=${DOMAIN}
min-port=49160
max-port=49200
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
no-cli
no-tls
no-dtls
EOF
  grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn 2>/dev/null \
    || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn
  TURN_ENV="Environment=TURN_SECRET=${TURN_SECRET}
Environment=TURN_HOST=${PUBIP}"
  log "coturn active: $(systemctl is-active coturn) (relay host ${PUBIP})"
fi

log "Writing systemd service"
cat > /etc/systemd/system/watch2gether.service <<EOF
[Unit]
Description=Watch2Gether movie sync server
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) ${APP_DIR}/src/server.js
Environment=PORT=${PORT}
Environment=DATA_DIR=${APP_DIR}/data
${TURN_ENV}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable watch2gether >/dev/null 2>&1 || true
systemctl restart watch2gether

# ---- optional HTTPS via Caddy ----
if [ -n "$DOMAIN" ]; then
  if ! command -v caddy >/dev/null; then
    log "Installing Caddy"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  fi
  log "Configuring Caddy for ${DOMAIN}"
  cat > /etc/caddy/Caddyfile <<EOF
{
	admin off
}
${DOMAIN} {
	reverse_proxy 127.0.0.1:${PORT}
}
EOF
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy
fi

# ---- firewall (only if ufw is present/active) ----
if command -v ufw >/dev/null; then
  log "Opening firewall ports"
  if [ -n "$DOMAIN" ]; then
    ufw allow 80/tcp   >/dev/null 2>&1 || true
    ufw allow 443/tcp  >/dev/null 2>&1 || true
    ufw allow 3478/udp >/dev/null 2>&1 || true
    ufw allow 3478/tcp >/dev/null 2>&1 || true
    ufw allow 49160:49200/udp >/dev/null 2>&1 || true
  else
    ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
  fi
fi

# ---- health check ----
log "Waiting for the app to answer"
ok=0
for _ in $(seq 1 10); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/health"; then ok=1; break; fi
  sleep 1
done
[ "$ok" -eq 1 ] || die "app did not become healthy — check: journalctl -u watch2gether -n 50"

echo
log "Done. Watch2Gether is running."
if [ -n "$DOMAIN" ]; then
  echo "   URL:   https://${DOMAIN}  (Caddy is fetching a TLS cert; give it a few seconds)"
  echo "   TURN:  relay enabled on ${PUBIP:-this host}:3478"
else
  echo "   URL:   http://$(curl -fsS4 ifconfig.me 2>/dev/null || echo '<server-ip>'):${PORT}"
  echo "   Tip:   re-run with DOMAIN=your.domain to add HTTPS + a TURN relay."
fi
echo "   Logs:  journalctl -u watch2gether -f"
