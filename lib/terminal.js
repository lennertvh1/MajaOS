'use strict';
/*
 * Terminal op de server: een root-shell (bash) in de browser via xterm.js.
 * Node heeft zelf geen pseudo-terminal; `script` van util-linux (altijd aanwezig op Debian) maakt er een.
 * Elke verbinding heeft een eenmalig ticket nodig (na het wachtwoord, als dat in Beveiliging aan staat).
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { run } = require('./system');

/* ---- tickets: eenmalig, 60 seconden geldig */
const tickets = new Map(); // ticket → vervaltijd
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

// Berichten van de browser: {t: 'd', d: '…'} (toetsen) of {t: 'r', cols, rows} (grootte).
function parseMessage(msg) {
  if (typeof msg !== 'string') return { t: 'd', d: msg };
  try {
    const m = JSON.parse(msg);
    if (m && m.t === 'd' && typeof m.d === 'string') return m;
    if (m && m.t === 'r') {
      const cols = Math.round(Number(m.cols)), rows = Math.round(Number(m.rows));
      if (cols >= 10 && cols <= 1000 && rows >= 3 && rows <= 500) return { t: 'r', cols, rows };
    }
  } catch { /* geen JSON */ }
  return null;
}

// De pseudo-terminal van de shell, om de grootte aan te passen (stty -F … rows … cols …).
function shellTty(scriptPid) {
  try {
    const kids = fs.readFileSync(`/proc/${scriptPid}/task/${scriptPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    for (const pid of kids) { const tty = fs.readlinkSync(`/proc/${pid}/fd/0`); if (tty.startsWith('/dev/pts/')) return tty; }
  } catch { /* nog niet gestart */ }
  return null;
}

// Een shell koppelen aan een WebSocket (zie websocket.acceptWebSocket).
// command: alleen voor tests (op macOS werkt `script` anders).
function attach(ws, { cols = 120, rows = 32, log = console.log, who = '', command = null } = {}) {
  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  const home = process.env.HOME && fs.existsSync(process.env.HOME) ? process.env.HOME : '/root';
  // Gehele getallen binnen grenzen: ze komen uit de URL en gaan in het commando van script.
  const c = Math.min(1000, Math.max(10, Math.round(Number(cols)) || 120)), r = Math.min(500, Math.max(3, Math.round(Number(rows)) || 32));
  const [cmd, ...args] = command || ['script', '-qfec', `stty rows ${r} cols ${c}; exec ${shell} -l`, '/dev/null'];
  const child = spawn(cmd, args, {
    cwd: fs.existsSync(home) ? home : '/', detached: true,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', HOME: home, LANG: process.env.LANG || 'C.UTF-8', SHELL: shell },
  });
  log('Terminal geopend' + (who ? ' vanaf ' + who : '') + '.');
  let tty = null;
  const resize = async (c, r) => {
    tty = tty || shellTty(child.pid);
    if (tty) await run('stty', ['-F', tty, 'rows', String(r), 'cols', String(c)], { timeout: 3000 }).catch(() => {});
  };
  child.stdout.on('data', (d) => ws.send(d));
  child.stderr.on('data', (d) => ws.send(d));
  child.on('error', (e) => { ws.send(Buffer.from('\r\nDe terminal kon niet starten: ' + e.message + '\r\n')); ws.close(); });
  child.on('exit', () => { ws.send(Buffer.from('\r\n[De shell is afgesloten.]\r\n')); ws.close(); });
  ws.on('message', (msg) => {
    const m = parseMessage(msg);
    if (!m) return;
    if (m.t === 'd') child.stdin.write(m.d);
    else resize(m.cols, m.rows);
  });
  ws.on('close', () => {
    try { process.kill(-child.pid, 'SIGHUP'); } catch { /* al gestopt */ }
    log('Terminal gesloten' + (who ? ' (' + who + ')' : '') + '.');
  });
  return child;
}

module.exports = { newTicket, useTicket, attach, parseMessage };
