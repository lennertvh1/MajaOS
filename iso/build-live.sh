#!/bin/bash
# A small Debian live system whose only job is the HomeBaseOS installer screen.
# Needs root, debootstrap and squashfs-tools. build-iso.sh calls this with --live.
#   ./iso/build-live.sh /path/to/output
set -euo pipefail
OUT="${1:-}"
[ -n "$OUT" ] || { echo "Usage: build-live.sh <output folder>"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "build-live.sh needs root (debootstrap)."; exit 1; }
command -v debootstrap >/dev/null || { echo "Missing: debootstrap"; exit 1; }
command -v mksquashfs >/dev/null || { echo "Missing: mksquashfs (squashfs-tools)"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/iso"
R="$(mktemp -d)"
trap 'umount "$R/dev" "$R/proc" "$R/sys" 2>/dev/null || true; rm -rf "$R"' EXIT
mkdir -p "$OUT"

echo "==> debootstrap Debian 13 (trixie)"
debootstrap trixie "$R" http://deb.debian.org/debian
printf 'deb http://deb.debian.org/debian trixie main\ndeb http://deb.debian.org/debian-security trixie-security main\n' > "$R/etc/apt/sources.list"
mount --bind /proc "$R/proc"
mount --bind /sys "$R/sys"
mount --bind /dev "$R/dev"
chroot "$R" apt-get update -q
DEBIAN_FRONTEND=noninteractive chroot "$R" apt-get install -y -q \
  linux-image-amd64 live-boot live-boot-initramfs-tools systemd dbus nodejs \
  chromium cage libgl1-mesa-dri fonts-dejavu-core fonts-noto-cjk kexec-tools openssl cpio gzip
# gzip, not zstd: the installer's GRUB must be able to load this initrd. CD and USB modules stay in even though this build machine has neither.
printf '\nMODULES=most\nCOMPRESS=gzip\n' >> "$R/etc/initramfs-tools/initramfs.conf"
printf 'iso9660\nsquashfs\noverlay\nloop\nsr_mod\nusb-storage\nuas\n' >> "$R/etc/initramfs-tools/modules"

echo "==> installer files"
APP="$R/opt/homebaseos-installer"
mkdir -p "$APP/iso" "$APP/lib" "$APP/public/lang"
cp "$HERE/serve.js" "$HERE/kiosk.sh" "$HERE/run-install.sh" "$HERE/preseed.cfg" "$APP/iso/"
cp "$ROOT/lib/installer.js" "$ROOT/lib/system.js" "$APP/lib/"
cp "$ROOT/public/install.html" "$ROOT/public/install.js" "$ROOT/public/install.css" "$ROOT/public/style.css" "$APP/public/"
cp "$ROOT/public/lang/"*.js "$APP/public/lang/"
chmod 755 "$APP/iso/kiosk.sh" "$APP/iso/run-install.sh"

cat > "$R/etc/systemd/system/homebaseos-kiosk.service" <<'EOF'
[Unit]
Description=HomeBaseOS installer
After=systemd-logind.service systemd-user-sessions.service getty@tty1.service
Wants=systemd-logind.service
Conflicts=getty@tty1.service
[Service]
ExecStart=/opt/homebaseos-installer/iso/kiosk.sh
Type=idle
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
StandardInput=tty
StandardOutput=tty
StandardError=tty
PAMName=login
UtmpIdentifier=tty1
Environment=XDG_RUNTIME_DIR=/run/user/0
Environment=WLR_RENDERER=pixman
[Install]
WantedBy=multi-user.target
EOF
mkdir -p "$R/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/homebaseos-kiosk.service "$R/etc/systemd/system/multi-user.target.wants/homebaseos-kiosk.service"

echo "==> initramfs and squashfs"
chroot "$R" update-initramfs -u
VMLINUZ="$(ls "$R"/boot/vmlinuz-* | head -1)"
INITRD="$(ls "$R"/boot/initrd.img-* | head -1)"
chroot "$R" lsinitramfs "/boot/$(basename "$INITRD")" | grep -q 'scripts/live' || { echo "The live initramfs has no live-boot scripts."; exit 1; }
cp "$VMLINUZ" "$OUT/vmlinuz"
cp "$INITRD" "$OUT/initrd.img"
umount "$R/dev" "$R/proc" "$R/sys"
mksquashfs "$R" "$OUT/filesystem.squashfs" -comp xz -e boot -noappend
echo "==> live system in $OUT"
