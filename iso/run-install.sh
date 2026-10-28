#!/bin/bash
# Installs Debian on the disk that the screen already confirmed, while that screen stays up.
# The Debian installer itself is not started: its text would replace the loading screen.
# Usage: run-install.sh <disk> <language> <nvidia 0|1>
set -uo pipefail
DISK="${1:-}"
LANG_CODE="${2:-en}"
NVIDIA="${3:-0}"
ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DIR="${INSTALL_DIR:-/run/homebaseos-install}"
STATUS="${STATUS:-$DIR/status.json}"
LOG="$DIR/log.txt"
TARGET=/mnt/homebase-install
mkdir -p "$DIR"
: > "$LOG"

status() {
  STATUS_STATE="$1" STATUS_PCT="$2" STATUS_MSG="$3" STATUS_FILE="$STATUS" LOG_FILE="$LOG" node <<'JS'
const fs = require('fs');
const log = fs.existsSync(process.env.LOG_FILE) ? fs.readFileSync(process.env.LOG_FILE, 'utf8') : '';
fs.writeFileSync(process.env.STATUS_FILE, JSON.stringify({
  state: process.env.STATUS_STATE, percent: Number(process.env.STATUS_PCT), message: process.env.STATUS_MSG, log,
}));
JS
}

cleanup() {
  umount "$TARGET/boot/efi" 2>/dev/null || true
  umount "$TARGET/dev/pts" 2>/dev/null || true
  umount "$TARGET/dev" 2>/dev/null || true
  umount "$TARGET/proc" 2>/dev/null || true
  umount "$TARGET/sys" 2>/dev/null || true
  umount "$TARGET" 2>/dev/null || true
}
fail() { echo "$1" >> "$LOG"; cleanup; status failed "${2:-0}" "$1"; exit 1; }

# Keep the bar moving while a long command runs. Its own output stays out of the loading screen.
watch() {
  # Two lines: local expands all its words first, so pct="$from" on the same line hits set -u and ends the script.
  local pid="$1" from="$2" to="$3" msg="$4"
  local pct="$from"
  while kill -0 "$pid" 2>/dev/null; do
    [ "$pct" -lt "$to" ] && pct=$((pct + 1))
    status running "$pct" "$msg"
    sleep 2
  done
  wait "$pid" || return 1
}

part() {
  case "$DISK" in
    nvme*|mmcblk*|md*|loop*) printf '/dev/%sp%s' "$DISK" "$1" ;;
    *) printf '/dev/%s%s' "$DISK" "$1" ;;
  esac
}

locale_of() {
  case "$1" in
    nl) echo nl_BE.UTF-8 ;;
    fr) echo fr_FR.UTF-8 ;;
    de) echo de_DE.UTF-8 ;;
    es) echo es_ES.UTF-8 ;;
    pt) echo pt_PT.UTF-8 ;;
    it) echo it_IT.UTF-8 ;;
    pl) echo pl_PL.UTF-8 ;;
    zh) echo zh_CN.UTF-8 ;;
    ja) echo ja_JP.UTF-8 ;;
    *) echo en_US.UTF-8 ;;
  esac
}

printf '%s' "$DISK" | grep -qxE '[a-z][a-z0-9]{0,31}' || fail "Choose a disk." 5
[ -b "/dev/$DISK" ] || fail "Choose a disk." 5

status running 8 "Preparing the installation"
LIVE=""
for cand in /run/live/medium /lib/live/mount/medium /cdrom; do
  if [ -f "$cand/homebaseos/homebaseos.tar.gz" ]; then LIVE="$cand"; break; fi
done
[ -n "$LIVE" ] || fail "The Debian installer was not found on this disc." 8
live_src="$(findmnt -n -o SOURCE "$LIVE" 2>/dev/null || true)"
live_base="$(basename "$live_src")"
case "$live_base" in
  nvme*|mmcblk*) live_disk="$(printf '%s' "$live_base" | sed -E 's/p[0-9]*$//')" ;;
  *) live_disk="$(printf '%s' "$live_base" | sed -E 's/[0-9]*$//')" ;;
esac
[ -n "$live_disk" ] && [ "$live_disk" = "$DISK" ] && fail "This disk is the installer. Choose another disk." 8
if lsblk -n -o MOUNTPOINT "/dev/$DISK" | grep -q '[^[:space:]]'; then fail "This disk is the installer. Choose another disk." 8; fi
command -v debootstrap >/dev/null || fail "The installation could not be prepared." 8
command -v parted >/dev/null || fail "The installation could not be prepared." 8

