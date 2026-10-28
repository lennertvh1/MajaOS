'use strict';
/*
 * MajaOS — a simple management system for your home server (in the style of ZimaOS/HexOS).
 * Runs as root on Debian 13 with ZFS, KVM/libvirt and Docker. No external dependencies: Node 18.11+.
 *
 * Environment variables (on the server in /etc/majaos/majaos.env):
 *   APP_PASSWORD     password from older installs (optional). Without a password you create an account the first time.
 *   SESSION_SECRET   fixed key for sign-ins; otherwise random per start
 *   PORT             web port if Settings has none; otherwise 80 (8080 in the demo)
 *   OLLAMA_URL       e.g. http://127.0.0.1:11434  (optional)
 *   VM_DIR           folder for VM disks (older installs; now in Settings → Storage)
 *   ISO_DIR          folder with ISOs and disk files (older installs; now in Settings → Storage)
 *   VM_NETWORK       network for new VMs: network=default (NAT) or bridge=br0
 *   APPDATA_DIR      app data (older installs; now in Settings → Storage, default /<first pool>/appdata)
 *   SHARES_DIR       where Unraid shares (/mnt/user/...) go (older installs; default the first pool)
 *   STACKS_DIR       compose files of the app store, default /opt/stacks (like Dockge)
 *   APP_UID/APP_GID  user for apps instead of Unraid's 99:100, default 1000:1000
 *   DATA_DIR         own settings, default /var/lib/majaos
 *   DEMO             1 = demo mode with sample data (no server needed)
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// Read a .env file next to server.js (handy during development).
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

// Only load after reading .env: the modules read their settings when they are loaded.
const sys = require('./lib/system');
const docker = require('./lib/docker');
const vms = require('./lib/vms');
const storage = require('./lib/storage');
const appstore = require('./lib/appstore');
const settings = require('./lib/settings');
const ssh = require('./lib/ssh');
const network = require('./lib/network');
const dockernet = require('./lib/dockernet');
const vmnet = require('./lib/vmnet');
const ws = require('./lib/websocket');
const about = require('./lib/about');
const bays = require('./lib/bays');
const zpool = require('./lib/zpool');
const replace = require('./lib/replace');
const shadow = require('./lib/shadow');
const disks = require('./lib/disks');
const layout = require('./lib/layout');
const shortcuts = require('./lib/shortcuts');
const terminal = require('./lib/terminal');
const mcphttp = require('./lib/mcphttp');
const tlsCert = require('./lib/tls');
const shares = require('./lib/shares');
const files = require('./lib/files');
const sharelinks = require('./lib/sharelinks');
const tunnel = require('./lib/tunnel');
const auth = require('./lib/auth');
const datetime = require('./lib/datetime');
const release = require('./lib/release');
const updater = require('./lib/updater');
const debian = require('./lib/debian');
const onboarding = require('./lib/onboarding');
const paths = require('./lib/paths');
const migrate = require('./lib/migrate');
const backup = require('./lib/backup');
const kopia = require('./lib/kopia');
const vmsnap = require('./lib/vmsnap');
const sysbackup = require('./lib/sysbackup');
const ai = require('./lib/ai');
const issue = require('./lib/issue');
const keyboard = require('./lib/keyboard');

const CFG = {
  port: settings.listenPort(),
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
    req.on('timeout', () => req.destroy(new Error('Time-out connecting to ' + url.host)));
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
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
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
  // Send large responses (the app catalogue is ~2 MB) compressed.
  if (body.length > 64 * 1024 && /\bgzip\b/.test((res.req && res.req.headers['accept-encoding']) || '')) {
    body = zlib.gzipSync(body); headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(body);
}

async function readBody(req, limit = 1e6) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) { const e = new Error('Request too large'); e.status = 413; throw e; } chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { const e = new Error('Invalid JSON'); e.status = 400; throw e; }
}

/* ---------------------------------------------------------------- auth */

