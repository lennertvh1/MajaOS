'use strict';
/*
 * Storage locations (Settings → Storage) and moving app data to another pool.
 * Moving: stop the apps that use a folder in the app data, copy everything with rsync,
 * replace the paths in their compose files (with .bak), set the new folder and recreate the apps.
 * The old folder stays: remove it yourself when everything works.
 */
const fs = require('node:fs');
const path = require('node:path');
const { run, runStream, httpError } = require('./system');
const paths = require('./paths');
const { docker } = require('./docker');

const POOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const APP_UID = Number(process.env.APP_UID || 1000), APP_GID = Number(process.env.APP_GID || 1000);
const under = (p, dir) => p === dir || p.startsWith(dir + '/');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replace a path by another, but only as a full path (not /tank/appdata2 for /tank/appdata).
function replacePath(text, from, to) {
  return text.replace(new RegExp(escRe(from) + '(?=$|[/"\'\\s:,\\]}])', 'gm'), to);
}

// Which containers use a folder in dir. With compose: per project (stopping and recreating is possible),
// without compose, or with a compose file that isn't on the server (e.g. Portainer keeps it in its
// own container): only report them (they keep using the old folder).
async function appsUsing(dir) {
  if (!dir) return { projects: [], manual: [] };
  return groupContainers(await docker('GET', '/containers/json?all=1').catch(() => []), dir);
}
function groupContainers(list, dir, exists = fs.existsSync) {
  const projects = new Map(), manual = [];
  for (const c of list || []) {
    if (!(c.Mounts || []).some((m) => m.Type === 'bind' && m.Source && under(path.resolve(m.Source), dir))) continue;
    const l = c.Labels || {}, name = (c.Names && c.Names[0] ? c.Names[0] : c.Id.slice(0, 12)).replace(/^\//, '');
    const project = l['com.docker.compose.project'];
    const files = (l['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean);
    if (!project || !files.length || !files.every((f) => exists(f))) { manual.push(name); continue; }
    const p = projects.get(project) || { project, files, workingDir: l['com.docker.compose.project.working_dir'] || path.dirname(files[0]), containers: [], running: false };
    p.containers.push(name);
    if (c.State === 'running') p.running = true;
    projects.set(project, p);
  }
  return { projects: [...projects.values()], manual };
}

const composeBase = (p) => ['compose', '--ansi', 'never', '-p', p.project, '--project-directory', p.workingDir, ...p.files.flatMap((f) => ['-f', f])];

async function overview() {
  await paths.detect().catch(() => {});
  const [pools, used] = await Promise.all([paths.pools(), appsUsing(paths.dir('appdata'))]);
  const all = paths.all();
  return {
    paths: all, exists: Object.fromEntries(paths.KINDS.map((k) => [k, paths.exists(k)])),
    pools, folders: paths.FOLDER,
    apps: used.projects.map((p) => ({ project: p.project, containers: p.containers, running: p.running })), manual: used.manual,
    migration: status(),
  };
}

// Choose a pool for VM disks, ISOs or shared folders. Existing files don't move along.
async function setLocation(kind, pool) {
  if (!['vms', 'isos', 'shares'].includes(kind)) throw httpError('Unknown kind of folder.', 400);
  const p = (await paths.pools()).find((x) => x.name === String(pool || ''));
  if (!p || !POOL.test(p.name)) throw httpError('Choose a pool.', 400);
  const target = path.join(p.mountpoint, paths.FOLDER[kind]);
  if (!fs.existsSync(target)) await run('zfs', ['create', p.name + '/' + paths.FOLDER[kind]], { timeout: 30000 });
  paths.save({ [kind]: target });
  return overview();
}

// Point to an existing folder yourself (e.g. where your app data already is). Nothing moves.
const SYSTEM = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/tmp', '/usr', '/var'];
function usePath(kind, dir) {
  if (!paths.KINDS.includes(kind)) throw httpError('Unknown kind of folder.', 400);
  const raw = String(dir || '').trim();
  if (!path.isAbsolute(raw) || /[\r\n]/.test(raw)) throw httpError('Choose a full path, e.g. /tank/appdata.', 400);
  const p = path.resolve(raw);
  if (SYSTEM.includes(p) || ['/proc', '/sys', '/dev', '/etc', '/usr', '/boot', '/run'].some((x) => p.startsWith(x + '/'))) throw httpError('Choose a folder on one of your pools, not a system folder.', 400);
  let st = null;
  try { st = fs.statSync(p); } catch { /* doesn't exist */ }
  if (!st || !st.isDirectory()) throw httpError(`The folder ${p} does not exist.`, 400);
  paths.save({ [kind]: p });
  return overview();
}

/* ---- moving app data: one job at a time, progress in memory */
let job = null;
function status() {
  if (!job) return null;
  const { from, to, items, state, step, percent, error, lines, manual, started, finished } = job;
  return { from, to, ...(items ? { items } : {}), state, step, percent, error, lines, manual, started, finished };
}
function log(line) { job.lines.push(line); if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200); }

async function migrateAppdata(pool) {
  if (job && job.state === 'running') throw httpError('A move is already running. Wait until it is done.', 409);
  const p = (await paths.pools()).find((x) => x.name === String(pool || ''));
  if (!p) throw httpError('Choose a pool.', 400);
  const from = paths.exists('appdata') ? paths.dir('appdata') : null;
  const to = path.join(p.mountpoint, 'appdata');
  if (from === to) throw httpError('The app data is already on ' + p.name + '.', 400);
  if (from && under(to, from)) throw httpError('The new folder cannot be inside the old one.', 400);

  // No app data yet (or the folder is gone)? Then there is nothing to move: just set it.
  if (!from) {
    if (!fs.existsSync(to)) { await run('zfs', ['create', p.name + '/appdata'], { timeout: 30000 }); try { fs.chownSync(to, APP_UID, APP_GID); } catch { /* not root */ } }
    paths.save({ appdata: to });
    return { done: true, migration: null };
  }
  // Folders with the same name in the new folder: don't overwrite.
  if (fs.existsSync(to)) {
    const clash = fs.readdirSync(from).filter((n) => fs.existsSync(path.join(to, n)));
    if (clash.length) throw httpError(`${to} already contains folders with the same name: ${clash.slice(0, 5).join(', ')}. Move or remove them first.`, 409);
  }
  const used = await appsUsing(from);
  job = { from, to, state: 'running', step: 'prepare', percent: 0, error: null, lines: [], manual: used.manual, started: new Date().toISOString(), finished: null };
  runMigration(p, used).catch(() => {});
  return { started: true, migration: status() };
}

async function runMigration(p, { projects, manual }) {
  const { from, to } = job;
  const stopped = [];
  let switched = false;
  try {
    if (!fs.existsSync(to)) {
      log(`Creating folder ${to}…`);
      await run('zfs', ['create', p.name + '/appdata'], { timeout: 30000 });
    }
    try { const st = fs.statSync(from); fs.chownSync(to, st.uid, st.gid); fs.chmodSync(to, st.mode & 0o7777); } catch { /* not root */ }

    job.step = 'stop';
    for (const pr of projects) {
      log(`Stopping ${pr.project}…`);
      await run('docker', [...composeBase(pr), 'stop'], { timeout: 5 * 60000 });
      stopped.push(pr);
    }
    if (manual.length) log(`No compose file on the server (they keep using the old folder): ${manual.join(', ')}`);

    job.step = 'copy';
    log(`Copying from ${from} to ${to}…`);
    let last = '';
    await runStream('rsync', ['-aHAX', '--numeric-ids', '--info=progress2', '--no-inc-recursive', from + '/', to + '/'], (line) => {
      const m = line.match(/\s(\d{1,3})%\s/);
      if (m) job.percent = Math.min(99, Number(m[1]));
      else if (line.trim() && line !== last) { last = line; log(line.trim()); }
    }, { timeout: 24 * 3600000 });
    job.percent = 100;

    job.step = 'compose';
    for (const pr of projects) {
      for (const f of pr.files) {
        let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        const next = replacePath(text, from, to);
        if (next === text) continue;
        fs.copyFileSync(f, f + '.bak');
        fs.writeFileSync(f, next);
        log(`Changed: ${f} (backup copy: ${path.basename(f)}.bak)`);
      }
    }
    paths.save({ appdata: to });
    switched = true;

    job.step = 'start';
    for (const pr of projects) {
      log(pr.running ? `Starting ${pr.project}…` : `Recreating ${pr.project}…`);
      await run('docker', [...composeBase(pr), 'up', ...(pr.running ? ['-d'] : ['--no-start']), '--force-recreate'], { timeout: 10 * 60000 });
    }
    job.state = 'done'; job.step = 'done';
    log(`Done. The old folder ${from} stays: remove it yourself when everything works.`);
  } catch (e) {
    job.state = 'failed'; job.error = e.message;
    log('Failed: ' + e.message);
    if (!switched) {
      // Back to how it was: start the apps that were running again with the old folder.
      for (const pr of stopped.filter((x) => x.running)) await run('docker', [...composeBase(pr), 'start'], { timeout: 5 * 60000 }).catch(() => {});
      log(`The apps still use ${from}. What was already copied is in ${to}.`);
    }
  } finally { job.finished = new Date().toISOString(); }
}


/* ---- the default folders to another pool (a second pool: move them instead of making them twice) */
const MOVABLE = ['appdata', 'media', 'isos', 'vms', 'shares'];
const virsh = (args, timeout = 30000) => run('virsh', ['-c', 'qemu:///system', ...args], { timeout });

// Where the default folders are now: app data, VM disks, ISOs and new shared folders (Settings → Storage), and the
// media and backups datasets of a pool. [{kind, path, pool}]
async function homeFolders() {
  const pools = await paths.pools().catch(() => []);
  const poolOf = (p) => (pools.filter((x) => under(p, x.mountpoint)).sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0] || {}).name || null;
  const out = [];
  for (const kind of ['appdata', 'isos', 'vms']) if (paths.exists(kind)) out.push({ kind, path: paths.dir(kind), pool: poolOf(paths.dir(kind)) });
  for (const f of ['media', 'backups']) {
    const p = pools.find((x) => fs.existsSync(path.join(x.mountpoint, f)));
    if (p) out.push({ kind: f, path: path.join(p.mountpoint, f), pool: p.name });
  }
  if (paths.exists('shares')) out.push({ kind: 'shares', path: paths.dir('shares'), pool: poolOf(paths.dir('shares')) });
  return out.filter((x) => x.pool);
}

// Can these folders move now? Checked before a pool is even created, so a refusal costs nothing.
async function checkMove(kinds) {
  const list = [...new Set((kinds || []).map(String))];
  if (!list.length) return [];
  if (list.includes('backups')) throw httpError('The backups can\'t move along: devices and the backup app use that folder. They stay where they are.', 400);
  if (list.some((k) => !MOVABLE.includes(k))) throw httpError('Unknown kind of folder.', 400);
  if (job && job.state === 'running') throw httpError('A move is already running. Wait until it is done.', 409);
  if (list.includes('vms')) {
    const running = (await virsh(['list', '--name']).catch(() => '')).split('\n').map((x) => x.trim()).filter(Boolean);
    if (running.length) throw httpError(`Shut down the VMs first, then their disks can move: ${running.join(', ')}.`, 409);
    const all = (await virsh(['list', '--all', '--name']).catch(() => '')).split('\n').map((x) => x.trim()).filter(Boolean);
    for (const vm of all) {
      const snaps = (await virsh(['snapshot-list', vm, '--name']).catch(() => '')).split('\n').map((x) => x.trim()).filter(Boolean);
      if (snaps.length) throw httpError(`${vm} has snapshots. Remove them first (they point to the old disks), then the VM disks can move.`, 409);
    }
  }
  return list;
}

// Move the chosen default folders to a pool, as one job (the same progress as moving the app data): datasets on the
// new pool, stop the apps that use them, rsync, compose files, shared folders and VM settings to the new paths,
// Settings → Storage, start the apps. The old folders always stay.
async function migrateFolders(pool, kinds) {
  const list = await checkMove(kinds);
  const p = (await paths.pools()).find((x) => x.name === String(pool || ''));
  if (!p || !POOL.test(p.name)) throw httpError('Choose a pool.', 400);
  const homes = await homeFolders();
  const items = list.map((kind) => {
    const h = homes.find((x) => x.kind === kind);
    const to = kind === 'shares' ? p.mountpoint : path.join(p.mountpoint, kind === 'appdata' ? 'appdata' : kind);
    return h && h.path !== to ? { kind, from: h.path, to, dataset: kind === 'shares' ? null : p.name + '/' + path.basename(to) } : null;
  }).filter(Boolean);
  for (const it of items) {
    if (it.kind === 'shares' || !fs.existsSync(it.to)) continue;
    const clash = fs.readdirSync(it.from).filter((n) => fs.existsSync(path.join(it.to, n)));
    if (clash.length) throw httpError(`${it.to} already contains folders with the same name: ${clash.slice(0, 5).join(', ')}. Move or remove them first.`, 409);
  }
  if (!items.length) return { started: false, migration: status() };
  const copies = items.filter((x) => x.kind !== 'shares');
  const used = { projects: [], manual: [] };
  for (const it of copies) {
    const u = await appsUsing(it.from);
    for (const pr of u.projects) if (!used.projects.some((x) => x.project === pr.project)) used.projects.push(pr);
    for (const m of u.manual) if (!used.manual.includes(m)) used.manual.push(m);
  }
  const first = copies[0] || items[0];
  job = { from: first.from, to: first.to, items: items.map(({ kind, from, to }) => ({ kind, from, to, state: 'waiting' })), state: 'running', step: 'prepare',
    percent: 0, error: null, lines: [], manual: used.manual, started: new Date().toISOString(), finished: null };
  runFolders(items, used).catch(() => {});
  return { started: true, migration: status() };
}

async function runFolders(items, { projects, manual }) {
  const copies = items.filter((x) => x.kind !== 'shares');
  const mark = (it, state) => { const x = job.items.find((y) => y.kind === it.kind); if (x) x.state = state; };
  const stopped = [];
  let switched = false;
  try {
    for (const it of copies) {
      if (fs.existsSync(it.to)) continue;
      log(`Creating folder ${it.to}…`);
      // A dataset on ZFS; a pool with mixed disks has no datasets, so a plain folder there.
      await run('zfs', ['create', it.dataset], { timeout: 30000 }).catch(() => fs.mkdirSync(it.to, { recursive: true }));
      try { const st = fs.statSync(it.from); fs.chownSync(it.to, st.uid, st.gid); fs.chmodSync(it.to, st.mode & 0o7777); } catch { /* not root */ }
    }
    job.step = 'stop';
    for (const pr of projects) {
      log(`Stopping ${pr.project}…`);
      await run('docker', [...composeBase(pr), 'stop'], { timeout: 5 * 60000 });
      stopped.push(pr);
    }
    if (manual.length) log(`No compose file on the server (they keep using the old folder): ${manual.join(', ')}`);

    job.step = 'copy';
    for (let i = 0; i < copies.length; i++) {
      const it = copies[i];
      job.from = it.from; job.to = it.to; mark(it, 'running');
      log(`Copying from ${it.from} to ${it.to}…`);
      let last = '';
      await runStream('rsync', ['-aHAX', '--numeric-ids', '--info=progress2', '--no-inc-recursive', it.from + '/', it.to + '/'], (line) => {
        const m = line.match(/\s(\d{1,3})%\s/);
        if (m) job.percent = Math.min(99, Math.round(((i + Number(m[1]) / 100) / copies.length) * 100));
        else if (line.trim() && line !== last) { last = line; log(line.trim()); }
      }, { timeout: 24 * 3600000 });
      mark(it, 'done');
    }
    job.percent = 100;

    job.step = 'compose';
    for (const pr of projects) {
      for (const f of pr.files) {
        let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        const next = copies.reduce((t, it) => replacePath(t, it.from, it.to), text);
        if (next === text) continue;
        fs.copyFileSync(f, f + '.bak');
        fs.writeFileSync(f, next);
        log(`Changed: ${f} (backup copy: ${path.basename(f)}.bak)`);
      }
    }
    // Shared folders (e.g. media) and the VMs' disks and ISOs point to the new place.
    for (const it of copies) {
      const moved = await require('./shares').movePaths(it.from, it.to).catch((e) => { log(`Shared folders: ${e.message}`); return []; });
      if (moved.length) log(`Shared folders now in ${it.to}: ${moved.join(', ')}`);
    }
    const vmMoves = copies.filter((x) => x.kind === 'vms' || x.kind === 'isos');
    if (vmMoves.length) {
      const all = (await virsh(['list', '--all', '--name']).catch(() => '')).split('\n').map((x) => x.trim()).filter(Boolean);
      for (const vm of all) {
        const xml = await virsh(['dumpxml', '--security-info', vm]);
        const next = vmMoves.reduce((t, it) => replacePath(t, it.from, it.to), xml);
        if (next === xml) continue;
        const tmp = path.join(process.env.DATA_DIR || '/var/lib/majaos', `move-${process.pid}.xml`);
        fs.writeFileSync(tmp, next, { mode: 0o600 });
        try { await virsh(['define', tmp]); log(`VM ${vm} now uses the new folder.`); } finally { fs.rmSync(tmp, { force: true }); }
      }
    }
    const save = {};
    for (const it of items) if (['appdata', 'isos', 'vms', 'shares'].includes(it.kind)) save[it.kind] = it.to;
    paths.save(save);
    items.filter((x) => x.kind === 'shares').forEach((it) => { mark(it, 'done'); log(`New shared folders go to ${it.to}.`); });
    switched = true;

    job.step = 'start';
    for (const pr of projects) {
      log(pr.running ? `Starting ${pr.project}…` : `Recreating ${pr.project}…`);
      await run('docker', [...composeBase(pr), 'up', ...(pr.running ? ['-d'] : ['--no-start']), '--force-recreate'], { timeout: 10 * 60000 });
    }
    job.state = 'done'; job.step = 'done';
    log(`Done. The old folders stay (${copies.map((x) => x.from).join(', ') || '–'}): remove them yourself when everything works.`);
  } catch (e) {
    job.state = 'failed'; job.error = e.message;
    log('Failed: ' + e.message);
    if (!switched) {
      for (const pr of stopped.filter((x) => x.running)) await run('docker', [...composeBase(pr), 'start'], { timeout: 5 * 60000 }).catch(() => {});
      log('Everything still uses the old folders. What was already copied stays in the new ones.');
    }
  } finally { job.finished = new Date().toISOString(); }
}

module.exports = { overview, setLocation, usePath, migrateAppdata, homeFolders, checkMove, migrateFolders, status, appsUsing, groupContainers, replacePath };
