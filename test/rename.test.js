'use strict';
/* HomeBaseOS was renamed to MajaOS: older servers keep working (labels, network, the move on update). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ownLabels } = require('../lib/docker');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('apps installed before the rename keep their address, icon and data folders', () => {
  const l = ownLabels({ 'homebaseos.webui': 'http://[IP]:[PORT:8080]', 'homebaseos.store': 'abc', 'majaos.icon': 'new.png', 'homebaseos.icon': 'old.png', other: 'x' });
  assert.equal(l['majaos.webui'], 'http://[IP]:[PORT:8080]');
  assert.equal(l['majaos.store'], 'abc');
  assert.equal(l['majaos.icon'], 'new.png'); // the new label wins
  assert.equal(l.other, 'x');
  assert.deepEqual(ownLabels(null), {});
});

test('the update moves an older server to the new names, and can go back', () => {
  const r = read('deploy/rename-majaos.sh'), h = read('lib/update-helper.sh');
  for (const p of ['/opt', '/etc', '/var/lib', '/run']) assert.match(r, new RegExp('move ' + p + '/homebaseos ' + p + '/majaos'));
  assert.match(r, /ln -s "\$new" "\$old"/); // the old path stays as a link
  assert.match(r, /homebaseos-\$\{unit\}/);
  assert.match(r, /samba\/majaos\.conf/);
  assert.match(h, /rename-majaos\.sh/);
  assert.match(h, /systemctl stop homebaseos/);
  assert.match(h, /BACKUP\/homebaseos\.service/); // rollback to the old service
  assert.match(read('install.sh'), /rename-majaos\.sh/);
  assert.match(read('lib/dockernet.js'), /networks\/homebase'/);
});
