#!/bin/bash
# Draait bij elke update via Software-update (na het kopiëren van de nieuwe bestanden, vóór de herstart).
# Installeer hier systeempakketten die een nieuwe versie nodig heeft. Moet meerdere keren mogen lopen.
set -eu
export DEBIAN_FRONTEND=noninteractive

NEEDED="curl smartmontools pciutils usbutils bridge-utils samba systemd-timesyncd"
MISSING=""
for p in $NEEDED; do dpkg -s "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then
  echo "Pakketten installeren:$MISSING"
  apt-get update -q
  # shellcheck disable=SC2086
  apt-get install -y -q $MISSING
fi
