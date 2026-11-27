'use strict';
/*
 * Updates of Debian itself (Settings > Software update, section Debian).
 * - Automatic security updates: unattended-upgrades (APT::Periodic in /etc/apt/apt.conf.d/20auto-upgrades), never an
 *   automatic reboot (a new kernel needs the ZFS module built by DKMS first).
 * - What is waiting: `apt list --upgradable` (from the package lists apt-daily refreshes), security = a "-security" suite.
 * - Reboot needed: /var/run/reboot-required(.pkgs); ZFS ready = `dkms status` has zfs installed for the newest kernel.
 * - Check now / Update Debian now / turn automatic updates on: lib/apt-helper.sh as its own systemd unit (needrestart may
 *   restart MajaOS while apt runs), with its state in DATA_DIR/debian/status.json and its output in log.txt.
 */
const fs = require('node:fs');
const path = require('node:path');
const { run, httpError, readText } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const DIR = path.join(DATA_DIR, 'debian');
const STATUS = path.join(DIR, 'status.json'), LOG = path.join(DIR, 'log.txt'), SCHEDULE = path.join(DIR, 'schedule.json');
const AUTO_FILE = process.env.APT_AUTO_FILE || '/etc/apt/apt.conf.d/20auto-upgrades';
const UU_LOG = '/var/log/unattended-upgrades/unattended-upgrades.log';
const ACTIONS = ['check', 'upgrade', 'auto-on', 'auto-off', 'nvidia'];

/* ---- parsers (testable on their own) */

// `apt list --upgradable`: "openssl/stable-security 3.5.4-1~deb13u1 amd64 [upgradable from: 3.5.1-1]"
function parseUpgradable(text) {
  return String(text).split('\n').map((l) => l.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from: ([^\]]+)\]/)).filter(Boolean)
    .map(([, name, suite, version, arch, from]) => ({ name, suite, version, arch, from, security: /-security\b/.test(suite) }));
}

// 20auto-upgrades: APT::Periodic::Unattended-Upgrade "1";
function parseAutoConf(text) {
  const v = (k) => { const m = String(text).match(new RegExp(`APT::Periodic::${k}\\s+"(\\d+)"`)); return m ? Number(m[1]) : 0; };
  return { lists: v('Update-Package-Lists') > 0, upgrade: v('Unattended-Upgrade') > 0 };
}

// The end of unattended-upgrades.log: when it last ran and what it said.
function parseUuLog(text) {
  const lines = String(text).split('\n').filter(Boolean);
  let last = null;
  for (let i = lines.length - 1; i >= 0 && !last; i--) {
    const m = lines[i].match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ (\w+) (.*)$/);
    if (m && /Starting unattended upgrades script/.test(m[3])) last = { at: m[1].replace(' ', 'T'), index: i };
  }
  if (!last) return null;
  const after = lines.slice(last.index + 1).map((l) => l.replace(/^\S+ \S+ \w+ /, ''));
  const upgraded = after.find((l) => /^Packages that will be upgraded:/.test(l));
  return {
    at: last.at,
    packages: upgraded ? upgraded.replace(/^Packages that will be upgraded:\s*/, '').split(/\s+/).filter(Boolean) : [],
    ok: !after.some((l) => /error|failed/i.test(l)),
    nothing: after.some((l) => /No packages found that can be upgraded unattended/.test(l)),
  };
}

// `dkms status`: "zfs/2.3.2, 6.12.48+deb13-amd64, x86_64: installed"
function parseDkms(text) {
  return String(text).split('\n').map((l) => l.match(/^([^/,\s]+)\/([^,]+),\s*([^,]+),\s*([^:]+):\s*(\S+)/)).filter(Boolean)
    .map(([, module, version, kernel, arch, state]) => ({ module, version, kernel: kernel.trim(), arch: arch.trim(), state }));
}

// Kernel versions like 6.12.48+deb13-amd64, newest first.
function sortKernels(list) {
  const key = (k) => String(k).split(/[^0-9]+/).filter(Boolean).map(Number);
  return [...list].sort((a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  });
}

/* ---- NVIDIA: a card in the server, and whether its driver and Docker's GPU support are there */

