#!/bin/bash
# The Debian live system of the installer: the installer screen, and (with majaos.tar.gz) MajaOS itself, fully installed.
# The installer then copies this system to the disk (iso/run-install.sh): no internet and no compiling on the server.
# MajaOS's services are enabled but don't run on the stick (ConditionKernelCommandLine=!boot=live, removed on the disk).
# Needs root, debootstrap and squashfs-tools. build-iso.sh calls this with --live.
#   ./iso/build-live.sh /path/to/output [majaos.tar.gz]
set -euo pipefail
OUT="${1:-}"
TAR="${2:-}"
[ -n "$OUT" ] || { echo "Usage: build-live.sh <output folder> [majaos.tar.gz]"; exit 1; }
[ -z "$TAR" ] || [ -f "$TAR" ] || { echo "Not found: $TAR"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "build-live.sh needs root (debootstrap)."; exit 1; }
command -v debootstrap >/dev/null || { echo "Missing: debootstrap"; exit 1; }
command -v mksquashfs >/dev/null || { echo "Missing: mksquashfs (squashfs-tools)"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/iso"
R="$(mktemp -d)"
trap 'umount "$R/run" "$R/dev" "$R/proc" "$R/sys" 2>/dev/null || true; rm -rf "$R"' EXIT
mkdir -p "$OUT"

echo "==> debootstrap Debian 13 (trixie), amd64"
debootstrap --arch=amd64 trixie "$R" http://deb.debian.org/debian
# debootstrap copies the name of the build machine; the live system gets its own.
echo majaos-installer > "$R/etc/hostname"
printf '127.0.0.1\tlocalhost\n127.0.1.1\tmajaos-installer\n' > "$R/etc/hosts"
printf 'deb http://deb.debian.org/debian trixie main contrib non-free non-free-firmware\ndeb http://deb.debian.org/debian-security trixie-security main contrib non-free non-free-firmware\n' > "$R/etc/apt/sources.list"
mount --bind /proc "$R/proc"
mount --bind /sys "$R/sys"
mount --bind /dev "$R/dev"
chroot "$R" apt-get update -q
printf 'APT::Sandbox "0";\n' > "$R/etc/apt/apt.conf.d/99majaos-build"
DEBIAN_FRONTEND=noninteractive chroot "$R" apt-get install -y -q \
  linux-image-amd64 live-boot live-boot-initramfs-tools systemd dbus libpam-systemd nodejs \
  cog cage libgl1-mesa-dri libegl1 adwaita-icon-theme fonts-dejavu-core fonts-noto-cjk \
  plymouth plymouth-themes plymouth-label \
  debootstrap parted dosfstools openssl cpio gzip zstd \
  ifupdown dhcpcd-base firmware-realtek firmware-misc-nonfree firmware-bnx2 firmware-bnx2x firmware-amd-graphics \
  locales keyboard-configuration console-setup sudo curl ca-certificates systemd-timesyncd rsync \
  grub-efi-amd64-bin grub-pc-bin grub2-common efibootmgr
# gzip, not zstd: the installer's GRUB must be able to load this initrd. Trixie defaults to zstd; replace, don't append a second COMPRESS line.
CONF="$R/etc/initramfs-tools/initramfs.conf"
if grep -q '^COMPRESS=' "$CONF"; then sed -i 's/^COMPRESS=.*/COMPRESS=gzip/' "$CONF"; else echo 'COMPRESS=gzip' >> "$CONF"; fi
if grep -q '^MODULES=' "$CONF"; then sed -i 's/^MODULES=.*/MODULES=most/' "$CONF"; else echo 'MODULES=most' >> "$CONF"; fi
printf 'iso9660\nsquashfs\noverlay\nloop\nsr_mod\nusb-storage\nuas\n' >> "$R/etc/initramfs-tools/modules"

echo "==> installer files"
APP="$R/opt/majaos-installer"
mkdir -p "$APP/iso" "$APP/lib" "$APP/public/lang"
cp "$HERE/serve.js" "$HERE/kiosk.sh" "$HERE/run-install.sh" "$HERE/preseed.cfg" "$APP/iso/"
cp "$ROOT/lib/installer.js" "$ROOT/lib/system.js" "$ROOT/lib/keyboard.js" "$APP/lib/"
cp "$ROOT/public/install.html" "$ROOT/public/favicon.svg" "$ROOT/public/install.js" "$ROOT/public/install.css" "$ROOT/public/style.css" "$APP/public/"
cp "$ROOT/public/lang/"*.js "$APP/public/lang/"
chmod 755 "$APP/iso/kiosk.sh" "$APP/iso/run-install.sh"

# dhcpcd must not rename the computer to what the router hands out (option host_name, hook 30-hostname).
# Faster when a cable goes in: no random wait before it starts (nodelay), no 5 s check whether the address is
# free (noarp), and no 169.254.x.x address while it waits for the router (noipv4ll).
printf 'nohook hostname\nnodelay\nnoarp\nnoipv4ll\n' >> "$R/etc/dhcpcd.conf"
# Ask with the MAC address as client ID, like Windows and most devices, instead of a DUID that is new at every start
# of the stick: some routers (mesh systems) ignored the first requests and answered only after a minute.
sed -i 's/^duid$/clientid/' "$R/etc/dhcpcd.conf"
grep -q '^clientid$' "$R/etc/dhcpcd.conf" || echo clientid >> "$R/etc/dhcpcd.conf"

# Logo on a quiet boot. Plymouth keeps it until Cog is ready to draw. A login prompt would wipe it.
THEME="$R/usr/share/plymouth/themes/majaos"
mkdir -p "$THEME" "$R/etc/plymouth"
cp "$HERE/plymouth/majaos.plymouth" "$HERE/plymouth/majaos.script" "$HERE/plymouth/logo.png" "$HERE/plymouth/bar.png" "$THEME/"
printf '[Daemon]\nTheme=majaos\nShowDelay=0\n' > "$R/etc/plymouth/plymouthd.conf"
chroot "$R" plymouth-set-default-theme majaos || ln -sf majaos/majaos.plymouth "$R/usr/share/plymouth/themes/default.plymouth"
chroot "$R" systemctl mask plymouth-quit.service plymouth-quit-wait.service || true
chroot "$R" systemctl mask getty@tty1.service || true
# Ctrl+Alt+F2 opens a root shell, to read /tmp/majaos-installer.log when the screen misbehaves.
mkdir -p "$R/etc/systemd/system/getty@tty2.service.d"
printf '[Service]\nExecStart=\nExecStart=-/sbin/agetty --autologin root --noclear %%I $TERM\n' > "$R/etc/systemd/system/getty@tty2.service.d/autologin.conf"
# The same on the serial port, for when the screen takes no keys at all: on Unraid or libvirt, virsh console <vm>.
mkdir -p "$R/etc/systemd/system/serial-getty@ttyS0.service.d" "$R/etc/systemd/system/getty.target.wants"
printf '[Service]\nExecStart=\nExecStart=-/sbin/agetty --autologin root --keep-baud 115200,57600,38400,9600 %%I $TERM\n' > "$R/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf"
ln -sf /lib/systemd/system/serial-getty@.service "$R/etc/systemd/system/getty.target.wants/serial-getty@ttyS0.service"

cat > "$R/etc/systemd/system/majaos-kiosk.service" <<'EOF'
[Unit]
Description=MajaOS installer
After=systemd-logind.service plymouth-start.service
Wants=systemd-logind.service
[Service]
ExecStart=/opt/majaos-installer/iso/kiosk.sh
Type=simple
# A logind session on tty1: without it cage gets the screen but no mouse or keyboard.
# No TTYReset or TTYVHangup: those clear the boot logo.
User=root
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
UtmpIdentifier=tty1
StandardOutput=journal
StandardError=journal
Environment=XDG_RUNTIME_DIR=/run/user/0
Environment=WLR_NO_HARDWARE_CURSORS=1
Environment=XCURSOR_THEME=Adwaita
Environment=XCURSOR_SIZE=24
[Install]
WantedBy=multi-user.target
EOF
mkdir -p "$R/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/majaos-kiosk.service "$R/etc/systemd/system/multi-user.target.wants/majaos-kiosk.service"

if [ -n "$TAR" ]; then
  echo "==> MajaOS itself: install.sh in the live system (ZFS, libvirt, Samba, Docker, the web interface)"
  # What install.sh enables (services, sockets, timers): compared before and after.
  enabled() { find "$R/etc/systemd/system" -path '*.wants/*' -printf '%f\n' | sort -u; }
  BEFORE="$(enabled)"
  mkdir -p "$R/opt/majaos-setup"
  tar -xzf "$TAR" -C "$R/opt/majaos-setup"
  # /run as an empty tmpfs: package scripts need /run/lock, and without /run/systemd/system nothing starts here.
  mount -t tmpfs tmpfs "$R/run" && mkdir -p "$R/run/lock"
  chroot "$R" env MAJAOS_CHROOT=1 bash /opt/majaos-setup/install.sh
  umount "$R/run"
  # On the stick they stay off (they'd only use memory and time); run-install.sh removes this on the disk.
  comm -13 <(printf '%s\n' "$BEFORE") <(enabled) | while read -r unit; do
    [ -n "$unit" ] || continue
    mkdir -p "$R/etc/systemd/system/$unit.d"
    printf '[Unit]\nConditionKernelCommandLine=!boot=live\n' > "$R/etc/systemd/system/$unit.d/majaos-live.conf"
  done
  # The boot loader of the disk: both packages ready, the installer picks the one for UEFI or BIOS (they conflict).
  mkdir -p "$R/var/cache/majaos/grub"
  chroot "$R" sh -c 'cd /var/cache/majaos/grub && apt-get download grub-efi-amd64 grub-pc'
  # /opt/majaos-setup stays: the NVIDIA driver (online) and the first-boot fallback use install.sh from there.
fi
# Smaller: no downloaded packages and no package lists (the server fetches fresh ones).
chroot "$R" apt-get clean
rm -rf "$R"/var/lib/apt/lists/*

echo "==> initramfs and squashfs"
VMLINUZ="$(ls "$R"/boot/vmlinuz-* | head -1)"
KVER="$(basename "$VMLINUZ" | sed 's/^vmlinuz-//')"
INITRD="$R/boot/initrd.img-${KVER}"
if ! chroot "$R" update-initramfs -c -k "$KVER"; then
  echo "update-initramfs failed."
  exit 1
fi
[ -s "$INITRD" ] || { echo "The initrd was not created."; exit 1; }
chroot "$R" test -f /usr/share/initramfs-tools/scripts/live || { echo "live-boot is not installed in the chroot."; exit 1; }
if ! chroot "$R" lsinitramfs "/boot/initrd.img-${KVER}" 2>/dev/null | grep -q 'scripts/live'; then
  echo "Note: lsinitramfs could not list the initrd (often a gzip/zstd mismatch in the reader, not a failed build)."
fi
cp "$VMLINUZ" "$OUT/vmlinuz"
cp "$INITRD" "$OUT/initrd.img"
# Chromium otherwise rebuilds the font list on first start. The CJK fonts make that slow.
chroot "$R" fc-cache -fr >/dev/null 2>&1 || true
umount "$R/dev" "$R/proc" "$R/sys"
# mktemp -d made the root folder 0700: as / that stops every service that doesn't run as root (dbus, timesyncd).
chmod 755 "$R"
# zstd unpacks much faster than xz. On a VM the CPU is the limit, not the size.
# The kernel stays in /boot (the disk boots it); the live initrd doesn't (the disk gets its own, without live-boot).
mksquashfs "$R" "$OUT/filesystem.squashfs" -comp zstd -Xcompression-level 15 -wildcards -e 'boot/initrd.img*' -noappend
echo "==> live system in $OUT"
