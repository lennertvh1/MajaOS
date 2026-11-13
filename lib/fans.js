'use strict';
/*
 * Cooling (Settings → Cooling): temperatures and fans from /sys/class/hwmon, and control of the fans that have a PWM
 * channel. Per channel: auto (the BIOS / the chip decides, as before MajaOS), fixed (a percentage) or curve (a
 * temperature of choice → a percentage, straight lines between the points). MajaOS applies fixed and curve every
 * 3 s. Safety: never below the channel's minimum, everything at 100% from 85 °C on any CPU sensor, and 100% when a
 * curve's temperature can't be read. When MajaOS stops (also a crash), systemd runs `node lib/fans.js --restore`
 * (ExecStopPost): every channel MajaOS controlled goes back to the mode it had before.
 *
 * Like the FanControl app on Windows: a curve can follow several temperatures (the highest counts), has a hysteresis
 * (it only slows down once the temperature dropped that much) and a step speed (how fast it may speed up or slow down).
 * *Detect fans* finds out which fan each channel drives (pairing) and measures where the fan stops and starts again.
 *
 * DATA_DIR/fans.json: {channels: {"<id>": {name, mode: auto|fixed|curve, percent, min, sources: [temp ids], points: [[°C, %]…],
 *   hyst, stepUp, stepDown, orig, fan, calib: {stop, start, maxRpm, at}}}, names: {"<fan or temp id>": "own name"}, testing: {"<pwm id>": enable}}
 *
 * Drivers: the board's sensor chip needs a kernel driver. nct6775 (Nuvoton), it87 (ITE, with ignore_resource_conflict
 * when the BIOS claims the chip: no restart needed), f71882fg (Fintek). Chips the kernel can't control yet get a driver
 * from the community, built for this kernel with DKMS (COMMUNITY: it87 by frankcrawford for newer ITE chips on Gigabyte
 * boards, nct6687d for NCT6683/6686/6687 on MSI boards), pinned to a commit.
 * An id stays the same after a restart (hwmonN may change): <chip name>@<device>/<file>, e.g. nct6798@nct6775.656/pwm2.
 */
const fs = require('node:fs');
const path = require('node:path');

