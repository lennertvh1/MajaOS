'use strict';
/* Browse, upload and change files inside a shared folder. Paths never leave that folder. */
const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./system');
const shares = require('./shares');
const zip = require('./zip');

const APP_UID = Number(process.env.APP_UID || 1000);
const APP_GID = Number(process.env.APP_GID || 1000);
const MAX_LIST = 4000;
const MAX_TEXT = 1048576;
const MAX_ZIP_ENTRIES = 20000;
const NAME_MAX = 255;
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'js', 'mjs', 'cjs', 'css', 'html', 'htm', 'xml', 'yaml', 'yml', 'sh', 'conf', 'log', 'py', 'ini', 'toml', 'env', 'cfg', 'service', 'ts', 'tsx', 'jsx', 'vue', 'php', 'rb', 'go', 'rs', 'sql', 'gitignore', 'properties']);
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'gemfile', 'procfile', 'authors', 'changelog']);
const MIME = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
};

function splitRel(rel) {
  const s = String(rel == null ? '' : rel).replace(/\\/g, '/');
  if (s.includes('\0') || s.length > 4000) throw httpError('That path is not allowed.', 400);
  const parts = s.split('/').filter((p) => p && p !== '.');
  for (const p of parts) {
    if (p === '..' || p.includes('\0') || /[\x00-\x1f]/.test(p)) throw httpError('That path is not allowed.', 400);
    if (p.length > NAME_MAX) throw httpError('A file name may be at most 255 characters.', 400);
  }
  return parts;
}

function fileName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) throw httpError('Choose a name.', 400);
  if (n.includes('/') || n.includes('\\') || n === '.' || n === '..') throw httpError('That name is not allowed.', 400);
  splitRel(n);
  return n;
}

function inside(root, abs) {
  const a = path.resolve(abs);
  const r = path.resolve(root);
  return a === r || a.startsWith(r + path.sep);
}

function realRoot(root) {
  try { return fs.realpathSync(root); } catch {
    throw httpError("This shared folder's folder is missing on the server.", 404);
  }
}

function resolveRel(root, rel, { createLast = false } = {}) {
  const base = realRoot(root);
  const parts = splitRel(rel);
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const next = path.join(cur, parts[i]);
    if (!fs.existsSync(next)) {
      if (last && createLast) {
        if (!inside(base, cur)) throw httpError('That path is not allowed.', 400);
        return { root: base, abs: next, rel: parts.join('/'), name: parts[i], exists: false, parent: cur };
      }
      throw httpError('This file or folder does not exist (anymore).', 404);
    }
    let real;
    try { real = fs.realpathSync(next); } catch {
      throw httpError('This file or folder does not exist (anymore).', 404);
    }
    if (!inside(base, real)) throw httpError('That path is not allowed.', 400);
    cur = real;
  }
  return {
    root: base, abs: cur, rel: parts.join('/'),
    name: parts.length ? parts[parts.length - 1] : path.basename(base),
    exists: true, parent: parts.length ? path.dirname(cur) : base,
  };
}

function ofShare(name, rel, opts) {
  return resolveRel(shares.shareByName(name).path, rel, opts);
}

function list(shareName, rel) {
  const share = shares.shareByName(shareName);
  const t = resolveRel(share.path, rel);
  const st = fs.statSync(t.abs);
  if (!st.isDirectory()) throw httpError('This is a file, not a folder.', 400);
  let names;
  try { names = fs.readdirSync(t.abs); } catch (e) { throw httpError(e.message, 500); }
  if (names.length > MAX_LIST) throw httpError('Too many files in this folder to show at once.', 400);
  const items = [];
  for (const name of names) {
    const p = path.join(t.abs, name);
    let st2, real;
    try { st2 = fs.lstatSync(p); real = fs.realpathSync(p); } catch { continue; }
    if (!inside(t.root, real)) continue;
    items.push({
      name,
      type: st2.isDirectory() ? 'dir' : st2.isSymbolicLink() ? 'link' : 'file',
      size: st2.isFile() ? st2.size : null,
      mtime: st2.mtime.toISOString(),
    });
  }
  items.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { share: share.name, path: t.rel, items };
}

