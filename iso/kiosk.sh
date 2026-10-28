#!/bin/bash
# Opens the installer screen on this computer. Cog draws the same page Chromium used to draw.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p /run/user/0 /run/majaos-install
chmod 700 /run/user/0
export XDG_RUNTIME_DIR=/run/user/0 HOME=/root
export XCURSOR_THEME=Adwaita XCURSOR_SIZE=24
export WLR_NO_HARDWARE_CURSORS=1
# Software GL is more reliable in VMs; set INSTALL_GL=0 on real hardware with a GPU if needed.
export LIBGL_ALWAYS_SOFTWARE="${INSTALL_GL:-1}"
node iso/serve.js >>/tmp/majaos-installer.log 2>&1 &
say() { printf '%s\n' "$*" > /dev/tty1 || true; printf '%s\n' "$*"; }
url="http://127.0.0.1:${INSTALL_PORT:-8753}/install.html?kiosk=1"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95 96 97 98 99 100; do
  [ -f /run/majaos-install/server-ready ] && break
  sleep 0.1
done
if [ ! -f /run/majaos-install/server-ready ]; then
  say "The installer server did not start. See /tmp/majaos-installer.log"
  exec sleep infinity
fi

# pixman first: works in VMs without GPU passthrough; gles2 when a GPU is available.
# Only options that cage 0.2.0 (Debian 13) knows: an unknown one (like -D) stops cage at once and leaves a black screen.
open_screen() {
  WLR_RENDERER="$1" cage -s -- cog --platform=wl --bg-color='#101a33' --doc-viewer \
    --webprocess-failure=restart "$url" >>/tmp/majaos-installer.log 2>&1
}

if command -v cage >/dev/null && command -v cog >/dev/null; then
  # For when the mouse or keyboard does nothing: what the kernel sees, and whether this runs in a session.
  { echo "== input devices"; grep -E '^(N|H):' /proc/bus/input/devices; echo "== sessions"; loginctl list-sessions --no-pager; } >>/tmp/majaos-installer.log 2>&1
  # cage needs the screen. --retain-splash leaves the logo on it until the page paints over it.
  plymouth quit --retain-splash 2>/dev/null || true
  open_screen pixman || open_screen gles2 || true
  say "The installer screen stopped. Open $url"
  say "The log is /tmp/majaos-installer.log"
  # tty1 still holds the boot logo in graphics mode, so text there stays invisible. tty2 is a root shell.
  printf '
The installer screen stopped. The log is /tmp/majaos-installer.log
' > /dev/tty2 2>/dev/null || true
  chvt 2 2>/dev/null || true
  exec sleep infinity
fi
say "Open $url"
exec sleep infinity
