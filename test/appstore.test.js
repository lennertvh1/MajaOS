'use strict';
/* Tests for the app store: converting Community Apps templates to Docker Compose. */
process.env.APPDATA_DIR = '/fast/appdata';
process.env.SHARES_DIR = '/tank';
process.env.APP_UID = '1000';
process.env.APP_GID = '1000';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../lib/appstore');

const cfg = (attrs, value = '') => ({ '@attributes': { Display: 'always', Required: 'false', Mask: 'false', ...attrs }, value });
const FEED = {
  last_updated_timestamp: 1792514584,
  applist: [
    {
      Name: 'jellyfin', Repo: "linuxserver's Repository", Repository: 'lscr.io/linuxserver/jellyfin', TemplatePath: '/t/lsio/jellyfin.xml',
      Overview: 'Mediaserver.[br][br][b]Free[/b] and open. Open [IP]:[PORT:8096].', CategoryList: ['MediaServer-Video'], downloads: 1000,
      Network: 'bridge', Privileged: 'false', WebUI: 'http://[IP]:[PORT:8096]', Icon: 'https://example.org/jf.png',
      ExtraParams: '--restart unless-stopped --runtime=nvidia --shm-size=1gb --cap-add=NET_ADMIN --foo-bar', PostArgs: '',
      Config: [
        cfg({ Name: 'WebUI', Target: '8096', Default: '8096', Mode: 'tcp', Type: 'Port', Required: 'true' }, '8096'),
        cfg({ Name: 'Discovery', Target: '7359', Default: '7359', Mode: 'udp', Type: 'Port' }, '7359'),
        cfg({ Name: 'Appdata', Target: '/config', Default: '', Mode: 'rw', Type: 'Path', Display: 'advanced', Required: 'true' }),
        cfg({ Name: 'Media', Target: '/data/movies', Default: '/mnt/user/media/movies', Mode: 'ro', Type: 'Path' }),
        cfg({ Name: 'Unraid', Target: '/emhttp', Default: '/usr/local/emhttp', Mode: 'ro', Type: 'Path' }),
        cfg({ Name: 'PUID', Target: 'PUID', Default: '99', Type: 'Variable', Display: 'advanced' }),
        cfg({ Name: 'PGID', Target: 'PGID', Default: '100', Type: 'Variable', Display: 'advanced' }),
        cfg({ Name: 'Log level', Target: 'LOG', Default: 'info|debug|error', Type: 'Variable' }),
        cfg({ Name: 'Password', Target: 'PASS', Default: '', Type: 'Variable', Mask: 'true' }),
        cfg({ Name: 'GPU', Target: '/dev/dri', Default: '/dev/dri', Type: 'Device' }),
        cfg({ Name: 'Webcam', Target: '', Default: '', Type: 'Device' }, '/dev/'),
      ],
    },
    { Name: 'Something', Repository: 'x/plugin', TemplatePath: '/t/p.xml', Plugin: true },
    { Name: 'Old', Repository: 'x/old', TemplatePath: '/t/o.xml', Deprecated: true },
    { Name: 'Bad', Repository: 'x/bad', TemplatePath: '/t/b.xml', Blacklist: true },
    { Name: 'EasyPXE-Nginx', Repository: 'nginx:latest', TemplatePath: '/t/pxe.xml', downloads: 99999, CategoryList: ['Network-Web'], Network: 'host',
      PostArgs: "nginx -g 'daemon off;'", Config: [cfg({ Name: 'Port', Target: '80', Default: '80', Mode: 'tcp', Type: 'Port' }, '80')] },
    { Name: 'nginx', Repository: 'library/nginx', TemplatePath: '/t/nginx.xml', downloads: 99999, Official: true, CategoryList: ['Network-Web'], Config: [] },
  ],
};