function mkdir(shareName, rel) {
  const t = ofShare(shareName, rel, { createLast: true });
  if (t.exists) throw httpError('A folder with that name already exists.', 409);
  fs.mkdirSync(t.abs, { mode: 0o775 });
  try { fs.chownSync(t.abs, APP_UID, APP_GID); } catch { /* not root on a developer machine */ }
  return { name: t.name, path: t.rel };
}

function rename(shareName, rel, newName) {
  const n = fileName(newName);
  const t = ofShare(shareName, rel);
  if (!t.rel) throw httpError('You cannot rename the shared folder itself here.', 400);
  const dest = path.join(t.parent, n);
  if (!inside(t.root, dest)) throw httpError('That path is not allowed.', 400);
  if (fs.existsSync(dest)) throw httpError('A file with that name already exists. Choose another name, or overwrite it.', 409);
  fs.renameSync(t.abs, dest);
  const parts = t.rel.split('/');
  parts[parts.length - 1] = n;
  return { name: n, path: parts.join('/') };
}

function remove(shareName, rel, { recursive } = {}) {
  const t = ofShare(shareName, rel);
  if (!t.rel) throw httpError('You cannot delete the shared folder itself here.', 400);
  const st = fs.lstatSync(t.abs);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    const kids = fs.readdirSync(t.abs);
    if (kids.length && !recursive) throw httpError('The folder is not empty. Tick the box to delete everything in it.', 409);
    fs.rmSync(t.abs, { recursive: true });
  } else fs.unlinkSync(t.abs);
  return { removed: t.name };
}

function isTextName(name) {
  const base = path.basename(String(name || '')).toLowerCase();
  if (TEXT_NAMES.has(base)) return true;
  return TEXT_EXT.has(path.extname(base).slice(1));
}

function readText(shareName, rel) {
  const t = ofShare(shareName, rel);
  const st = fs.lstatSync(t.abs);
  if (!st.isFile() || st.isSymbolicLink()) throw httpError('Choose a file to edit.', 400);
  if (!isTextName(t.name)) throw httpError('This file is not a text file.', 400);
  if (st.size > MAX_TEXT) throw httpError('This file is too big to edit here. Download it instead.', 400);
  const buf = fs.readFileSync(t.abs);
  if (buf.includes(0)) throw httpError('This file is not a text file.', 400);
  return { name: t.name, path: t.rel, text: buf.toString('utf8') };
}

function copyName(name, exists) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = `${stem} copy${ext}`;
  let n = 2;
  while (exists(candidate)) {
    candidate = `${stem} copy ${n}${ext}`;
    n += 1;
    if (n > 1000) throw httpError('A file with that name already exists. Choose another name, or overwrite it.', 409);
  }
  return candidate;
}

function ownTree(abs) {
  try { fs.chownSync(abs, APP_UID, APP_GID); } catch { return; }
  let st;
  try { st = fs.lstatSync(abs); } catch { return; }
  if (!st.isDirectory() || st.isSymbolicLink()) return;
  for (const name of fs.readdirSync(abs)) ownTree(path.join(abs, name));
}

function copyItem(shareName, rel) {
  const t = ofShare(shareName, rel);
  if (!t.rel) throw httpError('You cannot copy the shared folder itself here.', 400);
  const st = fs.lstatSync(t.abs);
  if (st.isSymbolicLink()) throw httpError('That path is not allowed.', 400);
  const destName = copyName(t.name, (n) => fs.existsSync(path.join(t.parent, n)));
  const dest = path.join(t.parent, destName);
  if (!inside(t.root, dest)) throw httpError('That path is not allowed.', 400);
  fs.cpSync(t.abs, dest, { recursive: true, errorOnExist: true });
  ownTree(dest);
  const parts = t.rel.split('/');
  parts[parts.length - 1] = destName;
  return { name: destName, path: parts.join('/') };
}

