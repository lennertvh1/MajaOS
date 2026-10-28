'use strict';
/* Serves the installer screen on the USB stick. Listens only on this computer.
 * Wiping a disk happens in iso/run-install.sh, after the name was confirmed. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('../lib/system');
const net = require('node:net');
const installer = require('../lib/installer');
const network = require('../lib/network');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.INSTALL_PORT || 8753);
const DIR = process.env.INSTALL_DIR || '/run/majaos-install';
const STATUS = path.join(DIR, 'status.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

let child = null;
let chosen = null; // the network settings from the network step: they go along to the installed system

function send(res, status, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 1e6) reject(new Error('too large')); else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function status() {
  try { return JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { return { state: 'idle', percent: 0, message: '', log: '' }; }
}
function publicFile(urlPath) {
  const rel = urlPath === '/' ? 'install.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC, rel);
  if (abs !== PUBLIC && !abs.startsWith(PUBLIC + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

async function bootDisk() {
  try {
    const text = await run('findmnt', ['-no', 'SOURCE', '/run/live/medium'], { timeout: 4000 });
    const src = String(text).trim().replace(/\/+$/, '');
    const name = path.basename(src).replace(/[0-9]*$/, '') || path.basename(src);
    if (/^nvme/.test(path.basename(src))) return path.basename(src).replace(/p[0-9]+$/, '');
    if (/^mmcblk/.test(path.basename(src))) return path.basename(src).replace(/p[0-9]+$/, '');
    return name;
  } catch { return ''; }
}

async function disks() {
  const boot = await bootDisk();
  let data;
  try { data = JSON.parse(await run('lsblk', ['-J', '-b', '-o', 'NAME,TYPE,SIZE,MODEL,ROTA,TRAN,MOUNTPOINTS'], { timeout: 8000 })); }
  catch { data = JSON.parse(await run('lsblk', ['-J', '-b', '-o', 'NAME,TYPE,SIZE,MODEL,ROTA,TRAN,MOUNTPOINT'], { timeout: 8000 })); }
  return installer.parseDisks(data, { boot });
}

/* ---- network step: the live system gets the address now, so Debian can be downloaded, and the installed system gets the same */
function physicalCards() {
  try {
    return fs.readdirSync('/sys/class/net').filter((n) => fs.existsSync(`/sys/class/net/${n}/device`) && !/^(wl|ww)/.test(n));
  } catch { return []; }
}
async function cards() {
  const names = physicalCards(), speeds = {};
  for (const n of names) { try { speeds[n] = Number(fs.readFileSync(`/sys/class/net/${n}/speed`, 'utf8')); } catch { /* no cable */ } }
  const [addrs, routes] = await Promise.all([run('ip', ['-j', 'addr'], { timeout: 4000 }), run('ip', ['-j', 'route'], { timeout: 4000 })]);
  return installer.parseCards(JSON.parse(addrs || '[]'), JSON.parse(routes || '[]'), names, speeds);
}
// live-boot only asks DHCP for cards that had a cable at the start, and dhcpcd falls back to 169.254.x.x.
// A card with a cable but without a real address: ask again (in the background, at most every 20 s), without that fallback.
const asked = {};
function askDhcp(list) {
  for (const c of list) {
    if (!c.connected || c.address || (chosen && chosen.interface === c.name && chosen.mode === 'static')) continue;
    if (Date.now() - (asked[c.name] || 0) < 20000) continue;
    asked[c.name] = Date.now();
    quiet('dhcpcd', ['-x', c.name])
      .then(() => quiet('ip', ['-4', 'addr', 'flush', 'dev', c.name]))
      .then(() => quiet('dhcpcd', ['-4', '--noipv4ll', '-b', c.name], 10000));
  }
}
// A real connection to the Debian mirror: a DNS answer alone also comes with a wrong gateway (the router is in the same network).
function online() {
  return new Promise((resolve) => {
    let done = false;
    const end = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => { sock.destroy(); end(false); }, 5000);
    const sock = net.connect({ host: 'deb.debian.org', port: 80 }, () => { sock.destroy(); end(true); });
    sock.on('error', () => end(false));
  });
}
async function waitOnline(seconds) {
  for (let i = 0; i < seconds; i += 2) { if (await online()) return true; await new Promise((r) => setTimeout(r, 2000)); }
  return online();
}
function nameservers() { try { return network.nameservers(fs.readFileSync('/etc/resolv.conf', 'utf8')); } catch { return []; } }
const quiet = (cmd, args, timeout = 8000) => run(cmd, args, { timeout }).catch(() => '');

