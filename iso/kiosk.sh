#!/bin/bash
# Opens the installer screen on this computer. Cog draws the same page Chromium used to draw.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p /run/user/0 /run/homebaseos-install
chmod 700 /run/user/0
export XDG_RUNTIME_DIR=/run/user/0 HOME=/root
export XCURSOR_THEME=Adwaita XCURSOR_SIZE=24
export WLR_NO_HARDWARE_CURSORS=1
rm -f /run/homebaseos-install/ui-ready
node iso/serve.js >>/tmp/homebaseos-installer.log 2>&1 &
say() { printf '%s\n' "$*" > /dev/tty1 || true; printf '%s\n' "$*"; }
url="http://127.0.0.1:${INSTALL_PORT:-8753}/install.html"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50; do
  [ -f /run/homebaseos-install/server-ready ] && break
  sleep 0.1
done

# gles2 uses the GPU when there is one, and llvmpipe in a VM. pixman is the fallback.
open_screen() {
  WLR_RENDERER="$1" cage -s -- cog --platform=wl --bg-color='#101a33' --doc-viewer \
    --webprocess-failure=restart "$url" >>/tmp/homebaseos-installer.log 2>&1
}

if command -v cage >/dev/null && command -v cog >/dev/null; then
  plymouth quit --retain-splash 2>/dev/null || true
  open_screen gles2 || open_screen pixman || true
  say "The installer screen stopped. Open $url"
  say "The log is /tmp/homebaseos-installer.log"
  exec sleep infinity
fi
say "Open $url"
exec sleep infinity
