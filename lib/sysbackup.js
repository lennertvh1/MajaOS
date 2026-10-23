'use strict';
/*
 * Back-ups van apps (Docker) en VM's naar een map op de NAS (Back-ups → Apps en VM's).
 * Taken in DATA_DIR/sysbackup.json: { jobs: [{ id, name, dest, apps: ['compose:<project>' | 'container:<naam>'], vms: [naam],
 *   stopApps, vmMode: 'live' | 'shutdown', keep, schedule, created, lastScheduled, lastRun, history }] }.
 * Elke keer een map <dest>/<datum> met manifest.json, apps/<app>.tar.gz en vms/<vm>/ (domain.xml, nvram, <schijf>.qcow2).
 *  - Een app = een compose-project (alle containers samen) of een losse container. Mee: de compose-bestanden (+ .env),
 *    gekoppelde mappen binnen de appgegevens of de map van het compose-project, en Docker-volumes. Andere gekoppelde
 *    mappen (bv. /tank/media of /var/run/docker.sock) bewust niet: die staan in `skipped`. Met stopApps stoppen de
 *    containers even, zodat databases een consistente kopie geven, en starten ze daarna weer.
 *  - Een VM: domein-XML (met VNC-wachtwoord, daarom 0600), nvram en elke schijf als één qcow2 (ook met snapshots).
 *    Uitgeschakeld: qemu-img convert. Aan en vmMode live: `virsh backup-begin` (push, libvirt kopieert terwijl de VM
 *    draait). Aan en vmMode shutdown: netjes afsluiten (max. 5 minuten), kopiëren, weer starten.
 * De oudste mappen boven `keep` verdwijnen. Wil je ze ook buiten de deur: een taak bij Synchroniseren op deze map.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, runStream, httpError, wait } = require('./system');
const { docker } = require('./docker');
const vms = require('./vms');
const hw = require('./vmhw');
const paths = require('./paths');
const backup = require('./backup');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'sysbackup.json');
const LOG_DIR = path.join(DATA_DIR, 'backup-logs');
const CONN = 'qemu:///system';
const virsh = (args, opts) => run('virsh', ['-c', CONN, ...args], opts);
const UNIT = /^(compose|container):[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VM = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,62}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}_\d{6}$/;

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { jobs: Array.isArray(j.jobs) ? j.jobs : [] }; } catch { return { jobs: [] }; }
}
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}
const inside = (p, root) => !!root && (p === root || p.startsWith(root.replace(/\/$/, '') + '/'));
const fileSafe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');

/* ---- apps: containers groeperen per compose-project, en kiezen welke mappen meegaan */

