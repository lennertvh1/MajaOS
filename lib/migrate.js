'use strict';
/*
 * Opslaglocaties (Instellingen → Opslag) en appgegevens verhuizen naar een andere pool.
 * Verhuizen: de apps die een map in de appgegevens gebruiken stoppen, alles kopiëren met rsync,
 * de paden in hun compose-bestanden vervangen (met .bak), de nieuwe map instellen en de apps opnieuw aanmaken.
 * De oude map blijft staan: verwijder ze zelf als alles werkt.
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

// Vervang een pad door een ander, maar alleen als volledig pad (niet /tank/appdata2 bij /tank/appdata).
function replacePath(text, from, to) {
  return text.replace(new RegExp(escRe(from) + '(?=$|[/"\'\\s:,\\]}])', 'gm'), to);
}

// Welke containers een map in dir gebruiken. Met compose: per project (stoppen en opnieuw aanmaken kan),
// zonder compose, of met een compose-bestand dat niet op de server staat (bv. Portainer bewaart het in zijn
// eigen container): alleen melden (die blijven de oude map gebruiken).
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

// Een pool kiezen voor VM-schijven, ISO's of gedeelde mappen. Bestaande bestanden verhuizen niet mee.
async function setLocation(kind, pool) {
  if (!['vms', 'isos', 'shares'].includes(kind)) throw httpError('Onbekende soort map.', 400);
  const p = (await paths.pools()).find((x) => x.name === String(pool || ''));
  if (!p || !POOL.test(p.name)) throw httpError('Kies een pool.', 400);
  const target = path.join(p.mountpoint, paths.FOLDER[kind]);
  if (!fs.existsSync(target)) await run('zfs', ['create', p.name + '/' + paths.FOLDER[kind]], { timeout: 30000 });
  paths.save({ [kind]: target });
  return overview();
}

// Een bestaande map zelf aanwijzen (bv. waar je appgegevens al staan). Er verhuist niets.
const SYSTEM = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/tmp', '/usr', '/var'];
function usePath(kind, dir) {
  if (!paths.KINDS.includes(kind)) throw httpError('Onbekende soort map.', 400);
  const raw = String(dir || '').trim();
  if (!path.isAbsolute(raw) || /[\r\n]/.test(raw)) throw httpError('Kies een volledig pad, bv. /tank/appdata.', 400);
  const p = path.resolve(raw);
  if (SYSTEM.includes(p) || ['/proc', '/sys', '/dev', '/etc', '/usr', '/boot', '/run'].some((x) => p.startsWith(x + '/'))) throw httpError('Kies een map op een van je pools, niet een map van het systeem.', 400);
  let st = null;
  try { st = fs.statSync(p); } catch { /* bestaat niet */ }
  if (!st || !st.isDirectory()) throw httpError(`De map ${p} bestaat niet.`, 400);
  paths.save({ [kind]: p });
  return overview();
}

/* ---- appgegevens verhuizen: één taak tegelijk, voortgang in het geheugen */
let job = null;
function status() {
  if (!job) return null;
  const { from, to, state, step, percent, error, lines, manual, started, finished } = job;
  return { from, to, state, step, percent, error, lines, manual, started, finished };
}
function log(line) { job.lines.push(line); if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200); }

async function migrateAppdata(pool) {
  if (job && job.state === 'running') throw httpError('Er loopt al een verhuis. Wacht tot die klaar is.', 409);
  const p = (await paths.pools()).find((x) => x.name === String(pool || ''));
  if (!p) throw httpError('Kies een pool.', 400);
  const from = paths.exists('appdata') ? paths.dir('appdata') : null;
  const to = path.join(p.mountpoint, 'appdata');
  if (from === to) throw httpError('De appgegevens staan al op ' + p.name + '.', 400);
  if (from && under(to, from)) throw httpError('De nieuwe map mag niet in de oude liggen.', 400);

  // Nog geen appgegevens (of de map is weg)? Dan is er niets te verhuizen: gewoon instellen.
  if (!from) {
    if (!fs.existsSync(to)) { await run('zfs', ['create', p.name + '/appdata'], { timeout: 30000 }); try { fs.chownSync(to, APP_UID, APP_GID); } catch { /* geen root */ } }
    paths.save({ appdata: to });
    return { done: true, migration: null };
  }
  // Mappen met dezelfde naam in de nieuwe map: niet overschrijven.
  if (fs.existsSync(to)) {
    const clash = fs.readdirSync(from).filter((n) => fs.existsSync(path.join(to, n)));
    if (clash.length) throw httpError(`In ${to} staan al mappen met dezelfde naam: ${clash.slice(0, 5).join(', ')}. Verplaats of verwijder ze eerst.`, 409);
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
      log(`Map ${to} aanmaken…`);
      await run('zfs', ['create', p.name + '/appdata'], { timeout: 30000 });
    }
    try { const st = fs.statSync(from); fs.chownSync(to, st.uid, st.gid); fs.chmodSync(to, st.mode & 0o7777); } catch { /* geen root */ }

    job.step = 'stop';
    for (const pr of projects) {
      log(`${pr.project} stoppen…`);
      await run('docker', [...composeBase(pr), 'stop'], { timeout: 5 * 60000 });
      stopped.push(pr);
    }
    if (manual.length) log(`Geen compose-bestand op de server (blijven de oude map gebruiken): ${manual.join(', ')}`);

    job.step = 'copy';
    log(`Kopiëren van ${from} naar ${to}…`);
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
        log(`Aangepast: ${f} (reservekopie: ${path.basename(f)}.bak)`);
      }
    }
    paths.save({ appdata: to });
    switched = true;

    job.step = 'start';
    for (const pr of projects) {
      log(`${pr.project} ${pr.running ? 'starten' : 'opnieuw aanmaken'}…`);
      await run('docker', [...composeBase(pr), 'up', ...(pr.running ? ['-d'] : ['--no-start']), '--force-recreate'], { timeout: 10 * 60000 });
    }
    job.state = 'done'; job.step = 'done';
    log(`Klaar. De oude map ${from} blijft staan: verwijder ze zelf als alles werkt.`);
  } catch (e) {
    job.state = 'failed'; job.error = e.message;
    log('Mislukt: ' + e.message);
    if (!switched) {
      // Terug zoals het was: de apps die draaiden, weer starten met de oude map.
      for (const pr of stopped.filter((x) => x.running)) await run('docker', [...composeBase(pr), 'start'], { timeout: 5 * 60000 }).catch(() => {});
      log(`De apps gebruiken nog altijd ${from}. Wat al gekopieerd was, staat in ${to}.`);
    }
  } finally { job.finished = new Date().toISOString(); }
}

module.exports = { overview, setLocation, usePath, migrateAppdata, status, appsUsing, groupContainers, replacePath };
