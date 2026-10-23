'use strict';
/*
 * Terminal on the server: a root shell (bash) in the browser via xterm.js.
 * Node has no pseudo-terminal of its own; `script` from util-linux (always present on Debian) creates one.
 * Every connection needs a one-time ticket (after the password, if that is turned on in Security).
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { run } = require('./system');

/* ---- tickets: one-time, valid for 60 seconds */
const tickets = new Map(); // ticket → expiry time
function newTicket() {
  const now = Date.now();
  for (const [k, until] of tickets) if (until < now) tickets.delete(k);
  const t = crypto.randomBytes(24).toString('base64url');
  tickets.set(t, now + 60000);
  return t;
}
function useTicket(t) {
  const until = tickets.get(String(t || ''));
  tickets.delete(String(t || ''));
  return !!until && until >= Date.now();
}

// Messages from the browser: {t: 'd', d: '…'} (keys) or {t: 'r', cols, rows} (size).
function parseMessage(msg) {
  if (typeof msg !== 'string') return { t: 'd', d: msg };
  try {
    const m = JSON.parse(msg);
    if (m && m.t === 'd' && typeof m.d === 'string') return m;
    if (m && m.t === 'r') {
      const cols = Math.round(Number(m.cols)), rows = Math.round(Number(m.rows));
      if (cols >= 10 && cols <= 1000 && rows >= 3 && rows <= 500) return { t: 'r', cols, rows };
    }
  } catch { /* not JSON */ }
  return null;
}

// The pseudo-terminal of the shell, to change its size (stty -F … rows … cols …).
function shellTty(scriptPid) {
  try {
    const kids = fs.readFileSync(`/proc/${scriptPid}/task/${scriptPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    for (const pid of kids) { const tty = fs.readlinkSync(`/proc/${pid}/fd/0`); if (tty.startsWith('/dev/pts/')) return tty; }
  } catch { /* not started yet */ }
  return null;
}

// Attach a shell to a WebSocket (see websocket.acceptWebSocket).
// command: only for tests (`script` works differently on macOS).
function attach(ws, { cols = 120, rows = 32, log = console.log, who = '', command = null } = {}) {
  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const home = process.env.HOME && fs.existsSync(process.env.HOME) ? process.env.HOME : '/root';
  // Integers within limits: they come from the URL and go into the command of script.
  const c = Math.min(1000, Math.max(10, Math.round(Number(cols)) || 120)), r = Math.min(500, Math.max(3, Math.round(Number(rows)) || 32));
  const [cmd, ...args] = command || ['script', '-qfec', `stty rows ${r} cols ${c}; exec ${shell} -l`, '/dev/null'];
  const child = spawn(cmd, args, {
    cwd: fs.existsSync(home) ? home : '/', detached: true,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', HOME: home, LANG: process.env.LANG || 'C.UTF-8', SHELL: shell },
  });
  log('Terminal opened' + (who ? ' from ' + who : '') + '.');
  let tty = null;
  const resize = async (c, r) => {
    tty = tty || shellTty(child.pid);
    if (tty) await run('stty', ['-F', tty, 'rows', String(r), 'cols', String(c)], { timeout: 3000 }).catch(() => {});
  };
  child.stdout.on('data', (d) => ws.send(d));
  child.stderr.on('data', (d) => ws.send(d));
  child.on('error', (e) => { ws.send(Buffer.from('\r\nThe terminal could not start: ' + e.message + '\r\n')); ws.close(); });
  child.on('exit', () => { ws.send(Buffer.from('\r\n[The shell has exited.]\r\n')); ws.close(); });
  ws.on('message', (msg) => {
    const m = parseMessage(msg);
    if (!m) return;
    if (m.t === 'd') child.stdin.write(m.d);
    else resize(m.cols, m.rows);
  });
  ws.on('close', () => {
    try { process.kill(-child.pid, 'SIGHUP'); } catch { /* already stopped */ }
    log('Terminal closed' + (who ? ' (' + who + ')' : '') + '.');
  });
  return child;
}

module.exports = { newTicket, useTicket, attach, parseMessage };