// containers: antwoord van GET /containers/json?all=1. Geeft [{ id, name, containers, workingDir, files, paths, skipped }].
function parseUnits(containers, { appdata = null } = {}) {
  const units = new Map();
  for (const c of containers || []) {
    const labels = c.Labels || {};
    const cname = (c.Names && c.Names[0] ? c.Names[0] : c.Id.slice(0, 12)).replace(/^\//, '');
    const project = labels['com.docker.compose.project'];
    const id = project ? 'compose:' + project : 'container:' + cname;
    if (!units.has(id)) {
      const wd = labels['com.docker.compose.project.working_dir'] || null;
      const files = (labels['com.docker.compose.project.config_files'] || '').split(',').map((x) => x.trim()).filter(Boolean)
        .map((f) => (path.isAbsolute(f) ? f : wd ? path.join(wd, f) : null)).filter(Boolean);
      units.set(id, { id, name: project || cname, compose: !!project, workingDir: wd, files, containers: [], paths: new Set(), skipped: new Map() });
    }
    const u = units.get(id);
    u.containers.push({ id: c.Id, name: cname, state: String(c.State || '').toLowerCase(), image: c.Image });
    for (const m of c.Mounts || []) {
      const src = m.Source ? path.resolve(m.Source) : null;
      if (!src) continue;
      if (m.Type === 'volume') u.paths.add(src);
      else if (m.Type === 'bind' && (inside(src, appdata) || inside(src, u.workingDir))) u.paths.add(src);
      else if (m.Type === 'bind') u.skipped.set(src, inside(src, '/dev') || inside(src, '/run') || inside(src, '/var/run') || inside(src, '/proc') || inside(src, '/sys') || src.startsWith('/etc/')
        ? 'systeem' : 'buiten de appgegevens');
    }
  }
  return [...units.values()].map((u) => {
    // Een map die al in een andere meegaande map zit, niet dubbel.
    const list = [...new Set([...u.files, ...(u.workingDir ? ['.env'].map((f) => path.join(u.workingDir, f)) : []), ...u.paths])].sort();
    const own = list.filter((p) => !list.some((q) => q !== p && inside(p, q)));
    return { id: u.id, name: u.name, compose: u.compose, workingDir: u.workingDir, containers: u.containers,
      paths: own, skipped: [...u.skipped].map(([p, why]) => ({ path: p, reason: why })).sort((a, b) => a.path.localeCompare(b.path)) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function appUnits() {
  const list = await docker('GET', '/containers/json?all=1');
  return parseUnits(list, { appdata: paths.dir('appdata') });
}

/* ---- taken */

function validateSysJob(body, { datasets = [] } = {}) {
  const name = String(body.name || '').replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 60);
  if (!name) throw httpError('Geef de taak een naam, bv. Apps en Home Assistant.', 400);
  const dest = backup.cleanLocalPath(body.dest, datasets, 'pull');
  const apps = [...new Set((Array.isArray(body.apps) ? body.apps : []).map(String))];
  if (apps.some((a) => !UNIT.test(a))) throw httpError('Een van de gekozen apps bestaat niet (meer).', 400);
  const vmList = [...new Set((Array.isArray(body.vms) ? body.vms : []).map(String))];
  if (vmList.some((v) => !VM.test(v))) throw httpError('Een van de gekozen VM\'s bestaat niet (meer).', 400);
  if (!apps.length && !vmList.length) throw httpError('Kies minstens één app of VM.', 400);
  const keep = Math.min(365, Math.max(1, Math.round(Number(body.keep) || 7)));
  return {
    name, dest, apps, vms: vmList, keep, stopApps: body.stopApps !== false, vmMode: body.vmMode === 'shutdown' ? 'shutdown' : 'live',
    schedule: backup.validateSchedule(body.schedule),
  };
}

const live = new Map(); // id → lopende back-up
const newId = () => crypto.randomBytes(4).toString('hex');
const liveInfo = (r) => (r ? { kind: r.kind, started: r.started, current: r.current, done: r.done, total: r.total, percent: r.percent } : null);
const publicJob = (j) => ({ ...j, history: (j.history || []).slice(0, 10), next: backup.nextRun(j.schedule, j.lastScheduled || j.created), running: liveInfo(live.get(j.id)) });

async function overview() {
  const [units, vmList, ds] = await Promise.all([appUnits().catch(() => []), vms.listVms().catch(() => []), backup.datasets()]);
  const pool = ds.find((d) => !d.name.includes('/') && d.mounted);
  return {
    jobs: load().jobs.map(publicJob), apps: units, vms: vmList.map((v) => ({ name: v.name, state: v.state })),
    folders: ds.filter((d) => d.mounted).map((d) => d.mountpoint), defaultDest: pool ? pool.mountpoint + '/backups/systeem' : null,
  };
}

async function saveJob(body, id = null) {
  const data = load();
  const current = id ? data.jobs.find((j) => j.id === id) : null;
  if (id && !current) throw httpError('Deze taak bestaat niet (meer).', 404);
  if (id && live.has(id)) throw httpError('Deze taak loopt nu. Stop ze eerst, of wacht tot ze klaar is.', 409);
  const job = validateSysJob(body, { datasets: await backup.datasets() });
  const out = current ? { ...current, ...job } : { id: newId(), ...job, created: Date.now(), lastRun: null, history: [] };
  if (!current || JSON.stringify(current.schedule) !== JSON.stringify(job.schedule)) out.lastScheduled = Date.now();
  const fresh = load();
  fresh.jobs = current ? fresh.jobs.map((j) => (j.id === id ? out : j)) : fresh.jobs.concat(out);
  save(fresh);
  return publicJob(out);
}

function deleteJob(id) {
  const data = load();
  if (!data.jobs.some((j) => j.id === id)) throw httpError('Deze taak bestaat niet (meer).', 404);
  if (live.has(id)) throw httpError('Deze taak loopt nu. Stop ze eerst, of wacht tot ze klaar is.', 409);
  data.jobs = data.jobs.filter((j) => j.id !== id);
  save(data);
  fs.rmSync(path.join(LOG_DIR, 'sys-' + id + '.json'), { force: true });
  return { removed: id };
}

/* ---- één back-up */

function say(r, level, text) {
  r.lines.push({ time: new Date().toISOString(), level, text });
  if (r.lines.length > 400) r.lines.splice(0, r.lines.length - 400);
}
// Een lang commando dat je kan stoppen (tar, qemu-img).
function long(r, cmd, args) {
  if (r.cancelled) throw httpError('Gestopt.', 409);
  return runStream(cmd, args, (line) => say(r, 'info', line), { timeout: 0, onSpawn: (c) => { r.child = c; } }).finally(() => { r.child = null; });
}
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

async function backupApp(r, unit, dir, stopApps) {
  const out = { id: unit.id, name: unit.name, file: null, size: 0, paths: unit.paths, skipped: unit.skipped, containers: unit.containers.map((c) => ({ name: c.name, image: c.image })) };
  const running = unit.containers.filter((c) => c.state === 'running');
  const existing = unit.paths.filter((p) => fs.existsSync(p));
  if (!existing.length) { say(r, 'info', `${unit.name}: geen gegevens om te bewaren.`); return out; }
  if (stopApps) for (const c of running) { say(r, 'info', `${unit.name}: ${c.name} stoppen`); await docker('POST', `/containers/${c.id}/stop?t=30`).catch(() => {}); }
  try {
    fs.mkdirSync(path.join(dir, 'apps'), { recursive: true });
    out.file = 'apps/' + fileSafe(unit.name) + '.tar.gz';
    say(r, 'info', `${unit.name}: inpakken (${existing.join(', ')})`);
    await long(r, 'tar', ['--create', '--gzip', '--file', path.join(dir, out.file), '--directory', '/', '--warning=no-file-changed', '--ignore-failed-read', '--',
      ...existing.map((p) => p.replace(/^\/+/, ''))]);
    out.size = sizeOf(path.join(dir, out.file));
  } finally {
    if (stopApps) for (const c of running) { await docker('POST', `/containers/${c.id}/start`).catch((e) => say(r, 'error', `${c.name} starten lukte niet: ${e.message}`)); }
  }
  return out;
}

async function vmStateOf(name) {
  return (await virsh(['domstate', name], { timeout: 10000 })).trim().toLowerCase();
}
async function waitOff(name, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(5000)) if ((await vmStateOf(name)) === 'shut off') return true;
  return false;
}
// `virsh domjobinfo --bytes`: hoe ver een back-up is.
function parseJobInfo(text) {
  const kv = Object.fromEntries(String(text).split('\n').map((l) => l.split(/:\s+/)).filter((x) => x.length >= 2).map(([k, ...v]) => [k.trim().toLowerCase(), v.join(': ').trim()]));
  const n = (k) => { const m = String(kv[k] || '').match(/^(\d+)/); return m ? Number(m[1]) : null; };
  return { type: kv['job type'] || null, processed: n('data processed'), total: n('data total') };
}
function backupXml(disks, cdroms, dir) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;');
  return `<domainbackup mode='push'>\n  <disks>\n${disks.map((d) => `    <disk name='${esc(d.target)}' backup='yes' type='file'><target file='${esc(path.join(dir, d.target + '.qcow2'))}'/><driver type='qcow2'/></disk>`).join('\n')}\n` +
    `${cdroms.map((c) => `    <disk name='${esc(c.target)}' backup='no'/>`).join('\n')}${cdroms.length ? '\n' : ''}  </disks>\n</domainbackup>\n`;
}

async function backupVm(r, name, dir, mode) {
  const out = { name, disks: [], nvram: null, size: 0, mode: null };
  const vdir = path.join(dir, 'vms', fileSafe(name));
  fs.mkdirSync(vdir, { recursive: true });
  const xml = await virsh(['dumpxml', '--inactive', '--security-info', name], { timeout: 20000 });
  fs.writeFileSync(path.join(vdir, 'domain.xml'), xml, { mode: 0o600 });
  const nv = xml.match(/<nvram\b[^>]*>([^<]+)<\/nvram>/);
  if (nv && fs.existsSync(nv[1].trim())) { fs.copyFileSync(nv[1].trim(), path.join(vdir, 'nvram.fd')); out.nvram = { source: nv[1].trim(), file: 'nvram.fd' }; }
  const h = hw.parseHardware(xml);
  const disks = h.disks.filter((d) => d.source && d.target);
  const formats = {};
  for (const d of disks) formats[d.target] = await run('qemu-img', ['info', '--output=json', '-U', d.source], { timeout: 15000 }).then((o) => JSON.parse(o).format, () => d.format || 'qcow2');
  let st = await vmStateOf(name);
  let restart = false;
  if (st !== 'shut off' && mode === 'shutdown') {
    say(r, 'info', `${name}: afsluiten`);
    await virsh(['shutdown', name], { timeout: 30000 });
    if (!(await waitOff(name, 5 * 60000))) throw httpError(`${name} sloot niet af binnen 5 minuten. Er is geen back-up van deze VM gemaakt.`, 409);
    restart = true; st = 'shut off';
  }
  try {
    if (st === 'shut off') {
      out.mode = 'offline';
      for (const d of disks) {
        say(r, 'info', `${name}: ${d.target} kopiëren`);
        await long(r, 'qemu-img', ['convert', '-O', 'qcow2', d.source, path.join(vdir, d.target + '.qcow2')]);
      }
    } else {
      // Live: libvirt kopieert elke schijf zoals de VM ze nu ziet (alle snapshots samen), terwijl de VM draait.
      out.mode = 'live';
      const bx = path.join(vdir, 'backup.xml');
      fs.writeFileSync(bx, backupXml(disks, h.cdroms.filter((c) => c.target), vdir));
      say(r, 'info', `${name}: live kopiëren`);
      await virsh(['backup-begin', name, bx], { timeout: 60000 });
      r.vmJob = name;
      try {
        for (;;) {
          await wait(3000);
          const j = parseJobInfo(await virsh(['domjobinfo', name, '--bytes'], { timeout: 15000 }));
          if (j.total) r.percent = Math.min(100, Math.round((j.processed / j.total) * 1000) / 10);
          if (!j.type || j.type.toLowerCase() === 'none') break;
          if (r.cancelled) { await virsh(['domjobabort', name], { timeout: 30000 }).catch(() => {}); throw httpError('Gestopt.', 409); }
        }
        const done = parseJobInfo(await virsh(['domjobinfo', name, '--completed', '--bytes'], { timeout: 15000 }).catch(() => ''));
        if (done.type && !/completed/i.test(done.type)) throw httpError(`De back-up van ${name} is mislukt (${done.type}).`, 502);
      } finally { r.vmJob = null; r.percent = null; fs.rmSync(bx, { force: true }); }
    }
  } finally {
    if (restart) { say(r, 'info', `${name}: weer starten`); await virsh(['start', name], { timeout: 60000 }).catch((e) => say(r, 'error', `${name} starten lukte niet: ${e.message}`)); }
  }
  out.disks = disks.map((d) => ({ target: d.target, source: d.source, format: formats[d.target] || 'qcow2', file: d.target + '.qcow2', size: sizeOf(path.join(vdir, d.target + '.qcow2')) }));
  out.size = out.disks.reduce((a, d) => a + d.size, 0);
  return out;
}

// Mappen van vroeger opruimen: alleen <datum>-mappen die wij maakten (met manifest.json), de nieuwste `keep` blijven.
function prune(dest, keep) {
  let dirs = [];
  try { dirs = fs.readdirSync(dest).filter((d) => STAMP.test(d) && fs.existsSync(path.join(dest, d, 'manifest.json'))).sort(); } catch { return []; }
  const gone = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const d of gone) fs.rmSync(path.join(dest, d), { recursive: true, force: true });
  return gone;
}

function record(id, entry, lines) {
  const data = load(), job = data.jobs.find((j) => j.id === id);
  if (!job) return;
  job.history = [entry, ...(job.history || [])].slice(0, 20);
  if (entry.kind === 'backup') job.lastRun = entry;
  save(data);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOG_DIR, 'sys-' + id + '.json'), JSON.stringify(lines.slice(-400)));
}

