'use strict';
/* HTTPS with an own certificate (lib/tls.js): which names go in, when a new one is needed, and a real one with openssl. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-tls-'));
const tls = require('../lib/tls');

const ifaces = {
  eno1: [{ family: 'IPv4', address: '192.168.1.10', internal: false }, { family: 'IPv6', address: 'fd00::10', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
  docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
  'br-1a2b': [{ family: 'IPv4', address: '172.30.0.1', internal: false }],
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
};

test('the certificate names the host, <host>.local and the real addresses, not the app networks', () => {
  const n = tls.wantedNames('Freddy.home.lan', ifaces);
  assert.deepEqual(n.dns, ['localhost', 'freddy', 'freddy.local']);
  assert.deepEqual(n.ips, ['127.0.0.1', '0:0:0:0:0:0:0:1', '192.168.1.10', 'fd00:0:0:0:0:0:0:10']);
  assert.equal(tls.expandIpv6('2001:db8::1'), '2001:db8:0:0:0:0:0:1');
  assert.deepEqual(tls.wantedNames('bad_name!', {}).dns, ['localhost']); // a strange host name stays out
  assert.match(tls.opensslConfig(n), /subjectAltName = DNS:localhost, DNS:freddy, DNS:freddy\.local, IP:127\.0\.0\.1/);
  assert.match(tls.opensslConfig(n), /extendedKeyUsage = serverAuth/);
});

let openssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }

test('a real CA and server certificate: made once, renewed when an address changes, the CA stays', { skip: !openssl && 'openssl is not installed' }, async () => {
  const first = await tls.ensure({ host: 'freddy', ifaces });
  assert.equal(first.renewed, true);
  assert.match(first.key, /PRIVATE KEY/);
  assert.equal((first.cert.match(/BEGIN CERTIFICATE/g) || []).length, 2); // server + CA
  const info = tls.info();
  assert.ok(info.names.includes('freddy.local') && info.names.includes('192.168.1.10'));
  assert.ok(Date.parse(info.expires) - Date.now() < 398 * 864e5); // browsers refuse longer
  assert.equal((fs.statSync(path.join(tls.DIR, 'ca.key')).mode & 0o777), 0o600);
  const fp = info.caFingerprint;

  assert.equal((await tls.ensure({ host: 'freddy', ifaces })).renewed, false);
  const moved = { eno1: [{ family: 'IPv4', address: '192.168.1.20', internal: false }] };
  const second = await tls.ensure({ host: 'freddy', ifaces: moved });
  assert.equal(second.reason, 'names');
  assert.ok(tls.info().names.includes('192.168.1.20'));
  assert.equal(tls.info().caFingerprint, fp); // devices that trust the CA keep trusting it
  assert.equal(tls.renewReason({ certPem: '', caPem: tls.caPem(), names: tls.wantedNames('freddy', moved) }), 'missing');
  assert.equal(tls.renewReason({ certPem: tls.caPem(), caPem: tls.caPem(), names: tls.wantedNames('freddy', moved) }) !== null, true);
});
