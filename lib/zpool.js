'use strict';
/*
 * Creating a ZFS pool: which disks are free, how much storage a layout gives, and `zpool create`.
 * Disks always go through /dev/disk/by-id, so the pool finds them again when sda/sdb swap names.
 */
const fs = require('node:fs');
const path = require('node:path');
const { run, num, readText, httpError } = require('./system');
const { parseZpoolStatus, partToDisk } = require('./storage');
const paths = require('./paths');
const bays = require('./bays');
const mixed = require('./mixed');

// Layouts: minimum number of disks, how many may fail, and what is usable (in "disks").
const LAYOUTS = {
  stripe: { min: 1, data: (n) => n, fail: () => 0 },
  mirror: { min: 2, data: () => 1, fail: (n) => n - 1 },
  raidz1: { min: 3, data: (n) => n - 1, fail: () => 1 },
  raidz2: { min: 4, data: (n) => n - 2, fail: () => 2 },
  raidz3: { min: 5, data: (n) => n - 3, fail: () => 3 },
  mirrors: { min: 4, even: true, data: (n) => n / 2, fail: () => 1 }, // mirror pairs (RAID 10): 1 per pair, guaranteed
};
const COMPRESSION = ['lz4', 'zstd', 'off'];
const NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const RESERVED = /^(mirror|raidz\d?|draid\d?|spare|log|cache|special|dedup|c\d+)/i;

// Storage of a layout. ZFS only uses as much of each disk as the smallest; it keeps ~3% back (slop).
function capacity(layout, sizes) {
  const L = LAYOUTS[layout], n = sizes.length;
  if (!L || n < L.min || (L.even && n % 2)) return null;
  const raw = sizes.reduce((a, b) => a + b, 0);
  let usable, perDisk;
  if (layout === 'stripe') { usable = raw; perDisk = null; }
  else if (layout === 'mirrors') {
    // Pairs in order of size: each pair counts the smallest of the two.
    const s = [...sizes].sort((a, b) => b - a);
    usable = 0; for (let i = 0; i < n; i += 2) usable += Math.min(s[i], s[i + 1]);
    perDisk = null;
  } else { perDisk = Math.min(...sizes); usable = L.data(n) * perDisk; }
  const unused = perDisk == null ? (layout === 'mirrors' ? raw / 2 - usable : 0) : sizes.reduce((a, b) => a + (b - perDisk), 0);
  const slop = Math.min(Math.max(usable / 32, 128 * 1048576), 128 * 1073741824);
  return { raw, usable: Math.max(0, usable - slop), redundancy: Math.max(0, raw - usable - unused), unused, failures: L.fail(n) };
}

