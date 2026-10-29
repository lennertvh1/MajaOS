'use strict';
/*
 * Pools with mixed disks: every data disk keeps its own file system (ext4) and stays readable on its own, mergerfs shows
 * them together as one folder at /<name>, and SnapRAID keeps parity on one or two disks that are at least as large as
 * the largest data disk. Disks of any size mix, and a disk can be added later. Parity is brought up to date on a
 * schedule (sync) and checked bit by bit (scrub), not at every write: what changed since the last sync isn't protected yet.
 * A failed disk is replaced with startReplace: a new disk gets the same place, and its files come back from the parity
 * (snapraid fix), or, when the old disk still works, are copied from it (rsync). Then a sync.
 *
 * DATA_DIR/mixed.json: {pools: [{name, mountpoint, created, disks: [{key, byId, uuid, role: data|parity, index, mount,
 * model, size}], schedule: {sync, scrub}, last: {sync, scrub}}]}. /etc/fstab gets one block per pool between markers,
 * /etc/snapraid/<name>.conf the SnapRAID configuration.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run, runStream, httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'mixed.json');
const CONTENT_DIR = path.join(DATA_DIR, 'snapraid');
const CONF_DIR = process.env.SNAPRAID_DIR || '/etc/snapraid';
const FSTAB = process.env.FSTAB_FILE || '/etc/fstab';
const DISK_ROOT = process.env.MIXED_DISK_ROOT || '/mnt';
// Lowercase: the name is also part of mount paths and ext4 labels.
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_PARITY = 2;
const APP_UID = Number(process.env.APP_UID || 1000), APP_GID = Number(process.env.APP_GID || 1000);
const DEFAULT_SCHEDULE = { sync: { every: 'daily', time: '03:00', day: 0 }, scrub: { every: 'weekly', time: '04:30', day: 0 } };

/* ---- state */

function load() {
  try { const s = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { pools: Array.isArray(s.pools) ? s.pools : [] }; } catch { return { pools: [] }; }
}
function store(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}
const list = () => load().pools;
const find = (name) => list().find((p) => p.name === name) || null;
const isMixed = (name) => !!find(name);

/* ---- planning (pure, tested) */

// Usable space: the data disks together (ext4 keeps ~2% for itself). Parity only protects, it holds no files.
function capacity(dataSizes, paritySizes) {
  const raw = [...dataSizes, ...paritySizes].reduce((a, b) => a + b, 0);
  const data = dataSizes.reduce((a, b) => a + b, 0);
  const parity = paritySizes.reduce((a, b) => a + b, 0);
  return { raw, usable: Math.round(data * 0.98), redundancy: parity, unused: 0, failures: paritySizes.length };
}

// body: {name, disks: [{name, role: data|parity}], confirm}. ctx: {disks (poolOptions), names (pools that exist)}.
function plan(body, { disks, names = [] }) {
  const name = String(body.name || '').trim();
  if (!NAME.test(name)) throw httpError('Choose a name of lowercase letters, digits, - or _ that starts with a letter (e.g. media).', 400);
  if (names.includes(name)) throw httpError(`A pool named ${name} already exists.`, 409);
  const seen = new Set();
  const chosen = (Array.isArray(body.disks) ? body.disks : []).map((x) => {
    const n = String((x && x.name) || ''), role = x && x.role === 'parity' ? 'parity' : 'data';
    if (seen.has(n)) throw httpError(`The disk ${n} is chosen twice.`, 400);
    seen.add(n);
    const d = disks.find((y) => y.name === n);
    if (!d) throw httpError(`The disk ${n} no longer exists. Open the window again.`, 400);
    if (!d.available) throw httpError(`You cannot use ${n}: ${d.reason}.`, 409);
    return { ...d, role };
  });
  const data = chosen.filter((d) => d.role === 'data'), parity = chosen.filter((d) => d.role === 'parity');
  if (!data.length) throw httpError('Choose at least one data disk.', 400);
  if (parity.length > MAX_PARITY) throw httpError('Choose at most two parity disks.', 400);
  const largest = Math.max(...data.map((d) => d.size));
  const small = parity.find((d) => d.size < largest);
  if (small) throw httpError(`The parity disk ${small.name} is smaller than the largest data disk. A parity disk must be at least as large as every data disk.`, 400);
  if (String(body.confirm || '') !== name) throw httpError('Type the pool name to confirm that the disks may be erased.', 400);
  const at = (role, i) => path.join(DISK_ROOT, name, `${role === 'data' ? 'disk' : 'parity'}${i + 1}`);
  return {
    name, mountpoint: '/' + name,
    disks: [...data.map((d, i) => ({ ...d, index: i + 1, mount: at('data', i) })), ...parity.map((d, i) => ({ ...d, index: i + 1, mount: at('parity', i) }))],
  };
}

