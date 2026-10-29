#!/usr/bin/env bash
# Installs MajaOS on a bare Debian 13 (trixie): ZFS, KVM/libvirt, Docker and the web interface.
# Usage:  sudo ./install.sh            (running it again = updating; your settings stay)
#         sudo ./install.sh --nvidia   (also the NVIDIA driver and GPU support for Docker)
# The ISO installer runs it in a chroot on the new disk with MAJAOS_CHROOT=1: services are only enabled (they start at
# the first boot), and kernel modules are built for the kernel on that disk instead of the running one.
set -euo pipefail

NVIDIA=0
for arg in "$@"; do
  case "$arg" in
    --nvidia) NVIDIA=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (use --help)"; exit 1 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "Run this script with sudo: sudo ./install.sh"; exit 1; }
. /etc/os-release
[ "${VERSION_CODENAME:-}" = trixie ] || { echo "This script is made for Debian 13 (trixie). Found: ${PRETTY_NAME:-unknown}."; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/majaos
ETC=/etc/majaos
# A server from before the rename: move its folders and units to MajaOS first (deploy/rename-majaos.sh).
[ -f "$SRC/deploy/rename-majaos.sh" ] && bash "$SRC/deploy/rename-majaos.sh" "$SRC"
export DEBIAN_FRONTEND=noninteractive
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

CHROOT="${MAJAOS_CHROOT:-0}"
# The kernel modules (ZFS, NVIDIA) are built for: the running kernel, or in the chroot the newest one on the new disk.
if [ "$CHROOT" = 1 ]; then KVER="$(ls /lib/modules | sort -V | tail -1)"; else KVER="$(uname -r)"; fi
# In the chroot nothing can start: only enable, the first boot starts it.
enable_now() { if [ "$CHROOT" = 1 ]; then systemctl enable "$@"; else systemctl enable --now "$@"; fi; }
disable_now() { if [ "$CHROOT" = 1 ]; then systemctl disable "$@"; else systemctl disable --now "$@"; fi; }
restart() { [ "$CHROOT" = 1 ] || systemctl restart "$@"; }

step "Turning on the contrib and non-free package sources (needed for ZFS and NVIDIA)"
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
  sed -i -E '/^Components:/{/ contrib( |$)/!s/$/ contrib/;/ non-free( |$)/!s/$/ non-free/}' /etc/apt/sources.list.d/debian.sources
fi
if [ -f /etc/apt/sources.list ]; then
  sed -i -E '/^deb(-src)? /{/ contrib( |$)/!s/$/ contrib/;/ non-free( |$)/!s/$/ non-free/}' /etc/apt/sources.list
fi
apt-get update

step "Base packages"
apt-get install -y ca-certificates openssl curl gnupg nodejs smartmontools pciutils usbutils eject bridge-utils rsync rclone
# <name>.local in the browser (macOS, Linux, and Windows 10+ also ask mDNS); also on the server's screen.
apt-get install -y avahi-daemon || true
# Keep the clock right: the codes of two-step verification depend on the time.
apt-get install -y systemd-timesyncd || true
if [ "$CHROOT" = 1 ]; then systemctl enable systemd-timesyncd || true; else timedatectl set-ntp true || true; fi

step "ZFS"
apt-get install -y "linux-headers-$KVER" linux-headers-amd64
apt-get install -y zfs-dkms zfsutils-linux
if [ "$CHROOT" = 1 ]; then
  # zfs-dkms builds for the running kernel (the installer's); make sure it is there for the new disk's kernel.
  dkms autoinstall -k "$KVER"
  modinfo -k "$KVER" zfs >/dev/null || { echo "The ZFS module was not built for kernel $KVER."; exit 1; }
else
  modprobe zfs
fi

step "Pools with mixed disks (mergerfs and SnapRAID)"
# Disks of different sizes together, with one or two parity disks (Storage → Create pool → Mixed disks).
apt-get install -y mergerfs snapraid

step "Virtual machines (KVM/QEMU and libvirt)"
apt-get install -y qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst ovmf swtpm swtpm-tools
enable_now libvirtd
if [ "$CHROOT" = 1 ]; then
  # What net-autostart does, without a running libvirtd: the default network starts with libvirtd at the first boot.
  [ -f /etc/libvirt/qemu/networks/default.xml ] && mkdir -p /etc/libvirt/qemu/networks/autostart \
    && ln -sf /etc/libvirt/qemu/networks/default.xml /etc/libvirt/qemu/networks/autostart/default.xml
else
  virsh -c qemu:///system net-autostart default >/dev/null 2>&1 || true
  virsh -c qemu:///system net-start default >/dev/null 2>&1 || true
fi

step "Shared folders (Samba)"
apt-get install -y samba wsdd || apt-get install -y samba
# Own [global]: plain users with a password, guests only where a folder allows it, and working well with macOS.
if ! grep -q "MajaOS" /etc/samba/smb.conf 2>/dev/null; then
  [ -f /etc/samba/smb.conf ] && cp /etc/samba/smb.conf /etc/samba/smb.conf.before-majaos
  cat > /etc/samba/smb.conf <<'SMB'
# Samba for MajaOS. The shared folders themselves are in majaos.conf (manage them in Settings → Shared folders).
[global]
   workgroup = WORKGROUP
   server string = %h
   server role = standalone server
   security = user
   map to guest = Bad User
   server min protocol = SMB2_10
   fruit:aapl = yes
   fruit:metadata = stream
   fruit:model = MacSamba
   logging = systemd
   load printers = no
   printing = bsd
   disable spoolss = yes

# Shared folders of MajaOS
include = /etc/samba/majaos.conf
SMB
  touch /etc/samba/majaos.conf
fi
enable_now smbd
enable_now wsdd 2>/dev/null || true

step "SSH (off until you turn it on in Settings → Security)"
apt-get install -y openssh-server
# The package turns SSH on. MajaOS keeps it off unless Settings saved "ssh": true.
if ! grep -q '"ssh": true' /var/lib/majaos/settings.json 2>/dev/null; then
  disable_now ssh || true
fi

step "Backup app for your PCs (Kopia, official package source)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://kopia.io/signing-key | gpg --dearmor --yes -o /etc/apt/keyrings/kopia-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/kopia-keyring.gpg] http://packages.kopia.io/apt/ stable main" > /etc/apt/sources.list.d/kopia.list
apt-get update
apt-get install -y kopia

step "Remote access without port forwarding (cloudflared)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /etc/apt/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/etc/apt/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y cloudflared

step "Docker (official package source)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
enable_now docker

if [ "$NVIDIA" = 1 ]; then
  step "NVIDIA driver and GPU support for Docker"
  apt-get install -y nvidia-driver firmware-misc-nonfree
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /etc/apt/keyrings/nvidia-container-toolkit.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/etc/apt/keyrings/nvidia-container-toolkit.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update
  apt-get install -y nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker
  [ "$CHROOT" = 1 ] && dkms autoinstall -k "$KVER"
  restart docker
fi

step "Automatic security updates (unattended-upgrades, no automatic reboot)"
# Only the first time: whoever turned it off in Settings > Software update keeps it off.
if [ ! -f /etc/apt/apt.conf.d/52majaos ]; then
  bash "$SRC/lib/apt-helper.sh" auto-on "$(mktemp)" /dev/stdout /etc/apt/apt.conf.d/20auto-upgrades || echo "Turning on automatic updates failed; do it later in Settings > Software update."
fi

step "Installing MajaOS in $APP"
mkdir -p "$APP" "$ETC" /opt/stacks
rm -rf "$APP/lib" "$APP/public" "$APP/deploy"
rm -f "$APP/build.json"   # marker of a development build; deploy/install-branch.sh writes it again after this script
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/lib" "$SRC/public" "$SRC/deploy" "$APP/"
# No password: you create an account yourself in the browser the first time (the welcome wizard).
NEW_INSTALL=0
if [ ! -f "$ETC/majaos.env" ]; then
  NEW_INSTALL=1
  SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  sed -e "s#^SESSION_SECRET=.*#SESSION_SECRET=$SECRET#" "$SRC/deploy/majaos.env" > "$ETC/majaos.env"
  chmod 600 "$ETC/majaos.env"
fi
install -m 644 "$SRC/deploy/majaos.service" /etc/systemd/system/majaos.service
[ "$CHROOT" = 1 ] || systemctl daemon-reload
systemctl enable majaos >/dev/null
if [ -f /etc/systemd/system/homebaseos.service ]; then  # the old name (before MajaOS) holds the port
  systemctl disable --now homebaseos >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/homebaseos.service; systemctl daemon-reload
fi
restart majaos
# In the chroot: the installer shows the address itself.
[ "$CHROOT" = 1 ] && { step "Done (MajaOS starts at the first boot)"; exit 0; }

IP="$(hostname -I | awk '{print $1}')"
PORT="$(sed -n 's/^PORT=//p' "$ETC/majaos.env" | tail -1)"
PORT="${PORT:-80}"
step "Done"
if [ "$PORT" = 80 ]; then echo "Open http://$IP"; else echo "Open http://$IP:$PORT"; fi
echo "It switches to https with the server's own certificate: the browser warns about it the first time. Settings > Security explains how to trust it."
if [ "$NEW_INSTALL" = 1 ]; then
  echo "Open that address in your browser: the welcome wizard creates your account and helps you with the name, the time zone and your storage."
  echo "You can also create a pool there; MajaOS right away creates the folders appdata, media, backups, vms and isos on it."
fi
echo
echo "Want VMs directly in your home network? Create a bridge br0 (Settings → Network) and set VM_NETWORK=bridge=br0 in $ETC/majaos.env"
[ "$NVIDIA" = 1 ] && echo "Reboot the server, so the NVIDIA driver loads."
exit 0