// lsblk -J -b with partitions: which disks are free and why not.
function classifyDisks(lsblk, { poolDisks = new Map(), swaps = new Set(), byId = {} } = {}) {
  const out = [];
  for (const b of lsblk.blockdevices || []) {
    if (b.type !== 'disk' || /^(zram|loop|sr|ram|md)/.test(b.name)) continue;
    const parts = b.children || [];
    const mounts = [b, ...parts].flatMap((x) => (x.mountpoints || [x.mountpoint]).filter(Boolean));
    const fs = [...new Set(parts.map((p) => p.fstype).concat(b.fstype).filter(Boolean))];
    let reason = null, warn = null;
    if (poolDisks.has(b.name)) reason = 'In pool ' + poolDisks.get(b.name);
    else if (mounts.some((m) => m === '/' || m === '/boot' || m === '/boot/efi' || m === '[SWAP]')) reason = 'System disk (Debian is on it)';
    else if (mounts.length) reason = 'In use: ' + (mounts.join(', '));
    else if ([b, ...parts].some((x) => swaps.has(x.name))) reason = 'In use as swap';
    else if (fs.includes('zfs_member')) warn = 'Belonged to an old ZFS pool. That data will be erased.';
    else if (parts.length) warn = fs.length ? `Has partitions (${fs.join(', ')}). They will be erased.` : 'Has partitions. They will be erased.';
    else if (fs.length) warn = `Has a file system (${fs.join(', ')}). It will be erased.`;
    out.push({
      name: b.name, size: num(b.size), model: b.model ? String(b.model).trim() : null, serial: b.serial || bays.sysSerial(b.name) || null,
      rotational: b.rota === true || b.rota === '1' || b.rota === 1, transport: b.tran || null,
      byId: byId[b.name] || null, available: !reason, reason, warn,
    });
  }
  return out.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// /dev/disk/by-id: the nicest name per disk (ata-/nvme-/scsi-, not wwn- or eui).
function byIdMap() {
  const dir = '/dev/disk/by-id', out = {};
  let list = [];
  try { list = fs.readdirSync(dir); } catch { return out; }
  const rank = (n) => (/^(ata|nvme|scsi|usb)-/.test(n) && !/eui\.|_1$/.test(n) ? 0 : /^wwn-|^nvme-eui/.test(n) ? 2 : 1);
  for (const n of list.filter((x) => !/-part\d+$/.test(x)).sort((a, b) => rank(a) - rank(b))) {
    let target; try { target = path.basename(fs.readlinkSync(path.join(dir, n))); } catch { continue; }
    if (!out[target]) out[target] = path.join(dir, n);
  }
  return out;
}

async function poolOptions() {
  const [lsblk, status, names] = await Promise.all([
    run('lsblk', ['-J', '-b', '-o', 'NAME,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,FSTYPE,MOUNTPOINTS'], { timeout: 8000 }).then(JSON.parse),
    run('zpool', ['status', '-LP'], { timeout: 8000 }).then(parseZpoolStatus, () => []),
    run('zpool', ['list', '-H', '-o', 'name'], { timeout: 8000 }).then((t) => t.split('\n').map((s) => s.trim()).filter(Boolean), () => []),
  ]);
  const poolDisks = new Map();
  status.forEach((p) => p.devices.forEach((d) => poolDisks.set(d.disk || partToDisk(d.path || ''), p.name)));
  for (const [dev, m] of mixed.diskRoles()) poolDisks.set(dev, m.pool);
  const swaps = new Set(readText('/proc/swaps').split('\n').slice(1).map((l) => path.basename(l.split(/\s+/)[0] || '')).filter(Boolean));
  return { disks: classifyDisks(lsblk, { poolDisks, swaps, byId: byIdMap() }), pools: [...names, ...mixed.list().map((p) => p.name)], layouts: Object.keys(LAYOUTS), compression: COMPRESSION };
}

// Check the choice and build the arguments for `zpool create`.
function buildCreate(body, { disks, pools }) {
  const name = String(body.name || '').trim();
  if (!NAME.test(name) || RESERVED.test(name)) throw httpError('Choose a name that starts with a letter, with letters, digits, - or _ (e.g. tank or fast). Names like mirror or raidz are not allowed.', 400);
  if (pools.includes(name)) throw httpError(`A pool named ${name} already exists.`, 409);
  const layout = String(body.layout || '');
  const L = LAYOUTS[layout];
  if (!L) throw httpError('Choose a layout: stripe, mirror, RAID-Z1, RAID-Z2, RAID-Z3 or mirror pairs.', 400);
  const names = [...new Set((Array.isArray(body.disks) ? body.disks : []).map(String))];
  const chosen = names.map((n) => {
    const d = disks.find((x) => x.name === n);
    if (!d) throw httpError(`The disk ${n} no longer exists. Open the window again.`, 400);
    if (!d.available) throw httpError(`You cannot use ${n}: ${d.reason}.`, 409);
    return d;
  });
  if (chosen.length < L.min) throw httpError(`This layout needs at least ${L.min} disks.`, 400);
  if (L.even && chosen.length % 2) throw httpError('Mirror pairs need an even number of disks.', 400);
  if (String(body.confirm || '') !== name) throw httpError('Type the pool name to confirm that the disks may be erased.', 400);
  const compression = COMPRESSION.includes(body.compression) ? body.compression : 'lz4';

  // Mirror pairs: large with large, so as little as possible is lost.
  const devs = (layout === 'mirrors' ? [...chosen].sort((a, b) => b.size - a.size) : chosen).map((d) => d.byId || '/dev/' + d.name);
  const vdevs = layout === 'stripe' ? devs
    : layout === 'mirrors' ? devs.flatMap((d, i) => (i % 2 ? [] : ['mirror', d, devs[i + 1]]))
    : [layout, ...devs];
  const ssd = chosen.every((d) => !d.rotational);
  return ['create', '-f', '-o', 'ashift=12', '-o', 'autoreplace=on', ...(ssd ? ['-o', 'autotrim=on'] : []),
    '-O', 'compression=' + compression, '-O', 'atime=off', '-O', 'xattr=sa', '-O', 'acltype=posixacl',
    '-m', '/' + name, name, ...vdevs];
}

// folders (on by default): appdata, media, backups, vms and isos as their own datasets. Whatever had no place yet
// (app data, VM disks, ISOs, shared folders) then goes on this pool.
async function createPool(body, { opts = null, step = () => {} } = {}) {
  opts = opts || await poolOptions();
  // A pool with mixed disks (lib/mixed.js): each disk its own file system, parity on one or two disks.
  if (body.kind === 'mixed') return mixed.create(body, { disks: opts.disks, names: opts.pools, step });
  const args = buildCreate(body, opts);
  // Old file systems, partitions and pool labels off the disks first (zpool create -f would also overwrite them,
  // but a leftover label can make a disk look like part of an old pool later).
  for (const n of body.disks) {
    step('disk:' + n, 'running');
    const parts = (await run('lsblk', ['-ln', '-o', 'NAME', '/dev/' + n], { timeout: 10000 }).catch(() => '')).split('\n').map((x) => x.trim())
      .filter((x) => x && x !== n && /^[a-z][a-z0-9]{0,31}$/.test(x));
    for (const part of parts) await run('wipefs', ['-a', '/dev/' + part], { timeout: 30000 }).catch(() => {});
    await run('wipefs', ['-a', '/dev/' + n], { timeout: 30000 }).catch(() => {});
    step('disk:' + n, 'done');
  }
  await run('udevadm', ['settle', '--timeout=15'], { timeout: 20000 }).catch(() => {});
  step('create', 'running');
  try { await run('zpool', args, { timeout: 180000 }); }
  catch (e) { throw httpError('Creating the pool failed: ' + e.message, e.status || 502); }
  step('create', 'done');
  const name = args[args.indexOf('-m') + 2], mountpoint = args[args.indexOf('-m') + 1];
  let folders = [], warning = null;
  if (body.folders !== false) {
    step('folders', 'running');
    try { folders = await paths.createDefaultFolders(name); }
    catch (e) { warning = e.message; }
    step('folders', 'done');
  }
  return { name, folders, uses: paths.adoptPool(mountpoint), warning };
}

// Creating a pool runs as a job the browser follows (GET /api/pools/progress): erasing each disk (or formatting it
// for mixed disks), the pool itself, the default folders. Everything is checked before it starts, so a wrong choice
// still comes back as an error right away. One at a time.
let creating = null; // { name, kind, steps [{ id, label, name, state }], percent, done, ok, error, result, started }

function progress() {
  if (!creating) return { state: 'idle' };
  const { steps, ...rest } = creating;
  return { ...rest, state: creating.done ? (creating.ok ? 'done' : 'failed') : 'running', steps: steps.map((x) => ({ ...x })) };
}

async function startCreate(body) {
  if (creating && !creating.done) throw httpError('A pool is already being created. Wait until it is ready.', 409);
  const opts = await poolOptions();
  const isMixed = body.kind === 'mixed';
  let name, disks;
  if (isMixed) { const p = mixed.plan(body, { disks: opts.disks, names: opts.pools }); name = p.name; disks = p.disks.map((d) => d.name); }
  else { buildCreate(body, opts); name = String(body.name).trim(); disks = [...new Set(body.disks.map(String))]; }
  const steps = [
    ...disks.map((n) => ({ id: 'disk:' + n, label: isMixed ? 'Formatting disk {name}' : 'Erasing disk {name}', name: n, state: 'waiting' })),
    { id: 'create', label: isMixed ? 'Mounting the disks' : 'Creating the pool', state: 'waiting' },
    ...(body.folders !== false ? [{ id: 'folders', label: 'Creating the folders', state: 'waiting' }] : []),
  ];
  // Formatting a disk takes longer than mounting; erasing is quick next to zpool create.
  const weight = (s) => (s.id.startsWith('disk:') ? (isMixed ? 3 : 1) : s.id === 'create' ? (isMixed ? 1 : 3) : 1);
  const total = steps.reduce((a, s) => a + weight(s), 0);
  const job = { name, kind: isMixed ? 'mixed' : 'zfs', steps, percent: 0, done: false, ok: null, error: null, result: null, started: new Date().toISOString() };
  creating = job;
  const step = (id, state) => {
    const s = steps.find((x) => x.id === id);
    if (!s) return;
    s.state = state;
    const done = steps.reduce((a, x) => a + (x.state === 'done' ? weight(x) : x.state === 'running' ? weight(x) / 3 : 0), 0);
    job.percent = Math.min(99, Math.round((done / total) * 100));
  };
  createPool(body, { opts, step }).then((result) => { job.result = result; job.ok = true; job.percent = 100; })
    .catch((e) => {
      job.ok = false; job.error = e.message;
      const running = steps.find((x) => x.state === 'running'); if (running) running.state = 'failed';
    })
    .finally(() => { job.done = true; });
  return { started: true, name, progress: progress() };
}

/* ---- managing a pool: check (scrub), disconnect (export), delete (destroy), and importing one found on the disks */

function checkName(name) {
  if (!NAME.test(String(name || ''))) throw httpError('This pool doesn\'t exist (anymore).', 404);
  return String(name);
}
async function mountpointOf(name) {
  return (await run('zfs', ['get', '-H', '-o', 'value', 'mountpoint', name], { timeout: 8000 }).catch(() => '')).trim();
}
async function refuseWhileUsed(name, what) {
  const mp = await mountpointOf(name);
  const users = await require('./poolusers').poolUsers(mp);
  if (users.length) throw httpError(`${name} is still used by ${users.join(', ')}. Move or remove that first, then ${what} the pool.`, 409);
}

async function scrub(name, stop = false) {
  checkName(name);
  try { await run('zpool', ['scrub', ...(stop ? ['-s'] : []), name], { timeout: 30000 }); }
  catch (e) { throw httpError(stop ? 'No check is running on this pool.' : 'The check could not start: ' + e.message, 409); }
  return { name, scrub: stop ? 'stopped' : 'started' };
}

// Disconnect: the pool and its files stay on the disks; Import brings it back (also on another server).
async function exportPool(name) {
  checkName(name);
  await refuseWhileUsed(name, 'disconnect');
  try { await run('zpool', ['export', name], { timeout: 120000 }); }
  catch (e) { throw httpError('The pool could not be disconnected: ' + e.message, 409); }
  return { name, exported: true };
}

// Delete: everything on the pool is gone. confirm must be the pool's name.
async function destroyPool(name, confirm) {
  checkName(name);
  if (String(confirm || '') !== name) throw httpError('Type the pool name to confirm that everything on it may be erased.', 400);
  await refuseWhileUsed(name, 'delete');
  try { await run('zpool', ['destroy', name], { timeout: 120000 }); }
  catch (e) { throw httpError('The pool could not be deleted: ' + e.message, 409); }
  return { name, destroyed: true };
}

// `zpool import` without a name: the pools found on the disks that can be imported.
function parseImportable(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(pool|id|state|status|action):\s*(.*)$/);
    if (!m) { if (cur && cur.key === 'status' && /^\s{8,}\S/.test(line)) cur.status += ' ' + line.trim(); continue; }
    if (m[1] === 'pool') { cur = { name: m[2].trim(), id: null, state: null, status: '', key: null }; out.push(cur); continue; }
    if (!cur) continue;
    cur.key = m[1];
    if (m[1] === 'id') cur.id = m[2].trim();
    if (m[1] === 'state') cur.state = m[2].trim();
    if (m[1] === 'status') cur.status = m[2].trim();
  }
  return out.map(({ key, ...p }) => p).filter((p) => p.name && /^\d+$/.test(p.id || ''));
}
async function importable() {
  // zpool import exits 1 when there is nothing to import.
  const text = await run('zpool', ['import', '-d', '/dev/disk/by-id'], { timeout: 60000, anyExit: true }).catch(() => '');
  return { pools: parseImportable(text) };
}
async function importPool(id) {
  if (!/^\d{1,20}$/.test(String(id || ''))) throw httpError('Choose a pool to import.', 400);
  const found = (await importable()).pools.find((p) => p.id === String(id));
  if (!found) throw httpError('This pool is no longer on the disks. Open the list again.', 404);
  const names = (await run('zpool', ['list', '-H', '-o', 'name'], { timeout: 8000 }).catch(() => '')).split('\n').map((x) => x.trim());
  if (names.includes(found.name)) throw httpError(`A pool named ${found.name} already exists.`, 409);
  try { await run('zpool', ['import', '-d', '/dev/disk/by-id', String(id)], { timeout: 180000 }); }
  catch (e) { throw httpError('The pool could not be imported: ' + e.message, 409); }
  const mp = await mountpointOf(found.name);
  return { name: found.name, uses: mp.startsWith('/') ? paths.adoptPool(mp) : [] };
}

module.exports = { poolOptions, createPool, startCreate, progress, capacity, classifyDisks, buildCreate, byIdMap, LAYOUTS, scrub, exportPool, destroyPool, parseImportable, importable, importPool };
