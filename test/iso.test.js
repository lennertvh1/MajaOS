'use strict';
/* Tests for the installation ISO: safety of the preseed file and consistency of the files. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'iso');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
// preseed: "d-i key type value" (skip comments and empty lines)
const preseed = Object.fromEntries(read('preseed.cfg').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => { const [owner, key, type, ...rest] = l.trim().split(/\s+/); return [key, { owner, type, value: rest.join(' ') }]; }));

test('preseed asks for the disk, the confirmation and the password itself', () => {
  // Never choose a disk itself or erase without asking: the server may contain disks with data.
  for (const k of ['partman-auto/disk', 'partman/confirm', 'partman/confirm_nooverwrite', 'partman-auto/select_disk']) assert.equal(preseed[k], undefined, k);
  // No passwords in the ISO.
  for (const k of Object.keys(preseed)) assert.ok(!/password/.test(k), k);
  assert.equal(preseed['passwd/root-login'].value, 'false'); // root off, the user gets sudo
  assert.equal(preseed['passwd/username'].value, 'homebase');
  assert.equal(preseed['debian-installer/locale'].value, 'en_US.UTF-8');
  assert.match(preseed['tasksel/first'].value, /ssh-server/);
  assert.equal(preseed['preseed/late_command'].value, 'sh /cdrom/homebaseos/late.sh');
});

test('late.sh, the first-boot service and firstboot.sh fit together', () => {
  const late = read('late.sh'), unit = read('homebaseos-firstboot.service'), first = read('firstboot.sh');
  for (const f of ['homebaseos.tar.gz', 'homebaseos-firstboot.service', 'installing.issue']) assert.ok(late.includes(f), f);
  assert.match(late, /homebaseos\.nvidia=1/);
  assert.match(late, /homebaseos\\.lang=/);
  assert.match(late, /passwd -l homebase/);
  assert.match(unit, /ExecStart=\/bin\/bash \/opt\/homebaseos-setup\/iso\/firstboot\.sh/);
  assert.match(unit, /ConditionPathExists=\/opt\/homebaseos-setup\/install\.sh/);
  assert.match(first, /install\.sh/);
  assert.match(first, /systemctl disable homebaseos-firstboot\.service/);
  // No password on the screen: you create the account in the browser. (server.js cleans up an old password file.)
  assert.doesNotMatch(first, /APP_PASSWORD|homebaseos-wachtwoord\.issue/);
  assert.match(first, /account/);
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').includes('/etc/issue.d/homebaseos-wachtwoord.issue'));
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8'), /APP_PASSWORD=\$/);
  // The build script copies everything late.sh uses from /cdrom/homebaseos.
  const build = read('build-iso.sh');
  for (const f of ['late.sh', 'homebaseos-firstboot.service', 'installing.issue', 'serve.js', 'kiosk.sh', 'run-install.sh']) assert.ok(build.includes('"$HERE/' + f + '"'), f);
  assert.match(build, /boot=live components quiet splash/);
  assert.match(build, /background_image \/homebaseos\/splash\.png/);
  assert.ok(fs.existsSync(path.join(dir, 'plymouth', 'grub-splash.png')));
  const live = read('build-live.sh'), kiosk = read('kiosk.sh');
  assert.match(live, /plymouth-set-default-theme homebaseos/);
  assert.match(live, /cog cage/);
  assert.doesNotMatch(live, /chromium/);
  assert.match(read('plymouth/homebaseos.script'), /bar.png/);
  assert.match(kiosk, /retain-splash/);
  assert.match(kiosk, /kiosk=1/);
  assert.match(kiosk, /open_screen pixman/);
  assert.match(kiosk, /--platform=wl/);
  assert.match(live, /PAMName=login/);
  assert.match(live, /TTYPath=\/dev\/tty1/);
  assert.doesNotMatch(live, /TTYReset=yes/);
  assert.match(live, /Type=simple/);
  assert.match(live, /-comp zstd/);
  assert.match(read('serve.js'), /server-ready/);
  assert.match(live, /COMPRESS=gzip/);
  assert.match(live, /fonts-noto-cjk/);
  assert.match(live, /WLR_NO_HARDWARE_CURSORS=1/);
  assert.doesNotMatch(live, /getty@tty1\.service[\s\S]{0,40}\/dev\/null/);
  const handoff = read('run-install.sh');
  assert.match(handoff, /debootstrap trixie/);
  assert.doesNotMatch(handoff, /kexec/);
  assert.match(live, /debootstrap/);
});

test('no local line in the ISO scripts uses a variable it sets itself', () => {
  // local expands all its words before assigning, so `local a="$1" b="$a"` stops a script under set -u.
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sh'))) {
    for (const line of read(f).split('\n')) {
      const m = line.match(/^\s*local\s+(.*)$/);
      if (!m) continue;
      const names = [...m[1].matchAll(/\b([A-Za-z_]\w*)=/g)].map((x) => x[1]);
      for (const n of names) assert.ok(!new RegExp('\\$\\{?' + n + '\\b').test(m[1]), f + ': ' + line.trim());
    }
  }
});
