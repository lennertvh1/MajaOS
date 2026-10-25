#!/bin/bash
# Continues an installation that the screen already confirmed: one disk, one language.
# Writes a preseed (the file in git never names a disk), then hands over to the Debian installer.
# Usage: run-install.sh <disk> <language> <nvidia 0|1>
set -uo pipefail
DISK="${1:-}"
LANG_CODE="${2:-en}"
NVIDIA="${3:-0}"
ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DIR="${INSTALL_DIR:-/run/homebaseos-install}"
STATUS="${STATUS:-$DIR/status.json}"
LOG="$DIR/log.txt"
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

fail() { echo "$1" | tee -a "$LOG" >/dev/null; status failed "${2:-0}" "$1"; exit 1; }

status running 10 "Preparing the installation"
PRESEED="$DIR/preseed.cfg"
if ! ROOT="$ROOT" DISK="$DISK" LANG_CODE="$LANG_CODE" PRESEED="$PRESEED" node <<'JS'
const fs = require('fs');
const path = require('path');
const inst = require(path.join(process.env.ROOT, 'lib/installer'));
const base = fs.readFileSync(path.join(process.env.ROOT, 'iso/preseed.cfg'), 'utf8');
const built = inst.buildPreseed(base, { disk: process.env.DISK, language: process.env.LANG_CODE });
fs.writeFileSync(process.env.PRESEED, built.text);
fs.writeFileSync(process.env.PRESEED + '.cmdline', built.cmdline);
JS
then fail "The installation could not be prepared." 10; fi

# A random password so the Debian installer does not ask. The account is locked again before the first boot.
if ! command -v openssl >/dev/null; then fail "openssl is missing, so the installer cannot continue." 10; fi
HASH="$(openssl passwd -6 "$(od -An -tx1 -N 18 /dev/urandom | tr -d ' \n')")" || fail "The installation could not be prepared." 10
printf 'd-i passwd/user-password-crypted password %s\n' "$HASH" >> "$PRESEED"
unset HASH

# The disc may be mounted in more than one place, depending on the live system.
MEDIUM=""
for cand in /run/live/medium /lib/live/mount/medium /cdrom; do
  if [ -f "$cand/install.amd/vmlinuz" ] && [ -f "$cand/homebaseos/initrd.gz" ]; then MEDIUM="$cand"; break; fi
done
[ -n "$MEDIUM" ] || fail "The Debian installer was not found on this disc." 20
echo "Installer files on $MEDIUM" >> "$LOG"

# A second, tiny archive after the installer's initrd. The kernel reads both, and this preseed replaces the one without a disk.
# Unpacking and recompressing that initrd here is what made this step sit on "Partitioning the disk".
status running 40 "Preparing the installation"
(cd "$DIR" && echo preseed.cfg | cpio -H newc -o) > "$DIR/preseed.cpio" 2>>"$LOG" || fail "The installation could not be prepared." 40
cat "$MEDIUM/homebaseos/initrd.gz" "$DIR/preseed.cpio" > "$DIR/initrd.gz" || fail "The installation could not be prepared." 40

CMDLINE="$(cat "$PRESEED.cmdline")"
[ "$NVIDIA" = 1 ] && CMDLINE="$CMDLINE homebaseos.nvidia=1"
status running 70 "The installation continues on its own. You don't have to do anything."
if ! command -v kexec >/dev/null; then fail "kexec is missing, so the installer cannot continue." 70; fi
# Leave the screen in text mode. A graphics mode here stays black on a UEFI VM. Partitioning happens in the Debian installer, after this handoff.
kexec -l "$MEDIUM/install.amd/vmlinuz" --initrd="$DIR/initrd.gz" --command-line="$CMDLINE console=tty0 ---" >>"$LOG" 2>&1 || fail "The Debian installer was not found on this disc." 70
sync
kexec -e >>"$LOG" 2>&1 || fail "The Debian installer was not found on this disc." 90
