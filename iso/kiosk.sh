#!/bin/bash
# Opens the installer screen on this computer. Started by the live system on tty1.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p /run/user/0
chmod 700 /run/user/0
export XDG_RUNTIME_DIR=/run/user/0 HOME=/root
node iso/serve.js >>/tmp/homebaseos-installer.log 2>&1 &
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  node -e 'fetch("http://127.0.0.1:'"${INSTALL_PORT:-8753}"'/api/config").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' && break
  sleep 0.3
done
URL="http://127.0.0.1:${INSTALL_PORT:-8753}/install.html"
say() { printf '%s\n' "$*" > /dev/tty1 || true; printf '%s\n' "$*"; }
# Chromium refuses to start as root without --no-sandbox. pixman draws without a GPU, which a VM usually lacks.
if command -v cage >/dev/null && command -v chromium >/dev/null; then
  plymouth quit 2>/dev/null || true
  cage -s -- chromium --kiosk --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --no-first-run --disable-infobars --ozone-platform=wayland --start-fullscreen "$URL" || true
  say "The installer screen stopped. Open $URL"
  say "The log is /tmp/homebaseos-installer.log"
  exec sleep infinity
fi
say "Open $URL"
exec sleep infinity
