#!/usr/bin/env bash
# Installeert HomeBaseOS op een kale Debian 13 (trixie): ZFS, KVM/libvirt, Docker en de webinterface.
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
APP=/opt/homebaseos
ETC=/etc/homebaseos
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
apt-get install -y ca-certificates curl gnupg nodejs smartmontools pciutils usbutils bridge-utils rsync rclone
# Klok gelijk houden: de codes van tweestapsverificatie hangen af van de tijd.
apt-get install -y systemd-timesyncd || true
timedatectl set-ntp true || true

step "ZFS"
apt-get install -y "linux-headers-$(uname -r)" linux-headers-amd64
apt-get install -y zfs-dkms zfsutils-linux
modprobe zfs

step "Virtuele machines (KVM/QEMU en libvirt)"
apt-get install -y qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst ovmf swtpm swtpm-tools
systemctl enable --now libvirtd
virsh -c qemu:///system net-autostart default >/dev/null 2>&1 || true
virsh -c qemu:///system net-start default >/dev/null 2>&1 || true

step "Gedeelde mappen (Samba)"
apt-get install -y samba wsdd || apt-get install -y samba
# Eigen [global]: gewone gebruikers met wachtwoord, gasten alleen waar een map dat toelaat, en goed samenwerken met macOS.
if ! grep -q "HomeBaseOS" /etc/samba/smb.conf 2>/dev/null; then
  [ -f /etc/samba/smb.conf ] && cp /etc/samba/smb.conf /etc/samba/smb.conf.voor-homebaseos
  cat > /etc/samba/smb.conf <<'SMB'
# Samba voor HomeBaseOS. De gedeelde mappen zelf staan in homebaseos.conf (beheer ze in Instellingen → Gedeelde mappen).
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

# Gedeelde mappen van HomeBaseOS
include = /etc/samba/homebaseos.conf
SMB
  touch /etc/samba/homebaseos.conf
fi
systemctl enable --now smbd
systemctl enable --now wsdd 2>/dev/null || true

step "Back-up-app voor je pc's (Kopia, officiële pakketbron)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://kopia.io/signing-key | gpg --dearmor --yes -o /etc/apt/keyrings/kopia-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/kopia-keyring.gpg] http://packages.kopia.io/apt/ stable main" > /etc/apt/sources.list.d/kopia.list
apt-get update
apt-get install -y kopia

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

step "HomeBaseOS installeren in $APP"
mkdir -p "$APP" "$ETC" /opt/stacks
rm -rf "$APP/lib" "$APP/public" "$APP/deploy"
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/lib" "$SRC/public" "$SRC/deploy" "$APP/"
# Geen wachtwoord: bij de eerste keer in de browser maak je zelf een account aan (de welkomstwizard).
NEW_INSTALL=0
if [ ! -f "$ETC/homebaseos.env" ]; then
  NEW_INSTALL=1
  SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  sed -e "s#^SESSION_SECRET=.*#SESSION_SECRET=$SECRET#" "$SRC/deploy/homebaseos.env" > "$ETC/homebaseos.env"
  chmod 600 "$ETC/homebaseos.env"
fi
install -m 644 "$SRC/deploy/homebaseos.service" /etc/systemd/system/homebaseos.service
systemctl daemon-reload
systemctl enable homebaseos >/dev/null
systemctl restart homebaseos

IP="$(hostname -I | awk '{print $1}')"
step "Klaar"
echo "Open http://$IP:8080"
if [ "$NEW_INSTALL" = 1 ]; then
  echo "Open dat adres in je browser: de welkomstwizard maakt je account aan en helpt je met de naam, de tijdzone en je opslag."
  echo "Een pool aanmaken kan daar ook; HomeBaseOS maakt er meteen de mappen appdata, media, backups, vms en isos op."
fi
echo
echo "Wil je VM's rechtstreeks in je thuisnetwerk? Maak een bridge br0 (Instellingen → Netwerk) en zet VM_NETWORK=bridge=br0 in $ETC/homebaseos.env"
[ "$NVIDIA" = 1 ] && echo "Herstart de server, zodat de NVIDIA-driver laadt."
exit 0
