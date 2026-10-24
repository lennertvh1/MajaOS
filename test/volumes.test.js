'use strict';
/* Which folders and disks the file browser lists, and which disks may be ejected. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVolumes, buildPlaces, ejectTarget, ejectFailure, safeMount } = require('../lib/volumes');

const lsblk = {
  blockdevices: [
    { name: 'sda', type: 'disk', tran: 'sata', rm: false, children: [
      { name: 'sda1', fstype: 'ext4', mountpoints: ['/'] },
    ] },
    { name: 'sdb', type: 'disk', tran: 'usb', rm: true, model: 'Ultra Fit', children: [
      { name: 'sdb1', fstype: 'vfat', label: 'PHOTOS', uuid: 'ABCD-1234', mountpoints: ['/media/root/PHOTOS'] },
    ] },
    { name: 'sdc', type: 'disk', tran: 'usb', rm: false, model: 'DataTraveler', children: [
      { name: 'sdc1', fstype: 'exfat', uuid: '1111-2222', mountpoints: [null] },
    ] },
    { name: 'mmcblk0', type: 'disk', rm: true, hotplug: true, children: [
      { name: 'mmcblk0p1', fstype: 'vfat', uuid: 'EEEE-FFFF', mountpoints: [null] },
    ] },
    { name: 'mmcblk1', type: 'disk', rm: false, children: [
      { name: 'mmcblk1p1', fstype: 'ext4', mountpoints: ['/'] },
    ] },
    { name: 'sdd', type: 'disk', tran: 'usb', children: [
      { name: 'sdd1', fstype: 'zfs_member', mountpoints: [null] },
    ] },
  ],
};

test('parseVolumes keeps USB sticks and SD cards, not the system disk or a ZFS member', () => {
  const vols = parseVolumes(lsblk);
  assert.deepEqual(vols.map((v) => v.name), ['PHOTOS', 'USB drive', 'SD card']);
  assert.equal(vols[0].eject, true);
  assert.equal(vols[0].path, '/media/root/PHOTOS');
  assert.equal(vols[0].generic, false);
  assert.equal(vols[0].media, 'usb');
  assert.equal(vols[1].generic, true);
  assert.equal(vols[1].media, 'usb');
  assert.equal(vols[2].media, 'sd');
  assert.equal(vols[1].model, 'DataTraveler');
  assert.equal(vols[1].path, null);
  assert.equal(vols[2].dev, 'mmcblk0p1');
  assert.ok(vols.every((v) => v.id.startsWith('@d')));
});

test('buildPlaces shows datasets and system folders once, then disks', () => {
  const places = buildPlaces({
    shares: [{ name: 'media', path: '/tank/media' }],
    datasets: [
      { name: 'tank', mountpoint: '/tank' },
      { name: 'tank/media', mountpoint: '/tank/media' },
      { name: 'tank/photos', mountpoint: '/tank/photos' },
      { name: 'tank/backups', mountpoint: '/tank/backups' },
      { name: 'fast/appdata', mountpoint: '/fast/appdata' },
      { name: 'fast/docker', mountpoint: '/fast/docker' },
    ],
    dirs: { appdata: '/fast/appdata', vms: '/tank/vms', isos: '/tank/isos' },
    volumes: parseVolumes(lsblk),
  });
  const ids = places.map((p) => p.kind + ':' + p.name);
  assert.deepEqual(ids, [
    'share:media', 'folder:docker', 'folder:photos',
    'system:App data', 'system:VMs', 'system:ISOs', 'system:Backups',
    'disk:PHOTOS', 'disk:USB drive', 'disk:SD card',
  ]);
  assert.equal(places.find((p) => p.name === 'Backups').id, '@backups');
  assert.ok(!places.some((p) => p.path === '/tank'));
});

test('eject only unmounts a removable disk from a media folder', () => {
  const vol = parseVolumes(lsblk)[0];
  assert.deepEqual(ejectTarget(vol), { mount: '/media/root/PHOTOS', device: '/dev/sdb' });
  assert.equal(safeMount('/'), false);
  assert.equal(safeMount('/etc/passwd'), false);
  assert.throws(() => ejectTarget({ kind: 'disk', dev: '../etc', disk: 'sdb', path: '/media/x' }), /no longer connected/);
  assert.throws(() => ejectTarget({ kind: 'disk', dev: 'sdb1', disk: 'sdb', path: '/' }), /not allowed/);
  assert.equal(ejectFailure('umount: /media/root/PHOTOS: target is busy'), 'This disk is in use. Close the files that are open on it, then eject it again.');
  assert.equal(ejectFailure('no such file'), null);
});
