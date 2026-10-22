'use strict';
/* Tests voor de appstore: Community Apps-templates omzetten naar Docker Compose. */
process.env.APPDATA_DIR = '/snel/appdata';
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
      Overview: 'Mediaserver.[br][br][b]Vrij[/b] en open. Open [IP]:[PORT:8096].', CategoryList: ['MediaServer-Video'], downloads: 1000,
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
        cfg({ Name: 'Wachtwoord', Target: 'PASS', Default: '', Type: 'Variable', Mask: 'true' }),
        cfg({ Name: 'GPU', Target: '/dev/dri', Default: '/dev/dri', Type: 'Device' }),
        cfg({ Name: 'Webcam', Target: '', Default: '', Type: 'Device' }, '/dev/'),
      ],
    },
    { Name: 'Iets', Repository: 'x/plugin', TemplatePath: '/t/p.xml', Plugin: true },
    { Name: 'Oud', Repository: 'x/oud', TemplatePath: '/t/o.xml', Deprecated: true },
    { Name: 'Slecht', Repository: 'x/bad', TemplatePath: '/t/b.xml', Blacklist: true },
    { Name: 'EasyPXE-Nginx', Repository: 'nginx:latest', TemplatePath: '/t/pxe.xml', downloads: 99999, CategoryList: ['Network-Web'], Network: 'host',
      PostArgs: "nginx -g 'daemon off;'", Config: [cfg({ Name: 'Poort', Target: '80', Default: '80', Mode: 'tcp', Type: 'Port' }, '80')] },
    { Name: 'nginx', Repository: 'library/nginx', TemplatePath: '/t/nginx.xml', downloads: 99999, Official: true, CategoryList: ['Network-Web'], Config: [] },
  ],
};

test('feed normaliseren: plugins, verouderde en geblokkeerde apps weg; tekst opgeschoond', () => {
  const c = s.normalizeFeed(FEED);
  assert.deepEqual(c.apps.map((a) => a.name), ['jellyfin', 'EasyPXE-Nginx', 'nginx']);
  const jf = c.apps[0];
  assert.equal(jf.maintainer, 'linuxserver');
  assert.equal(jf.overview, 'Mediaserver.\n\nVrij en open. Open [IP]:[PORT:8096].');
  assert.deepEqual(jf.categories, ['MediaServer']);
  assert.match(jf.id, /^[0-9a-f]{12}$/);
  assert.equal(jf.featured, true);
  // Populariteit: per image één template, en alleen als de naam bij het image past.
  const pxe = c.apps[1], ng = c.apps[2];
  assert.equal(pxe.popularity, 0);
  assert.equal(ng.popularity, 99999);
});

test('velden vertalen: Unraid-paden, gebruiker 99:100, lege appdata-map, keuzelijst, tijdzone', () => {
  const jf = s.normalizeFeed(FEED).apps[0];
  const f = Object.fromEntries(s.prepareFields(jf.config, 'jellyfin', 'Europe/Brussels').map((x) => [x.name, x]));
  assert.equal(f.Appdata.value, '/snel/appdata/jellyfin');
  assert.equal(f.Appdata.auto, true);
  assert.equal(f.Appdata.advanced, true);
  assert.equal(f.Media.value, '/tank/media/movies');
  assert.equal(f.PUID.value, '1000');
  assert.equal(f.PGID.value, '1000');
  assert.deepEqual(f['Log level'].options, ['info', 'debug', 'error']);
  assert.equal(f['Log level'].value, 'info');
  assert.equal(f.Wachtwoord.mask, true);
  assert.equal(f.Webcam.value, '');
  assert.equal(s.mapHostPath('/mnt/cache/appdata/x'), '/snel/appdata/x');
  assert.equal(s.mapHostPath('/mnt/disk2/films'), '/tank/films');
  assert.equal(s.mapHostPath('/etc/localtime'), '/etc/localtime');
});

