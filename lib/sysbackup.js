'use strict';
/*
 * Backups of apps (Docker) and VMs to a folder on the NAS (Backups → Apps and VMs).
 * Tasks in DATA_DIR/sysbackup.json: { jobs: [{ id, name, dest, apps: ['compose:<project>' | 'container:<name>'], vms: [name],
 *   stopApps, vmMode: 'live' | 'shutdown', keep, schedule, created, lastScheduled, lastRun, history }] }.
 * Each run a folder <dest>/<date> with manifest.json, apps/<app>.tar.gz and vms/<vm>/ (domain.xml, nvram, <disk>.qcow2).
 *  - An app = a compose project (all containers together) or a single container. Included: the compose files (+ .env),
 *    mounted folders inside the app data or the compose project's folder, and Docker volumes. Other mounted
 *    folders (e.g. /tank/media or /var/run/docker.sock) deliberately not: they are listed in `skipped`. With stopApps the
 *    containers stop briefly, so databases give a consistent copy, and start again afterwards.
 *  - A VM: domain XML (with the VNC password, hence 0600), nvram and each disk as one qcow2 (also with snapshots).
 *    Shut off: qemu-img convert. Running and vmMode live: `virsh backup-begin` (push, libvirt copies while the VM
 *    runs). Running and vmMode shutdown: shut down cleanly (max. 5 minutes), copy, start again.
 * The oldest folders beyond `keep` are removed. Want them off-site too: a task under Sync on this folder.
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

/* ---- apps: group containers per compose project, and choose which folders go along */

// containers: response of GET /containers/json?all=1. Returns [{ id, name, containers, workingDir, files, paths, skipped }].
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
        ? 'system' : 'outside the app data');
    }
  }
  return [...units.values()].map((u) => {
    // A folder that is already inside another included folder: not twice.
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

/* ---- tasks */

function validateSysJob(body, { datasets = [] } = {}) {
  const name = String(body.name || '').replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 60);
  if (!name) throw httpError('Give the task a name, e.g. Apps and Home Assistant.', 400);
  const dest = backup.cleanLocalPath(body.dest, datasets, 'pull');
  const apps = [...new Set((Array.isArray(body.apps) ? body.apps : []).map(String))];
  if (apps.some((a) => !UNIT.test(a))) throw httpError('One of the chosen apps doesn\'t exist (anymore).', 400);
  const vmList = [...new Set((Array.isArray(body.vms) ? body.vms : []).map(String))];
  if (vmList.some((v) => !VM.test(v))) throw httpError('One of the chosen VMs doesn\'t exist (anymore).', 400);
  if (!apps.length && !vmList.length) throw httpError('Choose at least one app or VM.', 400);
  const keep = Math.min(365, Math.max(1, Math.round(Number(body.keep) || 7)));
  return {
    name, dest, apps, vms: vmList, keep, stopApps: body.stopApps !== false, vmMode: body.vmMode === 'shutdown' ? 'shutdown' : 'live',
    schedule: backup.validateSchedule(body.schedule),
  };
}

const live = new Map(); // id → running backup
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
  if (id && !current) throw httpError('This task doesn\'t exist (anymore).', 404);
  if (id && live.has(id)) throw httpError('This task is running now. Stop it first, or wait until it is done.', 409);
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
  if (!data.jobs.some((j) => j.id === id)) throw httpError('This task doesn\'t exist (anymore).', 404);
  if (live.has(id)) throw httpError('This task is running now. Stop it first, or wait until it is done.', 409);
  data.jobs = data.jobs.filter((j) => j.id !== id);
  save(data);
  fs.rmSync(path.join(LOG_DIR, 'sys-' + id + '.json'), { force: true });
  return { removed: id };
}

/* ---- one backup */

function say(r, level, text) {
  r.lines.push({ time: new Date().toISOString(), level, text });
  if (r.lines.length > 400) r.lines.splice(0, r.lines.length - 400);
}
// A long command you can stop (tar, qemu-img).
function long(r, cmd, args) {
  if (r.cancelled) throw httpError('Stopped.', 409);
  return runStream(cmd, args, (line) => say(r, 'info', line), { timeout: 0, onSpawn: (c) => { r.child = c; } }).finally(() => { r.child = null; });
}
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

