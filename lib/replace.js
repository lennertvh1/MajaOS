'use strict';
/*
 * A failed disk: put a new one in its place and the pool rebuilds itself.
 * ZFS does not notice a new serial number on its own, so when exactly one data disk is gone
 * and exactly one free disk is large enough, HomeBaseOS runs `zpool replace`.
 * A resilver that is already running is left alone. Several missing disks, or several free disks: wait,
 * and say so, because guessing would erase the wrong disk.
 * New pools are created with autoreplace=on; existing pools get that the first time we look.
 */
const { run, readText } = require('./system');
const path = require('node:path');
const bays = require('./bays');
const { parseZpoolStatus, parseScan, partToDisk } = require('./storage');
const { classifyDisks, byIdMap } = require('./zpool');

const GONE = new Set(['UNAVAIL', 'REMOVED', 'OFFLINE']);

function bayLabel(id) {
  const m = String(id).match(/^([ms]?)(\d+)$/);
  if (!m) return String(id);
  if (m[1] === 'm') return 'M.2 ' + m[2];
  if (m[1] === 's') return '2.5" ' + m[2];
  return m[2];
}

// The bay whose disk is no longer in the machine, when there is exactly one such bay.
function emptyBay(slots, presentKeys) {
  const stale = Object.entries(slots || {}).filter(([, v]) => v && v.key && !presentKeys.has(v.key));
  return stale.length === 1 ? bayLabel(stale[0][0]) : null;
}

// status: parseZpoolStatus(). present: disk names lsblk still sees. available: free disks ({ name, size, byId }).
// sizes: { diskName: bytes } for disks that are still there. bays: getBays().
function planReplace({ status = [], present = [], available = [], sizes = {}, bays = {} } = {}) {
  const here = new Set(present);
  const slot = emptyBay(bays.slots, bays.presentKeys || new Set());
  const gone = (d) => GONE.has(d.state) || (d.state === 'FAULTED' && !here.has(d.disk));
  const poolsMissing = status.filter((p) => (p.devices || []).some((d) => d.role === 'data' && gone(d)));
  const replace = [], waiting = [], failing = [];
  for (const pool of status) {
    const scan = parseScan(pool.scan);
    if (scan.running && scan.kind === 'resilver') continue;
    const data = (pool.devices || []).filter((d) => d.role === 'data');
    const missing = data.filter(gone);
    const faulted = data.filter((d) => d.state === 'FAULTED' && here.has(d.disk));
    if (!missing.length) {
      faulted.forEach((d) => failing.push({ pool: pool.name, disk: d.disk || d.path }));
      continue;
    }
    const known = data.filter((d) => here.has(d.disk) && sizes[d.disk]).map((d) => sizes[d.disk]);
    const floor = known.length ? Math.min(...known) * 0.99 : 0;
    const fits = available.filter((d) => d.size >= floor);
    const item = { pool: pool.name, old: missing[0].path, disk: missing[0].disk || partToDisk(missing[0].path || ''), bay: slot };
    // One gap in the whole machine and one free disk: that is the disk that was just put in.
    if (missing.length === 1 && poolsMissing.length === 1 && fits.length === 1) replace.push({ ...item, neu: fits[0].byId || '/dev/' + fits[0].name, newName: fits[0].name });
    else waiting.push(item);
  }
  return { replace, waiting, failing };
}

function repairView(status, plan) {
  const running = (status || []).map((p) => ({ name: p.name, scan: parseScan(p.scan) })).find((p) => p.scan.running && p.scan.kind === 'resilver');
  if (running) return { state: 'rebuilding', pool: running.name, progress: running.scan.progress, bay: null, disk: null };
  const go = plan.replace[0];
  if (go) return { state: 'replacing', pool: go.pool, bay: go.bay, disk: go.disk, progress: null };
  const wait = plan.waiting[0];
  if (wait) return { state: 'waiting', pool: wait.pool, bay: wait.bay, disk: wait.disk, progress: null };
  const bad = plan.failing[0];
  if (bad) return { state: 'failing', pool: bad.pool, bay: null, disk: bad.disk, progress: null };
  return null;
}

async function look() {
  const [status, lsblk] = await Promise.all([
    run('zpool', ['status', '-LP'], { timeout: 8000 }).then(parseZpoolStatus),
    run('lsblk', ['-J', '-b', '-o', 'NAME,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,FSTYPE,MOUNTPOINTS'], { timeout: 8000 }).then(JSON.parse),
  ]);
  const poolDisks = new Map();
  status.forEach((p) => p.devices.forEach((d) => {
    if (d.state === 'ONLINE' || d.state === 'DEGRADED' || d.state === 'FAULTED') poolDisks.set(d.disk || partToDisk(d.path || ''), p.name);
  }));
  const swaps = new Set(readText('/proc/swaps').split('\n').slice(1).map((l) => path.basename(l.split(/\s+/)[0] || '')).filter(Boolean));
  const disks = classifyDisks(lsblk, { poolDisks, swaps, byId: byIdMap() });
  const layout = bays.getBays();
  const presentKeys = new Set(disks.map((d) => (d.serial ? 's:' + String(d.serial).trim() : 'n:' + d.name)));
  const plan = planReplace({
    status, present: disks.map((d) => d.name), available: disks.filter((d) => d.available),
    sizes: Object.fromEntries(disks.map((d) => [d.name, d.size])), bays: { slots: layout.slots, presentKeys },
  });
  return { status, plan, repair: repairView(status, plan) };
}

let tried = '';
async function tick() {
  let found;
  try { found = await look(); } catch { return; }
  for (const p of found.status) run('zpool', ['set', 'autoreplace=on', p.name], { timeout: 8000 }).catch(() => {});
  const job = found.plan.replace[0];
  if (!job) { tried = ''; return; }
  const key = job.pool + '\0' + job.old + '\0' + job.neu;
  if (key === tried) return;
  tried = key;
  try {
    await run('zpool', ['replace', '-f', job.pool, job.old, job.neu], { timeout: 120000 });
    console.log('Replacing ' + job.disk + ' in ' + job.pool + ' with ' + job.neu);
  } catch (e) { console.log('Replacing the disk in ' + job.pool + ' failed: ' + e.message); }
}

function startSchedule() { setInterval(() => tick().catch(() => {}), 30000); }

module.exports = { planReplace, repairView, bayLabel, look, tick, startSchedule };
