'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sh = require('../lib/shadow');
const shares = require('../lib/shares');

const mounts = [
  { name: 'tank', mountpoint: '/tank' },
  { name: 'tank/media', mountpoint: '/tank/media' },
];

test('snapshot name is the GMT form Samba expects', () => {
  const t0 = new Date(Date.UTC(2026, 9, 24, 18, 5, 9));
  assert.equal(sh.snapName(t0), 'GMT-2026.10.24-18.05.09');
  assert.equal(sh.snapTime('GMT-2026.10.24-18.05.09'), t0.getTime());
  assert.equal(sh.snapTime('manual'), null);
});

test('Samba looks in .zfs/snapshot of the dataset that holds the folder', () => {
  assert.equal(sh.snapdir('/tank/media', mounts), '.zfs/snapshot');
  assert.equal(sh.snapdir('/tank/media/photos', mounts), '../.zfs/snapshot');
  assert.equal(sh.snapdir('/tank', mounts), '.zfs/snapshot');
  assert.equal(sh.snapdir('/etc', mounts), null);
  assert.deepEqual(sh.datasetsFor([{ path: '/tank/media' }, { path: '/tank/media/photos' }, { path: '/fast/x' }], mounts), ['tank/media']);
});

test('one snapshot per hour, then days and weeks, and the rest can go', () => {
  const now = new Date(Date.UTC(2026, 9, 24, 18, 30, 0));
  const snaps = [];
  for (let h = 0; h < 24 * 70; h++) {
    const time = now.getTime() - h * 3600000;
    const d = new Date(time);
    snaps.push({ name: sh.snapName(d), time });
  }
  const keep = sh.keepNames(snaps, now);
  assert.equal(sh.due(snaps, now), false);
  assert.equal(sh.due(snaps.filter((s) => s.time < now.getTime() - 3600000), now), true);
  // 24 hours + older days and weeks, not the whole 70 days.
  assert.ok(keep.size < 24 + 14 + 8);
  assert.ok(keep.size >= 24);
  const ancient = snaps[snaps.length - 1];
  assert.equal(keep.has(ancient.name), false);
  assert.equal(keep.has(snaps[0].name), true);
});

test('the share file points Windows at those snapshots', () => {
  const conf = shares.buildSmbConf([
    { name: 'media', path: '/tank/media', users: { lisa: 'rw' }, guest: false },
  ], { mounts });
  assert.match(conf, /vfs objects = catia fruit streams_xattr shadow_copy2/);
  assert.match(conf, /shadow:snapdir = \.zfs\/snapshot/);
  assert.match(conf, /shadow:format = GMT-%Y\.%m\.%d-%H\.%M\.%S/);
  const plain = shares.buildSmbConf([{ name: 'media', path: '/tank/media', users: { lisa: 'rw' } }]);
  assert.doesNotMatch(plain, /shadow_copy2/);
});
