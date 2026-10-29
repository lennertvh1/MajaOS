'use strict';
/* Tests for the disk bays: key per disk and checking the layout. */
const test = require('node:test');
const assert = require('node:assert/strict');
const bays = require('../lib/bays');

test('recognise a disk by serial number, otherwise by name', () => {
  assert.equal(bays.diskKey({ name: 'sda', serial: 'WD-WX12A3456789 ' }), 's:WD-WX12A3456789');
  assert.equal(bays.diskKey({ name: 'vda', serial: null }), 'n:vda');
});

test('checking the layout', () => {
  const ok = bays.validateBays({ count: 4, columns: 2, slots: { 1: { key: 's:A', label: 'WDC · A' }, 3: { key: 's:B' }, 6: { key: 's:C' } } });
  assert.deepEqual(ok, { count: 4, columns: 2, m2: 0, ssd: 0, slots: { 1: { key: 's:A', label: 'WDC · A' }, 3: { key: 's:B', label: '' } } }); // bay 6 no longer exists
  assert.throws(() => bays.validateBays({ count: 61, columns: 4 }), /between 0 and 60/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 0 }), /between 1 and 12/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, slots: { 1: { key: 's:A' }, 2: { key: 's:A' } } }), /only be in one bay/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, slots: { 1: { key: 'sda' } } }), /Unknown disk/);
});

test('M.2 slots for NVMe', () => {
  const ok = bays.validateBays({ count: 4, columns: 4, m2: 2, slots: { 1: { key: 's:A' }, m1: { key: 's:N1' }, m2: { key: 's:N2' }, m3: { key: 's:N3' } } });
  assert.deepEqual(Object.keys(ok.slots), ['1', 'm1', 'm2']); // m3 doesn't exist
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, m2: 9 }), /between 0 and 8 M\.2/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, m2: 2, slots: { 1: { key: 's:A' }, m1: { key: 's:A' } } }), /only be in one bay/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, m2: 2, slots: { m1: { key: 'x' } } }), /Unknown disk in M\.2 slot 1/);
});

test('2.5" slots for SSDs', () => {
  const ok = bays.validateBays({ count: 4, columns: 4, m2: 1, ssd: 2, slots: { 2: { key: 's:A' }, s1: { key: 's:S1' }, s2: { key: 's:S2' }, s3: { key: 's:S3' }, m1: { key: 's:N' } } });
  assert.deepEqual(Object.keys(ok.slots).sort(), ['2', 'm1', 's1', 's2']);
  assert.equal(ok.ssd, 2);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, ssd: 17 }), /between 0 and 16 2\.5"/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, ssd: 1, slots: { s1: { key: '?' } } }), /2\.5" slot 1/);
});

test('new disks in the drawing: the bay of a replaced disk, otherwise the first free bay of their kind', () => {
  const hdd = (name, serial) => ({ name, serial, model: 'WDC', rotational: true, transport: 'sata' });
  const base = { count: 4, columns: 4, m2: 1, ssd: 1, slots: { 1: { key: 's:A' }, 2: { key: 's:B' }, 3: { key: 's:C' } } };
  // The first time it only remembers what is there.
  let r = bays.placeNew(base, [hdd('sda', 'A'), hdd('sdb', 'B'), hdd('sdc', 'C'), hdd('sdd', 'LOOSE')]);
  assert.deepEqual(r.placed, []);
  assert.ok(r.changed);
  const cfg = r.cfg;
  // C is replaced by NEW: NEW takes bay 3, not the free bay 4.
  r = bays.placeNew(cfg, [hdd('sda', 'A'), hdd('sdb', 'B'), hdd('sdd', 'LOOSE'), hdd('sde', 'NEW')]);
  assert.deepEqual(r.placed, [{ name: 'sde', bay: '3' }]);
  assert.deepEqual(r.cfg.slots[3], { key: 's:NEW', label: 'WDC · NEW' });
  // A disk added next to them goes in the first free bay; an NVMe in the M.2 slot, a SATA SSD in the 2.5" slot.
  r = bays.placeNew(cfg, [hdd('sda', 'A'), hdd('sdb', 'B'), hdd('sdc', 'C'), hdd('sdd', 'LOOSE'), hdd('sdf', 'X'),
    { name: 'nvme0n1', serial: 'N', transport: 'nvme', rotational: false }, { name: 'sdg', serial: 'S', transport: 'sata', rotational: false }]);
  assert.deepEqual(r.placed, [{ name: 'sdf', bay: '4' }, { name: 'nvme0n1', bay: 'm1' }, { name: 'sdg', bay: 's1' }]);
  // A disk seen before (LOOSE, or one the user dragged out) is never put back; USB disks never go in a bay.
  assert.ok(!Object.values(r.cfg.slots).some((v) => v.key === 's:LOOSE'));
  r = bays.placeNew(cfg, [hdd('sda', 'A'), hdd('sdb', 'B'), hdd('sdc', 'C'), { name: 'sdh', serial: 'U', transport: 'usb', rotational: true }]);
  assert.deepEqual(r.placed, []);
  // Two new disks and one empty bay: unclear which one replaced it, so the empty bay keeps its old disk.
  r = bays.placeNew(cfg, [hdd('sda', 'A'), hdd('sdb', 'B'), hdd('sde', 'NEW1'), hdd('sdf', 'NEW2')]);
  assert.equal(r.cfg.slots[3].key, 's:C');
  assert.deepEqual(r.placed, [{ name: 'sde', bay: '4' }]);
  // Nothing new: nothing changes and nothing is written.
  assert.equal(bays.placeNew(cfg, [hdd('sda', 'A')]).changed, false);
});