// One block per pool in /etc/fstab, between markers: the disks by UUID (nofail: a missing disk doesn't stop the boot),
// then mergerfs over all data disks. New files go to the disk with the most free space (mfs).
const MARK = (name) => [`# MajaOS pool ${name} (mixed disks) start`, `# MajaOS pool ${name} (mixed disks) end`];
function fstabBlock(pool) {
  const [start, end] = MARK(pool.name);
  const data = pool.disks.filter((d) => d.role === 'data');
  const lines = pool.disks.map((d) => `UUID=${d.uuid} ${d.mount} ext4 defaults,noatime,nofail 0 2`);
  const needs = data.map((d) => `x-systemd.requires-mounts-for=${d.mount}`).join(',');
  lines.push(`${path.join(DISK_ROOT, pool.name, 'disk*')} ${pool.mountpoint} fuse.mergerfs defaults,nofail,allow_other,use_ino,cache.files=off,dropcacheonclose=true,category.create=mfs,moveonenospc=true,minfreespace=${minFree(data)},fsname=${pool.name},${needs} 0 0`);
  return [start, ...lines, end].join('\n');
}
// mergerfs puts no new file on a disk with less free space than this: 2% of the smallest data disk, at least 256 MB
// and at most 20 GB (a fixed 20 GB refused every new file on small disks).
function minFree(data) {
  const smallest = Math.min(...data.map((d) => Number(d.size) || Infinity));
  const mb = Number.isFinite(smallest) ? Math.round(Math.min(20 * 1024, Math.max(256, (smallest * 0.02) / 1048576))) : 4096;
  return mb >= 1024 && mb % 1024 === 0 ? mb / 1024 + 'G' : mb + 'M';
}
// Replaces (or adds, or with block = null removes) the pool's block; the rest of fstab stays as it is.
function replaceBlock(text, name, block) {
  const [start, end] = MARK(name);
  const lines = String(text || '').split('\n');
  const a = lines.indexOf(start), b = lines.indexOf(end);
  let rest = lines;
  if (a >= 0 && b > a) rest = [...lines.slice(0, a), ...lines.slice(b + 1)];
  let out = rest.join('\n').replace(/\n+$/, '');
  if (block) out += (out ? '\n\n' : '') + block;
  return out + '\n';
}

function confPath(name) { return path.join(CONF_DIR, name + '.conf'); }
// SnapRAID: parity files on the parity disks, a content file (the list of files with their checksums) on every data
// disk and one in DATA_DIR, then the data disks. Its own files and the trash folders are left out.
function snapraidConf(pool) {
  const parity = pool.disks.filter((d) => d.role === 'parity'), data = pool.disks.filter((d) => d.role === 'data');
  const names = ['parity', '2-parity'];
  return [
    `# Written by MajaOS for the pool ${pool.name}. Change the pool in Storage, not here.`,
    ...parity.map((d, i) => `${names[i]} ${path.join(d.mount, 'snapraid.parity')}`),
    `content ${path.join(CONTENT_DIR, pool.name + '.content')}`,
    ...data.map((d) => `content ${path.join(d.mount, '.snapraid.content')}`),
    ...data.map((d) => `data d${d.index} ${d.mount}/`),
    'exclude *.unrecoverable', 'exclude /lost+found/', 'exclude /.snapraid.content', 'exclude /.snapraid.content.tmp',
    'exclude .Trash-*/', 'exclude .recycle/', 'exclude /tmp/',
    'autosave 500', '',
  ].join('\n');
}

// SnapRAID's progress line: "34%, 1205 MB, 98 MB/s, 120 stripe/s, CPU 12%, 0:01 ETA".
function parseProgress(text) {
  const hits = String(text || '').match(/(\d{1,3})%,/g);
  return hits ? Math.min(100, Number(hits[hits.length - 1].slice(0, -2))) : null;
}

/* ---- disks */

