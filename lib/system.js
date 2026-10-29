'use strict';
/* Basics: running commands and reading system data from /proc. */
const fs = require('node:fs');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function httpError(msg, status) { const e = new Error(msg); e.status = status; return e; }

// Run a program without a shell. anyExit: also return stdout on an exit code ≠ 0 (smartctl).
// full: always return { stdout, stderr, code }, also on an exit code ≠ 0 (console).
// input: text for stdin (e.g. a password for smbpasswd: that way it never shows up in the process list).
// env: extra environment variables (e.g. KOPIA_PASSWORD, for the same reason).
function run(cmd, args, { timeout = 20000, anyExit = false, full = false, input = null, env = null } = {}) {
  return new Promise((_resolve, _reject) => {
    // A process stuck in the kernel (zpool or smartctl on a disk that no longer answers) doesn't die from the time-out's
    // SIGTERM, and execFile only answers once it has exited: give up on it 5 s after the time-out anyway.
    let over = false;
    const guard = timeout ? setTimeout(() => { if (!over) { over = true; _reject(httpError(cmd + ' did not respond in time.', 504)); } }, timeout + 5000) : null;
    const resolve = (v) => { if (over) return; over = true; clearTimeout(guard); _resolve(v); };
    const reject = (e) => { if (over) return; over = true; clearTimeout(guard); _reject(e); };
    // LC_ALL=C: English output, so the parsers always see the same text.
    const child = execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...(env || {}), LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (full && (!err || typeof err.code === 'number')) return resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? err.code : 0 });
      if (!err || (anyExit && typeof err.code === 'number')) return resolve(String(stdout));
      if (err.code === 'ENOENT') return reject(httpError(cmd + ' is not installed on the server.', 503));
      if (err.killed) return reject(httpError(cmd + ' did not respond in time.', 504));
      const msg = String(stderr).split('\n').map((s) => s.replace(/^error:\s*/i, '').trim()).filter(Boolean).join(' ');
      reject(httpError(msg || err.message, 502));
    });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

// Like run(), but passes on each output line (stdout and stderr) right away. For long tasks like docker pull.
// timeout 0 = no limit (backups); onSpawn gets the process, so it can be stopped.
function runStream(cmd, args, onLine, { timeout = 30 * 60000, onSpawn = null, env = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...(env || {}), LC_ALL: 'C' } });
    if (onSpawn) onSpawn(child);
    const timer = timeout ? setTimeout(() => child.kill('SIGTERM'), timeout) : null;
    let buf = '';
    const feed = (d) => {
      buf += d;
      const parts = buf.split(/\r?\n|\r/); buf = parts.pop();
      parts.filter((l) => l.trim()).forEach(onLine);
    };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? httpError(cmd + ' is not installed on the server.', 503) : e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) onLine(buf);
      if (code === 0) resolve(); else reject(httpError(cmd + ' ' + args.slice(-2).join(' ') + ' stopped with exit code ' + code + '.', 502));
    });
  });
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

