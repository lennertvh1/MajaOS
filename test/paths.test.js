'use strict';
/* Tests for the storage locations (app data, VMs, ISOs) and replacing paths when moving. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
delete process.env.APPDATA_DIR; delete process.env.VM_DIR; delete process.env.ISO_DIR; delete process.env.SHARES_DIR;
const paths = require('../lib/paths');
const { replacePath, groupContainers } = require('../lib/migrate');

test('storage locations: nothing set, a new pool, and an own choice', () => {
  assert.deepEqual(paths.all(), { appdata: null, vms: null, isos: null, shares: null });
  assert.equal(paths.shown('appdata'), '/<pool>/appdata');
  assert.equal(paths.exists('appdata'), false);
  // A "pool" with the default folders: everything that had no place yet goes on it.
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pool-'));
  for (const f of paths.DEFAULT_FOLDERS) fs.mkdirSync(path.join(pool, f));
  assert.deepEqual(paths.adoptPool(pool).sort(), ['appdata', 'isos', 'shares', 'vms']);
  assert.equal(paths.dir('appdata'), path.join(pool, 'appdata'));
  assert.equal(paths.dir('shares'), pool);
  // A second pool changes nothing anymore.
  const pool2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pool-'));
  for (const f of paths.DEFAULT_FOLDERS) fs.mkdirSync(path.join(pool2, f));
  assert.deepEqual(paths.adoptPool(pool2), []);
  paths.save({ vms: path.join(pool2, 'vms') });
  paths._reset();
  assert.equal(paths.dir('vms'), path.join(pool2, 'vms'));
  assert.equal(paths.dir('appdata'), path.join(pool, 'appdata'));
  assert.throws(() => paths.save({ appdata: 'relative/path' }), /full path/);
});

test('moving: only replace full paths', () => {
  const text = [
    '    volumes:', '      - "/fast/appdata/jellyfin:/config"', '      - /fast/appdata:/all', '      - "/fast/appdata2/x:/y"',
    '      - type: bind', '        source: /fast/appdata/kuma', '    labels:', '      majaos.data: "/fast/appdata/jellyfin,/fast/appdata/kuma"',
  ].join('\n');
  const out = replacePath(text, '/fast/appdata', '/tank/appdata');
  assert.match(out, /"\/tank\/appdata\/jellyfin:\/config"/);
  assert.match(out, /- \/tank\/appdata:\/all/);
  assert.match(out, /"\/fast\/appdata2\/x:\/y"/); // another path, stays
  assert.match(out, /source: \/tank\/appdata\/kuma/);
  assert.match(out, /majaos\.data: "\/tank\/appdata\/jellyfin,\/tank\/appdata\/kuma"/);
});

test('moving: which apps can come along', () => {
  const c = (name, source, labels = {}, State = 'running') => ({ Id: name + '0123456789', Names: ['/' + name], State, Labels: labels, Mounts: [{ Type: 'bind', Source: source, Destination: '/config' }] });
  const compose = (project, file) => ({ 'com.docker.compose.project': project, 'com.docker.compose.project.config_files': file, 'com.docker.compose.project.working_dir': path.dirname(file) });
  const onHost = new Set(['/opt/stacks/jellyfin/compose.yaml']);
  const r = groupContainers([
    c('jellyfin', '/fast/appdata/jellyfin', compose('jellyfin', '/opt/stacks/jellyfin/compose.yaml')),
    c('kuma', '/fast/appdata/kuma'), // docker run
    c('pihole', '/fast/appdata/pihole', compose('pihole', '/data/compose/3/docker-compose.yml')), // Portainer: file in its own container
    c('plex', '/tank/media', compose('plex', '/opt/stacks/plex/compose.yaml')), // doesn't use the app data
  ], '/fast/appdata', (f) => onHost.has(f));
  assert.deepEqual(r.projects.map((x) => x.project), ['jellyfin']);
  assert.deepEqual(r.manual, ['kuma', 'pihole']);
});

test('finding an existing folder for app data', () => {
  // where the containers already have their data, the most used first
  const containers = [
    { Mounts: [{ Type: 'bind', Source: '/fast/appdata/jellyfin' }, { Type: 'bind', Source: '/tank/media' }] },
    { Mounts: [{ Type: 'bind', Source: '/fast/appdata/immich/upload' }, { Type: 'volume', Source: '/var/lib/docker/volumes/x/_data' }] },
    { Mounts: [{ Type: 'bind', Source: '/mnt/user/appdata/oud' }] },
  ];
  assert.deepEqual(paths.appdataFromMounts(containers), ['/fast/appdata', '/mnt/user/appdata']);
  const list = [{ name: 'tank', mountpoint: '/tank' }, { name: 'tank/data', mountpoint: '/tank/data' }, { name: 'tank/data/appdata', mountpoint: '/tank/data/appdata' }, { name: '/fast', mountpoint: '/fast' }];
  const has = (set) => (p) => set.includes(p);
  // containers first, but only what exists (not Unraid's /mnt/user/appdata)
  assert.equal(paths.pickFolder('appdata', { list, mounts: ['/mnt/user/appdata', '/fast/appdata'], existsFn: has(['/fast/appdata', '/tank/data/appdata']) }), '/fast/appdata');
  // then a dataset with that name, also deeper
  assert.equal(paths.pickFolder('appdata', { list, existsFn: has(['/tank/data/appdata', '/tank/appdata']) }), '/tank/data/appdata');
  // then a plain folder on a pool
  assert.equal(paths.pickFolder('vms', { list, existsFn: has(['/tank/vms']) }), '/tank/vms');
  assert.equal(paths.pickFolder('isos', { list, existsFn: has([]) }), null);
});
