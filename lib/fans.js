'use strict';
/*
 * Cooling (Settings → Cooling): temperatures and fans from /sys/class/hwmon, and control of the fans that have a PWM
 * channel. Per channel: auto (the BIOS / the chip decides, as before MajaOS), fixed (a percentage) or curve (a
 * temperature of choice → a percentage, straight lines between the points). MajaOS applies fixed and curve every
 * 3 s. Safety: never below the channel's minimum, everything at 100% from 85 °C on any CPU sensor, and 100% when a
 * curve's temperature can't be read. When MajaOS stops (also a crash), systemd runs `node lib/fans.js --restore`
 * (ExecStopPost): every channel MajaOS controlled goes back to the mode it had before.
 *
 * DATA_DIR/fans.json: {channels: {"<id>": {name, mode: auto|fixed|curve, percent, min, source, points: [[°C, %]…], orig}},
 *   names: {"<fan or temp id>": "own name"}}
 * An id stays the same after a restart (hwmonN may change): <chip name>@<device>/<file>, e.g. nct6798@nct6775.656/pwm2.
 */
const fs = require('node:fs');
const path = require('node:path');

const HWMON = process.env.HWMON_DIR || '/sys/class/hwmon';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'fans.json');
const HOT = 85; // °C on a CPU sensor: every controlled fan at 100%
const CPU_CHIPS = /^(k10temp|coretemp|zenpower)$/;
const MODULES = ['nct6775', 'it87', 'drivetemp'];
const MODULES_FILE = process.env.FANS_MODULES_FILE || '/etc/modules-load.d/majaos-fans.conf';

const readText = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const num = (f) => { const v = readText(f); return v === '' || Number.isNaN(Number(v)) ? null : Number(v); };
const httpError = (msg, status) => { const e = new Error(msg); e.status = status; return e; };

