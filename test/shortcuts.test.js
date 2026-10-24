'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-cut-'));
process.env.DATA_DIR = dir;
const sc = require('../lib/shortcuts');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function reader(buf) {
  let sent = false;
  return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: buf }; } };
}
function res(status, buf, headers) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] || null }, body: { getReader: () => reader(buf), cancel() {} } };
}

test('a shortcut address is http or https, without a password in it', () => {
  assert.equal(sc.normalizeUrl('https://example.com/a#x'), 'https://example.com/a');
  assert.equal(sc.normalizeUrl('http://192.168.1.1/admin'), 'http://192.168.1.1/admin');
  assert.throws(() => sc.normalizeUrl('javascript:alert(1)'), /http:\/\/ or https:\/\//);
  assert.throws(() => sc.normalizeUrl('ftp://files.example/a'), /http:\/\/ or https:\/\//);
  assert.throws(() => sc.normalizeUrl('https://user:secret@example.com/'), /user name and password/);
  assert.throws(() => sc.normalizeUrl('not a url'), /not a valid address/);
});

test('icon links in a page, best first, and no SVG', () => {
  const html = '<html><head>'
    + '<link rel="icon" href="/favicon.ico">'
    + '<link rel="apple-touch-icon" href="icon.png">'
    + '<link rel="icon" href="logo.svg">'
    + '<link rel="stylesheet" href="a.css">'
    + '</head></html>';
  assert.deepEqual(sc.linkIcons(html, 'https://nas.home/apps/'), [
    'https://nas.home/apps/icon.png',
    'https://nas.home/favicon.ico',
  ]);
});

test('an uploaded icon is a real image, not SVG', () => {
  assert.equal(sc.sniffImage(PNG), 'image/png');
  assert.equal(sc.sniffImage(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 0, 0])), 'image/x-icon');
  const got = sc.decodeIcon('data:image/png;base64,' + PNG.toString('base64'));
  assert.equal(got.type, 'image/png');
  assert.throws(() => sc.decodeIcon('data:image/svg+xml;base64,' + Buffer.from('<svg></svg>').toString('base64')), /PNG, JPEG/);
});

test('the site icon is fetched, and a shortcut keeps it', async () => {
  const real = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/icon.png')) return res(200, PNG, {});
    if (u.endsWith('/favicon.ico')) return res(404, Buffer.from('no'), {});
    return res(200, Buffer.from('<html><link rel="icon" href="/icon.png"></html>'), { 'content-type': 'text/html' });
  };
  try {
    const made = await sc.create({ name: ' Router ', url: 'https://192.168.1.1/admin#top', fetchIcon: true });
    assert.equal(made.name, 'Router');
    assert.equal(made.url, 'https://192.168.1.1/admin');
    assert.equal(made.iconFetched, true);
    assert.match(made.icon, /^\/api\/shortcuts\/s[0-9a-f]{8}\/icon\?v=1$/);
    const ic = sc.icon(made.id);
    assert.equal(ic.type, 'image/png');
    assert.equal(fs.readFileSync(ic.path).length, PNG.length);
    const edited = await sc.update(made.id, { name: 'Router', url: 'https://192.168.1.1/', fetchIcon: false });
    assert.equal(edited.icon, made.icon); // the same icon stays
    const listed = sc.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, made.id);
    assert.deepEqual(sc.remove(made.id), { removed: made.id });
    assert.equal(sc.list().length, 0);
    assert.equal(fs.existsSync(ic.path), false);
  } finally { global.fetch = real; }
});

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
