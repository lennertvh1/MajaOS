'use strict';
/* Apps: Docker-containers via de Unix-socket van Docker. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, httpError } = require('./system');
const { toYaml } = require('./yaml');
const composeForm = require('./composeform');
const registry = require('./registry');

const SOCK = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const OVR_FILE = path.join(DATA_DIR, 'apps.json'); // eigen instellingen per app (op containernaam)

/* ---- updates: digest van de registry vergelijken met die van het image waarop de container draait */
const UPD_FILE = path.join(DATA_DIR, 'updates.json');
const UPD_MAX_AGE = 6 * 3600 * 1000;
let updState = null; // ref → { imageId, checked, update: true|false|null, error }
function updates() { if (!updState) { try { updState = JSON.parse(fs.readFileSync(UPD_FILE, 'utf8')); } catch { updState = {}; } } return updState; }
function saveUpdates() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(UPD_FILE, JSON.stringify(updState)); } catch { /* volgende keer */ } }
function updateInfo(ref, imageId) {
  const s = updates()[ref];
  return s && s.imageId === imageId ? s : null; // ander image (bv. net bijgewerkt): opnieuw controleren
}

let checking = null, lastCheck = 0;
// Alle images controleren. force: ook wat nog geen 6 uur geleden gecontroleerd is.
function checkUpdates(force = false) {
  if (checking) return checking;
  checking = (async () => {
    const list = await docker('GET', '/containers/json?all=1');
    const infos = (await Promise.all(list.map((c) => docker('GET', '/containers/' + c.Id + '/json').catch(() => null)))).filter(Boolean);
    const todo = new Map();
    infos.forEach((i) => { if (i.Config && i.Config.Image) todo.set(i.Config.Image, i.Image); });
    const st = updates(); const now = Date.now(); let found = 0; const errors = [];
    const queue = [...todo].filter(([ref, id]) => force || !st[ref] || st[ref].imageId !== id || now - st[ref].checked > UPD_MAX_AGE);
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const [ref, imageId] = job;
        let entry = { imageId, checked: Date.now(), update: null, error: null };
        try {
          const img = await docker('GET', '/images/' + encodeURIComponent(imageId) + '/json');
          const local = (img.RepoDigests || []).map((d) => d.slice(d.indexOf('@') + 1));
          if (!local.length) entry.error = 'zelf gebouwd image: geen versie in een registry';
          else {
            const remote = await registry.remoteDigest(ref);
            if (remote) entry.update = !local.includes(remote); else entry.error = 'vastgezet op een digest';
          }
        } catch (e) { entry.error = e.message; }
        st[ref] = entry;
        if (entry.update) found++;
        if (entry.error && entry.update === null && !/zelf gebouwd|vastgezet/.test(entry.error)) errors.push(ref + ': ' + entry.error);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]); // 4 tegelijk
    saveUpdates(); lastCheck = Date.now();
    const total = Object.entries(st).filter(([ref]) => todo.has(ref) && st[ref].update).length;
    return { checked: todo.size, updates: total, errors };
  })().finally(() => { checking = null; });
  return checking;
}
function forgetUpdate(ref) { const st = updates(); if (st[ref]) { delete st[ref]; saveUpdates(); } }

function readOverrides() { try { return JSON.parse(fs.readFileSync(OVR_FILE, 'utf8')); } catch { return {}; } }
function writeOverrides(o) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OVR_FILE + '.tmp', JSON.stringify(o, null, 2));
  fs.renameSync(OVR_FILE + '.tmp', OVR_FILE);
}