status running 18 "Partitioning the disk"
bytes="$(blockdev --getsize64 "/dev/$DISK")" || fail "The installation could not be prepared." 18
ESP="$(part 1)"
if [ "$bytes" -ge $((12 * 1024 * 1024 * 1024)) ]; then SWAP="$(part 2)"; ROOTP="$(part 3)"; else SWAP=""; ROOTP="$(part 2)"; fi
swapoff "$SWAP" 2>/dev/null || true
wipefs -a "/dev/$DISK" >>"$LOG" 2>&1 || fail "The installation could not be prepared." 18
if [ -d /sys/firmware/efi ]; then
  parted -s "/dev/$DISK" mklabel gpt >>"$LOG" 2>&1 || fail "The installation could not be prepared." 22
  parted -s "/dev/$DISK" mkpart ESP fat32 1MiB 513MiB >>"$LOG" 2>&1 || fail "The installation could not be prepared." 22
  parted -s "/dev/$DISK" set 1 esp on >>"$LOG" 2>&1 || true
  if [ -n "$SWAP" ]; then
    parted -s "/dev/$DISK" mkpart swap linux-swap 513MiB 2561MiB >>"$LOG" 2>&1 || fail "The installation could not be prepared." 24
    parted -s "/dev/$DISK" mkpart root ext4 2561MiB 100% >>"$LOG" 2>&1 || fail "The installation could not be prepared." 24
  else
    parted -s "/dev/$DISK" mkpart root ext4 513MiB 100% >>"$LOG" 2>&1 || fail "The installation could not be prepared." 24
  fi
else
  SWAP=""; ROOTP="$(part 1)"; ESP=""
  parted -s "/dev/$DISK" mklabel msdos >>"$LOG" 2>&1 || fail "The installation could not be prepared." 22
  parted -s "/dev/$DISK" mkpart primary ext4 1MiB 100% >>"$LOG" 2>&1 || fail "The installation could not be prepared." 24
  parted -s "/dev/$DISK" set 1 boot on >>"$LOG" 2>&1 || true
fi
partprobe "/dev/$DISK" >>"$LOG" 2>&1 || true
udevadm settle >>"$LOG" 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -b "$ROOTP" ] && break; sleep 0.3; done
[ -b "$ROOTP" ] || fail "The installation could not be prepared." 26
if [ -n "$ESP" ]; then mkfs.vfat -F 32 "$ESP" >>"$LOG" 2>&1 || fail "The installation could not be prepared." 28; fi
if [ -n "$SWAP" ]; then mkswap "$SWAP" >>"$LOG" 2>&1 || fail "The installation could not be prepared." 28; fi
mkfs.ext4 -F "$ROOTP" >>"$LOG" 2>&1 || fail "The installation could not be prepared." 28

mkdir -p "$TARGET"
mount "$ROOTP" "$TARGET" || fail "The installation could not be prepared." 30
if [ -n "$ESP" ]; then mkdir -p "$TARGET/boot/efi"; mount "$ESP" "$TARGET/boot/efi" || fail "The installation could not be prepared." 30; fi

status running 32 "Installing Debian"
debootstrap trixie "$TARGET" http://deb.debian.org/debian >"$DIR/debootstrap.log" 2>&1 &
watch $! 32 64 "Installing Debian" || fail "The installation could not be prepared." 40

mount --bind /dev "$TARGET/dev"
mount --bind /dev/pts "$TARGET/dev/pts"
mount --bind /proc "$TARGET/proc"
mount --bind /sys "$TARGET/sys"
cp /etc/resolv.conf "$TARGET/etc/resolv.conf"
printf 'Europe/Brussels\n' > "$TARGET/etc/timezone"
ln -sf /usr/share/zoneinfo/Europe/Brussels "$TARGET/etc/localtime"
printf 'XKBMODEL="pc105"\nXKBLAYOUT="be"\nXKBVARIANT=""\nXKBOPTIONS=""\n' > "$TARGET/etc/default/keyboard"
printf 'homebaseos\n' > "$TARGET/etc/hostname"
printf '127.0.0.1 localhost\n127.0.1.1 homebaseos\n' > "$TARGET/etc/hosts"
export DEBIAN_FRONTEND=noninteractive
if [ -n "$ESP" ]; then PKGS="linux-image-amd64 grub-efi-amd64 grub-efi-amd64-bin"; else PKGS="linux-image-amd64 grub-pc"; fi
status running 66 "Installing Debian"
chroot "$TARGET" apt-get update -qq >>"$LOG" 2>&1 || fail "The installation could not be prepared." 66
chroot "$TARGET" apt-get install -y -qq $PKGS sudo curl ca-certificates openssh-server locales keyboard-configuration console-setup systemd-timesyncd >"$DIR/apt.log" 2>&1 &
watch $! 66 80 "Installing Debian" || fail "The installation could not be prepared." 70

