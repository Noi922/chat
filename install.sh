#!/bin/sh
# Installiert den Chat-Server ohne Docker als Systemdienst.
# Läuft mit jeder POSIX-Shell (sh, dash, bash, busybox ash).
#
#   sudo ./install.sh
#
set -eu

APP_DIR=/opt/chat-server
DATA_DIR=/var/lib/chat-server
ENV_FILE=/etc/chat-server.env
SERVICE_USER=chat
MIN_NODE=18
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

info() { printf '==> %s\n' "$*"; }
die() { printf 'Fehler: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Bitte als root ausführen (z. B. mit sudo)."
[ -f "$SRC_DIR/server.js" ] || die "server.js nicht gefunden – das Skript muss im Projektordner liegen."

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

install_node() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    # RHEL-Familie (Rocky, Alma, CentOS Stream): Standard ist oft ein altes Node.js – neueren Modul-Stream wählen
    for stream in 22 20 18; do
      if dnf -q module list nodejs 2>/dev/null | grep -q "^nodejs  *$stream "; then
        dnf module reset -y nodejs
        dnf module enable -y "nodejs:$stream"
        break
      fi
    done
    dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed nodejs npm
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs npm
  else
    die "Kein unterstützter Paketmanager gefunden. Bitte Node.js $MIN_NODE+ selbst installieren oder Docker verwenden."
  fi
}

if [ "$(node_major)" -lt "$MIN_NODE" ] || ! command -v npm >/dev/null 2>&1; then
  info "Installiere Node.js über den Paketmanager …"
  install_node
fi
if [ "$(node_major)" -lt "$MIN_NODE" ]; then
  die "Diese Distribution liefert nur Node.js $(node_major), benötigt wird $MIN_NODE oder neuer.
Installiere eine neuere Version (https://nodejs.org/de/download) oder nutze Docker: docker compose up -d"
fi
info "Node.js $(node --version) gefunden"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  info "Lege Systembenutzer „$SERVICE_USER“ an"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null ||
      useradd --system --home-dir "$DATA_DIR" --shell /sbin/nologin "$SERVICE_USER"
  else
    addgroup -S "$SERVICE_USER" 2>/dev/null || true
    adduser -S -D -H -h "$DATA_DIR" -s /sbin/nologin -G "$SERVICE_USER" "$SERVICE_USER"
  fi
fi
SERVICE_GROUP=$(id -gn "$SERVICE_USER")

info "Kopiere Programmdateien nach $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR"
rm -rf "$APP_DIR/src" "$APP_DIR/public"
cp -R "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$SRC_DIR/src" "$SRC_DIR/public" "$APP_DIR/"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DATA_DIR"
chmod 750 "$DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  info "Lege Konfiguration $ENV_FILE an"
  sed -e '/^# DATA_DIR=/d' -e '/^# Kopiere/d' "$SRC_DIR/.env.example" > "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  chown "root:$SERVICE_GROUP" "$ENV_FILE"
else
  info "Bestehende Konfiguration $ENV_FILE bleibt unverändert"
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  info "Richte systemd-Dienst ein"
  sed "s/^Group=chat$/Group=$SERVICE_GROUP/" "$SRC_DIR/deploy/chat-server.service" > /etc/systemd/system/chat-server.service
  systemctl daemon-reload
  systemctl enable chat-server >/dev/null
  systemctl restart chat-server
  info "Fertig. Status: systemctl status chat-server · Logs: journalctl -u chat-server -f"
else
  info "Kein systemd gefunden – der Dienst wurde nicht automatisch eingerichtet."
  cat <<EOF
Starte den Server von Hand (oder binde diesen Befehl in dein Init-System ein):

  su -s /bin/sh $SERVICE_USER -c 'set -a; . $ENV_FILE; set +a; DATA_DIR=$DATA_DIR NODE_ENV=production exec node $APP_DIR/server.js'

EOF
fi

PORT_VALUE=$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1)
info "Der Chat ist unter http://<Server-Adresse>:${PORT_VALUE:-3000} erreichbar. Einstellungen: $ENV_FILE"
