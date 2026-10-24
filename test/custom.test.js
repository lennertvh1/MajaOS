'use strict';
/* Tests for own apps (image or link), the home screen layout and choosing a manifest. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
process.env.APPDATA_DIR = process.env.APPDATA_DIR || '/fast/appdata';
const store = require('../lib/appstore');
const { validateLayout, defaultLayout } = require('../lib/layout');
const { pickManifest } = require('../lib/registry');

test('link or name → image', () => {
  const n = store.normalizeImage;
  assert.equal(n('nginx'), 'nginx:latest');
  assert.equal(n('  Nginx:1.27-alpine '), 'nginx:1.27-alpine');
  assert.equal(n('docker pull lscr.io/linuxserver/jellyfin:10.10.7'), 'lscr.io/linuxserver/jellyfin:10.10.7');
  assert.equal(n('https://hub.docker.com/r/linuxserver/jellyfin'), 'linuxserver/jellyfin:latest');
  assert.equal(n('https://hub.docker.com/r/louislam/uptime-kuma/tags?name=1.23.16'), 'louislam/uptime-kuma:1.23.16');
  assert.equal(n('https://hub.docker.com/_/postgres'), 'postgres:latest');
  assert.equal(n('https://hub.docker.com/layers/library/redis/7.4/images/sha256-abc'), 'library/redis:7.4');
  assert.equal(n('https://github.com/home-assistant/core/pkgs/container/home-assistant'), 'ghcr.io/home-assistant/home-assistant:latest');
  assert.equal(n('https://github.com/orgs/immich-app/packages/container/package/immich-server'), 'ghcr.io/immich-app/immich-server:latest');
  assert.equal(n('https://quay.io/repository/minio/minio'), 'quay.io/minio/minio:latest');
  assert.equal(n('ghcr.io/home-assistant/home-assistant:stable'), 'ghcr.io/home-assistant/home-assistant:stable');
  assert.equal(n('localhost:5000/own/app:v2'), 'localhost:5000/own/app:v2');
  for (const bad of ['', 'https://example.com', 'rm -rf /', 'https://hub.docker.com/search?q=x', 'a b', 'docker run -p 80:80 nginx']) assert.equal(n(bad), null, bad);
});

test('compose file of an own app', () => {
  const body = { name: 'kuma', image: 'louislam/uptime-kuma:1', restart: 'always',
    ports: [{ host: '3001', container: '3001', protocol: 'tcp' }, { host: '', container: '' }],
    volumes: [{ host: '/fast/appdata/kuma', container: '/app/data', mode: 'rw' }], env: [{ name: 'TZ', value: 'Europe/Brussels' }],
    webui: 'http://[IP]:[PORT:3001]/', icon: 'https://x/kuma.png' };
  const c = store.buildCustomCompose(body, { network: { mode: 'bridge' }, takenPorts: [] });
  assert.match(c.text, /image: "louislam\/uptime-kuma:1"/);
  assert.match(c.text, /restart: "always"/);
  assert.match(c.text, /ports:\n {6}- "3001:3001\/tcp"/);
  assert.match(c.text, /volumes:\n {6}- "\/fast\/appdata\/kuma:\/app\/data"/);
  assert.match(c.text, /homebaseos.custom: "1"/);
  assert.match(c.text, /homebaseos.data: "\/fast\/appdata\/kuma"/);
  assert.deepEqual(c.data, ['/fast/appdata/kuma']);
  const extra = store.buildCustomCompose({ ...body, privileged: true, devices: [{ host: '/dev/dri', container: '' }], labels: [{ name: 'mine', value: 'yes' }, { name: 'homebaseos.store', value: 'x' }] },
    { network: { mode: 'bridge' }, takenPorts: [] });
  assert.match(extra.text, /devices:\n {6}- "\/dev\/dri:\/dev\/dri"/);
  assert.match(extra.text, /privileged: true/);
  assert.match(extra.text, /mine: "yes"/);
  assert.doesNotMatch(extra.text, /homebaseos.store/);
  const host = store.buildCustomCompose(body, { network: { mode: 'host' }, takenPorts: [] });
  assert.match(host.text, /network_mode: "host"/); assert.doesNotMatch(host.text, /ports:/);
  const bad = (b, re, taken = []) => assert.throws(() => store.buildCustomCompose({ ...body, ...b }, { network: { mode: 'bridge' }, takenPorts: taken }), re);
  bad({ image: 'https://example.com' }, /Paste the name of an image/);
  bad({ ports: [{ host: '99999', container: '80' }] }, /not a valid port/);
  bad({ ports: [{ host: '3001', container: '80' }] }, /already used by uptime/, [{ port: 3001, type: 'TCP', app: 'uptime' }]);
  bad({ volumes: [{ host: 'data', container: '/data' }] }, /full path/);
  bad({ volumes: [{ host: '/a', container: 'data' }] }, /must start with \//);
  bad({ env: [{ name: '1X', value: '' }] }, /not a valid name/);
  bad({ webui: 'ftp://x' }, /web interface/);
});

test('checking the home screen layout', () => {
  const out = validateLayout({ items: ['plex', { folder: 'f1', name: ' Media  ', apps: ['jellyfin', 'plex', 'sonarr'] }, { folder: 'f2', name: '', apps: ['radarr'] },
    { folder: 'f3', name: 'Empty', apps: [] }, 'jellyfin', 'pihole'] });
  // plex is already there (the first place counts), a folder with one app becomes a plain app, an empty folder disappears.
  assert.deepEqual(out.items, ['plex', { folder: 'f1', name: 'Media', apps: ['jellyfin', 'sonarr'] }, 'radarr', 'pihole']);
  assert.throws(() => validateLayout({ items: ['../etc'] }), /not a valid app name/);
  assert.throws(() => validateLayout({ items: [{ folder: 'x', apps: [] }] }), /folder/);
  assert.throws(() => validateLayout({}), /not valid/);
});

test('choosing a manifest for the architecture of the server', () => {
  const idx = { manifests: [{ digest: 'a', platform: { os: 'linux', architecture: 'arm64' } }, { digest: 'b', platform: { os: 'linux', architecture: 'amd64' } },
    { digest: 'c', platform: { os: 'unknown', architecture: 'unknown' } }] };
  assert.equal(pickManifest(idx, 'amd64').digest, 'b');
  assert.equal(pickManifest(idx, 'riscv64'), null);
});

test('widgets: order and hidden', () => {
  const out = validateLayout({ items: [], widgets: { order: ['sys', 'shares', 'sys', 'Bad!', 'vms'], hidden: ['ai', 7] } });
  assert.deepEqual(out.widgets, { order: ['sys', 'shares', 'vms'], hidden: ['ai'] });
  assert.deepEqual(validateLayout({ items: [] }).widgets, { order: [], hidden: [] });
});

test('home screen layout with widgets and VMs between the apps', () => {
  const r = validateLayout({ items: ['plex', { widget: 'sys' }, { vm: 'Home Assistant OS' }, { widget: 'sys' }, { vm: 'Home Assistant OS' }, 'jellyfin'] });
  assert.deepEqual(r.items, ['plex', { widget: 'sys', w: 2, h: 2 }, { vm: 'Home Assistant OS' }, 'jellyfin']); // each only once; default size
  assert.throws(() => validateLayout({ items: [{ widget: '../x' }] }), /not a valid widget/);
  assert.throws(() => validateLayout({ items: [{ vm: 'a/b' }] }), /not a valid VM name/);
  const pages = validateLayout({ items: [{ page: 'files' }, 'plex', { page: 'files' }, { page: 'store' }, { page: 'backup' }] });
  assert.deepEqual(pages.items, [{ page: 'files' }, 'plex', { page: 'store' }, { page: 'backup' }]);
  assert.deepEqual(validateLayout({ items: [{ page: 'storage' }, { page: 'shares' }, { page: 'vms' }] }).items, [{ page: 'storage' }, { page: 'shares' }, { page: 'vms' }]);
  assert.throws(() => validateLayout({ items: [{ page: 'settings' }] }), /not a valid page/);
  const grouped = validateLayout({ items: [{ folder: 'f1', name: 'System', apps: [{ page: 'storage' }, { page: 'shares' }, 'plex', { page: 'storage' }] }] });
  assert.deepEqual(grouped.items, [{ folder: 'f1', name: 'System', apps: [{ page: 'storage' }, { page: 'shares' }, 'plex'] }]);
  assert.deepEqual(validateLayout({ items: [{ page: 'storage' }, { folder: 'f9', name: 'A', apps: [{ page: 'storage' }, 'plex', 'jellyfin'] }] }).items,
    [{ page: 'storage' }, { folder: 'f9', name: 'A', apps: ['plex', 'jellyfin'] }]);
  assert.deepEqual(validateLayout({ items: [{ folder: 'f2', name: 'One', apps: [{ page: 'vms' }] }] }).items, [{ page: 'vms' }]);
  const fresh = validateLayout(defaultLayout());
  assert.equal(fresh.items[0].folder, 'fsystem');
  assert.deepEqual(fresh.items[0].apps.map((n) => n.page), ['storage', 'shares', 'vms', 'store', 'files', 'backup']);
  const cuts = validateLayout({ items: ['plex', { shortcut: 's0123abcd' }, { shortcut: 's0123abcd' }, { shortcut: 'sabcdef01' }] });
  assert.deepEqual(cuts.items, ['plex', { shortcut: 's0123abcd' }, { shortcut: 'sabcdef01' }]);
  assert.throws(() => validateLayout({ items: [{ shortcut: 'nope' }] }), /not a valid shortcut/);
});

test('widget size on the home screen', () => {
  const keep = validateLayout({ items: [{ widget: 'clock', w: 4, h: 2 }, { widget: 'sys', w: 2, h: 4 }] });
  assert.deepEqual(keep.items, [{ widget: 'clock', w: 4, h: 2 }, { widget: 'sys', w: 2, h: 4 }]);
  const wide = validateLayout({ items: [{ widget: 'clock', w: 8, h: 2 }, { widget: 'shares', w: 6, h: 4 }] });
  assert.deepEqual(wide.items, [{ widget: 'clock', w: 8, h: 2 }, { widget: 'shares', w: 6, h: 4 }]);
  const clamp = validateLayout({ items: [{ widget: 'ai', w: 9, h: 0 }, { widget: 'vms', w: 'x', h: 2 }] });
  assert.deepEqual(clamp.items, [{ widget: 'ai', w: 2, h: 2 }, { widget: 'vms', w: 2, h: 2 }]);
  const odd = validateLayout({ items: [{ widget: 'sys', w: 3, h: 3 }, { widget: 'clock', w: 1, h: 2 }] });
  assert.deepEqual(odd.items, [{ widget: 'sys', w: 3, h: 3 }, { widget: 'clock', w: 1, h: 2 }]);
});
