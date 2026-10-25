#!/bin/bash
# X session for the installer: the logo stays on top until the language screen is drawn.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export XCURSOR_SIZE=24
xset s off -dpms 2>/dev/null || true
xsetroot -cursor_name left_ptr 2>/dev/null || true
python3 "$ROOT/iso/splash.py" >>/tmp/homebaseos-installer.log 2>&1 &
splash=$!
# Let the logo cover the screen before Chromium opens its own window.
sleep 0.5
url="http://127.0.0.1:${INSTALL_PORT:-8753}/install.html"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  node -e 'fetch("http://127.0.0.1:'"${INSTALL_PORT:-8753}"'/api/config").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' && break
  sleep 0.3
done
chromium --kiosk --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --disable-infobars --ozone-platform=x11 --start-fullscreen "$url" \
  >>/tmp/homebaseos-installer.log 2>&1 &
chrome=$!
wait "$chrome" || true
kill "$splash" 2>/dev/null || true
wait "$splash" 2>/dev/null || true
