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
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50; do
  [ -f /run/homebaseos-install/server-ready ] && break
  sleep 0.1
done
# No extensions, sync or update checks: this is one local page, and those delay the first paint.
chromium --kiosk --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check --disable-infobars --disable-extensions --disable-sync \
  --disable-translate --disable-background-networking --disable-component-update --disable-default-apps \
  --ozone-platform=x11 --start-fullscreen "$url" \
  >>/tmp/homebaseos-installer.log 2>&1 &
chrome=$!
wait "$chrome" || true
kill "$splash" 2>/dev/null || true
wait "$splash" 2>/dev/null || true
