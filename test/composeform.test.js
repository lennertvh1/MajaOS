'use strict';
/* Tests voor het compose-formulier: lezen uit `docker compose config --format json` en weer schrijven. */
const test = require('node:test');
const assert = require('node:assert/strict');
const cf = require('../lib/composeform');
const { toYaml } = require('../lib/yaml');

// Zoals docker compose config --no-interpolate --no-normalize --format json het teruggeeft.
const PROJECT = {
  name: 'media',
  services: {
    jellyfin: {
      container_name: 'jellyfin', image: 'lscr.io/linuxserver/jellyfin:latest', restart: 'unless-stopped',
      environment: { PUID: '1000', TZ: 'Europe/Brussels', DOORGEVEN: null },
      labels: { 'thuisbasis.icon': 'https://x/jf.png' },
      ports: [
        { mode: 'ingress', target: 8096, published: '8096', protocol: 'tcp' },
        { mode: 'ingress', target: 7359, published: '7359', protocol: 'udp' },
        { mode: 'host', target: 1900, published: '1900', protocol: 'udp' },
      ],
      volumes: [
        { type: 'bind', source: '/snel/appdata/jellyfin', target: '/config', bind: { create_host_path: true } },
        { type: 'bind', source: '/tank/media', target: '/media', read_only: true, bind: {} },
        { type: 'bind', source: '/mnt/x', target: '/x', bind: { propagation: 'rslave' } },
        { type: 'volume', source: 'cache', target: '/cache', volume: {} },
        { type: 'tmpfs', target: '/transcode', tmpfs: { size: 1073741824 } },
      ],
      devices: [{ source: '/dev/dri', target: '/dev/dri', permissions: 'rwm' }],
      networks: { default: null },
      healthcheck: { test: ['CMD', 'curl', '-f', 'http://localhost:8096'], interval: '30s' },
    },
    db: { image: 'postgres:17', environment: ['POSTGRES_PASSWORD=geheim'] },
  },
  volumes: { cache: {} },
  networks: { default: { name: 'media_default' } },
};

test('formulier lezen: poorten, mappen, variabelen, apparaten en labels', () => {
  const f = cf.serviceForm(PROJECT, 'jellyfin');
  assert.equal(f.image, 'lscr.io/linuxserver/jellyfin:latest');
  assert.equal(f.restart, 'unless-stopped');
  assert.equal(f.network, '');
  assert.deepEqual(f.otherServices, ['db']);
  assert.deepEqual(f.ports.map((p) => [p.host, p.container, p.protocol, !!p.locked]),
    [['8096', '8096', 'tcp', false], ['7359', '7359', 'udp', false], ['1900', '1900', 'udp', false]]);
  assert.equal(f.ports[2].mode, 'host');
  assert.deepEqual(f.volumes.map((v) => [v.host, v.container, v.mode, v.locked]), [
    ['/snel/appdata/jellyfin', '/config', 'rw', false], ['/tank/media', '/media', 'ro', false],
    ['/mnt/x', '/x', 'rw', true], ['cache', '/cache', 'rw', false], ['', '/transcode', 'rw', true]]);
  assert.deepEqual(f.env, [{ name: 'PUID', value: '1000' }, { name: 'TZ', value: 'Europe/Brussels' }, { name: 'DOORGEVEN', value: '', unset: true }]);
  assert.deepEqual(f.devices, [{ host: '/dev/dri', container: '/dev/dri', perm: '' }]);
  assert.deepEqual(f.labels, [{ name: 'thuisbasis.icon', value: 'https://x/jf.png' }]);
  assert.deepEqual(cf.serviceForm(PROJECT, 'db').env, [{ name: 'POSTGRES_PASSWORD', value: 'geheim' }]);
});

test('korte schrijfwijze lezen', () => {
  assert.deepEqual(cf.parsePort('127.0.0.1:8080:80/udp'), { host: '8080', container: '80', protocol: 'udp', ip: '127.0.0.1' });
  assert.deepEqual(cf.parsePort('3000'), { host: '', container: '3000', protocol: 'tcp', ip: '' });
  const v = cf.parseVolume('/a:/b:ro');
  assert.equal(v.mode, 'ro'); assert.equal(v.locked, false);
  assert.equal(cf.parseVolume('/a:/b:z').locked, true);
  assert.deepEqual(cf.parseDevice('/dev/ttyUSB0'), { host: '/dev/ttyUSB0', container: '/dev/ttyUSB0', perm: '' });
});

