/* Console: the screen of a VM in the browser with noVNC. Opens in its own tab via console.html#<name of the VM>. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);

  /* ---- language and theme, like in app.js */
  const DICTS = window.TB_LANG || {};
  let LANG = 'en';
  try { LANG = localStorage.getItem('tb-lang') || 'en'; } catch (e) { /* private window */ }
  const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : String(s));
  function t(s, vars) { const d = DICTS[LANG]; return fill(d && d[s] != null ? d[s] : s, vars); }
  // Server messages are in English: find a template that fits.
  function tr(msg) {
    const m = String(msg || ''), d = DICTS[LANG];
    if (!d || d[m] != null) return d ? d[m] : m;
    for (const k of Object.keys(d).filter((x) => /\{\w+\}/.test(x))) {
      const names = [];
      const re = new RegExp('^' + k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([\\s\\S]+?)'; }) + '$');
      const hit = m.match(re);
      if (hit) return fill(d[k], Object.fromEntries(names.map((n, i) => [n, hit[i + 1]])));
    }
    return m;
  }
  function translateStatic() {
    document.documentElement.lang = LANG;
    document.querySelectorAll('[data-t]').forEach((el) => { el.dataset.key = el.dataset.key || el.textContent.trim(); el.textContent = t(el.dataset.key); });
    document.querySelectorAll('[data-t-ph]').forEach((el) => { el.dataset.key = el.dataset.key || el.placeholder; el.placeholder = t(el.dataset.key); });
    document.querySelectorAll('[data-t-label]').forEach((el) => { const k = el.dataset.key || el.getAttribute('aria-label'); el.dataset.key = k; el.setAttribute('aria-label', t(k)); el.title = t(k); });
    $('#screen').setAttribute('aria-label', t('VM screen'));
  }
  try { const th = localStorage.getItem('tb-theme'); if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th; } catch (e) { /* default */ }

  function toast(msg, bad) {
    const el = document.createElement('div'); el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = msg;
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), 4000);
  }

  /* ---- API: the real server or the demo adapter */
  async function call(method, path) {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || r.statusText); e.status = r.status; throw e; }
    return data;
  }
  let api = { get: (p) => call('GET', p), post: (p) => call('POST', p) };
  let demo = false;

  const name = decodeURIComponent(location.hash.slice(1));
  // In a HomeBaseOS window (iframe) or on its own (separate browser window)?
  const embedded = window.self !== window.top;
  const consoleUrl = () => location.pathname + location.hash;
  const vmPath = '/api/vms/' + encodeURIComponent(name);
  let vm = null, rfb = null, scale = true, connecting = false, retryAt = 0;

  function status(text, buttons = []) {
    $('#cStatus').hidden = !text;
    $('#cStatusText').textContent = text || '';
    const box = $('#cStatusBtns'); box.innerHTML = '';
    buttons.forEach(([label, fn, primary]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = label;
      b.addEventListener('click', fn); box.appendChild(b);
    });
  }
  const STATE = { RUNNING: ['Running', 'ok'], IDLE: ['Idle', 'ok'], PAUSED: ['Paused', 'warn'], SHUTDOWN: ['Shutting down', 'warn'], SHUTOFF: ['Off', ''],
    CRASHED: ['Crashed', 'bad'], PMSUSPENDED: ['Suspended', 'warn'] };
  function showState() {
    const [label, cls] = STATE[vm.state] || [vm.state, ''];
    $('#cState').textContent = t(label); $('#cState').className = 'pill ' + cls;
    $('#cName').textContent = vm.name;
    document.title = vm.name + ' · ' + t('Console');
  }
  const setTools = (on) => { $('#cKeys').disabled = !on; $('#cType').disabled = !on; };

  async function startVm() {
    try { await api.post(vmPath + '/start'); toast(t('{name} is starting…', { name })); setTimeout(refresh, 1500); }
    catch (e) { toast(t('Starting failed: {error}', { error: tr(e.message) }), true); }
  }

  async function refresh() {
    try { vm = await api.get(vmPath); }
    catch (e) { status(e.status === 404 ? t('This VM does not exist (anymore).') : tr(e.message), [[t('Try again'), refresh]]); return; }
    showState();
    if (vm.state === 'SHUTOFF') { disconnect(); status(t('The VM is off.'), [[t('Start'), startVm, true]]); return; }
    if (!vm.vnc) { status(t('This VM has no VNC screen.')); return; }
    if (!rfb && !connecting && Date.now() >= retryAt) connect();
  }

  async function connect() {
    if (demo) { demoScreen(); return; }
    connecting = true;
    status(t('Connecting to the screen…'));
    let RFB;
    try { ({ default: RFB } = await import('./vendor/novnc/core/rfb.js')); }
    catch (e) { connecting = false; status(t('noVNC could not be loaded: {error}', { error: e.message })); return; }
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + vmPath + '/vnc';
    rfb = new RFB($('#screen'), url, { credentials: { password: (vm.vnc && vm.vnc.password) || '' }, wsProtocols: ['binary'] });
    rfb.scaleViewport = scale;
    rfb.focusOnClick = true;
    rfb.background = getComputedStyle(document.documentElement).getPropertyValue('--screen-bg').trim();
    rfb.addEventListener('connect', () => { connecting = false; status(''); setTools(true); rfb.focus(); });
    rfb.addEventListener('clipboard', (e) => onVmClipboard(e.detail.text));
    rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: (vm.vnc && vm.vnc.password) || '' }));
    rfb.addEventListener('securityfailure', () => status(t('The screen password is wrong. Open the console again from HomeBaseOS.')));
    rfb.addEventListener('disconnect', () => {
      connecting = false; rfb = null; setTools(false);
      retryAt = Date.now() + 5000; // try again by itself, but not right away
      status(t('The connection to the screen was lost.'), [[t('Reconnect'), () => { retryAt = 0; refresh(); }, true]]);
      setTimeout(refresh, 1500); // maybe the VM was just turned off
    });
  }
  function disconnect() { if (rfb) { const r = rfb; rfb = null; try { r.disconnect(); } catch (e) { /* already gone */ } } setTools(false); }

  /* ---- buttons */
  $('#cKeys').addEventListener('click', () => { if (rfb) { rfb.sendCtrlAltDel(); rfb.focus(); } else if (demo) toast(t('Ctrl+Alt+Del sent.')); });
  $('#cScale').addEventListener('click', () => {
    scale = !scale; $('#cScale').setAttribute('aria-pressed', String(scale));
    $('#cScale').textContent = t(scale ? 'Fit to window' : 'Actual size');
    if (rfb) rfb.scaleViewport = scale;
  });
  $('#cFull').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => toast(t('Full screen does not work in this browser.'), true));
  });
  $('#cType').addEventListener('click', () => {
    const bar = $('#cTypeBar'); bar.hidden = !bar.hidden; $('#cType').setAttribute('aria-expanded', String(!bar.hidden));
    if (!bar.hidden) $('#cText').focus();
  });
  // Send text letter by letter as keys (handy for passwords; pasting doesn't work in a VM without an agent).
  $('#cTypeBar').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#cText').value + ($('#cEnter').checked ? '\n' : '');
    if (!text) return;
    if (rfb) {
      for (const ch of text) {
        const code = ch.codePointAt(0);
        rfb.sendKey(ch === '\n' ? 0xff0d : code < 256 ? code : 0x01000000 + code, null);
      }
      rfb.focus();
    } else if (demo) demoType(text);
    $('#cText').value = '';
    $('#cTypeBar').hidden = true; $('#cType').setAttribute('aria-expanded', 'false');
  });

  /* ---- separate window: take the console out of HomeBaseOS */
  if (embedded) {
    $('#cPop').hidden = false; $('#cClose').hidden = false;
    document.querySelector('.console-bar .back').hidden = true;
  }
  $('#cPop').addEventListener('click', () => {
    const w = window.open(consoleUrl(), 'tb-console-' + name.replace(/[^\w-]/g, ''), 'popup=yes,width=1180,height=800');
    if (!w) { toast(t('Your browser blocked the new window. Allow pop-ups for HomeBaseOS.'), true); return; }
    disconnect();
    if (window.parent && window.parent.TB_closeConsole) window.parent.TB_closeConsole();
  });
  $('#cClose').addEventListener('click', () => { disconnect(); if (window.parent && window.parent.TB_closeConsole) window.parent.TB_closeConsole(); });

  /* ---- paste: Cmd/Ctrl+V doesn't go to the VM as a key; the text from your clipboard is typed in the VM */
  const isField = (el) => el && (el.tagName === 'INPUT' || (el.tagName === 'TEXTAREA' && el.id !== 'cPasteSink'));
  let backFocus = null;
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'v' || isField(e.target) || !(rfb || demo)) return;
    e.stopImmediatePropagation(); // noVNC doesn't get this key
    // The browser pastes into the focused element: briefly an invisible text box, so the paste event arrives everywhere (also in Safari).
    backFocus = document.activeElement;
    const sink = $('#cPasteSink'); sink.value = ''; sink.focus();
  }, true);
  document.addEventListener('paste', (e) => {
    if (isField(e.target)) return;
    e.preventDefault();
    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    if (backFocus && backFocus.focus) backFocus.focus(); else if (rfb) rfb.focus();
    backFocus = null;
    if (text) pasteText(text);
  });
  // Letter by letter as keys (works everywhere, also without an agent in the VM). Long text in chunks, so nothing gets lost.
  async function pasteText(raw) {
    const text = raw.replace(/\r\n?/g, '\n').slice(0, 20000);
    if (raw.length > 20000) toast(t('Only the first 20,000 characters are pasted.'), true);
    if (demo) { demoType(text); toast(t('Pasted: {n} characters.', { n: text.length })); return; }
    if (!rfb) return;
    try { rfb.clipboardPasteFrom(text); } catch (e) { /* old server without clipboard */ }
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      if (!rfb) return;
      const ch = chars[i], code = ch.codePointAt(0);
      rfb.sendKey(ch === '\n' ? 0xff0d : ch === '\t' ? 0xff09 : code < 256 ? code : 0x01000000 + code, null);
      if (i % 40 === 39) await new Promise((r) => setTimeout(r, 15));
    }
    toast(t('Pasted: {n} characters.', { n: chars.length }));
  }

  /* ---- copy: what the VM puts on its clipboard (with spice-vdagent), put on this PC */
  let vmClip = '';
  function copyToPc(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    // Without https: the old way, which works on a click.
    const ta = document.createElement('textarea'); ta.value = text; ta.className = 'paste-sink'; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('copy'));
  }
  function onVmClipboard(text) {
    vmClip = text;
    if (!text) return;
    const show = () => {
      $('#cClipText').textContent = t('The VM copied: "{text}"', { text: text.length > 60 ? text.slice(0, 60) + '…' : text });
      $('#cClip').hidden = false;
    };
    if (navigator.clipboard && window.isSecureContext && document.hasFocus()) {
      navigator.clipboard.writeText(text).then(() => toast(t('Copied from the VM: it is now also on this PC\'s clipboard.')), show);
    } else show();
  }
  $('#cClipCopy').addEventListener('click', () => {
    copyToPc(vmClip).then(() => { $('#cClip').hidden = true; toast(t('Copied to this PC\'s clipboard.')); if (rfb) rfb.focus(); },
      () => toast(t('Copying did not work in this browser.'), true));
  });
  $('#cClipHide').addEventListener('click', () => { $('#cClip').hidden = true; if (rfb) rfb.focus(); });

  /* ---- demo: a simulated screen you can type in */
  let demoLines = null, demoCanvas = null;
  function demoScreen() {
    status(''); setTools(true);
    if (demoCanvas) return;
    demoCanvas = document.createElement('canvas'); demoCanvas.width = 1024; demoCanvas.height = 640; demoCanvas.tabIndex = 0;
    demoCanvas.setAttribute('aria-label', t('Simulated screen (demo)'));
    $('#screen').appendChild(demoCanvas);
    const ha = /home assistant/i.test(vm.name);
    demoLines = ha
      ? ['', '  _   _                          _            _     _              _', ' | | | | ___  _ __ ___   ___    / \\   ___ ___(_)___| |_ __ _ _ __ | |_',
        ' | |_| |/ _ \\| \'_ ` _ \\ / _ \\  / _ \\ / __/ __| / __| __/ _` | \'_ \\| __|', ' |  _  | (_) | | | | | |  __/ / ___ \\\\__ \\__ \\ \\__ \\ || (_| | | | | |_',
        ' |_| |_|\\___/|_| |_| |_|\\___|/_/   \\_\\___/___/_|___/\\__\\__,_|_| |_|\\__|', '',
        ' Welcome to the Home Assistant command line.', ' System information:', '   IPv4 addresses for enp0s2:  192.168.1.40/24', '   OS Version:     Home Assistant OS 16.2',
        '   Home Assistant Core: 2026.10.1', '', ' Home Assistant URL:     http://homeassistant.local:8123', ' Observer URL:           http://homeassistant.local:4357', '', 'ha > ']
      : ['', ' Debian GNU/Linux 13 ' + vm.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + ' tty1', '', vm.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + ' login: '];
    demoCanvas.addEventListener('keydown', (e) => {
      if (e.key.length === 1) demoType(e.key); else if (e.key === 'Enter') demoType('\n');
      else if (e.key === 'Backspace') { const l = demoLines.length - 1; if (!/(> |: )$/.test(demoLines[l])) demoLines[l] = demoLines[l].slice(0, -1); demoDraw(); }
      e.preventDefault();
    });
    demoCanvas.addEventListener('click', () => demoCanvas.focus());
    demoDraw(); demoCanvas.focus();
    setInterval(demoDraw, 530); // blinking cursor
  }
  function demoType(text) {
    for (const ch of text) {
      if (ch !== '\n') { demoLines[demoLines.length - 1] += ch; continue; }
      const cmd = demoLines[demoLines.length - 1].replace(/^.*?(> |: )/, '').trim();
      if (cmd) demoLines.push(t('(demo) On your own server, the VM runs "{cmd}" here.', { cmd }));
      if (cmd) onVmClipboard(cmd); // in the demo the VM pretends it copied the command
      demoLines.push(/login: /.test(demoLines[demoLines.length - 2] || '') ? 'Password: ' : (demoLines.find((l) => /^ha > /.test(l)) ? 'ha > ' : '$ '));
    }
    demoLines = demoLines.slice(-30); demoDraw();
  }
  function demoDraw() {
    const g = demoCanvas.getContext('2d'), css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--screen-bg').trim(); g.fillRect(0, 0, demoCanvas.width, demoCanvas.height);
    g.font = '15px ui-monospace, Menlo, monospace'; g.fillStyle = css.getPropertyValue('--screen-ink').trim();
    const lines = demoLines.slice(-33);
    lines.forEach((l, i) => g.fillText(l, 12, 22 + i * 18.5));
    if (Math.floor(Date.now() / 530) % 2) { const w = g.measureText(lines[lines.length - 1]).width; g.fillRect(12 + w, 22 + (lines.length - 1) * 18.5 - 13, 9, 16); }
  }

  /* ---- start */
  (async function init() {
    if (!name) { status(t('No VM chosen. Open the console from the VM page in HomeBaseOS.')); translateStatic(); return; }
    let cfg = null;
    try { cfg = await call('GET', '/api/config'); } catch (e) { /* below */ }
    if (cfg && !cfg.demo && cfg.language) LANG = cfg.language;
    translateStatic();
    if (!cfg) { status(t('HomeBaseOS cannot be reached.'), [[t('Try again'), () => location.reload()]]); return; }
    if (cfg.needsLogin) { status(t('Sign in to HomeBaseOS first.'), [[t('Sign in'), () => { location.href = '/'; }, true]]); return; }
    if (cfg.demo && window.HomeBaseOSDemo) { demo = true; api = window.HomeBaseOSDemo; }
    await refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  })();
})();
