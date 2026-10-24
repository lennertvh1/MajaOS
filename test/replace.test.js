'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planReplace, repairView } = require('../lib/replace');

const disk = (path, state) => ({ path, disk: path.replace(/^\/dev\//, ''), role: 'data', state, vdev: 'raidz1', errors: 0 });

test('one missing disk and one free disk large enough starts a rebuild', () => {
  const status = [{ name: 'tank', state: 'DEGRADED', scan: 'resilvered 1.2T in 0 days 03:00:00 with 0 errors on Sun Oct 12 2025', devices: [
    disk('/dev/sda', 'ONLINE'), disk('/dev/sdb', 'ONLINE'), disk('/dev/sdc', 'UNAVAIL'),
  ] }];
  const plan = planReplace({
    status, present: ['sda', 'sdb', 'sde'], available: [{ name: 'sde', size: 2e12, byId: '/dev/disk/by-id/ata-NEW' }],
    sizes: { sda: 2e12, sdb: 2e12, sde: 2e12 },
    bays: { slots: { 3: { key: 's:OLD' } }, presentKeys: new Set(['s:SDA', 's:SDB']) },
  });
  assert.equal(plan.replace.length, 1);
  assert.equal(plan.replace[0].neu, '/dev/disk/by-id/ata-NEW');
  assert.equal(plan.replace[0].old, '/dev/sdc');
  assert.equal(plan.replace[0].bay, '3');
  assert.equal(plan.waiting.length, 0);
  assert.equal(repairView(status, plan).state, 'replacing');
});

test('two free disks, a disk that is too small, or a rebuild already running: do not guess', () => {
  const status = [{ name: 'tank', state: 'DEGRADED', scan: 'none requested', devices: [disk('/dev/sda', 'ONLINE'), disk('/dev/sdb', 'UNAVAIL')] }];
  const two = planReplace({ status, present: ['sda', 'sde', 'sdf'], available: [{ name: 'sde', size: 2e12 }, { name: 'sdf', size: 2e12 }], sizes: { sda: 2e12 } });
  assert.equal(two.replace.length, 0);
  assert.equal(two.waiting[0].pool, 'tank');
  const small = planReplace({ status, present: ['sda', 'sde'], available: [{ name: 'sde', size: 5e11 }], sizes: { sda: 2e12 } });
  assert.equal(small.replace.length, 0);
  const running = [{ name: 'tank', state: 'DEGRADED', scan: 'resilver in progress since Tue Oct 21 21:00:01 2025 1.50T scanned at 1.16G/s, 412G issued at 310M/s 35.48% done, 00:12:10 to go', devices: [disk('/dev/sda', 'ONLINE'), disk('/dev/sdb', 'UNAVAIL')] }];
  const busy = planReplace({ status: running, present: ['sda', 'sde'], available: [{ name: 'sde', size: 2e12 }], sizes: { sda: 2e12 } });
  assert.equal(busy.replace.length, 0);
  assert.equal(busy.waiting.length, 0);
  assert.equal(repairView(running, busy).state, 'rebuilding');
  assert.equal(repairView(running, busy).progress, 35.48);
});

test('a disk that is still there but faulted asks to be replaced, it is not erased', () => {
  const status = [{ name: 'tank', state: 'DEGRADED', scan: 'none requested', devices: [disk('/dev/sda', 'ONLINE'), disk('/dev/sdb', 'FAULTED')] }];
  const plan = planReplace({ status, present: ['sda', 'sdb', 'sde'], available: [{ name: 'sde', size: 2e12, byId: '/dev/disk/by-id/ata-NEW' }], sizes: { sda: 2e12, sdb: 2e12 } });
  assert.equal(plan.replace.length, 0);
  assert.equal(plan.failing[0].disk, 'sdb');
  assert.equal(repairView(status, plan).state, 'failing');
});
