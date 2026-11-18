'use strict';
/* Creating a VM from an existing disk file: a copy, the file as it is, and a file chosen anywhere on a pool.
   virsh, qemu-img, virt-install and zfs are small scripts that log what they were asked. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-vmimport-')));
const pool = path.join(tmp, 'tank');
for (const d of ['isos', 'vms', 'downloads', 'vms/other']) fs.mkdirSync(path.join(pool, d), { recursive: true });
const LOG = path.join(tmp, 'calls.log');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const tool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node
const fs = require('fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, ${JSON.stringify(name)} + ' ' + JSON.stringify(args) + '\\n');
${body}
`, { mode: 0o755 });
const OTHER_DISK = path.join(pool, 'vms', 'other', 'other.qcow2');
const OTHER_FILE = path.join(tmp, 'other-disk.txt'); // the disk of the VM Other (a test can point it elsewhere)
fs.writeFileSync(OTHER_FILE, OTHER_DISK);
tool('zfs', `console.log('tank\\t' + ${JSON.stringify(pool)} + '\\t1000000000');`);
tool('virsh', `
const a = args.slice(2);
if (a[0] === 'list') console.log('Other');
else if (a[0] === 'dumpxml') console.log("<domain><name>Other</name><devices><disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='" + fs.readFileSync(${JSON.stringify(OTHER_FILE)}, 'utf8') + "'/><target dev='vda' bus='virtio'/></disk></devices></domain>");
else if (a[0] === 'domstate') { if (a[1] === 'Other') console.log('shut off'); else { console.error('error: failed to get domain ' + a[1]); process.exit(1); } }
`);
tool('qemu-img', `
if (args[0] === 'info') {
  const file = args[args.length - 1];
  const fmt = /\\.vmdk$/.test(file) ? 'vmdk' : /\\.raw$/.test(file) ? 'raw' : 'qcow2';
  const one = { filename: file, format: fmt };
  console.log(JSON.stringify(args.includes('--backing-chain') ? [one] : one));
} else if (args[0] === 'convert') fs.copyFileSync(args[args.length - 2], args[args.length - 1]);
else if (args[0] === 'dd') {
  // The first MiB as raw bytes: an MBR without an EFI partition for files with "bios" in their name, a GPT with
  // an EFI system partition for "efi", nothing (zeros) otherwise.
  const src = args.find((a) => a.startsWith('if=')).slice(3), out = args.find((a) => a.startsWith('of=')).slice(3);
  const buf = Buffer.alloc(1048576);
  if (/bios|efi/.test(src)) { buf[510] = 0x55; buf[511] = 0xaa; }
  if (/bios/.test(src)) buf[446 + 4] = 0x83;
  if (/efi/.test(src)) {
    buf[446 + 4] = 0xee;
    buf.write('EFI PART', 512, 'latin1'); buf.writeBigUInt64LE(2n, 512 + 72); buf.writeUInt32LE(128, 512 + 80); buf.writeUInt32LE(128, 512 + 84);
    Buffer.from('af3dc60f838472478e793d69d8477de4', 'hex').copy(buf, 1024); // Linux data first
    Buffer.from('28732ac11ff8d211ba4b00a0c93ec93b', 'hex').copy(buf, 1024 + 128); // then the EFI system partition
  }
  fs.writeFileSync(out, buf);
}
`);
tool('virt-install', '');
process.env.PATH = bin + path.delimiter + process.env.PATH;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.ISO_DIR = path.join(pool, 'isos');
process.env.VM_DIR = path.join(pool, 'vms');
fs.mkdirSync(process.env.DATA_DIR);

// No real networks or devices on a test machine.
const vmnet = require('../lib/vmnet');
vmnet.listVmNetworks = async () => ({ networks: [{ name: 'default', mode: 'nat', subnet: '192.168.122.0/24', active: true }], bridges: [] });
const vmhw = require('../lib/vmhw');
vmhw.usbDevices = async () => [];
vmhw.pciDevices = async () => ({ iommu: false, pci: [] });
const vms = require('../lib/vms');

const calls = () => fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => { const i = l.indexOf(' '); return { tool: l.slice(0, i), args: JSON.parse(l.slice(i + 1)) }; });
const reset = () => fs.writeFileSync(LOG, '');
const install = () => calls().find((c) => c.tool === 'virt-install');
const diskArg = () => { const a = install().args; return a[a.indexOf('--disk') + 1]; };
const base = { os: 'haos', media: 'disk', vcpus: 2, memoryGb: 2, network: 'network:default' };

fs.writeFileSync(path.join(pool, 'isos', 'haos.qcow2'), 'disk');
fs.writeFileSync(OTHER_DISK, 'other');
fs.writeFileSync(path.join(pool, 'downloads', 'old.raw'), 'raw');
fs.writeFileSync(path.join(pool, 'downloads', 'old.vmdk'), 'vmdk');

test('a disk file from the ISO folder is copied into the VM folder', async () => {
  reset();
  const r = await vms.createVm({ ...base, name: 'Copy', source: 'haos.qcow2' });
  assert.equal(r.inPlace, false);
  assert.equal(r.disk, path.join(pool, 'vms', 'copy', 'copy.qcow2'));
  assert.ok(calls().some((c) => c.tool === 'qemu-img' && c.args[0] === 'convert' && c.args.includes(path.join(pool, 'isos', 'haos.qcow2'))));
  assert.equal(diskArg(), `path=${r.disk},format=qcow2,bus=virtio`);
  assert.equal(fs.readFileSync(path.join(pool, 'isos', 'haos.qcow2'), 'utf8'), 'disk');
});

test('Use the file as it is: the file itself is the disk, nothing is copied', async () => {
  reset();
  const file = path.join(pool, 'isos', 'haos.qcow2');
  const r = await vms.createVm({ ...base, name: 'In place', source: 'haos.qcow2', inPlace: true });
  assert.equal(r.inPlace, true);
  assert.equal(r.disk, file);
  assert.ok(!calls().some((c) => c.tool === 'qemu-img' && c.args[0] === 'convert'));
  assert.equal(diskArg(), `path=${file},format=qcow2,bus=virtio`);
  assert.ok(!fs.existsSync(path.join(pool, 'vms', 'in-place')));
});

test('a raw file anywhere on a pool can be used as it is, a vmdk only as a copy', async () => {
  reset();
  const raw = path.join(pool, 'downloads', 'old.raw');
  const r = await vms.createVm({ ...base, name: 'Raw', source: raw, inPlace: true });
  assert.equal(diskArg(), `path=${raw},format=raw,bus=virtio`);
  assert.equal(r.disk, raw);
  const vmdk = path.join(pool, 'downloads', 'old.vmdk');
  await assert.rejects(vms.createVm({ ...base, name: 'Vmdk', source: vmdk, inPlace: true }), /Only a qcow2 or raw file can be used as it is \(this one is vmdk\)/);
  reset();
  const c = await vms.createVm({ ...base, name: 'Vmdk', source: vmdk });
  assert.ok(calls().some((x) => x.tool === 'qemu-img' && x.args[0] === 'convert' && x.args.includes(vmdk)));
  assert.equal(c.disk, path.join(pool, 'vms', 'vmdk', 'vmdk.qcow2'));
});

test('the disk of another VM is never used as it is, and files outside the pools are refused', async () => {
  await assert.rejects(vms.createVm({ ...base, name: 'Twice', source: OTHER_DISK, inPlace: true }), /already the disk of the VM Other/);
  // A copy of a VM that is off is fine (a clone).
  reset();
  await vms.createVm({ ...base, name: 'Clone', source: OTHER_DISK });
  assert.ok(calls().some((c) => c.tool === 'qemu-img' && c.args[0] === 'convert'));
  const outside = path.join(tmp, 'outside.qcow2');
  fs.writeFileSync(outside, 'x');
  await assert.rejects(vms.createVm({ ...base, name: 'Outside', source: outside }), /one of your pools/);
  fs.symlinkSync(path.join(pool, 'isos', 'haos.qcow2'), path.join(pool, 'downloads', 'link.qcow2'));
  await assert.rejects(vms.createVm({ ...base, name: 'Link', source: path.join(pool, 'downloads', 'link.qcow2') }), /not a folder or a link/);
  await assert.rejects(vms.createVm({ ...base, name: 'Iso', media: 'iso', os: 'debian', diskGb: 8, source: path.join(pool, 'downloads', 'old.raw') }), /Choose an ISO file/);
});

test('vmOptions marks the files a VM uses', async () => {
  const spare = path.join(pool, 'isos', 'spare.qcow2');
  fs.copyFileSync(OTHER_DISK, spare);
  fs.writeFileSync(OTHER_FILE, spare);
  try {
    const o = await vms.vmOptions();
    assert.deepEqual(o.images.map((f) => [f.name, f.usedBy]), [['haos.qcow2', null], ['spare.qcow2', 'Other']]);
  } finally { fs.writeFileSync(OTHER_FILE, OTHER_DISK); }
});

test('Automatic firmware: BIOS for a disk without an EFI partition, UEFI with one or when unknown', async () => {
  const fw = () => { const a = install().args; const i = a.indexOf('--boot'); return i < 0 ? 'bios' : a[i + 1].split(',')[0]; };
  fs.writeFileSync(path.join(pool, 'isos', 'kali-bios.qcow2'), 'x');
  fs.writeFileSync(path.join(pool, 'isos', 'debian-efi.qcow2'), 'x');
  reset();
  let r = await vms.createVm({ ...base, os: 'linux', name: 'Kali', source: 'kali-bios.qcow2' });
  assert.deepEqual([r.firmware, r.firmwareDetected, fw()], ['bios', 'bios', 'bios']);
  reset();
  r = await vms.createVm({ ...base, os: 'linux', name: 'Deb', source: 'debian-efi.qcow2' });
  assert.deepEqual([r.firmware, r.firmwareDetected, fw()], ['uefi', 'uefi', 'uefi']);
  reset();
  r = await vms.createVm({ ...base, os: 'linux', name: 'Unknown', source: 'haos.qcow2', firmware: 'auto' });
  assert.deepEqual([r.firmware, r.firmwareDetected], ['uefi', null]);
  // A choice of the user wins: no detection.
  reset();
  r = await vms.createVm({ ...base, os: 'linux', name: 'Forced', source: 'kali-bios.qcow2', firmware: 'uefi' });
  assert.deepEqual([r.firmware, r.firmwareDetected, fw()], ['uefi', null, 'uefi']);
  assert.ok(!calls().some((c) => c.tool === 'qemu-img' && c.args[0] === 'dd'));
});

test('parseBootSectors reads MBR and GPT', () => {
  const mbr = (type) => { const b = Buffer.alloc(4096); b[510] = 0x55; b[511] = 0xaa; b[446 + 4] = type; return b; };
  assert.equal(vms.parseBootSectors(Buffer.alloc(4096)), null);
  assert.equal(vms.parseBootSectors(mbr(0x83)), 'bios');
  assert.equal(vms.parseBootSectors(mbr(0xef)), 'uefi');
  assert.equal(vms.parseBootSectors(mbr(0)), null);
  // GPT on 4096-byte sectors, with only a Linux partition.
  const g = Buffer.alloc(65536); g[510] = 0x55; g[511] = 0xaa; g[446 + 4] = 0xee;
  g.write('EFI PART', 4096, 'latin1'); g.writeBigUInt64LE(2n, 4096 + 72); g.writeUInt32LE(4, 4096 + 80); g.writeUInt32LE(128, 4096 + 84);
  Buffer.from('af3dc60f838472478e793d69d8477de4', 'hex').copy(g, 8192);
  assert.equal(vms.parseBootSectors(g), 'bios');
  Buffer.from('28732ac11ff8d211ba4b00a0c93ec93b', 'hex').copy(g, 8192 + 128);
  assert.equal(vms.parseBootSectors(g), 'uefi');
});
