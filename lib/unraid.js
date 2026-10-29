'use strict';
/*
 * Moving from Unraid (Storage → Move from Unraid): the Unraid USB stick and the disks of the old server are in this
 * server. scan() reads what there is, migrate() takes over what the user ticked, as one job with steps.
 *
 * - The stick (FAT, label UNRAID) is mounted read-only: config/ident.cfg (name), config/shares/*.cfg (shared folders
 *   with their access), config/passwd (users), config/plugins/dockerMan/templates-user/my-*.xml (apps; userprefs.cfg says
 *   which were still installed), config/domain.cfg (where libvirt.img and the VM disks are).
 * - The disks: a data disk has one partition with xfs or btrfs (Unraid's array), the parity disk has a partition without
 *   a file system, a cache pool is btrfs over one or more SSDs (one UUID). Unraid's own disk numbering (super.dat) isn't
 *   read: a path like /mnt/disk2/x is looked up on every data disk.
 * - To look inside, data and cache disks are mounted read-only under /run/majaos/unraid/<name>. "/mnt/user/<share>/x"
 *   is the union of all of them, cache first (like Unraid).
 * - Taking over: the data disks as a pool with mixed disks (mixed.adopt: nothing is formatted, the parity disk becomes
 *   SnapRAID's), shared folders (with the files of the cache copied onto the pool), users (new passwords), apps (template
 *   → compose, app data copied with rsync), VMs (the disk converted with qemu-img, CPU and memory from libvirt.img).
 */
const fs = require('node:fs');
const path = require('node:path');
const { run, runStream, httpError } = require('./system');
const { parseXml, find, findAll, attr, text } = require('./xml');

const RUN_DIR = process.env.UNRAID_MOUNT_DIR || '/run/majaos/unraid';
const APP_UID = Number(process.env.APP_UID || 1000), APP_GID = Number(process.env.APP_GID || 1000);

/* ---- reading the stick (pure, tested) */