async function partitionOf(dev) {
  // by-id has a -part1 link as soon as udev has seen the new partition.
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(dev + '-part1')) return dev + '-part1';
    if (/^\/dev\/(sd|vd|hd)[a-z]+$/.test(dev) && fs.existsSync(dev + '1')) return dev + '1';
    if (/^\/dev\/nvme/.test(dev) && fs.existsSync(dev + 'p1')) return dev + 'p1';
    await new Promise((r) => setTimeout(r, 250));
  }
  throw httpError(`The new partition on ${dev} did not appear.`, 502);
}

async function prepareDisk(d, pool) {
  const dev = d.byId || '/dev/' + d.name;
  const label = `${pool.name.slice(0, 10)}-${d.role === 'data' ? 'd' : 'p'}${d.index}`;
  await run('wipefs', ['-a', dev], { timeout: 30000 });
  await run('parted', ['-s', dev, 'mklabel', 'gpt', 'mkpart', label, 'ext4', '1MiB', '100%'], { timeout: 30000 });
  await run('partprobe', [dev], { timeout: 30000 }).catch(() => {});
  await run('udevadm', ['settle'], { timeout: 30000 }).catch(() => {});
  const part = await partitionOf(dev);
  // No reserved blocks (-m 0): nobody logs in on these disks. Parity holds a few huge files (largefile4).
  await run('mkfs.ext4', ['-F', '-q', '-m', '0', '-L', label, ...(d.role === 'parity' ? ['-T', 'largefile4'] : []), part], { timeout: 600000 });
  const uuid = (await run('blkid', ['-s', 'UUID', '-o', 'value', part], { timeout: 10000 })).trim();
  if (!uuid) throw httpError(`The new file system on ${dev} has no UUID.`, 502);
  return { key: d.serial ? 's:' + d.serial : 'n:' + d.name, byId: dev, uuid, role: d.role, index: d.index, mount: d.mount, model: d.model || null, size: d.size };
}

function mounted() {
  try { return new Set(fs.readFileSync('/proc/mounts', 'utf8').split('\n').map((l) => (l.split(' ')[1] || '').replace(/\\040/g, ' ')).filter(Boolean)); } catch { return new Set(); }
}
function space(dir) {
  try { const s = fs.statfsSync(dir); return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch { return { total: null, free: null }; }
}

async function writeFstab(name, block) {
  const text = fs.existsSync(FSTAB) ? fs.readFileSync(FSTAB, 'utf8') : '';
  fs.writeFileSync(FSTAB + '.majaos-tmp', replaceBlock(text, name, block));
  fs.renameSync(FSTAB + '.majaos-tmp', FSTAB);
  await run('systemctl', ['daemon-reload'], { timeout: 30000 }).catch(() => {});
}

/* ---- creating and removing */

// step(id, state): progress for the browser ("disk:<name>", "create", "folders"; running, done).
async function create(body, { disks, names, step = () => {} }) {
  const p = plan(body, { disks, names });
  if (fs.existsSync(p.mountpoint) && fs.readdirSync(p.mountpoint).length) throw httpError(`The folder ${p.mountpoint} already exists and isn't empty. Choose another name.`, 409);
  const pool = { name: p.name, mountpoint: p.mountpoint, created: new Date().toISOString(), disks: [], schedule: DEFAULT_SCHEDULE, last: {} };
  for (const d of p.disks) {
    step('disk:' + d.name, 'running');
    try { pool.disks.push(await prepareDisk(d, p)); }
    catch (e) { throw httpError(`Preparing the disk ${d.name} failed: ${e.message}`, e.status || 502); }
    step('disk:' + d.name, 'done');
  }
  step('create', 'running');
  for (const d of pool.disks) fs.mkdirSync(d.mount, { recursive: true });
  fs.mkdirSync(pool.mountpoint, { recursive: true });
  await writeFstab(pool.name, fstabBlock(pool));
  for (const d of pool.disks) await run('mount', [d.mount], { timeout: 60000 });
  await run('mount', [pool.mountpoint], { timeout: 60000 });
  fs.mkdirSync(CONF_DIR, { recursive: true });
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  fs.writeFileSync(confPath(pool.name), snapraidConf(pool));
  const state = load();
  state.pools = state.pools.filter((x) => x.name !== pool.name).concat(pool);
  store(state);
  step('create', 'done');
  // The default folders, owned by the app user (here plain folders: there are no datasets).
  const paths = require('./paths');
  let folders = [], warning = null;
  if (body.folders !== false) {
    step('folders', 'running');
    try {
      for (const f of paths.DEFAULT_FOLDERS) {
        const dir = path.join(pool.mountpoint, f);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir); folders.push(f); }
        if (['appdata', 'media', 'backups'].includes(f)) { try { fs.chownSync(dir, APP_UID, APP_GID); } catch { /* not root */ } }
      }
    } catch (e) { warning = e.message; }
    step('folders', 'done');
  }
  // An empty pool: the first sync takes seconds and gives SnapRAID its content files.
  startJob(pool.name, 'sync').catch(() => {});
  return { name: pool.name, kind: 'mixed', folders, uses: paths.adoptPool(pool.mountpoint), warning };
}