async function backupApp(r, unit, dir, stopApps) {
  const out = { id: unit.id, name: unit.name, file: null, size: 0, paths: unit.paths, skipped: unit.skipped, containers: unit.containers.map((c) => ({ name: c.name, image: c.image })) };
  const running = unit.containers.filter((c) => c.state === 'running');
  const existing = unit.paths.filter((p) => fs.existsSync(p));
  if (!existing.length) { say(r, 'info', `${unit.name}: no data to keep.`); return out; }
  if (stopApps) for (const c of running) { say(r, 'info', `${unit.name}: stopping ${c.name}`); await docker('POST', `/containers/${c.id}/stop?t=30`).catch(() => {}); }
  try {
    fs.mkdirSync(path.join(dir, 'apps'), { recursive: true });
    out.file = 'apps/' + fileSafe(unit.name) + '.tar.gz';
    say(r, 'info', `${unit.name}: packing (${existing.join(', ')})`);
    await long(r, 'tar', ['--create', '--gzip', '--file', path.join(dir, out.file), '--directory', '/', '--warning=no-file-changed', '--ignore-failed-read', '--',
      ...existing.map((p) => p.replace(/^\/+/, ''))]);
    out.size = sizeOf(path.join(dir, out.file));
  } finally {
    if (stopApps) for (const c of running) { await docker('POST', `/containers/${c.id}/start`).catch((e) => say(r, 'error', `Starting ${c.name} failed: ${e.message}`)); }
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
// `virsh domjobinfo --bytes`: how far a backup is.
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
    say(r, 'info', `${name}: shutting down`);
    await virsh(['shutdown', name], { timeout: 30000 });
    if (!(await waitOff(name, 5 * 60000))) throw httpError(`${name} didn't shut down within 5 minutes. No backup of this VM was made.`, 409);
    restart = true; st = 'shut off';
  }
  try {
    if (st === 'shut off') {
      out.mode = 'offline';
      for (const d of disks) {
        say(r, 'info', `${name}: copying ${d.target}`);
        await long(r, 'qemu-img', ['convert', '-O', 'qcow2', d.source, path.join(vdir, d.target + '.qcow2')]);
      }
    } else {
      // Live: libvirt copies each disk as the VM sees it now (all snapshots together), while the VM runs.
      out.mode = 'live';
      const bx = path.join(vdir, 'backup.xml');
      fs.writeFileSync(bx, backupXml(disks, h.cdroms.filter((c) => c.target), vdir));
      say(r, 'info', `${name}: copying live`);
      await virsh(['backup-begin', name, bx], { timeout: 60000 });
      r.vmJob = name;
      try {
        for (;;) {
          await wait(3000);
          const j = parseJobInfo(await virsh(['domjobinfo', name, '--bytes'], { timeout: 15000 }));
          if (j.total) r.percent = Math.min(100, Math.round((j.processed / j.total) * 1000) / 10);
          if (!j.type || j.type.toLowerCase() === 'none') break;
          if (r.cancelled) { await virsh(['domjobabort', name], { timeout: 30000 }).catch(() => {}); throw httpError('Stopped.', 409); }
        }
        const done = parseJobInfo(await virsh(['domjobinfo', name, '--completed', '--bytes'], { timeout: 15000 }).catch(() => ''));
        if (done.type && !/completed/i.test(done.type)) throw httpError(`The backup of ${name} failed (${done.type}).`, 502);
      } finally { r.vmJob = null; r.percent = null; fs.rmSync(bx, { force: true }); }
    }
  } finally {
    if (restart) { say(r, 'info', `${name}: starting again`); await virsh(['start', name], { timeout: 60000 }).catch((e) => say(r, 'error', `Starting ${name} failed: ${e.message}`)); }
  }
  out.disks = disks.map((d) => ({ target: d.target, source: d.source, format: formats[d.target] || 'qcow2', file: d.target + '.qcow2', size: sizeOf(path.join(vdir, d.target + '.qcow2')) }));
  out.size = out.disks.reduce((a, d) => a + d.size, 0);
  return out;
}

// Clean up older folders: only <date> folders we made (with manifest.json), the newest `keep` stay.
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
  if (!job) throw httpError('This task doesn\'t exist (anymore).', 404);
  if (live.has(id)) throw httpError('This task is already running.', 409);
  if ([...live.values()].length) throw httpError('A backup of apps or VMs is already running. Wait until it is done.', 409);
  const ds = backup.datasetOf(job.dest, await backup.datasets());
  if (!ds || !ds.mounted) throw httpError(`${job.dest} is not on a mounted pool. Check under Storage whether your pool is all right.`, 409);
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
        if (!unit) throw httpError('This app no longer exists.', 404);
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
    if (gone.length) say(r, 'info', `Old backups removed: ${gone.join(', ')}`);
    const state = r.cancelled ? 'cancelled' : manifest.errors.length ? 'failed' : 'ok';
    say(r, state === 'ok' ? 'info' : 'error', state === 'ok' ? 'Done.' : state === 'cancelled' ? 'Stopped.' : 'Done, with errors.');
    record(id, { kind: 'backup', scheduled, started: r.started, ended: Date.now(), state, stamp, size: manifest.size, items: manifest.apps.length + manifest.vms.length,
      errors: manifest.errors.length, error: manifest.errors[0] || null }, r.lines);
  })().catch((e) => {
    say(r, 'error', 'Failed: ' + e.message);
    record(id, { kind: 'backup', scheduled, started: r.started, ended: Date.now(), state: 'failed', size: 0, items: 0, errors: 1, error: e.message }, r.lines);
  }).finally(() => live.delete(id));
  return { started: true };
}

