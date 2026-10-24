'use strict';
/* Tests for browsing files in a shared folder: path checks and list/mkdir/rename/delete/upload. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const zip = require('../lib/zip');

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

test('readText returns text and refuses a binary file', () => {
  const root = tmpShare();
  try {
    assert.equal(files.readText('media', 'readme.txt').text, 'hello');
    fs.writeFileSync(path.join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
    assert.throws(() => files.readText('media', 'photo.png'), /not a text file/);
    fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(1048577, 0x61));
    assert.throws(() => files.readText('media', 'big.txt'), /too big to edit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('places lists shared folders plus the VM and ISO folders', async () => {
  const root = tmpShare();
  const vms = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-vms-'));
  const isos = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-isos-'));
  fs.writeFileSync(path.join(vms, 'haos.qcow2'), 'disk');
  fs.writeFileSync(path.join(isos, 'debian.iso'), 'iso');
  // The VM folder is the same as the share, so it must not show up a second time.
  fs.writeFileSync(path.join(DATA_DIR, 'paths.json'), JSON.stringify({ vms: root, isos }));
  require('../lib/paths')._reset();
  try {
    const ids = (await files.places()).map((p) => p.id);
    assert.ok(ids.includes('media'));
    assert.ok(!ids.includes('@vms'));
    assert.ok(ids.includes('@isos'));
    const listed = files.list('@isos', '');
    assert.ok(listed.items.some((x) => x.name === 'debian.iso' && x.type === 'file'));
    files.mkdir('@isos', 'extra');
    assert.ok(files.list('@isos', '').items.some((x) => x.name === 'extra' && x.type === 'dir'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(vms, { recursive: true, force: true });
    fs.rmSync(isos, { recursive: true, force: true });
  }
});

test('copy places a duplicate next to the original', () => {
  const root = tmpShare();
  try {
    const file = files.act('media', { action: 'copy', path: 'readme.txt' });
    assert.equal(file.name, 'readme copy.txt');
    assert.equal(fs.readFileSync(path.join(root, 'readme copy.txt'), 'utf8'), 'hello');
    const again = files.act('media', { action: 'copy', path: 'readme.txt' });
    assert.equal(again.name, 'readme copy 2.txt');
    const folder = files.act('media', { action: 'copy', path: 'Movies' });
    assert.equal(folder.name, 'Movies copy');
    assert.equal(fs.readFileSync(path.join(root, 'Movies copy', 'Dune.mkv'), 'utf8'), 'video');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function storedEntries(buf) {
  const out = [];
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    let p = i + 30 + nameLen + extra;
    const mark = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
    const desc = buf.indexOf(mark, p);
    assert.ok(desc >= p);
    const data = buf.slice(p, desc);
    const crc = buf.readUInt32LE(desc + 4);
    const size = buf.readUInt32LE(desc + 8);
    out.push({ name, data, crc, size });
    i = desc + 16;
  }
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  return out;
}

test('a folder download is a stored zip and skips a symlink', async () => {
  const root = tmpShare();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-zip-out-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret'), 'hidden');
    fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'Movies', 'secret.mkv'));
    const chunks = [];
    const res = new PassThrough();
    res.writeHead = () => {};
    res.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => res.on('end', resolve));
    await files.sendZip(res, 'media', 'Movies');
    await done;
    const entries = storedEntries(Buffer.concat(chunks));
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('Movies/'));
    assert.ok(names.includes('Movies/Dune.mkv'));
    assert.ok(!names.some((n) => n.includes('secret')));
    const dune = entries.find((e) => e.name === 'Movies/Dune.mkv');
    assert.equal(dune.data.toString('utf8'), 'video');
    assert.equal(dune.size, 5);
    assert.equal(dune.crc, zip.crc32(Buffer.from('video')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a file larger than 4 GB is refused before the zip starts', async () => {
  const root = tmpShare();
  try {
    const big = path.join(root, 'Movies', 'huge.mkv');
    const fd = fs.openSync(big, 'w');
    fs.ftruncateSync(fd, 0x100000001);
    fs.closeSync(fd);
    const res = new PassThrough();
    let started = false;
    res.writeHead = () => { started = true; };
    await assert.rejects(() => files.sendZip(res, 'media', 'Movies'), /4 GB/);
    assert.equal(started, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