async function startRun(id, { scheduled = false } = {}) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('Deze taak bestaat niet (meer).', 404);
  if (live.has(id)) throw httpError('Deze taak loopt al.', 409);
  if ([...live.values()].length) throw httpError('Er loopt al een back-up van apps of VM\'s. Wacht tot die klaar is.', 409);
  const ds = backup.datasetOf(job.dest, await backup.datasets());
  if (!ds || !ds.mounted) throw httpError(`${job.dest} ligt niet op een gekoppelde pool. Kijk bij Opslag of je pool in orde is.`, 409);
  const r = { kind: 'backup', started: Date.now(), lines: [], current: null, done: 0, total: job.apps.length + job.vms.length, percent: null, cancelled: false, child: null };
  live.set(id, r);
  (async () => {
    const stamp = backup.stampOf(new Date());
    const dir = path.join(job.dest, stamp);
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    const manifest = { version: 1, job: job.name, created: Date.now(), apps: [], vms: [], errors: [] };
    const units = await appUnits().catch((e) => { manifest.errors.push('Docker: ' + e.message); return []; });
    for (const uid of job.apps) {
      const unit = units.find((u) => u.id === uid);
      r.current = unit ? unit.name : uid.split(':')[1];
      try {
        if (!unit) throw httpError('Deze app bestaat niet meer.', 404);
        manifest.apps.push(await backupApp(r, unit, dir, job.stopApps));
      } catch (e) { manifest.apps.push({ id: uid, name: r.current, error: e.message }); manifest.errors.push(`${r.current}: ${e.message}`); say(r, 'error', `${r.current}: ${e.message}`); }
      r.done++;
      if (r.cancelled) break;
    }
    for (const name of r.cancelled ? [] : job.vms) {
      r.current = name;
      try { manifest.vms.push(await backupVm(r, name, dir, job.vmMode)); }
      catch (e) { manifest.vms.push({ name, error: e.message }); manifest.errors.push(`${name}: ${e.message}`); say(r, 'error', `${name}: ${e.message}`); }
      r.done++;
      if (r.cancelled) break;
    }
    manifest.finished = Date.now();
    manifest.size = [...manifest.apps, ...manifest.vms].reduce((a, x) => a + (x.size || 0), 0);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const gone = r.cancelled ? [] : prune(job.dest, job.keep);
    if (gone.length) say(r, 'info', `Oude back-ups weg: ${gone.join(', ')}`);
    const state = r.cancelled ? 'cancelled' : manifest.errors.length ? 'failed' : 'ok';
    say(r, state === 'ok' ? 'info' : 'error', state === 'ok' ? 'Klaar.' : state === 'cancelled' ? 'Gestopt.' : 'Klaar, met fouten.');
    record(id, { kind: 'backup', scheduled, started: r.started, ended: Date.now(), state, stamp, size: manifest.size, items: manifest.apps.length + manifest.vms.length,
      errors: manifest.errors.length, error: manifest.errors[0] || null }, r.lines);
  })().catch((e) => {
    say(r, 'error', 'Mislukt: ' + e.message);
    record(id, { kind: 'backup', scheduled, started: r.started, ended: Date.now(), state: 'failed', size: 0, items: 0, errors: 1, error: e.message }, r.lines);
  }).finally(() => live.delete(id));
  return { started: true };
}

