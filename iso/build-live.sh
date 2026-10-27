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

echo "==> debootstrap Debian 13 (trixie), amd64"
debootstrap --arch=amd64 trixie "$R" http://deb.debian.org/debian
printf 'deb http://deb.debian.org/debian trixie main contrib non-free non-free-firmware\ndeb http://deb.debian.org/debian-security trixie-security main contrib non-free non-free-firmware\n' > "$R/etc/apt/sources.list"
mount --bind /proc "$R/proc"
mount --bind /sys "$R/sys"
mount --bind /dev "$R/dev"
chroot "$R" apt-get update -q
DEBIAN_FRONTEND=noninteractive chroot "$R" apt-get install -y -q \
  linux-image-amd64 live-boot live-boot-initramfs-tools systemd dbus nodejs \
  cog cage libgl1-mesa-dri libegl1 adwaita-icon-theme fonts-dejavu-core fonts-noto-cjk plymouth \
  debootstrap parted dosfstools openssl cpio gzip
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

# Logo on a quiet boot. Plymouth keeps it until Cog is ready to draw. A login prompt would wipe it.
THEME="$R/usr/share/plymouth/themes/homebaseos"
mkdir -p "$THEME" "$R/etc/plymouth"
cp "$HERE/plymouth/homebaseos.plymouth" "$HERE/plymouth/homebaseos.script" "$HERE/plymouth/logo.png" "$HERE/plymouth/bar.png" "$THEME/"
printf '[Daemon]\nTheme=homebaseos\nShowDelay=0\n' > "$R/etc/plymouth/plymouthd.conf"
chroot "$R" plymouth-set-default-theme homebaseos || ln -sf homebaseos/homebaseos.plymouth "$R/usr/share/plymouth/themes/default.plymouth"
chroot "$R" systemctl mask plymouth-quit.service plymouth-quit-wait.service || true
chroot "$R" systemctl mask getty@tty1.service || true

cat > "$R/etc/systemd/system/homebaseos-kiosk.service" <<'EOF'
[Unit]
Description=HomeBaseOS installer
After=systemd-logind.service plymouth-start.service
Wants=systemd-logind.service
[Service]
ExecStart=/opt/homebaseos-installer/iso/kiosk.sh
Type=simple
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
ln -sf /etc/systemd/system/homebaseos-kiosk.service "$R/etc/systemd/system/multi-user.target.wants/homebaseos-kiosk.service"

echo "==> initramfs and squashfs"
chroot "$R" update-initramfs -u
VMLINUZ="$(ls "$R"/boot/vmlinuz-* | head -1)"
INITRD="$(ls "$R"/boot/initrd.img-* | head -1)"
chroot "$R" lsinitramfs "/boot/$(basename "$INITRD")" | grep -q 'scripts/live' || { echo "The live initramfs has no live-boot scripts."; exit 1; }
cp "$VMLINUZ" "$OUT/vmlinuz"
cp "$INITRD" "$OUT/initrd.img"
# Chromium otherwise rebuilds the font list on first start. The CJK fonts make that slow.
chroot "$R" fc-cache -fr >/dev/null 2>&1 || true
umount "$R/dev" "$R/proc" "$R/sys"
# zstd unpacks much faster than xz. On a VM the CPU is the limit, not the size.
mksquashfs "$R" "$OUT/filesystem.squashfs" -comp zstd -Xcompression-level 15 -e boot -noappend
echo "==> live system in $OUT"
