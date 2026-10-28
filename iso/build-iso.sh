#!/usr/bin/env bash
# Builds the MajaOS installation ISO: the official Debian 13 net installer + preseed + MajaOS.
# Runs on Linux (GitHub Actions: ubuntu-24.04). Needs: xorriso, GNU cpio, gzip, curl, git, sha256sum.
#
#   ./iso/build-iso.sh                      download the latest Debian 13 netinst and build the ISO in dist/
#   ./iso/build-iso.sh --iso debian.iso     use your own Debian ISO (no download)
#   ./iso/build-iso.sh --out folder         write somewhere else
#   ./iso/build-iso.sh --worktree           use the current files instead of the last commit
#   ./iso/build-iso.sh --live               also build the graphical installer (root, debootstrap; the release ISO)
#
# What changes in the Debian ISO (the rest stays identical byte for byte):
#   /majaos/initrd.gz      copy of install.amd/initrd.gz with preseed.cfg in it
#   /majaos/*              MajaOS (tar.gz), late.sh, the first-boot service, screen text
#   /live/                     with --live: the graphical installer (language, disk, confirm)
#   /boot/grub/grub.cfg        UEFI: Install MajaOS first (the live screen with --live, otherwise the Debian installer)
#   /isolinux/*.cfg            BIOS: the same in the isolinux menu
#   /md5sum.txt                updated for the changed and new files
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/iso"
SRC_ISO=""; OUT="$ROOT/dist"; WORKTREE=0; LIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --iso) SRC_ISO="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --worktree) WORKTREE=1; shift ;;
    --live) LIVE=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (use --help)"; exit 1 ;;
  esac
done

need() { command -v "$1" >/dev/null || { echo "Missing: $1 (sudo apt-get install -y $2)"; exit 1; }; }
need xorriso xorriso; need cpio cpio; need gzip gzip; need curl curl; need sha256sum coreutils; need git git
cpio --version 2>/dev/null | grep -q 'GNU cpio' || { echo "GNU cpio is needed (not the BSD version)."; exit 1; }

VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
[ -n "$VERSION" ] || { echo "No version found in package.json."; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT" "$WORK/hb"

# 1. The Debian ISO: the latest 13.x netinst, checked with SHA256SUMS from debian.org.
if [ -z "$SRC_ISO" ]; then
  step "Fetching Debian 13 netinst"
  BASE=https://cdimage.debian.org/debian-cd/current/amd64/iso-cd
  curl -fsSL "$BASE/SHA256SUMS" -o "$WORK/SHA256SUMS"
  NAME="$(grep -oE 'debian-13\.[0-9.]+-amd64-netinst\.iso' "$WORK/SHA256SUMS" | head -1 || true)"
  [ -n "$NAME" ] || { echo "No Debian 13 netinst found at $BASE (new Debian version?). Pass one with --iso."; exit 1; }
  CACHE="$ROOT/.iso-cache"; mkdir -p "$CACHE"; SRC_ISO="$CACHE/$NAME"
  if [ ! -f "$SRC_ISO" ]; then
    curl -fL --progress-bar "$BASE/$NAME" -o "$SRC_ISO.part"
    mv "$SRC_ISO.part" "$SRC_ISO"
  fi
  (cd "$CACHE" && grep " $NAME\$" "$WORK/SHA256SUMS" | sha256sum -c -) || { rm -f "$SRC_ISO"; echo "Checksum doesn't match: download again."; exit 1; }
fi
[ -f "$SRC_ISO" ] || { echo "ISO not found: $SRC_ISO"; exit 1; }
DEBIAN="$(basename "$SRC_ISO" .iso)"

# Extract the files from the Debian ISO that we change.
extract() { xorriso -osirrox on -indev "$SRC_ISO" -extract "$1" "$2" >/dev/null 2>&1; }
extract /install.amd/initrd.gz "$WORK/initrd.gz" || { echo "install.amd/initrd.gz is missing: is this a Debian amd64 netinst?"; exit 1; }
extract /boot/grub/grub.cfg "$WORK/grub.cfg"
extract /md5sum.txt "$WORK/md5sum.txt"
BIOS=0
if extract /isolinux/menu.cfg "$WORK/menu.cfg" && extract /isolinux/gtk.cfg "$WORK/gtk.cfg"; then BIOS=1; fi
chmod u+w "$WORK"/*

# 2. preseed.cfg in a copy of the initrd (method from the Debian wiki: unpack, append to the cpio archive, pack again).
step "Putting the preseed in the initrd"
gunzip -c "$WORK/initrd.gz" > "$WORK/initrd"
(cd "$HERE" && echo preseed.cfg | cpio -H newc -o -A -F "$WORK/initrd" 2>/dev/null)
gzip -9 -c "$WORK/initrd" > "$WORK/hb/initrd.gz"
rm -f "$WORK/initrd"

# 3. MajaOS itself (the last commit, or the current files with --worktree).
step "Packing MajaOS $VERSION"
if [ "$WORKTREE" = 1 ]; then
  tar -C "$ROOT" --exclude=.git --exclude=dist --exclude=.iso-cache --exclude=node_modules -czf "$WORK/hb/majaos.tar.gz" .
else
  [ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] || echo "Note: there are uncommitted changes; they are NOT in the ISO (use --worktree)."
  git -C "$ROOT" archive --format=tar.gz -o "$WORK/hb/majaos.tar.gz" HEAD
fi
cp "$HERE/late.sh" "$HERE/majaos-firstboot.service" "$HERE/installing.issue" "$HERE/preseed.cfg" \
  "$HERE/serve.js" "$HERE/kiosk.sh" "$HERE/run-install.sh" "$WORK/hb/"
if [ "$LIVE" = 1 ]; then
  step "Building the graphical installer"
  bash "$HERE/build-live.sh" "$WORK/live"
fi

# 4. Boot menus: MajaOS at the top and the default; the normal Debian installation stays below.
step "Changing the boot menus"
KERNEL=/install.amd/vmlinuz
if [ -f "$WORK/live/vmlinuz" ]; then
  cat > "$WORK/grub-entries.cfg" <<EOF
# Start the installer right away. Hold Esc while it starts for the menu (recovery, plain Debian).
set default=0
set timeout_style=hidden
set timeout=1
menuentry --hotkey=h 'Install MajaOS $VERSION' {
    set background_color=black
    linux    /live/vmlinuz boot=live components quiet splash loglevel=3 rd.udev.log_level=3 systemd.show_status=false vt.global_cursor_default=0 live-media-path=/live
    initrd   /live/initrd.img
}
menuentry 'Install MajaOS $VERSION (recovery)' {
    set background_color=black
    linux    $KERNEL vga=788 --- quiet
    initrd   /majaos/initrd.gz
}
EOF
else
  cat > "$WORK/grub-entries.cfg" <<EOF
menuentry --hotkey=h 'Install MajaOS $VERSION' {
    set background_color=black
    linux    $KERNEL vga=788 --- quiet
    initrd   /majaos/initrd.gz
}
menuentry --hotkey=n 'Install MajaOS $VERSION with the NVIDIA driver' {
    set background_color=black
    linux    $KERNEL vga=788 majaos.nvidia=1 --- quiet
    initrd   /majaos/initrd.gz
}
EOF
fi
grep -q '^menuentry' "$WORK/grub.cfg" || { echo "Unexpected grub.cfg: no menuentry found."; exit 1; }
awk -v f="$WORK/grub-entries.cfg" '!done && /^menuentry/ { while ((getline l < f) > 0) print l; done = 1 } { print }' "$WORK/grub.cfg" > "$WORK/grub.cfg.new"
mv "$WORK/grub.cfg.new" "$WORK/grub.cfg"
if [ -f "$WORK/live/vmlinuz" ]; then
  # While the installer loads: the house on the same blue as the boot logo, not Debian's splash. No beep either.
  # The Debian menu behind Esc keeps its own look.
  cp "$HERE/plymouth/grub-splash.png" "$WORK/hb/splash.png"
  sed -i -e 's#^if background_image /isolinux/splash.png; then#if background_image /majaos/splash.png; then#' -e '/^play 960 /d' "$WORK/grub.cfg"
  grep -q 'background_image /majaos/splash.png' "$WORK/grub.cfg" || echo "Note: the GRUB background was not replaced (unexpected grub.cfg)."
fi

MAPS=(-map "$WORK/grub.cfg" /boot/grub/grub.cfg)
if [ "$BIOS" = 1 ]; then
  if [ -f "$WORK/live/vmlinuz" ]; then
    cat > "$WORK/majaos.cfg" <<EOF
label majaos
	menu label ^Install MajaOS $VERSION
	menu default
	kernel /live/vmlinuz
	append boot=live components quiet splash loglevel=3 rd.udev.log_level=3 systemd.show_status=false vt.global_cursor_default=0 live-media-path=/live initrd=/live/initrd.img
label majaos-recovery
	menu label Install MajaOS $VERSION (recovery)
	kernel $KERNEL
	append vga=788 initrd=/majaos/initrd.gz --- quiet
EOF
  else
    cat > "$WORK/majaos.cfg" <<EOF
label majaos
	menu label ^Install MajaOS $VERSION
	menu default
	kernel $KERNEL
	append vga=788 initrd=/majaos/initrd.gz --- quiet
label majaos-nvidia
	menu label Install MajaOS $VERSION with the ^NVIDIA driver
	kernel $KERNEL
	append vga=788 initrd=/majaos/initrd.gz majaos.nvidia=1 --- quiet
EOF
  fi
  grep -q '^include gtk.cfg' "$WORK/menu.cfg" || { echo "Unexpected isolinux/menu.cfg."; exit 1; }
  # BIOS: the same, after one second (isolinux counts in tenths).
  awk -v title="menu title MajaOS $VERSION (Debian 13)" \
    '/^include gtk.cfg/ { print "include majaos.cfg"; if (live) print "timeout 10" } /^menu title / { print title; next } { print }' live="$([ -f "$WORK/live/vmlinuz" ] && echo 1 || echo 0)" "$WORK/menu.cfg" > "$WORK/menu.cfg.new"
  mv "$WORK/menu.cfg.new" "$WORK/menu.cfg"
  awk '!/^[[:space:]]*menu default/' "$WORK/gtk.cfg" > "$WORK/gtk.cfg.new"   # the default choice is now MajaOS
  mv "$WORK/gtk.cfg.new" "$WORK/gtk.cfg"
  MAPS+=(-map "$WORK/menu.cfg" /isolinux/menu.cfg -map "$WORK/gtk.cfg" /isolinux/gtk.cfg -map "$WORK/majaos.cfg" /isolinux/majaos.cfg)
else
  echo "No isolinux in this ISO: UEFI only."
fi

# 5. md5sum.txt (the installer can use it to check the USB stick).
sum_line() { printf '%s  ./%s\n' "$(md5sum < "$1" | cut -d' ' -f1)" "$2"; }
grep -v -e ' \./boot/grub/grub\.cfg$' -e ' \./majaos/' "$WORK/md5sum.txt" > "$WORK/md5sum.new" || true
sum_line "$WORK/grub.cfg" boot/grub/grub.cfg >> "$WORK/md5sum.new"
for f in "$WORK"/hb/*; do sum_line "$f" "majaos/$(basename "$f")" >> "$WORK/md5sum.new"; done
if [ -d "$WORK/live" ]; then
  grep -v ' \./live/' "$WORK/md5sum.new" > "$WORK/md5sum.live" || true
  mv "$WORK/md5sum.live" "$WORK/md5sum.new"
  for f in "$WORK"/live/*; do sum_line "$f" "live/$(basename "$f")" >> "$WORK/md5sum.new"; done
  MAPS+=(-map "$WORK/live" /live)
fi
MAPS+=(-map "$WORK/md5sum.new" /md5sum.txt -map "$WORK/hb" /majaos)

# 6. The new ISO: the same boot setup as the original (BIOS + UEFI, also on a USB stick).
step "Writing the ISO"
ISO_OUT="$OUT/majaos-$VERSION-amd64.iso"
rm -f "$ISO_OUT"
xorriso -indev "$SRC_ISO" -outdev "$ISO_OUT" -boot_image any replay "${MAPS[@]}" -compliance no_emul_toc 2>&1 | grep -v -e '^xorriso : UPDATE' || true
[ -s "$ISO_OUT" ] || { echo "Writing the ISO failed."; exit 1; }

# Check: are our files in it, and is the boot setup still there?
xorriso -indev "$ISO_OUT" -find /majaos -type f 2>/dev/null | grep -q initrd.gz || { echo "Check failed: /majaos is missing."; exit 1; }
xorriso -indev "$ISO_OUT" -report_el_torito plain 2>/dev/null | grep -i -E 'El Torito boot img|Boot record' | head -5 || true
(cd "$OUT" && sha256sum "$(basename "$ISO_OUT")" > "$(basename "$ISO_OUT").sha256")

step "Done"
echo "$ISO_OUT  (built on $DEBIAN)"
echo "Put it on a USB stick: balenaEtcher, or: sudo dd if=$(basename "$ISO_OUT") of=/dev/sdX bs=4M status=progress conv=fsync"