function stopRun(id) {
  const r = live.get(id);
  if (!r) throw httpError('Deze taak loopt niet.', 409);
  r.cancelled = true;
  if (r.child) r.child.kill('SIGTERM');
  return { stopping: true };
}

function jobLog(id) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('Deze taak bestaat niet (meer).', 404);
  const r = live.get(id);
  let lines = r ? r.lines : [];
  if (!r) { try { lines = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'sys-' + id + '.json'), 'utf8')); } catch { lines = []; } }
  return { running: liveInfo(r), lines, last: (job.history || [])[0] || null };
}

// Elke 30 s: is er een geplande taak aan de beurt? Loopt er al een, dan wacht ze tot de volgende keer.
function tick() {
  const data = load(), now = Date.now();
  let changed = false;
  for (const job of data.jobs) {
    const next = backup.nextRun(job.schedule, job.lastScheduled || job.created);
    if (!next || next > now) continue;
    job.lastScheduled = now; changed = true;
    startRun(job.id, { scheduled: true }).catch((e) => record(job.id, { kind: 'backup', scheduled: true, started: now, ended: Date.now(), state: 'failed', size: 0, items: 0, errors: 1, error: e.message },
      [{ time: new Date().toISOString(), level: 'error', text: 'Niet gestart: ' + e.message }]));
  }
  if (changed) save(data);
}
function startSchedule() { setInterval(tick, 30000); }

