'use strict';
/* Tests for the backup app (Kopia): backups per device, passwords, addresses and the systemd unit. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-kopia-'));
const k = require('../lib/kopia');
const b = require('../lib/backup');

test('backups per device from kopia snapshot list', () => {
  const snap = (user, host, p, end, size) => ({ id: Math.random().toString(16).slice(2), source: { host, userName: user, path: p }, startTime: end, endTime: end, stats: { totalSize: size, fileCount: 10 } });
  const out = k.parseSnapshots([
    snap('pc-tom', 'pc-tom', 'C:\\Users\\tom', '2026-10-22T10:00:00Z', 100),
    snap('pc-tom', 'pc-tom', 'C:\\Users\\tom', '2026-10-23T10:00:00Z', 120), // newest of that folder counts
    snap('pc-tom', 'pc-tom', 'D:\\Foto', '2026-10-21T10:00:00Z', 50),
    snap('lies', 'imac', '/Users/lies', '2026-10-20T08:00:00Z', 0),
    { source: { host: 'x' } }, // incomplete: skip
  ]);
  assert.deepEqual(out['pc-tom@pc-tom'], { last: Date.parse('2026-10-23T10:00:00Z'), count: 3, size: 170, paths: ['C:\\Users\\tom', 'D:\\Foto'] });
  assert.equal(out['lies@imac'].count, 1);
  assert.deepEqual(k.parseSnapshots(null), {});
  // without stats: the size from rootEntry
  assert.equal(k.parseSnapshots([{ source: { host: 'h', userName: 'u', path: '/' }, endTime: '2026-10-23T10:00:00Z', rootEntry: { summ: { size: 42 } } }])['u@h'].size, 42);
});

test('user and password of a device', () => {
  assert.equal(k.userId('MacBook-Lies'), 'macbook-lies@macbook-lies');
  const pw = k.newPassword();
  assert.match(pw, /^[a-km-z2-9]{5}(-[a-km-z2-9]{5}){3}$/);
  assert.notEqual(pw, k.newPassword());
});

test('addresses of the server', () => {
  const ifs = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    br0: [{ family: 'IPv4', address: '192.168.1.10', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    virbr0: [{ family: 'IPv4', address: '192.168.122.1', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.64.0.1', internal: false }],
  };
  assert.deepEqual(k.addresses(ifs), ['192.168.1.10']);
});

test('systemd unit of the Kopia server', () => {
  const unit = k.unitFile('/usr/bin/kopia', '/tank/backups/kopia');
  assert.match(unit, /RequiresMountsFor=\/tank\/backups\/kopia/);
  assert.match(unit, /^EnvironmentFile=.*server\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/kopia server start .*--address=0\.0\.0\.0:51515 .*--tls-cert-file=.*--tls-key-file=.*--random-password --random-server-control-password --no-ui$/m);
  assert.match(unit, /^ExecReload=\/bin\/kill -HUP \$MAINPID$/m);
  assert.doesNotMatch(unit, /KOPIA_PASSWORD/); // the password is only in server.env (0600)
});

test('checking a device with the backup app', () => {
  const ctx = { devices: [{ name: 'iMac' }], shareNames: ['pc-tom'], pools: ['tank'], users: ['lies'] };
  // no pool, quota or Samba user needed; a shared folder with the same name doesn't matter
  assert.deepEqual(b.validateDevice({ name: 'pc-tom', kind: 'windows', method: 'kopia' }, ctx), { name: 'pc-tom', kind: 'windows', method: 'kopia', user: 'pc-tom@pc-tom' });
  assert.throws(() => b.validateDevice({ name: 'gsm', kind: 'phone', method: 'kopia' }, ctx), /for phones/);
  assert.throws(() => b.validateDevice({ name: 'imac', kind: 'mac', method: 'kopia' }, ctx), /device named imac already exists/);
  assert.equal(b.validateDevice({ name: 'mac2', kind: 'mac', pool: 'tank', user: 'lies' }, ctx).method, 'share');
});

test('pairing code: wrong codes and blocking per address', () => {
  for (let i = 0; i < 9; i++) assert.equal(k.usePairing('AAAA-BBBB', '192.168.1.50').status, 404);
  assert.equal(k.usePairing('aaaa-bbbb', '192.168.1.50').status, 404); // the tenth: now blocked for 5 minutes
  assert.equal(k.usePairing('AAAA-BBBB', '192.168.1.50').status, 429);
  assert.equal(k.usePairing('AAAA-BBBB', '192.168.1.51').status, 404); // another device isn't
});
