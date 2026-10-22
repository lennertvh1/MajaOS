#!/usr/bin/env bash
# Installeert Thuisbasis op een kale Debian 13 (trixie): ZFS, KVM/libvirt, Docker en de webinterface.
# Gebruik:  sudo ./install.sh            (opnieuw uitvoeren = bijwerken; je instellingen blijven staan)
#           sudo ./install.sh --nvidia   (ook de NVIDIA-driver en GPU-ondersteuning voor Docker)
set -euo pipefail

NVIDIA=0
for arg in "$@"; do
  case "$arg" in
    --nvidia) NVIDIA=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "Onbekende optie: $arg (gebruik --help)"; exit 1 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "Start dit script met sudo: sudo ./install.sh"; exit 1; }
. /etc/os-release
[ "${VERSION_CODENAME:-}" = trixie ] || { echo "Dit script is gemaakt voor Debian 13 (trixie). Gevonden: ${PRETTY_NAME:-onbekend}."; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/thuisbasis
ETC=/etc/thuisbasis
export DEBIAN_FRONTEND=noninteractive
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Pakketbronnen contrib en non-free aanzetten (nodig voor ZFS en NVIDIA)"
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
  sed -i -E '/^Components:/{/ contrib( |$)/!s/$/ contrib/;/ non-free( |$)/!s/$/ non-free/}' /etc/apt/sources.list.d/debian.sources
fi
if [ -f /etc/apt/sources.list ]; then
  sed -i -E '/^deb(-src)? /{/ contrib( |$)/!s/$/ contrib/;/ non-free( |$)/!s/$/ non-free/}' /etc/apt/sources.list
fi
apt-get update

step "Basispakketten"
apt-get install -y ca-certificates curl gnupg nodejs smartmontools pciutils usbutils bridge-utils

step "ZFS"
apt-get install -y "linux-headers-$(uname -r)" linux-headers-amd64
apt-get install -y zfs-dkms zfsutils-linux
modprobe zfs

step "Virtuele machines (KVM/QEMU en libvirt)"
apt-get install -y qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst ovmf swtpm swtpm-tools
systemctl enable --now libvirtd
virsh -c qemu:///system net-autostart default >/dev/null 2>&1 || true
virsh -c qemu:///system net-start default >/dev/null 2>&1 || true

step "Docker (officiële pakketbron)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker

if [ "$NVIDIA" = 1 ]; then
  step "NVIDIA-driver en GPU-ondersteuning voor Docker"
  apt-get install -y nvidia-driver firmware-misc-nonfree
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /etc/apt/keyrings/nvidia-container-toolkit.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/etc/apt/keyrings/nvidia-container-toolkit.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update
  apt-get install -y nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker
fi

step "Thuisbasis installeren in $APP"
mkdir -p "$APP" "$ETC" /opt/stacks
rm -rf "$APP/lib" "$APP/public"
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/lib" "$SRC/public" "$APP/"
NEW_PASSWORD=""
if [ ! -f "$ETC/thuisbasis.env" ]; then
  NEW_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))")"
  SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  sed -e "s#^APP_PASSWORD=.*#APP_PASSWORD=$NEW_PASSWORD#" -e "s#^SESSION_SECRET=.*#SESSION_SECRET=$SECRET#" \
    "$SRC/deploy/thuisbasis.env" > "$ETC/thuisbasis.env"
  chmod 600 "$ETC/thuisbasis.env"
fi
install -m 644 "$SRC/deploy/thuisbasis.service" /etc/systemd/system/thuisbasis.service
systemctl daemon-reload
systemctl enable thuisbasis >/dev/null
systemctl restart thuisbasis

IP="$(hostname -I | awk '{print $1}')"
step "Klaar"
echo "Open http://$IP:8080"
if [ -n "$NEW_PASSWORD" ]; then
  echo "Je wachtwoord: $NEW_PASSWORD  (staat ook in $ETC/thuisbasis.env)"
fi
echo
echo "Volgende stappen (zie README):"
echo "  1. Maak een ZFS-pool, bv.: zpool create -o ashift=12 tank raidz1 /dev/disk/by-id/..."
echo "  2. Maak de datasets voor VM's en ISO's: zfs create tank/vms && zfs create tank/isos"
echo "     en voor de appstore: zfs create snel/appdata (of pas APPDATA_DIR aan in $ETC/thuisbasis.env)"
echo "  3. Wil je VM's rechtstreeks in je thuisnetwerk? Maak een bridge br0 en zet VM_NETWORK=bridge=br0 in $ETC/thuisbasis.env"
[ "$NVIDIA" = 1 ] && echo "  4. Herstart de server, zodat de NVIDIA-driver laadt."
exit 0
