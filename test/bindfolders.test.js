'use strict';
/* Folders an app mounts that don't exist yet: which ones MajaOS makes beforehand (and gives to the app user). */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'majaos-binds-'));
const { bindFolderPlan, folderSuggestions } = require('../lib/appstore');

test('missing folders on a pool are made, also outside the app data', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'majaos-pool-')));
  const pool = path.join(tmp, 'tank'), appdata = path.join(pool, 'appdata');
  fs.mkdirSync(appdata, { recursive: true });
  const plan = bindFolderPlan([path.join(pool, 'media/movies'), path.join(pool, 'media/shows'), path.join(appdata, 'arr/config')], [appdata, pool]);
  assert.deepEqual(plan, [
    { base: pool, rest: ['media', 'movies'] }, // media itself is new too: it is made and given away as well
    { base: pool, rest: ['media', 'shows'] },
    { base: appdata, rest: ['arr', 'config'] },
  ]);
});

test('never outside the pools, never an existing folder, never through a symlink out of the pool', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'majaos-pool-')));
  const pool = path.join(tmp, 'tank'), outside = path.join(tmp, 'etc');
  fs.mkdirSync(path.join(pool, 'media'), { recursive: true }); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(pool, 'escape'));
  const plan = bindFolderPlan([
    path.join(outside, 'new'),            // not on a pool
    path.join(pool, 'media'),             // exists: keeps its owner
    path.join(pool, 'escape/new'),        // through a symlink out of the pool
    path.join(pool, '../etc/x'),          // ..
    'relative/folder',                    // not a full path
    pool,                                 // the pool itself
  ], [pool]);
  assert.deepEqual(plan, []);
});

test('folder suggestions never list folders outside the pools', async () => {
  const r = await folderSuggestions('/etc');
  assert.deepEqual(r, { path: '/etc', dirs: [] });
  assert.equal((await folderSuggestions('relative/path')).path, null);
});