const HWMON = process.env.HWMON_DIR || '/sys/class/hwmon';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'fans.json');
const HOT = 85; // °C on a CPU sensor: every controlled fan at 100%
const CPU_CHIPS = /^(k10temp|coretemp|zenpower)$/;
const MODULES = ['nct6775', 'it87', 'f71882fg', 'asus_ec_sensors', 'drivetemp'];
const MODULES_FILE = process.env.FANS_MODULES_FILE || '/etc/modules-load.d/majaos-fans.conf';
const OPTIONS_FILE = process.env.FANS_OPTIONS_FILE || '/etc/modprobe.d/majaos-fans.conf';
// Drivers from the community for chips the kernel can't control. Pinned: MajaOS builds exactly this commit.
const COMMUNITY = {
  it87: { repo: 'frankcrawford/it87', commit: 'bd7a566c8a60fe0308d67e26761e16260368191a', package: 'it87', module: 'it87',
    options: 'ignore_resource_conflict=1', blacklist: [], match: /\bIT8\d{3}|\bITE\b/i },
  nct6687: { repo: 'Fred78290/nct6687d', commit: 'ec1030ba7acc32b36723af0c7c9c9aead5e57b54', package: 'nct6687d', module: 'nct6687',
    options: '', blacklist: ['nct6683'], match: /NCT668[3-8]/i },
};
// Options a kernel driver needs to take a chip the BIOS (ACPI) claims, without a restart.
const KERNEL_OPTIONS = { it87: 'ignore_resource_conflict=1' };

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
const sourcesOf = (ch) => (Array.isArray(ch.sources) && ch.sources.length ? ch.sources : ch.source ? [ch.source] : []);
// The temperature a curve follows: the highest of its sources; null when one of them can't be read (then: full speed).
function sourceTemp(ch, temps) {
  const ids = sourcesOf(ch);
  if (!ids.length) return null;
  const vals = ids.map((id) => temps.find((x) => x.id === id)).map((x) => (x ? x.value : null));
  return vals.some((v) => v == null) ? null : Math.max(...vals);
}
// What a channel should run at now (0–100), or null for auto (leave it to the chip).
function target(ch, temps) {
  if (!ch || ch.mode === 'auto' || !ch.mode) return null;
  if (temps.some((x) => x.cpu && x.value >= HOT)) return 100;
  let pct;
  if (ch.mode === 'fixed') pct = Number(ch.percent);
  else {
    const temp = sourceTemp(ch, temps);
    pct = temp == null ? 100 : curvePercent(ch.points, temp);
  }
  return Math.round(Math.max(Number(ch.min) || 0, Math.min(100, Number.isFinite(pct) ? pct : 100)));
}
// The next speed, with hysteresis and step speed (prev = {pct, temp} of the last round, secs since then).
// Safety (hot CPU, a source that can't be read) always goes straight to 100%.
function nextPercent(ch, temps, prev, secs = 3) {
  const want = target(ch, temps);
  if (want == null) return { pct: null, temp: null };
  const temp = ch.mode === 'curve' ? sourceTemp(ch, temps) : null;
  const emergency = want === 100 && (temps.some((x) => x.cpu && x.value >= HOT) || (ch.mode === 'curve' && temp == null));
  if (emergency || !prev || prev.pct == null) return { pct: want, temp };
  let pct = want;
  // Hysteresis: slow down only once the temperature is hyst °C below the one the current speed was set at.
  const hyst = Number(ch.hyst) || 0;
  if (ch.mode === 'curve' && want < prev.pct && hyst > 0 && prev.temp != null && temp != null && temp > prev.temp - hyst) return { pct: prev.pct, temp: prev.temp };
  const up = Number(ch.stepUp) || 0, down = Number(ch.stepDown) || 0;
  if (pct > prev.pct && up > 0) pct = Math.min(pct, prev.pct + up * secs);
  if (pct < prev.pct && down > 0) pct = Math.max(pct, prev.pct - down * secs);
  pct = Math.round(pct);
  // A stopped fan needs its start speed for a moment to spin up again (measured by Detect fans).
  const c = ch.calib;
  if (c && c.start != null && pct > 0 && pct < c.start && prev.pct <= (c.stop != null ? c.stop : 0)) pct = c.start;
  return { pct, temp: pct === prev.pct ? prev.temp : temp };
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
    const sources = [...new Set((Array.isArray(body.sources) && body.sources.length ? body.sources : [body.source]).filter(Boolean).map(String))];
    if (!sources.length || sources.some((id) => !temps.some((x) => x.id === id))) throw httpError('Choose the temperature the fan follows.', 400);
    if (sources.length > 4) throw httpError('A fan can follow at most 4 temperatures.', 400);
    const points = (Array.isArray(body.points) ? body.points : []).map((x) => [Number(x[0]), Number(x[1])]);
    if (points.length < 2 || points.length > 8) throw httpError('A curve needs between 2 and 8 points.', 400);
    if (points.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || a > 110 || b < 0 || b > 100)) throw httpError('Each point needs a temperature (0–110 °C) and a speed (0–100%).', 400);
    out.sources = sources;
    out.source = sources[0];
    out.points = points.sort((x, y) => x[0] - y[0]);
    const hyst = body.hyst == null || body.hyst === '' ? 2 : Number(body.hyst);
    if (!Number.isFinite(hyst) || hyst < 0 || hyst > 15) throw httpError('Choose a hysteresis between 0 and 15 °C.', 400);
    out.hyst = hyst;
  }
  for (const k of ['stepUp', 'stepDown']) {
    const v = body[k] == null || body[k] === '' ? 0 : Number(body[k]);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw httpError('Choose a step speed between 0 and 100% per second (0 = right away).', 400);
    out[k] = v;
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

const live = {}; // per channel: the last {pct, temp, at} (hysteresis and step speed)
// One round: every channel MajaOS controls gets its speed; a channel back on auto gets its original mode back.
async function tick() {
  if (job && job.state === 'running') return; // Detect fans drives the channels itself
  const r = read(), temps = await allTemps(r), state = load();
  let changed = false;
  for (const p of r.pwms) {
    const ch = state.channels[p.id];
    if (!ch || !p.writable) continue;
    const prev = live[p.id], now = Date.now();
    const { pct, temp } = nextPercent(ch, temps, prev, prev ? Math.min(10, (now - prev.at) / 1000) : 3);
    live[p.id] = pct == null ? undefined : { pct, temp, at: now };
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
// Also the channels Detect fans was testing when MajaOS stopped.
function restore() {
  const state = load();
  for (const p of read().pwms) {
    const ch = state.channels[p.id];
    const testing = state.testing && state.testing[p.id];
    if (testing != null) write(p.file + '_enable', testing);
    else if (ch && ch.orig != null && ch.mode !== 'auto') write(p.file + '_enable', ch.orig);
  }
  if (state.testing) { delete state.testing; try { store(state); } catch { /* read-only */ } }
}

/* ---- for the API */

async function status() {
  const r = read(), temps = await allTemps(r), state = load();
  const name = (id) => state.names[id] || null;
  const pwmView = (pwm, ch) => ({ id: pwm.id, percent: pwm.value == null ? null : Math.round((pwm.value / 255) * 100), writable: pwm.writable, enable: pwm.enable,
    mode: ch.mode || 'auto', fixed: ch.percent != null ? ch.percent : 50, min: ch.min != null ? ch.min : (ch.calib && ch.calib.start != null ? Math.min(100, ch.calib.start + 5) : 20),
    source: sourcesOf(ch)[0] || null, sources: sourcesOf(ch), points: ch.points || null, hyst: ch.hyst != null ? ch.hyst : 2,
    stepUp: ch.stepUp || 0, stepDown: ch.stepDown || 0, calib: ch.calib || null, paired: !!ch.fan });
  // Which channel drives which fan: what Detect fans found, else the usual fanN ↔ pwmN of the same chip.
  const pairedTo = new Map(Object.entries(state.channels).filter(([, ch]) => ch.fan).map(([id, ch]) => [ch.fan, id]));
  const fans = r.fans.map((f) => {
    const pid = pairedTo.get(f.id);
    const pwm = pid ? r.pwms.find((p) => p.id === pid) : r.pwms.find((p) => p.chip === f.chip && p.n === f.n && p.id.split('/')[0] === f.id.split('/')[0]
      && !(state.channels[p.id] && state.channels[p.id].fan && state.channels[p.id].fan !== f.id));
    const ch = pwm ? state.channels[pwm.id] || { mode: 'auto' } : null;
    return { id: f.id, chip: f.chip, label: f.label, name: name(f.id), rpm: f.rpm, pwm: pwm ? pwmView(pwm, ch) : null };
  });
  // PWM channels without a fan reading (some boards): still controllable.
  for (const p of r.pwms) {
    if (fans.some((f) => f.pwm && f.pwm.id === p.id)) continue;
    fans.push({ id: p.id, chip: p.chip, label: null, name: name(p.id), rpm: null, pwm: pwmView(p, state.channels[p.id] || { mode: 'auto' }) });
  }
  return {
    temps: temps.map((x) => ({ ...x, name: name(x.id) })), fans,
    controllable: fans.some((f) => f.pwm && f.pwm.writable), hot: HOT,
    modules: readText(MODULES_FILE).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
    detect: job ? jobView() : null,
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
  state.channels[id] = { ...v, orig: prev.orig != null ? prev.orig : (p.enable !== 1 ? p.enable : prev.orig),
    ...(prev.fan ? { fan: prev.fan } : {}), ...(prev.calib ? { calib: prev.calib } : {}) };
  delete live[id];
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

// /etc/modprobe.d/majaos-fans.conf: the lines of one driver replaced, the rest kept.
function buildOptions(text, { module, options = '', blacklist = [] }) {
  const mine = (l) => new RegExp('^\\s*options\\s+' + module + '\\s').test(l) || blacklist.some((b) => new RegExp('^\\s*blacklist\\s+' + b + '\\s*$').test(l));
  const lines = String(text || '').split('\n').filter((l) => l.trim() && !mine(l) && !/^# Written by MajaOS/.test(l));
  if (options) lines.push(`options ${module} ${options}`);
  for (const b of blacklist) lines.push(`blacklist ${b}`);
  return `# Written by MajaOS (Settings → Cooling): options of the sensor drivers.\n${lines.join('\n')}\n`;
}
function addModule(name) {
  const have = new Set(readText(MODULES_FILE).split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#')));
  have.add(name);
  try { fs.writeFileSync(MODULES_FILE, `# Written by MajaOS (Settings → Cooling): sensor drivers loaded at every start.\n${[...have].join('\n')}\n`); } catch { /* not root */ }
}
function setOptions(o) { try { fs.writeFileSync(OPTIONS_FILE, buildOptions(readText(OPTIONS_FILE), o)); } catch { /* not root */ } }
const communityFor = (chip) => Object.entries(COMMUNITY).find(([, c]) => c.match.test(chip || '')) || null;
// The kernel's nct6683 only reads: no fan control.
const READ_ONLY = new Set(['nct6683']);

// What it takes: {state: ready|loaded|pending|community|unsupported|none, chip, driver, reboot: no|yes|maybe, community, secureBoot}.
// community = {id, repo, commit, installed}: a driver from the community can control this chip (offered, never installed by itself).
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
  const dkms = await run('dkms', ['status'], { timeout: 15000 }).catch(() => '');
  const chip = found[0];
  const comm = chip ? communityFor(chip.chip) : null;
  const community = comm ? { id: comm[0], repo: comm[1].repo, commit: comm[1].commit.slice(0, 7),
    installed: new RegExp('^' + comm[1].package + '/[^\\n]*installed', 'm').test(dkms) } : null;
  const secureBoot = (() => { try { return require('./debian').secureBootOn(); } catch { return false; } })();
  const controllable = read().pwms.some((x) => x.writable);
  let result;
  if (!chip) result = { state: 'none', chip: null, driver: null, reboot: 'no' };
  else {
    const inKernel = chip.driver !== 'to-be-written' && await run('modinfo', [chip.driver], { timeout: 10000 }).then(() => true, () => false);
    const loaded = inKernel && fs.existsSync('/sys/module/' + chip.driver.replace(/-/g, '_'));
    const conflict = acpiConflict(dmesg, chip.driver);
    if (!inKernel || READ_ONLY.has(chip.driver) || (loaded && !controllable && comm)) {
      result = { state: comm ? 'community' : 'unsupported', chip: chip.chip, driver: comm ? comm[1].module : chip.driver, reboot: 'no' };
    }
    // Installed earlier, the boot setting is there but not active yet: only the restart is left.
    else if (laxSet() && !laxOn() && !KERNEL_OPTIONS[chip.driver]) result = { state: 'pending', chip: chip.chip, driver: chip.driver, reboot: 'yes' };
    else result = {
      state: loaded ? 'loaded' : 'ready', chip: chip.chip, driver: chip.driver,
      // A driver with its own option (it87) takes the chip without a restart; others need acpi_enforce_resources=lax.
      reboot: KERNEL_OPTIONS[chip.driver] ? 'no' : conflict && !laxOn() ? 'yes' : loaded && !laxOn() ? 'maybe' : 'no',
    };
  }
  result.community = community;
  result.secureBoot = secureBoot;
  diag = { at: Date.now(), result };
  return result;
}

// Install: load the driver (now and at every start); if the BIOS blocks the chip, allow it (driver option, or at the next start).
// With {community: true}: build the community driver for this kernel first.
async function installDriver(body = {}) {
  const d = await diagnose({ fresh: true });
  if (d.state === 'none') throw httpError('MajaOS found no sensor chip on this motherboard. Its fans can only be set in the BIOS.', 404);
  if (body.community || d.state === 'community') {
    if (!d.community) throw httpError(`The sensor chip ${d.chip} has no driver in this Linux version yet. Set the fans in the BIOS.`, 409);
    return installCommunity(d.community.id);
  }
  if (d.state === 'unsupported') throw httpError(`The sensor chip ${d.chip} has no driver in this Linux version yet. Set the fans in the BIOS.`, 409);
  const { run } = require('./system');
  if (KERNEL_OPTIONS[d.driver]) {
    setOptions({ module: d.driver, options: KERNEL_OPTIONS[d.driver] });
    await run('modprobe', ['-r', d.driver], { timeout: 20000 }).catch(() => {});
  }
  await run('modprobe', [d.driver], { timeout: 20000 }).catch(() => {});
  addModule(d.driver);
  await new Promise((r) => setTimeout(r, 1500));
  diag = null;
  if (read().fans.length) return { ok: true, reboot: false, driver: d.driver, ...(await status()) };
  const dmesg = await run('dmesg', [], { timeout: 10000 }).catch(() => '');
  if (!KERNEL_OPTIONS[d.driver] && acpiConflict(dmesg, d.driver) && !laxOn()) {
    if (!laxSet()) {
      const g = readText(GRUB);
      const next = /^GRUB_CMDLINE_LINUX_DEFAULT="/m.test(g) ? g.replace(/^GRUB_CMDLINE_LINUX_DEFAULT="([^"]*)"/m, (m0, v) => `GRUB_CMDLINE_LINUX_DEFAULT="${(v + ' ' + LAX).trim()}"`) : g + `\nGRUB_CMDLINE_LINUX_DEFAULT="${LAX}"\n`;
      fs.writeFileSync(GRUB, next);
      await run('update-grub', [], { timeout: 120000 }).catch((e) => { throw httpError('The boot settings could not be updated: ' + e.message, 502); });
    }
    try { fs.writeFileSync('/var/run/reboot-required', ''); fs.appendFileSync('/var/run/reboot-required.pkgs', d.driver + '\n'); } catch { /* not root */ }
    return { ok: true, reboot: true, driver: d.driver, ...(await status()) };
  }
  if (d.community) throw httpError(`The driver ${d.driver} is loaded, but it doesn't control the fans of ${d.chip}. Try the driver from the community.`, 409);
  throw httpError(`The driver ${d.driver} is loaded, but the chip reports no fans. Check in the BIOS that the fan headers are on, or set the fans there.`, 409);
}

// Download a commit of a GitHub repository as a tarball (codeload answers directly).
function download(url, dest) {
  const https = require('node:https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'MajaOS' }, timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('Download failed: HTTP ' + res.statusCode)); return; }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Download timed out.')));
    req.on('error', reject);
  });
}

// A driver from the community: build exactly the pinned commit with DKMS (rebuilt by itself after a kernel update).
async function installCommunity(id) {
  const c = COMMUNITY[id];
  if (!c) throw httpError('Unknown driver.', 400);
  const { run } = require('./system');
  let sb = false;
  try { sb = require('./debian').secureBootOn(); } catch { /* not EFI */ }
  if (sb) throw httpError('Secure Boot is on: a driver built on this server would not load. Turn Secure Boot off in the BIOS, then try again.', 409);
  const kernel = require('node:os').release();
  const env = { DEBIAN_FRONTEND: 'noninteractive' };
  try { await run('apt-get', ['install', '-y', '-q', 'dkms', 'build-essential', 'linux-headers-' + kernel], { timeout: 15 * 60000, env }); }
  catch (e) { throw httpError('The build tools could not be installed: ' + e.message, 502); }
  const version = 'git' + c.commit.slice(0, 7);
  const work = path.join(DATA_DIR, 'fan-drivers');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const tar = path.join(work, c.package + '.tar.gz');
  try { await download(`https://codeload.github.com/${c.repo}/tar.gz/${c.commit}`, tar); }
  catch (e) { throw httpError('The driver could not be downloaded from GitHub: ' + e.message, 502); }
  await run('tar', ['-xzf', tar, '-C', work], { timeout: 60000 });
  const srcDir = fs.readdirSync(work).map((x) => path.join(work, x)).find((x) => fs.statSync(x).isDirectory());
  if (!srcDir || !fs.existsSync(path.join(srcDir, 'dkms.conf'))) throw httpError('The download does not look like the driver (no dkms.conf).', 502);
  // Older versions of this driver go first.
  const status = await run('dkms', ['status', c.package], { timeout: 15000 }).catch(() => '');
  for (const old of new Set([...String(status).matchAll(new RegExp('^' + c.package + '/([^,:\\s]+)', 'gm'))].map((m) => m[1]))) {
    if (old !== version) await run('dkms', ['remove', '-m', c.package, '-v', old, '--all'], { timeout: 120000 }).catch(() => {});
  }
  const dest = path.join('/usr/src', c.package + '-' + version);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(srcDir, dest, { recursive: true });
  const conf = path.join(dest, 'dkms.conf');
  fs.writeFileSync(conf, fs.readFileSync(conf, 'utf8').replace(/^PACKAGE_VERSION=.*$/m, `PACKAGE_VERSION="${version}"`));
  fs.writeFileSync(path.join(dest, 'VERSION'), version + '\n');
  await run('dkms', ['add', '-m', c.package, '-v', version], { timeout: 60000 }).catch((e) => { if (!/already/i.test(e.message)) throw e; });
  try { await run('dkms', ['install', '-m', c.package, '-v', version, '-k', kernel, '--force'], { timeout: 15 * 60000 }); }
  catch (e) { throw httpError('The driver could not be built for this kernel: ' + e.message, 502); }
  setOptions({ module: c.module, options: c.options, blacklist: c.blacklist });
  addModule(c.module);
  for (const m of [...c.blacklist, c.module]) await run('modprobe', ['-r', m], { timeout: 20000 }).catch(() => {});
  try { await run('modprobe', [c.module], { timeout: 20000 }); }
  catch (e) { throw httpError('The driver was built, but it does not load: ' + e.message, 502); }
  fs.rmSync(work, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 1500));
  diag = null;
  return { ok: true, reboot: false, driver: c.module, community: true, ...(await status()) };
}

/* ---- Detect fans: which channel drives which fan, and where each fan stops and starts again */

let job = null; // {state: running|done|failed, step, percent, results: [{pwm, fan, calib}], error}
const jobView = () => ({ state: job.state, step: job.step, percent: Math.round(job.percent), results: job.results, error: job.error });
function progress() { return job ? jobView() : { state: 'idle' }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT = Number(process.env.FANS_WAIT_MS) || 1000; // one "second" of waiting (tests make it short)

// The fan whose speed fell clearly when the channel went from 100% to 0%: that channel drives it.
function pairFan(full, low) {
  let best = null;
  for (const [id, rpm] of Object.entries(full)) {
    const after = low[id] == null ? rpm : low[id];
    const drop = rpm - after;
    if (rpm >= 300 && drop >= 200 && drop / rpm >= 0.35 && (!best || drop > best.drop)) best = { id, drop };
  }
  return best ? best.id : null;
}

function detect() {
  if (job && job.state === 'running') throw httpError('Fans are already being detected.', 409);
  const pwms = read().pwms.filter((p) => p.writable);
  if (!pwms.length) throw httpError('No fan can be controlled yet. Install the driver of the sensor chip first.', 409);
  job = { state: 'running', step: 'Starting', percent: 0, results: [], error: null };
  detectRun(pwms).then(() => { job.state = 'done'; job.step = 'Done'; job.percent = 100; },
    (e) => { job.state = 'failed'; job.error = e.message || String(e); });
  return jobView();
}

async function detectRun(pwms) {
  const state = load();
  state.testing = Object.fromEntries(pwms.map((p) => [p.id, p.enable != null ? p.enable : 1]));
  store(state); // restore() puts these back if MajaOS stops in the middle
  const origVal = Object.fromEntries(pwms.map((p) => [p.id, p.value]));
  const rpms = () => Object.fromEntries(read().fans.map((f) => [f.id, f.rpm || 0]));
  const set = (p, pct) => { write(p.file + '_enable', 1); write(p.file, Math.round((pct / 100) * 255)); };
  const safe = async (secs) => {
    for (let i = 0; i < secs; i++) {
      await sleep(WAIT);
      const temps = await allTemps(read());
      if (temps.some((x) => x.cpu && x.value >= 80)) throw new Error('Stopped: the processor reached 80 °C. Try again when the server is less busy.');
    }
  };
  const back = (p) => { if (origVal[p.id] != null) write(p.file, origVal[p.id]); write(p.file + '_enable', state.testing[p.id]); };
  const share = 100 / pwms.length;
  try {
    for (const [i, p] of pwms.entries()) {
      const base = i * share;
      job.step = `Testing channel ${i + 1} of ${pwms.length}`;
      // The others stay at 100% meanwhile, so only this channel changes something.
      for (const o of pwms) set(o, 100);
      await safe(6);
      const full = rpms();
      job.percent = base + share * 0.2;
      set(p, 0);
      await safe(8);
      const low = rpms();
      job.percent = base + share * 0.45;
      const fan = pairFan(full, low);
      let calib = null;
      if (fan) {
        calib = { maxRpm: full[fan], stop: null, start: null, at: new Date().toISOString() };
        if (!low[fan]) {
          // Stopped at 0%: up in steps of 5% until it turns (start), then down until it stops again (stop).
          for (let pct = 5; pct <= 60; pct += 5) {
            set(p, pct); await safe(4);
            if (rpms()[fan] > 0) { calib.start = pct; break; }
          }
          if (calib.start != null) {
            set(p, Math.min(100, calib.start + 20)); await safe(4);
            calib.stop = 0;
            for (let pct = calib.start; pct >= 0; pct -= 5) {
              set(p, pct); await safe(4);
              if (!rpms()[fan]) { calib.stop = pct; break; }
            }
          }
        }
      }
      job.results.push({ pwm: p.id, fan, calib });
      job.percent = base + share;
      back(p);
    }
  } finally {
    for (const p of pwms) back(p);
    const now = load();
    delete now.testing;
    for (const r of job.results) {
      const ch = now.channels[r.pwm] || { mode: 'auto' };
      if (r.fan) { ch.fan = r.fan; ch.calib = r.calib; } else { delete ch.fan; delete ch.calib; }
      now.channels[r.pwm] = ch;
    }
    store(now);
    for (const k of Object.keys(live)) delete live[k];
  }
}

module.exports = { read, curvePercent, target, nextPercent, validate, tick, startSchedule, restore, status, save, rename, probe, diagnose, installDriver, detect, progress, pairFan, buildOptions, parseSensorsDetect, acpiConflict, COMMUNITY, HOT };

if (require.main === module && process.argv.includes('--restore')) restore();
