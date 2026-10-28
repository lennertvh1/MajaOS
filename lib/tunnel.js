'use strict';
/* Reach MajaOS from the internet without forwarding a port.
 * cloudflared opens the connection itself (Settings → Remote access).
 * A temporary address is a Cloudflare quick tunnel: the name changes when it starts again.
 * A fixed address is a tunnel token plus the hostname configured for it at Cloudflare. */
const fs = require('node:fs');
const path = require('node:path');
const { run, httpError } = require('./system');
const settings = require('./settings');

const SERVICE = 'majaos-tunnel';
const UNIT = '/etc/systemd/system/majaos-tunnel.service';
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function dataDir() { return process.env.DATA_DIR || '/var/lib/majaos'; }
function stateFile() { return path.join(dataDir(), 'tunnel.json'); }
function envFile() { return path.join(dataDir(), 'tunnel.env'); }
function logFile() { return path.join(dataDir(), 'tunnel.log'); }

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { mode: 'off', address: '', url: '' }; }
}

function writeState(st) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile() + '.tmp', JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.renameSync(stateFile() + '.tmp', stateFile());
}

function readToken() {
  try {
    const m = fs.readFileSync(envFile(), 'utf8').match(/^TOKEN=(.*)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function writeToken(token) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envFile(), `TOKEN=${token}\n`, { mode: 0o600 });
}

function parseQuickUrl(text) {
  const m = String(text || '').match(QUICK_URL);
  return m ? m[0] : '';
}

// https://home.example.com, or home.example.com. No path, user or query.
function normalizePublic(input) {
  let s = String(input || '').trim();
  if (!s) throw httpError('Type an address like https://home.example.com.', 400);
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw httpError('Type an address like https://home.example.com.', 400); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw httpError('Type an address like https://home.example.com.', 400);
  }
  return u.origin;
}

function unitText(mode, { bin, port, log, env }) {
  const start = mode === 'token'
    ? `${bin} --no-autoupdate tunnel run --token $TOKEN`
    : `${bin} --no-autoupdate tunnel --url http://127.0.0.1:${port}`;
  return `# Created by MajaOS (Settings → Remote access). Changes here are overwritten.
[Unit]
Description=MajaOS remote access
After=network-online.target
Wants=network-online.target

[Service]
${mode === 'token' ? `EnvironmentFile=${env}\n` : ''}ExecStart=${start}
Restart=on-failure
RestartSec=5
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=multi-user.target
`;
}

function rememberQuickUrl(st) {
  if (!st || st.mode !== 'quick') return st || { mode: 'off', address: '', url: '' };
  let text = '';
  try { text = fs.readFileSync(logFile(), 'utf8'); } catch { /* not started yet */ }
  const url = parseQuickUrl(text);
  if (url && url !== st.url) {
    st = { ...st, url };
    writeState(st);
  }
  return st;
}

async function bin() {
  try { return (await run('which', ['cloudflared'], { timeout: 5000 })).trim(); } catch { return ''; }
}

async function active() {
  try { return (await run('systemctl', ['is-active', SERVICE], { timeout: 5000, anyExit: true })).trim() === 'active'; }
  catch { return false; }
}

async function installUnit(text) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(logFile(), '');
  fs.writeFileSync(UNIT, text);
  await run('systemctl', ['daemon-reload'], { timeout: 30000 });
  await run('systemctl', ['enable', SERVICE], { timeout: 30000 });
  await run('systemctl', ['restart', SERVICE], { timeout: 30000 });
}

async function stopUnit() {
  await run('systemctl', ['disable', '--now', SERVICE], { timeout: 30000 }).catch(() => {});
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startQuick() {
  const pathToBin = await bin();
  if (!pathToBin) throw httpError('Remote access is not installed on the server.', 503);
  const port = settings.listenPort();
  await installUnit(unitText('quick', { bin: pathToBin, port, log: logFile(), env: envFile() }));
  let url = '';
  for (let i = 0; i < 40 && !url; i++) {
    await wait(500);
    url = parseQuickUrl(fs.readFileSync(logFile(), 'utf8'));
  }
  writeState({ ...readState(), mode: 'quick', url });
  return status();
}

async function startToken(token, address) {
  const pathToBin = await bin();
  if (!pathToBin) throw httpError('Remote access is not installed on the server.', 503);
  const origin = normalizePublic(address);
  const next = String(token || '').trim() || readToken();
  if (!/^[A-Za-z0-9+/=_.-]{20,8000}$/.test(next)) throw httpError('Paste the tunnel token from Cloudflare.', 400);
  writeToken(next);
  const port = settings.listenPort();
  await installUnit(unitText('token', { bin: pathToBin, port, log: logFile(), env: envFile() }));
  await wait(2000);
  if (!(await active())) {
    await stopUnit();
    throw httpError('The tunnel did not start. Check the token and the address, then try again.', 502);
  }
  writeState({ mode: 'token', address: origin, url: origin });
  return status();
}

async function stop() {
  await stopUnit();
  const st = readState();
  writeState({ ...st, mode: 'off', url: '' });
  return status();
}

// The web port changed: point the tunnel at the new one. A temporary address changes with it.
async function retarget() {
  const st = readState();
  if (!st || st.mode === 'off') return;
  if (st.mode === 'quick') await startQuick();
  else if (st.address) await startToken('', st.address);
}

function publicUrl() {
  const st = rememberQuickUrl(readState());
  if (!st || st.mode === 'off') return '';
  return st.mode === 'quick' ? (st.url || '') : (st.address || '');
}

async function status() {
  const st = rememberQuickUrl(readState());
  const pathToBin = await bin();
  const running = st.mode !== 'off' && await active();
  return {
    installed: !!pathToBin, running, mode: st.mode || 'off',
    url: publicUrl(), address: st.address || '', hasToken: !!readToken(),
  };
}

async function apply(body) {
  const mode = body && body.mode;
  if (mode === 'off') return stop();
  if (mode === 'quick') return startQuick();
  if (mode === 'token') return startToken(body.token, body.address);
  throw httpError('Choose a temporary address or a fixed address.', 400);
}

module.exports = { parseQuickUrl, normalizePublic, unitText, publicUrl, status, apply, retarget };
