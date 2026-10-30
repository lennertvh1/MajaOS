'use strict';
/* Tests for the hardware of VMs (domain XML), VM networks, devices of the server and the WebSocket for the console. */
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../lib/xml');
const hw = require('../lib/vmhw');
const vmnet = require('../lib/vmnet');
const wsock = require('../lib/websocket');

// As `virsh dumpxml --inactive` after virt-install (shortened).
const DOMAIN = `<domain type='kvm'>
  <name>Home Assistant OS</name>
  <memory unit='KiB'>4194304</memory>
  <currentMemory unit='KiB'>4194304</currentMemory>
  <vcpu placement='static'>2</vcpu>
  <os firmware='efi'>
    <type arch='x86_64' machine='pc-q35-10.0'>hvm</type>
    <boot dev='hd'/>
  </os>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' discard='unmap'/>
      <source file='/tank/vms/home-assistant-os/home-assistant-os.qcow2'/>
      <target dev='vda' bus='virtio'/>
      <address type='pci' domain='0x0000' bus='0x04' slot='0x00' function='0x0'/>
    </disk>
    <interface type='network'>
      <mac address='52:54:00:6b:3c:58'/>
      <source network='default'/>
      <model type='virtio'/>
      <address type='pci' domain='0x0000' bus='0x01' slot='0x00' function='0x0'/>
    </interface>
    <interface type='direct'>
      <mac address='52:54:00:aa:bb:cc'/>
      <source dev='enp5s0' mode='bridge'/>
    </interface>
    <graphics type='vnc' port='-1' autoport='yes' listen='0.0.0.0' passwd='geheim12'/>
  </devices>
</domain>
`;

test('XML: reading and writing unchanged gives back exactly the same', () => {
  assert.equal(X.toXml(X.parseXml(DOMAIN)) + '\n', DOMAIN);
  const tricky = `<a x="1 &amp; 2" y='it&apos;s'><!-- note --><b>&lt;text&gt;</b><c/></a>`;
  assert.equal(X.toXml(X.parseXml(tricky)), `<a x='1 &amp; 2' y='it&apos;s'><!-- note --><b>&lt;text&gt;</b><c/></a>`);
  assert.throws(() => X.parseXml('<a><b></a>'), /expected/);
});

test('reading hardware', () => {
  const h = hw.parseHardware(DOMAIN);
  assert.deepEqual(h.nics, [
    { mac: '52:54:00:6b:3c:58', type: 'network', source: 'default', model: 'virtio', locked: false },
    { mac: '52:54:00:aa:bb:cc', type: 'direct', source: 'enp5s0', model: null, locked: true }]);
  assert.deepEqual(h.disks, [{ target: 'vda', bus: 'virtio', source: '/tank/vms/home-assistant-os/home-assistant-os.qcow2', format: 'qcow2' }]);
  assert.deepEqual([h.cdroms, h.boot, h.hostdevs, h.cpuPins], [[], 'disk', [], []]);
});

test('writing hardware: network, disk, cd-rom, boot, devices and cores', () => {
  const out = hw.applyHardware(DOMAIN, {
    nics: [{ id: '52:54:00:6b:3c:58', type: 'bridge', source: 'br0', model: 'virtio', mac: '52:54:00:6b:3c:58' }, { id: '52:54:00:aa:bb:cc', locked: true },
      { type: 'network', source: 'labo', model: 'e1000e', mac: '52:54:00:01:02:03' }],
    addDisks: [{ file: '/tank/vms/ha/ha-2.qcow2', bus: 'virtio' }],
    cdrom: '/tank/isos/debian.iso', boot: 'cdrom',
    hostdevs: ['usb:10c4:ea60', 'pci:0000:0a:00.0'], cpuPins: [2, 10],
  });
  const h = hw.parseHardware(out);
  assert.deepEqual(h.nics.map((n) => [n.type, n.source, n.model, n.mac]),
    [['bridge', 'br0', 'virtio', '52:54:00:6b:3c:58'], ['direct', 'enp5s0', null, '52:54:00:aa:bb:cc'], ['network', 'labo', 'e1000e', '52:54:00:01:02:03']]);
  assert.match(out, /<interface type='bridge'>\n {6}<mac address='52:54:00:6b:3c:58'\/>\n {6}<source bridge='br0'\/>/);
  assert.match(out, /<address type='pci' domain='0x0000' bus='0x01'/); // the card's PCI slot stays
  assert.deepEqual(h.disks.map((d) => d.target), ['vda', 'vdb']);
  assert.deepEqual(h.cdroms.map((d) => [d.target, d.bus, d.source]), [['sda', 'sata', '/tank/isos/debian.iso']]);
  assert.equal(h.boot, 'cdrom');
  assert.doesNotMatch(out, /<boot dev=/);
  assert.deepEqual(h.hostdevs, ['usb:10c4:ea60', 'pci:0000:0a:00.0']);
  assert.match(out, /<vendor id='0x10c4'\/>/);
  assert.match(out, /<address domain='0x0000' bus='0x0a' slot='0x00' function='0x0'\/>/);
  assert.deepEqual(h.cpuPins, [2, 10]);
  assert.match(out, /<vcpu placement='static'>2<\/vcpu>\n {2}<cputune>\n {4}<vcpupin vcpu='0' cpuset='2'\/>\n {4}<vcpupin vcpu='1' cpuset='10'\/>\n {2}<\/cputune>/);
  // And back again: cd-rom empty, disk first, no devices, no pinned cores, disk detached.
  const back = hw.parseHardware(hw.applyHardware(out, { cdrom: null, boot: 'disk', hostdevs: [], cpuPins: [], removeDisks: ['vdb'] }));
  assert.deepEqual([back.cdroms[0].source, back.boot, back.hostdevs, back.cpuPins, back.disks.length], [null, 'disk', [], [], 1]);
  assert.doesNotMatch(hw.applyHardware(out, { cpuPins: [] }), /cputune/);
});