// lspci -mm -d 10de: → the graphics cards (VGA or 3D controller) with their name.
function parseNvidiaCards(text) {
  return String(text || '').split('\n').map((l) => [...l.matchAll(/"([^"]*)"/g)].map((m) => m[1]))
    .filter((f) => f.length >= 3 && /VGA compatible controller|3D controller|Display controller/i.test(f[0]) && /nvidia/i.test(f[1]))
    .map((f) => ((f[2].match(/\[([^\]]+)\]\s*$/) || [])[1] || f[2]).trim()); // "GA104 [GeForce RTX 3060 Ti]": the name in brackets
}
// /proc/driver/nvidia/version: "NVRM version: NVIDIA UNIX x86_64 Kernel Module  535.183.01  Sun May 12 …"
const parseDriverVersion = (text) => (String(text || '').match(/Kernel Module\s+([\d.]+)/) || [])[1] || null;
// The SecureBoot EFI variable: 4 bytes of attributes, then 1 = on. An unsigned DKMS module doesn't load with it on.
function secureBootOn() {
  try {
    const dir = '/sys/firmware/efi/efivars';
    const f = fs.readdirSync(dir).find((x) => x.startsWith('SecureBoot-'));
    if (!f) return false;
    const b = fs.readFileSync(path.join(dir, f));
    return b[b.length - 1] === 1;
  } catch { return false; }
}
async function nvidiaStatus(installed) {
  const [cards, driver, toolkit] = await Promise.all([
    run('lspci', ['-mm', '-d', '10de:'], { timeout: 5000 }).then(parseNvidiaCards, () => []),
    installed('nvidia-driver'), installed('nvidia-container-toolkit'),
  ]);
  const version = parseDriverVersion(readText('/proc/driver/nvidia/version'));
  const docker = /"nvidia"/.test(readText('/etc/docker/daemon.json'));
  return { cards, installed: driver, loaded: !!version, version, toolkit, docker, secureBoot: cards.length ? secureBootOn() : false };
}

/* ---- status */

