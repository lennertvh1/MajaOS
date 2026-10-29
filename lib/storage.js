'use strict';
/* Storage: ZFS pools and datasets (zpool/zfs), disks (lsblk) and their health (smartctl). */
const fs = require('node:fs');
const path = require('node:path');
const bays = require('./bays');
const { run, num } = require('./system');

const HEALTH_ORDER = ['ONLINE', 'DEGRADED', 'OFFLINE', 'REMOVED', 'UNAVAIL', 'FAULTED', 'SUSPENDED'];
const worst = (list) => list.reduce((w, h) => (HEALTH_ORDER.indexOf(h) > HEALTH_ORDER.indexOf(w) ? h : w), 'ONLINE');
const tabLines = (text) => text.split('\n').filter((l) => l.includes('\t'));

function parseZfsList(text) {
  return tabLines(text).map((l) => {
    const [name, used, avail, mountpoint, ratio] = l.split('\t');
    return { name, used: num(used), free: num(avail), mountpoint: !mountpoint || mountpoint === '-' || mountpoint === 'none' ? null : mountpoint,
      compress: parseFloat(ratio) || null };
  });
}
function parseZpoolList(text) {
  return tabLines(text).map((l) => { const [name, health] = l.split('\t'); return { name, health }; });
}

// /dev/sdb1 → sdb, /dev/nvme0n1p1 → nvme0n1
function partToDisk(dev) {
  const b = dev.replace(/^\/dev\//, '');
  if (/^(nvme\d+n\d+|mmcblk\d+)p\d+$/.test(b)) return b.replace(/p\d+$/, '');
  if (/^(sd|vd|hd|xvd)[a-z]+\d+$/.test(b)) return b.replace(/\d+$/, '');
  return b;
}

function parseScan(scan) {
  if (!scan || /none requested/.test(scan)) return { kind: null, running: false, progress: null, errors: null, last: null };
  const p = scan.match(/([\d.]+)% done/);
  const e = scan.match(/with (\d+) errors on (.+?)\s*$/);
  const t = e ? Date.parse(e[2]) : NaN;
  return { kind: /resilver/.test(scan) ? 'resilver' : 'scrub', running: /in progress/.test(scan), progress: p ? Number(p[1]) : null,
    errors: e ? Number(e[1]) : null, last: Number.isNaN(t) ? null : new Date(t).toISOString() };
}

// Output of `zpool status -LP`: per pool the state, the scrub and which disk sits where.
function parseZpoolStatus(text) {
  const pools = [];
  const SECTIONS = { cache: 'cache', logs: 'log', spares: 'spare', special: 'special', dedup: 'dedup' };
  for (const block of text.split(/^\s*pool: /m).slice(1)) {
    const lines = block.split('\n');
    const pool = { name: lines[0].trim(), state: null, scan: '', devices: [] };
    let key = null, inConfig = false, section = 'data', vdev = null;
    for (const raw of lines.slice(1)) {
      if (!inConfig) {
        const k = raw.match(/^\s*(state|status|action|scan|config|see|errors|remove):\s?(.*)$/);
        if (k) {
          key = k[1];
          if (key === 'state') pool.state = k[2].trim();
          if (key === 'scan') pool.scan = k[2].trim();
          if (key === 'config') inConfig = true;
        } else if (key === 'scan' && raw.trim()) pool.scan += ' ' + raw.trim();
        continue;
      }
      if (/^\s*errors:/.test(raw)) { inConfig = false; key = 'errors'; continue; }
      const body = raw.replace(/^\t/, '');
      const indent = body.match(/^ */)[0].length;
      const cols = body.trim().split(/\s+/);
      if (!cols[0] || cols[0] === 'NAME' || cols[0] === pool.name) continue;
      if (SECTIONS[cols[0]] && cols.length === 1) { section = SECTIONS[cols[0]]; vdev = null; continue; }
      if (/^(mirror|raidz\d?|draid\d?)(-|$)/.test(cols[0])) { vdev = cols[0].replace(/-\d+$/, '').replace(/:.*$/, ''); continue; }
      if (indent <= 2) vdev = null;
      pool.devices.push({
        path: cols[0], disk: partToDisk(cols[0]), role: section, vdev, state: cols[1] || null,
        errors: (parseFloat(cols[2]) || 0) + (parseFloat(cols[3]) || 0) + (parseFloat(cols[4]) || 0),
      });
    }
    pools.push(pool);
  }
  return pools;
}

function parseLsblk(json) {
  const d = JSON.parse(json);
  return (d.blockdevices || []).filter((b) => b.type === 'disk' && !/^(zram|loop|sr|ram)/.test(b.name)).map((b) => ({
    name: b.name, size: num(b.size), rotational: b.rota === true || b.rota === '1' || b.rota === 1,
    transport: b.tran || null, model: b.model ? String(b.model).trim() : null, serial: b.serial || null,
  }));
}

// -n standby: don't wake a sleeping HDD. Then there is no temperature ("standby").
const smartCache = new Map();
async function smartCached(dev) {
  const hit = smartCache.get(dev);
  if (hit && Date.now() - hit.at < 60000) return hit;
  const s = await smart(dev);
  const row = { at: Date.now(), ok: s.ok, sectors: s.sectors };
  smartCache.set(dev, row);
  return row;
}

async function smart(dev) {
  try {
    const j = JSON.parse(await run('smartctl', ['-n', 'standby', '-j', '-H', '-A', '/dev/' + dev], { timeout: 8000, anyExit: true }));
    // Sectors the disk had to replace or can't read: the first signs of wear.
    const table = (j.ata_smart_attributes && j.ata_smart_attributes.table) || [];
    const raw = (id) => { const a = table.find((x) => x.id === id); return a && a.raw ? num(a.raw.value) : null; };
    const sectors = table.length ? { reallocated: raw(5) || 0, pending: raw(197) || 0, uncorrectable: raw(198) || 0 } : null;
    return { temp: j.temperature ? num(j.temperature.current) : null, ok: j.smart_status ? j.smart_status.passed !== false : null, sectors };
  } catch { return { temp: null, ok: null, sectors: null }; }
}

function bayTitle(id) {
  const m = String(id).match(/^([ms]?)(\d+)$/);
  if (!m) return String(id);
  if (m[1] === 'm') return 'M.2 ' + m[2];
  if (m[1] === 's') return '2.5" ' + m[2];
  return m[2];
}

// Disks that need attention: pulled out of a bay, gone from the pool, failing, or no longer healthy.
// disks: { name, serial, model, pool, state, errors, smartOk, sectors }. slots: bays.json slots.
function diskAlerts({ status = [], disks = [], slots = {} } = {}) {
  const byName = new Map();
  const present = new Set();
  for (const d of disks) {
    if (d.name) byName.set(d.name, d);
    present.add(d.serial ? 's:' + String(d.serial).trim() : 'n:' + d.name);
    if (d.name) present.add('n:' + d.name);
  }
  const bayOf = new Map();
  for (const [id, v] of Object.entries(slots || {})) {
    if (v && v.key) bayOf.set(v.key, { bay: bayTitle(id), label: v.label || '' });
  }
  const out = new Map();
  const rank = { missing: 0, failing: 1, unhealthy: 2 };
  const put = (id, alert) => {
    const prev = out.get(id);
    if (!prev || rank[alert.kind] < rank[prev.kind]) out.set(id, alert);
  };
  const keyOf = (d) => (d && d.serial ? 's:' + String(d.serial).trim() : d && d.name ? 'n:' + d.name : null);
  const gone = new Set(['UNAVAIL', 'REMOVED']);
  const failing = new Set(['FAULTED', 'DEGRADED', 'OFFLINE']);
  for (const pool of status) {
    for (const dev of pool.devices || []) {
      if (!dev.path) continue;
      const here = dev.disk ? byName.get(dev.disk) : null;
      const id = keyOf(here) || ('z:' + pool.name + ':' + (dev.disk || dev.path));
      const bay = here ? bayOf.get(keyOf(here)) : null;
      const base = {
        pool: pool.name, name: (here && here.name) || dev.disk || null,
        serial: (here && here.serial) || null, model: (here && here.model) || null,
        bay: bay ? bay.bay : null, state: dev.state || null,
      };
      if (gone.has(dev.state) || (failing.has(dev.state) && !here)) put(id, { ...base, kind: 'missing' });
      else if (failing.has(dev.state)) put(id, { ...base, kind: 'failing' });
      else if (dev.errors > 0) put(id, { ...base, kind: 'unhealthy' });
    }
  }
  for (const d of disks) {
    const sec = d.sectors || {};
    if (d.smartOk !== false && !(sec.pending > 0) && !(sec.uncorrectable > 0)) continue;
    const id = keyOf(d);
    const bay = bayOf.get(id);
    put(id, {
      kind: 'unhealthy', pool: d.pool || null, name: d.name || null, serial: d.serial || null,
      model: d.model || null, bay: bay ? bay.bay : null, state: d.state || null,
    });
  }
  const stale = [];
  for (const [key, slot] of bayOf) {
    if (present.has(key)) continue;
    stale.push({ key, ...slot, serial: key.startsWith('s:') ? key.slice(2) : null });
  }
  // One missing pool disk and one empty bay: that is the same disk.
  const missing = [...out.values()].filter((a) => a.kind === 'missing' && !a.bay);
  if (missing.length === 1 && stale.length === 1) {
    const id = [...out.keys()].find((k) => out.get(k) === missing[0]);
    out.set(id, { ...missing[0], bay: stale[0].bay, serial: missing[0].serial || stale[0].serial, model: missing[0].model || stale[0].label || null });
  } else {
    for (const slot of stale) {
      put('bay:' + slot.key, {
        kind: 'missing', pool: null, name: null, serial: slot.serial, model: slot.label || null, bay: slot.bay, state: null,
      });
    }
  }
  return [...out.values()];
}

function summarize(pools) {
  const total = pools.reduce((s, p) => s + (p.total || 0), 0);
  const used = pools.reduce((s, p) => s + (p.used || 0), 0);
  return { health: pools.length ? worst(pools.map((p) => p.health)) : null, total, used, free: total - used, pools: pools.length };
}

// ZFS pools, then the pools with mixed disks (lib/mixed.js).
async function poolSizes() {
  const mixed = require('./mixed').status().map((p) => ({ name: p.name, health: p.health, used: p.used, free: p.free, total: p.total, kind: 'mixed' }));
  let zfs = [];
  try { zfs = await zfsPoolSizes(); } catch (e) { if (!mixed.length) throw e; }
  return [...zfs, ...mixed];
}
async function zfsPoolSizes() {
  const [list, roots] = await Promise.all([
    run('zpool', ['list', '-H', '-o', 'name,health']).then(parseZpoolList),
    run('zfs', ['list', '-Hp', '-d', '0', '-o', 'name,used,avail']).then(parseZfsList),
  ]);
  // Usable space from the root dataset (zpool list counts parity too).
  return list.map((p) => {
    const r = roots.find((x) => x.name === p.name) || {};
    return { name: p.name, health: p.health, used: r.used, free: r.free, total: r.used != null ? r.used + r.free : null };
  });
}

// Short overview for the home screen.
async function storageSummary() { return summarize(await poolSizes()); }

async function storage() {
  let pools = [], datasets = [], status = [], zfsError = null;
  const mixedPools = require('./mixed').status();
  try {
    [pools, datasets, status] = await Promise.all([
      zfsPoolSizes(),
      run('zfs', ['list', '-Hp', '-t', 'filesystem', '-o', 'name,used,avail,mountpoint,compressratio']).then(parseZfsList),
      run('zpool', ['status', '-LP']).then(parseZpoolStatus),
    ]);
  } catch (e) { zfsError = e.message; }

  const devices = new Map();
  status.forEach((p) => p.devices.forEach((d) => devices.set(d.disk, { ...d, pool: p.name })));
  // Disks of a pool with mixed disks: role data or parity; "state" like ZFS so the same warnings work.
  for (const p of mixedPools) {
    for (const d of p.disks) if (d.device) devices.set(d.device, { pool: p.name, role: d.role, state: d.mounted ? 'ONLINE' : 'UNAVAIL', errors: 0 });
  }
  const raw = await listDisks();
  const smarts = await Promise.all(raw.map((d) => smart(d.name)));
  const disks = raw.map((d, i) => {
    const z = devices.get(d.name) || {};
    return { id: d.name, key: bays.diskKey(d), name: d.name, model: d.model, serial: d.serial, size: d.size, rotational: d.rotational, transport: d.transport,
      temp: smarts[i].temp, smartOk: smarts[i].ok, sectors: smarts[i].sectors, pool: z.pool || null, role: z.role || null, vdev: z.vdev || null,
      state: z.state || null, errors: z.errors || 0 };
  });

  const children = datasets.filter((d) => d.name.includes('/'));
  const layout = bays.autoPlace(raw); // new disks in the drawing: a replaced disk's bay, or the first free one
  const mixedOut = mixedPools.map((p) => ({ ...p, disks: undefined, members: p.disks }));
  return {
    ...summarize([...pools, ...mixedPools]), zfsError,
    pools: [...pools.map((p) => {
      const st = status.find((s) => s.name === p.name) || { devices: [], scan: '' };
      const data = st.devices.filter((d) => d.role === 'data');
      const layouts = [...new Set(data.map((d) => d.vdev || 'stripe'))];
      const root = datasets.find((d) => d.name === p.name);
      return { ...p, mountpoint: root ? root.mountpoint : null, layout: layouts.join(' + ') || null, diskCount: data.length, scrub: parseScan(st.scan) };
    }), ...mixedOut],
    disks, bays: layout,
    alerts: diskAlerts({ status, disks, slots: layout.slots }),
    datasets: children.length ? children : datasets,
  };
}

// Whole disks from lsblk, after udev is done with what it was handling, with the serial number filled in from the
// kernel when udev has none for a moment.
async function listDisks() {
  await run('udevadm', ['settle', '--timeout=3'], { timeout: 5000 }).catch(() => {});
  const raw = await run('lsblk', ['-J', '-b', '-d', '-o', 'NAME,SIZE,ROTA,TRAN,MODEL,SERIAL,TYPE']).then(parseLsblk, () => []);
  return raw.map(bays.withSerial);
}

// The disks the kernel sees right now (lsblk only, fast): the storage window compares them to notice a disk that was
// plugged in or taken out.
async function diskList() {
  const raw = await listDisks();
  return { disks: raw.map((d) => ({ name: d.name, serial: d.serial, model: d.model, size: d.size })) };
}

// A SATA or SAS port only reports a disk plugged in while the server runs if hot plug is on for it (BIOS). Asking every
// controller to scan its ports again, and the PCI bus for an NVMe disk, finds it in most other cases.
const SCSI_HOSTS = '/sys/class/scsi_host';
async function rescan() {
  const before = new Set((await diskList()).disks.map((d) => d.name));
  let hosts = [];
  try { hosts = fs.readdirSync(SCSI_HOSTS).filter((h) => /^host\d+$/.test(h)); } catch { /* not Linux */ }
  await Promise.all(hosts.map((h) => fs.promises.writeFile(path.join(SCSI_HOSTS, h, 'scan'), '- - -').catch(() => {})));
  await fs.promises.writeFile('/sys/bus/pci/rescan', '1').catch(() => {});
  await run('udevadm', ['settle', '--timeout=15'], { timeout: 20000 }).catch(() => {});
  const after = await diskList();
  return { ...after, added: after.disks.filter((d) => !before.has(d.name)).map((d) => d.name) };
}

/* ---- disks plugged in or taken out while the server runs: every 5 s lsblk, the difference since the last time.
 * The dashboard shows each event once (/api/overview diskEvents; boot changes when MajaOS restarts). */
const diskKeyOf = (d) => (d.serial ? 's:' + d.serial : 'n:' + d.name);
// prev, cur: lists from listDisks(). Returns {added, removed} (by serial number, otherwise by name).
function diffDisks(prev, cur) {
  const p = new Map(prev.map((d) => [diskKeyOf(d), d])), c = new Map(cur.map((d) => [diskKeyOf(d), d]));
  return { added: [...c].filter(([k]) => !p.has(k)).map(([, d]) => d), removed: [...p].filter(([k]) => !c.has(k)).map(([, d]) => d) };
}
const hotplug = { boot: Date.now().toString(36), seq: 0, events: [], last: null, timer: null };
async function watchOnce() {
  let cur;
  try { cur = await listDisks(); } catch { return; }
  if (hotplug.last) {
    const { added, removed } = diffDisks(hotplug.last, cur);
    for (const [kind, list] of [['added', added], ['removed', removed]]) {
      for (const d of list) {
        hotplug.events.push({ seq: ++hotplug.seq, kind, at: new Date().toISOString(), name: d.name, model: d.model || null, size: d.size || null, transport: d.transport || null });
        console.log(`Disk ${kind === 'added' ? 'plugged in' : 'taken out'}: ${d.name}${d.model ? ' (' + d.model + ')' : ''}`);
      }
    }
    hotplug.events = hotplug.events.slice(-20);
  }
  hotplug.last = cur;
}
function watchDisks() { if (!hotplug.timer) { watchOnce(); hotplug.timer = setInterval(watchOnce, 5000); } }
// For /api/overview: the events of the last 10 minutes.
function diskEvents() {
  const since = Date.now() - 10 * 60000;
  return { boot: hotplug.boot, list: hotplug.events.filter((e) => Date.parse(e.at) > since) };
}

module.exports = { diffDisks, watchDisks, diskEvents, diskList, rescan, storage, storageSummary, poolSizes, parseZfsList, parseZpoolList, parseZpoolStatus, parseScan, parseLsblk, partToDisk, worst, diskAlerts, smart, smartCached };
