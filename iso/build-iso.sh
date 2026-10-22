#!/usr/bin/env bash
# Bouwt de installatie-ISO van HomeBaseOS: de officiële Debian 13-netinstaller + preseed + HomeBaseOS.
# Draait op Linux (GitHub Actions: ubuntu-24.04). Nodig: xorriso, GNU cpio, gzip, curl, git, sha256sum.
#
#   ./iso/build-iso.sh                      laatste Debian 13-netinst downloaden en de ISO bouwen in dist/
#   ./iso/build-iso.sh --iso debian.iso     een eigen Debian-ISO gebruiken (geen download)
#   ./iso/build-iso.sh --out map            ergens anders wegschrijven
#   ./iso/build-iso.sh --worktree           de huidige bestanden gebruiken in plaats van de laatste commit
#
# Wat er verandert aan de Debian-ISO (de rest blijft byte voor byte gelijk):
#   /homebaseos/initrd.gz      kopie van install.amd/initrd.gz met preseed.cfg erin
#   /homebaseos/*              HomeBaseOS (tar.gz), late.sh, de first-boot-dienst, schermtekst
#   /boot/grub/grub.cfg        UEFI (en GRUB): twee HomeBaseOS-regels bovenaan, standaard de eerste
#   /isolinux/*.cfg            BIOS: hetzelfde in het menu van isolinux
#   /md5sum.txt                bijgewerkt voor de gewijzigde en nieuwe bestanden
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/iso"
SRC_ISO=""; OUT="$ROOT/dist"; WORKTREE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --iso) SRC_ISO="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --worktree) WORKTREE=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Onbekende optie: $1 (gebruik --help)"; exit 1 ;;
  esac
done

need() { command -v "$1" >/dev/null || { echo "Ontbreekt: $1 (sudo apt-get install -y $2)"; exit 1; }; }
need xorriso xorriso; need cpio cpio; need gzip gzip; need curl curl; need sha256sum coreutils; need git git
cpio --version 2>/dev/null | grep -q 'GNU cpio' || { echo "GNU cpio is nodig (niet de BSD-versie)."; exit 1; }

VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
[ -n "$VERSION" ] || { echo "Geen versie gevonden in package.json."; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT" "$WORK/hb"

# 1. De Debian-ISO: de laatste 13.x-netinst, gecontroleerd met SHA256SUMS van debian.org.
if [ -z "$SRC_ISO" ]; then
  step "Debian 13 netinst ophalen"
  BASE=https://cdimage.debian.org/debian-cd/current/amd64/iso-cd
  curl -fsSL "$BASE/SHA256SUMS" -o "$WORK/SHA256SUMS"
  NAME="$(grep -oE 'debian-13\.[0-9.]+-amd64-netinst\.iso' "$WORK/SHA256SUMS" | head -1 || true)"
  [ -n "$NAME" ] || { echo "Geen Debian 13-netinst gevonden op $BASE (nieuwe Debian-versie?). Geef er een mee met --iso."; exit 1; }
  CACHE="$ROOT/.iso-cache"; mkdir -p "$CACHE"; SRC_ISO="$CACHE/$NAME"
  if [ ! -f "$SRC_ISO" ]; then
    curl -fL --progress-bar "$BASE/$NAME" -o "$SRC_ISO.part"
    mv "$SRC_ISO.part" "$SRC_ISO"
  fi
  (cd "$CACHE" && grep " $NAME\$" "$WORK/SHA256SUMS" | sha256sum -c -) || { rm -f "$SRC_ISO"; echo "Checksum klopt niet: download opnieuw."; exit 1; }
fi
[ -f "$SRC_ISO" ] || { echo "ISO niet gevonden: $SRC_ISO"; exit 1; }
DEBIAN="$(basename "$SRC_ISO" .iso)"

# Bestanden uit de Debian-ISO halen die we aanpassen.
extract() { xorriso -osirrox on -indev "$SRC_ISO" -extract "$1" "$2" >/dev/null 2>&1; }
extract /install.amd/initrd.gz "$WORK/initrd.gz" || { echo "install.amd/initrd.gz ontbreekt: is dit een Debian amd64-netinst?"; exit 1; }
extract /boot/grub/grub.cfg "$WORK/grub.cfg"
extract /md5sum.txt "$WORK/md5sum.txt"
BIOS=0
if extract /isolinux/menu.cfg "$WORK/menu.cfg" && extract /isolinux/gtk.cfg "$WORK/gtk.cfg"; then BIOS=1; fi
chmod u+w "$WORK"/*

# 2. preseed.cfg in een kopie van de initrd (methode van de Debian-wiki: uitpakken, cpio-archief aanvullen, weer inpakken).
step "Preseed in de initrd zetten"
gunzip -c "$WORK/initrd.gz" > "$WORK/initrd"
(cd "$HERE" && echo preseed.cfg | cpio -H newc -o -A -F "$WORK/initrd" 2>/dev/null)
gzip -9 -c "$WORK/initrd" > "$WORK/hb/initrd.gz"
rm -f "$WORK/initrd"

# 3. HomeBaseOS zelf (de laatste commit, of de huidige bestanden met --worktree).
step "HomeBaseOS $VERSION inpakken"
if [ "$WORKTREE" = 1 ]; then
  tar -C "$ROOT" --exclude=.git --exclude=dist --exclude=.iso-cache --exclude=node_modules -czf "$WORK/hb/homebaseos.tar.gz" .
else
  [ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] || echo "Let op: er zijn niet-gecommitte wijzigingen; die zitten NIET in de ISO (gebruik --worktree)."
  git -C "$ROOT" archive --format=tar.gz -o "$WORK/hb/homebaseos.tar.gz" HEAD
fi
cp "$HERE/late.sh" "$HERE/homebaseos-firstboot.service" "$HERE/installing.issue" "$HERE/preseed.cfg" "$WORK/hb/"

# 4. Opstartmenu's: HomeBaseOS bovenaan en standaard; de gewone Debian-installatie blijft eronder staan.
step "Opstartmenu's aanpassen"
KERNEL=/install.amd/vmlinuz
cat > "$WORK/grub-entries.cfg" <<EOF
menuentry --hotkey=h 'HomeBaseOS $VERSION installeren' {
    set background_color=black
    linux    $KERNEL vga=788 --- quiet
    initrd   /homebaseos/initrd.gz
}
menuentry --hotkey=n 'HomeBaseOS $VERSION installeren met NVIDIA-driver' {
    set background_color=black
    linux    $KERNEL vga=788 homebaseos.nvidia=1 --- quiet
    initrd   /homebaseos/initrd.gz
}
EOF
grep -q '^menuentry' "$WORK/grub.cfg" || { echo "Onverwachte grub.cfg: geen menuentry gevonden."; exit 1; }
awk -v f="$WORK/grub-entries.cfg" '!done && /^menuentry/ { while ((getline l < f) > 0) print l; done = 1 } { print }' "$WORK/grub.cfg" > "$WORK/grub.cfg.new"
mv "$WORK/grub.cfg.new" "$WORK/grub.cfg"

MAPS=(-map "$WORK/grub.cfg" /boot/grub/grub.cfg)
if [ "$BIOS" = 1 ]; then
  cat > "$WORK/homebaseos.cfg" <<EOF
label homebaseos
	menu label ^HomeBaseOS $VERSION installeren
	menu default
	kernel $KERNEL
	append vga=788 initrd=/homebaseos/initrd.gz --- quiet
label homebaseos-nvidia
	menu label HomeBaseOS $VERSION installeren met ^NVIDIA-driver
	kernel $KERNEL
	append vga=788 initrd=/homebaseos/initrd.gz homebaseos.nvidia=1 --- quiet
EOF
  grep -q '^include gtk.cfg' "$WORK/menu.cfg" || { echo "Onverwachte isolinux/menu.cfg."; exit 1; }
  awk -v title="menu title HomeBaseOS $VERSION (Debian 13)" \
    '/^include gtk.cfg/ { print "include homebaseos.cfg" } /^menu title / { print title; next } { print }' "$WORK/menu.cfg" > "$WORK/menu.cfg.new"
  mv "$WORK/menu.cfg.new" "$WORK/menu.cfg"
  awk '!/^[[:space:]]*menu default/' "$WORK/gtk.cfg" > "$WORK/gtk.cfg.new"   # de standaardkeuze is nu HomeBaseOS
  mv "$WORK/gtk.cfg.new" "$WORK/gtk.cfg"
  MAPS+=(-map "$WORK/menu.cfg" /isolinux/menu.cfg -map "$WORK/gtk.cfg" /isolinux/gtk.cfg -map "$WORK/homebaseos.cfg" /isolinux/homebaseos.cfg)
else
  echo "Geen isolinux in deze ISO: alleen UEFI."
fi

# 5. md5sum.txt (de installer kan er de USB-stick mee controleren).
sum_line() { printf '%s  ./%s\n' "$(md5sum < "$1" | cut -d' ' -f1)" "$2"; }
grep -v -e ' \./boot/grub/grub\.cfg$' -e ' \./homebaseos/' "$WORK/md5sum.txt" > "$WORK/md5sum.new" || true
sum_line "$WORK/grub.cfg" boot/grub/grub.cfg >> "$WORK/md5sum.new"
for f in "$WORK"/hb/*; do sum_line "$f" "homebaseos/$(basename "$f")" >> "$WORK/md5sum.new"; done
MAPS+=(-map "$WORK/md5sum.new" /md5sum.txt -map "$WORK/hb" /homebaseos)

# 6. De nieuwe ISO: zelfde opstartinrichting als het origineel (BIOS + UEFI, ook op een USB-stick).
step "ISO schrijven"
ISO_OUT="$OUT/homebaseos-$VERSION-amd64.iso"
rm -f "$ISO_OUT"
xorriso -indev "$SRC_ISO" -outdev "$ISO_OUT" -boot_image any replay "${MAPS[@]}" -compliance no_emul_toc 2>&1 | grep -v -e '^xorriso : UPDATE' || true
[ -s "$ISO_OUT" ] || { echo "Het schrijven van de ISO is mislukt."; exit 1; }

# Controle: staan onze bestanden erin, en is de opstartinrichting er nog?
xorriso -indev "$ISO_OUT" -find /homebaseos -type f 2>/dev/null | grep -q initrd.gz || { echo "Controle mislukt: /homebaseos ontbreekt."; exit 1; }
xorriso -indev "$ISO_OUT" -report_el_torito plain 2>/dev/null | grep -i -E 'El Torito boot img|Boot record' | head -5 || true
(cd "$OUT" && sha256sum "$(basename "$ISO_OUT")" > "$(basename "$ISO_OUT").sha256")

step "Klaar"
echo "$ISO_OUT  (gebouwd op $DEBIAN)"
echo "Op een USB-stick zetten: balenaEtcher, of: sudo dd if=$(basename "$ISO_OUT") of=/dev/sdX bs=4M status=progress conv=fsync"
