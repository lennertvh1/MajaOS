'use strict';
/* Tests voor de opslaglocaties (appgegevens, VM's, ISO's) en het vervangen van paden bij het verhuizen. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
delete process.env.APPDATA_DIR; delete process.env.VM_DIR; delete process.env.ISO_DIR; delete process.env.SHARES_DIR;
const paths = require('../lib/paths');
const { replacePath } = require('../lib/migrate');

test('opslaglocaties: niets ingesteld, een nieuwe pool, en een eigen keuze', () => {
  assert.deepEqual(paths.all(), { appdata: null, vms: null, isos: null, shares: null });
  assert.equal(paths.shown('appdata'), '/<pool>/appdata');
  assert.equal(paths.exists('appdata'), false);
  // Een "pool" met de standaardmappen: alles wat nog geen plek had, komt erop.
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pool-'));
  for (const f of paths.DEFAULT_FOLDERS) fs.mkdirSync(path.join(pool, f));
  assert.deepEqual(paths.adoptPool(pool).sort(), ['appdata', 'isos', 'shares', 'vms']);
  assert.equal(paths.dir('appdata'), path.join(pool, 'appdata'));
  assert.equal(paths.dir('shares'), pool);
  // Een tweede pool verandert niets meer.
  const pool2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pool-'));
  for (const f of paths.DEFAULT_FOLDERS) fs.mkdirSync(path.join(pool2, f));
  assert.deepEqual(paths.adoptPool(pool2), []);
  paths.save({ vms: path.join(pool2, 'vms') });
  paths._reset();
  assert.equal(paths.dir('vms'), path.join(pool2, 'vms'));
  assert.equal(paths.dir('appdata'), path.join(pool, 'appdata'));
  assert.throws(() => paths.save({ appdata: 'relatief/pad' }), /volledig pad/);
});

test('verhuizen: alleen volledige paden vervangen', () => {
  const text = [
    '    volumes:', '      - "/snel/appdata/jellyfin:/config"', '      - /snel/appdata:/all', '      - "/snel/appdata2/x:/y"',
    '      - type: bind', '        source: /snel/appdata/kuma', '    labels:', '      homebaseos.data: "/snel/appdata/jellyfin,/snel/appdata/kuma"',
  ].join('\n');
  const out = replacePath(text, '/snel/appdata', '/tank/appdata');
  assert.match(out, /"\/tank\/appdata\/jellyfin:\/config"/);
  assert.match(out, /- \/tank\/appdata:\/all/);
  assert.match(out, /"\/snel\/appdata2\/x:\/y"/); // ander pad, blijft staan
  assert.match(out, /source: \/tank\/appdata\/kuma/);
  assert.match(out, /homebaseos\.data: "\/tank\/appdata\/jellyfin,\/tank\/appdata\/kuma"/);
});
