'use strict';
/*
 * HomeBaseOS — een eenvoudig beheersysteem voor je thuisserver (in de stijl van ZimaOS/HexOS).
 * Draait als root op Debian 13 met ZFS, KVM/libvirt en Docker. Geen externe dependencies: Node 18.11+.
 *
 * Omgevingsvariabelen (op de server in /etc/homebaseos/homebaseos.env):
 *   APP_PASSWORD     wachtwoord voor de webinterface (verplicht, behalve in de demo)
 *   SESSION_SECRET   vaste sleutel voor aanmeldingen; anders willekeurig per opstart
 *   PORT             standaard 8080
 *   OLLAMA_URL       bv. http://127.0.0.1:11434  (optioneel)
 *   VM_DIR           map voor VM-schijven, standaard /tank/vms
 *   ISO_DIR          map met ISO's en schijfbestanden, standaard /tank/isos
 *   VM_NETWORK       netwerk voor nieuwe VM's: network=default (NAT) of bridge=br0
 *   APPDATA_DIR      gegevens van apps uit de appstore, standaard /snel/appdata
 *   SHARES_DIR       waar Unraid-shares (/mnt/user/...) naartoe vertaald worden, standaard /tank
 *   STACKS_DIR       compose-bestanden van de appstore, standaard /opt/stacks (zoals Dockge)
 *   APP_UID/APP_GID  gebruiker voor apps in plaats van Unraid's 99:100, standaard 1000:1000
 *   DATA_DIR         eigen instellingen, standaard /var/lib/homebaseos
 *   DEMO             1 = demo-modus met voorbeelddata (geen server nodig)
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// Lees een .env-bestand naast server.js (handig tijdens het ontwikkelen).
(function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
})();
if (process.argv.includes('--demo')) process.env.DEMO = '1';

// Pas na het lezen van .env laden: de modules lezen hun instellingen bij het inladen.
const sys = require('./lib/system');
const docker = require('./lib/docker');
const vms = require('./lib/vms');
const storage = require('./lib/storage');
const appstore = require('./lib/appstore');
const settings = require('./lib/settings');
const network = require('./lib/network');
const dockernet = require('./lib/dockernet');
const vmnet = require('./lib/vmnet');
const ws = require('./lib/websocket');
const about = require('./lib/about');
const bays = require('./lib/bays');
const zpool = require('./lib/zpool');
const disks = require('./lib/disks');
const layout = require('./lib/layout');
const terminal = require('./lib/terminal');
const shares = require('./lib/shares');
const auth = require('./lib/auth');
const datetime = require('./lib/datetime');
const release = require('./lib/release');
const updater = require('./lib/updater');
const onboarding = require('./lib/onboarding');

const CFG = {
  port: Number(process.env.PORT || 8080),
  ollamaUrl: (process.env.OLLAMA_URL || '').replace(/\/+$/, ''),
  password: process.env.APP_PASSWORD || '',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  demo: process.env.DEMO === '1',
};

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

/* ---------------------------------------------------------------- helpers */