test('normalising the feed: plugins, deprecated and blacklisted apps removed; text cleaned up', () => {
  const c = s.normalizeFeed(FEED);
  assert.deepEqual(c.apps.map((a) => a.name), ['jellyfin', 'EasyPXE-Nginx', 'nginx']);
  const jf = c.apps[0];
  assert.equal(jf.maintainer, 'linuxserver');
  assert.equal(jf.overview, 'Mediaserver.\n\nFree and open. Open [IP]:[PORT:8096].');
  assert.deepEqual(jf.categories, ['MediaServer']);
  assert.match(jf.id, /^[0-9a-f]{12}$/);
  assert.equal(jf.featured, true);
  // Popularity: one template per image, and only if the name fits the image.
  const pxe = c.apps[1], ng = c.apps[2];
  assert.equal(pxe.popularity, 0);
  assert.equal(ng.popularity, 99999);
});

test('translating fields: Unraid paths, user 99:100, empty appdata folder, choice list, time zone', () => {
  const jf = s.normalizeFeed(FEED).apps[0];
  const f = Object.fromEntries(s.prepareFields(jf.config, 'jellyfin', 'Europe/Brussels').map((x) => [x.name, x]));
  assert.equal(f.Appdata.value, '/fast/appdata/jellyfin');
  assert.equal(f.Appdata.auto, true);
  assert.equal(f.Appdata.advanced, true);
  assert.equal(f.Media.value, '/tank/media/movies');
  assert.equal(f.PUID.value, '1000');
  assert.equal(f.PGID.value, '1000');
  assert.deepEqual(f['Log level'].options, ['info', 'debug', 'error']);
  assert.equal(f['Log level'].value, 'info');
  assert.equal(f.Password.mask, true);
  assert.equal(f.Webcam.value, '');
  assert.equal(s.mapHostPath('/mnt/cache/appdata/x'), '/fast/appdata/x');
  assert.equal(s.mapHostPath('/mnt/disk2/films'), '/tank/films');
  assert.equal(s.mapHostPath('/etc/localtime'), '/etc/localtime');
});

test('splitting extra Docker options and PostArgs', () => {
  assert.deepEqual(s.shellSplit(`nginx -g 'daemon off;' "a b" ''`), ['nginx', '-g', 'daemon off;', 'a b', '']);
  const o = s.parseExtraParams('--restart=always -e "FOO=bar baz" --user 99:100 --gpus all --device /dev/dri --log-opt max-size=10m --mystery');
  assert.equal(o.restart, 'always');
  assert.deepEqual(o.env, { FOO: 'bar baz' });
  assert.equal(o.user, '99:100');
  assert.equal(o.gpu, true);
  assert.deepEqual(o.devices, ['/dev/dri']);
  assert.deepEqual(o.unknown, ['--mystery']);
});

