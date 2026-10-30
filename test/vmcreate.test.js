'use strict';
/* A new VM: the operating system decides the hardware, Advanced can change it, and old requests (kind) keep working. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { vmHardware, VM_OS_IDS, defaultVmNetwork } = require('../lib/vms');

test('new VMs default to br0 when it exists, otherwise to libvirt NAT', () => {
  const nets = [{ name: 'default' }];
  assert.equal(defaultVmNetwork([{ name: 'br0' }], nets, 'network=default'), 'bridge:br0');
  assert.equal(defaultVmNetwork([], nets, 'network=default'), 'network:default');
  assert.equal(defaultVmNetwork([{ name: 'br0' }], [...nets, { name: 'lab' }], 'network=lab'), 'network:lab');
  assert.equal(defaultVmNetwork([{ name: 'br0' }], nets, 'bridge=missing'), 'bridge:br0');
});

test('each operating system gets hardware its installer understands', () => {
  assert.deepEqual(vmHardware({ os: 'debian' }), { os: 'debian', media: 'iso', osinfo: 'debian13', fallback: 'linux2022', firmware: 'uefi', bus: 'virtio', nic: 'virtio', tpm: false });
  const win = vmHardware({ os: 'windows11' });
  assert.equal(win.bus, 'sata'); assert.equal(win.nic, 'e1000e'); assert.equal(win.tpm, true);
  assert.equal(vmHardware({ os: 'haos' }).media, 'disk'); // Home Assistant OS is a disk image
  assert.equal(vmHardware({ os: 'other' }).osinfo, 'detect=on,require=off');
  assert.equal(vmHardware({ os: 'other' }).bus, 'sata');
});

test('Advanced changes the firmware, disk bus, network card and TPM, within limits', () => {
  const hw = vmHardware({ os: 'windows10', firmware: 'bios', bus: 'virtio', nic: 'virtio', tpm: true, media: 'disk' });
  assert.deepEqual([hw.firmware, hw.bus, hw.nic, hw.tpm, hw.media], ['bios', 'virtio', 'virtio', true, 'disk']);
  assert.equal(vmHardware({ os: 'windows11', tpm: false }).tpm, false);
  assert.throws(() => vmHardware({ os: 'macos' }), /operating system/);
  assert.throws(() => vmHardware({ os: '__proto__' }), /operating system/);
  assert.throws(() => vmHardware({ os: 'linux', firmware: 'coreboot' }), /UEFI or BIOS/);
  assert.throws(() => vmHardware({ os: 'linux', bus: 'ide' }), /VirtIO or SATA/);
  assert.throws(() => vmHardware({ os: 'linux', nic: 'ne2k' }), /network card/);
  assert.throws(() => vmHardware({ os: 'linux', media: 'usb' }), /ISO or an existing disk/);
});

test('requests from before the list of systems still work', () => {
  assert.equal(vmHardware({ kind: 'windows' }).os, 'windows11');
  assert.equal(vmHardware({ kind: 'import' }).media, 'disk');
  assert.equal(vmHardware({ kind: 'linux' }).bus, 'virtio');
});

test('the browser offers the same systems the server knows', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const block = app.slice(app.indexOf('const VM_OS = ['), app.indexOf('const VM_FAMILY'));
  const ids = [...block.matchAll(/\{ id: '([a-z0-9]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, [...VM_OS_IDS].sort());
});
