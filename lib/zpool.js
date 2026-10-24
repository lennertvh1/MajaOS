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
      name: b.name, size: num(b.size), model: b.model ? String(b.model).trim() : null, serial: b.serial || null,
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
  const swaps = new Set(readText('/proc/swaps').split('\n').slice(1).map((l) => path.basename(l.split(/\s+/)[0] || '')).filter(Boolean));
  return { disks: classifyDisks(lsblk, { poolDisks, swaps, byId: byIdMap() }), pools: names, layouts: Object.keys(LAYOUTS), compression: COMPRESSION };
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
async function createPool(body) {
  const opts = await poolOptions();
  const args = buildCreate(body, opts);
  try { await run('zpool', args, { timeout: 180000 }); }
  catch (e) { throw httpError('Creating the pool failed: ' + e.message, e.status || 502); }
  const name = args[args.indexOf('-m') + 2], mountpoint = args[args.indexOf('-m') + 1];
  let folders = [], warning = null;
  if (body.folders !== false) {
    try { folders = await paths.createDefaultFolders(name); }
    catch (e) { warning = e.message; }
  }
  return { name, folders, uses: paths.adoptPool(mountpoint), warning };
}

module.exports = { poolOptions, createPool, capacity, classifyDisks, buildCreate, byIdMap, LAYOUTS };