// The pool goes away, the files stay: every disk keeps its own file system and can be mounted again by hand.
async function remove(name, { inUse = [] } = {}) {
  const pool = find(name);
  if (!pool) throw httpError('This pool doesn\'t exist (anymore).', 404);
  if (inUse.length) throw httpError(`${pool.mountpoint} is still used by ${inUse.join(', ')}. Move or remove that first.`, 409);
  if (job && job.pool === name && !job.done) throw httpError('The parity is being updated. Stop that first.', 409);
  for (const target of [pool.mountpoint, ...pool.disks.map((d) => d.mount)]) {
    await run('umount', [target], { timeout: 60000 }).catch((e) => { if (mounted().has(target)) throw httpError(`${target} can't be unmounted: ${e.message}`, 409); });
  }
  await writeFstab(name, null);
  fs.rmSync(confPath(name), { force: true });
  const state = load();
  state.pools = state.pools.filter((x) => x.name !== name);
  store(state);
  return { removed: name };
}

/* ---- parity: sync and scrub, one at a time */

let job = null; // {pool, action, started, lines, percent, done, ok, error, child; replace: disk, mode, phase}

const keep = (mine, l) => { mine.lines.push(l); if (mine.lines.length > 300) mine.lines.shift(); };

// Runs SnapRAID for a job: its progress in job.percent, the other lines in job.lines. Resolves with an error or null.
function snapraid(mine, name, args) {
  return new Promise((resolve) => {
    const child = spawn('snapraid', ['-c', confPath(name), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
    mine.child = child;
    let partial = '', over = false;
    const take = (buf) => {
      partial += buf.toString();
      const parts = partial.split(/[\r\n]/);
      partial = parts.pop();
      for (const l of parts) {
        if (!l.trim()) continue;
        const pct = parseProgress(l);
        if (pct != null) mine.percent = pct; else keep(mine, l);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const done = (error) => { if (over) return; over = true; delete mine.child; resolve(error); };
    child.on('error', (e) => done(e.code === 'ENOENT' ? 'SnapRAID is not installed. Run install.sh again.' : e.message));
    child.on('exit', (code, signal) => done(signal ? 'Stopped.' : code === 0 ? null : (mine.lines.filter((l) => /error|fail|abort|missing|not found/i.test(l)).slice(-1)[0] || `SnapRAID stopped with code ${code}.`)));
  });
}

// The job is over: remember it with the pool (last.sync, last.scrub, last.replace).
function finish(mine, name, record) {
  Object.assign(mine, { done: true, percent: mine.ok ? 100 : mine.percent, finished: new Date().toISOString() });
  delete mine.child;
  const state = load(), p = state.pools.find((x) => x.name === name);
  if (p) {
    p.last = { ...(p.last || {}) };
    for (const [action, extra] of Object.entries(record)) p.last[action] = { at: mine.finished, ok: mine.ok, error: mine.error, ...extra };
    store(state);
  }
  return mine;
}

const busyError = (name) => httpError(job.pool === name ? 'The parity of this pool is already being updated or checked.' : 'Another pool is busy with its parity. Wait until it is done.', 409);

function startJob(name, action) {
  const pool = find(name);
  if (!pool) return Promise.reject(httpError('This pool doesn\'t exist (anymore).', 404));
  if (!pool.disks.some((d) => d.role === 'parity')) return Promise.reject(httpError('This pool has no parity disk.', 409));
  if (job && !job.done) return Promise.reject(busyError(name));
  const args = action === 'scrub' ? ['scrub', '-p', '8', '-o', '10'] : ['sync'];
  job = { pool: name, action, started: new Date().toISOString(), lines: [], percent: 0, done: false, ok: null, error: null };
  const mine = job;
  return snapraid(mine, name, args).then((error) => { Object.assign(mine, { ok: !error, error }); return finish(mine, name, { [action]: {} }); });
}

/* ---- replacing a disk */

// A member of the pool: "d1", "d2"… for data disks, "p1", "p2" for parity disks. SnapRAID calls them d1… and parity/2-parity.
const memberId = (d) => (d.role === 'parity' ? 'p' : 'd') + d.index;
const snapName = (d) => (d.role === 'parity' ? ['parity', '2-parity'][d.index - 1] : 'd' + d.index);
const gb = (n) => Math.round((Number(n) || 0) / 1e9) + ' GB';

// May this disk take the place of that member? pool: from mixed.json; disk: from poolOptions (name, size, available, reason).
function checkReplacement(pool, member, disk) {
  if (!disk) throw httpError('Choose the new disk.', 400);
  if (!disk.available) throw httpError(`You cannot use ${disk.name}: ${disk.reason}.`, 409);
  const others = pool.disks.filter((d) => memberId(d) !== memberId(member));
  if (member.role === 'parity') {
    const largest = Math.max(0, ...others.filter((d) => d.role === 'data').map((d) => Number(d.size) || 0));
    if (disk.size < largest) throw httpError(`The disk ${disk.name} is smaller than the largest data disk. A parity disk must be at least as large as every data disk.`, 400);
  } else {
    if (disk.size < (Number(member.size) || 0) * 0.99) throw httpError(`The disk ${disk.name} is smaller than the disk it replaces (${gb(member.size)}).`, 400);
    const parity = others.filter((d) => d.role === 'parity').map((d) => Number(d.size) || 0);
    if (parity.length && disk.size > Math.min(...parity)) throw httpError(`The disk ${disk.name} is larger than the parity disk. Choose one of at most ${gb(Math.min(...parity))}, or replace the parity disk first.`, 400);
  }
}

// copy: the old disk still works, so its files are copied (nothing is lost); fix: they come back from the parity.
function replaceMode(pool, member) {
  const st = (status().find((p) => p.name === pool.name) || { disks: [] }).disks.find((d) => memberId(d) === memberId(member));
  return st && st.present && st.mounted ? 'copy' : 'fix';
}

// For the window: the member and the free disks, each with whether it fits.
function replaceOptions(name, id, { disks = [] } = {}) {
  const pool = find(name);
  if (!pool) throw httpError('This pool doesn\'t exist (anymore).', 404);
  const member = pool.disks.find((d) => memberId(d) === id);
  if (!member) throw httpError('This disk isn\'t part of the pool (anymore).', 404);
  const candidates = disks.filter((d) => d.available).map((d) => {
    let reason = null;
    try { checkReplacement(pool, member, d); } catch (e) { reason = e.message; }
    return { name: d.name, model: d.model || null, serial: d.serial || null, size: d.size, rotational: !!d.rotational, transport: d.transport || null, ok: !reason, reason };
  });
  const parity = pool.disks.some((d) => d.role === 'parity');
  return { disk: { id, role: member.role, index: member.index, model: member.model, size: member.size }, mode: replaceMode(pool, member), parity, candidates };
}

// body: {disk: "d1", with: "sdf", confirm: pool name}. Without "with": restore that member again from the parity (it is
// in place but its restore failed). Checked right away, then a job (one at a time, like sync and scrub).
function startReplace(name, body, { disks = [] } = {}) {
  const pool = find(name);
  if (!pool) throw httpError('This pool doesn\'t exist (anymore).', 404);
  const id = String((body && body.disk) || '');
  const member = pool.disks.find((d) => memberId(d) === id);
  if (!member) throw httpError('Choose the disk to replace.', 400);
  if (job && !job.done) throw busyError(name);
  const parity = pool.disks.some((d) => d.role === 'parity');
  let neu = null, mode = replaceMode(pool, member);
  if (body.with) {
    neu = disks.find((d) => d.name === String(body.with)) || null;
    checkReplacement(pool, member, neu);
    if (String(body.confirm || '') !== name) throw httpError('Type the pool name to confirm that the new disk may be erased.', 400);
  } else {
    if (mode !== 'copy') throw httpError('Choose the new disk.', 400);
    mode = 'fix'; // the new disk is already in place: only the restore again
  }
  if (mode === 'fix' && !parity) throw httpError('This pool has no parity disk, so the files of a missing disk can\'t be restored.', 409);
  job = { pool: name, action: 'replace', disk: id, mode, phase: neu ? 'prepare' : 'fix', with: neu ? neu.name : null, started: new Date().toISOString(), lines: [], percent: 0, done: false, ok: null, error: null };
  const mine = job;
  runReplace(mine, name, id, neu, mode).then(() => { mine.ok = true; }, (e) => { mine.ok = false; mine.error = e.message; })
    .then(() => finish(mine, name, { replace: { disk: id }, ...(mine.synced ? { sync: {} } : {}) }));
  return jobView(name);
}

async function runReplace(mine, name, id, neu, mode) {
  const stopped = () => { if (mine.stopped) throw httpError('Stopped.', 409); };
  const member = find(name).disks.find((d) => memberId(d) === id);
  if (neu) {
    keep(mine, `Preparing ${neu.name}…`);
    let fresh;
    try { fresh = await prepareDisk({ ...neu, role: member.role, index: member.index, mount: member.mount }, { name }); }
    catch (e) { throw httpError(`Preparing the disk ${neu.name} failed: ${e.message}`, e.status || 502); }
    stopped();
    if (mode === 'copy') {
      mine.phase = 'copy'; mine.percent = 0;
      const tmp = path.join(DISK_ROOT, name, '.replace');
      fs.mkdirSync(tmp, { recursive: true });
      await run('mount', ['-t', 'ext4', '/dev/disk/by-uuid/' + fresh.uuid, tmp], { timeout: 60000 });
      keep(mine, `Copying ${member.mount} to ${neu.name}…`);
      try {
        await runStream('rsync', ['-aHAX', '--numeric-ids', '--info=progress2', '--no-inc-recursive', member.mount + '/', tmp + '/'], (line) => {
          const m = line.match(/\s(\d{1,3})%\s/);
          if (m) mine.percent = Math.min(99, Number(m[1])); else keep(mine, line.trim());
        }, { timeout: 0, onSpawn: (c) => { mine.child = c; } });
      } catch (e) {
        throw httpError(mine.stopped ? 'Stopped.' : 'Copying from the old disk failed. Take the old disk out and replace it again: its files then come back from the parity.', 502);
      } finally {
        delete mine.child;
        await run('umount', [tmp], { timeout: 60000 }).catch(() => {});
      }
      stopped();
    }
    // The new disk takes the member's place: same mount point, its own UUID in fstab. The old one is let go (lazily: it
    // may be gone or hang).
    mine.phase = 'swap';
    await run('umount', ['-l', member.mount], { timeout: 60000 }).catch(() => {});
    const state = load(), p = state.pools.find((x) => x.name === name);
    p.disks = p.disks.map((d) => (memberId(d) === id ? fresh : d));
    store(state);
    await writeFstab(name, fstabBlock(p));
    fs.mkdirSync(fresh.mount, { recursive: true });
    await run('mount', [fresh.mount], { timeout: 60000 });
    // A data disk missing at boot keeps mergerfs from mounting (it requires every data disk).
    if (!mounted().has(p.mountpoint)) await run('mount', [p.mountpoint], { timeout: 60000 }).catch((e) => keep(mine, e.message));
    try {
      const bays = require('./bays');
      const slot = Object.entries(bays.getBays().slots || {}).find(([, v]) => v && v.key === member.key);
      if (slot) bays.replaced(slot[0], neu);
    } catch (e) { keep(mine, 'Disk bays: ' + e.message); }
    keep(mine, `${neu.name} took the place of ${member.model || member.byId}.`);
  }
  if (mode === 'fix') {
    mine.phase = 'fix'; mine.percent = 0;
    const error = await snapraid(mine, name, ['-d', snapName(member), 'fix']);
    if (error) {
      if (mine.stopped || error === 'Stopped.') throw httpError('Stopped.', 409);
      if (mine.lines.some((l) => /unrecoverable/i.test(l))) throw httpError('Not every file could be restored: some changed after the last parity update. Those end in .unrecoverable. Update the parity now to protect the rest again.', 502);
      throw httpError(`Restoring from the parity failed: ${error}`, 502);
    }
    stopped();
  }
  if (find(name).disks.some((d) => d.role === 'parity')) {
    mine.phase = 'sync'; mine.percent = 0;
    const error = await snapraid(mine, name, ['sync']);
    if (error) throw httpError(error === 'Stopped.' ? 'Stopped.' : `The disk is in place, but updating the parity failed: ${error}`, 502);
    mine.synced = true;
  }
  mine.phase = 'done';
}

function stopJob(name) {
  if (!job || job.done || job.pool !== name || (!job.child && job.action !== 'replace')) throw httpError('Nothing is running for this pool.', 409);
  job.stopped = true; // a replacement stops before its next step
  if (job.child) job.child.kill('SIGINT'); // SnapRAID saves what it did so far and stops cleanly
  return { stopping: true };
}
const jobView = (name) => (job && job.pool === name ? {
  action: job.action, started: job.started, percent: job.percent, done: job.done, ok: job.ok, error: job.error, lines: job.lines.slice(-200),
  ...(job.action === 'replace' ? { disk: job.disk, mode: job.mode, phase: job.phase, with: job.with } : {}),
} : null);

function setSchedule(name, body) {
  const { validateSchedule } = require('./backup');
  const state = load(), pool = state.pools.find((x) => x.name === name);
  if (!pool) throw httpError('This pool doesn\'t exist (anymore).', 404);
  pool.schedule = { sync: validateSchedule(body.sync || pool.schedule.sync), scrub: validateSchedule(body.scrub || pool.schedule.scrub) };
  store(state);
  return pool.schedule;
}

// Every minute: is a sync or scrub due? A missed time (server off) runs once when it is back.
function tick(now = Date.now()) {
  const { nextRun } = require('./backup');
  if (job && !job.done) return;
  for (const pool of list()) {
    if (!pool.disks.some((d) => d.role === 'parity')) continue;
    for (const action of ['sync', 'scrub']) {
      const s = pool.schedule && pool.schedule[action];
      if (!s || s.every === 'manual') continue;
      const last = pool.last && pool.last[action] ? Date.parse(pool.last[action].at) : Date.parse(pool.created);
      const due = nextRun(s, last);
      if (due && due <= now) { startJob(pool.name, action).catch(() => {}); return; }
    }
  }
}
let timer = null;
function startSchedule() { if (!timer) timer = setInterval(() => tick(), 60000); }

/* ---- status */

// For Storage: per pool the space, health and parity; per disk its pool and role (by the by-id link it points to).
function status() {
  const m = mounted();
  return list().map((pool) => {
    const disks = pool.disks.map((d) => {
      let dev = null;
      try { dev = path.basename(fs.realpathSync(d.byId)); } catch { /* the disk is gone */ }
      return { ...d, present: !!dev, device: dev, mounted: m.has(d.mount), ...space(d.mount) };
    });
    const missing = disks.filter((d) => !d.present || !d.mounted);
    const top = m.has(pool.mountpoint) ? space(pool.mountpoint) : { total: null, free: null };
    const health = !m.has(pool.mountpoint) ? 'UNAVAIL' : missing.length ? 'DEGRADED' : 'ONLINE';
    const { nextRun } = require('./backup');
    const next = (a) => { const s = pool.schedule && pool.schedule[a]; if (!s || s.every === 'manual') return null; const last = pool.last && pool.last[a] ? Date.parse(pool.last[a].at) : Date.parse(pool.created); return new Date(Math.max(Date.now(), nextRun(s, last))).toISOString(); };
    return {
      name: pool.name, kind: 'mixed', mountpoint: pool.mountpoint, health,
      total: top.total, free: top.free, used: top.total != null ? top.total - top.free : null,
      layout: 'mixed', diskCount: disks.filter((d) => d.role === 'data').length, parityCount: disks.filter((d) => d.role === 'parity').length,
      disks, schedule: pool.schedule, last: pool.last || {}, next: { sync: next('sync'), scrub: next('scrub') }, job: jobView(pool.name),
    };
  });
}

// The disks of mixed pools, by device name (sda…): for the disk list and to keep them out of new pools.
function diskRoles() {
  const out = new Map();
  for (const pool of list()) {
    for (const d of pool.disks) {
      try { out.set(path.basename(fs.realpathSync(d.byId)), { pool: pool.name, role: d.role }); } catch { /* gone */ }
    }
  }
  return out;
}

module.exports = {
  list, find, isMixed, capacity, plan, fstabBlock, minFree, replaceBlock, snapraidConf, parseProgress, create, remove,
  startJob, stopJob, setSchedule, tick, startSchedule, status, diskRoles, jobView, MAX_PARITY, DEFAULT_SCHEDULE,
  memberId, snapName, checkReplacement, replaceOptions, startReplace,
};