// KEY="value" lines (ident.cfg, shares/*.cfg, domain.cfg).
function parseCfg(textIn) {
  const out = {};
  for (const line of String(textIn || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*"?(.*?)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

// config/shares/<name>.cfg → access in MajaOS's terms: public = guests, secure = guests read + write list,
// private = the read and write lists. Only exported shares (shareExport "e" or "es") were shared over SMB.
function shareFromCfg(name, cfg) {
  const security = String(cfg.shareSecurity || 'public');
  const users = {};
  if (security !== 'public') {
    for (const u of list(cfg.shareReadList)) users[u] = 'ro';
    for (const u of list(cfg.shareWriteList)) users[u] = 'rw';
  }
  return {
    name, comment: cfg.shareComment || '', exported: /^e/.test(cfg.shareExport || 'e'), security,
    guest: security === 'public' || security === 'secure', users, cache: cfg.shareUseCache || 'no',
  };
}

// config/passwd: the users created in Unraid's interface (uid 1000 and up).
function parsePasswd(textIn) {
  return String(textIn || '').split(/\r?\n/).map((l) => l.split(':')).filter((x) => x.length >= 3 && Number(x[2]) >= 1000 && Number(x[2]) < 60000)
    .map((x) => x[0]).filter((n) => /^[a-z_][a-z0-9_-]{0,31}$/.test(n));
}

// userprefs.cfg: the containers that were still installed, in their order (0="plex").
function parseUserprefs(textIn) {
  return String(textIn || '').split(/\r?\n/).map((l) => (l.match(/^\s*\d+\s*=\s*"(.*)"\s*$/) || [])[1]).filter(Boolean);
}

// An Unraid template (my-<name>.xml) in the shape the app store uses for Community Apps (see appstore.normConfig).
function parseTemplate(xmlText) {
  const c = parseXml(String(xmlText || '')); // the top element
  if (c.name !== 'Container') throw new Error('No <Container> in the template.');
  const get = (n) => { const el = find(c, n); return el ? text(el).trim() : ''; };
  const config = findAll(c, 'Config').map((el) => ({
    '@attributes': Object.fromEntries(el.attrs.map(([k, v]) => [k, v])),
    value: text(el),
  }));
  return {
    name: get('Name'), image: get('Repository'), network: get('Network') || 'bridge', myIp: get('MyIP'),
    privileged: get('Privileged') === 'true', webui: get('WebUI') || null, icon: /^https?:\/\//.test(get('Icon')) ? get('Icon') : null,
    extraParams: get('ExtraParams'), postArgs: get('PostArgs'), templateUrl: get('TemplateURL') || null, overview: get('Overview'), config,
  };
}

// A domain from libvirt.img: what MajaOS needs to make the same VM.
const UNRAID_OS = { windows11: 'windows11', windows10: 'windows10', windows: 'windows10', windows2022: 'winserver', windows2019: 'winserver',
  ubuntu: 'ubuntu', debian: 'debian', fedora: 'fedora', linux: 'linux', freebsd: 'freebsd', pfsense: 'opnsense', opnsense: 'opnsense', truenas: 'truenas' };
function parseDomain(xmlText) {
  const d = parseXml(String(xmlText || ''));
  if (d.name !== 'domain') throw new Error('No <domain> in the file.');
  const name = text(find(d, 'name') || { children: [] }).trim();
  const memEl = find(d, 'memory');
  const unit = (memEl && attr(memEl, 'unit')) || 'KiB';
  const mult = { KiB: 1024, k: 1024, MiB: 1048576, M: 1048576, GiB: 1073741824, G: 1073741824, b: 1, bytes: 1 }[unit] || 1024;
  const memory = memEl ? Number(text(memEl)) * mult : null;
  const vcpus = Number(text(find(d, 'vcpu') || { children: [] })) || null;
  const os = find(d, 'os');
  const loader = os && find(os, 'loader');
  const uefi = !!(loader && /ovmf|edk2/i.test(text(loader))) || (os && attr(os, 'firmware') === 'efi');
  const disks = findAll(find(d, 'devices') || d, 'disk').filter((x) => attr(x, 'device') === 'disk').map((x) => {
    const src = find(x, 'source'), tgt = find(x, 'target');
    return { path: src ? attr(src, 'file') : null, bus: tgt ? attr(tgt, 'bus') : null };
  }).filter((x) => x.path);
  const nic = findAll(find(d, 'devices') || d, 'interface').map((x) => { const m = find(x, 'model'); return m ? attr(m, 'type') : null; })[0] || null;
  const tpl = find(find(d, 'metadata') || d, 'vmtemplate');
  const osHint = tpl ? String(attr(tpl, 'os') || '').toLowerCase() : '';
  const hostdev = findAll(find(d, 'devices') || d, 'hostdev').length;
  let osId = UNRAID_OS[osHint] || (/^windows/.test(osHint) ? 'windows10' : null);
  if (/home ?assistant|hass|haos/i.test(name + ' ' + (tpl ? attr(tpl, 'name') || '' : ''))) osId = 'haos';
  return { name, memory, vcpus, firmware: uefi ? 'uefi' : 'bios', disks, nic, os: osId || 'other', passthrough: hostdev };
}

/* ---- the disks (pure, tested): lsblk -J -b -o NAME,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,FSTYPE,UUID,LABEL,MOUNTPOINTS */

// role: flash | data | parity | cache | encrypted | zfs | other. The system disk and USB disks other than the stick
// aren't listed. A btrfs UUID on more than one disk, or btrfs/xfs on an SSD, is a cache pool.
function classify(lsblk) {
  const out = [];
  const devs = (lsblk.blockdevices || []).filter((d) => d.type === 'disk');
  const parts = (d) => (d.children || []).filter((p) => p.type === 'part');
  const mountsOf = (d) => [d, ...(d.children || [])].flatMap((x) => (x.mountpoints || []).filter(Boolean));
  const btrfsCount = new Map();
  devs.forEach((d) => parts(d).forEach((p) => { if (p.fstype === 'btrfs' && p.uuid) btrfsCount.set(p.uuid, (btrfsCount.get(p.uuid) || 0) + 1); }));
  for (const d of devs) {
    const ps = parts(d), p = ps[0] || null;
    const mounts = mountsOf(d);
    const base = { name: d.name, size: Number(d.size) || 0, model: (d.model || '').trim() || null, serial: (d.serial || '').trim() || null,
      rotational: d.rota === true || d.rota === '1' || d.rota === 1, transport: d.tran || null, part: p ? p.name : null, fs: p ? p.fstype || null : null, uuid: p ? p.uuid || null : null };
    if (ps.some((x) => x.label === 'UNRAID' && x.fstype === 'vfat')) { out.push({ ...base, role: 'flash', part: ps.find((x) => x.label === 'UNRAID').name }); continue; }
    if (mounts.some((m) => m === '/' || m === '/boot' || m === '/boot/efi' || m.startsWith('/usr') || m === '/var')) continue; // the system disk
    if (d.tran === 'usb') continue;
    if (!p) { out.push({ ...base, role: 'other' }); continue; }
    if (p.fstype === 'crypto_LUKS') { out.push({ ...base, role: 'encrypted' }); continue; }
    if (p.fstype === 'zfs_member') { out.push({ ...base, role: 'zfs' }); continue; }
    if (p.fstype === 'btrfs' && (btrfsCount.get(p.uuid) || 0) > 1) { out.push({ ...base, role: 'cache' }); continue; }
    if (p.fstype === 'xfs' || p.fstype === 'btrfs') { out.push({ ...base, role: base.rotational ? 'data' : 'cache' }); continue; }
    if (!p.fstype && ps.length === 1) { out.push({ ...base, role: 'parity' }); continue; }
    out.push({ ...base, role: 'other' });
  }
  // A parity disk is at least as large as every data disk; a smaller disk without a file system is something else.
  const largest = Math.max(0, ...out.filter((x) => x.role === 'data').map((x) => x.size));
  out.forEach((x) => { if (x.role === 'parity' && x.size < largest) x.role = 'other'; });
  return out;
}

// Where an Unraid path is on this server. roots: [{kind: cache|data, dir}], cache first. /mnt/user/<x> and /mnt/cache/<x>
// and /mnt/diskN/<x> → every root that has <x> (cache first). Returns {share, rest, hits: [dir]} or null for other paths.
function resolveUnraid(p, roots, exists = fs.existsSync) {
  const m = String(p || '').match(/^\/mnt\/(user0?|cache|disk\d+|[a-z][\w-]*)\/([^/]+)(\/.*)?$/);
  if (!m || ['remotes', 'addons', 'disks', 'rootshare'].includes(m[1])) return null;
  const share = m[2], rest = (m[3] || '').replace(/\/+$/, '');
  const which = m[1] === 'cache' ? roots.filter((r) => r.kind === 'cache') : /^disk\d+$/.test(m[1]) || m[1] === 'user0' ? roots.filter((r) => r.kind === 'data') : roots;
  const hits = which.map((r) => path.join(r.dir, share, rest)).filter((x) => exists(x));
  return { share, rest, hits };
}

/* ---- mounting (read-only, to look) */

const mountedHere = new Map(); // partition (or btrfs UUID) → dir we mounted
function mountsTable() { return require('./mixed').readMounts(); }
// The directory where this partition is mounted now (by us, by a pool), or a new read-only mount.
async function lookAt(disk) {
  const dev = '/dev/' + disk.part;
  const real = (x) => { try { return fs.realpathSync(x); } catch { return x; } };
  const hit = mountsTable().find((m) => real(m.source) === dev);
  if (hit) return hit.target;
  const key = disk.fs === 'btrfs' && disk.uuid ? 'uuid:' + disk.uuid : dev;
  if (mountedHere.has(key) && mountsTable().some((m) => m.target === mountedHere.get(key))) return mountedHere.get(key);
  const dir = path.join(RUN_DIR, disk.role === 'flash' ? 'flash' : disk.name);
  fs.mkdirSync(dir, { recursive: true });
  if (disk.fs === 'btrfs') await run('btrfs', ['device', 'scan'], { timeout: 30000 }).catch(() => {});
  try { await run('mount', ['-o', 'ro', dev, dir], { timeout: 60000 }); }
  catch (e) {
    // XFS that wasn't cleanly unmounted won't mount read-only without skipping its log.
    if (disk.fs !== 'xfs') throw e;
    await run('mount', ['-o', 'ro,norecovery', dev, dir], { timeout: 60000 });
  }
  mountedHere.set(key, dir);
  return dir;
}
const realpath = (x) => { try { return fs.realpathSync(x); } catch { return x; } };
async function unmountKey(key) {
  const dir = mountedHere.get(key);
  if (!dir) return;
  await run('umount', [dir], { timeout: 60000 }).catch(() => {});
  mountedHere.delete(key);
}
async function release() {
  for (const [key, dir] of mountedHere) {
    await run('umount', [dir], { timeout: 60000 }).catch(() => {});
    try { fs.rmdirSync(dir); } catch { /* still busy or not empty */ }
    mountedHere.delete(key);
  }
}

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const usedOf = (dir) => { try { const s = fs.statfsSync(dir); return (s.blocks - s.bfree) * s.bsize; } catch { return null; } };
async function sizeOf(dir) {
  try { return Number((await run('du', ['-sb', dir], { timeout: 8000 })).split(/\s/)[0]) || null; } catch { return null; }
}

/* ---- scan */

let last = null; // {at, result}
async function scan({ fresh = false } = {}) {
  if (job && !job.done) return { found: true, running: true };
  if (!fresh && last && Date.now() - last.at < 30000) return last.result;
  const lsblk = JSON.parse(await run('lsblk', ['-J', '-b', '-o', 'NAME,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,FSTYPE,UUID,LABEL,MOUNTPOINTS'], { timeout: 10000 }));
  const disks = classify(lsblk);
  const flash = disks.find((d) => d.role === 'flash');
  if (!flash) { last = { at: Date.now(), result: { found: false } }; return last.result; }
  const boot = await lookAt(flash);
  const cfg = path.join(boot, 'config');
  const ident = parseCfg(readText(path.join(cfg, 'ident.cfg')));
  const version = (readText(path.join(boot, 'changes.txt')).match(/Version\s+([\d.]+[\w.-]*)/) || [])[1] || null;
  const warnings = [];

  // The disks, each opened read-only to see its folders and what is used.
  const roots = [];
  const seenCache = new Set();
  for (const d of disks.filter((x) => x.role === 'data' || x.role === 'cache')) {
    if (d.role === 'cache' && d.fs === 'btrfs' && seenCache.has(d.uuid)) { d.sameAs = disks.find((x) => x.uuid === d.uuid && x !== d && x.dir)?.name || null; continue; }
    try {
      d.dir = await lookAt(d);
      d.used = usedOf(d.dir);
      d.folders = readDir(d.dir).filter((x) => x.isDirectory() && !x.name.startsWith('.') && x.name !== 'lost+found').map((x) => x.name);
      roots.push({ kind: d.role, dir: d.dir, disk: d.name });
      if (d.role === 'cache') seenCache.add(d.uuid);
    } catch (e) { d.error = 'This disk could not be opened: ' + e.message; }
  }
  roots.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'cache' ? -1 : 1));
  disks.filter((d) => d.role === 'encrypted').forEach((d) => warnings.push(`The disk ${d.name} is encrypted. Unlock it on Unraid and copy its files, or take it over later.`));
  disks.filter((d) => d.role === 'zfs').forEach((d) => warnings.push(`The disk ${d.name} holds a ZFS pool. Take it over with Import pool in Storage.`));

  // Shared folders: from the stick, with where their files are.
  const shareNames = readDir(path.join(cfg, 'shares')).filter((x) => x.isFile() && /\.cfg$/i.test(x.name)).map((x) => x.name.replace(/\.cfg$/i, ''));
  const shares = shareNames.map((n) => {
    const s = shareFromCfg(n, parseCfg(readText(path.join(cfg, 'shares', n + '.cfg'))));
    s.onData = disks.filter((d) => d.role === 'data' && (d.folders || []).includes(n)).map((d) => d.name);
    s.onCache = disks.filter((d) => d.role === 'cache' && (d.folders || []).includes(n)).map((d) => d.name);
    return s;
  });

  const users = parsePasswd(readText(path.join(cfg, 'passwd')));

  // Apps: the templates of the containers that were installed (the rest stay in the list, unticked).
  const tdir = path.join(cfg, 'plugins', 'dockerMan', 'templates-user');
  const installed = parseUserprefs(readText(path.join(cfg, 'plugins', 'dockerMan', 'userprefs.cfg')));
  const apps = [];
  for (const f of readDir(tdir).filter((x) => x.isFile() && /^my-.*\.xml$/i.test(x.name))) {
    let t;
    try { t = parseTemplate(readText(path.join(tdir, f.name))); } catch (e) { warnings.push(`The template ${f.name} could not be read: ${e.message}`); continue; }
    if (!t.name || !t.image) continue;
    const folders = [];
    for (const c of t.config) {
      const a = c['@attributes'] || {};
      if (a.Type !== 'Path') continue;
      const host = String(c.value || a.Default || '').trim();
      const r = resolveUnraid(host, roots);
      if (!r) continue;
      folders.push({ target: a.Target, host, share: r.share, rest: r.rest, appdata: r.share === 'appdata', found: r.hits.length > 0 });
    }
    const data = folders.filter((x) => x.appdata && x.found);
    const dataDirs = [...new Set(data.map((x) => path.join('appdata', x.rest.split('/')[1] || '')))];
    let size = 0;
    for (const dd of dataDirs) for (const r of roots) { const p = path.join(r.dir, dd); if (fs.existsSync(p)) size += (await sizeOf(p)) || 0; }
    apps.push({
      file: f.name, name: t.name, slug: slugify(t.name), image: t.image, icon: t.icon, network: t.network, ip: t.myIp || null,
      installed: installed.includes(t.name), folders, shares: [...new Set(folders.filter((x) => !x.appdata).map((x) => x.share))],
      dataSize: dataDirs.length ? size : null,
    });
  }
  apps.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));

  // VMs: libvirt.img (a btrfs image on the cache or a disk) has their XML; without it, the folders in domains/.
  const dcfg = parseCfg(readText(path.join(cfg, 'domain.cfg')));
  const vms = [];
  const img = resolveUnraid(dcfg.IMAGE_FILE || '/mnt/user/system/libvirt/libvirt.img', roots);
  let libvirtDir = null;
  if (img && img.hits[0]) {
    libvirtDir = path.join(RUN_DIR, 'libvirt');
    fs.mkdirSync(libvirtDir, { recursive: true });
    const busy = mountsTable().some((m) => m.target === libvirtDir);
    try { if (!busy) { await run('mount', ['-o', 'loop,ro', img.hits[0], libvirtDir], { timeout: 30000 }); mountedHere.set('libvirt', libvirtDir); } }
    catch (e) { warnings.push('The VM settings (libvirt.img) could not be opened: ' + e.message); libvirtDir = null; }
  }
  const xmls = libvirtDir ? readDir(path.join(libvirtDir, 'qemu')).filter((x) => x.isFile() && /\.xml$/.test(x.name)) : [];
  for (const x of xmls) {
    let d;
    try { d = parseDomain(readText(path.join(libvirtDir, 'qemu', x.name))); } catch { continue; }
    const disksOf = d.disks.map((dk) => { const r = resolveUnraid(dk.path, roots); const at = r && r.hits[0]; return { path: dk.path, at: at || null, size: at ? (fs.statSync(at).size || null) : null }; });
    vms.push({ ...d, disks: disksOf });
  }
  if (!xmls.length) {
    const dom = resolveUnraid((dcfg.DOMAINDIR || '/mnt/user/domains/').replace(/\/?$/, '/x'), roots);
    const bases = dom ? roots.map((r) => path.join(r.dir, dom.share)) : [];
    for (const b of bases) {
      for (const v of readDir(b).filter((x) => x.isDirectory())) {
        if (vms.some((y) => y.name === v.name)) continue;
        const files = readDir(path.join(b, v.name)).filter((x) => x.isFile() && /\.(img|qcow2|raw)$/i.test(x.name));
        if (!files.length) continue;
        vms.push({ name: v.name, memory: null, vcpus: null, firmware: 'uefi', nic: null, passthrough: 0, os: /home ?assistant|hass|haos/i.test(v.name) ? 'haos' : 'other',
          disks: files.map((f) => { const at = path.join(b, v.name, f.name); return { path: `/mnt/user/${dom.share}/${v.name}/${f.name}`, at, size: fs.statSync(at).size }; }), guessed: true });
      }
    }
  }

  const result = {
    found: true, name: ident.NAME || null, version, flash: flash.name, warnings,
    disks: disks.filter((d) => d.role !== 'flash').map(({ dir, ...d }) => d),
    shares, users, apps, vms,
  };
  last = { at: Date.now(), result, roots, disks, boot };
  return result;
}

