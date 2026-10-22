#!/bin/bash
# Tweede helft van "Nu bijwerken" (zie lib/updater.js). Draait als eigen systemd-eenheid (systemd-run),
# zodat het blijft lopen terwijl HomeBaseOS herstart. HomeBaseOS kopieert dit bestand eerst naar DATA_DIR/update/,
# want bash leest een script terwijl het loopt en lib/ wordt hieronder vervangen.
#
# Argumenten: <map met de nieuwe versie> <map van de app> <statusbestand> <poort> <nieuwe versie> <oude versie> <map voor de reservekopie>
set -u
NEW="$1"; APP="$2"; STATUS="$3"; PORT="$4"; VERSION="$5"; OLD="$6"; BACKUP="$7"
PARTS="server.js package.json lib public deploy"

# Voortgang in het statusbestand (JSON) zetten. HomeBaseOS leest het en de browser toont het.
st() { # stap procent toestand melding [reden]
  node -e '
    const fs = require("fs"); const [f, step, pct, state, msg, reason] = process.argv.slice(1);
    let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    const now = new Date().toISOString();
    Object.assign(s, { step, percent: Number(pct), state, message: msg, updated: now });
    if (reason) s.reason = reason;
    if (state !== "running") s.finished = now;
    (s.log = s.log || []).push(msg);
    fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2)); fs.renameSync(f + ".tmp", f);
  ' "$STATUS" "$1" "$2" "$3" "$4" "${5:-}"
}

restore() {
  st rollback 95 running "De nieuwe versie start niet. De vorige versie (${OLD}) wordt teruggezet."
  for p in $PARTS; do rm -rf "${APP:?}/$p"; [ -e "$BACKUP/$p" ] && cp -a "$BACKUP/$p" "$APP/$p"; done
  if [ -f "$BACKUP/homebaseos.service" ]; then install -m 644 "$BACKUP/homebaseos.service" /etc/systemd/system/homebaseos.service; systemctl daemon-reload; fi
  systemctl restart homebaseos
  st rollback 100 rolledback "Teruggezet naar versie ${OLD}." "$1"
  exit 1
}

healthy() {
  for _ in $(seq 1 45); do
    sleep 1
    if systemctl is-active --quiet homebaseos && curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/config"; then return 0; fi
  done
  return 1
}

# 1. Reservekopie van de huidige versie (en het service-bestand).
st backup 60 running "Reservekopie maken van versie ${OLD}…"
rm -rf "$BACKUP"; mkdir -p "$BACKUP"
for p in $PARTS; do [ -e "$APP/$p" ] && cp -a "$APP/$p" "$BACKUP/$p"; done
cp -a /etc/systemd/system/homebaseos.service "$BACKUP/homebaseos.service" 2>/dev/null || true

# 2. Nieuwe bestanden op hun plaats. Instellingen (/etc/homebaseos, DATA_DIR) blijven onaangeroerd.
st install 68 running "Nieuwe bestanden installeren…"
for p in $PARTS; do
  rm -rf "${APP:?}/$p"
  if [ -e "$NEW/$p" ] && ! cp -a "$NEW/$p" "$APP/$p"; then restore "Kopiëren lukte niet."; fi
done
if [ -f "$NEW/deploy/homebaseos.service" ] && ! cmp -s "$NEW/deploy/homebaseos.service" /etc/systemd/system/homebaseos.service; then
  install -m 644 "$NEW/deploy/homebaseos.service" /etc/systemd/system/homebaseos.service
  systemctl daemon-reload
fi

# 3. Systeempakketten die de nieuwe versie nodig heeft (deploy/upgrade.sh, mag meerdere keren lopen).
if [ -f "$NEW/deploy/upgrade.sh" ]; then
  st packages 75 running "Benodigde systeempakketten controleren…"
  if ! bash "$NEW/deploy/upgrade.sh" >>"${STATUS%.json}.log" 2>&1; then restore "De systeempakketten konden niet geïnstalleerd worden."; fi
fi

# 4. Herstarten en controleren of de nieuwe versie antwoordt.
st restart 85 running "HomeBaseOS herstarten…"
systemctl restart homebaseos
st check 92 running "Controleren of versie ${VERSION} goed draait…"
healthy || restore "Versie ${VERSION} antwoordde niet binnen 45 seconden."

rm -rf "$NEW"
st done 100 done "Bijgewerkt naar versie ${VERSION}."
exit 0
