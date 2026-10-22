'use strict';
/* Opslag: ZFS-pools en datasets (zpool/zfs), schijven (lsblk) en hun gezondheid (smartctl). */
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

// Uitvoer van `zpool status -LP`: per pool de toestand, de scrub en welke schijf waar in zit.
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

// -n standby: een slapende HDD niet wakker maken. Dan is er geen temperatuur ("in rust").
async function smart(dev) {
  try {
    const j = JSON.parse(await run('smartctl', ['-n', 'standby', '-j', '-H', '-A', '/dev/' + dev], { timeout: 8000, anyExit: true }));
    // Sectoren die de schijf heeft moeten vervangen of niet kan lezen: de eerste tekens van slijtage.
    const table = (j.ata_smart_attributes && j.ata_smart_attributes.table) || [];
    const raw = (id) => { const a = table.find((x) => x.id === id); return a && a.raw ? num(a.raw.value) : null; };
    const sectors = table.length ? { reallocated: raw(5) || 0, pending: raw(197) || 0, uncorrectable: raw(198) || 0 } : null;
    return { temp: j.temperature ? num(j.temperature.current) : null, ok: j.smart_status ? j.smart_status.passed !== false : null, sectors };
  } catch { return { temp: null, ok: null, sectors: null }; }
}

function summarize(pools) {
  const total = pools.reduce((s, p) => s + (p.total || 0), 0);
  const used = pools.reduce((s, p) => s + (p.used || 0), 0);
  return { health: pools.length ? worst(pools.map((p) => p.health)) : null, total, used, free: total - used, pools: pools.length };
}

async function poolSizes() {
  const [list, roots] = await Promise.all([
    run('zpool', ['list', '-H', '-o', 'name,health']).then(parseZpoolList),
    run('zfs', ['list', '-Hp', '-d', '0', '-o', 'name,used,avail']).then(parseZfsList),
  ]);
  // Bruikbare ruimte uit de hoofddataset (zpool list telt pariteit mee).
  return list.map((p) => {
    const r = roots.find((x) => x.name === p.name) || {};
    return { name: p.name, health: p.health, used: r.used, free: r.free, total: r.used != null ? r.used + r.free : null };
  });
}

// Kort overzicht voor het startscherm.
async function storageSummary() { return summarize(await poolSizes()); }

async function storage() {
  let pools = [], datasets = [], status = [], zfsError = null;
  try {
    [pools, datasets, status] = await Promise.all([
      poolSizes(),
      run('zfs', ['list', '-Hp', '-t', 'filesystem', '-o', 'name,used,avail,mountpoint,compressratio']).then(parseZfsList),
      run('zpool', ['status', '-LP']).then(parseZpoolStatus),
    ]);
  } catch (e) { zfsError = e.message; }

  const devices = new Map();
  status.forEach((p) => p.devices.forEach((d) => devices.set(d.disk, { ...d, pool: p.name })));
  const raw = await run('lsblk', ['-J', '-b', '-d', '-o', 'NAME,SIZE,ROTA,TRAN,MODEL,SERIAL,TYPE']).then(parseLsblk, () => []);
  const smarts = await Promise.all(raw.map((d) => smart(d.name)));
  const disks = raw.map((d, i) => {
    const z = devices.get(d.name) || {};
    return { id: d.name, key: bays.diskKey(d), name: d.name, model: d.model, serial: d.serial, size: d.size, rotational: d.rotational, transport: d.transport,
      temp: smarts[i].temp, smartOk: smarts[i].ok, sectors: smarts[i].sectors, pool: z.pool || null, role: z.role || null, vdev: z.vdev || null,
      state: z.state || null, errors: z.errors || 0 };
  });

  const children = datasets.filter((d) => d.name.includes('/'));
  return {
    ...summarize(pools), zfsError,
    pools: pools.map((p) => {
      const st = status.find((s) => s.name === p.name) || { devices: [], scan: '' };
      const data = st.devices.filter((d) => d.role === 'data');
      const layouts = [...new Set(data.map((d) => d.vdev || 'stripe'))];
      return { ...p, layout: layouts.join(' + ') || null, diskCount: data.length, scrub: parseScan(st.scan) };
    }),
    disks, bays: bays.getBays(),
    datasets: children.length ? children : datasets,
  };
}

module.exports = { storage, storageSummary, poolSizes, parseZfsList, parseZpoolList, parseZpoolStatus, parseScan, parseLsblk, partToDisk, worst };
