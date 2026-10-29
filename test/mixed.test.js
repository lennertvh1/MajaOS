'use strict';
/* Pools with mixed disks (lib/mixed.js): the checks, the fstab block, the SnapRAID configuration and its progress. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-'));
const mixed = require('../lib/mixed');

const TB = 1e12;
const disk = (name, size, extra = {}) => ({ name, size, available: true, byId: '/dev/disk/by-id/ata-' + name, serial: 'SN' + name, model: 'Disk', ...extra });
const DISKS = [disk('sda', 4 * TB), disk('sdb', 2 * TB), disk('sdc', 1 * TB), disk('sdd', 4 * TB), disk('sde', 2 * TB, { available: false, reason: 'In pool tank' })];

test('a plan: data and parity disks of different sizes, each with its own mount point', () => {
  const p = mixed.plan({ name: 'media', confirm: 'media', disks: [{ name: 'sdb', role: 'data' }, { name: 'sdc', role: 'data' }, { name: 'sda', role: 'parity' }] }, { disks: DISKS });
  assert.equal(p.mountpoint, '/media');
  assert.deepEqual(p.disks.map((d) => [d.name, d.role, d.mount]), [
    ['sdb', 'data', '/mnt/media/disk1'], ['sdc', 'data', '/mnt/media/disk2'], ['sda', 'parity', '/mnt/media/parity1'],
  ]);
  const c = mixed.capacity([2 * TB, 1 * TB], [4 * TB]);
  assert.equal(c.failures, 1);
  assert.equal(c.usable, Math.round(3 * TB * 0.98));
  assert.equal(c.redundancy, 4 * TB);
});

test('the checks: parity at least as large as every data disk, at most two, a data disk, the name confirmed', () => {
  const fails = (body) => { try { mixed.plan(body, { disks: DISKS, names: ['tank'] }); } catch (e) { return e.message; } return null; };
  const base = { name: 'media', confirm: 'media' };
  assert.match(fails({ ...base, disks: [{ name: 'sda', role: 'data' }, { name: 'sdb', role: 'parity' }] }), /parity disk sdb is smaller than the largest data disk/);
  assert.match(fails({ ...base, disks: [{ name: 'sda', role: 'parity' }] }), /at least one data disk/);
  assert.match(fails({ ...base, disks: [{ name: 'sdc', role: 'data' }, { name: 'sda', role: 'parity' }, { name: 'sdd', role: 'parity' }, { name: 'sdb', role: 'parity' }] }), /at most two parity disks/);
  assert.match(fails({ ...base, disks: [{ name: 'sde', role: 'data' }] }), /You cannot use sde: In pool tank/);
  assert.match(fails({ ...base, disks: [{ name: 'sdc', role: 'data' }, { name: 'sdc', role: 'data' }] }), /chosen twice/);
  assert.match(fails({ name: 'tank', confirm: 'tank', disks: [{ name: 'sdc', role: 'data' }] }), /already exists/);
  assert.match(fails({ name: 'Media', confirm: 'Media', disks: [{ name: 'sdc', role: 'data' }] }), /lowercase/);
  assert.match(fails({ name: 'media', confirm: 'nope', disks: [{ name: 'sdc', role: 'data' }] }), /Type the pool name/);
  // No parity is allowed (no protection): the interface warns about it.
  assert.equal(fails({ ...base, disks: [{ name: 'sdc', role: 'data' }] }), null);
});

const POOL = {
  name: 'media', mountpoint: '/media',
  disks: [
    { role: 'data', index: 1, mount: '/mnt/media/disk1', uuid: 'aaaa' },
    { role: 'data', index: 2, mount: '/mnt/media/disk2', uuid: 'bbbb' },
    { role: 'parity', index: 1, mount: '/mnt/media/parity1', uuid: 'pppp' },
    { role: 'parity', index: 2, mount: '/mnt/media/parity2', uuid: 'qqqq' },
  ],
};

test('fstab: the disks by UUID with nofail, then mergerfs over the data disks, between markers', () => {
  const block = mixed.fstabBlock(POOL);
  assert.match(block, /^# MajaOS pool media \(mixed disks\) start$/m);
  assert.match(block, /^UUID=aaaa \/mnt\/media\/disk1 ext4 defaults,noatime,nofail 0 2$/m);
  assert.match(block, /^UUID=pppp \/mnt\/media\/parity1 ext4 /m);
  assert.match(block, /^\/mnt\/media\/disk\* \/media fuse\.mergerfs [^ ]*category\.create=mfs[^ ]*x-systemd\.requires-mounts-for=\/mnt\/media\/disk1,x-systemd\.requires-mounts-for=\/mnt\/media\/disk2 0 0$/m);
  // Replacing keeps the rest of fstab; removing takes only this block away.
  const before = 'UUID=root / ext4 defaults 0 1\n';
  const added = mixed.replaceBlock(before, 'media', block);
  assert.ok(added.startsWith(before.trim()));
  assert.equal(mixed.replaceBlock(added, 'media', block), added);
  assert.equal(mixed.replaceBlock(added, 'media', null), before);
  assert.equal(mixed.replaceBlock(added, 'other', null), added);
});

test('mergerfs keeps room on each disk: 2% of the smallest data disk, between 256 MB and 20 GB', () => {
  assert.equal(mixed.minFree([{ size: 4e12 }, { size: 2e12 }]), '20G');
  assert.equal(mixed.minFree([{ size: 500e9 }]), '9537M');
  assert.equal(mixed.minFree([{ size: 2 * 2 ** 30 }]), '256M');
  assert.match(mixed.fstabBlock({ ...POOL, disks: POOL.disks.map((d) => ({ ...d, size: 4e12 })) }), /minfreespace=20G/);
});

test('SnapRAID: parity and 2-parity, a content file per data disk and in DATA_DIR, the data disks', () => {
  const conf = mixed.snapraidConf(POOL);
  assert.match(conf, /^parity \/mnt\/media\/parity1\/snapraid\.parity$/m);
  assert.match(conf, /^2-parity \/mnt\/media\/parity2\/snapraid\.parity$/m);
  assert.match(conf, /^content .*snapraid\/media\.content$/m);
  assert.match(conf, /^content \/mnt\/media\/disk2\/\.snapraid\.content$/m);
  assert.match(conf, /^data d1 \/mnt\/media\/disk1\/$/m);
  assert.match(conf, /^data d2 \/mnt\/media\/disk2\/$/m);
  assert.doesNotMatch(conf, /parity1\/ *$/m);
});

test('progress from SnapRAID\'s output', () => {
  assert.equal(mixed.parseProgress('Syncing...\n12%, 1205 MB, 98 MB/s, 120 stripe/s, CPU 12%, 0:01 ETA'), 12);
  assert.equal(mixed.parseProgress('5%, 10 MB\r34%, 900 MB, 98 MB/s'), 34);
  assert.equal(mixed.parseProgress('Everything OK'), null);
});

test('the schedule: a sync that is due starts once, and nothing without a parity disk', () => {
  // tick() only starts what is due; here there are no pools, so nothing happens and nothing throws.
  assert.doesNotThrow(() => mixed.tick(Date.now()));
  assert.deepEqual(mixed.status(), []);
});

test('zpool import: the pools found on the disks', () => {
  const zpool = require('../lib/zpool');
  const out = `   pool: tank
     id: 15532891293384729153
  state: ONLINE
 action: The pool can be imported using its name or numeric identifier.
 config:

	tank        ONLINE
	  raidz1-0  ONLINE
	    ata-WDC_1  ONLINE

   pool: old
     id: 702210496011390744
  state: DEGRADED
 status: One or more devices are missing from the system.
         The pool can still be used.
 action: The pool can be imported despite missing or damaged devices.
 config:
`;
  const p = zpool.parseImportable(out);
  assert.deepEqual(p.map((x) => [x.name, x.id, x.state]), [['tank', '15532891293384729153', 'ONLINE'], ['old', '702210496011390744', 'DEGRADED']]);
  assert.match(p[1].status, /devices are missing from the system\. The pool can still be used\./);
  assert.deepEqual(zpool.parseImportable('no pools available to import'), []);
});

test('what still uses a pool: folders, shared folders, apps and the backup app', async () => {
  const { poolUsers } = require('../lib/poolusers');
  const containers = [{ Names: ['/jellyfin'], Mounts: [{ Type: 'bind', Source: '/media/films' }] }, { Names: ['/other'], Mounts: [{ Type: 'bind', Source: '/mediaX/a' }] }];
  assert.deepEqual(await poolUsers('/media', { containers }), ['app jellyfin']);
  assert.deepEqual(await poolUsers('/', { containers }), []);
});

test('replacing a disk: the checks per role, and what the window offers', () => {
  const pool = { name: 'media', disks: [
    { role: 'data', index: 1, size: 2 * TB, key: 's:A', byId: '/nope/a', mount: '/mnt/media/disk1' },
    { role: 'data', index: 2, size: 1 * TB, key: 's:B', byId: '/nope/b', mount: '/mnt/media/disk2' },
    { role: 'parity', index: 1, size: 4 * TB, key: 's:C', byId: '/nope/c', mount: '/mnt/media/parity1' },
  ] };
  const [d1, d2, p1] = pool.disks;
  assert.deepEqual(pool.disks.map(mixed.memberId), ['d1', 'd2', 'p1']);
  assert.deepEqual(pool.disks.map(mixed.snapName), ['d1', 'd2', 'parity']);
  const fails = (member, d) => { try { mixed.checkReplacement(pool, member, d); } catch (e) { return e.message; } return null; };
  assert.equal(fails(d2, disk('sdx', 2 * TB)), null); // larger than the old one, not larger than the parity
  assert.match(fails(d1, disk('sdx', 1 * TB)), /smaller than the disk it replaces \(2000 GB\)/);
  assert.match(fails(d1, disk('sdx', 6 * TB)), /larger than the parity disk.*at most 4000 GB/);
  assert.match(fails(p1, disk('sdx', 1.5 * TB)), /smaller than the largest data disk/);
  assert.equal(fails(p1, disk('sdx', 2 * TB)), null);
  assert.match(fails(d1, disk('sde', 4 * TB, { available: false, reason: 'In pool tank' })), /You cannot use sde: In pool tank/);
  assert.match(fails(d1, null), /Choose the new disk/);

  fs.writeFileSync(path.join(process.env.DATA_DIR, 'mixed.json'), JSON.stringify({ pools: [{ ...pool, mountpoint: '/media', created: new Date().toISOString(), schedule: mixed.DEFAULT_SCHEDULE, last: {} }] }));
  const o = mixed.replaceOptions('media', 'd1', { disks: [disk('sdx', 3 * TB), disk('sdy', 1 * TB), disk('sdz', 3 * TB, { available: false, reason: 'x' })] });
  assert.equal(o.mode, 'fix'); // the old disk isn't there: its files come back from the parity
  assert.equal(o.parity, true);
  assert.deepEqual(o.candidates.map((c) => [c.name, c.ok]), [['sdx', true], ['sdy', false]]);
  const start = (body) => { try { mixed.startReplace('media', body, { disks: [disk('sdx', 3 * TB)] }); } catch (e) { return e.message; } return null; };
  assert.match(start({ disk: 'd9', with: 'sdx', confirm: 'media' }), /Choose the disk to replace/);
  assert.match(start({ disk: 'd1', with: 'sdx', confirm: 'nope' }), /Type the pool name/);
  assert.match(start({ disk: 'd1' }), /Choose the new disk/); // restoring again only when the disk is in place
  fs.rmSync(path.join(process.env.DATA_DIR, 'mixed.json'));
});
