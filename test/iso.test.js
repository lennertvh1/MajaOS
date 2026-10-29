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
  assert.equal(preseed['passwd/username'].value, 'maja');
  assert.equal(preseed['debian-installer/locale'].value, 'en_US.UTF-8');
  assert.match(preseed['tasksel/first'].value, /ssh-server/);
  assert.equal(preseed['preseed/late_command'].value, 'sh /cdrom/majaos/late.sh');
});

test('late.sh, the first-boot service and firstboot.sh fit together', () => {
  const late = read('late.sh'), unit = read('majaos-firstboot.service'), first = read('firstboot.sh');
  for (const f of ['majaos.tar.gz', 'majaos-firstboot.service', 'installing.issue']) assert.ok(late.includes(f), f);
  assert.match(late, /majaos\.nvidia=1/);
  assert.match(late, /majaos\\.lang=/);
  assert.match(late, /passwd -l maja/);
  assert.match(unit, /ExecStart=\/bin\/bash \/opt\/majaos-setup\/iso\/firstboot\.sh/);
  assert.match(unit, /ConditionPathExists=\/opt\/majaos-setup\/install\.sh/);
  assert.match(first, /install\.sh/);
  assert.match(first, /systemctl disable majaos-firstboot\.service/);
  // No password on the screen: you create the account in the browser. (server.js cleans up an old password file.)
  assert.doesNotMatch(first, /APP_PASSWORD|majaos-wachtwoord\.issue/);
  assert.match(first, /account/);
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').includes('/etc/issue.d/homebaseos-wachtwoord.issue'));
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8'), /APP_PASSWORD=\$/);
  // The build script copies everything late.sh uses from /cdrom/majaos.
  const build = read('build-iso.sh');
  for (const f of ['late.sh', 'majaos-firstboot.service', 'installing.issue', 'serve.js', 'kiosk.sh', 'run-install.sh']) assert.ok(build.includes('"$HERE/' + f + '"'), f);
  assert.match(build, /boot=live components quiet splash/);
  assert.match(build, /background_image \/majaos\/splash\.png/);
  assert.ok(fs.existsSync(path.join(dir, 'plymouth', 'grub-splash.png')));
  const live = read('build-live.sh'), kiosk = read('kiosk.sh');
  assert.match(live, /plymouth-set-default-theme majaos/);
  assert.match(live, /cog cage/);
  assert.doesNotMatch(live, /chromium/);
  assert.match(read('plymouth/majaos.script'), /bar.png/);
  assert.match(kiosk, /retain-splash/);
  assert.match(kiosk, /kiosk=1/);
  assert.match(kiosk, /renderer=pixman[\s\S]*open_screen "\$renderer"/);
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
  assert.match(handoff, /debootstrap [^\n]*trixie/);
  assert.doesNotMatch(handoff, /kexec/);
  // MajaOS is installed during the installer, in the chroot; the first boot is only the fallback.
  assert.match(handoff, /chroot "\$TARGET" env MAJAOS_CHROOT=1 bash \/opt\/majaos-setup\/install\.sh/);
  assert.match(handoff, /majaos-firstboot\.service/);
  // Without internet the disk stays as it was: the check comes before wipefs.
  assert.ok(handoff.indexOf('Checking the internet connection') < handoff.indexOf('wipefs -a'));
  assert.match(live, /firmware-realtek/);
  // The keyboard: chosen on the first screen, not fixed in the kiosk unit; the live system has lib/keyboard.js.
  assert.doesNotMatch(live, /XKB_DEFAULT_LAYOUT=be/);
  assert.match(live, /lib\/keyboard\.js/);
  assert.match(read('kiosk.sh'), /XKB_DEFAULT_LAYOUT="\$\{kbd%%:\*\}"/);
  assert.match(handoff, /XKBLAYOUT="%s"/);
  // DHCP with the MAC address as client ID, on the stick and on the installed system (a DUID made some routers slow).
  assert.match(live, /s\/\^duid\$\/clientid\//);
  assert.match(handoff, /s\/\^duid\$\/clientid\/' "\$TARGET\/etc\/dhcpcd.conf"/);
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

test('install.sh in the chroot only enables services and builds modules for the new disk\'s kernel', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  // Starting or restarting goes through the helpers, which skip it in the chroot (old HomeBaseOS units excepted).
  const direct = sh.split('\n').filter((l) => /systemctl (start|restart|enable --now|disable --now)/.test(l)
    && !/^(enable_now|disable_now|restart)\(\)/.test(l) && !/homebaseos/.test(l));
  assert.deepEqual(direct, []);
  assert.match(sh, /KVER="\$\(ls \/lib\/modules \| sort -V \| tail -1\)"/);
  assert.match(sh, /dkms autoinstall -k "\$KVER"/);
  assert.match(sh, /\[ "\$CHROOT" = 1 \] && \{ step "Done/);
});

test('the image: MajaOS is installed in the live system and copied to the disk, cleaned and made unique', () => {
  const live = read('build-live.sh'), run = read('run-install.sh'), iso = read('build-iso.sh');
  // Built in: install.sh in the live system, its services off on the stick, both GRUB packages ready.
  assert.match(live, /chroot "\$R" env MAJAOS_CHROOT=1 bash \/opt\/majaos-setup\/install\.sh/);
  assert.match(live, /ConditionKernelCommandLine=!boot=live/);
  assert.match(live, /apt-get download grub-efi-amd64 grub-pc/);
  assert.match(live, /-e 'boot\/initrd\.img\*'/);
  // Copied with rsync, without the installer itself.
  assert.match(run, /rsync -aHAX[^\n]*\n[^\n]*\n[^\n]*--exclude='\/opt\/majaos-installer'/);
  // Nothing of the stick's root shells or kiosk stays on the disk, the stick-only conditions go.
  for (const f of ['getty@tty2.service.d', 'serial-getty@ttyS0.service.d', 'majaos-kiosk.service', 'majaos-live.conf']) assert.ok(run.includes(f), f);
  assert.match(run, /systemctl unmask getty@tty1\.service plymouth-quit\.service plymouth-quit-wait\.service/);
  // Unique per server.
  for (const f of ['/etc/machine-id', 'ssh-keygen -A', 'SESSION_SECRET=', 'zgenhostid', 'secrets.tdb']) assert.ok(run.includes(f), f);
  assert.match(run, /dpkg --purge live-boot live-boot-initramfs-tools live-tools/);
  // / stays 0755 (else dbus and timesyncd can't start), and the initramfs really exists afterwards.
  assert.match(live, /chmod 755 "\$R"\n[^\n]*\n?mksquashfs|chmod 755 "\$R"/);
  assert.match(run, /chmod 755 "\$TARGET"/);
  assert.match(run, /\[ -s "\$TARGET\/boot\/initrd\.img-\$KVER" \] \|\| fail/);
  assert.match(run, /COMPRESS=zstd/);
  // Only NVIDIA needs the internet with the image.
  assert.match(run, /\[ "\$IMAGE" = 1 \] && \[ "\$NVIDIA" != 1 \] && NEED_NET=0/);
  // The ISO: without Debian's installer (under GitHub's 2 GiB), the live system gets MajaOS.
  assert.match(iso, /REMOVE=\(-rm_r \/pool \/dists \/install\.amd \/firmware --\)/);
  assert.match(iso, /build-live\.sh" "\$WORK\/live" "\$WORK\/hb\/majaos\.tar\.gz"/);
});