function sign(value) { return crypto.createHmac('sha256', CFG.secret).update(value).digest('hex'); }
const SESSION_MS = 30 * 24 * 3600 * 1000;
// ok.<issued>.<id>.<signature>: the id lets Sign out refuse this one cookie afterwards.
function makeToken() { const v = 'ok.' + Date.now() + '.' + crypto.randomBytes(9).toString('base64url'); return v + '.' + sign(v); }
function readToken(tok) {
  if (!tok) return null;
  const i = tok.lastIndexOf('.');
  if (i < 0) return null;
  const v = tok.slice(0, i), s = tok.slice(i + 1);
  const expected = sign(v);
  if (s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  const [, issued, id] = v.split('.');
  return { issued: Number(issued), id: id || '' };
}
function validToken(tok) {
  const t = readToken(tok);
  // Valid for 30 days, not from before the last password change or two-step verification, and not signed out.
  return !!t && Date.now() - t.issued < SESSION_MS && t.issued >= auth.sessionsAfter() && !auth.isRevoked(t.id);
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
// An account (own password) or APP_PASSWORD from older installs. Without both: create an account first (needsSetup).
const passwordEnabled = () => !!CFG.password || auth.hasPassword();
const needsSetup = () => !CFG.demo && !passwordEnabled();
function isAuthed(req) { return passwordEnabled() ? validToken(cookies(req).tb_session) : CFG.demo; }
// Check the password again (sign in, terminal, making security less strict).
// An own password (the account, or chosen in Security) replaces APP_PASSWORD.
function checkPassword(pw) {
  if (auth.hasPassword()) return auth.verifyPassword(pw);
  if (!CFG.password) return false;
  const a = Buffer.from(String(pw || '')), b = Buffer.from(CFG.password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Without "Stay signed in" the cookie disappears when the browser closes.
// Secure when the browser came over https (directly, or through a reverse proxy that says so).
const viaHttps = (req) => !!(req.socket.encrypted || /^https$/i.test(String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()));
function setSession(res, remember) {
  res.setHeader('Set-Cookie', `tb_session=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/` + (remember === false ? '' : '; Max-Age=2592000') + (viaHttps(res.req) ? '; Secure' : ''));
}
const slow = () => new Promise((r) => setTimeout(r, 800)); // slow down guessing
const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

/* ---------------------------------------------------------------- system */

async function apiOverview() {
  const [cpu, gpu, store, found] = await Promise.all([
    sys.cpuPercent(), sys.gpuStats(), storage.storageSummary().catch(() => null), replace.look().catch(() => null),
  ]);
  return {
    hostname: os.hostname(), uptime: sys.uptime(), version: sys.osName(),
    cpu: { ...sys.cpuInfo(), percent: cpu }, memory: sys.memory(),
    storage: store ? { ...store, repair: found && found.repair, alerts: (found && found.alerts) || [] } : store, gpu,
  };
}

/* ------------------------------------------------------------------ Ollama */

function needOllama() { return ai.ollamaBase(); }

// Pass Ollama's NDJSON stream on to the browser unchanged (model downloads).
async function proxyStream(res, urlPath, payload) {
  const up = await rawRequest(needOllama() + urlPath, {
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
      demo: CFG.demo, passwordEnabled: passwordEnabled(), needsLogin: passwordEnabled() && !isAuthed(req), ollama: ai.effective().provider === 'ollama',
      setup: needsSetup(), // no account yet: the welcome wizard creates one
      loginUser: true, // always a user name; older installs keep the one typed at their first sign-in
      language: settings.getSettings().language, clock: settings.getSettings().clock, experience: settings.getSettings().experience, port: settings.listenPort(),
      terminal: settings.getSettings().terminal, terminalPassword: settings.getSettings().terminalPassword && passwordEnabled(),
      onboarding: needsSetup() || (isAuthed(req) && !onboarding.getState().done), // show the welcome wizard
    });
  }
  // First time: create an account (user name + password). Only possible while there is none yet.
  if (p === '/api/setup' && method === 'POST') {
    if (!needsSetup()) return sendJson(res, 409, { error: 'There is already an account. Sign in.' });
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return sendJson(res, 403, { error: 'Other origin refused' });
    const body = await readBody(req);
    if (body.password !== body.repeat) return sendJson(res, 400, { error: 'The two passwords do not match.' });
    const r = auth.createAccount(body.user, body.password);
    if (body.language || body.experience) settings.saveSettings({ language: body.language, experience: body.experience });
    removePasswordIssue();
    refreshIssue(); // "create your account" becomes "sign in"
    setSession(res, true);
    console.log(`Account ${r.user} created from ${clientIp(req)}.`);
    return sendJson(res, 200, r);
  }
  // Sign in: first the password, then (if two-step verification is on) a code from the app or a recovery code.
  if ((p === '/api/login' || p === '/api/login/mfa') && method === 'POST') {
    const ip = clientIp(req), body = await readBody(req);
    if (auth.lockedFor(ip)) return sendJson(res, 429, { error: 'Too many wrong attempts. Wait 5 minutes and try again.' });
    if (p === '/api/login') {
      if (needsSetup()) return sendJson(res, 409, { error: 'There is no account yet. Create one first.', setup: true });
      if (!checkPassword(body.password) || !auth.checkUser(body.user)) { auth.failed(ip); await slow(); return sendJson(res, 401, { error: 'Wrong user name or password' }); }
      auth.claimUser(body.user);
      if (auth.mfaEnabled()) return sendJson(res, 200, { mfa: true, pending: auth.newPending() });
    } else {
      const r = auth.usePending(body.pending, body.code);
      if (r.result === 'expired') return sendJson(res, 401, { error: 'Your sign-in expired. Type your password again.', expired: true });
      if (r.result !== 'ok') { auth.failed(ip); await slow(); return sendJson(res, 401, { error: 'That code is not correct.' }); }
      auth.succeeded(ip); setSession(res, body.remember);
      return sendJson(res, 200, { ok: true, recovery: !!r.recovery, recoveryLeft: r.recoveryLeft });
    }
    auth.succeeded(ip); setSession(res, body.remember);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/logout' && method === 'POST') {
    const t = readToken(cookies(req).tb_session);
    if (t) auth.revoke(t.id, t.issued + SESSION_MS);
    res.setHeader('Set-Cookie', 'tb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }
  // Pairing the MajaOS Backup app on a PC: without sign-in, with a one-time code valid for 15 minutes (lib/kopia.js).
  const pair = p.match(/^\/api\/backup\/pair\/([A-Za-z0-9-]{1,20})$/);
  if (pair && method === 'GET' && !CFG.demo) {
    res.setHeader('Access-Control-Allow-Origin', '*'); // the app requests it from another address
    const r = kopia.usePairing(pair[1], clientIp(req));
    if (r.status !== 200) await slow();
    return sendJson(res, r.status, r.data || { error: r.status === 429 ? 'Too many wrong codes. Wait 5 minutes and try again.' : 'That pairing code is wrong or has expired.' });
  }
  // The own CA, so a device can trust the HTTPS certificate. Public: it holds no secret.
  if (p === '/api/tls/ca.crt' && method === 'GET') {
    const pem = tlsCert.caPem();
    if (!pem) return sendJson(res, 404, { error: 'There is no certificate yet.' });
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="majaos-ca.crt"', 'Cache-Control': 'no-store' });
    return res.end(pem);
  }
  // The demo adapter fetches a real site icon through here. On a normal server this stays behind sign-in.
  if (p === '/api/shortcuts/fetch-icon' && method === 'POST') {
    if (!CFG.demo && !isAuthed(req)) return sendJson(res, 401, { error: 'Not signed in' });
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return sendJson(res, 403, { error: 'Other origin refused' });
    const got = await shortcuts.fetchFavicon(shortcuts.normalizeUrl((await readBody(req)).url));
    return sendJson(res, 200, { icon: got ? 'data:' + got.type + ';base64,' + got.buf.toString('base64') : null });
  }
  if (!isAuthed(req)) return sendJson(res, 401, { error: 'Not signed in' });
  if (CFG.demo) return sendJson(res, 409, { error: 'Demo mode: the browser uses sample data.' });

  // Protection against CSRF: requests that change things must come from the same origin.
  if (method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return sendJson(res, 403, { error: 'Other origin refused' });
  }

  let m;
  if (p === '/api/overview' && method === 'GET') return sendJson(res, 200, await apiOverview());
  // Restart or shut down the server. Answer first, only then the command (otherwise the answer never arrives).
  if (p === '/api/system/power' && method === 'POST') {
    const action = (await readBody(req)).action;
    if (action !== 'reboot' && action !== 'shutdown') return sendJson(res, 400, { error: 'Choose restart or shut down.' });
    console.log(`Server ${action === 'reboot' ? 'restarted' : 'shut down'} from ${clientIp(req)}.`);
    sendJson(res, 200, { ok: true, action });
    setTimeout(() => sys.run('systemctl', [action === 'reboot' ? 'reboot' : 'poweroff'], { timeout: 30000 }).catch((e) => console.error('Power action failed: ' + e.message)), 1000);
    return;
  }

  if (p === '/api/apps' && method === 'GET') {
    const apps = await docker.listApps();
    const upd = appstore.updateStates();
    return sendJson(res, 200, apps.map((a) => ({ ...a, icon: a.icon || appstore.iconFor(a.image, a.name), updateJob: upd[a.name] || null })));
  }
  if (p === '/api/layout' && method === 'GET') return sendJson(res, 200, layout.getLayout());
  if (p === '/api/layout' && method === 'POST') return sendJson(res, 200, layout.saveLayout(await readBody(req)));
  if (p === '/api/shortcuts' && method === 'GET') return sendJson(res, 200, shortcuts.list());
  if (p === '/api/shortcuts' && method === 'POST') return sendJson(res, 200, await shortcuts.create(await readBody(req, 2e6)));
  if ((m = p.match(/^\/api\/shortcuts\/([^/]+)\/icon$/)) && method === 'GET') {
    const ic = shortcuts.icon(decodeURIComponent(m[1]));
    if (!ic) return sendJson(res, 404, { error: 'This shortcut has no icon.' });
    res.writeHead(200, { 'Content-Type': ic.type, 'Content-Length': ic.size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(ic.path).pipe(res);
    return;
  }
  if ((m = p.match(/^\/api\/shortcuts\/([^/]+)$/)) && method === 'POST') return sendJson(res, 200, await shortcuts.update(decodeURIComponent(m[1]), await readBody(req, 2e6)));
  if ((m = p.match(/^\/api\/shortcuts\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, shortcuts.remove(decodeURIComponent(m[1])));
  if (p === '/api/apps/custom/inspect' && method === 'POST') return sendJson(res, 200, await appstore.inspectImage((await readBody(req)).image));
  if (p === '/api/apps/custom' && method === 'POST') return sendJson(res, 200, await appstore.installCustom(await readBody(req)));
  if (p === '/api/apps/draft' && method === 'POST') return sendJson(res, 200, await appstore.draft(await readBody(req)));
  if (p === '/api/apps/compose' && method === 'POST') return sendJson(res, 200, await appstore.installCompose(await readBody(req)));
  if (p === '/api/apps/check-updates' && method === 'POST') return sendJson(res, 200, await docker.checkUpdates(true));
  if ((m = p.match(/^\/api\/apps\/([^/]+)\/logs$/)) && method === 'GET') {
    const tail = Math.min(2000, Math.max(10, Number(url.searchParams.get('tail')) || 200));
    return sendJson(res, 200, await docker.logs(decodeURIComponent(m[1]), tail));
  }
  // Updating is a job with progress and a log (lib/appstore.js), followed through /api/store/jobs/:id.
  if ((m = p.match(/^\/api\/apps\/([^/]+)\/update$/)) && method === 'POST') return sendJson(res, 200, await appstore.startUpdate(decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/apps\/([^/]+)\/(start|stop|restart)$/)) && method === 'POST') {
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
  // Snapshots of a VM (lib/vmsnap.js).
  if ((m = p.match(/^\/api\/vms\/([^/]+)\/snapshots$/)) && method === 'GET') return sendJson(res, 200, await vmsnap.listSnapshots(decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/vms\/([^/]+)\/snapshots$/)) && method === 'POST') return sendJson(res, 200, await vmsnap.createSnapshot(decodeURIComponent(m[1]), await readBody(req)));
  if ((m = p.match(/^\/api\/vms\/([^/]+)\/snapshots\/([^/]+)\/revert$/)) && method === 'POST') return sendJson(res, 200, await vmsnap.revertSnapshot(decodeURIComponent(m[1]), decodeURIComponent(m[2])));
  if ((m = p.match(/^\/api\/vms\/([^/]+)\/snapshots\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, await vmsnap.deleteSnapshot(decodeURIComponent(m[1]), decodeURIComponent(m[2])));
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

  if (p === '/api/settings' && method === 'GET') {
    const s = settings.getSettings();
    const sshState = CFG.demo
      ? { installed: true, enabled: !!s.ssh, active: !!s.ssh }
      : await ssh.status().catch(() => ({ installed: false, enabled: false, active: false }));
    return sendJson(res, 200, { ...s, port: settings.listenPort(), sshState });
  }
  if (p === '/api/tls' && method === 'GET') {
    return sendJson(res, 200, { enabled: settings.getSettings().https !== false, port: settings.httpsPort(), listening: !!secure, ...(tlsCert.info() || {}) });
  }
  if (p === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    const beforePort = settings.listenPort();
    const before = settings.getSettings();
    let saved;
    try { saved = settings.saveSettings(body, { checkPassword }); }
    catch (e) { if (e.status === 403) await new Promise((r) => setTimeout(r, 800)); throw e; } // slow down guessing
    // The file is the wish; systemctl is what the server actually does. A failure puts the wish back.
    if (body.ssh != null && !!saved.ssh !== !!before.ssh && !CFG.demo) {
      try { await ssh.apply(saved.ssh); }
      catch (e) {
        try { settings.saveSettings({ ssh: !!before.ssh }, { checkPassword: () => true }); } catch { /* the systemctl error is the one to show */ }
        throw e;
      }
    }
    // Listen on the new port before answering, and keep the old one until this response has left.
    if (body.port != null && settings.listenPort() !== beforePort) {
      try { await bind(settings.listenPort()); }
      catch (e) {
        try { settings.saveSettings({ port: beforePort }, { checkPassword: () => true }); } catch { /* the listen error is the one to show */ }
        const wanted = Number(body.port);
        if (e.code === 'EADDRINUSE') throw Object.assign(new Error(`Port ${wanted} is already in use. Choose another port.`), { status: 409 });
        if (e.code === 'EACCES' || e.code === 'EPERM') throw Object.assign(new Error(`Port ${wanted} needs MajaOS to run as root. Choose a port above 1024.`), { status: 409 });
        throw Object.assign(new Error(e.message || 'The port could not be changed.'), { status: 409 });
      }
      tunnel.retarget().catch((err) => console.error('Remote access: ' + err.message));
    }
    // HTTPS on, off or on another port. Answer first over the old connection, then switch.
    if ((body.https != null && (saved.https !== false) !== (before.https !== false)) || (body.httpsPort != null && settings.httpsPort() !== (secure && secure.port))) {
      if (saved.https !== false && settings.httpsPort() === settings.listenPort()) {
        settings.saveSettings({ https: before.https !== false, httpsPort: before.httpsPort || settings.httpsPort() }, { checkPassword: () => true });
        throw Object.assign(new Error('HTTPS needs another port than the web port.'), { status: 409 });
      }
      setTimeout(() => startHttps().catch((e) => console.error('HTTPS could not start: ' + e.message)), 500);
    }
    refreshIssue(); // http/https and the ports on the server's screen
    return sendJson(res, 200, { ...saved, port: settings.listenPort(), httpsPort: settings.httpsPort() });
  }
  // What Cursor needs to talk to this server. The token is a normal session (30 days); the password never leaves this check.
  if (p === '/api/mcp' && method === 'GET') {
    return sendJson(res, 200, { user: auth.userName() || '', passwordEnabled: passwordEnabled(), terminal: !!settings.getSettings().terminal, enabled: settings.getSettings().mcp !== false });
  }
  if (p === '/api/mcp/token' && method === 'POST') {
    const body = await readBody(req);
    if (passwordEnabled() && !checkPassword(body.password)) { await slow(); return sendJson(res, 401, { error: 'Wrong password' }); }
    return sendJson(res, 200, { token: makeToken(), user: auth.userName() || '' });
  }
  // Terminal: first a one-time ticket (with the password if Security asks for it), then the WebSocket.
  if (p === '/api/terminal/ticket' && method === 'POST') {
    const s0 = settings.getSettings();
    if (!s0.terminal) return sendJson(res, 403, { error: 'The terminal is turned off. Turn it on in Settings → Security.' });
    const body = await readBody(req);
    if (s0.terminalPassword && !checkPassword(body.password)) {
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return sendJson(res, 401, { error: 'Wrong password' });
    }
    return sendJson(res, 200, { ticket: terminal.newTicket() });
  }
  // One command on the server (the MCP server). Same switch and password as the terminal.
  if (p === '/api/terminal/run' && method === 'POST') {
    const s0 = settings.getSettings();
    if (!s0.terminal) return sendJson(res, 403, { error: 'The terminal is turned off. Turn it on in Settings → Security.' });
    const body = await readBody(req);
    if (s0.terminalPassword && !checkPassword(body.password)) {
      await new Promise((r) => setTimeout(r, 800));
      return sendJson(res, 401, { error: 'Wrong password' });
    }
    console.log('A command ran through the terminal' + (clientIp(req) ? ' from ' + clientIp(req) : '') + '.');
    return sendJson(res, 200, await terminal.runCommand(body.command, { timeout: body.timeout }));
  }
  // Manage two-step verification (Settings → Security). Password needed to start, password + code to turn it off.
  if (p === '/api/mfa' && method === 'GET') return sendJson(res, 200, { ...auth.status(), available: passwordEnabled(), passwordChanged: auth.passwordChanged() });
  if (p.startsWith('/api/mfa/') && method === 'POST') {
    if (!passwordEnabled()) return sendJson(res, 409, { error: 'Set a password (APP_PASSWORD) first to use two-step verification.' });
    const body = await readBody(req), action = p.slice('/api/mfa/'.length);
    if (action === 'enable') {
      const out = auth.finishSetup(body.code);
      setSession(res, true); // other sessions are now signed out, this one stays signed in
      return sendJson(res, 200, out);
    }
    if (!['setup', 'disable', 'recovery'].includes(action)) return sendJson(res, 404, { error: 'Not found' });
    if (!checkPassword(body.password)) { await slow(); return sendJson(res, 401, { error: 'Wrong password' }); }
    if (action === 'setup') return sendJson(res, 200, auth.beginSetup(auth.userName() ? auth.userName() + '@' + os.hostname() : os.hostname()));
    if (!auth.checkCode(body.code).ok) { await slow(); return sendJson(res, 401, { error: 'That code is not correct.' }); }
    return sendJson(res, 200, action === 'disable' ? auth.disable() : auth.newRecovery());
  }
  if (p === '/api/keyboard' && method === 'GET') return sendJson(res, 200, keyboard.getKeyboard());
  if (p === '/api/keyboard' && method === 'POST') return sendJson(res, 200, await keyboard.setKeyboard((await readBody(req)).layout));
  if (p === '/api/datetime' && method === 'GET') return sendJson(res, 200, await datetime.getDateTime());
  if (p === '/api/datetime' && method === 'POST') return sendJson(res, 200, await datetime.setDateTime(await readBody(req)));
  if (p === '/api/update' && method === 'GET') return sendJson(res, 200, { ...release.status(), install: updater.canUpdate(), running: updater.isRunning() });
  if (p === '/api/update/progress' && method === 'GET') return sendJson(res, 200, updater.progress());
  if (p === '/api/update/install' && method === 'POST') return sendJson(res, 200, await updater.start((await readBody(req)).version));
  // Debian itself: what is waiting, automatic security updates, reboot needed (lib/debian.js).
  if (p === '/api/system-updates' && method === 'GET') return sendJson(res, 200, await debian.status());
  if (p === '/api/system-updates/progress' && method === 'GET') return sendJson(res, 200, debian.progress());
  if ((m = p.match(/^\/api\/system-updates\/(check|upgrade|auto-on|auto-off)$/)) && method === 'POST') return sendJson(res, 200, await debian.start(m[1]));
  if (p === '/api/update/check' && method === 'POST') return sendJson(res, 200, await release.check());
  // Change password (welcome wizard and Security). Other sessions are signed out, this one stays signed in.
  if (p === '/api/password' && method === 'POST') {
    const body = await readBody(req);
    if (!passwordEnabled()) return sendJson(res, 409, { error: 'MajaOS runs without a password.' });
    if (!checkPassword(body.current)) { await slow(); return sendJson(res, 401, { error: 'Your current password is not correct.' }); }
    auth.setPassword(body.password);
    removePasswordIssue();
    setSession(res, true);
    return sendJson(res, 200, { ok: true, changed: auth.passwordChanged() });
  }
  // Welcome wizard: what is already set up, and finish or start over.
  if (p === '/api/onboarding' && method === 'GET') {
    const [pools, opts] = await Promise.all([storage.poolSizes().catch(() => null), zpool.poolOptions().catch(() => null)]);
    return sendJson(res, 200, {
      ...onboarding.getState(), hostname: os.hostname(), timezone: datetime.hostTimezone(),
      passwordChanged: auth.passwordChanged(), user: auth.userName(), mfa: auth.mfaEnabled(), appdata: paths.dir('appdata'),
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
  if (p === '/api/network/hostname' && method === 'POST') {
    const r = await network.setHostname((await readBody(req)).hostname);
    refreshHttps().catch((e) => console.error('HTTPS certificate: ' + e.message)); // the new name in the certificate
    refreshIssue(); // and <name>.local on the server's screen
    return sendJson(res, 200, r);
  }

  if (p === '/api/docker-networks' && method === 'GET') return sendJson(res, 200, await dockernet.listNetworks());
  // "Own address in my home network": the home network, the macvlan network if there is one, and a free address.
  if (p === '/api/docker-networks/lan' && method === 'GET') return sendJson(res, 200, await dockernet.lanInfo());
  if (p === '/api/docker-networks' && method === 'POST') return sendJson(res, 200, await dockernet.createNetwork(await readBody(req)));
  if ((m = p.match(/^\/api\/docker-networks\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, await dockernet.deleteNetwork(decodeURIComponent(m[1])));

  if (p === '/api/shares' && method === 'GET') return sendJson(res, 200, { ...(await shares.listShares()), places: await files.places(), admin: auth.userName() });
  if (p === '/api/shares' && method === 'POST') return sendJson(res, 200, await shares.saveShare(await readBody(req)));
  if (p === '/api/files/eject' && method === 'POST') return sendJson(res, 200, await files.eject((await readBody(req)).id));
  if (p === '/api/remote' && method === 'GET') return sendJson(res, 200, await tunnel.status());
  if (p === '/api/remote' && method === 'POST') return sendJson(res, 200, await tunnel.apply(await readBody(req)));
  if (p === '/api/share-links' && method === 'GET') return sendJson(res, 200, { links: sharelinks.list() });
  if (p === '/api/share-links' && method === 'POST') return sendJson(res, 200, await sharelinks.create(await readBody(req)));
  if ((m = p.match(/^\/api\/share-links\/([0-9a-f]{8})$/)) && method === 'DELETE') return sendJson(res, 200, sharelinks.remove(m[1]));
  if ((m = p.match(/^\/api\/shares\/([^/]+)\/files$/))) {
    const name = decodeURIComponent(m[1]);
    const rel = url.searchParams.get('path') || '';
    await files.prepare(name);
    if (method === 'GET' && url.searchParams.get('text') === '1') return sendJson(res, 200, files.readText(name, rel));
    if (method === 'GET' && url.searchParams.get('zip') === '1') { await files.sendZip(res, name, rel); return; }
    if (method === 'GET' && (url.searchParams.get('dl') === '1' || url.searchParams.get('inline') === '1')) {
      files.sendFile(res, name, rel, { inline: url.searchParams.get('inline') === '1', range: req.headers.range });
      return;
    }
    if (method === 'GET') return sendJson(res, 200, files.list(name, rel));
    if (method === 'PUT') return sendJson(res, 200, await files.upload(req, name, rel, { overwrite: url.searchParams.get('overwrite') === '1' }));
    if (method === 'DELETE') return sendJson(res, 200, files.remove(name, rel, { recursive: url.searchParams.get('recursive') === '1' }));
    if (method === 'POST') return sendJson(res, 200, files.act(name, await readBody(req)));
  }
  if ((m = p.match(/^\/api\/shares\/([^/]+)$/)) && method === 'POST') return sendJson(res, 200, await shares.saveShare(await readBody(req), decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/shares\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, await shares.deleteShare(decodeURIComponent(m[1])));
  if (p === '/api/share-users' && method === 'POST') return sendJson(res, 200, await shares.createUser(await readBody(req)));
  if ((m = p.match(/^\/api\/share-users\/([^/]+)\/password$/)) && method === 'POST') return sendJson(res, 200, await shares.setPassword(decodeURIComponent(m[1]), (await readBody(req)).password));
  if ((m = p.match(/^\/api\/share-users\/([^/]+)$/)) && method === 'POST') return sendJson(res, 200, await shares.saveUserAccess(decodeURIComponent(m[1]), await readBody(req)));
  if (p === '/api/share-groups' && method === 'POST') return sendJson(res, 200, await shares.saveGroup(await readBody(req)));
  if ((m = p.match(/^\/api\/share-groups\/([^/]+)$/)) && method === 'POST') return sendJson(res, 200, await shares.saveGroup(await readBody(req), decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/share-groups\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, await shares.deleteGroup(decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/share-users\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, await shares.deleteUser(decodeURIComponent(m[1])));
  // Backups: devices to the NAS, and the NAS to the cloud or another NAS (rclone).
  if (p === '/api/backup' && method === 'GET') return sendJson(res, 200, await backup.overview({ brief: url.searchParams.get('brief') === '1' }));
  // Backups of apps and VMs to a folder on the NAS (lib/sysbackup.js).
  if (p === '/api/sysbackups' && method === 'GET') return sendJson(res, 200, await sysbackup.overview());
  if (p === '/api/sysbackups' && method === 'POST') return sendJson(res, 200, await sysbackup.saveJob(await readBody(req)));
  if ((m = p.match(/^\/api\/sysbackups\/([0-9a-f]{8})$/)) && method === 'POST') return sendJson(res, 200, await sysbackup.saveJob(await readBody(req), m[1]));
  if ((m = p.match(/^\/api\/sysbackups\/([0-9a-f]{8})$/)) && method === 'DELETE') return sendJson(res, 200, sysbackup.deleteJob(m[1]));
  if ((m = p.match(/^\/api\/sysbackups\/([0-9a-f]{8})\/log$/)) && method === 'GET') return sendJson(res, 200, sysbackup.jobLog(m[1]));
  if ((m = p.match(/^\/api\/sysbackups\/([0-9a-f]{8})\/runs$/)) && method === 'GET') return sendJson(res, 200, sysbackup.listRuns(m[1]));
  if ((m = p.match(/^\/api\/sysbackups\/([0-9a-f]{8})\/(run|stop|restore)$/)) && method === 'POST') {
    const body = await readBody(req);
    if (m[2] === 'stop') return sendJson(res, 200, sysbackup.stopRun(m[1]));
    if (m[2] === 'restore') return sendJson(res, 200, await sysbackup.restore(m[1], body));
    return sendJson(res, 200, await sysbackup.startRun(m[1]));
  }
  if (p === '/api/backup/remotes' && method === 'POST') return sendJson(res, 200, await backup.createRemote(await readBody(req)));
  if (p === '/api/backup/auth' && method === 'POST') return sendJson(res, 200, await backup.startAuth((await readBody(req)).type));
  if (p === '/api/backup/auth/finish' && method === 'POST') return sendJson(res, 200, await backup.finishAuth(await readBody(req)));
  if ((m = p.match(/^\/api\/backup\/remotes\/([^/]+)\/test$/)) && method === 'POST') return sendJson(res, 200, await backup.testRemote(decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/backup\/remotes\/([^/]+)\/browse$/)) && method === 'GET') return sendJson(res, 200, await backup.browse(decodeURIComponent(m[1]), url.searchParams.get('path') || ''));
  if ((m = p.match(/^\/api\/backup\/remotes\/([^/]+)$/)) && method === 'DELETE') return sendJson(res, 200, backup.deleteRemote(decodeURIComponent(m[1])));
  if (p === '/api/backup/jobs' && method === 'POST') return sendJson(res, 200, await backup.saveJob(await readBody(req)));
  if ((m = p.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})$/)) && method === 'POST') return sendJson(res, 200, await backup.saveJob(await readBody(req), m[1]));
  if ((m = p.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})$/)) && method === 'DELETE') return sendJson(res, 200, backup.deleteJob(m[1]));
  if ((m = p.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})\/log$/)) && method === 'GET') return sendJson(res, 200, backup.jobLog(m[1]));
  if ((m = p.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})\/(run|stop|restore)$/)) && method === 'POST') {
    const body = await readBody(req);
    if (m[2] === 'stop') return sendJson(res, 200, backup.stopRun(m[1]));
    if (m[2] === 'restore') return sendJson(res, 200, await backup.restore(m[1], body));
    return sendJson(res, 200, await backup.startRun(m[1], { dryRun: !!body.dryRun }));
  }
  if (p === '/api/backup/devices' && method === 'POST') return sendJson(res, 200, await backup.createDevice(await readBody(req)));
  if ((m = p.match(/^\/api\/backup\/devices\/([^/]+)\/password$/)) && method === 'POST') return sendJson(res, 200, await backup.devicePassword(decodeURIComponent(m[1])));
  if ((m = p.match(/^\/api\/backup\/devices\/([^/]+)\/pair$/)) && method === 'POST') return sendJson(res, 200, await backup.devicePairing(decodeURIComponent(m[1])));
  if (p === '/api/backup/kopia' && method === 'POST') return sendJson(res, 200, await backup.setKopia(await readBody(req)));
  if ((m = p.match(/^\/api\/backup\/devices\/([^/]+)$/)) && method === 'DELETE') {
    return sendJson(res, 200, await backup.deleteDevice(decodeURIComponent(m[1]), url.searchParams.get('data') === '1'));
  }
  if (p === '/api/storage' && method === 'GET') {
    const [body, repair] = await Promise.all([storage.storage(), replace.look().then((r) => r.repair, () => null)]);
    return sendJson(res, 200, { ...body, repair });
  }
  if ((m = p.match(/^\/api\/disks\/([^/]+)$/)) && method === 'GET') return sendJson(res, 200, await disks.diskInfo(decodeURIComponent(m[1]), url.searchParams.get('wake') === '1'));
  if ((m = p.match(/^\/api\/disks\/([^/]+)\/test$/)) && method === 'POST') return sendJson(res, 200, await disks.selfTest(decodeURIComponent(m[1]), (await readBody(req)).type));
  if (p === '/api/pools/options' && method === 'GET') return sendJson(res, 200, await zpool.poolOptions());
  if (p === '/api/pools' && method === 'POST') return sendJson(res, 200, await zpool.createPool(await readBody(req)));
  // Storage locations (Settings → Storage): move app data to another pool, or choose a pool for VMs, ISOs and shared folders.
  if (p === '/api/storage-paths' && method === 'GET') return sendJson(res, 200, await migrate.overview());
  if (p === '/api/storage-paths' && method === 'POST') {
    const body = await readBody(req);
    if (body.path) return sendJson(res, 200, await migrate.usePath(body.kind, body.path)); // point to an existing folder, nothing moves
    if (body.kind === 'appdata') return sendJson(res, 200, await migrate.migrateAppdata(body.pool));
    return sendJson(res, 200, await migrate.setLocation(body.kind, body.pool));
  }
  if (p === '/api/storage-paths/migration' && method === 'GET') return sendJson(res, 200, { migration: migrate.status() });
  if (p === '/api/bays' && method === 'POST') return sendJson(res, 200, bays.saveBays(await readBody(req)));

  if (p === '/api/ai' && method === 'GET') return sendJson(res, 200, await ai.status());
  if (p === '/api/ai/settings' && method === 'POST') return sendJson(res, 200, ai.save(await readBody(req)));
  if (p === '/api/ai/pull' && method === 'POST') {
    const body = await readBody(req);
    if (!MODEL_NAME.test(body.name || '')) return sendJson(res, 400, { error: 'Invalid model name' });
    return proxyStream(res, '/api/pull', { name: body.name, stream: true });
  }
  if (p === '/api/ai/chat' && method === 'POST') {
    return ai.chat(res, await readBody(req, 5e6), { token: cookies(req).tb_session || '', port: CFG.port });
  }
  if ((m = p.match(/^\/api\/ai\/models\/(.+)$/)) && method === 'DELETE') {
    const base = needOllama();
    const name = decodeURIComponent(m[1]);
    if (!MODEL_NAME.test(name)) return sendJson(res, 400, { error: 'Invalid model name' });
    await requestJson(base + '/api/delete', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    return sendJson(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/api\/ai\/models\/(.+)\/(load|unload)$/)) && method === 'POST') {
    const base = needOllama();
    const name = decodeURIComponent(m[1]);
    if (!MODEL_NAME.test(name)) return sendJson(res, 400, { error: 'Invalid model name' });
    await requestJson(base + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 120000,
      body: JSON.stringify({ model: name, keep_alive: m[2] === 'load' ? '24h' : 0 }),
    });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (serr, st) => {
    if (serr || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    // The browser checks each time whether the file changed (304 if it is the same),
    // so a new version of MajaOS shows up right after a normal refresh.
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    // No other site may show these pages in a frame (clickjacking). The console window is the same origin.
    const headers = {
      'Cache-Control': 'no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'",
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
}

/* ------------------------------------------------------------------ HTTPS */

// HTTPS next to the web port, with an own certificate (lib/tls.js). Not in the demo.
let secure = null;
const isLoopback = (req) => /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket.remoteAddress || ''));
// Browsers that come in over http go to https. Not for the server itself: the remote access tunnel and the
// updater talk to http://127.0.0.1, and the backup app pairs over http with its own certificate check.
function toHttps(req, res, url) {
  if (!secure || req.socket.encrypted || isLoopback(req) || url.pathname.startsWith('/api/backup/pair/')) return false;
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  const name = /^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(host) ? host : (req.socket.localAddress || '').replace(/^::ffff:/, '');
  const port = settings.httpsPort();
  res.writeHead(308, { Location: `https://${name}${port === 443 ? '' : ':' + port}${req.url}`, 'Cache-Control': 'no-store' });
  res.end();
  return true;
}
async function startHttps() {
  const port = CFG.demo ? 0 : settings.httpsPort();
  if (!port) { if (secure) { secure.close(); secure = null; } return null; }
  const { key, cert } = await tlsCert.ensure();
  const next = https.createServer({ key, cert }, onRequest);
  next.on('upgrade', onUpgrade);
  await new Promise((resolve, reject) => { next.once('error', reject); next.listen(port, () => { next.removeListener('error', reject); resolve(); }); });
  const prev = secure;
  secure = next; secure.port = port;
  if (prev) prev.close();
  return port;
}
// A new host name or address needs a new certificate: swap it in without restarting.
async function refreshHttps() {
  if (!secure) return;
  const r = await tlsCert.ensure();
  if (r.renewed) { secure.setSecureContext({ key: r.key, cert: r.cert }); console.log(`New HTTPS certificate (${r.reason}).`); }
}

// The server's own screen: the logo with the address (lib/issue.js). After every change of what it says.
function refreshIssue() {
  if (CFG.demo) return;
  issue.write({ https: settings.httpsPort() > 0, httpsPort: settings.httpsPort(), port: CFG.port, setup: needsSetup(), hostname: os.hostname(), mdns: issue.hasMdns() })
    .catch((e) => console.error('Screen text: ' + e.message));
}

// Older installs showed the first password on the server's screen: remove it as soon as there is an own one.
function removePasswordIssue() {
  const pwIssue = '/etc/issue.d/homebaseos-wachtwoord.issue';
  if (fs.existsSync(pwIssue)) { fs.rmSync(pwIssue, { force: true }); sys.run('agetty', ['--reload']).catch(() => {}); }
}

let server;

function onRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const shared = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{16,80})(?:\/(.*))?$/);
  Promise.resolve().then(() => {
    if (toHttps(req, res, url)) return;
    if (shared) return sharelinks.send(req, res, shared[1], shared[2] ? decodeURIComponent(shared[2]) : '', clientIp(req));
    // MCP connector: one address, then the program signs in. It sits outside the cookie check on purpose.
    if (mcphttp.match(url.pathname)) {
      return mcphttp.handle(req, res, {
        port: () => CFG.port, validToken, makeToken, checkPassword, auth, passwordEnabled, needsSetup,
        language: () => settings.getSettings().language, clientIp, slow,
        enabled: () => settings.getSettings().mcp !== false,
      });
    }
    return url.pathname.startsWith('/api/') ? handleApi(req, res, url) : serveStatic(req, res, url);
  }).catch((e) => {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    if (status === 413 && !res.headersSent) res.setHeader('Connection', 'close'); // the rest of the body is not read
    if (!res.headersSent) sendJson(res, status, { ...(e.data || {}), error: e.message || 'Unknown error' });
    else res.end();
  });
}

// Console: the browser (noVNC) opens a WebSocket to /api/vms/<name>/vnc, we pass it on to QEMU's VNC screen.
async function onUpgrade(req, socket, head) {
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
    // Terminal on the server: only when it is turned on and with a valid one-time ticket.
    if (!settings.getSettings().terminal) return deny(403, 'Forbidden');
    if (!terminal.useTicket(url.searchParams.get('ticket'))) return deny(401, 'Unauthorized');
    const conn = ws.acceptWebSocket(req, socket, head);
    if (conn) terminal.attach(conn, { cols: Number(url.searchParams.get('cols')) || 120, rows: Number(url.searchParams.get('rows')) || 32, who: req.socket.remoteAddress });
    return;
  }
  try { ws.proxyToTcp(req, socket, head, await vms.vncPort(decodeURIComponent(m[1]))); }
  catch (e) { deny(e.status === 404 ? 404 : 409, 'Conflict'); }
}

// Open a port. The previous port stays up until this one is listening, so a failed change does not drop the page.
function bind(port) {
  const next = http.createServer(onRequest);
  next.on('upgrade', onUpgrade);
  return new Promise((resolve, reject) => {
    const fail = (err) => { next.removeListener('listening', ok); reject(err); };
    const ok = () => {
      next.removeListener('error', fail);
      const prev = server;
      server = next;
      CFG.port = port;
      if (prev) prev.close();
      resolve();
    };
    next.once('error', fail);
    next.once('listening', ok);
    next.listen(port);
  });
}

bind(CFG.port).then(() => {
  console.log(`MajaOS is running on port ${CFG.port}` + (CFG.demo ? ' (demo mode)' : ''));
  // MajaOS runs as root: until there is an account, you can only create that account (all other endpoints return 401).
  if (needsSetup()) console.log(`No account yet. Open http://<address>:${CFG.port} to create one.`);
  if (!CFG.demo) {
    startHttps().then((port) => port && console.log(`HTTPS on port ${port}.`))
      .catch((e) => console.error('HTTPS could not start, only http works: ' + e.message));
    // A new address (DHCP, Settings → Network) needs a new certificate. openssl only runs when something changed.
    setInterval(() => refreshHttps().catch((e) => console.error('HTTPS certificate: ' + e.message)), 10 * 60000);
    refreshIssue(); // the logo and the address on the server's own screen
    paths.detect().catch(() => {}); // pools that already have an appdata/vms/isos folder
    ssh.enforce(settings.getSettings().ssh).catch((e) => console.error('SSH: ' + e.message));
    vms.bootAutostart();
    // Updates: 2 minutes after start and then every 6 hours (only what hasn't been checked for 6 hours).
    const check = () => docker.checkUpdates(false).then((r) => r.updates && console.log(r.updates + ' app(s) with an update.')).catch(() => {});
    setTimeout(check, 2 * 60000);
    setInterval(check, 6 * 3600000);
    release.startSchedule((msg) => console.log(msg)); // new versions of MajaOS itself
    backup.startSchedule(); // scheduled backup tasks
    sysbackup.startSchedule(); // scheduled backups of apps and VMs
    shadow.startSchedule(); // ZFS snapshots behind Windows Previous Versions
    replace.startSchedule(); // a new disk in place of a failed one starts the rebuild
  }
}).catch((e) => {
  console.error(`MajaOS could not listen on port ${CFG.port}: ${e.message}`);
  process.exit(1);
});
