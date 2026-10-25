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
DEBIAN_FRONTEND=noninteractive chroot "$R" apt-get install -y -q linux-image-amd64 live-boot systemd nodejs chromium cage kexec-tools openssl cpio gzip

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
After=systemd-user-sessions.service
Conflicts=getty@tty1.service
[Service]
ExecStart=/opt/homebaseos-installer/iso/kiosk.sh
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
mkdir -p "$R/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/homebaseos-kiosk.service "$R/etc/systemd/system/multi-user.target.wants/homebaseos-kiosk.service"
ln -sf /dev/null "$R/etc/systemd/system/getty@tty1.service"

echo "==> initramfs and squashfs"
chroot "$R" update-initramfs -u
VMLINUZ="$(ls "$R"/boot/vmlinuz-* | head -1)"
INITRD="$(ls "$R"/boot/initrd.img-* | head -1)"
cp "$VMLINUZ" "$OUT/vmlinuz"
cp "$INITRD" "$OUT/initrd.img"
umount "$R/dev" "$R/proc" "$R/sys"
mksquashfs "$R" "$OUT/filesystem.squashfs" -comp xz -e boot -noappend
echo "==> live system in $OUT"
