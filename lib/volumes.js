'use strict';
/* Folders the file browser can open, besides a Samba share: ZFS datasets, the system folders
 * (app data, VMs, ISOs, backups) and removable disks (USB, SD card). Eject only those disks. */
const fs = require('node:fs');
const path = require('node:path');
const { run, httpError } = require('./system');

const APP_UID = Number(process.env.APP_UID || 1000);
const APP_GID = Number(process.env.APP_GID || 1000);
const DEV = /^[a-z][a-z0-9]{0,31}$/;
const SKIP_FS = /^(zfs_member|linux_raid_member|LVM2_member|swap|crypto_LUKS)$/;
const FAT = /^(vfat|msdos|exfat|ntfs|ntfs3)$/;
const BLOCKED = [/^\/$/, /^\/boot(\/|$)/, /^\/etc(\/|$)/, /^\/usr(\/|$)/, /^\/var(\/|$)/, /^\/home(\/|$)/, /^\/opt(\/|$)/, /^\/root(\/|$)/, /^\/sys(\/|$)/, /^\/proc(\/|$)/, /^\/dev(\/|$)/];

const SYSTEM = [
  { id: '@appdata', key: 'appdata', name: 'App data', missing: 'The folder for app data ({dir}) does not exist. Create the dataset first or change APPDATA_DIR.' },
  { id: '@vms', key: 'vms', name: 'VMs', missing: 'The folder for VM disks ({dir}) does not exist. Create a pool in Storage first, or choose a folder in Settings → Storage.' },
  { id: '@isos', key: 'isos', name: 'ISOs', missing: 'The folder for ISOs ({dir}) does not exist. Create a pool in Storage first, or choose a folder in Settings → Storage.' },
];

const yes = (v) => v === true || v === 1 || v === '1';
const mountsOf = (node) => {
  const list = Array.isArray(node.mountpoints) ? node.mountpoints : (node.mountpoint ? [node.mountpoint] : []);
  return list.filter((m) => typeof m === 'string' && m.startsWith('/'));
};