test('building the compose file', () => {
  const [jf, pxe] = s.normalizeFeed(FEED).apps;
  const r = s.buildCompose(jf, 'jellyfin', s.prepareFields(jf.config, 'jellyfin', 'Europe/Brussels'), { tz: 'Europe/Brussels' });
  const t = r.text;
  assert.match(t, /^# Created by MajaOS from the Community Apps template "jellyfin" by linuxserver/);
  assert.match(t, /\n {4}image: "lscr\.io\/linuxserver\/jellyfin"\n/);
  assert.match(t, /- "8096:8096\/tcp"/);
  assert.match(t, /- "7359:7359\/udp"/);
  assert.match(t, /- "\/fast\/appdata\/jellyfin:\/config"/);
  assert.match(t, /- "\/tank\/media\/movies:\/data\/movies:ro"/);
  assert.doesNotMatch(t, /emhttp/);
  assert.match(t, /- "\/dev\/dri:\/dev\/dri"/);
  assert.doesNotMatch(t, /\/dev\/:/);
  assert.match(t, /PUID: "1000"/);
  assert.match(t, /TZ: "Europe\/Brussels"/);
  assert.doesNotMatch(t, /PASS:/); // empty and not required
  assert.match(t, /shm_size: "1gb"/);
  assert.match(t, /cap_add:\n {6}- "NET_ADMIN"/);
  assert.match(t, /driver: "nvidia"/);
  assert.match(t, /majaos\.data: "\/fast\/appdata\/jellyfin"/);
  assert.match(t, /majaos\.webui: "http:\/\/\[IP\]:\[PORT:8096\]"/);
  assert.deepEqual(r.data, ['/fast/appdata/jellyfin']);
  assert.ok(r.warnings.some((w) => /NVIDIA/.test(w)));
  assert.ok(r.warnings.some((w) => /--foo-bar/.test(w)));
  assert.ok(r.warnings.some((w) => /emhttp/.test(w)));

  const p = s.buildCompose(pxe, 'easypxe', s.prepareFields(pxe.config, 'easypxe', 'UTC'), { tz: 'UTC' });
  assert.match(p.text, /network_mode: "host"/);
  assert.doesNotMatch(p.text, /ports:/); // host network: no ports
  assert.match(p.text, /command:\n {6}- "nginx"\n {6}- "-g"\n {6}- "daemon off;"/);
  assert.ok(!p.warnings.some((w) => /host/.test(w))); // host is the normal choice now: no warning
});

test('YAML: tricky text stays safe between quotes', () => {
  const y = s.toYaml({ services: { a: { environment: { 'WEIRD KEY': 'x: "y"\n# z', N: 'yes' }, init: true } } });
  assert.equal(y, 'services:\n  a:\n    environment:\n      "WEIRD KEY": "x: \\"y\\"\\n# z"\n      N: "yes"\n    init: true');
});

test('names and images', () => {
  assert.equal(s.slugify('Plex Media Server!'), 'plex-media-server');
  assert.equal(s.imageBase('docker.io/library/nginx:1.27'), 'nginx');
  assert.equal(s.imageBase('ghcr.io/immich-app/immich-server:release'), 'ghcr.io/immich-app/immich-server');
});

test('docker compose pull: one line per layer, with progress', () => {
  const job = { lines: [], keys: new Map(), layers: {}, phase: 'pull', done: false };
  const out = [
    ' jellyfin Pulling ',
    ' a2318d6c47ec Pulling fs layer ', ' 3f4ca61aafcd Pulling fs layer ', ' 3f4ca61aafcd Already exists ',
    ' a2318d6c47ec Downloading [=====>                                             ]  12.4MB/31.2MB',
    ' a2318d6c47ec Downloading [=========================>                         ]  15.6MB/31.2MB',
  ];
  out.forEach((l) => s.jobLog(job, l));
  assert.deepEqual(job.lines, ['jellyfin Pulling', 'a2318d6c47ec Downloading [=========================>                         ]  15.6MB/31.2MB', '3f4ca61aafcd Already exists']);
  let p = s.jobProgress(job);
  assert.equal(p.layers, 2); assert.equal(p.layersDone, 1); assert.equal(p.downloaded, 15.6e6); assert.equal(p.size, 31.2e6);
  assert.equal(p.percent, 3 + Math.round(82 * (1 + 0.75 * 0.5) / 2));
  ['a2318d6c47ec Download complete', 'a2318d6c47ec Extracting [==>  ]  1.2MB/31.2MB', 'a2318d6c47ec Pull complete', 'jellyfin Pulled'].forEach((l) => s.jobLog(job, l));
  assert.deepEqual(job.lines, ['jellyfin Pulled', 'a2318d6c47ec Pull complete', '3f4ca61aafcd Already exists']);
  p = s.jobProgress(job); assert.equal(p.percent, 85); assert.equal(p.downloaded, 31.2e6);
  job.phase = 'start';
  ['Network jellyfin_default  Creating', 'Network jellyfin_default  Created', 'Container jellyfin  Creating', 'Container jellyfin  Started'].forEach((l) => s.jobLog(job, l));
  assert.deepEqual(job.lines.slice(3), ['Network jellyfin_default  Created', 'Container jellyfin  Started']);
  assert.equal(s.jobProgress(job).phase, 'start');
});

test('host network: a changed port goes to the template\'s port setting', () => {
  const app = { id: 'abc', name: 'qbit', image: 'lscr.io/linuxserver/qbittorrent', webui: 'http://[IP]:[PORT:8080]', network: 'host', extraParams: '', postArgs: '' };
  const fields = [
    { key: 'c0', type: 'Port', name: 'WebUI', target: '8080', value: '8090', mode: 'tcp' },
    { key: 'c1', type: 'Variable', name: 'WebUI port', target: 'WEBUI_PORT', value: '8080' },
    { key: 'c2', type: 'Port', name: 'Torrents', target: '6881', value: '6999', mode: 'tcp' },
  ];
  const r = s.buildCompose(app, 'qbit', fields, { tz: 'UTC', network: { mode: 'host', name: null, ownIp: false } });
  assert.match(r.text, /network_mode: "host"/);
  assert.doesNotMatch(r.text, /ports:/);
  assert.match(r.text, /WEBUI_PORT: "8090"/);
  assert.match(r.text, /majaos\.webui: "http:\/\/\[IP\]:\[PORT:8090\]"/);
  assert.ok(r.warnings.some((w) => /own port 6881/.test(w)));
  assert.equal(fields[1].value, '8080'); // the caller's fields are not changed
});

test('host network: the WebUI works without touching anything', () => {
  const host = { network: { mode: 'host', name: null, ownIp: false } };
  // A template whose host port differs from the app's own port: untouched, so no warning and no change.
  const app = { id: 'g', name: 'grafana', image: 'grafana/grafana', webui: 'http://[IP]:[PORT:3000]', network: 'bridge', extraParams: '', postArgs: '' };
  const fields = [{ key: 'c0', type: 'Port', name: 'WebUI', target: '3000', value: '3001', mode: 'tcp' }];
  const r = s.buildCompose(app, 'grafana', fields, { tz: 'UTC', ...host, defaults: new Map([['c0', '3001']]) });
  assert.deepEqual(r.warnings, []);
  assert.match(r.text, /majaos\.webui: "http:\/\/\[IP\]:\[PORT:3000\]"/);
  assert.deepEqual(r.hostPorts, [{ port: 3000, proto: 'tcp' }]);
  assert.match(r.text, /majaos\.listen: "3000"/);
  // Without defaults a different value counts as a change (and warns, there is no port setting).
  assert.ok(s.buildCompose(app, 'grafana', fields, { tz: 'UTC', ...host }).warnings.some((w) => /own port 3000/.test(w)));

  // A template without a WebUI address: the web port is found, and only UDP or odd ports give nothing.
  const bare = { ...app, webui: '' };
  assert.match(s.buildCompose(bare, 'grafana', fields, { tz: 'UTC', ...host }).text, /majaos\.webui: "http:\/\/\[IP\]:\[PORT:3000\]\/"/);
  const odd = [{ key: 'a', type: 'Port', name: 'A', target: '1883', value: '1883', mode: 'tcp' }, { key: 'b', type: 'Port', name: 'B', target: '9001', value: '9001', mode: 'tcp' }];
  assert.equal(s.buildCompose(bare, 'mqtt', odd, { tz: 'UTC', ...host }).webui, '');
});

test('host network: a port that is taken is found, including MajaOS itself', () => {
  const inst = { ports: [{ port: 80, type: 'TCP', app: 'MajaOS' }, { port: 8080, type: 'TCP', app: 'qbit' }, { port: 53, type: 'UDP', app: 'pihole' }] };
  assert.deepEqual(s.hostClashes([{ port: 80 }, { port: 8080 }, { port: 8081 }], inst), [{ port: 80, app: 'MajaOS' }, { port: 8080, app: 'qbit' }]);
  assert.deepEqual(s.hostClashes([{ port: 53 }], inst), []); // only TCP is tracked
  assert.deepEqual(s.hostClashes([], inst), []);
});