const OPTS = {
  networks: [{ name: 'default' }, { name: 'labo' }], bridges: [{ name: 'br0' }], isos: [{ name: 'debian.iso' }], isoDir: '/tank/isos',
  usb: [{ key: 'usb:10c4:ea60' }], pci: [{ key: 'pci:0000:0a:00.0' }], iommu: true, cpus: Array.from({ length: 16 }, (_, id) => ({ id })),
};
test('checking hardware', () => {
  const cur = hw.parseHardware(DOMAIN);
  const ok = hw.validateHardware({ nics: [{ id: '52:54:00:6b:3c:58', type: 'bridge', source: 'br0', model: 'virtio', mac: '52:54:00:6B:3C:58' }],
    boot: 'disk', cdrom: 'debian.iso', hostdevs: ['usb:10c4:ea60'], cpuPins: [10, 2] }, OPTS, cur);
  assert.deepEqual(ok, { nics: [{ id: '52:54:00:6b:3c:58', type: 'bridge', source: 'br0', model: 'virtio', mac: '52:54:00:6b:3c:58' }],
    cdrom: '/tank/isos/debian.iso', hostdevs: ['usb:10c4:ea60'], cpuPins: [2, 10] });
  assert.deepEqual(hw.validateHardware({ boot: 'disk', cdrom: '', hostdevs: [], cpuPins: [] }, OPTS, cur), {}); // nothing changed
  const bad = (b, re) => assert.throws(() => hw.validateHardware(b, OPTS, cur), re);
  bad({ nics: [{ type: 'network', source: 'gone' }] }, /does not exist/);
  bad({ nics: [{ type: 'bridge', source: 'br9' }] }, /bridge "br9"/);
  bad({ nics: [{ type: 'network', source: 'default', mac: '01:00:00:00:00:01' }] }, /not a valid MAC/);
  bad({ nics: [{ type: 'network', source: 'default', mac: '52:54:00:00:00:01' }, { type: 'network', source: 'default', mac: '52:54:00:00:00:01' }] }, /twice/);
  bad({ nics: [{ id: '52:54:00:ff:ff:ff', type: 'network', source: 'default' }] }, /no longer exists/);
  bad({ cdrom: 'windows.iso' }, /Choose an ISO/);
  bad({ hostdevs: ['usb:dead:beef'] }, /not plugged in/);
  assert.throws(() => hw.validateHardware({ hostdevs: ['pci:0000:0a:00.0'] }, { ...OPTS, iommu: false }, cur), /IOMMU/);
  bad({ cpuPins: [16] }, /cores that exist on the server/);
  bad({ cpuPins: [1, 1] }, /only be chosen once/);
  bad({ boot: 'net' }, /boots from/);
});