function act(shareName, body) {
  const action = body && body.action;
  if (action === 'mkdir') return mkdir(shareName, body.path);
  if (action === 'rename') return rename(shareName, body.path, body.name);
  if (action === 'copy') return copyItem(shareName, body.path);
  throw httpError('Unknown action.', 400);
}

function upload(req, shareName, rel, { overwrite } = {}) {
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = ofShare(shareName, rel, { createLast: true });
      if (!t.rel) throw httpError('Choose a name.', 400);
      if (t.exists) {
        const st = fs.lstatSync(t.abs);
        if (st.isDirectory()) throw httpError('A folder with that name already exists.', 409);
        if (!overwrite) throw httpError('A file with that name already exists. Choose another name, or overwrite it.', 409);
      }
    } catch (e) { return reject(e); }
    const tmp = t.abs + '.homebaseos-upload';
    const out = fs.createWriteStream(tmp, { flags: 'w' });
    const fail = (e) => {
      req.unpipe(out); out.destroy();
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      reject(e.status ? e : httpError(e.message, 500));
    };
    req.on('error', fail);
    out.on('error', fail);
    req.pipe(out);
    out.on('finish', () => {
      try {
        fs.renameSync(tmp, t.abs);
        try { fs.chownSync(t.abs, APP_UID, APP_GID); } catch { /* not root */ }
        try { fs.chmodSync(t.abs, 0o664); } catch { /* ignore */ }
        resolve({ name: t.name, size: fs.statSync(t.abs).size, path: t.rel });
      } catch (e) { fail(e); }
    });
  });
}

function mimeOf(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

function disposition(name, inline) {
  const encoded = encodeURIComponent(name).replace(/'/g, '%27');
  const safe = name.replace(/["\\\r\n]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

function sendFile(res, shareName, rel, { inline = false, range = '' } = {}) {
  const t = ofShare(shareName, rel);
  const st = fs.lstatSync(t.abs);
  if (!st.isFile() || st.isSymbolicLink()) throw httpError('Choose a file to download.', 400);
  const headers = {
    'Content-Type': mimeOf(t.name),
    'Content-Disposition': disposition(t.name, inline),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range || ''));
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start = m[1] !== '' ? Number(m[1]) : null;
    let end = m[2] !== '' ? Number(m[2]) : st.size - 1;
    if (start == null) { start = Math.max(0, st.size - Number(m[2])); end = st.size - 1; }
    if (Number.isFinite(start) && Number.isFinite(end) && start < st.size && end >= start) {
      end = Math.min(end, st.size - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(t.abs, { start, end }).pipe(res);
      return;
    }
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  fs.createReadStream(t.abs).pipe(res);
}

function collectZip(abs, rel, out) {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return;
  if (out.length >= MAX_ZIP_ENTRIES) throw httpError('This folder has too many files to download at once.', 400);
  if (st.isDirectory()) {
    if (rel) out.push({ name: rel, dir: true, mtime: st.mtime });
    for (const name of fs.readdirSync(abs)) collectZip(path.join(abs, name), rel ? `${rel}/${name}` : name, out);
    return;
  }
  if (!st.isFile()) return;
  if (st.size > 0xffffffff) throw httpError('A file in this folder is larger than 4 GB. Download it on its own.', 400);
  out.push({ name: rel, dir: false, mtime: st.mtime, abs });
}

async function sendZip(res, shareName, rel) {
  const t = ofShare(shareName, rel);
  const st = fs.lstatSync(t.abs);
  if (st.isSymbolicLink() || !st.isDirectory()) return sendFile(res, shareName, rel);
  const entries = [];
  collectZip(t.abs, t.name, entries);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': disposition(`${t.name}.zip`, false),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  await zip.writeZip(res, entries.map((e) => ({
    name: e.name,
    dir: e.dir,
    mtime: e.mtime,
    open: e.dir ? null : () => fs.createReadStream(e.abs),
  })));
  res.end();
}

module.exports = {
  splitRel, fileName, inside, resolveRel, list, mkdir, rename, remove, act, upload, sendFile, sendZip, readText, mimeOf,
};
