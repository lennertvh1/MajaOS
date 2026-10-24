'use strict';
/* Tests for browsing files in a shared folder: path checks and list/mkdir/rename/delete/upload. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-files-data-'));
process.env.DATA_DIR = DATA_DIR;
const files = require('../lib/files');

function tmpShare() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-files-'));
  fs.mkdirSync(path.join(root, 'Movies'));
  fs.writeFileSync(path.join(root, 'readme.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'Movies', 'Dune.mkv'), 'video');
  fs.writeFileSync(path.join(DATA_DIR, 'shares.json'), JSON.stringify({
    shares: [{ name: 'media', path: root, comment: '', users: { lisa: 'rw' }, groups: {}, guest: false, timemachine: false }],
    users: ['lisa'], groups: [],
  }));
  return root;
}

test('splitRel refuses .., empty names and control characters', () => {
  assert.deepEqual(files.splitRel('Movies/Dune.mkv'), ['Movies', 'Dune.mkv']);
  assert.deepEqual(files.splitRel('/Movies//./Dune.mkv'), ['Movies', 'Dune.mkv']);
  assert.deepEqual(files.splitRel(''), []);
  assert.throws(() => files.splitRel('../etc/passwd'), /not allowed/);
  assert.throws(() => files.splitRel('a/../b'), /not allowed/);
  assert.throws(() => files.splitRel('a\0b'), /not allowed/);
  assert.throws(() => files.fileName('a/b'), /not allowed/);
  assert.throws(() => files.fileName(''), /Choose a name/);
  assert.throws(() => files.fileName('..'), /not allowed/);
});

test('inside keeps paths under the share root', () => {
  assert.equal(files.inside('/tank/media', '/tank/media'), true);
  assert.equal(files.inside('/tank/media', '/tank/media/Movies'), true);
  assert.equal(files.inside('/tank/media', '/tank/media2'), false);
  assert.equal(files.inside('/tank/media', '/etc/passwd'), false);
});

test('resolveRel lists under a folder and refuses a symlink out', () => {
  const root = tmpShare();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-out-'));
  fs.writeFileSync(path.join(outside, 'secret'), 'no');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const ok = files.resolveRel(root, 'Movies/Dune.mkv');
  assert.equal(ok.exists, true);
  assert.equal(ok.name, 'Dune.mkv');
  assert.throws(() => files.resolveRel(root, 'escape'), /not allowed/);
  assert.throws(() => files.resolveRel(root, 'missing'), /does not exist/);
  const created = files.resolveRel(root, 'Movies/New', { createLast: true });
  assert.equal(created.exists, false);
  assert.equal(created.name, 'New');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('mkdir, list, rename, remove and upload stay in the folder', async () => {
  const root = tmpShare();
  try {
    files.mkdir('media', 'Photos');
    const listed = files.list('media', '');
    assert.ok(listed.items.some((x) => x.name === 'Photos' && x.type === 'dir'));
    assert.ok(listed.items.some((x) => x.name === 'readme.txt' && x.type === 'file' && x.size === 5));
    files.rename('media', 'readme.txt', 'HELLO.txt');
    assert.ok(files.list('media', '').items.some((x) => x.name === 'HELLO.txt'));
    files.remove('media', 'HELLO.txt');
    assert.ok(!files.list('media', '').items.some((x) => x.name === 'HELLO.txt'));
    assert.throws(() => files.remove('media', 'Movies'), /not empty/);
    files.remove('media', 'Movies', { recursive: true });
    assert.ok(!files.list('media', '').items.some((x) => x.name === 'Movies'));

    const req = Readable.from([Buffer.from('uploaded-bytes')]);
    const up = await files.upload(req, 'media', 'note.txt');
    assert.equal(up.size, 14);
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'uploaded-bytes');
    const again = Readable.from([Buffer.from('x')]);
    await assert.rejects(() => files.upload(again, 'media', 'note.txt'), /already exists/);
    const over = Readable.from([Buffer.from('y')]);
    await files.upload(over, 'media', 'note.txt', { overwrite: true });
    assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'y');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
