#!/bin/bash
# Draait bij elke update via Software-update (na het kopiëren van de nieuwe bestanden, vóór de herstart).
# Installeer hier systeempakketten die een nieuwe versie nodig heeft. Moet meerdere keren mogen lopen.
set -eu
export DEBIAN_FRONTEND=noninteractive

NEEDED="curl gnupg smartmontools pciutils usbutils bridge-utils samba systemd-timesyncd rsync rclone"
MISSING=""
for p in $NEEDED; do dpkg -s "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then
  echo "Pakketten installeren:$MISSING"
  apt-get update -q
  # shellcheck disable=SC2086
  apt-get install -y -q $MISSING
fi

# Kopia (back-up-app voor pc's) komt uit een eigen pakketbron. Lukt dat niet, dan gaat de update toch door.
if ! command -v kopia >/dev/null 2>&1; then
  echo "Kopia installeren"
  {
    install -m 0755 -d /etc/apt/keyrings &&
    curl -fsSL https://kopia.io/signing-key | gpg --dearmor --yes -o /etc/apt/keyrings/kopia-keyring.gpg &&
    echo "deb [signed-by=/etc/apt/keyrings/kopia-keyring.gpg] http://packages.kopia.io/apt/ stable main" > /etc/apt/sources.list.d/kopia.list &&
    apt-get update -q && apt-get install -y -q kopia
  } || echo "Kopia installeren lukte niet. Voer later sudo ./install.sh uit om de back-up-app te gebruiken."
fi