function slugify(name) { return String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 63) || 'app'; }

/* ---- migrating: one job with steps, like creating a pool */

let job = null; // {steps [{id, label, name, state, error, since}], percent, done, ok, error, lines, started}
const say = (l) => { if (job) { job.lines.push(String(l)); if (job.lines.length > 400) job.lines.shift(); } };

function progress() {
  if (!job) return { state: 'idle' };
  const { steps, ...rest } = job;
  return { ...rest, lines: rest.lines.slice(-200), state: job.done ? (job.ok ? 'done' : 'failed') : 'running',
    steps: steps.map(({ since, ...x }) => ({ ...x, ...(x.state === 'running' && since ? { secs: Math.round((Date.now() - since) / 1000) } : {}) })) };
}

// rsync with its progress in the step (percent of that step).
async function copy(from, to, st) {
  fs.mkdirSync(to, { recursive: true });
  await runStream('rsync', ['-aHAX', '--numeric-ids', '--info=progress2', '--no-inc-recursive', from.replace(/\/?$/, '/'), to.replace(/\/?$/, '/')], (line) => {
    const m = line.match(/\s(\d{1,3})%\s/);
    if (m) st.percent = Math.min(99, Number(m[1])); else if (line.trim()) say(line.trim());
  }, { timeout: 0 });
}

