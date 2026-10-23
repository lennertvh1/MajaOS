'use strict';
/* Tests for creating a pool: storage per layout, free disks and the zpool command. */
const test = require('node:test');
const assert = require('node:assert/strict');
const zp = require('../lib/zpool');

const TB = 1e12, GiB = 1073741824;
const slop = (u) => Math.min(Math.max(u / 32, 128 * 1048576), 128 * GiB);

test('storage per layout', () => {
  const four = [2 * TB, 2 * TB, 2 * TB, 2 * TB];
  const z1 = zp.capacity('raidz1', four);
  assert.equal(z1.raw, 8 * TB); assert.equal(z1.usable, 6 * TB - slop(6 * TB)); assert.equal(z1.redundancy, 2 * TB); assert.equal(z1.failures, 1);
  assert.equal(zp.capacity('raidz2', four).failures, 2);
  assert.equal(zp.capacity('raidz2', four).usable, 4 * TB - slop(4 * TB));
  assert.equal(zp.capacity('mirror', [512e9, 512e9]).usable, 512e9 - slop(512e9));
  assert.equal(zp.capacity('stripe', [1 * TB, 2 * TB]).usable, 3 * TB - slop(3 * TB));
  // Different sizes: RAID-Z counts the smallest disk, the rest stays unused.
  const mixed = zp.capacity('raidz1', [2 * TB, 2 * TB, 4 * TB]);
  assert.equal(mixed.unused, 2 * TB); assert.equal(mixed.usable, 4 * TB - slop(4 * TB));
  // Mirror pairs: large with large.
  const pairs = zp.capacity('mirrors', [4 * TB, 2 * TB, 4 * TB, 2 * TB]);
  assert.equal(pairs.usable, 6 * TB - slop(6 * TB)); assert.equal(pairs.unused, 0); assert.equal(pairs.redundancy, 6 * TB);
  assert.equal(zp.capacity('raidz1', four.slice(0, 2)), null); // too few disks
  assert.equal(zp.capacity('mirrors', four.slice(0, 3)), null); // odd
});

const LSBLK = { blockdevices: [
  { name: 'nvme0n1', type: 'disk', size: 512e9, rota: false, tran: 'nvme', model: 'Samsung SSD 980 ', serial: 'S1', children: [
    { name: 'nvme0n1p1', type: 'part', fstype: 'vfat', mountpoints: ['/boot/efi'] }, { name: 'nvme0n1p2', type: 'part', fstype: 'ext4', mountpoints: ['/'] }] },
  { name: 'sda', type: 'disk', size: 2e12, rota: true, tran: 'sata', model: 'WDC WD20EFZX', serial: 'A', children: [{ name: 'sda1', type: 'part', fstype: 'zfs_member', mountpoints: [null] }] },
  { name: 'sdb', type: 'disk', size: 2e12, rota: true, tran: 'sata', model: 'WDC WD20EFZX', serial: 'B', mountpoints: [null] },
  { name: 'sdc', type: 'disk', size: 2e12, rota: true, tran: 'sata', model: 'WDC WD20EFZX', serial: 'C', children: [{ name: 'sdc1', type: 'part', fstype: 'ntfs', mountpoints: [null] }] },
  { name: 'sdd', type: 'disk', size: 2e12, rota: true, tran: 'sata', model: 'WDC WD20EFZX', serial: 'D', children: [{ name: 'sdd1', type: 'part', fstype: 'zfs_member', mountpoints: [null] }] },
  { name: 'loop0', type: 'loop', size: 1e6 },
] };
const ctx = { poolDisks: new Map([['sdd', 'tank']]), byId: { sdb: '/dev/disk/by-id/ata-WDC_WD20EFZX_B', sda: '/dev/disk/by-id/ata-WDC_WD20EFZX_A' } };

test('recognising free disks', () => {
  const d = zp.classifyDisks(LSBLK, ctx);
  const by = Object.fromEntries(d.map((x) => [x.name, x]));
  assert.deepEqual(d.map((x) => x.name), ['sda', 'sdb', 'sdc', 'nvme0n1', 'sdd']);
  assert.equal(by.nvme0n1.available, false); assert.match(by.nvme0n1.reason, /System disk/);
  assert.equal(by.sdd.reason, 'In pool tank');
  assert.equal(by.sdb.available, true); assert.equal(by.sdb.warn, null); assert.equal(by.sdb.byId, '/dev/disk/by-id/ata-WDC_WD20EFZX_B');
  assert.match(by.sda.warn, /old ZFS pool/);
  assert.match(by.sdc.warn, /partitions \(ntfs\)/);
});

test('building and checking zpool create', () => {
  const opts = { disks: zp.classifyDisks(LSBLK, ctx), pools: ['tank'] };
  const args = zp.buildCreate({ name: 'data', layout: 'raidz1', disks: ['sda', 'sdb', 'sdc'], compression: 'zstd', confirm: 'data' }, opts);
  assert.deepEqual(args, ['create', '-f', '-o', 'ashift=12', '-O', 'compression=zstd', '-O', 'atime=off', '-O', 'xattr=sa', '-O', 'acltype=posixacl',
    '-m', '/data', 'data', 'raidz1', '/dev/disk/by-id/ata-WDC_WD20EFZX_A', '/dev/disk/by-id/ata-WDC_WD20EFZX_B', '/dev/sdc']);
  const bad = (b, re) => assert.throws(() => zp.buildCreate({ name: 'data', layout: 'mirror', disks: ['sda', 'sdb'], confirm: 'data', ...b }, opts), re);
  bad({ name: 'tank', confirm: 'tank' }, /already exists/);
  bad({ name: 'mirror0', confirm: 'mirror0' }, /Choose a name/);
  bad({ name: '1data', confirm: '1data' }, /Choose a name/);
  bad({ layout: 'raid5' }, /Choose a layout/);
  bad({ disks: ['sda', 'sdd'] }, /In pool tank/);
  bad({ disks: ['sda', 'nvme0n1'] }, /System disk/);
  bad({ disks: ['sda', 'sdz'] }, /no longer exists/);
  bad({ layout: 'raidz2' }, /at least 4/);
  bad({ confirm: 'Data' }, /Type the pool name/);
  const m = zp.buildCreate({ name: 'fast', layout: 'mirror', disks: ['sdb', 'sdc'], confirm: 'fast' }, opts);
  assert.deepEqual(m.slice(-4), ['fast', 'mirror', '/dev/disk/by-id/ata-WDC_WD20EFZX_B', '/dev/sdc']);
});
