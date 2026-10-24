'use strict';
/*
 * Shortcuts on the home screen: a name, an http(s) address and an icon.
 * DATA_DIR/shortcuts.json: { shortcuts: [{ id, name, url, icon, rev }] }
 * icon is a mime type (or null). The bytes live in DATA_DIR/shortcut-icons/<id>.
 * The home screen places them with a { shortcut: "<id>" } item in the layout.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'shortcuts.json');
const ICON_DIR = path.join(DATA_DIR, 'shortcut-icons');
const ID = /^s[0-9a-f]{8}$/;
const MAX = 200;
const MAX_ICON = 512 * 1024;
const TIMEOUT = 8000;

function httpFail(message, status) { const e = httpError(message); e.status = status || 400; return e; }

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { shortcuts: [] }; }
}
function write(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, FILE);
}
function iconPath(id) { return path.join(ICON_DIR, id); }

function cleanName(name) {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  if (!s) throw httpFail('Choose a name.');
  return s;
}

// Only http and https, and no user name or password in the address.
// A bare name such as google.com is read as https://google.com.
function normalizeUrl(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (text && !/^[a-z][a-z0-9+.-]*:/i.test(text)) text = 'https://' + text;
  let u;
  try { u = new URL(text); }
  catch { throw httpFail('That is not a valid address. Start it with http:// or https://.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpFail('The address must start with http:// or https://.');
  if (u.username || u.password) throw httpFail('Leave the user name and password out of the address.');
  if (!u.hostname) throw httpFail('That is not a valid address. Start it with http:// or https://.');
  u.hash = '';
  const out = u.toString();
  if (out.length > 2000) throw httpFail('That address is too long.');
  return out;
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  return null;
}

// A data URL from the browser. The type comes from the bytes, not the label.
function decodeIcon(dataUrl) {
  const m = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) throw httpFail('The icon has to be a PNG, JPEG, GIF, WebP or ICO image.');
  let buf;
  try { buf = Buffer.from(m[1].replace(/\s/g, ''), 'base64'); } catch { buf = Buffer.alloc(0); }
  if (!buf.length || buf.length > MAX_ICON) throw httpFail('The icon is too big (at most 512 KB).');
  const type = sniffImage(buf);
  if (!type) throw httpFail('The icon has to be a PNG, JPEG, GIF, WebP or ICO image.');
  return { buf, type };
}

function decodeAttr(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function attr(tag, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+))', 'i').exec(tag);
  if (!m) return '';
  return decodeAttr(m[1] || m[2] || m[3] || '').trim();
}

// Icon addresses from a page, best first. SVG is skipped: it is not stored.
function linkIcons(html, base) {
  const found = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const tag = m[0];
    const rel = attr(tag, 'rel');
    if (!rel || !/(^|\s)(icon|apple-touch-icon(?:-precomposed)?|shortcut icon)(\s|$)/i.test(rel)) continue;
    const raw = attr(tag, 'href');
    if (!raw || /\.svg(\?|$)/i.test(raw)) continue;
    try {
      const abs = new URL(raw, base).href;
      if (!/^https?:/i.test(abs)) continue;
      const apple = /apple-touch-icon/i.test(rel[1]);
      const png = /\.png(\?|$)/i.test(abs);
      found.push({ abs, rank: apple ? 0 : png ? 1 : 2 });
    } catch { /* skip a broken address */ }
  }
  // A small favicon.ico is blurry on a tile. A logo PNG named in the page (Google does this) is sharper.
  const meta = /<meta\b[^>]*>/gi;
  while ((m = meta.exec(String(html || '')))) {
    const tag = m[0];
    if (!/^image$/i.test(attr(tag, 'itemprop'))) continue;
    const raw = attr(tag, 'content');
    if (!/\.(png|jpe?g|webp|gif)(\?|$)/i.test(raw) || !/icon|favicon|logo|apple-touch|branding/i.test(raw)) continue;
    if (/hero|banner|social|og-image/i.test(raw)) continue;
    try {
      const abs = new URL(raw, base).href;
      if (/^https?:/i.test(abs)) found.push({ abs, rank: 1 });
    } catch { /* skip */ }
  }
  found.sort((a, b) => a.rank - b.rank);
  const out = [];
  found.forEach((x) => { if (!out.includes(x.abs)) out.push(x.abs); });
  return out;
}

async function getBytes(start, limit, soft) {
  let u;
  try { u = new URL(start); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
  let res;
  try {
    res = await fetch(u.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HomeBaseOS)',
        Accept: 'image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon,text/html;q=0.8,*/*;q=0.5',
      },
    });
  } catch { return null; }
  try {
    const finalUrl = new URL(res.url || start);
    if (finalUrl.protocol !== 'http:' && finalUrl.protocol !== 'https:') return null;
  } catch { return null; }
  if (!res.ok) return null;
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return null;
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          if (soft) chunks.push(Buffer.from(value.subarray(0, value.length - (size - limit))));
          try { await reader.cancel(); } catch { /* ignore */ }
          return soft ? { buf: Buffer.concat(chunks) } : null;
        }
        chunks.push(Buffer.from(value));
      }
    } catch { return null; }
    return { buf: Buffer.concat(chunks) };
}

