#!/bin/bash
# First boot after an installation from the HomeBaseOS ISO: run install.sh (ZFS, libvirt, Docker, HomeBaseOS).
# If it succeeds, the installation files disappear and the address appears on the server's screen.
# There is no password yet: you create an account in the browser the first time.
# If it fails, everything stays and it tries again at the next boot.
set -uo pipefail
SETUP=/opt/homebaseos-setup
LOG=/var/log/homebaseos-firstboot.log
ISSUE=/etc/issue.d/homebaseos.issue
exec > >(tee -a "$LOG") 2>&1

# Text above the login prompt on the server's screen (\4 = the IPv4 address, filled in by agetty).
issue() { printf '%s\n' "$@" > "$ISSUE"; agetty --reload 2>/dev/null || true; }

echo "== Installing HomeBaseOS: $(date)"

# Wait for internet (max. 10 minutes): install.sh fetches packages.
for _ in $(seq 1 120); do
  getent hosts deb.debian.org >/dev/null && break
  sleep 5
done

ARGS=()
[ -f "$SETUP/.nvidia" ] && ARGS+=(--nvidia)

if bash "$SETUP/install.sh" "${ARGS[@]}"; then
  ENV=/etc/homebaseos/homebaseos.env
  PORT="$(sed -n 's/^PORT=//p' "$ENV" | tail -1)"; PORT="${PORT:-8080}"
  issue "" "  HomeBaseOS is ready. Open in your browser:  http://\\4:${PORT}" \
    "  and create your account there (the welcome wizard helps you along)." ""
  chmod 644 "$ISSUE"
  systemctl disable homebaseos-firstboot.service
  rm -rf "$SETUP"
  echo "== Done: $(date)"
  # The NVIDIA driver only loads after a reboot.
  if [ "${#ARGS[@]}" -gt 0 ]; then echo "Rebooting for the NVIDIA driver…"; systemctl reboot; fi
  exit 0
fi

issue "" "  The installation of HomeBaseOS failed. See /var/log/homebaseos-firstboot.log." \
  "  To try again:  sudo systemctl restart homebaseos-firstboot   (or reboot the server)" ""
echo "== Failed: $(date)"
exit 1
