'use strict';
/*
 * Updates of Debian itself (Settings > Software update, section Debian).
 * - Automatic security updates: unattended-upgrades (APT::Periodic in /etc/apt/apt.conf.d/20auto-upgrades), never an
 *   automatic reboot (a new kernel needs the ZFS module built by DKMS first).
 * - What is waiting: `apt list --upgradable` (from the package lists apt-daily refreshes), security = a "-security" suite.
 * - Reboot needed: /var/run/reboot-required(.pkgs); ZFS ready = `dkms status` has zfs installed for the newest kernel.
 * - Check now / Update Debian now / turn automatic updates on: lib/apt-helper.sh as its own systemd unit (needrestart may
 *   restart HomeBaseOS while apt runs), with its state in DATA_DIR/debian/status.json and its output in log.txt.
 */
const fs = require('node:fs');
const path = require('node:path');
const { run, httpError, readText } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const DIR = path.join(DATA_DIR, 'debian');
const STATUS = path.join(DIR, 'status.json'), LOG = path.join(DIR, 'log.txt');
const AUTO_FILE = process.env.APT_AUTO_FILE || '/etc/apt/apt.conf.d/20auto-upgrades';
const UU_LOG = '/var/log/unattended-upgrades/unattended-upgrades.log';
const ACTIONS = ['check', 'upgrade', 'auto-on', 'auto-off'];

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

/* ---- status */

function job() { try { return JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { return null; } }
const running = (j) => !!(j && j.state === 'running' && Date.now() - Date.parse(j.updated || j.started) < 2 * 3600 * 1000);

async function status() {
  const installed = (pkg) => run('dpkg-query', ['-W', '-f=${Status}', pkg], { timeout: 5000 }).then((o) => /install ok installed/.test(o), () => false);
  const [list, uu, needrestart, dkms] = await Promise.all([
    run('apt', ['list', '--upgradable'], { timeout: 30000 }).then(parseUpgradable, () => []),
    installed('unattended-upgrades'), installed('needrestart'),
    run('dkms', ['status', 'zfs'], { timeout: 10000 }).then(parseDkms, () => []),
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
    job: j ? { ...j, running: running(j) } : null,
  };
}

/* ---- actions: lib/apt-helper.sh as its own unit */

async function start(action) {
  if (!ACTIONS.includes(action)) throw httpError('Unknown action.', 400);
  if (process.platform !== 'linux' || (typeof process.getuid === 'function' && process.getuid() !== 0)) {
    throw httpError('Updating Debian only works on the server itself, with HomeBaseOS running as root.', 409);
  }
  if (running(job())) throw httpError('apt is already running. Wait until it is done.', 409);
  fs.mkdirSync(DIR, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(STATUS, JSON.stringify({ action, state: 'running', started: now, updated: now }, null, 2));
  fs.writeFileSync(LOG, '');
  const helper = path.join(DIR, 'apt-helper.sh');
  fs.copyFileSync(path.join(__dirname, 'apt-helper.sh'), helper);
  try {
    await run('systemd-run', ['--unit=homebaseos-apt-' + Date.now(), '--collect', '--quiet', '--description=HomeBaseOS: apt ' + action,
      '/bin/bash', helper, action, STATUS, LOG, AUTO_FILE], { timeout: 30000 });
  } catch (e) {
    fs.writeFileSync(STATUS, JSON.stringify({ action, state: 'failed', started: now, updated: now, finished: now, message: e.message }, null, 2));
    throw e;
  }
  return { started: true, action };
}

// Progress for the browser: the state and the last lines of the output.
function progress() {
  const j = job();
  const lines = readText(LOG).split('\n').filter(Boolean);
  return { ...(j || { state: 'idle' }), running: running(j), lines: lines.slice(-200) };
}

module.exports = { status, start, progress, parseUpgradable, parseAutoConf, parseUuLog, parseDkms, sortKernels };
