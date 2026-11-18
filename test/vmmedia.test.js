'use strict';
/* Tests for files for VMs: names, the output of xz and unzip, and uploading (with unpacking a .gz). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-vmmedia-data-'));
const ISO_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-vmmedia-isos-'))); // no symlink (/var on macOS)
process.env.DATA_DIR = DATA_DIR;
process.env.ISO_DIR = ISO_DIR;
const media = require('../lib/vmmedia');

// A request body as the server gets it: a stream that says when it is complete.
function body(buf) {
  const r = Readable.from([buf]);
  r.complete = false;
  r.on('end', () => { r.complete = true; });
  return r;
}
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
}

test('cleanName keeps a plain file name and drops paths and odd signs', () => {
  assert.equal(media.cleanName('haos_ova-16.2.qcow2.xz'), 'haos_ova-16.2.qcow2.xz');
  assert.equal(media.cleanName('../../etc/passwd'), 'passwd');
  assert.equal(media.cleanName('C:\\Users\\me\\disk.vmdk'), 'disk.vmdk');
  assert.equal(media.cleanName('.hidden.iso'), 'hidden.iso');
  assert.equal(media.cleanName('my disk;rm -rf.qcow2'), 'my disk-rm -rf.qcow2');
  assert.equal(media.cleanName('a\nb.iso'), 'a-b.iso');
});

test('acceptable takes disk files and ISOs, also packed', () => {
  for (const n of ['x.iso', 'x.qcow2', 'x.IMG', 'x.raw', 'x.vmdk', 'x.vhdx', 'x.vdi', 'x.qcow2.xz', 'x.img.gz', 'x.zip']) assert.ok(media.acceptable(n), n);
  for (const n of ['x.txt', 'x.xz', 'x.tar.gz', 'x.exe', 'qcow2']) assert.ok(!media.acceptable(n), n);
  assert.equal(media.unpackedName('haos.qcow2.xz'), 'haos.qcow2');
  assert.equal(media.unpackedName('disk.img.gz'), 'disk.img');
  assert.equal(media.unpackedName('vm.zip'), null);
});

test('fileNameFrom reads Content-Disposition first, then the address', () => {
  assert.equal(media.fileNameFrom('https://github.com/home-assistant/operating-system/releases/download/16.2/haos_ova-16.2.qcow2.xz'), 'haos_ova-16.2.qcow2.xz');
  assert.equal(media.fileNameFrom('https://example.com/get?id=1', 'attachment; filename="debian 13.iso"'), 'debian 13.iso');
  assert.equal(media.fileNameFrom('https://example.com/get', "attachment; filename*=UTF-8''disk%20one.qcow2"), 'disk one.qcow2');
  assert.equal(media.fileNameFrom('https://example.com/a%2F..%2Fb.iso'), 'b.iso');
  assert.equal(media.fileNameFrom('https://example.com/'), '');
});

test('parseXzList and parseUnzipList read the unpacked sizes', () => {
  const xz = 'name\thaos.qcow2.xz\nfile\t1\t1\t412345678\t1234567890\t0.334\tCRC64\t0\t-\ntotals\t1\t1\t412345678\t1234567890\t0.334\tCRC64\t0\t1\n';
  assert.equal(media.parseXzList(xz), 1234567890);
  assert.equal(media.parseXzList(''), null);
  const zip = `Archive:  haos_ova-16.2.vmdk.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
        0  2025-09-01 10:00   haos/
     1024  2025-09-01 10:00   haos/README.txt
1234567890  2025-09-01 10:00   haos/haos_ova-16.2.vmdk
---------                     -------
1234568914                     3 files
`;
  const list = media.parseUnzipList(zip);
  assert.deepEqual(list, [{ name: 'haos/README.txt', size: 1024 }, { name: 'haos/haos_ova-16.2.vmdk', size: 1234567890 }]);
  assert.deepEqual(media.pickZipMember(list), { name: 'haos/haos_ova-16.2.vmdk', size: 1234567890 });
  assert.equal(media.pickZipMember([{ name: 'a.txt', size: 1 }]), null);
  assert.deepEqual(media.pickZipMember([{ name: 'a.iso', size: 9 }, { name: 'b.qcow2', size: 1 }]), { name: 'b.qcow2', size: 1 });
});

test('upload writes a disk file into the ISO folder and refuses other kinds and existing names', async () => {
  const r = await media.upload(body(Buffer.from('QFI disk')), 'test.qcow2');
  assert.equal(r.name, 'test.qcow2');
  assert.equal(fs.readFileSync(path.join(ISO_DIR, 'test.qcow2'), 'utf8'), 'QFI disk');
  await assert.rejects(media.upload(body(Buffer.from('x')), 'test.qcow2'), /already a file called test.qcow2/);
  await assert.rejects(media.upload(body(Buffer.from('x')), 'notes.txt'), /Choose a disk file or ISO/);
  assert.deepEqual(fs.readdirSync(ISO_DIR).sort(), ['test.qcow2']);
});

test('upload of a .gz unpacks it next to it and removes the archive', async () => {
  const data = Buffer.alloc(300000, 7);
  const r = await media.upload(body(zlib.gzipSync(data)), 'small.img.gz');
  assert.ok(r.job && r.job.id);
  const job = await until(() => { const j = media.getJob(r.job.id); return !j.running && j; });
  assert.equal(job.state, 'done', job.error);
  assert.equal(job.name, 'small.img');
  assert.equal(job.percent, 100);
  assert.ok(fs.readFileSync(path.join(ISO_DIR, 'small.img')).equals(data));
  assert.ok(!fs.existsSync(path.join(ISO_DIR, 'small.img.gz')));
  // A broken archive: the job fails, nothing half is left behind.
  const bad = await media.upload(body(Buffer.from('not gzip at all')), 'broken.img.gz');
  const failed = await until(() => { const j = media.getJob(bad.job.id); return !j.running && j; });
  assert.equal(failed.state, 'failed');
  assert.deepEqual(fs.readdirSync(ISO_DIR).filter((n) => /broken|majaos-upload/.test(n)), []);
});

test('download refuses addresses that are not http(s)', async () => {
  await assert.rejects(media.download({ url: 'file:///etc/passwd' }), /https:\/\//);
  await assert.rejects(media.download({ url: 'not a link' }), /https:\/\//);
});

test('checkSource refuses relative paths, .. and files outside the pools', async () => {
  await assert.rejects(media.checkSource('disk.qcow2', 'disk'), /pools/);
  await assert.rejects(media.checkSource('/tank/../etc/x.qcow2', 'disk'), /pools/);
  await assert.rejects(media.checkSource(path.join(ISO_DIR, 'test.qcow2'), 'disk'), /pools/); // no pools in the test
  await assert.rejects(media.checkSource(path.join(ISO_DIR, 'missing.qcow2'), 'disk'), /doesn't exist/);
});

test('download follows a redirect, takes the name of the final address and unpacks it', async () => {
  const http = require('node:http');
  const data = Buffer.alloc(200000, 3);
  const packed = zlib.gzipSync(data);
  const srv = http.createServer((req, res) => {
    if (req.url === '/latest') { res.writeHead(302, { Location: '/files/haos_test.qcow2.gz' }); return res.end(); }
    if (req.url === '/files/haos_test.qcow2.gz') { res.writeHead(200, { 'Content-Length': packed.length }); return res.end(packed); }
    if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html></html>'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const j = await media.download({ url: base + '/latest' });
    const done = await until(() => { const x = media.getJob(j.id); return !x.running && x; });
    assert.equal(done.state, 'done', done.error);
    assert.equal(done.name, 'haos_test.qcow2');
    assert.ok(fs.readFileSync(path.join(ISO_DIR, 'haos_test.qcow2')).equals(data));
    assert.ok(!fs.existsSync(path.join(ISO_DIR, 'haos_test.qcow2.gz')));
    // Already there now: refused before downloading.
    await assert.rejects(media.download({ url: base + '/files/haos_test.qcow2.gz' }), /already a file called haos_test.qcow2/);
    // A web page instead of a file, and a 404: the job fails with a plain message.
    const page = await media.download({ url: base + '/page' });
    const p = await until(() => { const x = media.getJob(page.id); return !x.running && x; });
    assert.match(p.error, /doesn't point to a disk file or ISO/);
    const missing = await media.download({ url: base + '/nothing.iso' });
    const m = await until(() => { const x = media.getJob(missing.id); return !x.running && x; });
    assert.match(m.error, /answered 404/);
    assert.deepEqual(fs.readdirSync(ISO_DIR).filter((n) => n.startsWith('.')), []);
  } finally { srv.close(); }
});