// body: {pool: {name, data: [disk names], parity: [disk names]} | null, shares: [names], users: [{name, password}],
// apps: [{file, data: bool}], folders: {<share>: '/abs/folder'} (where an app's share goes when the disks don't come
// along), vms: [names]}. Checked as far as possible first; then each step runs, and a failed app or VM doesn't stop
// the others.
async function migrate(body) {
  if (job && !job.done) throw httpError('A move from Unraid is already running.', 409);
  const res = await scan();
  if (!res.found) throw httpError('No Unraid USB stick found. Put it in this server and look again.', 404);
  const { roots, boot } = last;
  const mixed = require('./mixed'), zpool = require('./zpool'), paths = require('./paths'), shares = require('./shares');
  const opts = await zpool.poolOptions();

  // The pool: data disks with their files, parity disks that may be erased.
  let pool = null;
  if (body.pool) {
    const byName = (n) => res.disks.find((d) => d.name === n);
    const data = (body.pool.data || []).map(byName).filter(Boolean);
    const parity = (body.pool.parity || []).map((n) => opts.disks.find((d) => d.name === n)).filter(Boolean);
    if ((body.pool.parity || []).length !== parity.length) throw httpError('A parity disk you chose is no longer there. Look again.', 400);
    const byId = (n) => (opts.disks.find((d) => d.name === n) || {}).byId || '/dev/' + n;
    pool = { name: String(body.pool.name || '').trim(), data: data.map((d) => ({ ...d, byId: byId(d.name) })), parity, folders: true };
    mixed.planAdopt(pool, { names: opts.pools }); // throws on a wrong choice
  }
  const poolDir = pool ? '/' + pool.name : null;

  const appsIn = (Array.isArray(body.apps) ? body.apps : []).map((a) => ({ ...a, app: res.apps.find((x) => x.file === a.file) })).filter((a) => a.app);
  const vmsIn = (Array.isArray(body.vms) ? body.vms : []).map((n) => res.vms.find((v) => v.name === n)).filter(Boolean);
  const sharesIn = (Array.isArray(body.shares) ? body.shares : []).map((n) => res.shares.find((s) => s.name === n)).filter(Boolean);
  const usersIn = (Array.isArray(body.users) ? body.users : []).filter((u) => res.users.includes(u.name));
  if (sharesIn.length && !pool) throw httpError('Shared folders come along with the data disks. Tick the data disks too.', 400);
  for (const u of usersIn) shares.validatePassword(u.password);
  const folderFor = (share) => {
    if (pool) return path.join(poolDir, share);
    const f = body.folders && body.folders[share];
    return f && path.isAbsolute(String(f)) && !/[\r\n]/.test(String(f)) ? path.resolve(String(f)) : null;
  };

  const steps = [
    ...(pool ? [...pool.parity.map((d) => ({ id: 'disk:' + d.name, label: 'Preparing parity disk {name}', name: d.name })),
      { id: 'mount', label: 'Taking over the data disks' }, { id: 'folders', label: 'Creating the folders' }] : []),
    ...usersIn.map((u) => ({ id: 'user:' + u.name, label: 'User {name}', name: u.name })),
    ...sharesIn.map((s) => ({ id: 'share:' + s.name, label: 'Shared folder {name}', name: s.name })),
    ...appsIn.map((a) => ({ id: 'app:' + a.file, label: 'App {name}', name: a.app.name })),
    ...vmsIn.map((v) => ({ id: 'vm:' + v.name, label: 'VM {name}', name: v.name })),
  ].map((x) => ({ ...x, state: 'waiting', percent: 0 }));
  if (!steps.length) throw httpError('Choose what you want to take over.', 400);
  job = { steps, percent: 0, done: false, ok: null, error: null, lines: [], started: new Date().toISOString(), failed: 0 };
  const mine = job;
  const weight = (x) => (x.id.startsWith('app:') || x.id.startsWith('vm:') ? 3 : 1);
  const total = steps.reduce((a, x) => a + weight(x), 0);
  const tick = () => { mine.percent = Math.min(99, Math.round(steps.reduce((a, x) => a + weight(x) * (x.state === 'done' || x.state === 'failed' ? 1 : x.state === 'running' ? (x.percent || 0) / 100 : 0), 0) / total * 100)); };
  const step = (id, state, error) => {
    const x = steps.find((y) => y.id === id); if (!x) return;
    x.state = state; if (state === 'running') x.since = Date.now();
    if (error) { x.error = error; mine.failed++; say(`${x.name || x.id}: ${error}`); }
    tick();
  };
  const timer = setInterval(tick, 1000);

  (async () => {
    if (pool) {
      // libvirt.img may sit on a data disk: its loop mount would keep that disk busy.
      await unmountKey('libvirt');
      // Without the pool nothing else makes sense (app data and VMs go on it): a failure here stops everything.
      await mixed.adopt(pool, { names: opts.pools, step: (id, state) => step(id, state) });
      // The data disks are now mounted in the pool: read from there.
      for (const r of roots.filter((x) => x.kind === 'data')) {
        const d = last.disks.find((x) => x.name === r.disk);
        const hit = d && mountsTable().find((m) => m.source === '/dev/' + d.part || realpath(m.source) === '/dev/' + d.part);
        if (hit) r.dir = hit.target;
      }
    }
    for (const u of usersIn) {
      step('user:' + u.name, 'running');
      try { await shares.createUser({ name: u.name, password: u.password }); step('user:' + u.name, 'done'); }
      catch (e) { step('user:' + u.name, 'failed', e.message); }
    }
    for (const s of sharesIn) {
      const id = 'share:' + s.name, st = steps.find((x) => x.id === id);
      step(id, 'running');
      try {
        const dir = folderFor(s.name);
        // Files that were still on the cache (Unraid moves them to the array at night) are copied onto the pool.
        for (const r of roots.filter((x) => x.kind === 'cache')) {
          const src = path.join(r.dir, s.name);
          if (fs.existsSync(src)) { say(`Copying ${s.name} from the cache…`); await copy(src, dir, st); }
        }
        fs.mkdirSync(dir, { recursive: true });
        if (s.exported) {
          const access = Object.fromEntries(Object.entries(s.users).filter(([u]) => usersIn.some((x) => x.name === u)));
          if (!s.guest && !Object.keys(access).length) throw httpError('Nobody you took over had access to it. Share it yourself in Shared folders.', 400);
          await shares.saveShare({ name: s.name, path: dir, comment: s.comment, users: access, guest: s.guest });
        }
        step(id, 'done');
      } catch (e) { step(id, 'failed', e.message); }
    }
    for (const a of appsIn) {
      const id = 'app:' + a.file, st = steps.find((x) => x.id === id);
      step(id, 'running');
      try { await migrateApp(a, { boot, roots, folderFor, pool, st }); step(id, 'done'); }
      catch (e) { step(id, 'failed', e.message); }
    }
    for (const v of vmsIn) {
      const id = 'vm:' + v.name;
      step(id, 'running');
      try { await migrateVm(v, { roots }); step(id, 'done'); }
      catch (e) { step(id, 'failed', e.message); }
    }
  })().then(() => { mine.ok = mine.failed === 0; if (mine.failed) mine.error = 'Not everything could be taken over. See the steps.'; },
    (e) => { mine.ok = false; mine.error = e.message; const r = steps.find((x) => x.state === 'running'); if (r) { r.state = 'failed'; r.error = e.message; } })
    .finally(async () => {
      clearInterval(timer);
      mine.percent = 100; mine.done = true; mine.finished = new Date().toISOString();
      await release().catch(() => {});
      last = null;
    });
  return { started: true, progress: progress() };
}

