#!/bin/bash
# Runs apt for Settings > Software update > Debian, as its own systemd unit (systemd-run): needrestart may restart
# HomeBaseOS while apt runs, and that must not stop apt. HomeBaseOS copies this file to DATA_DIR/debian/ first.
#
# Arguments: <action: check|upgrade|auto-on|auto-off> <status file> <log file> <20auto-upgrades file>
set -u
ACTION="$1"; STATUS="$2"; LOG="$3"; AUTO="$4"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a LC_ALL=C
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# Write the state to the status file (JSON); HomeBaseOS reads it and the browser shows it.
st() { # state message [code]
  node -e '
    const fs = require("fs"); const [f, state, msg, code] = process.argv.slice(1);
    let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    const now = new Date().toISOString();
    Object.assign(s, { state, message: msg, updated: now });
    if (code) s.code = Number(code);
    if (state !== "running") s.finished = now;
    fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2)); fs.renameSync(f + ".tmp", f);
  ' "$STATUS" "$1" "$2" "${3:-}"
}
say() { echo "== $*" >> "$LOG"; st running "$*"; }
step() { "$@" >> "$LOG" 2>&1; }

# Automatic security updates: unattended-upgrades and needrestart, no automatic reboot, Docker never restarted by needrestart.
configure() {
  cat > /etc/apt/apt.conf.d/52homebaseos <<'CONF'
// Written by HomeBaseOS (Settings > Software update). Security updates and Debian point releases are installed automatically.
// Never an automatic reboot: a new kernel needs the ZFS module built first. HomeBaseOS shows when a restart is needed.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
  mkdir -p /etc/needrestart/conf.d
  cat > /etc/needrestart/conf.d/homebaseos.conf <<'CONF'
# Written by HomeBaseOS: restart services with old libraries automatically, but never Docker (that would stop all apps).
$nrconf{restart} = 'a';
$nrconf{override_rc}{qr(^docker)} = 0;
$nrconf{override_rc}{qr(^containerd)} = 0;
CONF
}

case "$ACTION" in
  check)
    say "Fetching the package lists…"
    step apt-get update -q || { st failed "Fetching the package lists failed. See the log." 1; exit 1; }
    ;;
  upgrade)
    say "Fetching the package lists…"
    step apt-get update -q || { st failed "Fetching the package lists failed. See the log." 1; exit 1; }
    say "Installing the updates…"
    step apt-get full-upgrade "${APT_OPTS[@]}" || { st failed "apt could not install all updates. See the log." 1; exit 1; }
    say "Cleaning up…"
    step apt-get autoremove "${APT_OPTS[@]}"
    ;;
  auto-on)
    say "Installing unattended-upgrades and needrestart…"
    step apt-get update -q
    step apt-get install "${APT_OPTS[@]}" unattended-upgrades needrestart || { st failed "unattended-upgrades could not be installed. See the log." 1; exit 1; }
    configure
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > "$AUTO"
    ;;
  auto-off)
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "0";\n' > "$AUTO"
    ;;
  *) st failed "Unknown action: ${ACTION}" 1; exit 1 ;;
esac
st done "Done." 0
exit 0
