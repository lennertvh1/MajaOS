'use strict';
/*
 * "Nu bijwerken": HomeBaseOS bijwerken naar een nieuwe release, met voortgang.
 * Eerste helft (hier, in HomeBaseOS): de release downloaden van GitHub, uitpakken en controleren (package.json, node --check).
 * Tweede helft (lib/update-helper.sh, als eigen systemd-eenheid via systemd-run): reservekopie, bestanden vervangen,
 * deploy/upgrade.sh, herstarten en controleren. Start de nieuwe versie niet, dan zet de helper de vorige terug.
 * De voortgang staat in DATA_DIR/update/status.json; de browser leest die via /api/update/progress, ook tijdens de herstart.
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { run, httpError } = require('./system');
const release = require('./release');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const WORK = path.join(DATA_DIR, 'update');
const STATUS = path.join(WORK, 'status.json');
const APP_DIR = path.join(__dirname, '..');
const REPO = process.env.UPDATE_REPO || 'lennertvh1/homebaseos';
const TOKEN = process.env.UPDATE_TOKEN || '';
const PORT = Number(process.env.PORT || 8080);
const STALE = 15 * 60 * 1000; // een update die zo lang niets meldt, is vastgelopen

/* ---- kan deze installatie zichzelf bijwerken? */
function canUpdate() {
  if (process.platform !== 'linux') return { ok: false, reason: 'Bijwerken vanuit de interface werkt alleen op de server (Debian).' };
  if (typeof process.getuid === 'function' && process.getuid() !== 0) return { ok: false, reason: 'HomeBaseOS draait niet als root en kan zichzelf niet bijwerken.' };
  if (fs.existsSync(path.join(APP_DIR, '.git'))) return { ok: false, reason: 'HomeBaseOS draait uit een git-map. Werk bij met git pull.' };
  if (!fs.existsSync('/usr/bin/systemd-run') && !fs.existsSync('/bin/systemd-run')) return { ok: false, reason: 'systemd-run ontbreekt op deze server.' };
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
  if (s.state === 'running' && !isRunning(s)) return { ...s, state: 'failed', message: 'Het bijwerken liep vast. Probeer het opnieuw.' };
  return { ...s, current: release.currentVersion() };
}

/* ---- downloaden met voortgang (volgt de doorverwijzing naar codeload.github.com) */
function download(url, file, onBytes, headers, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('Onveilige doorverwijzing.'));
        // Het token alleen naar GitHub zelf sturen; de doorverwijzing heeft haar eigen tijdelijke sleutel.
        const h = { ...headers }; if (next.host !== 'api.github.com') delete h.Authorization;
        return download(next.href, file, onBytes, h, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub gaf een onverwacht antwoord (${res.statusCode}).`)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(file);
      res.on('data', (c) => { got += c.length; if (got > 200 * 1024 * 1024) req.destroy(new Error('De download is te groot.')); onBytes(got, total); });
      res.pipe(out);
      out.on('finish', () => resolve(got));
      res.on('error', reject); out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub antwoordt niet.')));
    req.on('error', reject);
  });
}

async function work(rel, from) {
  const dir = path.join(WORK, 'nieuw'), tgz = path.join(WORK, 'release.tar.gz');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tgz, { force: true });
  fs.mkdirSync(dir, { recursive: true });

  // 1. Downloaden: 2 → 40 %. Zonder lengte (codeload geeft die niet altijd) loopt de balk langzaam op.
  writeStatus({ step: 'download', percent: 2, message: `Versie ${rel.version} downloaden…` });
  const headers = { 'User-Agent': 'HomeBaseOS/' + from, Accept: 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  let last = 0;
  await download(`https://api.github.com/repos/${REPO}/tarball/${encodeURIComponent(rel.tag)}`, tgz, (got, total) => {
    if (Date.now() - last < 300) return;
    last = Date.now();
    const frac = total ? got / total : 1 - Math.exp(-got / (1.5 * 1024 * 1024));
    writeStatus({ step: 'download', percent: Math.round(2 + 38 * Math.min(1, frac)), bytes: got, total: total || null });
  }, headers);

  // 2. Uitpakken: 40 → 50 %.
  writeStatus({ step: 'extract', percent: 42, message: 'Uitpakken…' });
  await run('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1', '--no-same-owner'], { timeout: 120000 });
  fs.rmSync(tgz, { force: true });

  // 3. Controleren: 50 → 55 %. Dezelfde controles als na elke wijziging (node --check).
  writeStatus({ step: 'verify', percent: 50, message: 'De nieuwe versie controleren…' });
  for (const p of ['server.js', 'package.json', 'lib', 'public']) if (!fs.existsSync(path.join(dir, p))) throw new Error(`De release is onvolledig (${p} ontbreekt).`);
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* hieronder */ }
  if (release.compareVersions(pkg.version, rel.version) !== 0) throw new Error(`De versie in package.json (${pkg.version || '?'}) past niet bij de release (${rel.version}).`);
  const js = ['server.js', ...fs.readdirSync(path.join(dir, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f)];
  for (const f of js) {
    try { await run(process.execPath, ['--check', path.join(dir, f)], { timeout: 30000 }); }
    catch (e) { throw new Error(`De nieuwe versie bevat een fout in ${f}.`); }
  }
  if (!fs.existsSync(path.join(dir, 'lib', 'update-helper.sh'))) throw new Error('De release is onvolledig (lib/update-helper.sh ontbreekt).');

  // 4. De helper overnemen laten: eigen systemd-eenheid, zodat hij de herstart overleeft.
  writeStatus({ step: 'handover', percent: 56, message: 'Klaar om te installeren…' });
  const helper = path.join(WORK, 'helper.sh');
  fs.copyFileSync(path.join(dir, 'lib', 'update-helper.sh'), helper);
  await run('systemd-run', ['--unit=homebaseos-update-' + Date.now(), '--collect', '--quiet', '--description=HomeBaseOS bijwerken',
    '/bin/bash', helper, dir, APP_DIR, STATUS, String(PORT), rel.version, from, path.join(WORK, 'vorige')], { timeout: 30000 });
}

async function start(version) {
  const can = canUpdate();
  if (!can.ok) throw httpError(can.reason, 409);
  if (isRunning()) throw httpError('Er loopt al een update.', 409);
  const st = release.status();
  const rel = st.newer.find((r) => r.version === String(version || ''));
  if (!rel) throw httpError('Deze versie is niet (meer) beschikbaar. Zoek eerst opnieuw naar updates.', 404);
  const from = release.currentVersion();
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(STATUS, JSON.stringify({ id: Date.now().toString(36), state: 'running', version: rel.version, from, step: 'start', percent: 1,
    message: 'Bijwerken starten…', log: [], started: new Date().toISOString(), updated: new Date().toISOString() }, null, 2));
  work(rel, from).catch((e) => {
    writeStatus({ state: 'failed', message: 'Bijwerken mislukt. Er is niets veranderd.', reason: e.message });
    fs.rmSync(path.join(WORK, 'nieuw'), { recursive: true, force: true });
  });
  return { started: true, version: rel.version };
}

module.exports = { canUpdate, start, progress, isRunning, _download: download };