async function applyLive(cfg) {
  const dev = cfg.interface;
  await quiet('dhcpcd', ['-x', dev]);
  await quiet('ip', ['addr', 'flush', 'dev', dev]);
  await quiet('ip', ['link', 'set', dev, 'up']);
  if (cfg.mode === 'dhcp') {
    await quiet('dhcpcd', ['-4', '--noipv4ll', '-w', '-t', '20', dev], 25000);
  } else {
    await run('ip', ['addr', 'add', cfg.address, 'dev', dev], { timeout: 5000 });
    await run('ip', ['route', 'replace', 'default', 'via', cfg.gateway, 'dev', dev], { timeout: 5000 });
    fs.writeFileSync('/etc/resolv.conf', cfg.dns.map((d) => 'nameserver ' + d).join('\n') + '\n');
  }
}
// Without a choice: DHCP on the card that has the default route (or the first one with a cable).
async function defaultNetwork() {
  const list = await cards();
  const card = list[0];
  return card ? { interface: card.name, mode: 'dhcp', address: '', gateway: '', dns: [], bridge: false, bridgeName: 'br0' } : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, { installer: true, demo: false });
    if (url.pathname === '/api/install/disks' && req.method === 'GET') return send(res, 200, await disks());
    if (url.pathname === '/api/install/progress' && req.method === 'GET') return send(res, 200, status());
    if (url.pathname === '/api/install/network' && req.method === 'GET') {
      const [list, ok] = await Promise.all([cards(), online()]);
      askDhcp(list);
      return send(res, 200, { cards: list, online: ok, dns: nameservers(), chosen });
    }
    if (url.pathname === '/api/install/network' && req.method === 'POST') {
      if (child) return send(res, 409, { error: 'The installation is already running.' });
      const cfg = network.validate(await readBody(req), physicalCards());
      await applyLive(cfg);
      chosen = cfg;
      const ok = await waitOnline(cfg.mode === 'dhcp' ? 10 : 8);
      return send(res, 200, { online: ok, cards: await cards(), dns: nameservers(), chosen });
    }
    if (url.pathname === '/api/install' && req.method === 'POST') {
      if (child) return send(res, 409, { error: 'The installation is already running.' });
      const body = await readBody(req);
      const list = await disks();
      const picked = installer.choose(list, body);
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(STATUS, JSON.stringify({ state: 'running', percent: 5, message: 'Preparing the installation', log: '' }));
      // The installed system gets the same network, in the file MajaOS manages (Settings > Network).
      const net = chosen || await defaultNetwork();
      for (const f of ['interfaces', 'resolv.conf']) fs.rmSync(path.join(DIR, f), { force: true });
      if (net) fs.writeFileSync(path.join(DIR, 'interfaces'), network.buildInterfaces(net, ''));
      if (net && net.mode === 'static') fs.writeFileSync(path.join(DIR, 'resolv.conf'), net.dns.map((d) => 'nameserver ' + d).join('\n') + '\n');
      const out = fs.openSync(path.join(DIR, 'log.txt'), 'a');
      child = spawn('bash', [path.join(__dirname, 'run-install.sh'), picked.disk.name, picked.language, body.nvidia ? '1' : '0'], {
        env: { ...process.env, INSTALL_DIR: DIR, STATUS, ROOT }, stdio: ['ignore', out, out],
      });
      fs.closeSync(out);
      // A script that stops without saying so would leave the screen on its last step forever.
      child.on('exit', (code) => {
        child = null;
        const now = status();
        if (code !== 0 && now.state === 'running') {
          fs.writeFileSync(STATUS, JSON.stringify({ ...now, state: 'failed', message: 'The installation could not be prepared. Open Details to see why.' }));
        }
      });
      return send(res, 200, { started: true });
    }
    if (url.pathname === '/api/install/reboot' && req.method === 'POST') {
      spawn('systemctl', ['reboot'], { detached: true, stdio: 'ignore' }).unref();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      const file = publicFile(url.pathname);
      if (file) return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message || 'The installer failed.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'server-ready'), '1');
  } catch { /* the session still opens the page */ }
});
