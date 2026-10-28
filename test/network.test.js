'use strict';
/* Tests for the network settings and the About page. */
const test = require('node:test');
const assert = require('node:assert/strict');
const nw = require('../lib/network');
const ab = require('../lib/about');

// As the Debian installer writes the file, with an extra wifi card we don't manage.
const DEBIAN = `# This file describes the network interfaces available on your system
# and how to activate them. For more information, see interfaces(5).

source /etc/network/interfaces.d/*

# The loopback network interface
auto lo
iface lo inet loopback

# The primary network interface
allow-hotplug enp5s0
iface enp5s0 inet dhcp
# This is an autoconfigured IPv6 interface
iface enp5s0 inet6 auto

allow-hotplug wlp3s0
iface wlp3s0 inet dhcp
    wpa-ssid Thuis
`;

test('reading the interfaces file: DHCP without a bridge', () => {
  const cfg = nw.configFromInterfaces(nw.parseInterfaces(DEBIAN), ['enp5s0']);
  assert.deepEqual(cfg, { interface: 'enp5s0', mode: 'dhcp', address: '', gateway: '', dns: [], bridge: false, bridgeName: 'br0' });
});

test('reading the interfaces file: static address in a bridge, with netmask', () => {
  const text = 'auto lo\niface lo inet loopback\n\niface enp5s0 inet manual\n\nauto br0\niface br0 inet static\n  address 192.168.1.10\n  netmask 255.255.255.0\n  gateway 192.168.1.1\n  dns-nameservers 192.168.1.1 1.1.1.1\n  bridge_ports enp5s0\n';
  assert.deepEqual(nw.configFromInterfaces(nw.parseInterfaces(text), ['enp5s0']),
    { interface: 'enp5s0', mode: 'static', address: '192.168.1.10/24', gateway: '192.168.1.1', dns: ['192.168.1.1', '1.1.1.1'], bridge: true, bridgeName: 'br0' });
  assert.equal(nw.maskToPrefix('255.255.240.0'), 20);
});