test('formulier schrijven: nieuwe velden erbij, de rest blijft ongewijzigd', () => {
  const f = cf.serviceForm(PROJECT, 'jellyfin');
  f.ports.push({ host: '8920', container: '8920', protocol: 'tcp' });
  f.volumes.push({ host: '/tank/films', container: '/films', mode: 'ro' });
  f.env.push({ name: 'JELLYFIN_PublishedServerUrl', value: 'http://192.168.1.10:8096' });
  f.env = f.env.filter((e) => e.name !== 'PUID');
  f.devices.push({ host: '/dev/ttyUSB0', container: '' });
  f.labels = [];
  f.restart = 'always';
  const out = cf.applyServiceForm(PROJECT, f);
  const j = out.services.jellyfin;
  assert.deepEqual(j.ports.slice(0, 2), ['8096:8096/tcp', '7359:7359/udp']);
  assert.deepEqual(j.ports[2], { mode: 'host', target: 1900, published: '1900', protocol: 'udp' }); // mode: host blijft behouden
  assert.equal(j.ports[3], '8920:8920/tcp');
  assert.deepEqual(j.volumes.slice(0, 2), ['/snel/appdata/jellyfin:/config', '/tank/media:/media:ro']);
  assert.deepEqual(j.volumes[2], PROJECT.services.jellyfin.volumes[2]);
  assert.equal(j.volumes[3], 'cache:/cache');
  assert.deepEqual(j.volumes[4], PROJECT.services.jellyfin.volumes[4]);
  assert.equal(j.volumes[5], '/tank/films:/films:ro');
  assert.deepEqual(j.environment, { TZ: 'Europe/Brussels', DOORGEVEN: null, JELLYFIN_PublishedServerUrl: 'http://192.168.1.10:8096' });
  assert.deepEqual(j.devices, ['/dev/dri:/dev/dri', '/dev/ttyUSB0:/dev/ttyUSB0']);
  assert.equal('labels' in j, false);
  assert.equal(j.restart, 'always');
  assert.deepEqual(j.healthcheck, PROJECT.services.jellyfin.healthcheck); // onbekend voor het formulier: blijft
  assert.deepEqual(out.services.db, PROJECT.services.db); // andere dienst: ongewijzigd
  assert.deepEqual(out.volumes, { cache: {} });
  assert.equal(PROJECT.services.jellyfin.restart, 'unless-stopped'); // origineel niet aangepast
});

test('host-netwerk en foute invoer', () => {
  const f = cf.serviceForm(PROJECT, 'jellyfin');
  const host = cf.applyServiceForm(PROJECT, { ...f, network: 'host' }).services.jellyfin;
  assert.equal(host.network_mode, 'host'); assert.equal('networks' in host, false);
  const bad = (patch, re) => assert.throws(() => cf.applyServiceForm(PROJECT, { ...f, ...patch }), re);
  bad({ image: ' ' }, /image/);
  bad({ ports: [{ host: '80a', container: '80' }] }, /geen geldige poort/);
  bad({ volumes: [{ host: '/a', container: 'config' }] }, /met \/ beginnen/);
  bad({ volumes: [{ host: '', container: '/config' }] }, /map op de server/);
  bad({ env: [{ name: '1FOUT', value: 'x' }] }, /geen geldige naam/);
  bad({ env: [{ name: 'A', value: '1' }, { name: 'A', value: '2' }] }, /twee keer/);
  bad({ devices: [{ host: 'dri' }] }, /\/dev\//);
  bad({ restart: 'soms' }, /herstartbeleid/);
  assert.throws(() => cf.serviceForm(PROJECT, 'bestaat-niet'), /staat niet/);
});

test('YAML: null, lege lijsten en objecten en geneste lijsten blijven behouden', () => {
  assert.equal(toYaml({ a: null, b: {}, c: [], d: [[1, 2], {}], e: { f: 'x: "y"' } }),
    'a: null\nb: {}\nc: []\nd:\n  - - 1\n    - 2\n  - {}\ne:\n  f: "x: \\"y\\""');
});

test('poort met mode: host aanpassen', () => {
  const f = cf.serviceForm(PROJECT, 'jellyfin');
  f.ports[2].host = '1901';
  assert.deepEqual(cf.applyServiceForm(PROJECT, f).services.jellyfin.ports[2], { mode: 'host', target: 1900, published: '1901', protocol: 'udp' });
  assert.equal(cf.parsePort({ target: 80, published: '8080', x_extra: 1 }).locked, true); // onbekende sleutel: geavanceerd
});
