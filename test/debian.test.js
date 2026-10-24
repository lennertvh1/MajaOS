'use strict';
/* Tests for Debian updates: apt list, the unattended-upgrades settings and log, dkms and kernel versions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-deb-'));
const deb = require('../lib/debian');

test('apt list --upgradable', () => {
  const out = `Listing...
openssl/stable-security 3.5.4-1~deb13u1 amd64 [upgradable from: 3.5.1-1]
tzdata/stable-updates 2026b-0+deb13u1 all [upgradable from: 2026a-0+deb13u1]
docker-ce/trixie 5:29.1.0-1~debian.13~trixie amd64 [upgradable from: 5:29.0.2-1~debian.13~trixie]
`;
  const l = deb.parseUpgradable(out);
  assert.equal(l.length, 3);
  assert.deepEqual(l[0], { name: 'openssl', suite: 'stable-security', version: '3.5.4-1~deb13u1', arch: 'amd64', from: '3.5.1-1', security: true });
  assert.equal(l[1].security, false);
  assert.equal(l[2].from, '5:29.0.2-1~debian.13~trixie');
});

test('20auto-upgrades', () => {
  assert.deepEqual(deb.parseAutoConf('APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n'), { lists: true, upgrade: true });
  assert.deepEqual(deb.parseAutoConf('APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "0";\n'), { lists: true, upgrade: false });
  assert.deepEqual(deb.parseAutoConf(''), { lists: false, upgrade: false });
});

test('unattended-upgrades.log: the last run', () => {
  const log = `2026-10-22 06:12:01,101 INFO Starting unattended upgrades script
2026-10-22 06:12:01,102 INFO Allowed origins are: origin=Debian,codename=trixie,label=Debian-Security
2026-10-22 06:12:09,550 INFO No packages found that can be upgraded unattended and no pending auto-removals
2026-10-23 06:31:44,010 INFO Starting unattended upgrades script
2026-10-23 06:31:44,011 INFO Allowed origins are: origin=Debian,codename=trixie,label=Debian-Security
2026-10-23 06:31:52,900 INFO Packages that will be upgraded: libc-bin libc6
2026-10-23 06:31:52,901 INFO Writing dpkg log to /var/log/unattended-upgrades/unattended-upgrades-dpkg.log
2026-10-23 06:32:30,120 INFO All upgrades installed
`;
  assert.deepEqual(deb.parseUuLog(log), { at: '2026-10-23T06:31:44', packages: ['libc-bin', 'libc6'], ok: true, nothing: false });
  assert.equal(deb.parseUuLog(''), null);
});

test('dkms status and kernel versions', () => {
  const d = deb.parseDkms('zfs/2.3.2, 6.12.48+deb13-amd64, x86_64: installed\nzfs/2.3.2, 6.12.52+deb13-amd64, x86_64: built\n');
  assert.deepEqual(d[0], { module: 'zfs', version: '2.3.2', kernel: '6.12.48+deb13-amd64', arch: 'x86_64', state: 'installed' });
  assert.equal(d[1].state, 'built');
  assert.deepEqual(deb.sortKernels(['6.12.48+deb13-amd64', '6.12.52+deb13-amd64', '6.1.0-30-amd64']), ['6.12.52+deb13-amd64', '6.12.48+deb13-amd64', '6.1.0-30-amd64']);
});
