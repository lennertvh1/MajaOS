'use strict';
/* VM snapshots: deleting one of a VM that is off, merged with qemu-img instead of a QEMU that libvirt starts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { offlinePlan, parseSnapshotXml } = require('../lib/vmsnap');

const D = '/TEST_POOL/vms/w11-tst/';
const snap = (name, parent, file) => ({ name, parent, disks: [{ name: 'vda', snapshot: 'external', file }] });

test('the current snapshot without later ones: merge the overlay into the disk below and point the VM to it', () => {
  const all = [snap('before_install', null, D + 'w11-tst.before_install')];
  const backing = new Map([[D + 'w11-tst.before_install', D + 'w11-tst.qcow2'], [D + 'w11-tst.qcow2', null]]);
  const plan = offlinePlan({ snap: all[0], all, domDisks: [{ target: 'vda', source: D + 'w11-tst.before_install' }], backing });
  assert.deepEqual(plan, [{ commit: D + 'w11-tst.before_install', into: D + 'w11-tst.qcow2', target: 'vda' }]);
});

test('a side branch nothing uses anymore: just remove its overlay', () => {
  // a → b (abandoned), then back to a and on: the VM now runs on c.
  const all = [snap('a', null, D + 'x.a'), snap('b', 'a', D + 'x.b'), snap('c', 'a', D + 'x.c')];
  const backing = new Map([[D + 'x.a', D + 'x.qcow2'], [D + 'x.b', D + 'x.a'], [D + 'x.c', D + 'x.r'], [D + 'x.r', D + 'x.qcow2'], [D + 'x.qcow2', null]]);
  const domDisks = [{ target: 'vda', source: D + 'x.c' }];
  assert.deepEqual(offlinePlan({ snap: all[1], all, domDisks, backing }), [{ remove: D + 'x.b' }]);
});

test('not safe: later snapshots, or another file builds on it, so libvirt does it', () => {
  const all = [snap('a', null, D + 'x.a'), snap('b', 'a', D + 'x.b')];
  const backing = new Map([[D + 'x.a', D + 'x.qcow2'], [D + 'x.b', D + 'x.a'], [D + 'x.qcow2', null]]);
  assert.equal(offlinePlan({ snap: all[0], all, domDisks: [{ target: 'vda', source: D + 'x.b' }], backing }), null); // a has a later snapshot
  // The disk below is shared with another branch: merging into it would change that branch.
  const shared = new Map([[D + 'y.s', D + 'y.base'], [D + 'y.other', D + 'y.base'], [D + 'y.base', null]]);
  const one = [snap('s', null, D + 'y.s')];
  assert.equal(offlinePlan({ snap: one[0], all: one, domDisks: [{ target: 'vda', source: D + 'y.s' }], backing: shared }), null);
});

test('a snapshot\'s memory file', () => {
  const s = parseSnapshotXml(`<domainsnapshot><name>live</name><state>running</state><creationTime>1700000000</creationTime>
    <memory snapshot='external' file='/tank/vms/ha/ha.live.mem'/><disks><disk name='vda' snapshot='external'><source file='/tank/vms/ha/ha.live'/></disk></disks></domainsnapshot>`);
  assert.equal(s.memFile, '/tank/vms/ha/ha.live.mem');
  assert.equal(s.memory, true);
  assert.equal(s.disks[0].file, '/tank/vms/ha/ha.live');
});
