'use strict';
/* Basis: commando's uitvoeren en systeemgegevens lezen uit /proc. */
const fs = require('node:fs');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function httpError(msg, status) { const e = new Error(msg); e.status = status; return e; }

// Voer een programma uit zonder shell. anyExit: ook stdout teruggeven bij een exitcode ≠ 0 (smartctl).
// full: altijd { stdout, stderr, code } teruggeven, ook bij een exitcode ≠ 0 (console).
// input: tekst voor stdin (bv. een wachtwoord voor smbpasswd: zo staat het nooit in de lijst met processen).
function run(cmd, args, { timeout = 20000, anyExit = false, full = false, input = null } = {}) {
  return new Promise((resolve, reject) => {
    // LC_ALL=C: Engelse uitvoer, zodat de parsers altijd dezelfde tekst zien.
    const child = execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (full && (!err || typeof err.code === 'number')) return resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? err.code : 0 });
      if (!err || (anyExit && typeof err.code === 'number')) return resolve(String(stdout));
      if (err.code === 'ENOENT') return reject(httpError(cmd + ' is niet geïnstalleerd op de server.', 503));
      if (err.killed) return reject(httpError(cmd + ' reageerde niet op tijd.', 504));
      const msg = String(stderr).split('\n').map((s) => s.replace(/^error:\s*/i, '').trim()).filter(Boolean).join(' ');
      reject(httpError(msg || err.message, 502));
    });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

// Zoals run(), maar geeft elke uitvoerregel (stdout en stderr) meteen door. Voor lange taken zoals docker pull.
function runStream(cmd, args, onLine, { timeout = 30 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, LC_ALL: 'C' } });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    let buf = '';
    const feed = (d) => {
      buf += d;
      const parts = buf.split(/\r?\n|\r/); buf = parts.pop();
      parts.filter((l) => l.trim()).forEach(onLine);
    };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? httpError(cmd + ' is niet geïnstalleerd op de server.', 503) : e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) onLine(buf);
      if (code === 0) resolve(); else reject(httpError(cmd + ' ' + args.slice(-2).join(' ') + ' stopte met foutcode ' + code + '.', 502));
    });
  });
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

/* ---- CPU: verschil tussen twee metingen van /proc/stat */
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

/* ---- geheugen: de ZFS-cache (ARC) telt niet als gebruikt, want die geeft de kernel vrij als het nodig is */
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

/* ---- NVIDIA-GPU via nvidia-smi (null als er geen is) */
async function gpuStats() {
  let out;
  try {
    out = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
      '--format=csv,noheader,nounits'], { timeout: 4000 });
  } catch { return null; }
  const gpus = out.trim().split('\n').filter(Boolean).map((l) => {
    const [name, util, memUsed, memTotal, temp, power] = l.split(',').map((s) => s.trim());
    return { name, util: num(util), memUsed: num(memUsed) * 1048576, memTotal: num(memTotal) * 1048576, temp: num(temp), power: num(power) };
  });
  return gpus.length ? gpus : null;
}

module.exports = { wait, num, httpError, run, runStream, readText, parseCpuLine, cpuPercent, parseMeminfo, arcSize, memory, uptime, osName, cpuInfo, gpuStats };
