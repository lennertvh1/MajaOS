'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diskAlerts } = require('../lib/storage');

const disk = (name, serial, extra = {}) => ({ name, serial, model: 'WDC', pool: 'tank', state: 'ONLINE', errors: 0, smartOk: true, sectors: { pending: 0, uncorrectable: 0 }, ...extra });

test('a pulled disk is reported with its bay and serial', () => {
  const alerts = diskAlerts({
    status: [],
    disks: [disk('sda', 'AAA')],
    slots: { 1: { key: 's:AAA', label: 'WDC' }, 4: { key: 's:WD-WCC4N7VY1A2B', label: 'WDC WD20EFZX' } },
  });
  assert.deepEqual(alerts, [{
    kind: 'missing', pool: null, name: null, serial: 'WD-WCC4N7VY1A2B', model: 'WDC WD20EFZX', bay: '4', state: null,
  }]);
});

test('a missing pool disk and the empty bay are the same warning', () => {
  const alerts = diskAlerts({
    status: [{ name: 'tank', devices: [{ path: '/dev/sdb', disk: 'sdb', state: 'UNAVAIL', errors: 0, role: 'data' }] }],
    disks: [disk('sda', 'AAA')],
    slots: { 3: { key: 's:GONE', label: 'WDC WD20EFZX' }, 1: { key: 's:AAA', label: 'WDC' } },
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'missing');
  assert.equal(alerts[0].bay, '3');
  assert.equal(alerts[0].serial, 'GONE');
  assert.equal(alerts[0].pool, 'tank');
});

test('a faulted disk and a disk SMART can no longer trust are unhealthy', () => {
  const alerts = diskAlerts({
    status: [{ name: 'tank', devices: [
      { path: '/dev/sda', disk: 'sda', state: 'FAULTED', errors: 0, role: 'data' },
      { path: '/dev/sdb', disk: 'sdb', state: 'ONLINE', errors: 4, role: 'data' },
    ] }],
    disks: [
      disk('sda', 'AAA', { state: 'FAULTED' }),
      disk('sdb', 'BBB', { smartOk: false }),
    ],
    slots: { 1: { key: 's:AAA', label: 'WDC' }, 2: { key: 's:BBB', label: 'WDC' } },
  });
  const byName = Object.fromEntries(alerts.map((a) => [a.name, a]));
  assert.equal(byName.sda.kind, 'failing');
  assert.equal(byName.sda.bay, '1');
  assert.equal(byName.sda.serial, 'AAA');
  assert.equal(byName.sdb.kind, 'unhealthy');
  assert.equal(byName.sdb.bay, '2');
});

test('a healthy pool raises no disk warning', () => {
  assert.deepEqual(diskAlerts({
    status: [{ name: 'tank', devices: [{ path: '/dev/sda', disk: 'sda', state: 'ONLINE', errors: 0 }] }],
    disks: [disk('sda', 'AAA')],
    slots: { 1: { key: 's:AAA', label: 'WDC' } },
  }), []);
});
