#!/usr/bin/env bash
# Installs TSMB as a systemd service on Debian/Ubuntu (alternative to Docker).
# Usage: sudo ./install.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo ./install.sh"; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/tsmb

echo "==> Installing system packages (ffmpeg, python3, curl)"
apt-get update -qq
apt-get install -y -qq ffmpeg python3 python3-venv curl ca-certificates >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

echo "==> Copying bot to $DEST"
id tsmb >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin tsmb
mkdir -p "$DEST"
cp -r "$SRC"/src "$SRC"/public "$SRC"/package.json "$SRC"/package-lock.json "$DEST"/
[ -f "$DEST/.env" ] || cp "$SRC/.env.example" "$DEST/.env"
[ -f "$SRC/.env" ] && cp "$SRC/.env" "$DEST/.env"

echo "==> Installing dependencies"
cd "$DEST"
npm ci --omit=dev --silent
python3 -m venv .venv
.venv/bin/pip install -q -U "yt-dlp[default]"
chown -R tsmb:tsmb "$DEST"
chmod 600 "$DEST/.env"

echo "==> Installing systemd service"
cp "$SRC/deploy/tsmb.service" /etc/systemd/system/tsmb.service
systemctl daemon-reload
systemctl enable --now tsmb

echo
echo "Done. Edit $DEST/.env (TS_HOST, WEB_PASSWORD, ...) then: sudo systemctl restart tsmb"
echo "Logs: journalctl -u tsmb -f"
