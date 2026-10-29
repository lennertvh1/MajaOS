'use strict';
/*
 * What still uses a pool, before it may be disconnected or removed: the folders for app data, VMs, ISOs and shared
 * folders (Settings > Storage), shared folders, apps with a bind mount on it, and the backup app's archive.
 * Returns plain names for the message ("app data", "Films", "app jellyfin"…).
 */
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const KIND_NAMES = { appdata: 'app data', vms: 'virtual machines', isos: 'ISO files', shares: 'shared folders' };

const inside = (mp) => (p) => !!p && (p === mp || p.startsWith(mp.replace(/\/$/, '') + '/'));

async function poolUsers(mountpoint, { containers = null } = {}) {
  if (!mountpoint || !mountpoint.startsWith('/') || mountpoint === '/') return [];
  const at = inside(mountpoint), out = [];
  for (const [k, v] of Object.entries(require('./paths').all())) if (at(v)) out.push(KIND_NAMES[k] || k);
  for (const sh of require('./shares').shareRecords()) if (at(sh.path)) out.push('shared folder ' + sh.name);
  let list = containers;
  if (!list) { try { list = await require('./docker').docker('GET', '/containers/json?all=1'); } catch { list = []; } }
  for (const c of list || []) {
    if ((c.Mounts || []).some((m) => m.Type === 'bind' && at(m.Source))) out.push('app ' + String((c.Names || [''])[0]).replace(/^\//, ''));
  }
  try {
    const k = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'kopia', 'state.json'), 'utf8'));
    if (k && at(k.path)) out.push('the backup app');
  } catch { /* the backup app was never turned on */ }
  return [...new Set(out)];
}

module.exports = { poolUsers, inside };