function stopRun(id) {
  const r = live.get(id);
  if (!r) throw httpError('This task isn\'t running.', 409);
  r.cancelled = true;
  if (r.child) r.child.kill('SIGTERM');
  return { stopping: true };
}

function jobLog(id) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('This task doesn\'t exist (anymore).', 404);
  const r = live.get(id);
  let lines = r ? r.lines : [];
  if (!r) { try { lines = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'sys-' + id + '.json'), 'utf8')); } catch { lines = []; } }
  return { running: liveInfo(r), lines, last: (job.history || [])[0] || null };
}

// Every 30 s: is a scheduled task due? If one is already running, it waits until the next time.
function tick() {
  const data = load(), now = Date.now();
  let changed = false;
  for (const job of data.jobs) {
    const next = backup.nextRun(job.schedule, job.lastScheduled || job.created);
    if (!next || next > now) continue;
    job.lastScheduled = now; changed = true;
    startRun(job.id, { scheduled: true }).catch((e) => record(job.id, { kind: 'backup', scheduled: true, started: now, ended: Date.now(), state: 'failed', size: 0, items: 0, errors: 1, error: e.message },
      [{ time: new Date().toISOString(), level: 'error', text: 'Not started: ' + e.message }]));
  }
  if (changed) save(data);
}
function startSchedule() { setInterval(tick, 30000); }

/* ---- restore */

function readManifest(job, stamp) {
  if (!STAMP.test(String(stamp))) throw httpError('This backup doesn\'t exist (anymore).', 404);
  try { return JSON.parse(fs.readFileSync(path.join(job.dest, stamp, 'manifest.json'), 'utf8')); }
  catch { throw httpError('This backup doesn\'t exist (anymore).', 404); }
}

function listRuns(id) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('This task doesn\'t exist (anymore).', 404);
  let dirs = [];
  try { dirs = fs.readdirSync(job.dest).filter((d) => STAMP.test(d)).sort().reverse(); } catch { /* nothing yet */ }
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
  if (!a || !a.file) throw httpError('There is nothing of this app in this backup.', 404);
  const units = await appUnits();
  const unit = units.find((u) => u.id === appId);
  const running = unit ? unit.containers.filter((c) => c.state === 'running') : [];
  for (const c of running) await docker('POST', `/containers/${c.id}/stop?t=30`).catch(() => {});
  const moved = [];
  try {
    // What is there now moves aside (not away): <folder>.before-restore-<date>.
    const suffix = '.before-restore-' + backup.stampOf(new Date());
    for (const p of a.paths || []) if (fs.existsSync(p)) { fs.renameSync(p, p + suffix); moved.push(p + suffix); }
    await run('tar', ['--extract', '--gzip', '--file', path.join(job.dest, stamp, a.file), '--directory', '/', '--same-owner', '--preserve-permissions'], { timeout: 6 * 3600000 });
  } finally {
    for (const c of running) await docker('POST', `/containers/${c.id}/start`).catch(() => {});
  }
  return { restored: a.name, moved };
}

async function restoreVm(job, stamp, m, name) {
  const v = (m.vms || []).find((x) => x.name === name);
  if (!v || !v.disks || !v.disks.length) throw httpError('There is nothing of this VM in this backup.', 404);
  const vdir = path.join(job.dest, stamp, 'vms', fileSafe(name));
  const exists = await vmStateOf(name).then((st) => st, () => null);
  if (exists && exists !== 'shut off') throw httpError(`Turn ${name} off first. Then you can restore the backup.`, 409);
  if (exists) {
    const snaps = (await virsh(['snapshot-list', name, '--name'], { timeout: 15000 }).catch(() => '')).split('\n').filter((x) => x.trim());
    if (snaps.length) throw httpError(`${name} has snapshots. Remove them first: the backup disks don't fit in that chain.`, 409);
  } else {
    const file = path.join(vdir, 'domain.xml');
    await virsh(['define', file], { timeout: 30000 });
  }
  const current = hw.parseHardware(await virsh(['dumpxml', '--inactive', name], { timeout: 20000 }));
  const suffix = '.before-restore-' + backup.stampOf(new Date());
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
  if (!job) throw httpError('This task doesn\'t exist (anymore).', 404);
  if (live.has(id)) throw httpError('This task is running now. Wait until it is done.', 409);
  const m = readManifest(job, body.stamp);
  if (body.app) return restoreApp(job, body.stamp, m, String(body.app));
  if (body.vm) return restoreVm(job, body.stamp, m, String(body.vm));
  throw httpError('Choose an app or VM to restore.', 400);
}

module.exports = { parseUnits, validateSysJob, parseJobInfo, backupXml, prune, overview, saveJob, deleteJob, startRun, stopRun, jobLog, listRuns, restore, startSchedule };
