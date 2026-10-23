#!/bin/bash
# Runs on every update through Software update (after copying the new files, before the restart).
# Install system packages a new version needs here. Must be safe to run more than once.
set -eu
export DEBIAN_FRONTEND=noninteractive

NEEDED="curl gnupg smartmontools pciutils usbutils bridge-utils samba systemd-timesyncd rsync rclone"
MISSING=""
for p in $NEEDED; do dpkg -s "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then
  echo "Installing packages:$MISSING"
  apt-get update -q
  # shellcheck disable=SC2086
  apt-get install -y -q $MISSING
fi

# Kopia (the backup app for PCs) comes from its own package source. If that fails, the update carries on anyway.
if ! command -v kopia >/dev/null 2>&1; then
  echo "Installing Kopia"
  {
    install -m 0755 -d /etc/apt/keyrings &&
    curl -fsSL https://kopia.io/signing-key | gpg --dearmor --yes -o /etc/apt/keyrings/kopia-keyring.gpg &&
    echo "deb [signed-by=/etc/apt/keyrings/kopia-keyring.gpg] http://packages.kopia.io/apt/ stable main" > /etc/apt/sources.list.d/kopia.list &&
    apt-get update -q && apt-get install -y -q kopia
  } || echo "Installing Kopia failed. Run sudo ./install.sh later to use the backup app."
fi
