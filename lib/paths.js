'use strict';
/*
 * Waar HomeBaseOS zijn mappen zet: appgegevens, VM-schijven, ISO's en de basis voor gedeelde mappen (Unraid-shares).
 * DATA_DIR/paths.json: { appdata, vms, isos, shares }. Ontbreekt een waarde, dan geldt de omgevingsvariabele van
 * vroeger (APPDATA_DIR, VM_DIR, ISO_DIR, SHARES_DIR), anders is het nog niet ingesteld (null).
 * Een nieuwe pool krijgt standaardmappen (DEFAULT_FOLDERS); wat nog niet ingesteld is, komt dan op die pool.
 */
const fs = require('node:fs');
const path = require('node:path');
const { run, httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'paths.json');
const ENV = { appdata: 'APPDATA_DIR', vms: 'VM_DIR', isos: 'ISO_DIR', shares: 'SHARES_DIR' };
const KINDS = Object.keys(ENV);
// Map op de pool per soort; shares is de pool zelf (/mnt/user/media → /<pool>/media).
const FOLDER = { appdata: 'appdata', vms: 'vms', isos: 'isos', shares: '' };
// Datasets die een nieuwe pool krijgt. Deze van de app-gebruiker zijn, zodat apps en Samba erin kunnen schrijven.
const DEFAULT_FOLDERS = ['appdata', 'media', 'backups', 'vms', 'isos'];
const APP_OWNED = new Set(['appdata', 'media', 'backups']);
// Alleen om te tonen zolang er nog geen pool is (installeren kan dan toch niet).
const PLACEHOLDER = { appdata: '/<pool>/appdata', vms: '/<pool>/vms', isos: '/<pool>/isos', shares: '/<pool>' };

let cache = null;
function stored() {
  if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { cache = {}; } }
  return cache;
}
function write(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  cache = next;
}

// Ingestelde map, of null.
function dir(kind) {
  const v = stored()[kind] || process.env[ENV[kind]];
  return v ? path.resolve(v) : null;
}
// Ingestelde map, of een voorbeeld als er nog niets is.
const shown = (kind) => dir(kind) || PLACEHOLDER[kind];
const exists = (kind) => { const d = dir(kind); return !!d && fs.existsSync(d); };
function all() { return Object.fromEntries(KINDS.map((k) => [k, dir(k)])); }

function save(changes) {
  const next = { ...stored() };
  for (const [k, v] of Object.entries(changes)) {
    if (!KINDS.includes(k)) continue;
    if (v != null && (typeof v !== 'string' || !path.isAbsolute(v) || /[\r\n]/.test(v))) throw httpError('Kies een volledig pad, bv. /tank/appdata.', 400);
    if (v == null) delete next[k]; else next[k] = path.resolve(v);
  }
  write(next);
  return all();
}

// Een nieuwe pool (of een pool die HomeBaseOS net vond): wat nog niet ingesteld is of niet bestaat, komt erop.
function adoptPool(mountpoint, { only = null } = {}) {
  const changes = {};
  for (const k of KINDS) {
    if (only && !only.includes(k)) continue;
    const target = path.join(mountpoint, FOLDER[k]);
    if (!exists(k) && fs.existsSync(target)) changes[k] = target;
  }
  if (Object.keys(changes).length) save(changes);
  return Object.keys(changes);
}

// zfs list: bestandssystemen met hun koppelpunt (alleen echte paden).
async function datasets() {
  const out = await run('zfs', ['list', '-H', '-p', '-o', 'name,mountpoint,avail', '-t', 'filesystem'], { timeout: 8000 }).catch(() => '');
  return out.split('\n').map((l) => l.split('\t')).filter(([n, m]) => n && m && m.startsWith('/'))
    .map(([name, mountpoint, avail]) => ({ name, mountpoint, avail: Number(avail) || 0 }));
}
async function pools() {
  return (await datasets()).filter((d) => !d.name.includes('/')).map((d) => ({ name: d.name, mountpoint: d.mountpoint, free: d.avail }));
}

// Bij het opstarten: nog niets ingesteld, maar een pool heeft al een map appdata/vms/isos? Neem die.
async function detect() {
  const list = await datasets();
  const changes = {};
  for (const k of KINDS) {
    if (exists(k) || k === 'shares') continue;
    const hit = list.find((d) => d.name.split('/').length === 2 && d.name.endsWith('/' + FOLDER[k]));
    if (hit) changes[k] = hit.mountpoint;
  }
  if (!exists('shares')) {
    const base = changes.appdata || dir('appdata');
    const pool = list.find((d) => !d.name.includes('/') && base && (base === d.mountpoint || base.startsWith(d.mountpoint + '/'))) || list.find((d) => !d.name.includes('/'));
    if (pool) changes.shares = pool.mountpoint;
  }
  if (Object.keys(changes).length) save(changes);
  return all();
}

// De standaardmappen op een nieuwe pool. Een map die al bestaat, blijft zoals ze is.
async function createDefaultFolders(pool, { uid = Number(process.env.APP_UID || 1000), gid = Number(process.env.APP_GID || 1000) } = {}) {
  const made = [];
  for (const f of DEFAULT_FOLDERS) {
    const ds = pool + '/' + f;
    try { await run('zfs', ['create', ds], { timeout: 30000 }); made.push(f); }
    catch (e) { if (!/already exists/i.test(e.message)) throw httpError(`De map ${f} aanmaken lukte niet: ${e.message}`, e.status || 502); }
    if (APP_OWNED.has(f)) {
      const mp = (await run('zfs', ['get', '-H', '-o', 'value', 'mountpoint', ds]).catch(() => '')).trim();
      if (mp.startsWith('/')) { try { fs.chownSync(mp, uid, gid); } catch { /* geen root (ontwikkelen) */ } }
    }
  }
  return made;
}

function _reset() { cache = null; }

module.exports = { dir, shown, exists, all, save, adoptPool, detect, pools, datasets, createDefaultFolders, DEFAULT_FOLDERS, KINDS, FOLDER, _reset };