test('extra Docker-opties en PostArgs splitsen', () => {
  assert.deepEqual(s.shellSplit(`nginx -g 'daemon off;' "a b" ''`), ['nginx', '-g', 'daemon off;', 'a b', '']);
  const o = s.parseExtraParams('--restart=always -e "FOO=bar baz" --user 99:100 --gpus all --device /dev/dri --log-opt max-size=10m --mystery');
  assert.equal(o.restart, 'always');
  assert.deepEqual(o.env, { FOO: 'bar baz' });
  assert.equal(o.user, '99:100');
  assert.equal(o.gpu, true);
  assert.deepEqual(o.devices, ['/dev/dri']);
  assert.deepEqual(o.unknown, ['--mystery']);
});

test('compose-bestand bouwen', () => {
  const [jf, pxe] = s.normalizeFeed(FEED).apps;
  const r = s.buildCompose(jf, 'jellyfin', s.prepareFields(jf.config, 'jellyfin', 'Europe/Brussels'), { tz: 'Europe/Brussels' });
  const t = r.text;
  assert.match(t, /^# Gemaakt door HomeBaseOS uit het Community Apps-template "jellyfin" van linuxserver/);
  assert.match(t, /\n {4}image: "lscr\.io\/linuxserver\/jellyfin"\n/);
  assert.match(t, /- "8096:8096\/tcp"/);
  assert.match(t, /- "7359:7359\/udp"/);
  assert.match(t, /- "\/snel\/appdata\/jellyfin:\/config"/);
  assert.match(t, /- "\/tank\/media\/movies:\/data\/movies:ro"/);
  assert.doesNotMatch(t, /emhttp/);
  assert.match(t, /- "\/dev\/dri:\/dev\/dri"/);
  assert.doesNotMatch(t, /\/dev\/:/);
  assert.match(t, /PUID: "1000"/);
  assert.match(t, /TZ: "Europe\/Brussels"/);
  assert.doesNotMatch(t, /PASS:/); // leeg en niet verplicht
  assert.match(t, /shm_size: "1gb"/);
  assert.match(t, /cap_add:\n {6}- "NET_ADMIN"/);
  assert.match(t, /driver: "nvidia"/);
  assert.match(t, /homebaseos\.data: "\/snel\/appdata\/jellyfin"/);
  assert.match(t, /homebaseos\.webui: "http:\/\/\[IP\]:\[PORT:8096\]"/);
  assert.deepEqual(r.data, ['/snel/appdata/jellyfin']);
  assert.ok(r.warnings.some((w) => /NVIDIA/.test(w)));
  assert.ok(r.warnings.some((w) => /--foo-bar/.test(w)));
  assert.ok(r.warnings.some((w) => /emhttp/.test(w)));

  const p = s.buildCompose(pxe, 'easypxe', s.prepareFields(pxe.config, 'easypxe', 'UTC'), { tz: 'UTC' });
  assert.match(p.text, /network_mode: "host"/);
  assert.doesNotMatch(p.text, /ports:/); // host-netwerk: geen poorten
  assert.match(p.text, /command:\n {6}- "nginx"\n {6}- "-g"\n {6}- "daemon off;"/);
  assert.ok(p.warnings.some((w) => /host/.test(w)));
});

test('YAML: lastige tekst blijft veilig tussen aanhalingstekens', () => {
  const y = s.toYaml({ services: { a: { environment: { 'WEIRD KEY': 'x: "y"\n# z', N: 'ja' }, init: true } } });
  assert.equal(y, 'services:\n  a:\n    environment:\n      "WEIRD KEY": "x: \\"y\\"\\n# z"\n      N: "ja"\n    init: true');
});

test('namen en images', () => {
  assert.equal(s.slugify('Plex Media Server!'), 'plex-media-server');
  assert.equal(s.imageBase('docker.io/library/nginx:1.27'), 'nginx');
  assert.equal(s.imageBase('ghcr.io/immich-app/immich-server:release'), 'ghcr.io/immich-app/immich-server');
});
