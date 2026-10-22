'use strict';
/* Tests voor eigen apps (image of link), de indeling van het startscherm en het kiezen van een manifest. */
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/appstore');
const { validateLayout } = require('../lib/layout');
const { pickManifest } = require('../lib/registry');

test('link of naam → image', () => {
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
  assert.equal(n('localhost:5000/eigen/app:v2'), 'localhost:5000/eigen/app:v2');
  for (const bad of ['', 'https://example.com', 'rm -rf /', 'https://hub.docker.com/search?q=x', 'a b', 'docker run -p 80:80 nginx']) assert.equal(n(bad), null, bad);
});

test('compose-bestand van een eigen app', () => {
  const body = { name: 'kuma', image: 'louislam/uptime-kuma:1', restart: 'always',
    ports: [{ host: '3001', container: '3001', protocol: 'tcp' }, { host: '', container: '' }],
    volumes: [{ host: '/snel/appdata/kuma', container: '/app/data', mode: 'rw' }], env: [{ name: 'TZ', value: 'Europe/Brussels' }],
    webui: 'http://[IP]:[PORT:3001]/', icon: 'https://x/kuma.png' };
  const c = store.buildCustomCompose(body, { network: { mode: 'bridge' }, takenPorts: [] });
  assert.match(c.text, /image: "louislam\/uptime-kuma:1"/);
  assert.match(c.text, /restart: "always"/);
  assert.match(c.text, /ports:\n {6}- "3001:3001\/tcp"/);
  assert.match(c.text, /volumes:\n {6}- "\/snel\/appdata\/kuma:\/app\/data"/);
  assert.match(c.text, /thuisbasis.custom: "1"/);
  assert.match(c.text, /thuisbasis.data: "\/snel\/appdata\/kuma"/);
  assert.deepEqual(c.data, ['/snel/appdata/kuma']);
  const extra = store.buildCustomCompose({ ...body, privileged: true, devices: [{ host: '/dev/dri', container: '' }], labels: [{ name: 'eigen', value: 'ja' }, { name: 'thuisbasis.store', value: 'x' }] },
    { network: { mode: 'bridge' }, takenPorts: [] });
  assert.match(extra.text, /devices:\n {6}- "\/dev\/dri:\/dev\/dri"/);
  assert.match(extra.text, /privileged: true/);
  assert.match(extra.text, /eigen: "ja"/);
  assert.doesNotMatch(extra.text, /thuisbasis.store/);
  const host = store.buildCustomCompose(body, { network: { mode: 'host' }, takenPorts: [] });
  assert.match(host.text, /network_mode: "host"/); assert.doesNotMatch(host.text, /ports:/);
  const bad = (b, re, taken = []) => assert.throws(() => store.buildCustomCompose({ ...body, ...b }, { network: { mode: 'bridge' }, takenPorts: taken }), re);
  bad({ image: 'https://example.com' }, /Plak de naam van een image/);
  bad({ ports: [{ host: '99999', container: '80' }] }, /geen geldige poort/);
  bad({ ports: [{ host: '3001', container: '80' }] }, /al in gebruik door uptime/, [{ port: 3001, type: 'TCP', app: 'uptime' }]);
  bad({ volumes: [{ host: 'data', container: '/data' }] }, /volledig pad/);
  bad({ volumes: [{ host: '/a', container: 'data' }] }, /met \/ beginnen/);
  bad({ env: [{ name: '1X', value: '' }] }, /geen geldige naam/);
  bad({ webui: 'ftp://x' }, /webinterface/);
});

test('indeling van het startscherm controleren', () => {
  const out = validateLayout({ items: ['plex', { folder: 'f1', name: ' Media  ', apps: ['jellyfin', 'plex', 'sonarr'] }, { folder: 'f2', name: '', apps: ['radarr'] },
    { folder: 'f3', name: 'Leeg', apps: [] }, 'jellyfin', 'pihole'] });
  // plex staat er al (eerste plaats telt), een map met één app wordt een gewone app, een lege map verdwijnt.
  assert.deepEqual(out.items, ['plex', { folder: 'f1', name: 'Media', apps: ['jellyfin', 'sonarr'] }, 'radarr', 'pihole']);
  assert.throws(() => validateLayout({ items: ['../etc'] }), /geen geldige naam/);
  assert.throws(() => validateLayout({ items: [{ folder: 'x', apps: [] }] }), /map/);
  assert.throws(() => validateLayout({}), /klopt niet/);
});

test('manifest kiezen voor de architectuur van de server', () => {
  const idx = { manifests: [{ digest: 'a', platform: { os: 'linux', architecture: 'arm64' } }, { digest: 'b', platform: { os: 'linux', architecture: 'amd64' } },
    { digest: 'c', platform: { os: 'unknown', architecture: 'unknown' } }] };
  assert.equal(pickManifest(idx, 'amd64').digest, 'b');
  assert.equal(pickManifest(idx, 'riscv64'), null);
});
