'use strict';
/*
 * "Update now": update MajaOS to a new release, with progress.
 * First half (here, in MajaOS): download the release from GitHub, unpack it and check it (package.json, node --check).
 * Second half (lib/update-helper.sh, as its own systemd unit via systemd-run): backup copy, replace files,
 * deploy/upgrade.sh, restart and check. If the new version doesn't start, the helper puts the previous one back.
 * The progress is in DATA_DIR/update/status.json; the browser reads it via /api/update/progress, also during the restart.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { run, httpError } = require('./system');
const release = require('./release');
const settings = require('./settings');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const WORK = path.join(DATA_DIR, 'update');
const STATUS = path.join(WORK, 'status.json');
const APP_DIR = path.join(__dirname, '..');
const REPO = process.env.UPDATE_REPO || 'lennertvh1/homebaseos';
const TOKEN = process.env.UPDATE_TOKEN || '';
const STALE = 15 * 60 * 1000; // an update that reports nothing for this long is stuck

/* ---- can this install update itself? */
function canUpdate() {
  if (process.platform !== 'linux') return { ok: false, reason: 'Updating from the interface only works on the server (Debian).' };
  if (typeof process.getuid === 'function' && process.getuid() !== 0) return { ok: false, reason: 'MajaOS is not running as root and can\'t update itself.' };
  if (fs.existsSync(path.join(APP_DIR, '.git'))) return { ok: false, reason: 'MajaOS runs from a git folder. Update with git pull.' };
  if (!fs.existsSync('/usr/bin/systemd-run') && !fs.existsSync('/bin/systemd-run')) return { ok: false, reason: 'systemd-run is missing on this server.' };
  return { ok: true, reason: null };
}

/* ---- status */
function readStatus() { try { return JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { return null; } }
function writeStatus(patch) {
  const s = { ...(readStatus() || {}), ...patch, updated: new Date().toISOString() };
  if (patch.message && (!s.log || s.log[s.log.length - 1] !== patch.message)) (s.log = s.log || []).push(patch.message);
  if (s.state !== 'running') s.finished = s.finished || s.updated;
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(STATUS + '.tmp', JSON.stringify(s, null, 2));
  fs.renameSync(STATUS + '.tmp', STATUS);
  return s;
}
function isRunning(s = readStatus()) { return !!(s && s.state === 'running' && Date.now() - Date.parse(s.updated) < STALE); }
function progress() {
  const s = readStatus();
  if (!s) return { state: 'idle' };
  if (s.state === 'running' && !isRunning(s)) return { ...s, state: 'failed', message: 'The update got stuck. Try again.' };
  return { ...s, current: release.currentVersion() };
}

/* ---- download with progress (follows the redirect to codeload.github.com) */
function download(url, file, onBytes, headers, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('Unsafe redirect.'));
        // Only send the token to GitHub itself; the redirect has its own temporary key.
        const h = { ...headers }; if (next.host !== 'api.github.com') delete h.Authorization;
        return download(next.href, file, onBytes, h, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub gave an unexpected answer (${res.statusCode}).`)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(file);
      res.on('data', (c) => { got += c.length; if (got > 200 * 1024 * 1024) req.destroy(new Error('The download is too large.')); onBytes(got, total); });
      res.pipe(out);
      out.on('finish', () => resolve(got));
      res.on('error', reject); out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub is not responding.')));
    req.on('error', reject);
  });
}

async function work(rel, from) {
  const dir = path.join(WORK, 'new'), tgz = path.join(WORK, 'release.tar.gz');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tgz, { force: true });
  fs.mkdirSync(dir, { recursive: true });

  // 1. Download: 2 → 40 %. Without a length (codeload doesn't always give one) the bar creeps up slowly.
  writeStatus({ step: 'download', percent: 2, message: `Downloading version ${rel.version}…` });
  const headers = { 'User-Agent': 'MajaOS/' + from, Accept: 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  let last = 0;
  await download(`https://api.github.com/repos/${REPO}/tarball/${encodeURIComponent(rel.tag)}`, tgz, (got, total) => {
    if (Date.now() - last < 300) return;
    last = Date.now();
    const frac = total ? got / total : 1 - Math.exp(-got / (1.5 * 1024 * 1024));
    writeStatus({ step: 'download', percent: Math.round(2 + 38 * Math.min(1, frac)), bytes: got, total: total || null });
  }, headers);

  // 2. Unpack: 40 → 50 %.
  writeStatus({ step: 'extract', percent: 42, message: 'Unpacking…' });
  await run('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1', '--no-same-owner'], { timeout: 120000 });
  fs.rmSync(tgz, { force: true });

  // 3. Check: 50 → 55 %. The same checks as after every change (node --check).
  writeStatus({ step: 'verify', percent: 50, message: 'Verifying the new version…' });
  for (const p of ['server.js', 'package.json', 'lib', 'public']) if (!fs.existsSync(path.join(dir, p))) throw new Error(`The release is incomplete (${p} is missing).`);
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* below */ }
  const want = rel.dev ? rel.pkgVersion : rel.version; // a development build: the version in package.json of that commit
  if (want && release.compareVersions(pkg.version, want) !== 0) throw new Error(`The version in package.json (${pkg.version || '?'}) doesn't match the release (${want}).`);
  const js = ['server.js', ...fs.readdirSync(path.join(dir, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f)];
  for (const f of js) {
    try { await run(process.execPath, ['--check', path.join(dir, f)], { timeout: 30000 }); }
    catch (e) { throw new Error(`The new version has an error in ${f}.`); }
  }
  if (!fs.existsSync(path.join(dir, 'lib', 'update-helper.sh'))) throw new Error('The release is incomplete (lib/update-helper.sh is missing).');

  // Which commit this is (channel dev); an official release has no build.json, so updating to one removes it.
  if (rel.dev) fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ branch: release.DEV_BRANCH, commit: rel.commit, date: rel.published }, null, 2) + '\n');
  else fs.rmSync(path.join(dir, 'build.json'), { force: true });

  // 4. Hand over to the helper: its own systemd unit, so it survives the restart.
  writeStatus({ step: 'handover', percent: 56, message: 'Ready to install…' });
  const helper = path.join(WORK, 'helper.sh');
  fs.copyFileSync(path.join(dir, 'lib', 'update-helper.sh'), helper);
  await run('systemd-run', ['--unit=majaos-update-' + Date.now(), '--collect', '--quiet', '--description=Updating MajaOS',
    '/bin/bash', helper, dir, APP_DIR, STATUS, String(settings.listenPort()), rel.version, from, path.join(WORK, 'previous')], { timeout: 30000 });
}

async function start(version) {
  const can = canUpdate();
  if (!can.ok) throw httpError(can.reason, 409);
  if (isRunning()) throw httpError('An update is already running.', 409);
  const st = release.status();
  const rel = st.newer.find((r) => r.version === String(version || ''));
  if (!rel) throw httpError('This version is not available (anymore). Check for updates again first.', 404);
  const from = release.currentVersion();
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(STATUS, JSON.stringify({ id: Date.now().toString(36), state: 'running', version: rel.version, from, step: 'start', percent: 1,
    message: 'Starting the update…', log: [], started: new Date().toISOString(), updated: new Date().toISOString() }, null, 2));
  work(rel, from).catch((e) => {
    writeStatus({ state: 'failed', message: 'Update failed. Nothing was changed.', reason: e.message });
    fs.rmSync(path.join(WORK, 'new'), { recursive: true, force: true });
  });
  return { started: true, version: rel.version };
}

module.exports = { canUpdate, start, progress, isRunning, _download: download };
