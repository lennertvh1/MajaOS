'use strict';
/* Apps installed from a compose file as it is: recognised as own apps by their folder in STACKS_DIR. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'majaos-stacks-')));
process.env.STACKS_DIR = path.join(tmp, 'stacks');
process.env.DATA_DIR = path.join(tmp, 'data');
const docker = require('../lib/docker');

const labels = (project, dir) => ({ 'com.docker.compose.project': project, 'com.docker.compose.project.working_dir': dir });

test('a compose project in STACKS_DIR counts as installed by MajaOS', () => {
  assert.equal(docker.inStacks(labels('unifi', path.join(tmp, 'stacks', 'unifi'))), true);
  assert.equal(docker.inStacks(labels('unifi', '/home/me/unifi')), false);
  assert.equal(docker.inStacks(labels('unifi', path.join(tmp, 'stacks', 'other'))), false);
  assert.equal(docker.inStacks({}), false);
});

test('its data folders are the bind mounts inside its own folder', () => {
  const own = path.join(tmp, 'stacks', 'unifi');
  const ins = { Mounts: [
    { Type: 'bind', Source: own + '/data' },
    { Type: 'bind', Source: own + '/init-mongo.sh' },
    { Type: 'bind', Source: '/var/run/docker.sock' },
    { Type: 'volume', Source: '/var/lib/docker/volumes/x/_data' },
    { Type: 'bind', Source: own + '/data' },
  ] };
  assert.deepEqual(docker.dataDirsOf(labels('unifi', own), ins), [own + '/data', own + '/init-mongo.sh']);
  // The label wins; a project elsewhere has none.
  assert.deepEqual(docker.dataDirsOf({ ...labels('unifi', own), 'majaos.data': '/tank/appdata/unifi' }, ins), ['/tank/appdata/unifi']);
  assert.deepEqual(docker.dataDirsOf(labels('unifi', '/home/me/unifi'), ins), []);
});