/* ---- CPU: difference between two readings of /proc/stat */
function parseCpuLine(text) {
  const v = (text.split('\n')[0] || '').trim().split(/\s+/).slice(1).map(Number);
  return { idle: (v[3] || 0) + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
}
let lastCpu = null;
async function cpuPercent() {
  let prev = lastCpu;
  if (!prev || Date.now() - prev.at > 60000) { prev = { ...parseCpuLine(readText('/proc/stat')), at: Date.now() }; await wait(300); }
  const cur = { ...parseCpuLine(readText('/proc/stat')), at: Date.now() };
  lastCpu = cur;
  const dt = cur.total - prev.total;
  return dt > 0 ? Math.round((1 - (cur.idle - prev.idle) / dt) * 1000) / 10 : null;
}

/* ---- memory: the ZFS cache (ARC) doesn't count as used, because the kernel frees it when needed */
function parseMeminfo(text) {
  const kb = {};
  text.split('\n').forEach((l) => { const m = l.match(/^(\w+):\s+(\d+)/); if (m) kb[m[1]] = Number(m[2]) * 1024; });
  return kb;
}
function arcSize(text) { const m = text.match(/^size\s+\d+\s+(\d+)/m); return m ? Number(m[1]) : 0; }
function memory() {
  const mi = parseMeminfo(readText('/proc/meminfo'));
  if (!mi.MemTotal) return null;
  const arc = arcSize(readText('/proc/spl/kstat/zfs/arcstats'));
  const used = Math.max(0, mi.MemTotal - (mi.MemAvailable || 0) - arc);
  return { total: mi.MemTotal, used, zfsCache: arc, percent: Math.round((used / mi.MemTotal) * 1000) / 10 };
}

function uptime() { const v = parseFloat(readText('/proc/uptime')); return Number.isNaN(v) ? null : Math.round(v); }

function osName() { const m = readText('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]*)"?/m); return m ? m[1] : os.type(); }

function cpuInfo() {
  const cpus = os.cpus();
  const m = readText('/proc/cpuinfo').match(/^cpu cores\s*:\s*(\d+)/m);
  return { brand: cpus[0] ? cpus[0].model.trim() : null, cores: m ? Number(m[1]) : null, threads: cpus.length };
}

/* ---- NVIDIA GPU via nvidia-smi (null if there is none)
 * Asked in the background, at most every 5 s: without nvidia-persistenced the first answer can take seconds, and the
 * dashboard shouldn't wait for it. The last answer is kept; gpuError says why there is none (shown with the card). */
let gpuLast = { at: 0, gpus: null, error: null, busy: null };
function parseNvidiaSmi(out) {
  const gpus = String(out || '').trim().split('\n').filter(Boolean).map((l) => {
    const [name, util, memUsed, memTotal, temp, power] = l.split(',').map((s) => s.trim());
    return { name, util: num(util), memUsed: num(memUsed) == null ? null : num(memUsed) * 1048576, memTotal: num(memTotal) == null ? null : num(memTotal) * 1048576, temp: num(temp), power: num(power) };
  });
  return gpus.length ? gpus : null;
}
function sampleGpu() {
  if (gpuLast.busy) return gpuLast.busy;
  gpuLast.busy = run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits'], { timeout: 20000 })
    .then((out) => { gpuLast = { ...gpuLast, at: Date.now(), gpus: parseNvidiaSmi(out), error: null }; },
      (e) => { gpuLast = { ...gpuLast, at: Date.now(), gpus: null, error: /not installed/.test(e.message) ? null : String(e.message).split('\n')[0].slice(0, 200) }; })
    .finally(() => { gpuLast.busy = null; });
  return gpuLast.busy;
}
async function gpuStats() {
  // The first time we wait (so a page that just opened has it); after that the answer is never older than ~5 s.
  if (!gpuLast.at) await sampleGpu();
  else if (Date.now() - gpuLast.at > 5000) sampleGpu();
  return gpuLast.gpus;
}
const gpuError = () => gpuLast.error;

/* ---- graphics cards as lspci sees them, also without a driver (nvidia-smi only works once the driver is loaded) */
// lspci -vmmk: one record per device (Class, Vendor, Device, … Driver). Display devices only; a server's own BMC
// video (ASPEED, Matrox) isn't a GPU anyone uses.
function parseGpuDevices(text) {
  return String(text || '').split(/\n\s*\n/).map((rec) => Object.fromEntries(rec.split('\n').map((l) => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()])))
    .filter((r) => /VGA compatible controller|3D controller|Display controller/i.test(r.Class || '') && !/aspeed|matrox/i.test(r.Vendor || ''))
    .map((r) => {
      const vendor = /nvidia/i.test(r.Vendor) ? 'nvidia' : /amd|ati\b|advanced micro/i.test(r.Vendor) ? 'amd' : /intel/i.test(r.Vendor) ? 'intel' : 'other';
      const name = ((String(r.Device || '').match(/\[([^\]]+)\]\s*$/) || [])[1] || r.Device || '').trim();
      // A card with only nouveau (or nothing) has no working NVIDIA driver for apps.
      const driver = r.Driver || null;
      return { name, vendor, driver, ready: vendor === 'nvidia' ? driver === 'nvidia' : !!driver };
    });
}
let gpuCache = null;
async function gpuDevices() {
  if (gpuCache && Date.now() - gpuCache.at < 60000) return gpuCache.list;
  const list = await run('lspci', ['-vmmk'], { timeout: 5000 }).then(parseGpuDevices, () => []);
  gpuCache = { at: Date.now(), list };
  return list;
}

/* ---- the system window: per core, temperature, memory in detail, network per card (each a difference between two
 * readings, like cpuPercent; the window asks every 2 s) */
// /proc/stat: the cpu0, cpu1… lines.
function parseCpuCores(text) {
  return String(text || '').split('\n').filter((l) => /^cpu\d+\s/.test(l)).map((l) => {
    const v = l.trim().split(/\s+/).slice(1).map(Number);
    return { idle: (v[3] || 0) + (v[4] || 0), total: v.reduce((a, b) => a + b, 0) };
  });
}
// /proc/net/dev: bytes received and sent per card.
function parseNetDev(text) {
  const out = {};
  for (const l of String(text || '').split('\n').slice(2)) {
    const m = l.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    out[m[1]] = { rx: v[0] || 0, tx: v[8] || 0 };
  }
  return out;
}
const OWN_NET = /^(lo|veth|docker|br-|virbr|vnet|tap|tun)/;
// The CPU's temperature: AMD (k10temp: Tctl) or Intel (coretemp: the package), in °C.
function cpuTemp() {
  try {
    for (const h of fs.readdirSync('/sys/class/hwmon')) {
      const dir = '/sys/class/hwmon/' + h, name = readText(dir + '/name').trim();
      if (name !== 'k10temp' && name !== 'coretemp' && name !== 'zenpower') continue;
      const v = Number(readText(dir + '/temp1_input'));
      if (v) return Math.round(v / 100) / 10;
    }
  } catch { /* no hwmon */ }
  return null;
}
function coreMhz(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const khz = Number(readText(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`));
    out.push(khz ? Math.round(khz / 1000) : null);
  }
  if (out.every((x) => x == null)) {
    const mhz = [...readText('/proc/cpuinfo').matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((m) => Math.round(Number(m[1])));
    return mhz.length ? mhz : out;
  }
  return out;
}
let lastDetail = null; // {at, cores, net}
async function details() {
  let prev = lastDetail;
  const read = () => ({ at: Date.now(), cores: parseCpuCores(readText('/proc/stat')), net: parseNetDev(readText('/proc/net/dev')) });
  if (!prev || Date.now() - prev.at > 30000) { prev = read(); await wait(400); }
  const cur = read();
  lastDetail = cur;
  const secs = Math.max(0.1, (cur.at - prev.at) / 1000);
  const perCore = cur.cores.map((c, i) => {
    const p = prev.cores[i], dt = p ? c.total - p.total : 0;
    return dt > 0 ? Math.round((1 - (c.idle - p.idle) / dt) * 1000) / 10 : null;
  });
  const mhz = coreMhz(perCore.length);
  const mi = parseMeminfo(readText('/proc/meminfo'));
  const arc = arcSize(readText('/proc/spl/kstat/zfs/arcstats'));
  const net = Object.entries(cur.net).filter(([n]) => !OWN_NET.test(n)).map(([name, v]) => {
    const p = prev.net[name];
    return { name, rx: p ? Math.max(0, (v.rx - p.rx) / secs) : null, tx: p ? Math.max(0, (v.tx - p.tx) / secs) : null, rxTotal: v.rx, txTotal: v.tx };
  });
  const [gpu, gpus] = await Promise.all([gpuStats(), gpuDevices()]);
  return {
    hostname: os.hostname(), os: osName(), kernel: os.release(), uptime: uptime(), load: os.loadavg().map((x) => Math.round(x * 100) / 100),
    cpu: { ...cpuInfo(), percent: await cpuPercent(), temp: cpuTemp(), cores: perCore.map((p, i) => ({ id: i, percent: p, mhz: mhz[i] || null })), physical: cpuInfo().cores },
    memory: mi.MemTotal ? {
      total: mi.MemTotal, available: mi.MemAvailable || 0, zfsCache: arc,
      apps: Math.max(0, mi.MemTotal - (mi.MemAvailable || 0) - arc), cache: (mi.Buffers || 0) + (mi.Cached || 0) - (mi.Shmem || 0),
      swapTotal: mi.SwapTotal || 0, swapUsed: Math.max(0, (mi.SwapTotal || 0) - (mi.SwapFree || 0)),
    } : null,
    gpu, gpus, gpuError: gpuError(), net,
  };
}

module.exports = { wait, num, httpError, run, runStream, readText, parseCpuLine, cpuPercent, parseCpuCores, parseNetDev, details, parseMeminfo, arcSize, memory, uptime, osName, cpuInfo, gpuStats, gpuError, parseNvidiaSmi, parseGpuDevices, gpuDevices };