// Google's own favicon.ico is only 16 and 32 pixels, so a tile looks blurry. Their logo PNG is stable.
function extraIcons(pageUrl) {
  let host = '';
  try { host = new URL(pageUrl).hostname.toLowerCase(); } catch { return []; }
  if (/(^|\.)google\.(com?\.)?[a-z]{2,}$/.test(host)) return ['https://www.google.com/images/branding/googleg/1x/googleg_standard_color_128dp.png'];
  return [];
}

// The page's own icon: an icon link in the HTML, otherwise /favicon.ico.
async function fetchFavicon(pageUrl) {
  const page = await getBytes(pageUrl, 200 * 1024, true);
  const pageType = page && sniffImage(page.buf);
  if (pageType) return { buf: page.buf, type: pageType };
  const html = page && page.buf.length <= 200 * 1024 ? page.buf.toString('utf8') : '';
  const icons = linkIcons(html, pageUrl);
  extraIcons(pageUrl).forEach((href) => { if (!icons.includes(href)) icons.unshift(href); });
  let fav;
  try { fav = new URL('/favicon.ico', pageUrl).href; } catch { fav = null; }
  if (fav && !icons.includes(fav)) icons.push(fav);
  for (const href of icons) {
    if (href === pageUrl) continue;
    const got = await getBytes(href, MAX_ICON);
    const type = got && sniffImage(got.buf);
    if (type) return { buf: got.buf, type };
  }
  return null;
}

function pub(s) {
  return { id: s.id, name: s.name, url: s.url, icon: s.icon ? `/api/shortcuts/${s.id}/icon?v=${s.rev || 1}` : null };
}

function list() {
  return read().shortcuts.filter((s) => s && ID.test(s.id)).map(pub);
}

function must(id) {
  if (!ID.test(String(id || ''))) throw httpFail('Unknown shortcut.', 404);
  const data = read();
  const s = data.shortcuts.find((x) => x.id === id);
  if (!s) throw httpFail('Unknown shortcut.', 404);
  return { data, s };
}

function storeIcon(id, decoded) {
  if (!decoded) return;
  fs.mkdirSync(ICON_DIR, { recursive: true, mode: 0o700 });
  const tmp = iconPath(id) + '.tmp';
  fs.writeFileSync(tmp, decoded.buf, { mode: 0o600 });
  fs.renameSync(tmp, iconPath(id));
}
function dropIcon(id) {
  try { fs.unlinkSync(iconPath(id)); } catch { /* already gone */ }
}

async function iconBytes(body, url, previous) {
  if (body.icon) return { decoded: decodeIcon(body.icon), fetched: false };
  if (body.fetchIcon) {
    const got = await fetchFavicon(url);
    return { decoded: got, fetched: !!got, tried: true };
  }
  return { decoded: null, fetched: false, keep: !!previous };
}

async function create(body) {
  const data = read();
  if (data.shortcuts.length >= MAX) throw httpFail('There are already 200 shortcuts. Remove one first.');
  const name = cleanName(body.name);
  const url = normalizeUrl(body.url);
  const icon = await iconBytes(body, url, null);
  const id = 's' + crypto.randomBytes(4).toString('hex');
  const item = { id, name, url, icon: icon.decoded ? icon.decoded.type : null, rev: icon.decoded ? 1 : 0 };
  if (icon.decoded) storeIcon(id, icon.decoded);
  data.shortcuts.push(item);
  write(data);
  return { ...pub(item), iconFetched: icon.tried ? icon.fetched : undefined };
}

async function update(id, body) {
  const { data, s } = must(id);
  s.name = cleanName(body.name);
  s.url = normalizeUrl(body.url);
  const icon = await iconBytes(body, s.url, s.icon);
  if (icon.decoded) { storeIcon(s.id, icon.decoded); s.icon = icon.decoded.type; s.rev = (s.rev || 0) + 1; }
  else if (icon.tried && !icon.fetched) { /* keep the icon it already has */ }
  write(data);
  return { ...pub(s), iconFetched: icon.tried ? icon.fetched : undefined };
}

function remove(id) {
  const { data, s } = must(id);
  data.shortcuts = data.shortcuts.filter((x) => x.id !== s.id);
  write(data);
  dropIcon(s.id);
  return { removed: s.id };
}

function icon(id) {
  if (!ID.test(String(id || ''))) return null;
  const s = read().shortcuts.find((x) => x.id === id);
  if (!s || !s.icon) return null;
  const file = iconPath(id);
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (!size || size > MAX_ICON) return null;
  return { path: file, type: s.icon, size };
}

module.exports = {
  ID, list, create, update, remove, icon,
  normalizeUrl, linkIcons, sniffImage, decodeIcon, fetchFavicon,
};
