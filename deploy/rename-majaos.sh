#!/bin/bash
# One-time move of a server from HomeBaseOS to MajaOS (the same program, renamed). Safe to run again.
# Called by lib/update-helper.sh (before the restart) and by install.sh.
#   rename-majaos.sh <folder with the new version>
# Folders move and keep a symbolic link under the old name, so whatever still uses an old path keeps working
# (the running old version, the update in progress, a rollback). systemd units get the new name.
# Docker containers keep their homebaseos.* labels and the network "homebase": MajaOS reads those too.
set -u
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
say() { echo "rename-majaos: $*"; }

move() { # <old> <new>
  local old="$1" new="$2"
  if [ -e "$old" ] && [ ! -L "$old" ] && [ ! -e "$new" ]; then
    mv "$old" "$new" && ln -s "$new" "$old" && say "${old} → ${new}"
  fi
}

move /opt/homebaseos /opt/majaos
move /etc/homebaseos /etc/majaos
move /var/lib/homebaseos /var/lib/majaos
move /run/homebaseos /run/majaos   # the marker "VMs already started" must survive, or VMs start again
if [ -f /etc/majaos/homebaseos.env ] && [ ! -L /etc/majaos/homebaseos.env ] && [ ! -e /etc/majaos/majaos.env ]; then
  mv /etc/majaos/homebaseos.env /etc/majaos/majaos.env && ln -s majaos.env /etc/majaos/homebaseos.env
  sed -i 's/systemctl restart homebaseos/systemctl restart majaos/; s/HomeBaseOS/MajaOS/g' /etc/majaos/majaos.env
  say "settings file → /etc/majaos/majaos.env"
fi

# The service itself. The old unit stays (disabled) until the new one runs: lib/update-helper.sh removes it,
# or puts it back on a rollback.
if [ -f /etc/systemd/system/homebaseos.service ] && [ -f "$SRC/deploy/majaos.service" ]; then
  install -m 644 "$SRC/deploy/majaos.service" /etc/systemd/system/majaos.service
  systemctl daemon-reload
  systemctl disable homebaseos.service >/dev/null 2>&1 || true
  systemctl enable majaos.service >/dev/null 2>&1 || true
  say "service homebaseos → majaos"
fi

# Units MajaOS makes itself: the backup app server and remote access. Same content, new name.
for unit in kopia tunnel; do
  old="/etc/systemd/system/homebaseos-${unit}.service" new="/etc/systemd/system/majaos-${unit}.service"
  [ -f "$old" ] && [ ! -e "$new" ] || continue
  sed 's/homebaseos/majaos/g; s/HomeBaseOS/MajaOS/g' "$old" > "$new"
  on=0; systemctl is-enabled --quiet "homebaseos-${unit}" && on=1
  systemctl disable --now "homebaseos-${unit}" >/dev/null 2>&1 || true
  rm -f "$old"
  systemctl daemon-reload
  [ "$on" = 1 ] && systemctl enable --now "majaos-${unit}" >/dev/null 2>&1
  say "homebaseos-${unit} → majaos-${unit}"
done

# Shared folders (Samba): the include file and its line in smb.conf.
if [ -f /etc/samba/homebaseos.conf ] && [ ! -e /etc/samba/majaos.conf ]; then
  mv /etc/samba/homebaseos.conf /etc/samba/majaos.conf
  [ -f /etc/samba/smb.conf ] && sed -i 's#/etc/samba/homebaseos\.conf#/etc/samba/majaos.conf#' /etc/samba/smb.conf
  command -v smbcontrol >/dev/null && smbcontrol smbd reload-config >/dev/null 2>&1
  say "Samba → /etc/samba/majaos.conf"
fi

# Automatic Debian updates and needrestart (see lib/apt-helper.sh). Turned off stays off: only move what is there.
if [ -f /etc/apt/apt.conf.d/52homebaseos ] && [ ! -e /etc/apt/apt.conf.d/52majaos ]; then
  sed 's/HomeBaseOS/MajaOS/g; s/homebaseos/majaos/g' /etc/apt/apt.conf.d/52homebaseos > /etc/apt/apt.conf.d/52majaos && rm -f /etc/apt/apt.conf.d/52homebaseos
fi
if [ -f /etc/needrestart/conf.d/homebaseos.conf ] && [ ! -e /etc/needrestart/conf.d/majaos.conf ]; then
  sed 's/HomeBaseOS/MajaOS/g; s/homebaseos/majaos/g' /etc/needrestart/conf.d/homebaseos.conf > /etc/needrestart/conf.d/majaos.conf && rm -f /etc/needrestart/conf.d/homebaseos.conf
fi

# The address on the server's screen.
if [ -f /etc/issue.d/homebaseos.issue ] && [ ! -e /etc/issue.d/majaos.issue ]; then
  sed 's/HomeBaseOS/MajaOS/g; s/homebaseos/majaos/g' /etc/issue.d/homebaseos.issue > /etc/issue.d/majaos.issue && rm -f /etc/issue.d/homebaseos.issue
fi
exit 0
