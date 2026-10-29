'use strict';
/* A link for one file or folder, so someone can open it without an account.
 * The link is /s/<token>. It stays inside that file or folder.
 * HTML and SVG are downloaded, not shown, so a file cannot run as this site. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { httpError } = require('./system');
const files = require('./files');
const tunnel = require('./tunnel');

const MAX = 100;
const INLINE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/flac', 'application/pdf']);
const fails = new Map();

function dataDir() { return process.env.DATA_DIR || '/var/lib/majaos'; }
function file() { return path.join(dataDir(), 'links.json'); }

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')).links || []; } catch { return []; }
}

function save(links) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file() + '.tmp', JSON.stringify({ links }, null, 2), { mode: 0o600 });
  fs.renameSync(file() + '.tmp', file());
}

function live(row, now = Date.now()) {
  return row && (!row.expires || row.expires > now);
}

function prune(links, now = Date.now()) {
  const next = links.filter((row) => live(row, now));
  if (next.length !== links.length) save(next);
  return next;
}

function placeId(id) {
  const s = String(id || '');
  if (!/^[@A-Za-z0-9][A-Za-z0-9_.-]{0,64}$/.test(s)) throw httpError('Choose a folder.', 400);
  return s;
}

function expiry(days) {
  if (days === 0 || days === '0') return null;
  const n = Number(days);
  if (![1, 7, 30].includes(n)) throw httpError('Choose how long the link works.', 400);
  return Date.now() + n * 86400000;
}

function publish(row) {
  const p = '/s/' + row.token;
  const base = tunnel.publicUrl();
  return {
    id: row.id, name: row.name, dir: !!row.dir, place: row.place, rel: row.rel,
    created: row.created, expires: row.expires, path: p, url: base ? base + p : null,
  };
}

function targetRel(link, rest) {
  const extra = files.splitRel(rest);
  if (!link.dir && extra.length) throw httpError('This link is for one file.', 404);
  return [link.rel, ...extra].filter(Boolean).join('/');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dutch(header) {
  return String(header || '').split(',')[0].trim().toLowerCase().startsWith('nl');
}

const COPY = {
  en: {
    missing: 'This link does not exist.',
    expired: 'This link has expired.',
    one: 'This link is for one file.',
    wait: 'Too many wrong links. Wait 5 minutes and try again.',
    download: 'Download',
    empty: 'This folder is empty.',
    via: 'Shared with MajaOS',
    folder: 'Shared folder',
  },
  nl: {
    missing: 'Deze link bestaat niet.',
    expired: 'Deze link is verlopen.',
    one: 'Deze link is voor één bestand.',
    wait: 'Te veel foute links. Wacht 5 minuten en probeer het opnieuw.',
    download: 'Downloaden',
    empty: 'Deze map is leeg.',
    via: 'Gedeeld via MajaOS',
    folder: 'Gedeelde map',
  },
};

function text(header, key) {
  return (dutch(header) ? COPY.nl : COPY.en)[key];
}

function htmlHeaders() {
  return {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  };
}

function messagePage(message) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(message)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:12vh auto;max-width:32rem;padding:0 1.2rem;color:#1c2430}h1{font-size:1.25rem;font-weight:600}</style><h1>${esc(message)}</h1></html>`;
}

function hrefFor(token, rel) {
  const parts = String(rel || '').split('/').filter(Boolean).map(encodeURIComponent);
  return '/s/' + token + (parts.length ? '/' + parts.join('/') : '');
}

function folderPage(link, listed, header) {
  const t = (k) => text(header, k);
  const rows = (listed.items || []).map((it) => {
    const rel = listed.path ? listed.path + '/' + it.name : it.name;
    return `<li><a href="${esc(hrefFor(link.token, rel))}">${esc(it.name)}</a>${it.type === 'dir' ? '/' : ''}</li>`;
  }).join('');
  const title = link.name || t('folder');
  return `<!doctype html><html lang="${dutch(header) ? 'nl' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:8vh auto;max-width:36rem;padding:0 1.2rem;color:#1c2430}
h1{font-size:1.35rem;font-weight:600}a{color:#0b57d0}ul{padding:0;list-style:none}li{padding:.45rem 0;border-top:1px solid #e4e8ee}
.top{display:flex;justify-content:space-between;gap:1rem;align-items:center}.btn{display:inline-block;background:#0b57d0;color:#fff;text-decoration:none;border-radius:.6rem;padding:.4rem .8rem}
p{color:#5c6b7a}</style><div class="top"><h1>${esc(title)}</h1><a class="btn" href="?download=1">${esc(t('download'))}</a></div>
${rows ? `<ul>${rows}</ul>` : `<p>${esc(t('empty'))}</p>`}<p>${esc(t('via'))}</p></html>`;
}

function blocked(ip) {
  const row = fails.get(ip);
  return !!(row && row.until > Date.now());
}

function failed(ip) {
  const now = Date.now();
  const row = fails.get(ip) || { n: 0, at: now, until: 0 };
  if (now - row.at > 10 * 60 * 1000) { row.n = 0; row.at = now; }
  row.n += 1;
  if (row.n >= 10) row.until = now + 5 * 60 * 1000;
  fails.set(ip, row);
}

// Compared in constant time (hashes of equal length), and every link is checked: the answer time says nothing about the token.
function found(token) {
  const want = crypto.createHash('sha256').update(String(token || '')).digest();
  let hit = null;
  for (const row of prune(load())) {
    if (crypto.timingSafeEqual(want, crypto.createHash('sha256').update(String(row.token || '')).digest()) && !hit) hit = row;
  }
  return hit;
}

async function create(body) {
  const place = placeId(body.place);
  await files.prepare(place);
  const info = files.describe(place, body.path || '');
  const links = prune(load());
  if (links.length >= MAX) throw httpError('Remove a shared link first. You can have 100.', 409);
  const row = {
    id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(18).toString('base64url'),
    place, rel: info.rel, name: info.name, dir: info.dir, created: Date.now(), expires: expiry(body.days),
  };
  links.push(row);
  save(links);
  return publish(row);
}

function list() {
  return prune(load()).map(publish);
}

function remove(id) {
  const links = load();
  const i = links.findIndex((row) => row.id === id);
  if (i < 0) throw httpError('This link does not exist.', 404);
  links.splice(i, 1);
  save(links);
  return { removed: id };
}

async function send(req, res, token, rest, ip) {
  const header = req.headers['accept-language'];
  const write = (status, html) => { res.writeHead(status, htmlHeaders()); res.end(html); };
  if (blocked(ip)) { write(429, messagePage(text(header, 'wait'))); return; }
  const link = found(token);
  if (!link) { failed(ip); write(404, messagePage(text(header, 'missing'))); return; }
  let rel;
  try { rel = targetRel(link, rest); }
  catch (e) { write(e.status || 404, messagePage(text(header, e.message === 'This link is for one file.' ? 'one' : 'missing'))); return; }
  await files.prepare(link.place);
  const url = new URL(req.url, 'http://localhost');
  const info = files.describe(link.place, rel);
  if (info.dir) {
    if (url.searchParams.get('download') === '1') { await files.sendZip(res, link.place, rel); return; }
    write(200, folderPage({ ...link, name: info.name }, files.list(link.place, rel), header));
    return;
  }
  const mime = String(files.mimeOf(info.name)).split(';')[0];
  files.sendFile(res, link.place, rel, { inline: INLINE.has(mime), range: req.headers.range });
}

module.exports = { create, list, remove, send, publish, targetRel, messagePage, folderPage, esc };
