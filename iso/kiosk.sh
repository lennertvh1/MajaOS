#!/bin/bash
# Opens the installer screen on this computer. Started by the live system.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node iso/serve.js >>/tmp/homebaseos-installer.log 2>&1 &
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  node -e 'fetch("http://127.0.0.1:'"${INSTALL_PORT:-8753}"'/api/config").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' && break
  sleep 0.3
done
URL="http://127.0.0.1:${INSTALL_PORT:-8753}/install.html"
if command -v cage >/dev/null && command -v chromium >/dev/null; then
  exec cage -s -- chromium --kiosk --no-first-run --disable-infobars --ozone-platform=wayland --start-fullscreen "$URL"
fi
echo "Open $URL"
sleep infinity