test('devices of the server: lsusb, lspci and CPU list', () => {
  assert.deepEqual(hw.parseLsusb('Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub\nBus 001 Device 004: ID 10c4:ea60 Silicon Labs CP210x UART Bridge\nBus 003 Device 002: ID 05e3:0610 Genesys Logic, Inc. Hub\n'),
    [{ key: 'usb:10c4:ea60', bus: 1, device: 4, vendor: '10c4', product: 'ea60', name: 'Silicon Labs CP210x UART Bridge' }]);
  assert.equal(hw.parseLsusb('Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub', { includeHubs: true }).length, 1);
  const pci = hw.summarizePci([
    { address: '0000:00:01.0', class: '060000', group: '0', driver: null },
    { address: '0000:0a:00.0', class: '030000', group: '14', driver: 'nvidia' },
    { address: '0000:0a:00.1', class: '040300', group: '14', driver: 'snd_hda_intel' },
    { address: '0000:0c:00.3', class: '0c0330', group: '17', driver: 'xhci_hcd' },
  ], '0000:0a:00.0 "VGA compatible controller" "NVIDIA Corporation" "GA104 [GeForce RTX 3060 Ti]" -ra1 "ASUSTeK Computer Inc." "Device 8817"\n' +
     '0000:0a:00.1 "Audio device" "NVIDIA Corporation" "GA104 High Definition Audio Controller" -ra1 "" ""\n' +
     '0000:0c:00.3 "USB controller" "Advanced Micro Devices, Inc. [AMD]" "Matisse USB 3.0 Host Controller" "" ""\n');
  assert.deepEqual(pci.map((p) => [p.key, p.kind, p.name, p.driver, p.groupDevices.map((g) => g.address)]), [
    ['pci:0000:0a:00.0', 'Display', 'NVIDIA GeForce RTX 3060 Ti', 'nvidia', ['0000:0a:00.1']],
    ['pci:0000:0a:00.1', 'Audio', 'NVIDIA GA104 High Definition Audio Controller', 'snd_hda_intel', ['0000:0a:00.0']],
    ['pci:0000:0c:00.3', 'USB', 'Advanced Micro Devices Matisse USB 3.0 Host Controller', 'xhci_hcd', []]]);
  const all = hw.summarizePci([
    { address: '0000:00:01.0', class: '060000', group: '0', driver: null },
    { address: '0000:0a:00.0', class: '030000', group: '14', driver: 'nvidia' },
  ], '0000:00:01.0 "Host bridge" "Advanced Micro Devices" "Root Complex"\n', { all: true });
  assert.deepEqual(all.map((p) => [p.address, p.kind, p.driver]), [
    ['0000:00:01.0', 'Host bridge', null], ['0000:0a:00.0', 'Display', 'nvidia']]);
  assert.deepEqual(hw.expandList('0,8'), [0, 8]);
  assert.deepEqual(hw.expandList('0-1,4'), [0, 1, 4]);
});

test('VM networks: reading, creating and checking', () => {
  assert.deepEqual(vmnet.parseNetXml(`<network>
  <name>default</name>
  <uuid>x</uuid>
  <forward mode='nat'><nat><port start='1024' end='65535'/></nat></forward>
  <bridge name='virbr0' stp='on' delay='0'/>
  <ip address='192.168.122.1' netmask='255.255.255.0'>
    <dhcp><range start='192.168.122.2' end='192.168.122.254'/></dhcp>
  </ip>
</network>`), { name: 'default', mode: 'nat', bridge: 'virbr0', hostBridge: null, address: '192.168.122.1', subnet: '192.168.122.0/24',
    dhcp: { start: '192.168.122.2', end: '192.168.122.254' } });
  const xml = vmnet.buildNetXml({ name: 'labo', mode: 'isolated', subnet: '10.10.0.0/24', dhcp: true });
  assert.equal(xml, `<network>
  <name>labo</name>
  <bridge stp='on' delay='0'/>
  <ip address='10.10.0.1' prefix='24'>
    <dhcp>
      <range start='10.10.0.128' end='10.10.0.254'/>
    </dhcp>
  </ip>
</network>`);
  assert.deepEqual(vmnet.parseNetXml(xml), { name: 'labo', mode: 'isolated', bridge: null, hostBridge: null, address: '10.10.0.1', subnet: '10.10.0.0/24',
    dhcp: { start: '10.10.0.128', end: '10.10.0.254' } });
  const ctx = { existing: [{ name: 'default', subnet: '192.168.122.0/24' }], hostSubnets: [{ name: 'br0', subnet: '192.168.1.0/24' }, { name: 'docker0', subnet: '172.17.0.0/16' }] };
  assert.deepEqual(vmnet.validateNet({ name: 'labo', mode: 'nat', subnet: '10.10.0.5/24' }, ctx), { name: 'labo', mode: 'nat', subnet: '10.10.0.0/24', dhcp: true });
  const bad = (b, re) => assert.throws(() => vmnet.validateNet({ name: 'labo', subnet: '10.10.0.0/24', ...b }, ctx), re);
  bad({ name: 'default' }, /already exists/);
  bad({ name: '' }, /Choose a name/);
  bad({ subnet: '8.8.8.0/24' }, /private subnet/);
  bad({ subnet: '10.0.0.0/8' }, /not a valid subnet/);
  bad({ subnet: '192.168.1.0/24' }, /overlaps with br0/);
  bad({ subnet: '172.17.5.0/24' }, /overlaps with docker0/);
  bad({ subnet: '192.168.122.128/25' }, /overlaps with default/);
});

