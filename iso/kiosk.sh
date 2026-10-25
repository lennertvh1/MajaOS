#!/bin/bash
# Opens the installer screen on this computer. Started by the live system.
# The logo stays up, with a progress bar, until the language screen has been drawn.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p /run/user/0 /run/homebaseos-install
chmod 700 /run/user/0
export XDG_RUNTIME_DIR=/run/user/0 HOME=/root
rm -f /run/homebaseos-install/ui-ready
node iso/serve.js >>/tmp/homebaseos-installer.log 2>&1 &
say() { printf '%s\n' "$*" > /dev/tty1 || true; printf '%s\n' "$*"; }
url="http://127.0.0.1:${INSTALL_PORT:-8753}/install.html"

# Keep the last logo on the framebuffer, then draw the same logo in X until Chromium has painted.
if command -v xinit >/dev/null && command -v Xorg >/dev/null && command -v python3 >/dev/null && command -v chromium >/dev/null; then
  plymouth quit --retain-splash 2>/dev/null || true
  xinit "$ROOT/iso/xsession.sh" -- :0 vt1 -background none -nolisten tcp >>/tmp/xorg.log 2>&1 &
  xpid=$!
  ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do
    [ -S /tmp/.X11-unix/X0 ] && ready=1 && break
    kill -0 "$xpid" 2>/dev/null || break
    sleep 0.25
  done
  if [ "$ready" = 1 ]; then
    wait "$xpid" || true
    say "The installer screen stopped. Open $url"
    say "The log is /tmp/homebaseos-installer.log"
    exec sleep infinity
  fi
  kill "$xpid" 2>/dev/null || true
  wait "$xpid" 2>/dev/null || true
fi

# Chromium refuses to start as root without --no-sandbox. pixman draws without a GPU, which a VM usually lacks.
if command -v cage >/dev/null && command -v chromium >/dev/null; then
  plymouth quit 2>/dev/null || true
  WLR_NO_HARDWARE_CURSORS=1 WLR_RENDERER=pixman cage -s -- chromium --kiosk --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --no-first-run --no-default-browser-check --disable-infobars --disable-extensions --disable-sync \
    --disable-translate --disable-background-networking --disable-component-update --disable-default-apps \
    --ozone-platform=wayland --start-fullscreen "$url" || true
  say "The installer screen stopped. Open $url"
  say "The log is /tmp/homebaseos-installer.log"
  exec sleep infinity
fi
say "Open $url"
exec sleep infinity
