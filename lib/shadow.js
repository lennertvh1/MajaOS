'use strict';
/*
 * Previous versions of files on the shared folders.
 * Windows shows them in Properties → Previous Versions. Samba's shadow_copy2 reads ZFS snapshots
 * from .zfs/snapshot, so the snapshot name must be GMT-YYYY.MM.DD-HH.MM.SS (UTC).
 * Once an hour, for each dataset that has a shared folder: one snapshot.
 * Kept: 24 hours, then one per day for 14 days, then one per week for 8 weeks. Older ones go.
 */
const path = require('node:path');
const { run } = require('./system');

const HOUR = 3600000, DAY = 86400000;
const KEEP = { hourly: 24, daily: 14, weekly: 8 };
const SNAP = /^GMT-(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})$/;

function snapName(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `GMT-${date.getUTCFullYear()}.${p(date.getUTCMonth() + 1)}.${p(date.getUTCDate())}-${p(date.getUTCHours())}.${p(date.getUTCMinutes())}.${p(date.getUTCSeconds())}`;
}

function snapTime(name) {
  const m = SNAP.exec(String(name));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// Where Samba looks, relative to the shared folder. The longest dataset mount that contains the folder wins.
function snapdir(sharePath, mounts) {
  const dir = path.posix.normalize(String(sharePath || '').replace(/\\/g, '/'));
  const hit = (mounts || [])
    .filter((m) => m.mountpoint && (dir === m.mountpoint || dir.startsWith(m.mountpoint.replace(/\/$/, '') + '/')))
    .sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0];
  if (!hit) return null;
  const rel = path.posix.relative(dir, hit.mountpoint.replace(/\/$/, ''));
  return (rel ? rel + '/' : '') + '.zfs/snapshot';
}

// Datasets that actually hold a shared folder (the deepest mount under that folder).
function datasetsFor(shares, mounts) {
  const out = new Map();
  for (const share of shares || []) {
    const dir = path.posix.normalize(String(share.path || '').replace(/\\/g, '/'));
    const hit = (mounts || [])
      .filter((m) => m.name && m.mountpoint && (dir === m.mountpoint || dir.startsWith(m.mountpoint.replace(/\/$/, '') + '/')))
      .sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0];
    if (hit) out.set(hit.name, hit.mountpoint);
  }
  return [...out.keys()];
}

// True when this clock hour has no snapshot yet.
function due(snaps, now) {
  const hour = Math.floor(now.getTime() / HOUR);
  return !snaps.some((s) => s.time != null && Math.floor(s.time / HOUR) === hour);
}

// Names to keep. snaps: [{ name, time }]. Anything else with a GMT name can be removed.
function keepNames(snaps, now, policy = KEEP) {
  const sorted = [...snaps].filter((s) => s.time != null && s.time <= now.getTime()).sort((a, b) => b.time - a.time);
  const kept = new Set();
  const take = (span, count, maxAge) => {
    const seen = new Set();
    for (const s of sorted) {
      if (now.getTime() - s.time > maxAge) continue;
      const b = Math.floor(s.time / span);
      if (seen.has(b)) continue;
      if (seen.size >= count) break;
      seen.add(b);
      kept.add(s.name);
    }
  };
  take(HOUR, policy.hourly, policy.hourly * HOUR);
  take(DAY, policy.daily, policy.daily * DAY);
  take(7 * DAY, policy.weekly, policy.weekly * 7 * DAY);
  return kept;
}

function parseSnapList(text, dataset) {
  const prefix = dataset + '@';
  return text.split('\n').map((l) => l.split('\t')).filter(([n]) => n && n.startsWith(prefix)).map(([n, created]) => {
    const name = n.slice(prefix.length);
    return { name, time: snapTime(name) || (Number(created) ? Number(created) * 1000 : null) };
  }).filter((s) => s.time != null && SNAP.test(s.name));
}

async function tick(now = new Date()) {
  const shares = require('./shares').shareRecords();
  if (!shares.length) return { created: 0, removed: 0 };
  const mounts = (await run('zfs', ['list', '-H', '-o', 'name,mountpoint', '-t', 'filesystem'], { timeout: 8000 }).catch(() => ''))
    .split('\n').map((l) => l.split('\t')).filter(([n, m]) => n && m && m.startsWith('/')).map(([name, mountpoint]) => ({ name, mountpoint }));
  const sets = datasetsFor(shares, mounts);
  let created = 0, removed = 0;
  for (const dataset of sets) {
    const text = await run('zfs', ['list', '-Hp', '-t', 'snapshot', '-o', 'name,creation', dataset], { timeout: 20000 }).catch(() => '');
    const snaps = parseSnapList(text, dataset);
    if (due(snaps, now)) {
      const name = snapName(now);
      try {
        await run('zfs', ['snapshot', dataset + '@' + name], { timeout: 60000 });
        snaps.push({ name, time: now.getTime() });
        created++;
      } catch (e) { console.log('Snapshot of ' + dataset + ' failed: ' + e.message); }
    }
    const keep = keepNames(snaps, now);
    for (const s of snaps) {
      if (keep.has(s.name)) continue;
      try { await run('zfs', ['destroy', dataset + '@' + s.name], { timeout: 60000 }); removed++; }
      catch (e) { console.log('Removing snapshot ' + s.name + ' failed: ' + e.message); }
    }
  }
  return { created, removed };
}

function startSchedule() {
  setTimeout(() => tick().catch((e) => console.log('Previous versions: ' + e.message)), 20000);
  setInterval(() => tick().catch((e) => console.log('Previous versions: ' + e.message)), 60000);
}

module.exports = { snapName, snapTime, snapdir, datasetsFor, due, keepNames, parseSnapList, tick, startSchedule, KEEP };