LOCALE="$(locale_of "$LANG_CODE")"
grep -q "^$LOCALE UTF-8" "$TARGET/etc/locale.gen" || printf '%s UTF-8\n' "$LOCALE" >> "$TARGET/etc/locale.gen"
chroot "$TARGET" locale-gen >>"$LOG" 2>&1 || true
printf 'LANG=%s\n' "$LOCALE" > "$TARGET/etc/default/locale"
chroot "$TARGET" useradd --create-home --shell /bin/bash --comment HomeBaseOS homebase >>"$LOG" 2>&1 || fail "The installation could not be prepared." 82
chroot "$TARGET" passwd -l homebase >>"$LOG" 2>&1 || true
chroot "$TARGET" usermod -aG sudo homebase >>"$LOG" 2>&1 || true

uuid() { blkid -s UUID -o value "$1"; }
{
  printf 'UUID=%s / ext4 defaults 0 1\n' "$(uuid "$ROOTP")"
  [ -n "$ESP" ] && printf 'UUID=%s /boot/efi vfat umask=0077 0 1\n' "$(uuid "$ESP")"
  [ -n "$SWAP" ] && printf 'UUID=%s none swap sw 0 0\n' "$(uuid "$SWAP")"
} > "$TARGET/etc/fstab"
mkdir -p "$TARGET/etc/systemd/network"
cat > "$TARGET/etc/systemd/network/20-dhcp.network" <<'EOF'
[Match]
Name=e*

[Network]
DHCP=yes
EOF
for unit in systemd-networkd.service systemd-resolved.service systemd-timesyncd.service; do
  mkdir -p "$TARGET/etc/systemd/system/multi-user.target.wants"
  ln -sf "/usr/lib/systemd/system/$unit" "$TARGET/etc/systemd/system/multi-user.target.wants/$unit"
done
ln -sf /run/systemd/resolve/stub-resolv.conf "$TARGET/etc/resolv.conf"
# No Debian menu at every start: straight on after a second (hold Esc or Shift for it), under the name HomeBaseOS.
printf 'GRUB_DISABLE_OS_PROBER=true\nGRUB_CMDLINE_LINUX_DEFAULT="quiet"\nGRUB_TIMEOUT_STYLE=hidden\nGRUB_TIMEOUT=1\nGRUB_DISTRIBUTOR="HomeBaseOS"\n' >> "$TARGET/etc/default/grub"

status running 84 "Installing the boot loader"
if [ -n "$ESP" ]; then
  chroot "$TARGET" grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=debian --removable >>"$LOG" 2>&1 || fail "The installation could not be prepared." 84
else
  chroot "$TARGET" grub-install --target=i386-pc "/dev/$DISK" >>"$LOG" 2>&1 || fail "The installation could not be prepared." 84
fi
chroot "$TARGET" update-grub >>"$LOG" 2>&1 || fail "The installation could not be prepared." 88

status running 92 "Preparing HomeBaseOS"
mkdir -p "$TARGET/opt/homebaseos-setup"
tar -xzf "$LIVE/homebaseos/homebaseos.tar.gz" -C "$TARGET/opt/homebaseos-setup" >>"$LOG" 2>&1 || fail "The installation could not be prepared." 92
[ "$NVIDIA" = 1 ] && touch "$TARGET/opt/homebaseos-setup/.nvidia"
if printf '%s' "$LANG_CODE" | grep -qxE '[a-z][a-z]*'; then
  mkdir -p "$TARGET/var/lib/homebaseos"
  printf '{"language":"%s"}\n' "$LANG_CODE" > "$TARGET/var/lib/homebaseos/settings.json"
  chmod 600 "$TARGET/var/lib/homebaseos/settings.json"
fi
cp "$LIVE/homebaseos/homebaseos-firstboot.service" "$TARGET/etc/systemd/system/homebaseos-firstboot.service"
ln -sf /etc/systemd/system/homebaseos-firstboot.service "$TARGET/etc/systemd/system/multi-user.target.wants/homebaseos-firstboot.service"
mkdir -p "$TARGET/etc/issue.d"
cp "$LIVE/homebaseos/installing.issue" "$TARGET/etc/issue.d/homebaseos.issue"
cleanup
status done 100 "The installation continues on its own. You don't have to do anything."
