'use strict';
/* Update check from start to finish, with a simulated Docker socket and registry. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-upd-'));
process.env.DOCKER_SOCKET = path.join(dir, 'docker.sock');
process.env.DATA_DIR = dir;

const containers = [
  { Id: 'c1', Names: ['/jellyfin'], Image: 'jellyfin/jellyfin:latest', ImageID: 'sha256:img1', State: 'running', Status: 'Up', Ports: [], Labels: {} },
  { Id: 'c2', Names: ['/immich'], Image: 'ghcr.io/immich-app/immich-server:release', ImageID: 'sha256:img2', State: 'running', Status: 'Up', Ports: [], Labels: {} },
  { Id: 'c3', Names: ['/own'], Image: 'my-app:dev', ImageID: 'sha256:img3', State: 'exited', Status: 'Exited', Ports: [], Labels: {} },
  { Id: 'c4', Names: ['/private'], Image: 'ghcr.io/lennert/private:1', ImageID: 'sha256:img4', State: 'running', Status: 'Up', Ports: [], Labels: {} },
];
const images = { 'sha256:img1': ['jellyfin/jellyfin@sha256:aaa'], 'sha256:img2': ['ghcr.io/immich-app/immich-server@sha256:bbb'], 'sha256:img3': [], 'sha256:img4': ['ghcr.io/lennert/private@sha256:ddd'] };
const server = http.createServer((req, res) => {
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith('/containers/json')) return send(containers);
  let m = req.url.match(/^\/containers\/(\w+)\/json$/);
  if (m) { const c = containers.find((x) => x.Id === m[1]); return send({ Id: c.Id, Name: c.Names[0], Image: c.ImageID, Config: { Image: c.Image, Labels: {} }, HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }, State: { Running: c.State === 'running' } }); }
  m = req.url.match(/^\/images\/(.+)\/json$/);
  if (m) return send({ Id: decodeURIComponent(m[1]), RepoDigests: images[decodeURIComponent(m[1])] });
  res.writeHead(404); res.end('{}');
});

const registry = require('../lib/registry');
let calls = 0;
registry.remoteDigest = async (ref) => {
  calls++;
  if (ref.startsWith('jellyfin')) return 'sha256:aaa'; // same: no update
  if (ref.startsWith('ghcr.io/immich')) return 'sha256:new'; // different: update
  throw new Error('private image, sign-in is not set up');
};
const docker = require('../lib/docker');

test('checking updates and showing them in the list of apps', async (t) => {
  await new Promise((r) => server.listen(process.env.DOCKER_SOCKET, r));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const before = await docker.listApps();
  assert.ok(before.every((a) => a.update === null)); // not checked yet

  const r = await docker.checkUpdates(true);
  assert.equal(r.checked, 4);
  assert.equal(r.updates, 1);
  assert.deepEqual(r.errors, ['ghcr.io/lennert/private:1: private image, sign-in is not set up']);
  assert.equal(calls, 3); // the self-built image asks nothing of a registry

  const apps = Object.fromEntries((await docker.listApps()).map((a) => [a.name, a]));
  assert.equal(apps.jellyfin.update, false);
  assert.equal(apps.immich.update, true);
  assert.equal(apps.own.update, null);
  assert.match(apps.own.updateError, /self-built/);
  assert.equal(apps.private.update, null);
  assert.equal(apps.immich.image, 'ghcr.io/immich-app/immich-server:release');
  assert.ok(apps.immich.updateChecked > 0);
  assert.ok(fs.existsSync(path.join(dir, 'updates.json'))); // remembered for after a restart

  // Without force: ask nothing again within 6 hours.
  await docker.checkUpdates(false);
  assert.equal(calls, 3);

  // The container now runs on a different image (e.g. after updating): then the old result no longer applies.
  containers[1].ImageID = 'sha256:img2b'; images['sha256:img2b'] = ['ghcr.io/immich-app/immich-server@sha256:new'];
  assert.equal((await docker.listApps()).find((a) => a.name === 'immich').update, null);
  await docker.checkUpdates(false);
  assert.equal((await docker.listApps()).find((a) => a.name === 'immich').update, false);
});

test('parsing image names for the registry', () => {
  const p = registry.parseRef;
  assert.deepEqual(p('jellyfin/jellyfin'), { registry: 'registry-1.docker.io', repo: 'jellyfin/jellyfin', tag: 'latest' });
  assert.deepEqual(p('nextcloud:30'), { registry: 'registry-1.docker.io', repo: 'library/nextcloud', tag: '30' });
  assert.deepEqual(p('docker.io/library/redis:7'), { registry: 'registry-1.docker.io', repo: 'library/redis', tag: '7' });
  assert.deepEqual(p('lscr.io/linuxserver/jellyfin'), { registry: 'lscr.io', repo: 'linuxserver/jellyfin', tag: 'latest' });
  assert.deepEqual(p('localhost:5000/my/app:dev'), { registry: 'localhost:5000', repo: 'my/app', tag: 'dev' });
  assert.equal(p('postgres@sha256:abc'), null);
  assert.deepEqual(registry.authParams('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"'),
    { realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'repository:a/b:pull' });
});