function diskId(uuid, dev) {
  const raw = String(uuid || dev || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return '@d' + (raw || 'disk').slice(0, 40);
}
function zfsId(name) {
  return '@z' + Buffer.from(String(name)).toString('base64url');
}

function removableDisk(disk) {
  if (!disk || disk.type !== 'disk') return false;
  if (disk.tran === 'usb') return true;
  return /^mmcblk\d+$/.test(disk.name || '') && (yes(disk.rm) || yes(disk.hotplug));
}

// lsblk -J. Internal disks, the system disk and ZFS members are not volumes you can eject.
function parseVolumes(lsblk) {
  const out = [];
  for (const disk of (lsblk && lsblk.blockdevices) || []) {
    if (!removableDisk(disk) || !DEV.test(disk.name || '')) continue;
    const kids = Array.isArray(disk.children) && disk.children.length ? disk.children : [disk];
    const sd = /^mmcblk/.test(disk.name);
    for (const part of kids) {
      if (!part || part === disk && disk.children && disk.children.length) continue;
      if (!DEV.test(part.name || '') || !part.fstype || SKIP_FS.test(part.fstype)) continue;
      const mounts = mountsOf(part);
      if (mounts.some((m) => BLOCKED.some((re) => re.test(path.resolve(m))))) continue;
      const label = String(part.label || '').trim();
      const model = String(disk.model || '').replace(/\s+/g, ' ').trim();
      const mount = mounts.find((m) => safeMount(m)) || null;
      out.push({
        id: diskId(part.uuid, part.name),
        name: label || (sd ? 'SD card' : 'USB drive'),
        generic: !label,
        media: sd ? 'sd' : 'usb',
        model: label ? '' : model,
        kind: 'disk',
        eject: true,
        path: mount,
        dev: part.name,
        disk: disk.name,
        fstype: part.fstype,
      });
    }
  }
  return out;
}

function safeMount(mp) {
  if (!mp || typeof mp !== 'string' || mp.includes('\0') || !path.isAbsolute(mp)) return false;
  const r = path.resolve(mp);
  if (BLOCKED.some((re) => re.test(r))) return false;
  return r.startsWith('/media/') || r.startsWith('/mnt/') || r.startsWith('/run/media/') || r.startsWith('/run/majaos/media/');
}

function same(a, b) {
  return !!(a && b && path.resolve(a) === path.resolve(b));
}

// shares: { name, path }. datasets: { name, mountpoint }. volumes: parseVolumes(). dirs: { appdata, vms, isos } when the folder exists.
function buildPlaces({ shares = [], datasets = [], volumes = [], dirs = {} } = {}) {
  const taken = [];
  const seen = (p) => p && taken.some((t) => same(t, p));
  const remember = (p) => { if (p && !seen(p)) taken.push(p); };

  const sharePlaces = shares.map((s) => {
    remember(s.path);
    return { id: s.name, name: s.name, kind: 'share', path: s.path || '' };
  });

  const system = [];
  for (const spec of SYSTEM) {
    const dir = dirs[spec.key];
    if (!dir || seen(dir)) continue;
    remember(dir);
    system.push({ id: spec.id, name: spec.name, kind: 'system', path: dir });
  }

  const backups = datasets.filter((d) => d && d.mountpoint && /\/backups$/.test(d.name) && !seen(d.mountpoint));
  for (const d of backups) {
    remember(d.mountpoint);
    system.push({
      id: backups.length === 1 ? '@backups' : zfsId(d.name),
      name: 'Backups', kind: 'system', detail: backups.length > 1 ? d.name.split('/')[0] : '', path: d.mountpoint,
    });
  }

  const folderSrc = datasets.filter((d) => d && d.name && d.name.includes('/') && d.mountpoint && d.mountpoint.startsWith('/') && !seen(d.mountpoint));
  const leaves = folderSrc.map((d) => d.name.split('/').pop());
  const folders = folderSrc.map((d) => {
    const leaf = d.name.split('/').pop();
    remember(d.mountpoint);
    return { id: zfsId(d.name), name: leaves.filter((x) => x === leaf).length > 1 ? d.name : leaf, kind: 'folder', path: d.mountpoint };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  // A whole pool (ZFS or mixed disks), so every folder on it can be opened.
  const poolPlaces = datasets.filter((d) => d && d.name && !d.name.includes('/') && d.mountpoint && d.mountpoint.startsWith('/') && !seen(d.mountpoint))
    .map((d) => { remember(d.mountpoint); return { id: zfsId(d.name), name: d.name, kind: 'pool', path: d.mountpoint }; })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return [...sharePlaces, ...folders, ...system, ...poolPlaces, ...volumes.map((v) => ({ ...v, kind: 'disk', eject: true }))];
}

// The place that holds an absolute path (the deepest one) and the path inside it.
function locate(list, abs) {
  if (typeof abs !== 'string' || !abs.startsWith('/') || abs.includes('\0')) return null;
  const target = path.resolve(abs);
  let best = null;
  for (const p of list || []) {
    if (!p.path) continue;
    const root = path.resolve(p.path);
    const rel = target === root ? '' : target.startsWith(root.replace(/\/$/, '') + '/') ? target.slice(root.replace(/\/$/, '').length + 1) : null;
    if (rel === null || (best && best.root.length >= root.length)) continue;
    best = { root, place: p.id, rel };
  }
  return best && { place: best.place, rel: best.rel };
}

function publish(p) {
  const out = { id: p.id, name: p.name, kind: p.kind };
  if (p.eject) out.eject = true;
  if (p.generic) out.generic = true;
  if (p.media) out.media = p.media;
  if (p.model) out.model = p.model;
  if (p.detail) out.detail = p.detail;
  return out;
}

function mountedAt(dev) {
  let text = '';
  try { text = fs.readFileSync('/proc/mounts', 'utf8'); } catch { return null; }
  const prefix = '/dev/' + dev + ' ';
  const line = text.split('\n').find((l) => l.startsWith(prefix));
  if (!line) return null;
  return line.split(' ')[1].replace(/\\040/g, ' ');
}

async function connected() {
  const read = async (cols) => JSON.parse(await run('lsblk', ['-J', '-o', cols], { timeout: 8000 }));
  try { return parseVolumes(await read('NAME,TYPE,TRAN,RM,HOTPLUG,MODEL,LABEL,FSTYPE,UUID,MOUNTPOINTS')); }
  catch {
    try { return parseVolumes(await read('NAME,TYPE,TRAN,RM,MODEL,LABEL,FSTYPE,UUID,MOUNTPOINT')); }
    catch { return []; }
  }
}

async function mount(vol) {
  const current = vol.dev && DEV.test(vol.dev) ? mountedAt(vol.dev) : null;
  if (current && safeMount(current)) return current;
  if (vol.path && safeMount(vol.path)) return vol.path;
  if (!DEV.test(vol.dev || '')) throw httpError('This disk is no longer connected.', 404);
  const dest = path.join('/run/majaos/media', vol.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 48));
  fs.mkdirSync(dest, { recursive: true });
  const args = [];
  if (FAT.test(String(vol.fstype || ''))) args.push('-o', `uid=${APP_UID},gid=${APP_GID},umask=002`);
  args.push('/dev/' + vol.dev, dest);
  try { await run('mount', args, { timeout: 20000 }); }
  catch (e) {
    const again = mountedAt(vol.dev);
    if (again && safeMount(again)) return again;
    throw httpError('The disk could not be opened: ' + e.message, 502);
  }
  return dest;
}

// Only a removable volume we just listed. A mount point outside /media, /mnt or our own folder is refused.
function ejectTarget(vol) {
  if (!vol || vol.kind !== 'disk' || !DEV.test(vol.dev || '') || !DEV.test(vol.disk || '')) throw httpError('This disk is no longer connected.', 404);
  const live = mountedAt(vol.dev);
  const mp = (live && safeMount(live) ? live : null) || (vol.path && safeMount(vol.path) ? vol.path : null);
  if ((live || vol.path) && !mp) throw httpError('That path is not allowed.', 400);
  return { mount: mp, device: '/dev/' + vol.disk };
}

function ejectFailure(message) {
  return /busy/i.test(String(message || '')) ? 'This disk is in use. Close the files that are open on it, then eject it again.' : null;
}

async function eject(vol) {
  const target = ejectTarget(vol);
  if (target.mount) {
    try { await run('umount', [target.mount], { timeout: 20000 }); }
    catch (e) {
      const friendly = ejectFailure(e.message);
      throw httpError(friendly || ('The disk could not be ejected: ' + e.message), friendly ? 409 : (e.status || 502));
    }
  }
  await run('eject', ['-s', target.device], { timeout: 15000 }).catch(() => { /* unmounted is enough when eject is missing */ });
  return { ejected: true };
}

module.exports = {
  SYSTEM, parseVolumes, buildPlaces, locate, publish, safeMount, ejectTarget, ejectFailure, connected, mount, eject, zfsId,
};