function dockerRaw(method, path, timeout = 30000, body = null) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {};
    const req = http.request({ socketPath: SOCK, path, method, timeout, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(httpError('Docker reageerde niet op tijd.', 504)));
    req.on('error', (e) => reject(e.status ? e : httpError('Docker is niet bereikbaar. Draait de Docker-service?', 503)));
    req.end(data);
  });
}
async function docker(method, path, body) {
  const { status, buf } = await dockerRaw(method, path, 30000, body);
  let data = null;
  try { data = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { /* geen JSON */ }
  if (status >= 400) throw httpError((data && data.message) || 'Docker gaf fout ' + status, status === 404 ? 404 : 502);
  return data;
}

// [IP] blijft staan (dat vult de browser in), [PORT:80] wordt de poort op de server die aan poort 80 in de app hangt.
// Heeft de app een eigen adres in je thuisnetwerk (macvlan/ipvlan), dan is dat [IP] en blijft de poort die van de app.
function webui(labels, ports, override, ownIp) {
  const tpl = override || labels['homebaseos.webui'];
  if (tpl && ownIp) return tpl.replace(/\[IP\]/g, ownIp).replace(/\[PORT:(\d+)\]/g, '$1');
  if (ownIp) return null;
  if (tpl) {
    return tpl.replace(/\[PORT:(\d+)\]/g, (_, p) => {
      const m = ports.find((x) => String(x.private) === p);
      return m ? String(m.public) : p;
    });
  }
  const p = ports.find((x) => String(x.type).toLowerCase() === 'tcp');
  return p ? 'http://[IP]:' + p.public + '/' : null;
}

// Docker meldt elke poort twee keer (IPv4 en IPv6).
function publicPorts(list) {
  const seen = new Set();
  return (list || []).filter((p) => p.PublicPort).map((p) => ({ public: p.PublicPort, private: p.PrivatePort, type: String(p.Type).toUpperCase() }))
    .filter((p) => { const k = p.public + '/' + p.type; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Het eigen adres van een container in een macvlan- of ipvlan-netwerk.
function ownAddress(info, drivers) {
  const nets = (info && info.NetworkSettings && info.NetworkSettings.Networks) || {};
  const hit = Object.entries(nets).find(([n, v]) => OWN_IP_DRIVERS.has(drivers[n]) && v && v.IPAddress);
  return hit ? hit[1].IPAddress : null;
}
const OWN_IP_DRIVERS = new Set(['macvlan', 'ipvlan']);
async function networkDrivers() {
  const list = await docker('GET', '/networks').catch(() => []);
  return Object.fromEntries((list || []).map((n) => [n.Name, n.Driver]));
}

async function listApps() {
  const list = await docker('GET', '/containers/json?all=1');
  const [inspected, drivers] = await Promise.all([
    Promise.all(list.map((c) => docker('GET', '/containers/' + c.Id + '/json').catch(() => null))), networkDrivers()]);
  const ovr = readOverrides();
  return list.map((c, i) => {
    const ins = inspected[i] || {};
    const ref = (ins.Config && ins.Config.Image) || c.Image;
    const upd = updateInfo(ref, ins.Image || c.ImageID);
    const labels = c.Labels || {};
    const ports = publicPorts(c.Ports);
    const name = (c.Names && c.Names[0] ? c.Names[0] : c.Id.slice(0, 12)).replace(/^\//, '');
    const o = ovr[name] || {};
    const rp = inspected[i] && inspected[i].HostConfig && inspected[i].HostConfig.RestartPolicy;
    return {
      id: c.Id, name,
      state: String(c.State).toUpperCase(), status: c.Status,
      autoStart: !!rp && (rp.Name === 'always' || rp.Name === 'unless-stopped'),
      icon: o.icon || labels['homebaseos.icon'] || null, webui: webui(labels, ports, o.webui, ownAddress(ins, drivers)), ports,
      compose: labels['com.docker.compose.project'] || null,
      canUpdate: !!(labels['com.docker.compose.project'] && labels['com.docker.compose.service']),
      storeId: labels['homebaseos.store'] || null, // geïnstalleerd via de appstore
      custom: labels['homebaseos.custom'] === '1', // eigen app, gemaakt met HomeBaseOS
      dataDirs: (labels['homebaseos.data'] || '').split(',').filter(Boolean),
      image: ref, update: upd ? upd.update : null, updateChecked: upd ? upd.checked : null, updateError: upd ? upd.error : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Zonder TTY verpakt Docker elke logregel in een kop van 8 bytes: [stroom, 0, 0, 0, lengte (4 bytes)].
function demuxLogs(buf) {
  const multiplexed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!multiplexed) return buf.toString('utf8');
  let out = ''; let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out += buf.toString('utf8', i + 8, Math.min(buf.length, i + 8 + len));
    i += 8 + len;
  }
  return out;
}
function parseLogLines(text) {
  return text.split('\n').filter((l) => l.trim()).map((l) => {
    const m = l.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?(.*)$/);
    return m ? { timestamp: m[1], message: m[2] } : { timestamp: null, message: l };
  });
}
async function logs(id, tail) {
  const { status, buf } = await dockerRaw('GET', '/containers/' + encodeURIComponent(id) + '/logs?stdout=1&stderr=1&timestamps=1&tail=' + tail);
  if (status >= 400) throw httpError('Logboek niet beschikbaar (Docker gaf fout ' + status + ').', 502);
  return parseLogLines(demuxLogs(buf));
}

// Bijwerken: nieuwste image ophalen en de container opnieuw aanmaken via zijn compose-project.
async function updateApp(id) {
  const info = await docker('GET', '/containers/' + encodeURIComponent(id) + '/json');
  const l = (info.Config && info.Config.Labels) || {};
  const project = l['com.docker.compose.project'], service = l['com.docker.compose.service'];
  if (!project || !service) throw httpError('Bijwerken kan alleen voor apps die met Docker Compose gestart zijn.', 400);
  const files = (l['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean);
  const base = ['compose', '-p', project];
  if (l['com.docker.compose.project.working_dir']) base.push('--project-directory', l['com.docker.compose.project.working_dir']);
  files.forEach((f) => base.push('-f', f));
  await run('docker', [...base, 'pull', service], { timeout: 15 * 60000 });
  await run('docker', [...base, 'up', '-d', service], { timeout: 5 * 60000 });
}

async function appAction(id, action) {
  if (action === 'update') {
    await updateApp(id);
    // Meteen opnieuw controleren, zodat de melding "update beschikbaar" verdwijnt.
    const info = await inspect(id).catch(() => null);
    if (info) { forgetUpdate(info.Config.Image); checkUpdates(false).catch(() => {}); }
    return;
  }
  const { status, buf } = await dockerRaw('POST', '/containers/' + encodeURIComponent(id) + '/' + action, 90000);
  if (status >= 400) {
    let msg = ''; try { msg = JSON.parse(buf.toString('utf8')).message; } catch { /* leeg */ }
    throw httpError(msg || 'Docker gaf fout ' + status, 502);
  }
}

/* ---- instellingen per app */

async function inspect(id) { return docker('GET', '/containers/' + encodeURIComponent(id) + '/json'); }
const nameOf = (info) => String(info.Name || '').replace(/^\//, '');
function portsOf(info) {
  const out = []; const seen = new Set();
  Object.entries((info.NetworkSettings && info.NetworkSettings.Ports) || {}).forEach(([k, binds]) => {
    const [priv, type] = k.split('/');
    (binds || []).forEach((b) => {
      const key = b.HostPort + '/' + type; if (!b.HostPort || seen.has(key)) return; seen.add(key);
      out.push({ public: Number(b.HostPort), private: Number(priv), type: String(type).toUpperCase() });
    });
  });
  return out;
}
function composeOf(labels) {
  const project = labels['com.docker.compose.project'];
  if (!project) return null;
  const files = (labels['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean);
  const file = files.length === 1 ? files[0] : null;
  let text = null;
  if (file) { try { text = fs.readFileSync(file, 'utf8'); } catch { /* niet leesbaar */ } }
  return { project, service: labels['com.docker.compose.service'] || null, files, file,
    workingDir: labels['com.docker.compose.project.working_dir'] || (file && path.dirname(file)), editable: text != null, text };
}

async function appSettings(id) {
  const [info, drivers] = await Promise.all([inspect(id), networkDrivers()]);
  const labels = (info.Config && info.Config.Labels) || {};
  const name = nameOf(info), o = readOverrides()[name] || {};
  const ports = portsOf(info);
  const rp = (info.HostConfig && info.HostConfig.RestartPolicy) || {};
  return {
    name, image: info.Config && info.Config.Image, ports, restartPolicy: rp.Name || 'no',
    autoStart: rp.Name === 'always' || rp.Name === 'unless-stopped',
    webui: o.webui || '', webuiDefault: labels['homebaseos.webui'] || '', webuiAuto: webui(labels, ports, null, ownAddress(info, drivers)),
    icon: o.icon || '', iconDefault: labels['homebaseos.icon'] || '',
    compose: await withForm(composeOf(labels)),
  };
}
// Het formulier lukt niet altijd (bv. ${VARIABELEN} in poorten): dan blijft alleen de tekstmodus.
async function withForm(c) {
  if (!c || !c.editable || !c.service) return c;
  try {
    const [project, nets] = await Promise.all([composeForm.loadProject(c), docker('GET', '/networks').catch(() => [])]);
    // Netwerken die je in het formulier kan kiezen (de ingebouwde staan er al apart in).
    const dockerNetworks = (nets || []).filter((n) => !['bridge', 'host', 'none'].includes(n.Name) && n.Scope === 'local')
      .map((n) => ({ name: n.Name, driver: n.Driver, subnet: ((n.IPAM && n.IPAM.Config) || []).map((x) => x.Subnet).find(Boolean) || null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ...c, form: composeForm.serviceForm(project, c.service), dockerNetworks };
  }
  catch (e) { return { ...c, form: null, formError: e.message }; }
}

const URLISH = /^(https?:\/\/|\[IP\])/i;
async function saveAppSettings(id, body) {
  const info = await inspect(id);
  const name = nameOf(info);
  const webuiVal = String(body.webui || '').trim(), iconVal = String(body.icon || '').trim();
  if (webuiVal && !URLISH.test(webuiVal)) throw httpError('Het adres van de webinterface moet beginnen met http:// of https://, bv. http://[IP]:[PORT:8080]/', 400);
  if (iconVal && !/^https?:\/\//i.test(iconVal)) throw httpError('Het pictogram moet een adres zijn dat begint met http:// of https://.', 400);
  const all = readOverrides();
  const entry = { ...(all[name] || {}) };
  if (webuiVal) entry.webui = webuiVal; else delete entry.webui;
  if (iconVal) entry.icon = iconVal; else delete entry.icon;
  if (Object.keys(entry).length) all[name] = entry; else delete all[name];
  writeOverrides(all);
  if (body.autoStart != null) {
    const rp = (info.HostConfig && info.HostConfig.RestartPolicy && info.HostConfig.RestartPolicy.Name) || 'no';
    const on = rp === 'always' || rp === 'unless-stopped';
    if (!!body.autoStart !== on) await run('docker', ['update', '--restart', body.autoStart ? 'unless-stopped' : 'no', info.Id]);
  }
  return { ok: true };
}

async function editableCompose(id) {
  const info = await inspect(id);
  const c = composeOf((info.Config && info.Config.Labels) || {});
  if (!c || !c.editable) throw httpError('Deze app heeft geen compose-bestand dat HomeBaseOS kan aanpassen.', 400);
  return c;
}
async function saveCompose(id, text) { return writeCompose(await editableCompose(id), text); }

// Formulier opslaan: het hele bestand opnieuw schrijven met de aangepaste dienst.
async function saveComposeForm(id, form) {
  const c = await editableCompose(id);
  if (!c.service) throw httpError('HomeBaseOS weet niet welke dienst in het compose-bestand bij deze app hoort.', 400);
  const project = composeForm.applyServiceForm(await composeForm.loadProject(c), { ...form, service: c.service });
  const header = '# Bewerkt met HomeBaseOS op ' + new Date().toLocaleString('nl-BE') + '. De vorige versie staat in ' + path.basename(c.file) + '.bak.\n';
  return writeCompose(c, header + toYaml(project) + '\n');
}

// Compose-bestand vervangen: eerst laten controleren door docker compose, dan een reservekopie, dan opnieuw starten.
async function writeCompose(c, text) {
  const body = String(text || '');
  if (!body.trim() || body.length > 512 * 1024) throw httpError('Het compose-bestand is leeg of te groot.', 400);
  const tmp = path.join(path.dirname(c.file), '.homebaseos-controle-' + crypto.randomBytes(4).toString('hex') + '.yaml');
  fs.writeFileSync(tmp, body);
  try { await run('docker', ['compose', '-p', c.project, '--project-directory', c.workingDir, '-f', tmp, 'config', '-q'], { timeout: 30000 }); }
  catch (e) { throw httpError('Het compose-bestand klopt niet: ' + e.message, 400); }
  finally { fs.rmSync(tmp, { force: true }); }
  fs.copyFileSync(c.file, c.file + '.bak');
  fs.writeFileSync(c.file, body);
  try { await run('docker', ['compose', '-p', c.project, '--project-directory', c.workingDir, '-f', c.file, 'up', '-d'], { timeout: 10 * 60000 }); }
  catch (e) { throw httpError('Opgeslagen, maar opnieuw starten lukte niet: ' + e.message + ' De vorige versie staat in ' + c.file + '.bak.', 502); }
  return { ok: true, backup: c.file + '.bak' };
}

// Console: één commando per keer met sh in de container. De map ($PWD) geven we telkens mee terug.
const EXEC_SCRIPT = 'cd -- "$1" 2>/dev/null || cd /; eval "$2" 2>&1; s=$?; printf "\\n\\001%s" "$PWD"; exit $s';
async function execIn(id, cmd, cwd) {
  const command = String(cmd || '');
  if (!command.trim()) throw httpError('Typ een commando.', 400);
  if (command.length > 4000) throw httpError('Dat commando is te lang.', 400);
  const info = await inspect(id);
  if (!info.State || !info.State.Running) throw httpError('Start de app eerst. De console werkt alleen als de app draait.', 409);
  let r;
  try { r = await run('docker', ['exec', info.Id, 'sh', '-c', EXEC_SCRIPT, 'sh', String(cwd || '/'), command], { timeout: 30000, full: true }); }
  catch (e) { throw e.status === 504 ? httpError('Het commando liep langer dan 30 seconden en is afgebroken.', 504) : e; }
  return parseExec(r, cwd);
}
// Na de uitvoer van het commando volgt "\n\x01<map>". Ontbreekt dat, dan kon sh niet eens starten.
function parseExec(r, cwd) {
  const i = r.stdout.lastIndexOf('\n\u0001');
  if (i < 0) {
    if (/executable file not found|no such file or directory/i.test(r.stderr)) throw httpError('Deze app heeft geen shell (sh). Een console is daarom niet mogelijk.', 400);
    return { output: (r.stdout + r.stderr).slice(-200000), cwd: cwd || '/', exitCode: r.code };
  }
  const out = r.stdout.slice(0, i).replace(/\n$/, ''); // het laatste regeleinde van het commando zelf
  return { output: out.slice(-200000), cwd: r.stdout.slice(i + 2).trim() || cwd || '/', exitCode: r.code };
}

module.exports = { docker, listApps, logs, appAction, checkUpdates, lastUpdateCheck: () => lastCheck, appSettings, saveAppSettings, saveCompose, saveComposeForm, execIn, EXEC_SCRIPT, parseExec, demuxLogs, parseLogLines, publicPorts, webui };
