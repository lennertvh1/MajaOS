'use strict';
/* Spinning down hard disks that aren't used (Settings → Storage → Disk sleep).
 *
 * Every minute MajaOS reads /proc/diskstats. A hard disk whose read and write counters didn't change for its time
 * gets `hdparm -y` (standby now); the next read or write spins it up again by itself. Commands that only ask the disk
 * something (hdparm -C, smartctl, drivetemp) go to the disk as passthrough requests, which the kernel doesn't count in
 * diskstats, so they never keep a disk awake here. The disk's own timer (hdparm -S) isn't used: many disks ignore it or
 * understand it differently, and it is lost at every power cycle.
 *
 * Settings in DATA_DIR/spindown.json: {minutes: default for every hard disk (0 = never), disks: {"<key>": minutes}},
 * key = s:<serial> or n:<name>, like the drive bays, so it stays right when sda and sdb swap. */
const fs = require('node:fs');
const path = require('node:path');
const { run, httpError } = require('./system');
const bays = require('./bays');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'spindown.json');
const STATS = process.env.DISKSTATS || '/proc/diskstats';
const CHOICES = [0, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360];
const keyOf = (d) => (d.serial ? 's:' + String(d.serial).trim() : 'n:' + d.name);

function read() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { minutes: Number(j.minutes) || 0, disks: j.disks && typeof j.disks === 'object' ? j.disks : {} }; }
  catch { return { minutes: 0, disks: {} }; }
}
function write(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

// /proc/diskstats → {name: reads + writes completed} (fields 4 and 8; discards and flushes don't spin a disk up).
function parseDiskstats(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    out[f[2]] = Number(f[3]) + Number(f[7]);
  }
  return out;
}
// hdparm -C: "drive state is:  standby" / "active/idle" / "unknown".
function parsePowerMode(text) {
  const m = String(text || '').match(/drive state is:\s*(\S+)/);
  if (!m) return 'unknown';
  return /standby|sleeping/.test(m[1]) ? 'standby' : /active|idle/.test(m[1]) ? 'active' : 'unknown';
}
// The time for one disk: its own setting, else the default.
function minutesFor(cfg, key) {
  const own = cfg.disks[key];
  return own == null ? cfg.minutes : Number(own) || 0;
}

/* ---- the watch (in memory: per disk name) */
const seen = new Map(); // name → {count, since (last I/O), asleep (we sent it to standby and no I/O since), error}
let disks = [];          // the hard disks from the last lsblk
let available = null;    // hdparm installed

async function listHdds() {
  const raw = await run('lsblk', ['-J', '-b', '-d', '-o', 'NAME,SIZE,ROTA,TRAN,MODEL,SERIAL,TYPE'], { timeout: 10000 })
    .then((j) => require('./storage').parseLsblk(j), () => []);
  return raw.map(bays.withSerial).filter((d) => d.rotational && /^sd[a-z]+$/.test(d.name));
}

// One look: what was used since the last time. Returns the disks that should go to sleep now.
function observe(counts, list, cfg, now = Date.now()) {
  const due = [];
  for (const d of list) {
    const c = counts[d.name];
    if (c == null) continue;
    const s = seen.get(d.name);
    if (!s || s.key !== keyOf(d)) { seen.set(d.name, { key: keyOf(d), count: c, since: now, asleep: false, error: null }); continue; }
    if (c !== s.count) { s.count = c; s.since = now; s.asleep = false; }
    const min = minutesFor(cfg, keyOf(d));
    if (min > 0 && !s.asleep && now - s.since >= min * 60000) due.push(d);
  }
  for (const name of [...seen.keys()]) if (!list.some((d) => d.name === name)) seen.delete(name);
  return due;
}

async function tick() {
  const cfg = read();
  disks = await listHdds();
  let counts;
  try { counts = parseDiskstats(fs.readFileSync(STATS, 'utf8')); } catch { return; }
  const due = observe(counts, disks, cfg);
  for (const d of due) {
    const s = seen.get(d.name);
    try {
      await run('hdparm', ['-y', '/dev/' + d.name], { timeout: 30000 });
      s.asleep = true; s.at = Date.now(); s.error = null; available = true;
      console.log(`Disk ${d.name} (${d.model || d.serial || '?'}) went to sleep after ${minutesFor(cfg, keyOf(d))} minutes without use.`);
    } catch (e) {
      if (/not installed/.test(e.message)) available = false;
      s.error = e.message; s.since = Date.now(); // try again after another full period, not every minute
    }
  }
}

// Is this disk asleep because of us (and not used since)? The fan control then doesn't read its temperature.
function asleep(name) { const s = seen.get(name); return !!(s && s.asleep); }

function start() {
  tick().catch(() => {});
  setInterval(() => tick().catch(() => {}), 60000).unref();
}

async function status() {
  const cfg = read();
  if (!disks.length) disks = await listHdds();
  if (available == null) available = await run('hdparm', ['-V'], { timeout: 5000 }).then(() => true, () => false);
  const now = Date.now();
  const list = await Promise.all(disks.map(async (d) => {
    const s = seen.get(d.name);
    // hdparm -C asks the disk its power mode without waking it.
    const state = available ? await run('hdparm', ['-C', '/dev/' + d.name], { timeout: 8000 }).then(parsePowerMode, () => 'unknown') : 'unknown';
    return { key: keyOf(d), name: d.name, model: d.model, serial: d.serial, size: d.size, transport: d.transport,
      minutes: cfg.disks[keyOf(d)] == null ? null : Number(cfg.disks[keyOf(d)]) || 0, effective: minutesFor(cfg, keyOf(d)),
      state, idle: s ? Math.round((now - s.since) / 1000) : null, sleptAt: s && s.asleep ? s.at || null : null, error: s ? s.error : null };
  }));
  return { available, minutes: cfg.minutes, choices: CHOICES, disks: list };
}

async function save(body) {
  const cfg = read();
  const ok = (v) => CHOICES.includes(Number(v));
  if (body.minutes != null) {
    if (!ok(body.minutes)) throw httpError('Choose one of the times in the list.', 400);
    cfg.minutes = Number(body.minutes);
  }
  if (body.disks && typeof body.disks === 'object') {
    for (const [key, v] of Object.entries(body.disks)) {
      if (!/^[sn]:[^\s/]{1,80}$/.test(key)) throw httpError('Unknown disk.', 400);
      if (v == null || v === '') delete cfg.disks[key];
      else if (ok(v)) cfg.disks[key] = Number(v);
      else throw httpError('Choose one of the times in the list.', 400);
    }
  }
  write(cfg);
  return status();
}

// Spin one disk down right now (the button in the list).
async function sleepNow(name) {
  if (!disks.length) disks = await listHdds();
  const d = disks.find((x) => x.name === name);
  if (!d) throw httpError('This disk is not a hard disk MajaOS knows.', 404);
  await run('hdparm', ['-y', '/dev/' + d.name], { timeout: 30000 });
  const s = seen.get(d.name);
  if (s) { s.asleep = true; s.at = Date.now(); s.error = null; }
  return { name: d.name, state: 'standby' };
}

module.exports = { start, tick, status, save, sleepNow, asleep, observe, parseDiskstats, parsePowerMode, minutesFor, CHOICES, _seen: seen };
