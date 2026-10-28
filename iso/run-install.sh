#!/bin/bash
# Installs Debian on the disk that the screen already confirmed, while that screen stays up.
# The Debian installer itself is not started: its text would replace the loading screen.
# Usage: run-install.sh <disk> <language> <nvidia 0|1> [keyboard: layout or layout:variant, see lib/keyboard.js]
set -uo pipefail
DISK="${1:-}"
LANG_CODE="${2:-en}"
NVIDIA="${3:-0}"
KEYBOARD="${4:-us}"
ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DIR="${INSTALL_DIR:-/run/majaos-install}"
STATUS="${STATUS:-$DIR/status.json}"
LOG="$DIR/log.txt"
TARGET=/mnt/maja-install
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
  umount "$TARGET/run" 2>/dev/null || true
  umount "$TARGET/boot/efi" 2>/dev/null || true
  umount "$TARGET/dev/pts" 2>/dev/null || true
  umount "$TARGET/dev" 2>/dev/null || true
  umount "$TARGET/proc" 2>/dev/null || true
  umount "$TARGET/sys" 2>/dev/null || true
  umount "$TARGET" 2>/dev/null || true
}
fail() { echo "$1" >> "$LOG"; cleanup; status failed "${2:-0}" "$1"; exit 1; }
# The end of a tool's own log goes into the details on the screen, so a failure says why.
tail_into_log() { [ -f "$1" ] && { echo "--- $(basename "$1") (end) ---"; tail -n 25 "$1"; } >> "$LOG"; }
NOT_PREPARED="The installation could not be prepared. Open Details to see why."