// One app: its template with Unraid's paths replaced, the app data copied (if chosen), then installed like from the
// app store (compose file + docker compose pull/up), and waited for.
async function migrateApp(a, { boot, roots, folderFor, pool, st }) {
  const appstore = require('./appstore'), paths = require('./paths'), dockernet = require('./dockernet');
  const t = parseTemplate(readText(path.join(boot, 'config', 'plugins', 'dockerMan', 'templates-user', a.file)));
  const slug = slugify(t.name);
  const appdata = paths.dir('appdata');
  if (!appdata || !fs.existsSync(appdata)) throw httpError('There is no folder for app data yet. Take over the data disks, or create a pool first.', 503);
  const copies = [];
  for (const c of t.config) {
    const at = c['@attributes'] || (c['@attributes'] = {});
    if (at.Type !== 'Path') continue;
    const host = String(c.value || at.Default || '').trim();
    const r = resolveUnraid(host, roots);
    if (!r) continue;
    let to;
    if (r.share === 'appdata') {
      to = path.join(appdata, r.rest);
      const top = r.rest.split('/')[1];
      if (a.data && top && !copies.some((x) => x.top === top)) copies.push({ top, dest: path.join(appdata, top) });
    } else {
      const base = folderFor(r.share);
      if (!base) { at.Type = 'Skipped'; say(`${t.name}: ${host} was left out (no folder chosen for ${r.share}).`); continue; }
      to = path.join(base, r.rest);
    }
    c.value = to; at.Default = '';
  }
  // The app data: from every disk that has it (cache last: on Unraid the cache copy is the newest).
  for (const cp of copies) {
    const sources = [...roots].reverse().map((r) => ({ r, src: path.join(r.dir, 'appdata', cp.top) })).filter((x) => fs.existsSync(x.src))
      // On a pool made of the same disks the files are already there.
      .filter((x) => !(pool && x.r.kind === 'data' && cp.dest.startsWith('/' + pool.name + '/')));
    if (!sources.length) continue;
    if (fs.existsSync(cp.dest) && readDir(cp.dest).length && !(pool && cp.dest.startsWith('/' + pool.name + '/'))) {
      throw httpError(`The folder ${cp.dest} already exists and isn't empty. Move it away first, or take the app over without its data.`, 409);
    }
    for (const s of sources) { say(`${t.name}: copying ${s.src}…`); await copy(s.src, cp.dest, st); }
    // Unraid runs apps as nobody:users (99:100); here they run as the app user.
    if (t.config.some((c) => /^(PUID|PGID)$/.test((c['@attributes'] || {}).Target || ''))) await run('chown', ['-R', `${APP_UID}:${APP_GID}`, cp.dest], { timeout: 0 }).catch(() => {});
  }
  // The template as the app store's: its fields with this server's user and time zone.
  const store = await appstore.catalog(false).catch(() => null);
  const match = store && store.apps.find((x) => x.image.replace(/:latest$/, '') === t.image.replace(/:latest$/, ''));
  const app = { id: match ? match.id : null, name: t.name, image: t.image, icon: t.icon || (match && match.icon) || null, webui: t.webui,
    network: t.network, privileged: t.privileged, extraParams: t.extraParams, postArgs: t.postArgs, templateUrl: t.templateUrl, maintainer: '' };
  const fields = appstore.prepareFields(appstore.normConfig(t.config.filter((c) => (c['@attributes'] || {}).Type !== 'Skipped')), slug);
  // The network: host stays host, an own address (br0 with a fixed IP) gets an own address in the home network again.
  let network;
  const n = String(t.network || 'bridge');
  if (/^host$/i.test(n)) network = await dockernet.networkFor('host');
  else if (!/^(bridge|none)$/i.test(n) && t.myIp) network = await dockernet.networkFor('@lan', t.myIp).catch((e) => { say(`${t.name}: own address ${t.myIp} not possible (${e.message}); it uses the server's ports.`); return null; });
  if (!network) network = await dockernet.networkFor('bridge');
  const compose = appstore.buildCompose(app, slug, fields, { network });
  compose.warnings.forEach((w) => say(`${t.name}: ${w}`));
  const r = await appstore.installCompose({ name: slug, text: compose.text });
  for (;;) {
    await new Promise((x) => setTimeout(x, 1500));
    const j = appstore.jobStatus(r.job);
    if (j && typeof j.percent === 'number') st.percent = Math.max(st.percent || 0, j.percent);
    if (!j || j.done) { if (j && !j.ok) throw httpError(j.error || 'Installing failed.', 502); break; }
  }
}
// One VM: the first disk converted into the VM folder, CPU, memory and firmware as on Unraid.
async function migrateVm(v, { roots }) {
  const vms = require('./vms');
  // Looked up again: the data disks may have moved into the pool since the scan.
  const disk = v.disks.map((x) => { const r = resolveUnraid(x.path, roots); return { ...x, at: (r && r.hits[0]) || (x.at && fs.existsSync(x.at) ? x.at : null) }; }).find((x) => x.at);
  if (!disk) throw httpError('The VM\'s disk was not found on the disks of the old server.', 404);
  if (v.disks.length > 1) say(`${v.name}: only the first disk is taken over; add the others in the VM's settings.`);
  if (v.passthrough) say(`${v.name}: passed-through devices (USB, PCI) were left out; add them again in the VM's settings.`);
  const name = String(v.name).replace(/[^A-Za-z0-9 ._()-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 63) || 'vm';
  const opts = await vms.vmOptions();
  const cpus = Math.max(1, Math.min(opts.maxVcpus, v.vcpus || 2));
  const memGb = Math.max(1, Math.min(Math.floor(opts.maxMemory / 1073741824) - 1, Math.round((v.memory || 4 * 1073741824) / 1073741824)));
  await vms.createVm({ name, os: v.os, media: 'disk', vcpus: cpus, memoryGb: memGb, firmware: v.firmware, network: opts.network,
    ...(v.nic && ['virtio', 'e1000e', 'rtl8139'].includes(v.nic) ? { nic: v.nic } : {}) }, { sourcePath: disk.at });
}

// Close: the read-only mounts go away.
async function close() { if (job && !job.done) throw httpError('A move from Unraid is running. Wait until it is done.', 409); await release(); last = null; return { closed: true }; }

module.exports = { parseCfg, shareFromCfg, parsePasswd, parseUserprefs, parseTemplate, parseDomain, classify, resolveUnraid, scan, migrate, progress, close };
