#!/usr/bin/env bash
# deploy.sh — wysyła frontend i relay na serwer onchato.com
# Użycie: ./deploy/deploy.sh [user@host]
# Domyślny cel: root@onchato.com

set -euo pipefail

SERVER="${1:-root@onchato.com}"
REMOTE_APP="/opt/onchato"
REMOTE_WWW="/var/www/onchato"

echo "==> Budowanie frontendu..."
npm run build

echo "==> Wysyłanie frontendu → ${SERVER}:${REMOTE_WWW}/"
rsync -av --delete dist/ "${SERVER}:${REMOTE_WWW}/"

echo "==> Wysyłanie relay → ${SERVER}:${REMOTE_APP}/"
rsync -av \
  src/relay.mjs \
  package.json \
  package-lock.json \
  "${SERVER}:${REMOTE_APP}/"

echo "==> Instalowanie zależności na serwerze..."
ssh "${SERVER}" "cd ${REMOTE_APP} && npm ci --omit=dev"

echo "==> Restart relay service..."
ssh "${SERVER}" "sudo systemctl restart onchato-relay"

echo ""
echo "✅ Deploy zakończony."
echo "   Frontend:  https://onchato.com"
echo "   Relay:     wss://bs1.onchato.com/relay"
echo "   Logi relay: ssh ${SERVER} 'journalctl -u onchato-relay -f'"
