/* Terminal on the server: a root shell in the browser with xterm.js. Opens in HomeBaseOS (iframe) or on its own via "Separate window". */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);

  /* ---- language and theme, like in app.js */
  const DICTS = window.TB_LANG || {};
  let LANG = 'en';
  try { LANG = localStorage.getItem('tb-lang') || 'en'; } catch (e) { /* private window */ }
  const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : String(s));
  function t(s, vars) { const d = DICTS[LANG]; return fill(d && d[s] != null ? d[s] : s, vars); }
  const tr = (m) => { const d = DICTS[LANG]; return d && d[m] != null ? d[m] : m; };
  function translateStatic() {
    document.documentElement.lang = LANG;
    document.querySelectorAll('[data-t]').forEach((el) => { el.dataset.key = el.dataset.key || el.textContent.trim(); el.textContent = t(el.dataset.key); });
    document.querySelectorAll('[data-t-ph]').forEach((el) => { el.dataset.key = el.dataset.key || el.placeholder; el.placeholder = t(el.dataset.key); el.setAttribute('aria-label', t(el.dataset.key)); });
    document.querySelectorAll('[data-t-label]').forEach((el) => { const k = el.dataset.key || el.getAttribute('aria-label'); el.dataset.key = k; el.setAttribute('aria-label', t(k)); el.title = t(k); });
  }
  try { const th = localStorage.getItem('tb-theme'); if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th; } catch (e) { /* default */ }

  const embedded = window.self !== window.top;
  let cfg = null, demo = false, sock = null, term = null, fit = null;

  function status(text, buttons = [], login = false) {
    $('#tStatus').hidden = !text && !login;
    $('#tStatusText').textContent = text || '';
    $('#tLogin').hidden = !login;
    const box = $('#tStatusBtns'); box.innerHTML = '';
    buttons.forEach(([label, fn, primary]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = label;
      b.addEventListener('click', fn); box.appendChild(b);
    });
    if (login) setTimeout(() => $('#tPw').focus(), 30);
  }
  const setState = (label, cls) => { $('#tState').textContent = label; $('#tState').className = 'pill ' + (cls || ''); };

  /* ---- xterm: colours from the HomeBaseOS tokens */
  function makeTerm() {
    const css = getComputedStyle(document.documentElement), v = (n) => css.getPropertyValue(n).trim();
    term = new window.Terminal({
      cursorBlink: true, fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: 14, scrollback: 5000, allowProposedApi: false,
      theme: { background: v('--term-bg'), foreground: v('--term-fg'), cursor: v('--accent'), selectionBackground: v('--term-sel') },
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('#term'));
    fit.fit();
    new ResizeObserver(() => { try { fit.fit(); } catch (e) { /* not visible */ } }).observe($('#term'));
    term.onResize(({ cols, rows }) => send({ t: 'r', cols, rows }));
    term.onData((d) => (demo ? demoInput(d) : send({ t: 'd', d })));
  }
  const send = (m) => { if (sock && sock.readyState === 1) sock.send(JSON.stringify(m)); };

  /* ---- connect: ticket (with the password if Security asks for it), then the WebSocket */
  async function getTicket(password) {
    const r = await fetch('/api/terminal/ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ password }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; throw e; }
    return j.ticket;
  }
  async function open(password) {
    $('#tError').textContent = '';
    let ticket;
    try { ticket = await getTicket(password); }
    catch (e) {
      if (e.status === 401 && cfg.terminalPassword) { status(t('Type your password to open the terminal. You get a root shell on the server.'), [], true); $('#tError').textContent = tr(e.message); $('#tPw').select(); return; }
      status(tr(e.message), [[t('Try again'), () => start()]]); return;
    }
    connect(ticket);
  }
  function connect(ticket) {
    status(t('Connecting…')); setState(t('Connecting…'));
    if (!term) makeTerm();
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/terminal?ticket=' + encodeURIComponent(ticket) + '&cols=' + term.cols + '&rows=' + term.rows;
    sock = new WebSocket(url);
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => { status(''); setState(t('Connected'), 'ok'); $('#tReconnect').hidden = true; term.focus(); send({ t: 'r', cols: term.cols, rows: term.rows }); };
    sock.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    sock.onclose = () => {
      sock = null; setState(t('Not connected')); $('#tReconnect').hidden = false;
      term.write('\r\n\x1b[2m' + t('[Connection closed. Click Reconnect for a new shell.]') + '\x1b[0m\r\n');
    };
  }
  $('#tLogin').addEventListener('submit', (e) => { e.preventDefault(); open($('#tPw').value); $('#tPw').value = ''; });
  $('#tReconnect').addEventListener('click', () => start());

  /* ---- separate window */
  if (embedded) { $('#tPop').hidden = false; $('#tClose').hidden = false; document.querySelector('.console-bar .back').hidden = true; }
  const closeParent = () => { if (window.parent && window.parent.TB_closeConsole) window.parent.TB_closeConsole(); };
  $('#tPop').addEventListener('click', () => {
    const w = window.open('/terminal.html', 'tb-terminal', 'popup=yes,width=1100,height=720');
    if (!w) { toast(t('Your browser blocked the new window. Allow pop-ups for HomeBaseOS.'), true); return; }
    if (sock) sock.close();
    closeParent();
  });
  $('#tClose').addEventListener('click', () => { if (sock) sock.close(); closeParent(); });
  function toast(msg, bad) {
    const el = document.createElement('div'); el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = msg;
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), 4000);
  }

  /* ---- demo: a simulated shell */
  let line = '';
  const PROMPT = '\x1b[1;32mroot@freddy\x1b[0m:\x1b[1;34m~\x1b[0m# ';
  const DEMO = {
    help: 'Probeer: ls, uptime, free -h, df -h, zpool status, docker ps, uname -a, clear',
    ls: 'compose  isos  logs  homebaseos.env',
    whoami: 'root',
    uptime: ' 17:32:05 up 12 days,  5:17,  1 user,  load average: 0.42, 0.51, 0.48',
    'uname -a': 'Linux freddy 6.12.48+deb13-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.12.48-1 x86_64 GNU/Linux',
    'free -h': '               total        used        free      shared  buff/cache   available\r\nMem:            31Gi        15Gi       2.1Gi       112Mi        14Gi        15Gi\r\nSwap:          8.0Gi          0B       8.0Gi',
    'df -h': 'Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/sdh2       220G   18G  191G   9% /\r\ntank            5.4T  3.3T  2.1T  62% /tank\r\nsnel            461G  190G  271G  42% /fast',
    'zpool status': '  pool: tank\r\n state: ONLINE\r\n  scan: scrub repaired 0B in 05:12:44 with 0 errors\r\nconfig:\r\n\r\n\tNAME        STATE     READ WRITE CKSUM\r\n\ttank        ONLINE       0     0     0\r\n\t  raidz1-0  ONLINE       0     0     0\r\n\t    sda     ONLINE       0     0     0\r\n\t    sdb     ONLINE       0     0     0\r\n\t    sdc     ONLINE       0     0     0\r\n\t    sdd     ONLINE       0     0     0\r\n\r\nerrors: No known data errors',
    'docker ps': 'CONTAINER ID   IMAGE                      STATUS        NAMES\r\n3f2a1b9c8d7e   jellyfin/jellyfin:latest   Up 4 days     jellyfin\r\n9a8b7c6d5e4f   ollama/ollama:latest       Up 12 days    ollama\r\n1b2c3d4e5f6a   vaultwarden/server         Up 12 days    vaultwarden',
  };
  function demoStart() {
    status(''); setState(t('Demo'), 'warn');
    if (!term) makeTerm();
    term.write('\x1b[2m' + t('Demo: a simulated shell. On your own server this is a real root shell.') + '\x1b[0m\r\n\r\n' + PROMPT);
    term.focus();
  }
  function demoInput(d) {
    for (const ch of d) {
      if (ch === '\r') {
        const cmd = line.trim(); line = '';
        term.write('\r\n');
        if (cmd === 'clear') { term.clear(); term.write(PROMPT); continue; }
        if (cmd) term.write((DEMO[cmd] || t('(demo) On your own server, bash runs "{cmd}" here.', { cmd })) + '\r\n');
        term.write(PROMPT);
      } else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); term.write('\b \b'); } }
      else if (ch === '\x03') { line = ''; term.write('^C\r\n' + PROMPT); }
      else if (ch >= ' ') { line += ch; term.write(ch); }
    }
  }

  /* ---- start */
  async function start() {
    if (demo) { demoStart(); return; }
    if (!cfg.terminal) { status(t('The terminal is turned off. Turn it on in Settings → Security.')); return; }
    if (cfg.terminalPassword) { status(t('Type your password to open the terminal. You get a root shell on the server.'), [], true); return; }
    open('');
  }
  (async function init() {
    try { cfg = await (await fetch('/api/config', { credentials: 'same-origin' })).json(); } catch (e) { cfg = null; }
    if (cfg && !cfg.demo && cfg.language) LANG = cfg.language;
    translateStatic();
    if (!cfg) { status(t('HomeBaseOS cannot be reached.'), [[t('Try again'), () => location.reload()]]); return; }
    if (cfg.needsLogin) { status(t('Sign in to HomeBaseOS first.'), [[t('Sign in'), () => { location.href = '/'; }, true]]); return; }
    demo = !!cfg.demo;
    if (!window.Terminal) { status(t('xterm.js could not be loaded.')); return; }
    start();
  })();
})();
