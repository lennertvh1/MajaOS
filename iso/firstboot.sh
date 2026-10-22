#!/bin/bash
# Eerste opstart na een installatie vanaf de HomeBaseOS-ISO: install.sh draaien (ZFS, libvirt, Docker, HomeBaseOS).
# Lukt het, dan verdwijnen de installatiebestanden en komt het adres + wachtwoord op het scherm van de server.
# Lukt het niet, dan blijft alles staan en probeert het bij de volgende opstart opnieuw.
set -uo pipefail
SETUP=/opt/homebaseos-setup
LOG=/var/log/homebaseos-firstboot.log
ISSUE=/etc/issue.d/homebaseos.issue
PWISSUE=/etc/issue.d/homebaseos-wachtwoord.issue   # verdwijnt zodra je een eigen wachtwoord kiest
exec > >(tee -a "$LOG") 2>&1

# Tekst boven de aanmeldregel op het scherm van de server (\4 = het IPv4-adres, ingevuld door agetty).
issue() { printf '%s\n' "$@" > "$ISSUE"; agetty --reload 2>/dev/null || true; }

echo "== HomeBaseOS installeren: $(date)"

# Wachten op internet (max. 10 minuten): install.sh haalt pakketten op.
for _ in $(seq 1 120); do
  getent hosts deb.debian.org >/dev/null && break
  sleep 5
done

ARGS=()
[ -f "$SETUP/.nvidia" ] && ARGS+=(--nvidia)

if bash "$SETUP/install.sh" "${ARGS[@]}"; then
  ENV=/etc/homebaseos/homebaseos.env
  PORT="$(sed -n 's/^PORT=//p' "$ENV" | tail -1)"; PORT="${PORT:-8080}"
  PW="$(sed -n 's/^APP_PASSWORD=//p' "$ENV" | tail -1)"
  issue "" "  HomeBaseOS is klaar. Open in je browser:  http://\\4:${PORT}" ""
  printf '%s\n' "  Wachtwoord voor de eerste aanmelding: ${PW}" "  (de welkomstwizard helpt je daarna een eigen wachtwoord te kiezen)" "" > "$PWISSUE"
  chmod 644 "$ISSUE" "$PWISSUE"
  agetty --reload 2>/dev/null || true
  systemctl disable homebaseos-firstboot.service
  rm -rf "$SETUP"
  echo "== Klaar: $(date)"
  # De NVIDIA-driver laadt pas na een herstart.
  if [ "${#ARGS[@]}" -gt 0 ]; then echo "Herstarten voor de NVIDIA-driver…"; systemctl reboot; fi
  exit 0
fi

issue "" "  De installatie van HomeBaseOS is mislukt. Bekijk /var/log/homebaseos-firstboot.log." \
  "  Opnieuw proberen:  sudo systemctl restart homebaseos-firstboot   (of herstart de server)" ""
echo "== Mislukt: $(date)"
exit 1
