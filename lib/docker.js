'use strict';
/* Apps: Docker containers via Docker's Unix socket. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, httpError } = require('./system');
const { toYaml } = require('./yaml');
const composeForm = require('./composeform');
const registry = require('./registry');

const SOCK = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const OVR_FILE = path.join(DATA_DIR, 'apps.json'); // own settings per app (by container name)

/* ---- updates: compare the registry's digest with that of the image the container runs on */
const UPD_FILE = path.join(DATA_DIR, 'updates.json');
const UPD_MAX_AGE = 6 * 3600 * 1000;
let updState = null; // ref → { imageId, checked, update: true|false|null, error }
function updates() { if (!updState) { try { updState = JSON.parse(fs.readFileSync(UPD_FILE, 'utf8')); } catch { updState = {}; } } return updState; }
function saveUpdates() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(UPD_FILE, JSON.stringify(updState)); } catch { /* next time */ } }
function updateInfo(ref, imageId) {
  const s = updates()[ref];
  return s && s.imageId === imageId ? s : null; // a different image (e.g. just updated): check again
}

let checking = null, lastCheck = 0;
// Check all images. force: also those checked less than 6 hours ago.
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
          if (!local.length) entry.error = 'self-built image: no version in a registry';
          else {
            const remote = await registry.remoteDigest(ref);
            if (remote) entry.update = !local.includes(remote); else entry.error = 'pinned to a digest';
          }
        } catch (e) { entry.error = e.message; }
        st[ref] = entry;
        if (entry.update) found++;
        if (entry.error && entry.update === null && !/self-built|pinned/.test(entry.error)) errors.push(ref + ': ' + entry.error);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]); // 4 at a time
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
    // The local Docker socket, never the network (scanners see a variable path).
    const req = http.request({ socketPath: SOCK, path, method, timeout, headers }, (res) => { // nosec
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(httpError('Docker did not respond in time.', 504)));
    req.on('error', (e) => reject(e.status ? e : httpError('Docker is not reachable. Is the Docker service running?', 503)));
    req.end(data);
  });
}
async function docker(method, path, body) {
  const { status, buf } = await dockerRaw(method, path, 30000, body);
  let data = null;
  try { data = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { /* not JSON */ }
  if (status >= 400) throw httpError((data && data.message) || 'Docker returned error ' + status, status === 404 ? 404 : 502);
  return data;
}

// [IP] stays (the browser fills it in), [PORT:80] becomes the port on the server that is mapped to port 80 in the app.
// If the app has its own address in your home network (macvlan/ipvlan), that is [IP] and the port stays the app's own.
// hostNet: the app uses the server's network, so the app's own port is also the one on the server.
// Own labels are majaos.*. Apps installed before the rename still carry homebaseos.*: read those as the same.
function ownLabels(l) {
  const out = { ...(l || {}) };
  for (const [k, v] of Object.entries(out)) {
    if (k.startsWith('homebaseos.') && !(('majaos.' + k.slice(11)) in out)) out['majaos.' + k.slice(11)] = v;
  }
  return out;
}

function webui(labels, ports, override, ownIp, hostNet = false) {
  const tpl = override || labels['majaos.webui'];
  if (tpl && (ownIp || hostNet)) return tpl.replace(/\[IP\]/g, ownIp || '[IP]').replace(/\[PORT:(\d+)\]/g, '$1');
  if (ownIp) return null;
  const tcp = ports.filter((x) => String(x.type).toLowerCase() === 'tcp');
  if (tpl) {
    // On bridge only a published port is reachable. If the template's port isn't mapped anywhere
    // (e.g. a template for host that you put on bridge), take the only published TCP port.
    return tpl.replace(/\[PORT:(\d+)\]/g, (_, p) => {
      const m = ports.find((x) => String(x.private) === p && String(x.type).toLowerCase() === 'tcp') || ports.find((x) => String(x.private) === p);
      return m ? String(m.public) : tcp.length === 1 ? String(tcp[0].public) : p;
    });
  }
  return tcp.length ? 'http://[IP]:' + tcp[0].public + '/' : null;
}

// Docker reports every port twice (IPv4 and IPv6).
function publicPorts(list) {
  const seen = new Set();
  return (list || []).filter((p) => p.PublicPort).map((p) => ({ public: p.PublicPort, private: p.PrivatePort, type: String(p.Type).toUpperCase() }))
    .filter((p) => { const k = p.public + '/' + p.type; if (seen.has(k)) return false; seen.add(k); return true; });
}

// The own address of a container in a macvlan or ipvlan network.
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
    const labels = ownLabels(c.Labels);
    // If the list has no ports (some Docker versions), take them from inspect.
    const listed = publicPorts(c.Ports), ports = listed.length || !ins.NetworkSettings ? listed : portsOf(ins);
    const hostNet = !!(ins.HostConfig && ins.HostConfig.NetworkMode === 'host');
    const name = (c.Names && c.Names[0] ? c.Names[0] : c.Id.slice(0, 12)).replace(/^\//, '');
    const o = ovr[name] || {};
    const rp = inspected[i] && inspected[i].HostConfig && inspected[i].HostConfig.RestartPolicy;
    return {
      id: c.Id, name,
      state: String(c.State).toUpperCase(), status: c.Status,
      autoStart: !!rp && (rp.Name === 'always' || rp.Name === 'unless-stopped'),
      icon: o.icon || labels['majaos.icon'] || null, webui: webui(labels, ports, o.webui, ownAddress(ins, drivers), hostNet), ports,
      compose: labels['com.docker.compose.project'] || null,
      canUpdate: !!(labels['com.docker.compose.project'] && labels['com.docker.compose.service']),
      storeId: labels['majaos.store'] || null, // installed through the app store
      custom: labels['majaos.custom'] === '1', // own app, created with MajaOS
      dataDirs: (labels['majaos.data'] || '').split(',').filter(Boolean),
      hostPorts: (labels['majaos.listen'] || '').split(',').map(Number).filter((n) => n >= 1 && n <= 65535),
      image: ref, update: upd ? upd.update : null, updateChecked: upd ? upd.checked : null, updateError: upd ? upd.error : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Without a TTY Docker wraps every log line in an 8-byte header: [stream, 0, 0, 0, length (4 bytes)].
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
  if (status >= 400) throw httpError('Logs not available (Docker returned error ' + status + ').', 502);
  return parseLogLines(demuxLogs(buf));
}

// Update: what is needed to pull the newest image and recreate the container through its compose project
// (the job itself runs in lib/appstore.js, with the same progress as installing). The image ref is read before, because
// the container gets a new id when it is recreated.
async function updateTarget(id) {
  const info = await docker('GET', '/containers/' + encodeURIComponent(id) + '/json');
  const l = (info.Config && info.Config.Labels) || {};
  const project = l['com.docker.compose.project'], service = l['com.docker.compose.service'];
  if (!project || !service) throw httpError('Updating only works for apps started with Docker Compose.', 400);
  const files = (l['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean);
  const base = ['compose', '--ansi', 'never', '--progress', 'plain', '-p', project];
  if (l['com.docker.compose.project.working_dir']) base.push('--project-directory', l['com.docker.compose.project.working_dir']);
  files.forEach((f) => base.push('-f', f));
  return { name: nameOf(info), image: info.Config.Image, service, base };
}

// After an update: check that image again right away, so the "update available" notice disappears.
function afterUpdate(image) { forgetUpdate(image); checkUpdates(false).catch(() => {}); }

async function appAction(id, action) {
  const { status, buf } = await dockerRaw('POST', '/containers/' + encodeURIComponent(id) + '/' + action, 90000);
  if (status >= 400) {
    let msg = ''; try { msg = JSON.parse(buf.toString('utf8')).message; } catch { /* empty */ }
    throw httpError(msg || 'Docker returned error ' + status, 502);
  }
}

/* ---- settings per app */

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
  if (file) { try { text = fs.readFileSync(file, 'utf8'); } catch { /* not readable */ } }
  return { project, service: labels['com.docker.compose.service'] || null, files, file,
    workingDir: labels['com.docker.compose.project.working_dir'] || (file && path.dirname(file)), editable: text != null, text };
}

async function appSettings(id) {
  const [info, drivers] = await Promise.all([inspect(id), networkDrivers()]);
  const labels = ownLabels(info.Config && info.Config.Labels);
  const name = nameOf(info), o = readOverrides()[name] || {};
  const ports = portsOf(info);
  const rp = (info.HostConfig && info.HostConfig.RestartPolicy) || {};
  return {
    name, image: info.Config && info.Config.Image, ports, restartPolicy: rp.Name || 'no',
    autoStart: rp.Name === 'always' || rp.Name === 'unless-stopped',
    webui: o.webui || '', webuiDefault: labels['majaos.webui'] || '', webuiAuto: webui(labels, ports, null, ownAddress(info, drivers), !!(info.HostConfig && info.HostConfig.NetworkMode === 'host')),
    icon: o.icon || '', iconDefault: labels['majaos.icon'] || '',
    compose: await withForm(composeOf(labels)),
  };
}
// The form doesn't always work (e.g. ${VARIABLES} in ports): then only the text mode is left.
async function withForm(c) {
  if (!c || !c.editable || !c.service) return c;
  try {
    const [project, nets] = await Promise.all([composeForm.loadProject(c), docker('GET', '/networks').catch(() => [])]);
    // Networks you can pick in the form (the built-in ones are listed separately).
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
  if (webuiVal && !URLISH.test(webuiVal)) throw httpError('The web interface address must start with http:// or https://, e.g. http://[IP]:[PORT:8080]/', 400);
  if (iconVal && !/^https?:\/\//i.test(iconVal)) throw httpError('The icon must be an address that starts with http:// or https://.', 400);
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
  if (!c || !c.editable) throw httpError('This app has no compose file that MajaOS can edit.', 400);
  return c;
}
async function saveCompose(id, text) { return writeCompose(await editableCompose(id), text); }

// Saving the form: rewrite the whole file with the changed service.
async function saveComposeForm(id, form) {
  const c = await editableCompose(id);
  if (!c.service) throw httpError('MajaOS does not know which service in the compose file belongs to this app.', 400);
  // A fixed address on the default network: the shared maja network (lib/dockernet.js; loaded here to avoid a require cycle).
  const f = await require('./dockernet').formNetwork(form, nameOf(await inspect(id)));
  const project = composeForm.applyServiceForm(await composeForm.loadProject(c), { ...f, service: c.service });
  const header = '# Edited with MajaOS on ' + new Date().toLocaleString('en-GB') + '. The previous version is in ' + path.basename(c.file) + '.bak.\n';
  return writeCompose(c, header + toYaml(project) + '\n');
}

// Replace the compose file: let docker compose check it first, then a backup copy, then restart.
async function writeCompose(c, text) {
  const body = String(text || '');
  if (!body.trim() || body.length > 512 * 1024) throw httpError('The compose file is empty or too large.', 400);
  const tmp = path.join(path.dirname(c.file), '.majaos-check-' + crypto.randomBytes(4).toString('hex') + '.yaml');
  fs.writeFileSync(tmp, body);
  try { await run('docker', ['compose', '-p', c.project, '--project-directory', c.workingDir, '-f', tmp, 'config', '-q'], { timeout: 30000 }); }
  catch (e) { throw httpError('The compose file is not valid: ' + e.message, 400); }
  finally { fs.rmSync(tmp, { force: true }); }
  fs.copyFileSync(c.file, c.file + '.bak');
  fs.writeFileSync(c.file, body);
  try { await run('docker', ['compose', '-p', c.project, '--project-directory', c.workingDir, '-f', c.file, 'up', '-d'], { timeout: 10 * 60000 }); }
  catch (e) { throw httpError('Saved, but restarting failed: ' + e.message + ' The previous version is in ' + c.file + '.bak.', 502); }
  return { ok: true, backup: c.file + '.bak' };
}

// Console: one command at a time with sh in the container. We return the folder ($PWD) each time.
const EXEC_SCRIPT = 'cd -- "$1" 2>/dev/null || cd /; eval "$2" 2>&1; s=$?; printf "\\n\\001%s" "$PWD"; exit $s';
async function execIn(id, cmd, cwd) {
  const command = String(cmd || '');
  if (!command.trim()) throw httpError('Type a command.', 400);
  if (command.length > 4000) throw httpError('That command is too long.', 400);
  const info = await inspect(id);
  if (!info.State || !info.State.Running) throw httpError('Start the app first. The console only works while the app is running.', 409);
  let r;
  try { r = await run('docker', ['exec', info.Id, 'sh', '-c', EXEC_SCRIPT, 'sh', String(cwd || '/'), command], { timeout: 30000, full: true }); }
  catch (e) { throw e.status === 504 ? httpError('The command ran longer than 30 seconds and was stopped.', 504) : e; }
  return parseExec(r, cwd);
}
// After the command's output comes "\n\x01<folder>". If that is missing, sh couldn't even start.
function parseExec(r, cwd) {
  const i = r.stdout.lastIndexOf('\n\u0001');
  if (i < 0) {
    if (/executable file not found|no such file or directory/i.test(r.stderr)) throw httpError('This app has no shell (sh), so a console is not possible.', 400);
    return { output: (r.stdout + r.stderr).slice(-200000), cwd: cwd || '/', exitCode: r.code };
  }
  const out = r.stdout.slice(0, i).replace(/\n$/, ''); // the last line break of the command itself
  return { output: out.slice(-200000), cwd: r.stdout.slice(i + 2).trim() || cwd || '/', exitCode: r.code };
}

module.exports = { ownLabels, docker, listApps, logs, appAction, updateTarget, afterUpdate, checkUpdates, lastUpdateCheck: () => lastCheck, appSettings, saveAppSettings, saveCompose, saveComposeForm, execIn, EXEC_SCRIPT, parseExec, demuxLogs, parseLogLines, publicPorts, webui };
