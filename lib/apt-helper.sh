#!/bin/bash
# Runs apt for Settings > Software update > Debian, as its own systemd unit (systemd-run): needrestart may restart
# MajaOS while apt runs, and that must not stop apt. MajaOS copies this file to DATA_DIR/debian/ first.
#
# Arguments: <action: check|upgrade|auto-on|auto-off> <status file> <log file> <20auto-upgrades file>
set -u
ACTION="$1"; STATUS="$2"; LOG="$3"; AUTO="$4"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a LC_ALL=C
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

# Write the state to the status file (JSON); MajaOS reads it and the browser shows it.
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
  cat > /etc/apt/apt.conf.d/52majaos <<'CONF'
// Written by MajaOS (Settings > Software update). Security updates and Debian point releases are installed automatically.
// Never an automatic reboot: a new kernel needs the ZFS module built first. MajaOS shows when a restart is needed.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
  mkdir -p /etc/needrestart/conf.d
  cat > /etc/needrestart/conf.d/majaos.conf <<'CONF'
# Written by MajaOS: restart services with old libraries automatically, but never Docker (that would stop all apps).
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
  nvidia)
    # The NVIDIA driver (built with DKMS for every kernel, like ZFS) and GPU support for Docker, as install.sh --nvidia.
    say "Fetching the package lists…"
    step apt-get update -q || { st failed "Fetching the package lists failed. See the log." 1; exit 1; }
    say "Installing the kernel headers…"
    step apt-get install "${APT_OPTS[@]}" "linux-headers-$(uname -r)" linux-headers-amd64 || { st failed "The kernel headers could not be installed. See the log." 1; exit 1; }
    say "Installing the NVIDIA driver (this takes a few minutes)…"
    step apt-get install "${APT_OPTS[@]}" nvidia-driver firmware-misc-nonfree || { st failed "The NVIDIA driver could not be installed. Check that the contrib and non-free package sources are on. See the log." 1; exit 1; }
    # Keeps the driver loaded between uses: nvidia-smi then answers right away (the dashboard asks every 10 s).
    step apt-get install "${APT_OPTS[@]}" nvidia-persistenced && step systemctl enable --now nvidia-persistenced
    say "Installing GPU support for Docker…"
    install -m 0755 -d /etc/apt/keyrings
    { curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /etc/apt/keyrings/nvidia-container-toolkit.gpg &&
      curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
        | sed 's#deb https://#deb [signed-by=/etc/apt/keyrings/nvidia-container-toolkit.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list; } >> "$LOG" 2>&1 \
      || { st failed "NVIDIA's package source could not be reached. See the log." 1; exit 1; }
    step apt-get update -q
    step apt-get install "${APT_OPTS[@]}" nvidia-container-toolkit || { st failed "GPU support for Docker could not be installed. See the log." 1; exit 1; }
    step nvidia-ctk runtime configure --runtime=docker
    say "Restarting Docker (the apps are back in a moment)…"
    step systemctl restart docker
    # The driver loads at the next start: Software update shows that a restart is needed.
    touch /var/run/reboot-required; echo nvidia-driver >> /var/run/reboot-required.pkgs
    st done "Installed. Restart the server to load the driver." 0
    exit 0
    ;;
  *) st failed "Unknown action: ${ACTION}" 1; exit 1 ;;
esac
st done "Done." 0
exit 0