function rawRequest(urlStr, { method = 'GET', headers = {}, body, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers, timeout }, (res) => resolve(res));
    req.on('timeout', () => req.destroy(new Error('Time-out bij verbinden met ' + url.host)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(urlStr, opts = {}) {
  const res = await rawRequest(urlStr, opts);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* niet-JSON */ }
  if (res.statusCode >= 400) {
    const msg = (data && (data.error || data.message)) || text.slice(0, 200) || ('HTTP ' + res.statusCode);
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.statusCode;
    throw err;
  }
  return data;
}

function sendJson(res, status, obj) {
  let body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  // Grote antwoorden (de appcatalogus is ~2 MB) gecomprimeerd versturen.
  if (body.length > 64 * 1024 && /\bgzip\b/.test((res.req && res.req.headers['accept-encoding']) || '')) {
    body = zlib.gzipSync(body); headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(body);
}

async function readBody(req, limit = 1e6) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Body te groot'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { const e = new Error('Ongeldige JSON'); e.status = 400; throw e; }
}

/* ---------------------------------------------------------------- auth */

function sign(value) { return crypto.createHmac('sha256', CFG.secret).update(value).digest('hex'); }
function makeToken() { const v = 'ok.' + Date.now(); return v + '.' + sign(v); }
function validToken(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf('.');
  if (i < 0) return false;
  const v = tok.slice(0, i), s = tok.slice(i + 1);
  const expected = sign(v);
  if (s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return false;
  const issued = Number(v.split('.')[1]);
  // 30 dagen geldig, en niet van vóór het aanzetten van tweestapsverificatie.
  return Date.now() - issued < 30 * 24 * 3600 * 1000 && issued >= auth.sessionsAfter();
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) { return !CFG.password || validToken(cookies(req).tb_session); }
// Wachtwoord opnieuw controleren (terminal, beveiliging minder streng maken).
// Een eigen wachtwoord (gekozen in de welkomstwizard of bij Beveiliging) vervangt APP_PASSWORD.
function checkPassword(pw) {
  if (!CFG.password) return true;
  if (auth.hasPassword()) return auth.verifyPassword(pw);
  const a = Buffer.from(String(pw || '')), b = Buffer.from(CFG.password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Zonder "Aangemeld blijven" verdwijnt het koekje als de browser sluit.
function setSession(res, remember) {
  res.setHeader('Set-Cookie', `tb_session=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/` + (remember === false ? '' : '; Max-Age=2592000'));
}
const slow = () => new Promise((r) => setTimeout(r, 800)); // vertraag gokpogingen
const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

/* ---------------------------------------------------------------- systeem */

async function apiOverview() {
  const [cpu, gpu, store] = await Promise.all([sys.cpuPercent(), sys.gpuStats(), storage.storageSummary().catch(() => null)]);
  return {
    hostname: os.hostname(), uptime: sys.uptime(), version: sys.osName(),
    cpu: { ...sys.cpuInfo(), percent: cpu }, memory: sys.memory(), storage: store, gpu,
  };
}

/* ------------------------------------------------------------------ Ollama */

function needOllama() {
  if (!CFG.ollamaUrl) { const e = new Error('Ollama is niet ingesteld (OLLAMA_URL ontbreekt).'); e.status = 503; throw e; }
}

async function apiAi() {
  needOllama();
  const [tags, ps, version, gpu] = await Promise.all([
    requestJson(CFG.ollamaUrl + '/api/tags'),
    requestJson(CFG.ollamaUrl + '/api/ps').catch(() => ({ models: [] })),
    requestJson(CFG.ollamaUrl + '/api/version').catch(() => null),
    sys.gpuStats(),
  ]);
  const loaded = {};
  (ps.models || []).forEach((m) => { loaded[m.name] = m; });
  return {
    version: version && version.version,
    gpu,
    models: (tags.models || []).map((m) => ({
      name: m.name, size: m.size, modified: m.modified_at,
      family: m.details && m.details.family, params: m.details && m.details.parameter_size,
      quant: m.details && m.details.quantization_level,
      loaded: !!loaded[m.name], vram: loaded[m.name] ? loaded[m.name].size_vram : null,
      ramTotal: loaded[m.name] ? loaded[m.name].size : null,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Stuur de NDJSON-stream van Ollama ongewijzigd door naar de browser.
async function proxyStream(res, urlPath, payload) {
  needOllama();
  const up = await rawRequest(CFG.ollamaUrl + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeout: 0,
  });
  res.writeHead(up.statusCode, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  up.pipe(res);
  res.on('close', () => up.destroy());
}

/* ------------------------------------------------------------------ router */

const MODEL_NAME = /^[\w.\-/:]{1,200}$/;

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/config' && method === 'GET') {
    return sendJson(res, 200, {
      demo: CFG.demo, passwordEnabled: !!CFG.password, needsLogin: !!CFG.password && !isAuthed(req), ollama: !!CFG.ollamaUrl,
      language: settings.getSettings().language, clock: settings.getSettings().clock,
      terminal: settings.getSettings().terminal, terminalPassword: settings.getSettings().terminalPassword && !!CFG.password,
      onboarding: isAuthed(req) && !onboarding.getState().done, // welkomstwizard tonen
    });
  }
  // Aanmelden: eerst het wachtwoord, daarna (als tweestapsverificatie aan staat) een code uit de app of een herstelcode.
  if ((p === '/api/login' || p === '/api/login/mfa') && method === 'POST') {
    const ip = clientIp(req), body = await readBody(req);
    if (auth.lockedFor(ip)) return sendJson(res, 429, { error: 'Te veel foute pogingen. Wacht 5 minuten en probeer opnieuw.' });
    if (p === '/api/login') {
      if (!checkPassword(body.password)) { auth.failed(ip); await slow(); return sendJson(res, 401, { error: 'Verkeerd wachtwoord' }); }
      if (CFG.password && auth.mfaEnabled()) return sendJson(res, 200, { mfa: true, pending: auth.newPending() });
    } else {
      const r = auth.usePending(body.pending, body.code);
      if (r.result === 'expired') return sendJson(res, 401, { error: 'Je aanmelding is verlopen. Typ je wachtwoord opnieuw.', expired: true });
      if (r.result !== 'ok') { auth.failed(ip); await slow(); return sendJson(res, 401, { error: 'Die code klopt niet.' }); }
      auth.succeeded(ip); setSession(res, body.remember);
      return sendJson(res, 200, { ok: true, recovery: !!r.recovery, recoveryLeft: r.recoveryLeft });
    }
    auth.succeeded(ip); setSession(res, body.remember);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', 'tb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }
  if (!isAuthed(req)) return sendJson(res, 401, { error: 'Niet aangemeld' });
  if (CFG.demo) return sendJson(res, 409, { error: 'Demo-modus: de browser gebruikt voorbeelddata.' });

  // Bescherming tegen CSRF: wijzigende verzoeken moeten van dezelfde oorsprong komen.
  if (method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return sendJson(res, 403, { error: 'Andere oorsprong geweigerd' });
  }

  let m;
  if (p === '/api/overview' && method === 'GET') return sendJson(res, 200, await apiOverview());

  if (p === '/api/apps' && method === 'GET') {
    const apps = await docker.listApps();
    return sendJson(res, 200, apps.map((a) => (a.icon ? a : { ...a, icon: appstore.iconFor(a.image, a.name) })));
  }
  if (p === '/api/layout' && method === 'GET') return sendJson(res, 200, layout.getLayout());
  if (p === '/api/layout' && method === 'POST') return sendJson(res, 200, layout.saveLayout(await readBody(req)));
  if (p === '/api/apps/custom/inspect' && method === 'POST') return sendJson(res, 200, await appstore.inspectImage((await readBody(req)).image));
  if (p === '/api/apps/custom' && method === 'POST') return sendJson(res, 200, await appstore.installCustom(await readBody(req)));
  if (p === '/api/apps/check-updates' && method === 'POST') return sendJson(res, 200, await docker.checkUpdates(true));
  if ((m = p.match(/^\/api\/apps\/([^/]+)\/logs$/)) && method === 'GET') {
    const tail = Math.min(2000, Math.max(10, Number(url.searchParams.get('tail')) || 200));
    return sendJson(res, 200, await docker.logs(decodeURIComponent(m[1]), tail));
  }
  if ((m = p.match(/^\/api\/apps\/([^/]+)\/(start|stop|restart|update)$/)) && method === 'POST') {
    await docker.appAction(decodeURIComponent(m[1]), m[2]);
    return sendJson(res, 200, { ok: true });
  }

  if ((m = p.match(/^\/api\/apps\/([^/]+)\/settings$/)) && method === 'GET') return sendJson(res, 200, await docker.appSettings(decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/apps\/([^/]+)\/settings$/)) && method === 'POST') {
    return sendJson(res, 200, await docker.saveAppSettings(decodeURIComponent(m[1]), await readBody(req)));
  }
  if ((m = p.match(/^\/api\/apps\/([^/]+)\/compose$/)) && method === 'POST') {
    return sendJson(res, 200, await docker.saveCompose(decodeURIComponent(m[1]), (await readBody(req)).text));
  }
  if ((m = p.match(/^\/api\/apps\/([^/]+)\/compose-form$/)) && method === 'POST') {
    return sendJson(res, 200, await docker.saveComposeForm(decodeURIComponent(m[1]), (await readBody(req)).form || {}));
  }
  if ((m = p.match(/^\/api\/apps\/([^/]+)\/exec$/)) && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await docker.execIn(decodeURIComponent(m[1]), body.cmd, body.cwd));
  }
  if ((m = p.match(/^\/api\/apps\/([^/]+)$/)) && method === 'DELETE') {
    return sendJson(res, 200, await appstore.uninstall(decodeURIComponent(m[1]), url.searchParams.get('data') === '1'));
  }

  if (p === '/api/store' && method === 'GET') return sendJson(res, 200, await appstore.catalog(url.searchParams.get('refresh') === '1'));
  if ((m = p.match(/^\/api\/store\/apps\/([0-9a-f]{12})$/)) && method === 'GET') return sendJson(res, 200, await appstore.details(m[1]));
  if ((m = p.match(/^\/api\/store\/apps\/([0-9a-f]{12})\/install$/)) && method === 'POST') {
    return sendJson(res, 200, await appstore.install(m[1], await readBody(req)));
  }
  if ((m = p.match(/^\/api\/store\/jobs\/([0-9a-f]{12})$/)) && method === 'GET') return sendJson(res, 200, appstore.jobStatus(m[1]));

  if (p === '/api/vms' && method === 'GET') return sendJson(res, 200, await vms.listVms());
  if (p === '/api/vms' && method === 'POST') return sendJson(res, 200, await vms.createVm(await readBody(req)));
  if (p === '/api/vm-options' && method === 'GET') return sendJson(res, 200, await vms.vmOptions());
  if (p === '/api/vm-networks' && method === 'GET') return sendJson(res, 200, await vmnet.listVmNetworks());
  if (p === '/api/vm-networks' && method === 'POST') return sendJson(res, 200, await vmnet.createVmNetwork(await readBody(req)));
  if ((m = p.match(/^\/api\/vm-networks\/([^/]+)\/start$/)) && method === 'POST') return sendJson(res, 200, await vmnet.startVmNetwork(decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/vm-networks\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, await vmnet.deleteVmNetwork(decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/vms\/([^/]+)$/)) && method === 'GET') return sendJson(res, 200, await vms.vmDetails(decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/vms\/([^/]+)$/)) && method === 'DELETE') {
    return sendJson(res, 200, await vms.deleteVm(decodeURIComponent(m[1]), url.searchParams.get('disks') === '1'));
  }
  if ((m = p.match(/^\/api\/vms\/([^/]+)\/settings$/)) && method === 'POST') {
    return sendJson(res, 200, await vms.saveSettings(decodeURIComponent(m[1]), await readBody(req)));
  }
  if ((m = p.match(/^\/api\/vms\/([^/]+)\/(start|stop|reboot|pause|resume|force-stop|reset)$/)) && method === 'POST') {
    await vms.vmAction(decodeURIComponent(m[1]), m[2]);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/settings' && method === 'GET') return sendJson(res, 200, settings.getSettings());
  if (p === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    try { return sendJson(res, 200, settings.saveSettings(body, { checkPassword })); }
    catch (e) { if (e.status === 403) await new Promise((r) => setTimeout(r, 800)); throw e; } // vertraag gokpogingen
  }
  // Terminal: eerst een eenmalig ticket (met het wachtwoord als Beveiliging dat vraagt), daarna de WebSocket.
  if (p === '/api/terminal/ticket' && method === 'POST') {
    const s0 = settings.getSettings();
    if (!s0.terminal) return sendJson(res, 403, { error: 'De terminal staat uit. Zet hem aan bij Instellingen → Beveiliging.' });
    const body = await readBody(req);
    if (s0.terminalPassword && !checkPassword(body.password)) {
      await new Promise((r) => setTimeout(r, 800)); // vertraag gokpogingen
      return sendJson(res, 401, { error: 'Verkeerd wachtwoord' });
    }
    return sendJson(res, 200, { ticket: terminal.newTicket() });
  }
  // Tweestapsverificatie beheren (Instellingen → Beveiliging). Wachtwoord nodig om te beginnen, wachtwoord + code om uit te zetten.
  if (p === '/api/mfa' && method === 'GET') return sendJson(res, 200, { ...auth.status(), available: !!CFG.password, passwordChanged: auth.passwordChanged() });
  if (p.startsWith('/api/mfa/') && method === 'POST') {
    if (!CFG.password) return sendJson(res, 409, { error: 'Zet eerst een wachtwoord (APP_PASSWORD) om tweestapsverificatie te gebruiken.' });
    const body = await readBody(req), action = p.slice('/api/mfa/'.length);
    if (action === 'enable') {
      const out = auth.finishSetup(body.code);
      setSession(res, true); // andere sessies zijn nu afgemeld, deze blijft aangemeld
      return sendJson(res, 200, out);
    }
    if (!['setup', 'disable', 'recovery'].includes(action)) return sendJson(res, 404, { error: 'Niet gevonden' });
    if (!checkPassword(body.password)) { await slow(); return sendJson(res, 401, { error: 'Verkeerd wachtwoord' }); }
    if (action === 'setup') return sendJson(res, 200, auth.beginSetup(os.hostname()));
    if (!auth.checkCode(body.code).ok) { await slow(); return sendJson(res, 401, { error: 'Die code klopt niet.' }); }
    return sendJson(res, 200, action === 'disable' ? auth.disable() : auth.newRecovery());
  }
  if (p === '/api/datetime' && method === 'GET') return sendJson(res, 200, await datetime.getDateTime());
  if (p === '/api/datetime' && method === 'POST') return sendJson(res, 200, await datetime.setDateTime(await readBody(req)));
  if (p === '/api/update' && method === 'GET') return sendJson(res, 200, { ...release.status(), install: updater.canUpdate(), running: updater.isRunning() });
  if (p === '/api/update/progress' && method === 'GET') return sendJson(res, 200, updater.progress());
  if (p === '/api/update/install' && method === 'POST') return sendJson(res, 200, await updater.start((await readBody(req)).version));
  if (p === '/api/update/check' && method === 'POST') return sendJson(res, 200, await release.check());
  // Wachtwoord wijzigen (welkomstwizard en Beveiliging). Andere sessies worden afgemeld, deze blijft aangemeld.
  if (p === '/api/password' && method === 'POST') {
    const body = await readBody(req);
    if (!CFG.password) return sendJson(res, 409, { error: 'HomeBaseOS draait zonder wachtwoord.' });
    if (!checkPassword(body.current)) { await slow(); return sendJson(res, 401, { error: 'Je huidige wachtwoord klopt niet.' }); }
    auth.setPassword(body.password);
    // Na een installatie vanaf de ISO staat het eerste wachtwoord op het scherm van de server: weg ermee.
    const pwIssue = '/etc/issue.d/homebaseos-wachtwoord.issue';
    if (fs.existsSync(pwIssue)) { fs.rmSync(pwIssue, { force: true }); sys.run('agetty', ['--reload']).catch(() => {}); }
    setSession(res, true);
    return sendJson(res, 200, { ok: true, changed: auth.passwordChanged() });
  }
  // Welkomstwizard: wat er al ingesteld is, en afronden of opnieuw starten.
  if (p === '/api/onboarding' && method === 'GET') {
    const [pools, opts] = await Promise.all([storage.poolSizes().catch(() => null), zpool.poolOptions().catch(() => null)]);
    return sendJson(res, 200, {
      ...onboarding.getState(), hostname: os.hostname(), timezone: datetime.hostTimezone(),
      passwordChanged: auth.passwordChanged(), mfa: auth.mfaEnabled(),
      pools: (pools || []).map((x) => ({ name: x.name, total: x.total, health: x.health })),
      freeDisks: opts ? opts.disks.filter((d) => d.available).map((d) => ({ name: d.name, size: d.size, model: d.model, rotational: d.rotational, transport: d.transport })) : [],
    });
  }
  if (p === '/api/onboarding/finish' && method === 'POST') return sendJson(res, 200, onboarding.finish({ skipped: !!(await readBody(req)).skipped }));
  if (p === '/api/onboarding/reset' && method === 'POST') return sendJson(res, 200, onboarding.reset());
  if (p === '/api/about' && method === 'GET') return sendJson(res, 200, await about.about());
  if (p === '/api/network' && method === 'GET') return sendJson(res, 200, await network.getNetwork());
  if (p === '/api/network' && method === 'POST') return sendJson(res, 200, await network.applyNetwork(await readBody(req)));
  if (p === '/api/network/confirm' && method === 'POST') return sendJson(res, 200, network.confirmNetwork());
  if (p === '/api/network/revert' && method === 'POST') return sendJson(res, 200, await network.revertNetwork());
  if (p === '/api/network/hostname' && method === 'POST') return sendJson(res, 200, await network.setHostname((await readBody(req)).hostname));

  if (p === '/api/docker-networks' && method === 'GET') return sendJson(res, 200, await dockernet.listNetworks());
  if (p === '/api/docker-networks' && method === 'POST') return sendJson(res, 200, await dockernet.createNetwork(await readBody(req)));
  if ((m = p.match(/^\/api\/docker-networks\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, await dockernet.deleteNetwork(decodeURIComponent(m[1])));

  if (p === '/api/shares' && method === 'GET') return sendJson(res, 200, await shares.listShares());
  if (p === '/api/shares' && method === 'POST') return sendJson(res, 200, await shares.saveShare(await readBody(req)));
  if ((m = p.match(/^\/api\/shares\/([^/]+)$/)) && method === 'POST') return sendJson(res, 200, await shares.saveShare(await readBody(req), decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/shares\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, await shares.deleteShare(decodeURIComponent(m[1])));
  if (p === '/api/share-users' && method === 'POST') return sendJson(res, 200, await shares.createUser(await readBody(req)));
  if ((m = p.match(/^\/api\/share-users\/([^/]+)\/password$/)) && method === 'POST') return sendJson(res, 200, await shares.setPassword(decodeURIComponent(m[1]), (await readBody(req)).password));
  if ((m = p.match(/^\/api\/share-users\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, await shares.deleteUser(decodeURIComponent(m[1])));
  if (p === '/api/storage' && method === 'GET') return sendJson(res, 200, await storage.storage());
  if ((m = p.match(/^\/api\/disks\/([^/]+)$/)) && method === 'GET') return sendJson(res, 200, await disks.diskInfo(decodeURIComponent(m[1]), url.searchParams.get('wake') === '1'));
  if ((m = p.match(/^\/api\/disks\/([^/]+)\/test$/)) && method === 'POST') return sendJson(res, 200, await disks.selfTest(decodeURIComponent(m[1]), (await readBody(req)).type));
  if (p === '/api/pools/options' && method === 'GET') return sendJson(res, 200, await zpool.poolOptions());
  if (p === '/api/pools' && method === 'POST') return sendJson(res, 200, await zpool.createPool(await readBody(req)));
  if (p === '/api/bays' && method === 'POST') return sendJson(res, 200, bays.saveBays(await readBody(req)));

  if (p === '/api/ai' && method === 'GET') return sendJson(res, 200, await apiAi());
  if (p === '/api/ai/pull' && method === 'POST') {
    const body = await readBody(req);
    if (!MODEL_NAME.test(body.name || '')) return sendJson(res, 400, { error: 'Ongeldige modelnaam' });
    return proxyStream(res, '/api/pull', { name: body.name, stream: true });
  }
  if (p === '/api/ai/chat' && method === 'POST') {
    const body = await readBody(req, 5e6);
    if (!MODEL_NAME.test(body.model || '')) return sendJson(res, 400, { error: 'Ongeldig model' });
    const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-40)
      .map((x) => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || '').slice(0, 20000) }));
    return proxyStream(res, '/api/chat', { model: body.model, messages, stream: true });
  }
  if ((m = p.match(/^\/api\/ai\/models\/(.+)$/)) && method === 'DELETE') {
    needOllama();
    const name = decodeURIComponent(m[1]);
    if (!MODEL_NAME.test(name)) return sendJson(res, 400, { error: 'Ongeldige modelnaam' });
    await requestJson(CFG.ollamaUrl + '/api/delete', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    return sendJson(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/ai\/models\/(.+)\/(load|unload)$/)) && method === 'POST') {
    needOllama();
    const name = decodeURIComponent(m[1]);
    if (!MODEL_NAME.test(name)) return sendJson(res, 400, { error: 'Ongeldige modelnaam' });
    await requestJson(CFG.ollamaUrl + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 120000,
      body: JSON.stringify({ model: name, keep_alive: m[2] === 'load' ? '24h' : 0 }),
    });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'Onbekend endpoint' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (serr, st) => {
    if (serr || !st.isFile()) { res.writeHead(404); return res.end('Niet gevonden'); }
    // De browser vraagt elke keer na of het bestand veranderd is (304 als het hetzelfde is),
    // zodat een nieuwe versie van HomeBaseOS meteen zichtbaar is na een gewone verversing.
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const headers = { 'Cache-Control': 'no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
}

// HomeBaseOS draait als root en kan VM's en schijven wissen: zonder wachtwoord starten we niet.
if (!CFG.demo && !CFG.password) {
  console.error('APP_PASSWORD ontbreekt. Zet een wachtwoord in /etc/homebaseos/homebaseos.env (of in .env) en start opnieuw.');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    if (!res.headersSent) sendJson(res, status, { error: e.message || 'Onbekende fout' });
    else res.end();
  }
});

// Console: de browser (noVNC) maakt een WebSocket naar /api/vms/<naam>/vnc, wij geven die door aan het VNC-scherm van QEMU.
server.on('upgrade', async (req, socket, head) => {
  const deny = (status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.on('error', () => {});
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/api\/vms\/([^/]+)\/vnc$/);
  if (!m && url.pathname !== '/api/terminal') return deny(404, 'Not Found');
  if (!isAuthed(req)) return deny(401, 'Unauthorized');
  if (CFG.demo) return deny(409, 'Conflict');
  let sameOrigin = true;
  try { sameOrigin = !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; }
  if (!sameOrigin) return deny(403, 'Forbidden');
  if (!m) {
    // Terminal op de server: alleen als hij aan staat en met een geldig, eenmalig ticket.
    if (!settings.getSettings().terminal) return deny(403, 'Forbidden');
    if (!terminal.useTicket(url.searchParams.get('ticket'))) return deny(401, 'Unauthorized');
    const conn = ws.acceptWebSocket(req, socket, head);
    if (conn) terminal.attach(conn, { cols: Number(url.searchParams.get('cols')) || 120, rows: Number(url.searchParams.get('rows')) || 32, who: req.socket.remoteAddress });
    return;
  }
  try { ws.proxyToTcp(req, socket, head, await vms.vncPort(decodeURIComponent(m[1]))); }
  catch (e) { deny(e.status === 404 ? 404 : 409, 'Conflict'); }
});

server.listen(CFG.port, () => {
  console.log(`HomeBaseOS draait op poort ${CFG.port}` + (CFG.demo ? ' (demo-modus)' : ''));
  if (!CFG.demo) {
    vms.bootAutostart();
    // Updates: 2 minuten na het opstarten en daarna elke 6 uur (alleen wat 6 uur niet meer gecontroleerd is).
    const check = () => docker.checkUpdates(false).then((r) => r.updates && console.log(r.updates + ' app(s) met een update.')).catch(() => {});
    setTimeout(check, 2 * 60000);
    setInterval(check, 6 * 3600000);
    release.startSchedule((msg) => console.log(msg)); // nieuwe versies van HomeBaseOS zelf
  }
});
