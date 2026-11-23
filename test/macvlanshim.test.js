'use strict';
/* Tests for the shim that lets the server reach apps with their own address (macvlan/ipvlan). */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'majaos-shim-'));
const shim = require('../lib/macvlanshim');

const lan = { name: 'lan', driver: 'macvlan', subnet: '192.168.1.0/24', gateway: '192.168.1.1', ipRange: '192.168.1.192/27', parent: 'br0',
  containers: [{ name: 'pihole', ip: '192.168.1.53' }, { name: 'homebridge', ip: '192.168.1.193' }] };

test('the link name fits in 15 characters and stays the same', () => {
  assert.equal(shim.ifName('lan'), shim.ifName('lan'));
  assert.notEqual(shim.ifName('lan'), shim.ifName('lan2'));
  assert.ok(shim.ifName('a-very-long-network-name-here').length <= 15);
  assert.match(shim.ifName('lan'), /^mshim[0-9a-f]{8}$/);
});

test('a stable, locally administered MAC address', () => {
  assert.equal(shim.macFor('lan', 'abc'), shim.macFor('lan', 'abc'));
  assert.notEqual(shim.macFor('lan', 'abc'), shim.macFor('lan', 'xyz'));
  assert.match(shim.macFor('lan', 'abc'), /^02(:[0-9a-f]{2}){5}$/);
});

test('the shim\'s address: the top of the IP range, never the broadcast, the gateway or an app', () => {
  assert.equal(shim.defaultAddress(lan), '192.168.1.223');
  assert.equal(shim.defaultAddress({ ...lan, ipRange: '192.168.1.224/27' }), '192.168.1.254'); // the range ends at the broadcast
  assert.equal(shim.defaultAddress({ ...lan, containers: [{ name: 'x', ip: '192.168.1.223' }] }), '192.168.1.222');
  assert.equal(shim.defaultAddress({ ...lan, ipRange: null }), '192.168.1.254');
  assert.equal(shim.defaultAddress({ ...lan, subnet: null }), null);
});

test('routes: the IP range, plus a /32 for each app outside it', () => {
  assert.deepEqual(shim.wantedRoutes(lan, '192.168.1.223'), ['192.168.1.192/27', '192.168.1.53/32']);
  // Without an IP range never the whole subnet (that would cut the server off from the home network): only the apps.
  assert.deepEqual(shim.wantedRoutes({ ...lan, ipRange: null }, '192.168.1.254'), ['192.168.1.53/32', '192.168.1.193/32']);
  assert.deepEqual(shim.wantedRoutes({ ...lan, containers: [] }, '192.168.1.223'), ['192.168.1.192/27']);
});

test('the server\'s own address: on the parent card first, else any card in the subnet', () => {
  const parents = [{ name: 'eno2', address: '10.0.0.5' }, { name: 'eno1', address: '192.168.1.11' }, { name: 'br0', address: '192.168.1.10' }];
  assert.equal(shim.serverAddress(lan, parents), '192.168.1.10');
  assert.equal(shim.serverAddress({ ...lan, parent: 'eno3' }, parents), '192.168.1.11');
  assert.equal(shim.serverAddress(lan, [{ name: 'br0', address: null }]), null);
  assert.equal(shim.serverAddress({ ...lan, subnet: null }, parents), null);
});

test('info: a shim that shares the server\'s address shows that address', () => {
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'shims.json'), JSON.stringify({ networks: { lan: { server: true } } }));
  const i = shim.info(lan, [{ name: 'br0', address: '192.168.1.10' }]);
  assert.equal(i.enabled, true); assert.equal(i.server, true);
  assert.equal(i.address, '192.168.1.10'); assert.equal(i.serverAddress, '192.168.1.10');
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'shims.json'), JSON.stringify({ networks: {} }));
  const off = shim.info(lan, [{ name: 'br0', address: '192.168.1.10' }]);
  assert.equal(off.enabled, false); assert.equal(off.address, '192.168.1.223');
});

test('the routes ip -j lists, as CIDR text', () => {
  const out = JSON.parse('[{"dst":"192.168.1.192/27","dev":"mshim1","scope":"link","flags":[]},{"dst":"192.168.1.53","dev":"mshim1","scope":"link","flags":[]}]');
  assert.deepEqual(shim.routeDsts(out), ['192.168.1.192/27', '192.168.1.53/32']);
});

test('turning it on for a network that is not own-address is refused', async () => {
  await assert.rejects(shim.ensure({ name: 'proxy', driver: 'bridge' }, '172.20.0.5'), /Only a macvlan or ipvlan network/);
  await assert.rejects(shim.ensure({ name: 'x', driver: 'macvlan', parent: null }, '192.168.1.2'), /has no network card/);
});

test('ensure: makes the link, its address, brings it up and sets the routes (simulated ip)', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'majaos-shim-bin-')), log = path.join(bin, 'calls.log');
  const dev = shim.ifName('lan');
  // The parent exists, the shim doesn't yet, it has no address and no routes.
  fs.writeFileSync(path.join(bin, 'ip'), `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "-j -d link show dev br0") echo '[{"ifname":"br0"}]' ;;
  "-j -d link show dev ${dev}") echo 'Device "${dev}" does not exist.' >&2; exit 1 ;;
  "-j addr show dev ${dev}") echo '[{"ifname":"${dev}","addr_info":[]}]' ;;
  "-j route show dev ${dev}") echo '[{"dst":"192.168.1.99","dev":"${dev}"}]' ;;
esac
exit 0
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  try {
    const r = await shim.ensure(lan, '192.168.1.223');
    assert.deepEqual(r.routes, ['192.168.1.192/27', '192.168.1.53/32']);
  } finally { process.env.PATH = oldPath; }
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(calls.some((c) => c.startsWith(`link add ${dev} link br0 address 02:`) && c.endsWith('type macvlan mode bridge')), calls.join('\n'));
  assert.ok(calls.includes(`addr add 192.168.1.223/32 dev ${dev}`));
  assert.ok(calls.includes(`link set ${dev} up`));
  assert.ok(calls.includes(`route replace 192.168.1.192/27 dev ${dev}`));
  assert.ok(calls.includes(`route replace 192.168.1.53/32 dev ${dev}`));
  assert.ok(calls.includes(`route del 192.168.1.99/32 dev ${dev}`)); // an app that is gone
  // The address comes before the routes, and the link before both.
  const at = (p) => calls.findIndex((c) => c.startsWith(p));
  assert.ok(at('link add') < at('addr add') && at('addr add') < at('route replace'));
});