# Internet is needed to download Debian. Cards that appeared after the start (or a cable plugged in later)
# get no address from live-boot: ask for one with dhcpcd ourselves.
# A real connection to the mirror: DNS alone also answers with a wrong gateway.
online() { timeout 6 bash -c ': </dev/tcp/deb.debian.org/80' >/dev/null 2>&1; }
bring_up_network() {
  local dev
  for dev in /sys/class/net/*; do
    dev="$(basename "$dev")"
    case "$dev" in lo|docker*|veth*|virbr*|br-*|wl*) continue ;; esac
    [ -e "/sys/class/net/$dev/device" ] || continue
    ip link set "$dev" up >>"$LOG" 2>&1 || true
    ip -4 addr show dev "$dev" | grep 'inet ' | grep -qv ' 169\.254\.' || timeout 25 dhcpcd -4 --noipv4ll --noarp -w -t 20 "$dev" >>"$LOG" 2>&1 || true
  done
}

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
  if [ -f "$cand/majaos/majaos.tar.gz" ]; then LIVE="$cand"; break; fi
done
[ -n "$LIVE" ] || fail "The Debian installer was not found on this disc." 8
live_src="$(findmnt -n -o SOURCE "$LIVE" 2>/dev/null || true)"
live_base="$(basename "$live_src")"
case "$live_base" in
  nvme*|mmcblk*) live_disk="$(printf '%s' "$live_base" | sed -E 's/p[0-9]*$//')" ;;
  *) live_disk="$(printf '%s' "$live_base" | sed -E 's/[0-9]*$//')" ;;
esac
[ -n "$live_disk" ] && [ "$live_disk" = "$DISK" ] && fail "This disk is the installer. Choose another disk." 8
# live-boot turns on swap partitions it finds: an earlier installation's swap would keep the disk busy.
for p in $(lsblk -nlpo NAME "/dev/$DISK"); do grep -q "^$p " /proc/swaps && swapoff "$p" >>"$LOG" 2>&1; done
if lsblk -n -o MOUNTPOINT "/dev/$DISK" | grep -q '^/'; then fail "This disk is the installer. Choose another disk." 8; fi
command -v debootstrap >/dev/null || fail "$NOT_PREPARED" 8
command -v parted >/dev/null || fail "$NOT_PREPARED" 8

# Before anything is erased: without internet nothing can be installed.
status running 10 "Checking the internet connection"
if ! online; then
  bring_up_network
  for _ in $(seq 1 15); do online && break; sleep 2; done
fi
if ! online; then
  { echo "--- network ---"; ip -br link; ip -br addr; ip route; cat /etc/resolv.conf; } >>"$LOG" 2>&1
  fail "There is no internet connection. Connect the computer to your router with a network cable, then try again. Nothing was erased." 10
fi

status running 18 "Partitioning the disk"
bytes="$(blockdev --getsize64 "/dev/$DISK")" || fail "$NOT_PREPARED" 18
ESP="$(part 1)"
if [ "$bytes" -ge $((12 * 1024 * 1024 * 1024)) ]; then SWAP="$(part 2)"; ROOTP="$(part 3)"; else SWAP=""; ROOTP="$(part 2)"; fi
swapoff "$SWAP" 2>/dev/null || true
wipefs -a "/dev/$DISK" >>"$LOG" 2>&1 || fail "The disk could not be erased because it is in use. Restart from the USB stick and try again." 18
if [ -d /sys/firmware/efi ]; then
  parted -s "/dev/$DISK" mklabel gpt >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 22
  parted -s "/dev/$DISK" mkpart ESP fat32 1MiB 513MiB >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 22
  parted -s "/dev/$DISK" set 1 esp on >>"$LOG" 2>&1 || true
  if [ -n "$SWAP" ]; then
    parted -s "/dev/$DISK" mkpart swap linux-swap 513MiB 2561MiB >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 24
    parted -s "/dev/$DISK" mkpart root ext4 2561MiB 100% >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 24
  else
    parted -s "/dev/$DISK" mkpart root ext4 513MiB 100% >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 24
  fi
else
  SWAP=""; ROOTP="$(part 1)"; ESP=""
  parted -s "/dev/$DISK" mklabel msdos >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 22
  parted -s "/dev/$DISK" mkpart primary ext4 1MiB 100% >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 24
  parted -s "/dev/$DISK" set 1 boot on >>"$LOG" 2>&1 || true
fi
partprobe "/dev/$DISK" >>"$LOG" 2>&1 || true
udevadm settle >>"$LOG" 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -b "$ROOTP" ] && break; sleep 0.3; done
[ -b "$ROOTP" ] || fail "$NOT_PREPARED" 26
if [ -n "$ESP" ]; then mkfs.vfat -F 32 "$ESP" >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 28; fi
if [ -n "$SWAP" ]; then mkswap "$SWAP" >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 28; fi
mkfs.ext4 -F "$ROOTP" >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 28

mkdir -p "$TARGET"
mount "$ROOTP" "$TARGET" || fail "$NOT_PREPARED" 30
if [ -n "$ESP" ]; then mkdir -p "$TARGET/boot/efi"; mount "$ESP" "$TARGET/boot/efi" || fail "$NOT_PREPARED" 30; fi

status running 20 "Installing Debian"
# Also the non-free firmware: network cards such as Realtek 2.5G need it after the first start.
debootstrap --components=main,contrib,non-free,non-free-firmware trixie "$TARGET" http://deb.debian.org/debian >"$DIR/debootstrap.log" 2>&1 &
watch $! 20 40 "Installing Debian" || { tail_into_log "$DIR/debootstrap.log"; fail "Debian could not be downloaded. Check the internet connection and try again." 40; }

mount --bind /dev "$TARGET/dev"
mount --bind /dev/pts "$TARGET/dev/pts"
mount --bind /proc "$TARGET/proc"
mount --bind /sys "$TARGET/sys"
cp /etc/resolv.conf "$TARGET/etc/resolv.conf"
printf 'Europe/Brussels\n' > "$TARGET/etc/timezone"
ln -sf /usr/share/zoneinfo/Europe/Brussels "$TARGET/etc/localtime"
# The keyboard chosen on the first screen (layout or layout:variant); Settings > General changes it later.
printf '%s' "$KEYBOARD" | grep -qxE '[a-z]{2,8}(:[a-z0-9_]{1,16})?' || KEYBOARD=us
printf 'XKBMODEL="pc105"\nXKBLAYOUT="%s"\nXKBVARIANT="%s"\nXKBOPTIONS=""\n' "${KEYBOARD%%:*}" "$( [ "${KEYBOARD#*:}" = "$KEYBOARD" ] || printf '%s' "${KEYBOARD#*:}")" > "$TARGET/etc/default/keyboard"
printf 'majaos\n' > "$TARGET/etc/hostname"
printf '127.0.0.1 localhost\n127.0.1.1 majaos\n' > "$TARGET/etc/hosts"
export DEBIAN_FRONTEND=noninteractive
if [ -n "$ESP" ]; then PKGS="linux-image-amd64 grub-efi-amd64 grub-efi-amd64-bin"; else PKGS="linux-image-amd64 grub-pc"; fi
status running 41 "Installing Debian"
chroot "$TARGET" apt-get update -qq >>"$LOG" 2>&1 || fail "Debian could not be downloaded. Check the internet connection and try again." 41
chroot "$TARGET" apt-get install -y -qq $PKGS sudo curl ca-certificates openssh-server locales keyboard-configuration console-setup systemd-timesyncd \
  ifupdown dhcpcd-base firmware-realtek firmware-misc-nonfree firmware-amd-graphics >"$DIR/apt.log" 2>&1 &
watch $! 41 50 "Installing Debian" || { tail_into_log "$DIR/apt.log"; fail "Debian could not be downloaded. Check the internet connection and try again." 45; }

LOCALE="$(locale_of "$LANG_CODE")"
grep -q "^$LOCALE UTF-8" "$TARGET/etc/locale.gen" || printf '%s UTF-8\n' "$LOCALE" >> "$TARGET/etc/locale.gen"
chroot "$TARGET" locale-gen >>"$LOG" 2>&1 || true
printf 'LANG=%s\n' "$LOCALE" > "$TARGET/etc/default/locale"
chroot "$TARGET" useradd --create-home --shell /bin/bash --comment MajaOS maja >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 50
chroot "$TARGET" passwd -l maja >>"$LOG" 2>&1 || true
chroot "$TARGET" usermod -aG sudo maja >>"$LOG" 2>&1 || true

uuid() { blkid -s UUID -o value "$1"; }
{
  printf 'UUID=%s / ext4 defaults 0 1\n' "$(uuid "$ROOTP")"
  [ -n "$ESP" ] && printf 'UUID=%s /boot/efi vfat umask=0077 0 1\n' "$(uuid "$ESP")"
  [ -n "$SWAP" ] && printf 'UUID=%s none swap sw 0 0\n' "$(uuid "$SWAP")"
} > "$TARGET/etc/fstab"
# The network from the network step, with ifupdown: the file MajaOS changes in Settings > Network.
# DHCP: dhcpcd writes resolv.conf itself. A fixed address: our DNS servers.
if [ -f "$DIR/interfaces" ]; then
  cp "$DIR/interfaces" "$TARGET/etc/network/interfaces"
else
  # No choice was passed on: DHCP on every wired card.
  {
    printf 'source /etc/network/interfaces.d/*\n\nauto lo\niface lo inet loopback\n'
    for dev in /sys/class/net/*; do
      dev="$(basename "$dev")"
      [ -e "/sys/class/net/$dev/device" ] || continue
      case "$dev" in wl*|ww*) continue ;; esac
      printf '\nallow-hotplug %s\niface %s inet dhcp\n' "$dev" "$dev"
    done
  } > "$TARGET/etc/network/interfaces"
fi
# MajaOS sets the host name (Settings > Network): dhcpcd must not replace it with the router's.
echo 'nohook hostname' >> "$TARGET/etc/dhcpcd.conf"
# The MAC address as client ID, like the installer: the router hands out the same address as during the installation,
# and a reservation by MAC address works.
sed -i 's/^duid$/clientid/' "$TARGET/etc/dhcpcd.conf"
grep -q '^clientid$' "$TARGET/etc/dhcpcd.conf" || echo clientid >> "$TARGET/etc/dhcpcd.conf"
rm -f "$TARGET/etc/resolv.conf"
if [ -f "$DIR/resolv.conf" ]; then cp "$DIR/resolv.conf" "$TARGET/etc/resolv.conf"; else cp /etc/resolv.conf "$TARGET/etc/resolv.conf"; fi
mkdir -p "$TARGET/etc/systemd/system/multi-user.target.wants"
ln -sf /usr/lib/systemd/system/systemd-timesyncd.service "$TARGET/etc/systemd/system/multi-user.target.wants/systemd-timesyncd.service"
# No Debian menu at every start: straight on after a second (hold Esc or Shift for it), under the name MajaOS.
printf 'GRUB_DISABLE_OS_PROBER=true\nGRUB_CMDLINE_LINUX_DEFAULT="quiet"\nGRUB_TIMEOUT_STYLE=hidden\nGRUB_TIMEOUT=1\nGRUB_DISTRIBUTOR="MajaOS"\n' >> "$TARGET/etc/default/grub"

status running 52 "Installing the boot loader"
if [ -n "$ESP" ]; then
  chroot "$TARGET" grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=debian --removable >>"$LOG" 2>&1 || fail "The boot loader could not be installed. Open Details to see why." 52
else
  chroot "$TARGET" grub-install --target=i386-pc "/dev/$DISK" >>"$LOG" 2>&1 || fail "The boot loader could not be installed. Open Details to see why." 52
fi
chroot "$TARGET" update-grub >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 54

# MajaOS itself (ZFS, libvirt, Samba, Docker and the web interface) with install.sh in the chroot: after the restart it
# runs right away. install.sh only enables services there; they start at the first boot.
status running 56 "Preparing MajaOS"
mkdir -p "$TARGET/opt/majaos-setup"
tar -xzf "${MAJAOS_TAR:-$LIVE/majaos/majaos.tar.gz}" -C "$TARGET/opt/majaos-setup" >>"$LOG" 2>&1 || fail "$NOT_PREPARED" 56
[ "$NVIDIA" = 1 ] && touch "$TARGET/opt/majaos-setup/.nvidia"
if printf '%s' "$LANG_CODE" | grep -qxE '[a-z][a-z]*'; then
  mkdir -p "$TARGET/var/lib/majaos"
  printf '{"language":"%s"}\n' "$LANG_CODE" > "$TARGET/var/lib/majaos/settings.json"
  chmod 600 "$TARGET/var/lib/majaos/settings.json"
fi

# The bar follows the steps of install.sh ("==> ZFS" and so on): each step has its own message and part of the bar.
watch_majaos() {
  local pid="$1"
  local pct=58 lo=58 hi=62 msg="Installing MajaOS" last
  while kill -0 "$pid" 2>/dev/null; do
    last="$(grep -a '==> ' "$DIR/majaos.log" 2>/dev/null | tail -1 | sed 's/\x1b\[[0-9;]*m//g; s/^.*==> //')"
    case "$last" in
      "Turning on"*|"Base packages"*) lo=58; hi=64; msg="Installing MajaOS" ;;
      ZFS*) lo=64; hi=80; msg="Installing ZFS (this takes a few minutes)" ;;
      "Virtual machines"*) lo=80; hi=84; msg="Installing virtual machines" ;;
      "Shared folders"*) lo=84; hi=86; msg="Installing shared folders" ;;
      SSH*|"Backup app"*|"Remote access"*) lo=86; hi=89; msg="Installing backups and remote access" ;;
      Docker*) lo=89; hi=93; msg="Installing Docker" ;;
      NVIDIA*) lo=93; hi=96; msg="Installing the NVIDIA driver" ;;
      "Automatic security"*|"Installing MajaOS"*|Done*) lo=96; hi=98; msg="Finishing MajaOS" ;;
    esac
    [ "$pct" -lt "$lo" ] && pct="$lo"
    [ "$pct" -lt "$hi" ] && pct=$((pct + 1))
    status running "$pct" "$msg"
    sleep 4
  done
  wait "$pid"
}

# /run as an empty tmpfs: package scripts need /run/lock, and without /run/systemd/system nothing starts in the chroot.
mount -t tmpfs tmpfs "$TARGET/run" && mkdir -p "$TARGET/run/lock"
MAJAOS_ARGS=(); [ "$NVIDIA" = 1 ] && MAJAOS_ARGS+=(--nvidia)
status running 58 "Installing MajaOS"
chroot "$TARGET" env MAJAOS_CHROOT=1 bash /opt/majaos-setup/install.sh "${MAJAOS_ARGS[@]}" >"$DIR/majaos.log" 2>&1 &
mkdir -p "$TARGET/etc/issue.d"
if watch_majaos $!; then
  # Done: no first boot needed.
  # The logo and the address on the server's screen (lib/issue.js; MajaOS rewrites it at every start).
  chroot "$TARGET" node /opt/majaos/lib/issue.js >>"$LOG" 2>&1 || true
  rm -rf "$TARGET/opt/majaos-setup"
  cleanup
  status done 100 "MajaOS is installed. After the restart the address appears on the screen."
else
  # Not finished (often the network): Debian is there, so the first boot runs install.sh again, like before.
  tail_into_log "$DIR/majaos.log"
  echo "MajaOS could not be installed yet; it is installed at the first boot." >> "$LOG"
  cp "$LIVE/majaos/majaos-firstboot.service" "$TARGET/etc/systemd/system/majaos-firstboot.service"
  ln -sf /etc/systemd/system/majaos-firstboot.service "$TARGET/etc/systemd/system/multi-user.target.wants/majaos-firstboot.service"
  cp "$LIVE/majaos/installing.issue" "$TARGET/etc/issue.d/majaos.issue"
  cleanup
  status done 100 "Debian is installed. MajaOS finishes installing after the restart (5 to 15 minutes)."
fi