function job() { try { return JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { return null; } }
const running = (j) => !!(j && j.state === 'running' && Date.now() - Date.parse(j.updated || j.started) < 2 * 3600 * 1000);

async function status() {
  const installed = (pkg) => run('dpkg-query', ['-W', '-f=${Status}', pkg], { timeout: 5000 }).then((o) => /install ok installed/.test(o), () => false);
  const [list, uu, needrestart, dkms, nvidia] = await Promise.all([
    run('apt', ['list', '--upgradable'], { timeout: 30000 }).then(parseUpgradable, () => []),
    installed('unattended-upgrades'), installed('needrestart'),
    run('dkms', ['status', 'zfs'], { timeout: 10000 }).then(parseDkms, () => []),
    nvidiaStatus(installed),
  ]);
  const auto = parseAutoConf(readText(AUTO_FILE));
  let kernels = [];
  try { kernels = sortKernels(fs.readdirSync('/lib/modules').filter((k) => fs.existsSync(path.join('/lib/modules', k, 'modules.dep')))); } catch { /* not Linux */ }
  const runningKernel = (await run('uname', ['-r'], { timeout: 3000 }).catch(() => '')).trim();
  const newest = kernels[0] || runningKernel;
  const zfsFor = (k) => dkms.some((d) => d.kernel === k && d.state === 'installed');
  const rebootPkgs = readText('/var/run/reboot-required.pkgs').split('\n').map((x) => x.trim()).filter(Boolean);
  let listsAt = null;
  try { listsAt = fs.statSync('/var/lib/apt/lists').mtime.toISOString(); } catch { /* none */ }
  const j = job();
  const os = (readText('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || null;
  return {
    os, version: readText('/etc/debian_version').trim() || null, kernel: runningKernel, newestKernel: newest,
    updates: list, security: list.filter((x) => x.security).length, listsAt,
    auto: { installed: uu, enabled: uu && auto.upgrade && auto.lists, last: uu ? parseUuLog(readText(UU_LOG)) : null }, needrestart,
    reboot: { required: fs.existsSync('/var/run/reboot-required') || (!!newest && newest !== runningKernel), packages: rebootPkgs,
      // ZFS must be built for the kernel the server will start with; without ZFS (dkms empty) there is nothing to check.
      zfsReady: dkms.length ? zfsFor(newest) : null },
    job: j ? { ...j, running: running(j) } : null, nvidia, schedule: scheduleInfo(),
  };
}

/* ---- actions: lib/apt-helper.sh as its own unit */

async function start(action) {
  if (!ACTIONS.includes(action)) throw httpError('Unknown action.', 400);
  if (process.platform !== 'linux' || (typeof process.getuid === 'function' && process.getuid() !== 0)) {
    throw httpError('Updating Debian only works on the server itself, with MajaOS running as root.', 409);
  }
  if (running(job())) throw httpError('apt is already running. Wait until it is done.', 409);
  fs.mkdirSync(DIR, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(STATUS, JSON.stringify({ action, state: 'running', started: now, updated: now }, null, 2));
  fs.writeFileSync(LOG, '');
  const helper = path.join(DIR, 'apt-helper.sh');
  fs.copyFileSync(path.join(__dirname, 'apt-helper.sh'), helper);
  try {
    await run('systemd-run', ['--unit=majaos-apt-' + Date.now(), '--collect', '--quiet', '--description=MajaOS: apt ' + action,
      '/bin/bash', helper, action, STATUS, LOG, AUTO_FILE], { timeout: 30000 });
  } catch (e) {
    fs.writeFileSync(STATUS, JSON.stringify({ action, state: 'failed', started: now, updated: now, finished: now, message: e.message }, null, 2));
    throw e;
  }
  return { started: true, action };
}

// How far an upgrade is, from apt's output: the package lists 0–10 %, then every package is unpacked and set up
// (2 steps each, out of the count in "N upgraded, M newly installed") 10–95 %, cleaning up 97 %. Null when there is
// no way to tell (the other actions, or before apt said how many packages): the browser shows a bar that moves.
function aptPercent(action, text) {
  if (action !== 'upgrade') return null;
  if (/^== Cleaning up/m.test(text)) return 97;
  if (!/^== Installing the updates/m.test(text)) return 5;
  const m = text.match(/^(\d+) upgraded, (\d+) newly installed/m);
  const total = m ? Number(m[1]) + Number(m[2]) : 0;
  if (!total) return 10;
  const steps = (text.match(/^(Unpacking|Setting up) /gm) || []).length;
  return Math.min(95, Math.round(10 + 85 * steps / (2 * total)));
}

// Progress for the browser: the state, a percent when apt's output tells it, and the last lines of the output.
function progress() {
  const j = job();
  const text = readText(LOG);
  const lines = text.split('\n').filter(Boolean);
  const run = running(j);
  return { ...(j || { state: 'idle' }), running: run, percent: j && !run && j.state === 'done' ? 100 : j ? aptPercent(j.action, text) : null, lines: lines.slice(-200) };
}

/* ---- a scheduled update: once (a date and time) or every day/week, optionally with a restart afterwards */

const SCHED_EVERY = ['off', 'once', 'daily', 'weekly'];
const LATE = 60 * 60 * 1000; // a time missed by more than an hour (server off) is skipped, never run in the middle of the day
function readSchedule() { try { return JSON.parse(fs.readFileSync(SCHEDULE, 'utf8')); } catch { return {}; } }
function writeSchedule(x) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SCHEDULE + '.tmp', JSON.stringify(x, null, 2)); fs.renameSync(SCHEDULE + '.tmp', SCHEDULE);
}

function validateSchedule(body, now = Date.now()) {
  const every = SCHED_EVERY.includes(body && body.every) ? body.every : 'off';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test((body && body.time) || '') ? body.time : '03:00';
  const day = Number.isInteger(Number(body && body.day)) && Number(body.day) >= 0 && Number(body.day) <= 6 ? Number(body.day) : 0;
  const reboot = !!(body && body.reboot);
  let date = null;
  if (every === 'once') {
    date = String((body && body.date) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(atTime(date, time))) throw httpError('Choose the date of the update.', 400);
    if (atTime(date, time) <= now) throw httpError('Choose a time in the future.', 400);
  }
  return { every, time, day, date, reboot };
}
// A date (YYYY-MM-DD) and time (HH:MM) in the server's time zone, in ms.
function atTime(date, time) {
  const [y, mo, d] = date.split('-').map(Number), [h, m] = time.split(':').map(Number);
  const x = new Date(y, mo - 1, d, h, m, 0, 0);
  return x.getMonth() === mo - 1 ? x.getTime() : NaN;
}
// The next time after `from`, or null.
function nextScheduled(sc, from = Date.now()) {
  if (!sc || !SCHED_EVERY.includes(sc.every) || sc.every === 'off') return null;
  if (sc.every === 'once') { const at = atTime(sc.date || '', sc.time || '03:00'); return Number.isNaN(at) ? null : at; }
  return require('./backup').nextRun({ every: sc.every, time: sc.time, day: sc.day }, from);
}
function scheduleInfo() {
  const sc = readSchedule();
  const base = { every: 'off', time: '03:00', day: 0, date: null, reboot: false, ...sc };
  return { ...base, next: base.every === 'off' ? null : base.next || nextScheduled(base), last: sc.last || null };
}
function saveSchedule(body) {
  const v = validateSchedule(body);
  const old = readSchedule();
  writeSchedule({ ...v, next: nextScheduled(v), last: old.last || null, waiting: null });
  return scheduleInfo();
}

// Every minute: start the update when its time came, and restart afterwards when that was asked and an update needs it.
async function scheduleTick(now = Date.now()) {
  const sc = readSchedule();
  if (sc.waiting) { // our update was started: wait until apt is done
    const j = job();
    if (j && j.started === sc.waiting && running(j)) return;
    const ok = !!(j && j.started === sc.waiting && j.state === 'done');
    let restarted = false, note = ok ? null : (j && j.message) || 'The update did not finish.';
    if (ok && sc.rebootAfter) {
      const st = await status().catch(() => null);
      if (st && st.reboot.required && st.reboot.zfsReady === false) note = 'Not restarted: the ZFS module isn\'t built for the new kernel yet.';
      else if (st && st.reboot.required) restarted = true;
    }
    writeSchedule({ ...sc, waiting: null, rebootAfter: null, last: { at: new Date(now).toISOString(), ok, restarted, note } });
    if (restarted) setTimeout(() => run('systemctl', ['reboot'], { timeout: 30000 }).catch((e) => console.error('[debian] restart:', e.message)), 5000);
    return;
  }
  const at = sc.next || nextScheduled(sc, now);
  if (!at || at > now) return;
  // Its time came (or was missed): the next one, and "once" is done.
  const next = sc.every === 'once' ? null : nextScheduled(sc, now);
  const every = sc.every === 'once' ? 'off' : sc.every;
  if (now - at > LATE) { writeSchedule({ ...sc, every, next, last: { at: new Date(now).toISOString(), ok: false, restarted: false, note: 'Skipped: the server was off at the planned time.' } }); return; }
  if (running(job())) { writeSchedule({ ...sc, every, next, last: { at: new Date(now).toISOString(), ok: false, restarted: false, note: 'Skipped: apt was already running.' } }); return; }
  try {
    await start('upgrade');
    writeSchedule({ ...sc, every, next, waiting: job().started, rebootAfter: !!sc.reboot });
  } catch (e) {
    writeSchedule({ ...sc, every, next, last: { at: new Date(now).toISOString(), ok: false, restarted: false, note: e.message } });
  }
}
let ticker = null;
function startSchedule() {
  if (ticker) return;
  ticker = setInterval(() => scheduleTick().catch((e) => console.error('[debian] schedule:', e.message)), 60 * 1000);
  ticker.unref();
}

module.exports = { secureBootOn, saveSchedule, scheduleInfo, scheduleTick, startSchedule, validateSchedule, nextScheduled, status, start, progress, aptPercent, parseUpgradable, parseAutoConf, parseUuLog, parseDkms, sortKernels, parseNvidiaCards, parseDriverVersion };
