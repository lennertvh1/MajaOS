'use strict';
/*
 * ZFS-pool aanmaken: welke schijven vrij zijn, hoeveel opslag een indeling oplevert, en `zpool create`.
 * Schijven gaan altijd via /dev/disk/by-id, zodat de pool ze terugvindt als sda/sdb van naam wisselt.
 */
const fs = require('node:fs');
const path = require('node:path');
const { run, num, readText, httpError } = require('./system');
const { parseZpoolStatus, partToDisk } = require('./storage');
const paths = require('./paths');

// Indelingen: minimum aantal schijven, hoeveel er mogen uitvallen, en wat bruikbaar is (in "schijven").
const LAYOUTS = {
  stripe: { min: 1, data: (n) => n, fail: () => 0 },
  mirror: { min: 2, data: () => 1, fail: (n) => n - 1 },
  raidz1: { min: 3, data: (n) => n - 1, fail: () => 1 },
  raidz2: { min: 4, data: (n) => n - 2, fail: () => 2 },
  raidz3: { min: 5, data: (n) => n - 3, fail: () => 3 },
  mirrors: { min: 4, even: true, data: (n) => n / 2, fail: () => 1 }, // mirror-paren (RAID 10): 1 per paar, zeker
};
const COMPRESSION = ['lz4', 'zstd', 'off'];
const NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const RESERVED = /^(mirror|raidz\d?|draid\d?|spare|log|cache|special|dedup|c\d+)/i;

// Opslag van een indeling. ZFS gebruikt van elke schijf alleen zoveel als de kleinste; het houdt ~3% achter (slop).
function capacity(layout, sizes) {
  const L = LAYOUTS[layout], n = sizes.length;
  if (!L || n < L.min || (L.even && n % 2)) return null;
  const raw = sizes.reduce((a, b) => a + b, 0);
  let usable, perDisk;
  if (layout === 'stripe') { usable = raw; perDisk = null; }
  else if (layout === 'mirrors') {
    // Paren in de volgorde van grootte: elk paar telt de kleinste van de twee.
    const s = [...sizes].sort((a, b) => b - a);
    usable = 0; for (let i = 0; i < n; i += 2) usable += Math.min(s[i], s[i + 1]);
    perDisk = null;
  } else { perDisk = Math.min(...sizes); usable = L.data(n) * perDisk; }
  const unused = perDisk == null ? (layout === 'mirrors' ? raw / 2 - usable : 0) : sizes.reduce((a, b) => a + (b - perDisk), 0);
  const slop = Math.min(Math.max(usable / 32, 128 * 1048576), 128 * 1073741824);
  return { raw, usable: Math.max(0, usable - slop), redundancy: Math.max(0, raw - usable - unused), unused, failures: L.fail(n) };
}