/* ---- terugzetten */

function readManifest(job, stamp) {
  if (!STAMP.test(String(stamp))) throw httpError('Deze back-up bestaat niet (meer).', 404);
  try { return JSON.parse(fs.readFileSync(path.join(job.dest, stamp, 'manifest.json'), 'utf8')); }
  catch { throw httpError('Deze back-up bestaat niet (meer).', 404); }
}

function listRuns(id) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('Deze taak bestaat niet (meer).', 404);
  let dirs = [];
  try { dirs = fs.readdirSync(job.dest).filter((d) => STAMP.test(d)).sort().reverse(); } catch { /* nog niets */ }
  const runs = dirs.map((stamp) => {
    try {
      const m = readManifest(job, stamp);
      return { stamp, created: m.created, size: m.size || 0, errors: m.errors || [],
        apps: (m.apps || []).map((a) => ({ id: a.id, name: a.name, size: a.size || 0, error: a.error || null, file: !!a.file })),
        vms: (m.vms || []).map((v) => ({ name: v.name, size: v.size || 0, error: v.error || null, mode: v.mode || null })) };
    } catch { return null; }
  }).filter(Boolean);
  return { dest: job.dest, runs };
}

async function restoreApp(job, stamp, m, appId) {
  const a = (m.apps || []).find((x) => x.id === appId);
  if (!a || !a.file) throw httpError('Van deze app staat er niets in deze back-up.', 404);
  const units = await appUnits();
  const unit = units.find((u) => u.id === appId);
  const running = unit ? unit.containers.filter((c) => c.state === 'running') : [];
  for (const c of running) await docker('POST', `/containers/${c.id}/stop?t=30`).catch(() => {});
  const moved = [];
  try {
    // Wat er nu staat, gaat opzij (niet weg): <map>.voor-terugzetten-<datum>.
    const suffix = '.voor-terugzetten-' + backup.stampOf(new Date());
    for (const p of a.paths || []) if (fs.existsSync(p)) { fs.renameSync(p, p + suffix); moved.push(p + suffix); }
    await run('tar', ['--extract', '--gzip', '--file', path.join(job.dest, stamp, a.file), '--directory', '/', '--same-owner', '--preserve-permissions'], { timeout: 6 * 3600000 });
  } finally {
    for (const c of running) await docker('POST', `/containers/${c.id}/start`).catch(() => {});
  }
  return { restored: a.name, moved };
}