function load() {
  try { const s = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { channels: s.channels || {}, names: s.names || {} }; } catch { return { channels: {}, names: {} }; }
}
function store(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

/* ---- reading the sensors */

// Every hwmon chip: its stable key and directory.
function chips() {
  let list = [];
  try { list = fs.readdirSync(HWMON).filter((x) => /^hwmon\d+$/.test(x)); } catch { return []; }
  return list.map((h) => {
    const dir = path.join(HWMON, h), name = readText(path.join(dir, 'name')) || h;
    let dev = '';
    try { dev = path.basename(fs.realpathSync(path.join(dir, 'device'))); } catch { /* virtual chip */ }
    return { key: `${name}@${dev || h}`, name, dir };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

// drivetemp: the disk the sensor belongs to (its SCSI device has the block device under it), e.g. sda.
function diskOf(c) {
  if (c.name !== 'drivetemp') return null;
  try { return fs.readdirSync(path.join(c.dir, 'device', 'block'))[0] || null; } catch { return null; }
}
// Everything the chips report: temperatures (°C), fans (RPM) and PWM channels (0–255, mode).
function read() {
  const temps = [], fans = [], pwms = [];
  for (const c of chips()) {
    let files = [];
    try { files = fs.readdirSync(c.dir); } catch { continue; }
    for (const f of files) {
      let m;
      if ((m = f.match(/^temp(\d+)_input$/))) {
        const v = num(path.join(c.dir, f));
        if (v == null || v <= -40000 || v >= 150000) continue; // unused inputs report nonsense
        temps.push({ id: `${c.key}/temp${m[1]}`, chip: c.name, n: Number(m[1]), label: readText(path.join(c.dir, `temp${m[1]}_label`)) || diskOf(c) || null, value: Math.round(v / 100) / 10, cpu: CPU_CHIPS.test(c.name) });
      } else if ((m = f.match(/^fan(\d+)_input$/))) {
        fans.push({ id: `${c.key}/fan${m[1]}`, chip: c.name, n: Number(m[1]), label: readText(path.join(c.dir, `fan${m[1]}_label`)) || null, rpm: num(path.join(c.dir, f)) });
      } else if ((m = f.match(/^pwm(\d+)$/))) {
        const enable = num(path.join(c.dir, `pwm${m[1]}_enable`));
        let writable = false;
        try { fs.accessSync(path.join(c.dir, f), fs.constants.W_OK); writable = true; } catch { /* read-only */ }
        pwms.push({ id: `${c.key}/pwm${m[1]}`, chip: c.name, n: Number(m[1]), file: path.join(c.dir, f), value: num(path.join(c.dir, f)), enable, writable });
      }
    }
  }
  const order = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
  return { temps: temps.sort(order), fans: fans.sort(order), pwms: pwms.sort(order) };
}

/* ---- the rules (pure, tested) */

// A curve: straight lines between the points, flat before the first and after the last.
function curvePercent(points, temp) {
  const p = [...(points || [])].filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [Number(a), Number(b)]).sort((x, y) => x[0] - y[0]);
  if (!p.length || temp == null) return 100;
  if (temp <= p[0][0]) return p[0][1];
  if (temp >= p[p.length - 1][0]) return p[p.length - 1][1];
  for (let i = 1; i < p.length; i++) {
    if (temp <= p[i][0]) { const [t0, v0] = p[i - 1], [t1, v1] = p[i]; return v0 + ((v1 - v0) * (temp - t0)) / (t1 - t0); }
  }
  return 100;
}
// What a channel should run at now (0–100), or null for auto (leave it to the chip).
function target(ch, temps) {
  if (!ch || ch.mode === 'auto' || !ch.mode) return null;
  if (temps.some((x) => x.cpu && x.value >= HOT)) return 100;
  let pct;
  if (ch.mode === 'fixed') pct = Number(ch.percent);
  else {
    const src = temps.find((x) => x.id === ch.source) || (ch.source === 'gpu' ? temps.find((x) => x.id === 'gpu') : null);
    pct = src ? curvePercent(ch.points, src.value) : 100;
  }
  return Math.round(Math.max(Number(ch.min) || 0, Math.min(100, Number.isFinite(pct) ? pct : 100)));
}
function validate(body, temps) {
  const mode = ['auto', 'fixed', 'curve'].includes(body.mode) ? body.mode : null;
  if (!mode) throw httpError('Choose Auto, Fixed or Curve.', 400);
  const min = body.min == null ? 20 : Number(body.min);
  if (!Number.isFinite(min) || min < 0 || min > 100) throw httpError('Choose a minimum between 0 and 100%.', 400);
  const out = { mode, min: Math.round(min), name: String(body.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40) || null };
  if (mode === 'fixed') {
    const p = Number(body.percent);
    if (!Number.isFinite(p) || p < 0 || p > 100) throw httpError('Choose a speed between 0 and 100%.', 400);
    out.percent = Math.round(p);
  }
  if (mode === 'curve') {
    if (!temps.some((x) => x.id === body.source)) throw httpError('Choose the temperature the fan follows.', 400);
    const points = (Array.isArray(body.points) ? body.points : []).map((x) => [Number(x[0]), Number(x[1])]);
    if (points.length < 2 || points.length > 8) throw httpError('A curve needs between 2 and 8 points.', 400);
    if (points.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || a > 110 || b < 0 || b > 100)) throw httpError('Each point needs a temperature (0–110 °C) and a speed (0–100%).', 400);
    out.source = String(body.source);
    out.points = points.sort((x, y) => x[0] - y[0]);
  }
  return out;
}

/* ---- applying */

// Temperatures plus the GPU's (from nvidia-smi, kept by lib/system.js) as a source "gpu".
async function allTemps(r) {
  const temps = [...r.temps];
  try {
    const g = await require('./system').gpuStats();
    if (g && g[0] && g[0].temp != null) temps.push({ id: 'gpu', chip: 'nvidia', n: 1, label: g[0].name, value: g[0].temp, cpu: false });
  } catch { /* no GPU */ }
  return temps;
}
const write = (file, v) => { try { fs.writeFileSync(file, String(v)); return true; } catch { return false; } };

// One round: every channel MajaOS controls gets its speed; a channel back on auto gets its original mode back.
async function tick() {
  const r = read(), temps = await allTemps(r), state = load();
  let changed = false;
  for (const p of r.pwms) {
    const ch = state.channels[p.id];
    if (!ch || !p.writable) continue;
    const pct = target(ch, temps);
    const enableFile = p.file + '_enable';
    if (pct == null) {
      if (ch.orig != null && p.enable !== ch.orig) write(enableFile, ch.orig);
      continue;
    }
    if (ch.orig == null && p.enable != null && p.enable !== 1) { ch.orig = p.enable; changed = true; }
    if (p.enable !== 1) write(enableFile, 1);
    const raw = Math.round((pct / 100) * 255);
    if (p.value == null || Math.abs(p.value - raw) > 2) write(p.file, raw);
  }
  if (changed) store(state);
}
let timer = null;
function startSchedule() { if (!timer) { tick().catch(() => {}); timer = setInterval(() => tick().catch(() => {}), 3000); } }

// Back to how it was: called by systemd when MajaOS stops (ExecStopPost), and when a channel goes back to auto.
function restore() {
  const state = load();
  for (const p of read().pwms) {
    const ch = state.channels[p.id];
    if (ch && ch.orig != null && ch.mode !== 'auto') write(p.file + '_enable', ch.orig);
  }
}

/* ---- for the API */

async function status() {
  const r = read(), temps = await allTemps(r), state = load();
  const name = (id) => state.names[id] || null;
  const fans = r.fans.map((f) => {
    const pwm = r.pwms.find((p) => p.chip === f.chip && p.n === f.n && p.id.split('/')[0] === f.id.split('/')[0]);
    const ch = pwm ? state.channels[pwm.id] || { mode: 'auto' } : null;
    return { id: f.id, chip: f.chip, label: f.label, name: name(f.id), rpm: f.rpm,
      pwm: pwm ? { id: pwm.id, percent: pwm.value == null ? null : Math.round((pwm.value / 255) * 100), writable: pwm.writable, enable: pwm.enable,
        mode: ch.mode || 'auto', fixed: ch.percent != null ? ch.percent : 50, min: ch.min != null ? ch.min : 20, source: ch.source || null, points: ch.points || null } : null };
  });
  // PWM channels without a fan reading (some boards): still controllable.
  for (const p of r.pwms) {
    if (fans.some((f) => f.pwm && f.pwm.id === p.id)) continue;
    const ch = state.channels[p.id] || { mode: 'auto' };
    fans.push({ id: p.id, chip: p.chip, label: null, name: name(p.id), rpm: null,
      pwm: { id: p.id, percent: p.value == null ? null : Math.round((p.value / 255) * 100), writable: p.writable, enable: p.enable,
        mode: ch.mode || 'auto', fixed: ch.percent != null ? ch.percent : 50, min: ch.min != null ? ch.min : 20, source: ch.source || null, points: ch.points || null } });
  }
  return {
    temps: temps.map((x) => ({ ...x, name: name(x.id) })), fans,
    controllable: fans.some((f) => f.pwm && f.pwm.writable), hot: HOT,
    modules: readText(MODULES_FILE).split('\n').filter((l) => MODULES.includes(l.trim())),
  };
}

async function save(id, body) {
  const r = read(), temps = await allTemps(r);
  const p = r.pwms.find((x) => x.id === id);
  if (!p) throw httpError('This fan can\'t be controlled (anymore). Look for sensors again.', 404);
  if (!p.writable) throw httpError('This fan can\'t be controlled: the chip doesn\'t allow it. Use the fan settings in the BIOS.', 409);
  const v = validate(body, temps);
  const state = load();
  const prev = state.channels[id] || {};
  state.channels[id] = { ...v, orig: prev.orig != null ? prev.orig : (p.enable !== 1 ? p.enable : prev.orig) };
  delete state.channels[id].name;
  if (v.name) state.names[id] = v.name;
  const fan = r.fans.find((f) => f.chip === p.chip && f.n === p.n);
  if (fan && v.name) state.names[fan.id] = v.name;
  store(state);
  await tick();
  return status();
}
function rename(id, label) {
  const state = load(), v = String(label || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
  if (v) state.names[id] = v; else delete state.names[id];
  store(state);
  return { id, name: v || null };
}

// Look for sensors: the drivers of the usual monitoring chips (and of disk temperatures), loaded now and at every start.
async function probe() {
  const { run } = require('./system');
  const loaded = [];
  for (const m of MODULES) {
    try { await run('modprobe', [m], { timeout: 15000 }); loaded.push(m); } catch { /* not this board's chip */ }
  }
  if (loaded.length) {
    const have = new Set(readText(MODULES_FILE).split('\n').map((x) => x.trim()).filter(Boolean));
    loaded.forEach((m) => have.add(m));
    try { fs.writeFileSync(MODULES_FILE, `# Written by MajaOS (Settings → Cooling): sensor drivers loaded at every start.\n${[...have].filter((x) => !x.startsWith('#')).join('\n')}\n`); } catch { /* not root */ }
  }
  const st = await status();
  return { loaded, ...st };
}

/* ---- the driver of the board's sensor chip: what is needed, said beforehand, then installed */

// sensors-detect --auto: "Found `Nuvoton NCT6798D Super IO Sensors'   Success!\n    (address 0x290, driver `nct6775')".
function parseSensorsDetect(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/Found `([^']+)'[^\n]*\n\s*\(address [^,]+, driver `([^']+)'\)/g)) {
    out.push({ chip: m[1].replace(/\s+Super IO Sensors$/i, '').trim(), driver: m[2] });
  }
  return out;
}
// Chips that aren't the board's fan controller (CPU, memory, disks…): they never decide about a fan driver.
const NOT_BOARD = /^(k10temp|coretemp|zenpower|jc42|drivetemp|nvme|amdgpu|nouveau|spd5118|ee1004|eeprom)$/;
// The kernel said the BIOS keeps the chip's ports for itself (ACPI): the driver only loads with acpi_enforce_resources=lax.
function acpiConflict(dmesg, driver) {
  return String(dmesg || '').split('\n').some((l) => /conflicts with OpRegion|resource conflict/i.test(l) && (!driver || l.includes(driver) || /ACPI Warning: SystemIO/i.test(l)));
}
const GRUB = process.env.GRUB_DEFAULT_FILE || '/etc/default/grub';
const LAX = 'acpi_enforce_resources=lax';
const laxOn = () => readText('/proc/cmdline').includes(LAX);
const laxSet = () => readText(GRUB).includes(LAX);
let diag = null; // {at, result}

// What it takes: {state: ready|loaded|unsupported|none, chip, driver, reboot: no|yes|maybe, reason}.
async function diagnose({ fresh = false } = {}) {
  if (!fresh && diag && Date.now() - diag.at < 10 * 60000) return diag.result;
  const { run } = require('./system');
  const env = { DEBIAN_FRONTEND: 'noninteractive' };
  if (!fs.existsSync('/usr/sbin/sensors-detect')) {
    try { await run('apt-get', ['install', '-y', '-q', 'lm-sensors'], { timeout: 300000, env }); }
    catch (e) { throw httpError('lm-sensors could not be installed (needed to find the sensor chip): ' + e.message, 502); }
  }
  const out = await run('sensors-detect', ['--auto'], { timeout: 120000, anyExit: true }).catch(() => '');
  const found = parseSensorsDetect(out).filter((x) => !NOT_BOARD.test(x.driver));
  const dmesg = await run('dmesg', [], { timeout: 10000 }).catch(() => '');
  let result;
  const chip = found[0];
  if (!chip) result = { state: 'none', chip: null, driver: null, reboot: 'no' };
  else if (chip.driver === 'to-be-written') result = { state: 'unsupported', chip: chip.chip, driver: null, reboot: 'no' };
  else {
    const inKernel = await run('modinfo', [chip.driver], { timeout: 10000 }).then(() => true, () => false);
    const loaded = fs.existsSync('/sys/module/' + chip.driver.replace(/-/g, '_'));
    const conflict = acpiConflict(dmesg, chip.driver);
    if (!inKernel) result = { state: 'unsupported', chip: chip.chip, driver: chip.driver, reboot: 'no' };
    // Installed earlier, the boot setting is there but not active yet: only the restart is left.
    else if (laxSet() && !laxOn()) result = { state: 'pending', chip: chip.chip, driver: chip.driver, reboot: 'yes' };
    else result = {
      state: loaded ? 'loaded' : 'ready', chip: chip.chip, driver: chip.driver,
      // Already blocked once by the BIOS: certainly a restart (unless the parameter is already set and active).
      reboot: conflict && !laxOn() ? 'yes' : loaded && !laxOn() ? 'maybe' : 'no',
    };
  }
  diag = { at: Date.now(), result };
  return result;
}

// Install: load the driver (now and at every start); if the BIOS blocks the chip, allow it at the next start.
async function installDriver() {
  const d = await diagnose({ fresh: true });
  if (d.state === 'none') throw httpError('MajaOS found no sensor chip on this motherboard. Its fans can only be set in the BIOS.', 404);
  if (d.state === 'unsupported') throw httpError(`The sensor chip ${d.chip} has no driver in this Linux version yet. Set the fans in the BIOS.`, 409);
  const { run } = require('./system');
  await run('modprobe', [d.driver], { timeout: 20000 }).catch(() => {});
  const have = new Set(readText(MODULES_FILE).split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#')));
  have.add(d.driver);
  try { fs.writeFileSync(MODULES_FILE, `# Written by MajaOS (Settings → Cooling): sensor drivers loaded at every start.\n${[...have].join('\n')}\n`); } catch { /* not root */ }
  await new Promise((r) => setTimeout(r, 1500));
  diag = null;
  if (read().fans.length) return { ok: true, reboot: false, driver: d.driver, ...(await status()) };
  const dmesg = await run('dmesg', [], { timeout: 10000 }).catch(() => '');
  if (acpiConflict(dmesg, d.driver) && !laxOn()) {
    if (!laxSet()) {
      const g = readText(GRUB);
      const next = /^GRUB_CMDLINE_LINUX_DEFAULT="/m.test(g) ? g.replace(/^GRUB_CMDLINE_LINUX_DEFAULT="([^"]*)"/m, (m0, v) => `GRUB_CMDLINE_LINUX_DEFAULT="${(v + ' ' + LAX).trim()}"`) : g + `\nGRUB_CMDLINE_LINUX_DEFAULT="${LAX}"\n`;
      fs.writeFileSync(GRUB, next);
      await run('update-grub', [], { timeout: 120000 }).catch((e) => { throw httpError('The boot settings could not be updated: ' + e.message, 502); });
    }
    try { fs.writeFileSync('/var/run/reboot-required', ''); fs.appendFileSync('/var/run/reboot-required.pkgs', d.driver + '\n'); } catch { /* not root */ }
    return { ok: true, reboot: true, driver: d.driver, ...(await status()) };
  }
  throw httpError(`The driver ${d.driver} is loaded, but the chip reports no fans. Check in the BIOS that the fan headers are on, or set the fans there.`, 409);
}

module.exports = { read, curvePercent, target, validate, tick, startSchedule, restore, status, save, rename, probe, diagnose, installDriver, parseSensorsDetect, acpiConflict, HOT };

if (require.main === module && process.argv.includes('--restore')) restore();
