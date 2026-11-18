'use strict';
/* Files for VMs: installation ISOs and disk files (qcow2, img, raw, vmdk, vhdx, vdi). Upload them from the browser or
   download them from a link into the ISO folder, unpack .xz, .gz and .zip, and browse the pools for a file to use. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { run, httpError } = require('./system');
const paths = require('./paths');

const ISO_DIR = () => paths.shown('isos');
const APP_UID = Number(process.env.APP_UID || 1000), APP_GID = Number(process.env.APP_GID || 1000);
const IMAGE = /\.(qcow2|img|raw|vmdk|vhdx|vdi)$/i;
const ISO = /\.iso$/i;
const PACKED = /\.(xz|gz|zip)$/i;
const TMP = '.majaos-upload'; // the same suffix as Files: hidden from lists while it is written
const KINDS_TEXT = '.iso, .qcow2, .img, .raw, .vmdk, .vhdx or .vdi, also packed as .xz, .gz or .zip';

/* ---- names */
// A file name from a user, a link or an archive: only the last part, no control characters or odd signs, no leading dot.
function cleanName(name) {
  const base = String(name || '').split(/[\\/]/).pop().normalize('NFC');
  return base.replace(/[^\w.+ ()-]+/g, '-').replace(/^[.\s-]+/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
// The file an archive unpacks to: "haos_ova-16.2.qcow2.xz" → "haos_ova-16.2.qcow2". Zip files: decided by what is inside.
function unpackedName(name) { return /\.zip$/i.test(name) ? null : name.replace(/\.(xz|gz)$/i, ''); }
// Is this a file we take: a disk file or ISO, possibly packed (a zip is checked when it is unpacked).
function acceptable(name) {
  if (/\.zip$/i.test(name)) return true;
  const inner = name.replace(/\.(xz|gz)$/i, '');
  return IMAGE.test(inner) || ISO.test(inner);
}
// The file name of a download: Content-Disposition first, otherwise the last part of the (final) address.
function fileNameFrom(url, disposition) {
  const cd = String(disposition || '');
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  const plain = cd.match(/filename\s*=\s*"([^"]+)"/) || cd.match(/filename\s*=\s*([^;]+)/);
  let raw = '';
  try { raw = star ? decodeURIComponent(star[1].trim()) : plain ? plain[1].trim() : ''; } catch { raw = plain ? plain[1].trim() : ''; }
  if (!raw) { try { raw = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { raw = ''; } }
  return cleanName(raw);
}

/* ---- tools' output */
// xz --robot --list <file>: the "file" line has the uncompressed size in its 5th column.
function parseXzList(text) {
  const line = String(text).split('\n').map((l) => l.split('\t')).find((f) => f[0] === 'totals') || String(text).split('\n').map((l) => l.split('\t')).find((f) => f[0] === 'file');
  const n = line ? Number(line[4]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
// unzip -l <file>: one line per member, "  <size>  <date> <time>   <name>"; folders end with /.
function parseUnzipList(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    const m = l.match(/^\s*(\d+)\s+\d{2,4}-\d{2}-\d{2,4}\s+\d{2}:\d{2}\s+(.+?)\s*$/);
    if (m && !m[2].endsWith('/')) out.push({ name: m[2], size: Number(m[1]) });
  }
  return out;
}
// The member of a zip to unpack: the largest disk file, or the largest ISO when there is no disk file.
function pickZipMember(members) {
  const by = (re) => members.filter((m) => re.test(m.name)).sort((a, b) => b.size - a.size)[0];
  return by(IMAGE) || by(ISO) || null;
}

/* ---- jobs (in memory): a download and/or unpacking, followed by the browser */
const jobs = new Map();
function newJob(kind, fields) {
  for (const [id, j] of jobs) if (j.finished && Date.now() - j.finished > 3600000) jobs.delete(id);
  const job = { id: crypto.randomBytes(6).toString('hex'), kind, state: 'running', phase: kind, name: '', bytes: 0, total: null, error: null,
    started: Date.now(), finished: null, ...fields };
  jobs.set(job.id, job);
  return job;
}
function jobOut(j) {
  const { abort, child, tmp, ...rest } = j;
  const percent = j.state === 'done' ? 100 : j.total ? Math.min(99, Math.floor((j.bytes / j.total) * 100)) : null;
  return { ...rest, running: j.state === 'running', percent };
}
function getJob(id) {
  const j = jobs.get(id);
  if (!j) throw httpError('This download or unpacking is no longer known. Open the form again.', 404);
  return jobOut(j);
}
function listJobs() { return { jobs: [...jobs.values()].filter((j) => j.state === 'running' || Date.now() - j.finished < 600000).map(jobOut) }; }
function finish(j, state, error) {
  if (j.state !== 'running') return;
  j.state = state; j.error = error || null; j.finished = Date.now(); j.abort = null; j.child = null;
  if (j.tmp) { try { fs.unlinkSync(j.tmp); } catch { /* gone */ } j.tmp = null; }
}
function stopJob(id) {
  const j = jobs.get(id);
  if (!j) throw httpError('This download or unpacking is no longer known. Open the form again.', 404);
  if (j.state !== 'running') return jobOut(j);
  if (j.abort) j.abort.abort();
  if (j.child) j.child.kill('SIGTERM');
  finish(j, 'stopped');
  return jobOut(j);
}

/* ---- where files go */
function isoDir() {
  const dir = ISO_DIR();
  if (!dir || !fs.existsSync(dir)) throw httpError('The folder for ISOs and disk files (' + (dir || '?') + ') does not exist. Create a pool in Storage first, or choose a folder in Settings → Storage.', 503);
  return dir;
}
function targetFree(dir, name) {
  if (fs.existsSync(path.join(dir, name))) throw httpError('There is already a file called ' + name + ' in ' + dir + '. Remove or rename it first.', 409);
}
// A new temporary file next to the target (wx: never through a symlink), owned by the app user like the rest of the folder.
function openTmp(dir) {
  const tmp = path.join(dir, '.vm-' + crypto.randomBytes(8).toString('hex') + TMP);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.fchownSync(fd, APP_UID, APP_GID); } catch { /* not root on a developer machine */ }
  fs.fchmodSync(fd, 0o664);
  return { tmp, fd };
}
// Unpacking needs xz or unzip (gz is built into Node). Checked before anything is uploaded or downloaded.
async function needTool(name) {
  const tool = /\.xz$/i.test(name) ? 'xz' : /\.zip$/i.test(name) ? 'unzip' : null;
  if (!tool) return;
  try { await run(tool, tool === 'xz' ? ['--version'] : ['-v'], { timeout: 5000 }); }
  catch { throw httpError('The server can\'t unpack ' + name + ': ' + tool + ' is not installed. Install it with: apt install ' + (tool === 'xz' ? 'xz-utils' : 'unzip'), 409); }
}

/* ---- unpacking */
function unpack(j, src) {
  return new Promise((resolve) => {
    const dir = path.dirname(src);
    // A failed or stopped unpacking also removes the archive: it is not shown anywhere and only takes space.
    const fail = (e) => { finish(j, 'failed', e.message || String(e)); try { fs.unlinkSync(src); } catch { /* gone */ } resolve(); };
    (async () => {
      let outName = unpackedName(path.basename(src)), member = null;
      if (/\.zip$/i.test(src)) {
        const list = parseUnzipList(await run('unzip', ['-l', src], { timeout: 30000 }));
        member = pickZipMember(list);
        if (!member) throw new Error('The zip file has no disk file or ISO in it (' + KINDS_TEXT + ').');
        outName = cleanName(member.name); j.total = member.size || null;
      } else if (/\.xz$/i.test(src)) {
        j.total = parseXzList(await run('xz', ['--robot', '--list', src], { timeout: 30000 }).catch(() => ''));
      } else j.total = null;
      if (!outName || !(IMAGE.test(outName) || ISO.test(outName))) throw new Error('This archive has no disk file or ISO in it (' + KINDS_TEXT + ').');
      targetFree(dir, outName);
      j.phase = 'unpack'; j.name = outName; j.bytes = 0;
      const { tmp, fd } = openTmp(dir); j.tmp = tmp;
      const gz = /\.gz$/i.test(src);
      // Progress: the size of what is written so far against the unpacked size (xz and zip tell it); gz: the bytes read.
      const timer = gz ? null : setInterval(() => { try { j.bytes = fs.fstatSync(fd).size; } catch { /* closed */ } }, 1000);
      const done = (err) => {
        if (timer) clearInterval(timer);
        try { fs.closeSync(fd); } catch { /* closed */ }
        if (j.state !== 'running') { try { fs.unlinkSync(src); } catch { /* gone */ } return resolve(); }
        if (err) return fail(err);
        try {
          fs.renameSync(tmp, path.join(dir, outName)); j.tmp = null;
          j.bytes = fs.statSync(path.join(dir, outName)).size; j.total = j.bytes; j.unpacked = true;
          try { fs.unlinkSync(src); } catch { /* gone */ }
          finish(j, 'done'); resolve();
        } catch (e) { fail(e); }
      };
      if (gz) {
        j.total = fs.statSync(src).size;
        const input = fs.createReadStream(src);
        input.on('data', (c) => { j.bytes += c.length; });
        const out = fs.createWriteStream(null, { fd, autoClose: false });
        j.child = { kill: () => input.destroy(new Error('Stopped.')) };
        input.pipe(zlib.createGunzip()).on('error', done).pipe(out).on('error', done).on('finish', () => done());
        input.on('error', done);
        return;
      }
      const [cmd, args] = /\.zip$/i.test(src) ? ['unzip', ['-p', src, member.name]] : ['xz', ['-dc', '--', src]];
      const child = spawn(cmd, args, { stdio: ['ignore', fd, 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
      j.child = child;
      let err = '';
      child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
      child.on('error', done);
      child.on('close', (code) => done(code === 0 ? null : new Error('Unpacking failed: ' + (err.trim().split('\n').pop() || cmd + ' stopped with code ' + code))));
    })().catch(fail);
  });
}
function startUnpack(file) {
  const j = newJob('unpack', { name: path.basename(file), phase: 'unpack' });
  unpack(j, file);
  return j;
}

/* ---- upload (PUT with the file as the body) */
async function upload(req, rawName) {
  const name = cleanName(rawName);
  if (!name || !acceptable(name)) throw httpError('Choose a disk file or ISO: ' + KINDS_TEXT + '.', 400);
  const dir = isoDir();
  targetFree(dir, name);
  if (unpackedName(name)) targetFree(dir, unpackedName(name));
  if (PACKED.test(name)) await needTool(name);
  const size = await require('./files').receive(req, path.join(dir, name));
  if (!PACKED.test(name)) return { name, size };
  return { name, size, job: jobOut(startUnpack(path.join(dir, name))) };
}

/* ---- download from a link */
const MAX_REDIRECTS = 10;
async function download(body) {
  let url;
  try { url = new URL(String(body.url || '').trim()); } catch { throw httpError('Paste a link that starts with https:// or http://.', 400); }
  if (!/^https?:$/.test(url.protocol)) throw httpError('Paste a link that starts with https:// or http://.', 400);
  const dir = isoDir();
  const guess = fileNameFrom(url.href);
  if (guess && acceptable(guess)) {
    targetFree(dir, guess);
    if (unpackedName(guess)) targetFree(dir, unpackedName(guess));
    if (PACKED.test(guess)) await needTool(guess);
  }
  const j = newJob('download', { url: url.href, name: guess || '' });
  j.abort = new AbortController();
  (async () => {
    const res = await fetch(url.href, { signal: j.abort.signal, redirect: 'follow', headers: { 'User-Agent': 'MajaOS' } });
    if (!res.ok || !res.body) throw new Error('The server of that link answered ' + (res.status + ' ' + (res.statusText || '')).trim() + '. Check the link.');
    const name = fileNameFrom(res.url || url.href, res.headers.get('content-disposition'));
    if (!name || !acceptable(name)) throw new Error('This link doesn\'t point to a disk file or ISO (' + KINDS_TEXT + ').');
    targetFree(dir, name);
    if (PACKED.test(name)) await needTool(name);
    j.name = name; j.total = Number(res.headers.get('content-length')) || null;
    const { tmp, fd } = openTmp(dir); j.tmp = tmp;
    const out = fs.createWriteStream(null, { fd });
    await new Promise((resolve, reject) => {
      const input = Readable.fromWeb(res.body);
      input.on('data', (c) => { j.bytes += c.length; });
      input.on('error', reject); out.on('error', reject); out.on('finish', resolve);
      input.pipe(out);
    });
    if (j.state !== 'running') return;
    const file = path.join(dir, name);
    fs.renameSync(tmp, file); j.tmp = null;
    if (PACKED.test(name)) { await unpack(j, file); return; }
    finish(j, 'done');
  })().catch((e) => {
    if (j.state !== 'running') return;
    const msg = e.name === 'AbortError' ? 'Stopped.' : e.cause && e.cause.code === 'ENOTFOUND' ? 'The address of that link can\'t be found. Check the link and the server\'s internet connection.'
      : e.cause && e.cause.code ? 'Downloading failed: ' + e.cause.code + '. Check the link and the server\'s internet connection.' : e.message;
    finish(j, 'failed', msg);
  });
  return jobOut(j);
}

/* ---- browse the pools for a file, and check a file someone chose */
async function roots() { return (await paths.pools()).map((p) => ({ name: p.name, path: p.mountpoint })).filter((r) => fs.existsSync(r.path)); }
const within = (root, abs) => abs === root || abs.startsWith(root.endsWith('/') ? root : root + '/');

// The folders and files (disk files and ISOs) in one folder of a pool. Without a path: the pools.
async function browse(p) {
  const list = await roots();
  if (!p) return { path: null, parent: null, roots: list, dirs: [], files: [] };
  let real;
  try { real = fs.realpathSync(path.resolve(String(p))); } catch { throw httpError('This folder doesn\'t exist (anymore).', 404); }
  const root = list.find((r) => within(r.path, real));
  if (!root) throw httpError('Choose a folder on one of your pools.', 400);
  const dirs = [], files = [];
  let entries;
  try { entries = fs.readdirSync(real, { withFileTypes: true }); } catch (e) { throw httpError('This folder can\'t be read: ' + e.code, 403); }
  for (const d of entries) {
    if (d.name.startsWith('.')) continue; // hidden, .zfs, uploads that are still running
    if (d.isDirectory()) dirs.push(d.name);
    else if (d.isFile() && (IMAGE.test(d.name) || ISO.test(d.name))) {
      let size = 0; try { size = fs.statSync(path.join(real, d.name)).size; } catch { /* gone */ }
      files.push({ name: d.name, size, path: path.join(real, d.name), kind: ISO.test(d.name) ? 'iso' : 'disk' });
    }
  }
  dirs.sort((a, b) => a.localeCompare(b)); files.sort((a, b) => a.name.localeCompare(b.name));
  return { path: real, parent: real === root.path ? null : path.dirname(real), root: root.path, roots: list, dirs, files };
}

// A file chosen anywhere on the server: an existing, plain file (no symlink) of the right kind, on a pool.
async function checkSource(abs, kind) {
  const p = String(abs || '');
  if (!path.isAbsolute(p) || path.resolve(p) !== p) throw httpError('Choose a file on one of your pools.', 400);
  let st, real;
  try { st = fs.lstatSync(p); real = fs.realpathSync(p); } catch { throw httpError('The file ' + p + ' doesn\'t exist (anymore).', 404); }
  if (!st.isFile() || real !== p) throw httpError('Choose a plain file, not a folder or a link: ' + p, 400);
  if (!(kind === 'iso' ? ISO : IMAGE).test(p)) throw httpError(kind === 'iso' ? 'Choose an ISO file (.iso).' : 'Choose a disk file (.qcow2, .img, .raw, .vmdk, .vhdx or .vdi).', 400);
  if (!(await roots()).some((r) => within(r.path, p))) throw httpError('Choose a file on one of your pools.', 400);
  return p;
}

module.exports = { upload, download, getJob, listJobs, stopJob, browse, checkSource,
  cleanName, unpackedName, acceptable, fileNameFrom, parseXzList, parseUnzipList, pickZipMember, IMAGE, ISO };