async function restoreVm(job, stamp, m, name) {
  const v = (m.vms || []).find((x) => x.name === name);
  if (!v || !v.disks || !v.disks.length) throw httpError('Van deze VM staat er niets in deze back-up.', 404);
  const vdir = path.join(job.dest, stamp, 'vms', fileSafe(name));
  const exists = await vmStateOf(name).then((st) => st, () => null);
  if (exists && exists !== 'shut off') throw httpError(`Zet ${name} eerst uit. Daarna kan je de back-up terugzetten.`, 409);
  if (exists) {
    const snaps = (await virsh(['snapshot-list', name, '--name'], { timeout: 15000 }).catch(() => '')).split('\n').filter((x) => x.trim());
    if (snaps.length) throw httpError(`${name} heeft snapshots. Verwijder die eerst: de schijven van de back-up passen niet in die rij.`, 409);
  } else {
    const file = path.join(vdir, 'domain.xml');
    await virsh(['define', file], { timeout: 30000 });
  }
  const current = hw.parseHardware(await virsh(['dumpxml', '--inactive', name], { timeout: 20000 }));
  const suffix = '.voor-terugzetten-' + backup.stampOf(new Date());
  const moved = [];
  for (const d of v.disks) {
    const now = current.disks.find((x) => x.target === d.target);
    const target = (now && now.source) || d.source;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) { fs.renameSync(target, target + suffix); moved.push(target + suffix); }
    await run('qemu-img', ['convert', '-O', d.format || 'qcow2', path.join(vdir, d.file), target], { timeout: 12 * 3600000 });
  }
  if (v.nvram && fs.existsSync(path.join(vdir, v.nvram.file))) fs.copyFileSync(path.join(vdir, v.nvram.file), v.nvram.source);
  return { restored: name, moved };
}

async function restore(id, body) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('Deze taak bestaat niet (meer).', 404);
  if (live.has(id)) throw httpError('Deze taak loopt nu. Wacht tot ze klaar is.', 409);
  const m = readManifest(job, body.stamp);
  if (body.app) return restoreApp(job, body.stamp, m, String(body.app));
  if (body.vm) return restoreVm(job, body.stamp, m, String(body.vm));
  throw httpError('Kies een app of VM om terug te zetten.', 400);
}

module.exports = { parseUnits, validateSysJob, parseJobInfo, backupXml, prune, overview, saveJob, deleteJob, startRun, stopRun, jobLog, listRuns, restore, startSchedule };