test('WebSocket: reading frames (masked, in pieces) and writing them', () => {
  assert.equal(wsock.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='); // example from RFC 6455
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = (fin, op, data) => {
    const p = Buffer.from(data).map((b, i) => b ^ mask[i & 3]);
    const len = p.length < 126 ? Buffer.from([0x80 | p.length]) : Buffer.from([0x80 | 126, p.length >> 8, p.length & 255]);
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op]), len, mask, p]);
  };
  const r = new wsock.FrameReader();
  const big = Buffer.alloc(300, 7);
  const all = Buffer.concat([frame(false, 2, [1, 2]), frame(true, 0, [3]), frame(true, 9, []), frame(true, 2, big)]);
  const got = [...r.push(all.subarray(0, 5)), ...r.push(all.subarray(5, 20)), ...r.push(all.subarray(20))];
  assert.deepEqual(got.map((f) => [f.opcode, f.payload.length]), [[2, 3], [9, 0], [2, 300]]);
  assert.deepEqual([...got[0].payload], [1, 2, 3]);
  assert.deepEqual([...wsock.encodeFrame(2, Buffer.from([5, 6]))], [0x82, 2, 5, 6]);
  assert.deepEqual([...wsock.encodeFrame(2, Buffer.alloc(200)).subarray(0, 4)], [0x82, 126, 0, 200]);
});

test('WebSocket: passing on to a TCP port and back', async () => {
  const net = require('node:net'), http = require('node:http');
  const echo = net.createServer((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('>'), d]))));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const web = http.createServer();
  web.on('upgrade', (req, socket, head) => wsock.proxyToTcp(req, socket, head, echo.address().port));
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const reply = await new Promise((resolve, reject) => {
    const c = net.connect(web.address().port, '127.0.0.1', () => {
      c.write('GET /api/vms/x/vnc HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n\r\n');
      const mask = [9, 9, 9, 9], data = Buffer.from('RFB');
      c.write(Buffer.concat([Buffer.from([0x82, 0x80 | data.length, ...mask]), data.map((b, i) => b ^ mask[i & 3])]));
    });
    let buf = Buffer.alloc(0);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0 || buf.length < end + 4 + 2 + 4) return;
      resolve({ head: buf.subarray(0, end).toString(), frame: buf.subarray(end + 4) }); c.destroy();
    });
    c.on('error', reject);
  });
  web.close(); echo.close();
  assert.match(reply.head, /^HTTP\/1\.1 101/);
  assert.match(reply.head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  assert.match(reply.head, /Sec-WebSocket-Protocol: binary/);
  assert.deepEqual([...reply.frame], [0x82, 4, ...Buffer.from('>RFB')]);
});

test('sharing the clipboard (qemu-vdagent) on and off', () => {
  assert.equal(hw.parseHardware(DOMAIN).clipboard, false);
  const on = hw.applyHardware(DOMAIN, { clipboard: true });
  assert.match(on, /<channel type='qemu-vdagent'>\n {6}<source>\n {8}<clipboard copypaste='yes'\/>\n {8}<mouse mode='client'\/>\n {6}<\/source>\n {6}<target type='virtio' name='com.redhat.spice.0'\/>\n {4}<\/channel>/);
  assert.equal(hw.parseHardware(on).clipboard, true);
  assert.equal(hw.applyHardware(on, { clipboard: true }), on); // not twice
  assert.equal(hw.parseHardware(hw.applyHardware(on, { clipboard: false })).clipboard, false);
  assert.deepEqual(hw.validateHardware({ clipboard: true }, OPTS, hw.parseHardware(DOMAIN)), { clipboard: true });
  assert.deepEqual(hw.validateHardware({ clipboard: false }, OPTS, hw.parseHardware(DOMAIN)), {});
});

test('IP addresses of a VM (virsh domifaddr)', () => {
  const vms = require('../lib/vms');
  const agent = ` Name       MAC address          Protocol     Address
-------------------------------------------------------------------------------
 lo         00:00:00:00:00:00    ipv4         127.0.0.1/8
 -          -                    ipv6         ::1/128
 enp0s2     52:54:00:6b:3c:58    ipv4         192.168.1.40/24
 -          -                    ipv6         fd00::5054:ff:fe6b:3c58/64
 -          -                    ipv6         fe80::5054:ff:fe6b:3c58/64
 docker0    02:42:ac:11:00:01    ipv4         169.254.10.1/16
`;
  const list = vms.parseDomifaddr(agent);
  assert.equal(list.length, 6);
  assert.deepEqual(vms.usableIps(list), ['192.168.1.40', 'fd00::5054:ff:fe6b:3c58']);
  assert.deepEqual(vms.usableIps(vms.parseDomifaddr(' Name       MAC address          Protocol     Address\n----\n')), []);
});