// lsblk -J -b met partities: welke schijven vrij zijn en waarom niet.
function classifyDisks(lsblk, { poolDisks = new Map(), swaps = new Set(), byId = {} } = {}) {
  const out = [];
  for (const b of lsblk.blockdevices || []) {
    if (b.type !== 'disk' || /^(zram|loop|sr|ram|md)/.test(b.name)) continue;
    const parts = b.children || [];
    const mounts = [b, ...parts].flatMap((x) => (x.mountpoints || [x.mountpoint]).filter(Boolean));
    const fs = [...new Set(parts.map((p) => p.fstype).concat(b.fstype).filter(Boolean))];
    let reason = null, warn = null;
    if (poolDisks.has(b.name)) reason = 'In pool ' + poolDisks.get(b.name);
    else if (mounts.some((m) => m === '/' || m === '/boot' || m === '/boot/efi' || m === '[SWAP]')) reason = 'Systeemschijf (Debian staat erop)';
    else if (mounts.length) reason = 'In gebruik: ' + mounts.join(', ');
    else if ([b, ...parts].some((x) => swaps.has(x.name))) reason = 'In gebruik als swap';
    else if (fs.includes('zfs_member')) warn = 'Hoorde bij een oude ZFS-pool. Die gegevens worden gewist.';
    else if (parts.length) warn = fs.length ? `Heeft partities (${fs.join(', ')}). Die worden gewist.` : 'Heeft partities. Die worden gewist.';
    else if (fs.length) warn = `Heeft een bestandssysteem (${fs.join(', ')}). Dat wordt gewist.`;
    out.push({
      name: b.name, size: num(b.size), model: b.model ? String(b.model).trim() : null, serial: b.serial || null,
      rotational: b.rota === true || b.rota === '1' || b.rota === 1, transport: b.tran || null,
      byId: byId[b.name] || null, available: !reason, reason, warn,
    });
  }
  return out.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// /dev/disk/by-id: per schijf de mooiste naam (ata-/nvme-/scsi-, niet wwn- of eui).
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

// Controleer de keuze en bouw de argumenten voor `zpool create`.
function buildCreate(body, { disks, pools }) {
  const name = String(body.name || '').trim();
  if (!NAME.test(name) || RESERVED.test(name)) throw httpError('Kies een naam die met een letter begint, met letters, cijfers, - of _ (bv. tank of snel). Namen als mirror of raidz zijn niet toegelaten.', 400);
  if (pools.includes(name)) throw httpError(`Er bestaat al een pool met de naam ${name}.`, 409);
  const layout = String(body.layout || '');
  const L = LAYOUTS[layout];
  if (!L) throw httpError('Kies een indeling: stripe, mirror, RAID-Z1, RAID-Z2, RAID-Z3 of mirror-paren.', 400);
  const names = [...new Set((Array.isArray(body.disks) ? body.disks : []).map(String))];
  const chosen = names.map((n) => {
    const d = disks.find((x) => x.name === n);
    if (!d) throw httpError(`De schijf ${n} bestaat niet (meer). Open het venster opnieuw.`, 400);
    if (!d.available) throw httpError(`${n} kan je niet gebruiken: ${d.reason}.`, 409);
    return d;
  });
  if (chosen.length < L.min) throw httpError(`Deze indeling heeft minstens ${L.min} schijven nodig.`, 400);
  if (L.even && chosen.length % 2) throw httpError('Mirror-paren hebben een even aantal schijven nodig.', 400);
  if (String(body.confirm || '') !== name) throw httpError('Typ de naam van de pool om te bevestigen dat de schijven gewist mogen worden.', 400);
  const compression = COMPRESSION.includes(body.compression) ? body.compression : 'lz4';

  // Mirror-paren: groot bij groot, zodat zo weinig mogelijk verloren gaat.
  const devs = (layout === 'mirrors' ? [...chosen].sort((a, b) => b.size - a.size) : chosen).map((d) => d.byId || '/dev/' + d.name);
  const vdevs = layout === 'stripe' ? devs
    : layout === 'mirrors' ? devs.flatMap((d, i) => (i % 2 ? [] : ['mirror', d, devs[i + 1]]))
    : [layout, ...devs];
  const ssd = chosen.every((d) => !d.rotational);
  return ['create', '-f', '-o', 'ashift=12', ...(ssd ? ['-o', 'autotrim=on'] : []),
    '-O', 'compression=' + compression, '-O', 'atime=off', '-O', 'xattr=sa', '-O', 'acltype=posixacl',
    '-m', '/' + name, name, ...vdevs];
}

// folders (standaard aan): appdata, media, backups, vms en isos als eigen datasets. Wat nog geen plek had
// (appgegevens, VM-schijven, ISO's, gedeelde mappen), komt daarna op deze pool.
async function createPool(body) {
  const opts = await poolOptions();
  const args = buildCreate(body, opts);
  try { await run('zpool', args, { timeout: 180000 }); }
  catch (e) { throw httpError('De pool aanmaken lukte niet: ' + e.message, e.status || 502); }
  const name = args[args.indexOf('-m') + 2], mountpoint = args[args.indexOf('-m') + 1];
  let folders = [], warning = null;
  if (body.folders !== false) {
    try { folders = await paths.createDefaultFolders(name); }
    catch (e) { warning = e.message; }
  }
  return { name, folders, uses: paths.adoptPool(mountpoint), warning };
}

module.exports = { poolOptions, createPool, capacity, classifyDisks, buildCreate, LAYOUTS };
