/* Console: het scherm van een VM in de browser met noVNC. Opent in een eigen tabblad via console.html#<naam van de VM>. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);

  /* ---- taal en thema, zoals in app.js */
  const DICTS = { en: window.TB_LANG_EN || {} };
  let LANG = 'nl';
  try { LANG = localStorage.getItem('tb-lang') || 'nl'; } catch (e) { /* privévenster */ }
  const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : String(s));
  function t(s, vars) { const d = DICTS[LANG]; return fill(d && d[s] != null ? d[s] : s, vars); }
  // Meldingen van de server zijn Nederlands: zoek een sjabloon dat past.
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
    $('#screen').setAttribute('aria-label', t('Scherm van de VM'));
  }
  try { const th = localStorage.getItem('tb-theme'); if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th; } catch (e) { /* standaard */ }

  function toast(msg, bad) {
    const el = document.createElement('div'); el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = msg;
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), 4000);
  }

  /* ---- API: de echte server of de demo-adapter */
  async function call(method, path) {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || r.statusText); e.status = r.status; throw e; }
    return data;
  }
  let api = { get: (p) => call('GET', p), post: (p) => call('POST', p) };
  let demo = false;

  const name = decodeURIComponent(location.hash.slice(1));
  // In een venster van HomeBaseOS (iframe) of los (eigen browservenster)?
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
  const STATE = { RUNNING: ['Draait', 'ok'], IDLE: ['Inactief', 'ok'], PAUSED: ['Gepauzeerd', 'warn'], SHUTDOWN: ['Sluit af', 'warn'], SHUTOFF: ['Uit', ''],
    CRASHED: ['Gecrasht', 'bad'], PMSUSPENDED: ['Slaapstand', 'warn'] };
  function showState() {
    const [label, cls] = STATE[vm.state] || [vm.state, ''];
    $('#cState').textContent = t(label); $('#cState').className = 'pill ' + cls;
    $('#cName').textContent = vm.name;
    document.title = vm.name + ' · ' + t('Console');
  }
  const setTools = (on) => { $('#cKeys').disabled = !on; $('#cType').disabled = !on; };

  async function startVm() {
    try { await api.post(vmPath + '/start'); toast(t('{name} start…', { name })); setTimeout(refresh, 1500); }
    catch (e) { toast(t('Starten lukte niet: {error}', { error: tr(e.message) }), true); }
  }

  async function refresh() {
    try { vm = await api.get(vmPath); }
    catch (e) { status(e.status === 404 ? t('Deze VM bestaat niet (meer).') : tr(e.message), [[t('Opnieuw proberen'), refresh]]); return; }
    showState();
    if (vm.state === 'SHUTOFF') { disconnect(); status(t('De VM staat uit.'), [[t('Starten'), startVm, true]]); return; }
    if (!vm.vnc) { status(t('Deze VM heeft geen VNC-scherm.')); return; }
    if (!rfb && !connecting && Date.now() >= retryAt) connect();
  }

  async function connect() {
    if (demo) { demoScreen(); return; }
    connecting = true;
    status(t('Verbinden met het scherm…'));
    let RFB;
    try { ({ default: RFB } = await import('./vendor/novnc/core/rfb.js')); }
    catch (e) { connecting = false; status(t('noVNC kon niet geladen worden: {error}', { error: e.message })); return; }
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + vmPath + '/vnc';
    rfb = new RFB($('#screen'), url, { credentials: { password: (vm.vnc && vm.vnc.password) || '' }, wsProtocols: ['binary'] });
    rfb.scaleViewport = scale;
    rfb.focusOnClick = true;
    rfb.background = getComputedStyle(document.documentElement).getPropertyValue('--screen-bg').trim();
    rfb.addEventListener('connect', () => { connecting = false; status(''); setTools(true); rfb.focus(); });
    rfb.addEventListener('clipboard', (e) => onVmClipboard(e.detail.text));
    rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: (vm.vnc && vm.vnc.password) || '' }));
    rfb.addEventListener('securityfailure', () => status(t('Het wachtwoord van het scherm klopt niet. Open de console opnieuw vanuit HomeBaseOS.')));
    rfb.addEventListener('disconnect', () => {
      connecting = false; rfb = null; setTools(false);
      retryAt = Date.now() + 5000; // vanzelf opnieuw proberen, maar niet meteen
      status(t('De verbinding met het scherm is verbroken.'), [[t('Opnieuw verbinden'), () => { retryAt = 0; refresh(); }, true]]);
      setTimeout(refresh, 1500); // misschien is de VM net uitgeschakeld
    });
  }
  function disconnect() { if (rfb) { const r = rfb; rfb = null; try { r.disconnect(); } catch (e) { /* al weg */ } } setTools(false); }

  /* ---- knoppen */
  $('#cKeys').addEventListener('click', () => { if (rfb) { rfb.sendCtrlAltDel(); rfb.focus(); } else if (demo) toast(t('Ctrl+Alt+Del verstuurd.')); });
  $('#cScale').addEventListener('click', () => {
    scale = !scale; $('#cScale').setAttribute('aria-pressed', String(scale));
    $('#cScale').textContent = t(scale ? 'Passend maken' : 'Ware grootte');
    if (rfb) rfb.scaleViewport = scale;
  });
  $('#cFull').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => toast(t('Volledig scherm lukt niet in deze browser.'), true));
  });
  $('#cType').addEventListener('click', () => {
    const bar = $('#cTypeBar'); bar.hidden = !bar.hidden; $('#cType').setAttribute('aria-expanded', String(!bar.hidden));
    if (!bar.hidden) $('#cText').focus();
  });
  // Tekst letter per letter als toetsen doorsturen (handig voor wachtwoorden, plakken werkt niet in een VM zonder agent).
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

  /* ---- los venster: de console uit HomeBaseOS halen */
  if (embedded) {
    $('#cPop').hidden = false; $('#cClose').hidden = false;
    document.querySelector('.console-bar .back').hidden = true;
  }
  $('#cPop').addEventListener('click', () => {
    const w = window.open(consoleUrl(), 'tb-console-' + name.replace(/[^\w-]/g, ''), 'popup=yes,width=1180,height=800');
    if (!w) { toast(t('Je browser blokkeerde het nieuwe venster. Sta pop-ups toe voor HomeBaseOS.'), true); return; }
    disconnect();
    if (window.parent && window.parent.TB_closeConsole) window.parent.TB_closeConsole();
  });
  $('#cClose').addEventListener('click', () => { disconnect(); if (window.parent && window.parent.TB_closeConsole) window.parent.TB_closeConsole(); });

  /* ---- plakken: Cmd/Ctrl+V gaat niet als toets naar de VM; de tekst van je klembord wordt in de VM getypt */
  const isField = (el) => el && (el.tagName === 'INPUT' || (el.tagName === 'TEXTAREA' && el.id !== 'cPasteSink'));
  let backFocus = null;
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'v' || isField(e.target) || !(rfb || demo)) return;
    e.stopImmediatePropagation(); // noVNC krijgt deze toets niet
    // De browser plakt in het gefocuste element: even een onzichtbaar tekstvak, zodat het paste-event overal komt (ook in Safari).
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
  // Letter per letter als toetsen (werkt overal, ook zonder agent in de VM). Lange tekst in stukjes, zodat er niets verloren gaat.
  async function pasteText(raw) {
    const text = raw.replace(/\r\n?/g, '\n').slice(0, 20000);
    if (raw.length > 20000) toast(t('Alleen de eerste 20.000 tekens worden geplakt.'), true);
    if (demo) { demoType(text); toast(t('Geplakt: {n} tekens.', { n: text.length })); return; }
    if (!rfb) return;
    try { rfb.clipboardPasteFrom(text); } catch (e) { /* oude server zonder klembord */ }
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      if (!rfb) return;
      const ch = chars[i], code = ch.codePointAt(0);
      rfb.sendKey(ch === '\n' ? 0xff0d : ch === '\t' ? 0xff09 : code < 256 ? code : 0x01000000 + code, null);
      if (i % 40 === 39) await new Promise((r) => setTimeout(r, 15));
    }
    toast(t('Geplakt: {n} tekens.', { n: chars.length }));
  }

  /* ---- kopiëren: wat de VM op haar klembord zet (met spice-vdagent), op deze pc zetten */
  let vmClip = '';
  function copyToPc(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    // Zonder https: de oude manier, die werkt bij een klik.
    const ta = document.createElement('textarea'); ta.value = text; ta.className = 'paste-sink'; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('copy'));
  }
  function onVmClipboard(text) {
    vmClip = text;
    if (!text) return;
    const show = () => {
      $('#cClipText').textContent = t('De VM kopieerde: "{text}"', { text: text.length > 60 ? text.slice(0, 60) + '…' : text });
      $('#cClip').hidden = false;
    };
    if (navigator.clipboard && window.isSecureContext && document.hasFocus()) {
      navigator.clipboard.writeText(text).then(() => toast(t('Gekopieerd uit de VM: staat nu ook op het klembord van deze pc.')), show);
    } else show();
  }
  $('#cClipCopy').addEventListener('click', () => {
    copyToPc(vmClip).then(() => { $('#cClip').hidden = true; toast(t('Gekopieerd naar het klembord van deze pc.')); if (rfb) rfb.focus(); },
      () => toast(t('Kopiëren lukte niet in deze browser.'), true));
  });
  $('#cClipHide').addEventListener('click', () => { $('#cClip').hidden = true; if (rfb) rfb.focus(); });

  /* ---- demo: een nagebootst scherm waarin je kan typen */
  let demoLines = null, demoCanvas = null;
  function demoScreen() {
    status(''); setTools(true);
    if (demoCanvas) return;
    demoCanvas = document.createElement('canvas'); demoCanvas.width = 1024; demoCanvas.height = 640; demoCanvas.tabIndex = 0;
    demoCanvas.setAttribute('aria-label', t('Nagebootst scherm (demo)'));
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
    setInterval(demoDraw, 530); // knipperende cursor
  }
  function demoType(text) {
    for (const ch of text) {
      if (ch !== '\n') { demoLines[demoLines.length - 1] += ch; continue; }
      const cmd = demoLines[demoLines.length - 1].replace(/^.*?(> |: )/, '').trim();
      if (cmd) demoLines.push(t('(demo) Op je eigen server voert de VM hier "{cmd}" uit.', { cmd }));
      if (cmd) onVmClipboard(cmd); // in de demo doet de VM alsof ze het commando kopieerde
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

  /* ---- starten */
  (async function init() {
    if (!name) { status(t('Geen VM gekozen. Open de console vanuit de VM-pagina van HomeBaseOS.')); translateStatic(); return; }
    let cfg = null;
    try { cfg = await call('GET', '/api/config'); } catch (e) { /* hieronder */ }
    if (cfg && !cfg.demo && cfg.language) LANG = cfg.language;
    translateStatic();
    if (!cfg) { status(t('HomeBaseOS is niet bereikbaar.'), [[t('Opnieuw proberen'), () => location.reload()]]); return; }
    if (cfg.needsLogin) { status(t('Meld je eerst aan in HomeBaseOS.'), [[t('Aanmelden'), () => { location.href = '/'; }, true]]); return; }
    if (cfg.demo && window.HomeBaseOSDemo) { demo = true; api = window.HomeBaseOSDemo; }
    await refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  })();
})();
