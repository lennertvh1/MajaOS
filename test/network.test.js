'use strict';
/* Tests for the network settings and the About page. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('a bridge keeps the card\'s MAC address, and allow-hotplug cards are brought up too', () => {
  const nw = require('../lib/network');
  const cfg = { ...nw.validate({ interface: 'enp5s0', mode: 'dhcp', bridge: true }, ['enp5s0']), mac: '04:7C:16:AA:BB:CC' };
  const out = nw.buildInterfaces(cfg, 'auto lo\niface lo inet loopback\n\nallow-hotplug enp5s0\niface enp5s0 inet dhcp\n');
  assert.match(out, /iface br0 inet dhcp\n {4}bridge_ports enp5s0\n {4}bridge_hw 04:7c:16:aa:bb:cc\n {4}hwaddress ether 04:7c:16:aa:bb:cc\n/);
  assert.deepEqual(nw.upNames('auto lo\niface lo inet loopback\n\nallow-hotplug enp5s0\niface enp5s0 inet dhcp\n\nauto br1\n'), ['enp5s0', 'br1']);
});

test('a card or bridge with a cable that ifupdown left down is brought up; a down link is switched on first', () => {
  const nw = require('../lib/network');
  const text = `auto lo
iface lo inet loopback

iface enp5s0 inet manual

auto br0
iface br0 inet dhcp
    bridge_ports enp5s0

allow-hotplug enp6s0
iface enp6s0 inet dhcp

allow-hotplug enp7s0
iface enp7s0 inet dhcp
`;
  assert.deepEqual([...nw.parseIfState('lo=lo\nenp6s0=enp6s0\n')], ['lo', 'enp6s0']);
  const cables = { enp5s0: true, enp6s0: true, enp7s0: null };
  const plan = nw.cardsToBringUp(text, nw.parseIfState('lo=lo\nenp6s0=enp6s0\n'), (d) => cables[d]);
  assert.deepEqual(plan, { up: ['br0'], wake: ['enp7s0'] }); // enp6s0 is already up
  assert.deepEqual(nw.cardsToBringUp(text, new Set(['br0', 'enp6s0']), (d) => (d === 'enp7s0' ? false : true)), { up: [], wake: [] });
});

test('a bridge from before: the card\'s MAC address is added once', () => {
  const nw = require('../lib/network');
  const old = `auto lo
iface lo inet loopback

iface enp5s0 inet manual

auto br0
iface br0 inet dhcp
    bridge_ports enp5s0
    bridge_stp off
    bridge_fd 0
`;
  const r = nw.addBridgeMacs(old, (d) => ({ enp5s0: '04:7C:16:AA:BB:CC' })[d]);
  assert.deepEqual(r.bridges, ['br0']);
  assert.match(r.text, /bridge_ports enp5s0\n {4}bridge_hw 04:7c:16:aa:bb:cc\n {4}hwaddress ether 04:7c:16:aa:bb:cc\n {4}bridge_stp off\n/);
  assert.deepEqual(nw.addBridgeMacs(r.text, () => '04:7c:16:aa:bb:cc').bridges, []); // already done
  assert.deepEqual(nw.addBridgeMacs(old.replace('bridge_ports enp5s0', 'bridge_ports enp5s0 enp6s0'), () => '04:7c:16:aa:bb:cc').bridges, []); // several cards: left alone
});

test('reset: the card behind the default route (also through a bridge) goes in br0, the others get DHCP', () => {
  const nw = require('../lib/network');
  const links = [
    { name: 'enp5s0', mac: '04:7c:16:aa:bb:cc', up: true, kind: 'ethernet', master: 'br0', gateway: null },
    { name: 'enp6s0', mac: '04:7c:16:aa:bb:dd', up: true, kind: 'ethernet', master: null, gateway: null },
    { name: 'br0', mac: 'fe:12:34:56:78:9a', up: true, kind: 'bridge', master: null, gateway: '192.168.1.1' },
  ];
  const { home, text } = nw.resetPlan(['enp5s0', 'enp6s0'], links);
  assert.equal(home, 'enp5s0');
  assert.match(text, /^# Reset by MajaOS/);
  assert.match(text, /auto br0\niface br0 inet dhcp\n {4}bridge_ports enp5s0\n {4}bridge_hw 04:7c:16:aa:bb:cc\n/); // the card's MAC, not the bridge's
  assert.match(text, /allow-hotplug enp6s0\niface enp6s0 inet dhcp/);
  // No route anywhere: the first card that is up.
  assert.equal(nw.resetPlan(['enp5s0', 'enp6s0'], [{ name: 'enp5s0', up: false }, { name: 'enp6s0', up: true }]).home, 'enp6s0');
});

test('per card: the bridge it is in, its own stanza, or nothing', () => {
  const nw = require('../lib/network');
  const text = `auto lo
iface lo inet loopback

iface enp5s0 inet manual

auto br0
iface br0 inet static
    bridge_ports enp5s0
    address 192.168.1.10
    netmask 255.255.255.0
    gateway 192.168.1.1
    dns-nameservers 192.168.1.1 1.1.1.1

allow-hotplug enp6s0
iface enp6s0 inet dhcp
`;
  const c = nw.cardConfigs(nw.parseInterfaces(text), ['enp5s0', 'enp6s0', 'enp7s0']);
  assert.deepEqual(c.enp5s0, { mode: 'static', address: '192.168.1.10/24', gateway: '192.168.1.1', dns: ['192.168.1.1', '1.1.1.1'], bridge: true, bridgeName: 'br0' });
  assert.deepEqual(c.enp6s0, { mode: 'dhcp', address: '', gateway: '', dns: [], bridge: false, bridgeName: 'br0' });
  assert.equal(c.enp7s0, null);
});

test('DHCP with own DNS servers: in the file, and dhcpcd leaves resolv.conf alone', () => {
  const nw = require('../lib/network');
  const cfg = nw.validate({ interface: 'enp5s0', mode: 'dhcp', dns: '1.1.1.1, 9.9.9.9', bridge: false }, ['enp5s0']);
  const out = nw.buildInterfaces(cfg, 'auto lo\niface lo inet loopback\n');
  assert.match(out, /iface enp5s0 inet dhcp\n {4}dns-nameservers 1\.1\.1\.1 9\.9\.9\.9\n/);
  assert.deepEqual(nw.cardConfigs(nw.parseInterfaces(out), ['enp5s0']).enp5s0.dns, ['1.1.1.1', '9.9.9.9']);
  const plain = nw.buildInterfaces(nw.validate({ interface: 'enp5s0', mode: 'dhcp', dns: '' }, ['enp5s0']), 'auto lo\n');
  assert.doesNotMatch(plain, /dns-nameservers/);
  const conf = 'hostname\nclientid\nnohook hostname\n';
  const on = nw.dhcpcdConf(conf, true);
  assert.match(on, /nohook hostname\n# MajaOS: own DNS servers \(Settings > Network\)\nnohook resolv\.conf\n$/);
  assert.equal(nw.dhcpcdConf(on, true), on); // only once
  assert.equal(nw.dhcpcdConf(on, false), conf); // back as it was
});

test('changing a second card keeps the bridge of the first, and gives the second allow-hotplug', () => {
  const start = 'auto lo\niface lo inet loopback\n\niface enp5s0 inet manual\n\nauto br0\niface br0 inet dhcp\n    bridge_ports enp5s0\n    bridge_hw 9c:6b:00:f4:8b:9b\n    hwaddress ether 9c:6b:00:f4:8b:9b\n    bridge_stp off\n    bridge_fd 0\n    dns-nameservers 1.1.1.1\n';
  const out = nw.buildInterfaces(nw.validate({ interface: 'enp4s0', mode: 'dhcp', bridge: false }, ['enp4s0', 'enp5s0']), start);
  assert.match(out, /allow-hotplug enp4s0\niface enp4s0 inet dhcp\n/);
  assert.match(out, /auto br0\niface br0 inet dhcp\n {4}bridge_ports enp5s0\n {4}bridge_hw 9c:6b:00:f4:8b:9b/);
  assert.match(out, /iface enp5s0 inet manual/);
  assert.deepEqual(nw.bridgePorts(nw.parseInterfaces(out), 'br0'), ['enp5s0']);
  // Both cards read back as before.
  const cards = nw.cardConfigs(nw.parseInterfaces(out), ['enp4s0', 'enp5s0']);
  assert.equal(cards.enp4s0.mode, 'dhcp'); assert.equal(cards.enp4s0.bridge, false);
  assert.equal(cards.enp5s0.bridge, true); assert.deepEqual(cards.enp5s0.dns, ['1.1.1.1']);
});

test('every card gets DHCP by default, unless something uses it', () => {
  const text = `auto lo
iface lo inet loopback

iface enp5s0 inet manual

auto br0
iface br0 inet dhcp
    bridge_ports enp5s0
    bridge_stp off

iface enp4s0 inet manual

iface enp6s0 inet manual
    bond-master bond0

iface enp7s0 inet manual

auto enp7s0.10
iface enp7s0.10 inet dhcp
`;
  const r = nw.addDhcpCards(text, ['enp4s0', 'enp5s0', 'enp6s0', 'enp7s0', 'enp8s0']);
  assert.deepEqual(r.added, ['enp4s0', 'enp8s0']); // not the bridge port, the bond slave or the VLAN parent
  assert.match(r.text, /allow-hotplug enp4s0\niface enp4s0 inet dhcp\n/);
  assert.match(r.text, /allow-hotplug enp8s0\niface enp8s0 inet dhcp\n$/);
  assert.match(r.text, /iface enp5s0 inet manual\n/);
  assert.doesNotMatch(r.text, /iface enp4s0 inet manual/);
  const cards = nw.cardConfigs(nw.parseInterfaces(r.text), ['enp4s0', 'enp5s0', 'enp8s0']);
  assert.equal(cards.enp4s0.mode, 'dhcp'); assert.equal(cards.enp8s0.mode, 'dhcp'); assert.equal(cards.enp5s0.bridge, true);
  assert.deepEqual(nw.upNames(r.text).filter((n) => /enp[48]/.test(n)), ['enp4s0', 'enp8s0']);
  // Nothing to do: the same text back.
  assert.deepEqual(nw.addDhcpCards(r.text, ['enp4s0', 'enp8s0']), { text: r.text, added: [] });
});

const BR0 = `auto lo
iface lo inet loopback

iface enp5s0 inet manual

auto br0
iface br0 inet static
    bridge_ports enp5s0
    bridge_hw 9c:6b:00:f4:8b:9b
    hwaddress ether 9c:6b:00:f4:8b:9b
    bridge_stp off
    bridge_fd 0
    address 10.10.10.152/24
    gateway 10.10.10.1
    dns-nameservers 10.10.10.1

allow-hotplug enp4s0
iface enp4s0 inet dhcp

allow-hotplug wlp3s0
iface wlp3s0 inet dhcp
    wpa-ssid Thuis
`;

test('ports used together: a bond under br0 with the same address and MAC, and back', () => {
  const on = nw.buildBond(BR0, { enabled: true, cards: ['enp5s0', 'enp4s0'], mac: '9C:6B:00:F4:8B:9B' });
  assert.match(on, /auto bond0\niface bond0 inet manual\n {4}bond-slaves enp5s0 enp4s0\n {4}bond-mode active-backup\n {4}bond-miimon 100\n/);
  assert.match(on, /auto br0\niface br0 inet static\n {4}bridge_ports bond0\n {4}bridge_hw 9c:6b:00:f4:8b:9b\n {4}hwaddress ether 9c:6b:00:f4:8b:9b\n {4}bridge_stp off\n {4}bridge_fd 0\n {4}address 10\.10\.10\.152\/24\n {4}gateway 10\.10\.10\.1\n {4}dns-nameservers 10\.10\.10\.1\n/);
  assert.ok(on.indexOf('iface bond0') < on.indexOf('iface br0')); // the bond exists before the bridge takes it
  assert.doesNotMatch(on, /iface enp4s0|iface enp5s0/);
  assert.match(on, /iface wlp3s0 inet dhcp\n {4}wpa-ssid Thuis/); // other settings stay
  assert.deepEqual(nw.bondInFile(nw.parseInterfaces(on)), { name: 'bond0', cards: ['enp5s0', 'enp4s0'] });
  // Each card shows br0's settings, and that it is in the bond; nothing gives them DHCP of their own.
  const cards = nw.cardConfigs(nw.parseInterfaces(on), ['enp4s0', 'enp5s0']);
  assert.equal(cards.enp4s0.bond, 'bond0'); assert.equal(cards.enp4s0.mode, 'static'); assert.equal(cards.enp5s0.bridge, true);
  assert.deepEqual(nw.addDhcpCards(on, ['enp4s0', 'enp5s0']).added, []);
  assert.deepEqual(nw.cardsBehind(nw.parseInterfaces(on), 'br0'), ['enp5s0', 'enp4s0']);
  assert.deepEqual(nw.upNames(on).slice(0, 2), ['bond0', 'br0']);
  // Changing the address through a card in the bond keeps the bond.
  const dhcp = nw.buildInterfaces({ ...nw.validate({ interface: 'bond0', mode: 'dhcp', bridge: true }, ['bond0']), mac: '9c:6b:00:f4:8b:9b' }, on);
  assert.match(dhcp, /iface bond0 inet manual\n {4}bond-slaves enp5s0 enp4s0/);
  assert.match(dhcp, /iface br0 inet dhcp\n {4}bridge_ports bond0\n/);
  assert.ok(dhcp.indexOf('iface bond0') < dhcp.indexOf('iface br0'));
  assert.equal((dhcp.match(/iface bond0/g) || []).length, 1);
  // Off: br0 on the card that carried the traffic, the other card DHCP again.
  const off = nw.buildBond(on, { enabled: false, cards: [], mac: '00:e0:4c:01:40:dd', primary: 'enp4s0' });
  assert.match(off, /iface enp4s0 inet manual\n\nauto br0\niface br0 inet static\n {4}bridge_ports enp4s0\n {4}bridge_hw 00:e0:4c:01:40:dd/);
  assert.match(off, /allow-hotplug enp5s0\niface enp5s0 inet dhcp/);
  assert.doesNotMatch(off, /bond/);
  assert.match(off, /address 10\.10\.10\.152\/24/);
});

test('reading /proc/net/bonding', () => {
  const st = nw.parseBonding(`Ethernet Channel Bonding Driver: v6.12.0

Bonding Mode: fault-tolerance (active-backup)
Primary Slave: None
Currently Active Slave: enp4s0
MII Status: up
MII Polling Interval (ms): 100

Slave Interface: enp5s0
MII Status: down
Speed: Unknown
Permanent HW addr: 9c:6b:00:f4:8b:9b

Slave Interface: enp4s0
MII Status: up
Speed: 1000 Mbps
Permanent HW addr: 00:e0:4c:01:40:dd
`);
  assert.deepEqual(st, { mode: 'fault-tolerance (active-backup)', active: 'enp4s0',
    slaves: [{ name: 'enp5s0', up: false, speed: null }, { name: 'enp4s0', up: true, speed: 1000 }] });
  assert.deepEqual(nw.parseBonding(''), { mode: null, active: null, slaves: [] });
});

test('switching files: ifdown sees the old file, ifup the new one, and a bridge port keeps no address', () => {
  const { execFileSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'majaos-net-'));
  const bin = path.join(tmp, 'bin'), sys = path.join(tmp, 'sys'), file = path.join(tmp, 'interfaces'), log = path.join(tmp, 'log');
  fs.mkdirSync(bin); fs.mkdirSync(path.join(sys, 'enp4s0'), { recursive: true });
  fs.writeFileSync(path.join(sys, 'enp4s0', 'carrier'), '1\n');
  // Each tool logs its arguments and what the file says about enp4s0 right then.
  for (const tool of ['ifdown', 'ifup', 'dhclient', 'dhcpcd']) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $* [$(grep '^iface enp4s0' '${file}')]" >> '${log}'\n`, { mode: 0o755 });
  }
  // ip: enp4s0 still has an address of its own (a DHCP client that kept running) until it is flushed.
  fs.writeFileSync(path.join(bin, 'ip'), `#!/bin/sh\necho "ip $*" >> '${log}'\ncase "$*" in *"-j -4 addr show dev enp4s0"*) echo '[{"ifname":"enp4s0","addr_info":[{"family":"inet","local":"10.10.10.158"}]}]';; *-j*) echo '[]';; esac\n`, { mode: 0o755 });
  fs.writeFileSync(file, 'auto lo\niface lo inet loopback\n\nallow-hotplug enp4s0\niface enp4s0 inet dhcp\n');
  const next = 'auto lo\niface lo inet loopback\n\niface enp4s0 inet manual\n\nauto br0\niface br0 inet dhcp\n    bridge_ports enp4s0\n';
  const script = `require(${JSON.stringify(path.resolve(__dirname, '../lib/network.js'))}).reload(['enp4s0', 'br0'], ${JSON.stringify(next)}).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });`;
  execFileSync(process.execPath, ['-e', script], { env: { ...process.env, PATH: bin + ':' + process.env.PATH, NET_INTERFACES_FILE: file, SYS_NET_DIR: sys, DATA_DIR: tmp } });
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  assert.match(lines[at(/^ifdown --force enp4s0/)], /iface enp4s0 inet dhcp/); // the old file: DHCP is taken down
  assert.match(lines[at(/^dhclient -x -pf \/run\/dhclient\.enp4s0\.pid enp4s0/)], /inet dhcp/);
  assert.match(lines[at(/^ifup br0/)], /iface enp4s0 inet manual/); // the new file
  assert.ok(at(/^ifdown --force enp4s0/) < at(/^ifup br0/));
  assert.ok(at(/^ip -4 addr flush dev enp4s0/) > at(/^ifup br0/)); // the port's own address removed afterwards
  assert.equal(fs.readFileSync(file, 'utf8'), next);
  assert.deepEqual(nw.portsIn(next), ['enp4s0']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a bridge the settings no longer have, and a card still stuck in it', () => {
  const file = 'auto lo\niface lo inet loopback\n\nauto enp4s0\niface enp4s0 inet dhcp\n\nallow-hotplug enp5s0\niface enp5s0 inet dhcp\n';
  // br0 removed from the file while ifdown no longer knew it: br0 stays in the kernel with enp4s0 in it.
  const kernel = [{ name: 'lo', master: null, kind: null }, { name: 'enp4s0', master: 'br0', kind: null }, { name: 'enp5s0', master: null, kind: null },
    { name: 'br0', master: null, kind: 'bridge' }, { name: 'docker0', master: null, kind: 'bridge' }, { name: 'vethab12', master: 'docker0', kind: null },
    { name: 'virbr0', master: null, kind: 'bridge' }, { name: 'vnet0', master: 'virbr0', kind: null }];
  assert.deepEqual(nw.strayPlan(file, kernel), { detach: [], remove: ['br0'] }); // removing br0 frees enp4s0
  // In another bridge that isn't ours (made by hand): only the card comes out.
  const k2 = kernel.map((l) => (l.name === 'enp4s0' ? { ...l, master: 'brx' } : l)).concat([{ name: 'brx', master: null, kind: 'bridge' }]);
  assert.deepEqual(nw.strayPlan(file, k2), { detach: ['enp4s0'], remove: ['br0'] });
  // What the file wants stays: br0 with enp4s0, and a bond under it.
  const br = 'auto lo\niface lo inet loopback\n\niface enp4s0 inet manual\n\nauto br0\niface br0 inet dhcp\n    bridge_ports enp4s0\n';
  assert.deepEqual(nw.strayPlan(br, kernel), { detach: [], remove: [] });
  const bond = nw.buildBond(br, { enabled: true, cards: ['enp4s0', 'enp5s0'], mac: '00:e0:4c:01:40:dd' });
  const kb = [{ name: 'enp4s0', master: 'bond0', kind: null }, { name: 'enp5s0', master: 'bond0', kind: null }, { name: 'bond0', master: 'br0', kind: 'bond' }, { name: 'br0', master: null, kind: 'bridge' }];
  assert.deepEqual(nw.strayPlan(bond, kb), { detach: [], remove: [] });
});
