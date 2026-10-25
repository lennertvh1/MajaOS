'use strict';
/* Serves the installer screen on the USB stick. Listens only on this computer.
 * Wiping a disk happens in iso/run-install.sh, after the name was confirmed. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('../lib/system');
const installer = require('../lib/installer');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.INSTALL_PORT || 8753);
const DIR = process.env.INSTALL_DIR || '/run/homebaseos-install';
const STATUS = path.join(DIR, 'status.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

let child = null;

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, { installer: true, demo: false });
    if (url.pathname === '/api/install/disks' && req.method === 'GET') return send(res, 200, await disks());
    if (url.pathname === '/api/install/progress' && req.method === 'GET') return send(res, 200, status());
    if (url.pathname === '/api/install' && req.method === 'POST') {
      if (child) return send(res, 409, { error: 'The installation is already running.' });
      const body = await readBody(req);
      const list = await disks();
      const picked = installer.choose(list, body);
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(STATUS, JSON.stringify({ state: 'running', percent: 5, message: 'Preparing the installation', log: '' }));
      child = spawn('bash', [path.join(__dirname, 'run-install.sh'), picked.disk.name, picked.language, body.nvidia ? '1' : '0'], {
        env: { ...process.env, INSTALL_DIR: DIR, STATUS, ROOT },
      });
      child.on('exit', () => { child = null; });
      return send(res, 200, { started: true });
    }
    if (url.pathname === '/api/install/ui-ready' && req.method === 'POST') {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(path.join(DIR, 'ui-ready'), '1');
      return send(res, 200, { ok: true });
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

server.listen(PORT, '127.0.0.1');
