#!/bin/bash
# Second half of "Update now" (see lib/updater.js). Runs as its own systemd unit (systemd-run),
# so it keeps running while MajaOS restarts. MajaOS first copies this file to DATA_DIR/update/,
# because bash reads a script while it runs and lib/ gets replaced below.
#
# Arguments: <folder with the new version> <app folder> <status file> <port> <new version> <old version> <folder for the backup copy>
set -u
NEW="$1"; APP="$2"; STATUS="$3"; PORT="$4"; VERSION="$5"; OLD="$6"; BACKUP="$7"
PARTS="server.js package.json build.json lib public deploy"  # build.json: only for development builds (channel dev)

# Write progress to the status file (JSON). MajaOS reads it and the browser shows it.
st() { # step percent state message [reason]
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
  st rollback 95 running "The new version doesn't start. Restoring the previous version (${OLD})."
  for p in $PARTS; do rm -rf "${APP:?}/$p"; [ -e "$BACKUP/$p" ] && cp -a "$BACKUP/$p" "$APP/$p"; done
  if [ -f "$BACKUP/homebaseos.service" ]; then
    # Coming from HomeBaseOS: back to the old service. The old paths are links to the moved folders (deploy/rename-majaos.sh).
    systemctl disable --now majaos >/dev/null 2>&1 || true
    install -m 644 "$BACKUP/homebaseos.service" /etc/systemd/system/homebaseos.service; systemctl daemon-reload
    systemctl enable homebaseos >/dev/null 2>&1 || true
    systemctl restart homebaseos
  else
    if [ -f "$BACKUP/majaos.service" ]; then install -m 644 "$BACKUP/majaos.service" /etc/systemd/system/majaos.service; systemctl daemon-reload; fi
    systemctl restart majaos
  fi
  st rollback 100 rolledback "Restored version ${OLD}." "$1"
  exit 1
}

healthy() {
  for _ in $(seq 1 45); do
    sleep 1
    if systemctl is-active --quiet majaos && curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/config"; then return 0; fi
  done
  return 1
}

# 1. Backup copy of the current version (and the service file).
st backup 60 running "Backing up version ${OLD}…"
rm -rf "$BACKUP"; mkdir -p "$BACKUP"
for p in $PARTS; do [ -e "$APP/$p" ] && cp -a "$APP/$p" "$BACKUP/$p"; done
cp -a /etc/systemd/system/majaos.service "$BACKUP/majaos.service" 2>/dev/null || true
cp -a /etc/systemd/system/homebaseos.service "$BACKUP/homebaseos.service" 2>/dev/null || true  # before the rename to MajaOS

# 2. System packages the new version needs (deploy/upgrade.sh, may run more than once). This can take minutes; the old
# version keeps running meanwhile, its files are untouched.
if [ -f "$NEW/deploy/upgrade.sh" ]; then
  st packages 65 running "Checking required system packages…"
  if ! bash "$NEW/deploy/upgrade.sh" >>"${STATUS%.json}.log" 2>&1; then restore "The system packages could not be installed."; fi
fi

# 3. Stop MajaOS before its files change: a running server loads some modules only when it needs them, and with lib/
# half replaced it crashed (systemd then started a mix of old and new files). The page shows "restarting" meanwhile.
st install 72 running "Installing new files…"
systemctl stop majaos >/dev/null 2>&1 || true
systemctl stop homebaseos >/dev/null 2>&1 || true  # the old name, if it still runs: it holds the port
for p in $PARTS; do
  rm -rf "${APP:?}/$p"
  if [ -e "$NEW/$p" ] && ! cp -a "$NEW/$p" "$APP/$p"; then restore "Copying failed."; fi
done
# A server from before the rename: folders, units and files get the name MajaOS (once).
if [ -f "$NEW/deploy/rename-majaos.sh" ] && [ -f /etc/systemd/system/homebaseos.service ]; then
  st install 78 running "Renaming HomeBaseOS to MajaOS…"
  bash "$NEW/deploy/rename-majaos.sh" "$NEW" >>"${STATUS%.json}.log" 2>&1 || restore "Renaming to MajaOS failed."
fi
if [ -f "$NEW/deploy/majaos.service" ] && ! cmp -s "$NEW/deploy/majaos.service" /etc/systemd/system/majaos.service; then
  install -m 644 "$NEW/deploy/majaos.service" /etc/systemd/system/majaos.service
  systemctl daemon-reload
fi

# 4. Start and check that the new version responds.
st restart 85 running "Restarting MajaOS…"
systemctl restart majaos
st check 92 running "Checking that version ${VERSION} runs properly…"
healthy || restore "Version ${VERSION} did not respond within 45 seconds."

rm -rf "$NEW"
if [ -f /etc/systemd/system/homebaseos.service ] && systemctl is-active --quiet majaos; then
  rm -f /etc/systemd/system/homebaseos.service; systemctl daemon-reload  # the rename worked: the old unit can go
fi
st done 100 done "Updated to version ${VERSION}."
exit 0
