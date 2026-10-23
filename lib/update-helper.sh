#!/bin/bash
# Second half of "Update now" (see lib/updater.js). Runs as its own systemd unit (systemd-run),
# so it keeps running while HomeBaseOS restarts. HomeBaseOS first copies this file to DATA_DIR/update/,
# because bash reads a script while it runs and lib/ gets replaced below.
#
# Arguments: <folder with the new version> <app folder> <status file> <port> <new version> <old version> <folder for the backup copy>
set -u
NEW="$1"; APP="$2"; STATUS="$3"; PORT="$4"; VERSION="$5"; OLD="$6"; BACKUP="$7"
PARTS="server.js package.json lib public deploy"

# Write progress to the status file (JSON). HomeBaseOS reads it and the browser shows it.
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
  if [ -f "$BACKUP/homebaseos.service" ]; then install -m 644 "$BACKUP/homebaseos.service" /etc/systemd/system/homebaseos.service; systemctl daemon-reload; fi
  systemctl restart homebaseos
  st rollback 100 rolledback "Restored version ${OLD}." "$1"
  exit 1
}

healthy() {
  for _ in $(seq 1 45); do
    sleep 1
    if systemctl is-active --quiet homebaseos && curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/config"; then return 0; fi
  done
  return 1
}

# 1. Backup copy of the current version (and the service file).
st backup 60 running "Backing up version ${OLD}…"
rm -rf "$BACKUP"; mkdir -p "$BACKUP"
for p in $PARTS; do [ -e "$APP/$p" ] && cp -a "$APP/$p" "$BACKUP/$p"; done
cp -a /etc/systemd/system/homebaseos.service "$BACKUP/homebaseos.service" 2>/dev/null || true

# 2. New files in place. Settings (/etc/homebaseos, DATA_DIR) stay untouched.
st install 68 running "Installing new files…"
for p in $PARTS; do
  rm -rf "${APP:?}/$p"
  if [ -e "$NEW/$p" ] && ! cp -a "$NEW/$p" "$APP/$p"; then restore "Copying failed."; fi
done
if [ -f "$NEW/deploy/homebaseos.service" ] && ! cmp -s "$NEW/deploy/homebaseos.service" /etc/systemd/system/homebaseos.service; then
  install -m 644 "$NEW/deploy/homebaseos.service" /etc/systemd/system/homebaseos.service
  systemctl daemon-reload
fi

# 3. System packages the new version needs (deploy/upgrade.sh, may run more than once).
if [ -f "$NEW/deploy/upgrade.sh" ]; then
  st packages 75 running "Checking required system packages…"
  if ! bash "$NEW/deploy/upgrade.sh" >>"${STATUS%.json}.log" 2>&1; then restore "The system packages could not be installed."; fi
fi

# 4. Restart and check that the new version responds.
st restart 85 running "Restarting HomeBaseOS…"
systemctl restart homebaseos
st check 92 running "Checking that version ${VERSION} runs properly…"
healthy || restore "Version ${VERSION} did not respond within 45 seconds."

rm -rf "$NEW"
st done 100 done "Updated to version ${VERSION}."
exit 0