test('new file: bridge with a static address, other cards stay', () => {
  const cfg = nw.validate({ interface: 'enp5s0', mode: 'static', address: '192.168.1.10/24', gateway: '192.168.1.1', dns: '192.168.1.1, 1.1.1.1', bridge: true }, ['enp5s0']);
  const out = nw.buildInterfaces(cfg, DEBIAN);
  assert.match(out, /^# Managed by MajaOS/);
  assert.match(out, /\nauto lo\niface lo inet loopback\n/);
  assert.match(out, /\niface enp5s0 inet manual\n\nauto br0\niface br0 inet static\n {4}bridge_ports enp5s0\n {4}bridge_stp off\n {4}bridge_fd 0\n {4}address 192\.168\.1\.10\/24\n {4}gateway 192\.168\.1\.1\n {4}dns-nameservers 192\.168\.1\.1 1\.1\.1\.1\n/);
  assert.doesNotMatch(out, /enp5s0 inet dhcp/);
  assert.doesNotMatch(out, /allow-hotplug enp5s0/);
  assert.match(out, /allow-hotplug wlp3s0\niface wlp3s0 inet dhcp\n {4}wpa-ssid Thuis/); // not managed: unchanged
  assert.equal((out.match(/source \/etc\/network\/interfaces\.d/g) || []).length, 1);
  // What we write, we also read back correctly ourselves.
  assert.deepEqual(nw.configFromInterfaces(nw.parseInterfaces(out), ['enp5s0']), cfg);
});

test('new file: back to DHCP without a bridge', () => {
  const start = nw.buildInterfaces(nw.validate({ interface: 'enp5s0', mode: 'static', address: '10.0.0.5/8', gateway: '10.0.0.1', dns: ['10.0.0.1'], bridge: true }, ['enp5s0']), DEBIAN);
  const out = nw.buildInterfaces(nw.validate({ interface: 'enp5s0', mode: 'dhcp', bridge: false }, ['enp5s0']), start);
  assert.match(out, /\nauto enp5s0\niface enp5s0 inet dhcp\n/);
  assert.doesNotMatch(out, /br0|address|gateway/);
});

test('checking the input', () => {
  const bad = (f, re) => assert.throws(() => nw.validate({ interface: 'enp5s0', mode: 'static', address: '192.168.1.10/24', gateway: '192.168.1.1', dns: '1.1.1.1', ...f }, ['enp5s0']), re);
  bad({ interface: 'eth9' }, /network cards/);
  bad({ address: '192.168.1.10' }, /netmask/);
  bad({ address: '300.1.1.1/24' }, /netmask/);
  bad({ gateway: '' }, /gateway/);
  bad({ gateway: '10.0.0.1' }, /same network/);
  bad({ dns: 'router.lan' }, /not a valid DNS/);
  bad({ dns: '' }, /at least one DNS/);
  assert.equal(nw.validate({ interface: 'enp5s0', mode: 'dhcp', dns: '' }, ['enp5s0']).mode, 'dhcp');
});

test('ip -j -d addr samenvatten', () => {
  const links = nw.summarizeLinks([
    { ifname: 'lo', operstate: 'UNKNOWN', addr_info: [] },
    { ifname: 'enp5s0', address: 'aa:bb:cc:dd:ee:ff', operstate: 'UP', master: 'br0', addr_info: [] },
    { ifname: 'br0', address: 'aa:bb:cc:dd:ee:ff', operstate: 'UP', linkinfo: { info_kind: 'bridge' },
      addr_info: [{ family: 'inet', local: '192.168.1.10', prefixlen: 24, dynamic: true }, { family: 'inet6', local: 'fe80::1', prefixlen: 64, scope: 'link' }] },
    { ifname: 'docker0', operstate: 'DOWN', addr_info: [] }, { ifname: 'veth12ab', operstate: 'UP', addr_info: [] },
  ], [{ dst: 'default', gateway: '192.168.1.1', dev: 'br0' }]);
  assert.deepEqual(links.map((l) => [l.name, l.kind, l.master, l.ipv4.map((a) => a.address).join(), l.gateway]),
    [['enp5s0', 'ethernet', 'br0', '', null], ['br0', 'bridge', null, '192.168.1.10/24', '192.168.1.1']]);
  assert.deepEqual(nw.nameservers('# x\nnameserver 192.168.1.1\nnameserver 1.1.1.1\nsearch lan\n'), ['192.168.1.1', '1.1.1.1']);
});

test('about: versions of libvirt and GPU from lspci', () => {
  assert.deepEqual(ab.parseVirshVersion('Compiled against library: libvirt 11.3.0\nUsing library: libvirt 11.3.0\nUsing API: QEMU 11.3.0\nRunning hypervisor: QEMU 10.0.2\nRunning against daemon: 11.3.0\n'),
    { libvirt: '11.3.0', hypervisor: 'QEMU 10.0.2' });
  assert.deepEqual(ab.parseLspciGpus('00:00.0 "Host bridge" "Advanced Micro Devices, Inc. [AMD]" "Starship/Matisse Root Complex" "" ""\n' +
    '0a:00.0 "VGA compatible controller" "NVIDIA Corporation" "GA104 [GeForce RTX 3060 Ti]" -ra1 "ASUSTeK" "Device 8817"\n'), ['NVIDIA Corporation GA104']);
});

test('without a bridge the IPv6 setting of the card stays', () => {
  const out = nw.buildInterfaces(nw.validate({ interface: 'enp5s0', mode: 'dhcp', bridge: false }, ['enp5s0']), DEBIAN);
  assert.match(out, /iface enp5s0 inet6 auto/);
  assert.doesNotMatch(out, /The primary network interface/); // a loose comment no longer hangs on a block
});
