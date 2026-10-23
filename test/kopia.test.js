'use strict';
/* Tests voor de back-up-app (Kopia): back-ups per toestel, wachtwoorden, adressen en de systemd-eenheid. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-kopia-'));
const k = require('../lib/kopia');
const b = require('../lib/backup');

test('back-ups per toestel uit kopia snapshot list', () => {
  const snap = (user, host, p, end, size) => ({ id: Math.random().toString(16).slice(2), source: { host, userName: user, path: p }, startTime: end, endTime: end, stats: { totalSize: size, fileCount: 10 } });
  const out = k.parseSnapshots([
    snap('pc-tom', 'pc-tom', 'C:\\Users\\tom', '2026-10-22T10:00:00Z', 100),
    snap('pc-tom', 'pc-tom', 'C:\\Users\\tom', '2026-10-23T10:00:00Z', 120), // nieuwste van die map telt
    snap('pc-tom', 'pc-tom', 'D:\\Foto', '2026-10-21T10:00:00Z', 50),
    snap('lies', 'imac', '/Users/lies', '2026-10-20T08:00:00Z', 0),
    { source: { host: 'x' } }, // onvolledig: overslaan
  ]);
  assert.deepEqual(out['pc-tom@pc-tom'], { last: Date.parse('2026-10-23T10:00:00Z'), count: 3, size: 170, paths: ['C:\\Users\\tom', 'D:\\Foto'] });
  assert.equal(out['lies@imac'].count, 1);
  assert.deepEqual(k.parseSnapshots(null), {});
  // zonder stats: de grootte uit rootEntry
  assert.equal(k.parseSnapshots([{ source: { host: 'h', userName: 'u', path: '/' }, endTime: '2026-10-23T10:00:00Z', rootEntry: { summ: { size: 42 } } }])['u@h'].size, 42);
});

test('gebruiker en wachtwoord van een toestel', () => {
  assert.equal(k.userId('MacBook-Lies'), 'macbook-lies@macbook-lies');
  const pw = k.newPassword();
  assert.match(pw, /^[a-km-z2-9]{5}(-[a-km-z2-9]{5}){3}$/);
  assert.notEqual(pw, k.newPassword());
});

test('adressen van de server', () => {
  const ifs = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    br0: [{ family: 'IPv4', address: '192.168.1.10', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    virbr0: [{ family: 'IPv4', address: '192.168.122.1', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.64.0.1', internal: false }],
  };
  assert.deepEqual(k.addresses(ifs), ['192.168.1.10']);
});

test('systemd-eenheid van de Kopia-server', () => {
  const unit = k.unitFile('/usr/bin/kopia', '/tank/backups/kopia');
  assert.match(unit, /RequiresMountsFor=\/tank\/backups\/kopia/);
  assert.match(unit, /^EnvironmentFile=.*server\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/kopia server start .*--address=0\.0\.0\.0:51515 .*--tls-cert-file=.*--tls-key-file=.*--random-password --random-server-control-password --no-ui$/m);
  assert.match(unit, /^ExecReload=\/bin\/kill -HUP \$MAINPID$/m);
  assert.doesNotMatch(unit, /KOPIA_PASSWORD/); // het wachtwoord staat alleen in server.env (0600)
});

test('toestel met de back-up-app controleren', () => {
  const ctx = { devices: [{ name: 'iMac' }], shareNames: ['pc-tom'], pools: ['tank'], users: ['lies'] };
  // geen pool, quotum of Samba-gebruiker nodig; een gedeelde map met dezelfde naam stoort niet
  assert.deepEqual(b.validateDevice({ name: 'pc-tom', kind: 'windows', method: 'kopia' }, ctx), { name: 'pc-tom', kind: 'windows', method: 'kopia', user: 'pc-tom@pc-tom' });
  assert.throws(() => b.validateDevice({ name: 'gsm', kind: 'phone', method: 'kopia' }, ctx), /niet voor gsm/);
  assert.throws(() => b.validateDevice({ name: 'imac', kind: 'mac', method: 'kopia' }, ctx), /bestaat al een toestel/);
  assert.equal(b.validateDevice({ name: 'mac2', kind: 'mac', pool: 'tank', user: 'lies' }, ctx).method, 'share');
});

test('koppelcode: foute codes en blokkering per adres', () => {
  for (let i = 0; i < 9; i++) assert.equal(k.usePairing('AAAA-BBBB', '192.168.1.50').status, 404);
  assert.equal(k.usePairing('aaaa-bbbb', '192.168.1.50').status, 404); // de tiende: nu 5 minuten geblokkeerd
  assert.equal(k.usePairing('AAAA-BBBB', '192.168.1.50').status, 429);
  assert.equal(k.usePairing('AAAA-BBBB', '192.168.1.51').status, 404); // een ander toestel niet
});
