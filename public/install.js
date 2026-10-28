/* MajaOS installer. The same page runs in the demo and from the USB stick. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  // The USB stick draws this page with software rendering: no blur there (iso/kiosk.sh).
  if (/[?&]kiosk=1\b/.test(location.search)) document.documentElement.classList.add('kiosk');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LANGS = window.TB_LANGS || { en: { name: 'English', locale: 'en-GB' } };
  const DICTS = window.TB_LANG || {};
  let LANG = 'en';
  const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : String(s));
  function t(s, vars) {
    const d = DICTS[LANG];
    return fill(d && d[s] != null ? d[s] : s, vars);
  }
  const langLoads = {};
  async function setLang(code) {
    LANG = LANGS[code] ? code : 'en';
    document.documentElement.lang = LANG;
    try { localStorage.setItem('tb-lang', LANG); } catch (e) { /* private window */ }
    if (LANG === 'en' || DICTS[LANG]) return;
    if (!langLoads[LANG]) {
      langLoads[LANG] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'lang/' + LANG + '.js';
        s.onload = () => { delete langLoads[LANG]; resolve(); };
        s.onerror = () => { delete langLoads[LANG]; reject(new Error('Could not load the language.')); };
        document.head.appendChild(s);
      });
    }
    await langLoads[LANG];
  }

  const MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 15.5 16 6l11 9.5V27H19.5v-7.5h-7V27H5z"/></svg>';
  const HDD = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M3 12h18"/><circle cx="7.5" cy="15.2" r="1"/><circle cx="11" cy="15.2" r="1"/></svg>';
  // A network socket (RJ45) seen from the front: the body with the latch below and four contacts.
  const NET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v10h-4v3H8v-3H4z"/><path d="M8.5 8v3M11 8v3M13 8v3M15.5 8v3"/></svg>';
  const state = { step: 'lang', disks: [], disk: null, nvidia: false, error: '', job: null, timer: null, unavailable: false,
    net: null, netForms: {}, netSeen: {}, netSel: null, netBusy: false, netPicked: false, netTimer: null };
  let api = null;

  function bytes(n) {
    if (n == null || Number.isNaN(Number(n))) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = Number(n);
    const loc = (LANGS[LANG] && LANGS[LANG].locale) || 'en-GB';
    while (v >= 1000 && i < u.length - 1) { v /= 1024; i++; }
    const num = new Intl.NumberFormat(loc, { maximumFractionDigits: v >= 100 ? 0 : 1 }).format(v);
    return num + ' ' + u[i];
  }
  function kind(d) {
    if (d.tran === 'usb') return t('USB stick');
    return d.rotational ? t('Hard drive') : t('SSD');
  }
  function brand() {
    return `<div class="inst-brand">${MARK}<span>MajaOS</span></div>`;
  }
  function actions(html) { return `<div class="inst-actions">${html}</div>`; }
  function btn(label, attrs, primary) {
    return `<button type="button" class="btn${primary ? ' primary' : ''}" ${attrs}>${esc(label)}</button>`;
  }

  function draw() {
    const root = $('#inst');
    if (state.unavailable) {
      root.innerHTML = `<section class="inst-card">${brand()}<h1>${esc(t('Install MajaOS'))}</h1><p class="lead">${esc(t('This page is the installer. Start the computer from the MajaOS USB stick to use it.'))}</p></section>`;
      return;
    }
    if (state.step === 'lang') {
      const items = Object.entries(LANGS).map(([code, info]) =>
        `<button type="button" data-lang="${esc(code)}" aria-pressed="${code === LANG ? 'true' : 'false'}">${esc(info.name)}</button>`).join('');
      root.innerHTML = `<section class="inst-card">${brand()}<h1>${esc(t('Choose your language'))}</h1><div class="lang-grid">${items}</div>
        ${actions(btn(t('Continue'), 'data-go="welcome"', true))}</section>`;
      return;
    }
    if (state.step === 'welcome') {
      root.innerHTML = `<section class="inst-card">${brand()}<h1>${esc(t('Welcome to MajaOS'))}</h1>
        <p class="lead">${esc(t('This installs MajaOS on this computer. You create your account in the browser afterwards.'))}</p>
        ${actions(btn(t('Back'), 'data-go="lang"') + btn(t('Continue'), 'data-go="network"', true))}</section>`;
      return;
    }
    if (state.step === 'network') {
      const n = state.net, f = form();
      const head = `<section class="inst-card">${brand()}<h1>${esc(t('Network'))}</h1>
        <p class="lead">${esc(t('MajaOS needs the internet to install. Choose a network card and how it gets its address.'))}</p>`;
      if (!n || (n.cards.length && !f)) {
        root.innerHTML = head + `<p class="lead">${esc(state.error || t('Looking for network cards…'))}</p>
          ${actions(btn(t('Back'), 'data-go="welcome"'))}</section>`;
        return;
      }
      const summary = (c) => {
        const cf = state.netForms[c.name];
        return cf.mode === 'off' ? t('Not used') : cf.mode === 'static' ? t('Fixed address') : t('DHCP');
      };
      const cards = n.cards.length ? n.cards.map((c) => `<button type="button" class="disk net-card${c.connected ? ' up' : ''}" data-card="${esc(c.name)}" aria-pressed="${state.netSel === c.name ? 'true' : 'false'}">
          <span class="disk-ico">${NET}</span><span class="net-text"><b>${esc(c.name)}</b><span data-card-info>${cardInfo(c)}</span></span>
          <span class="net-mode">${esc(summary(c))}</span></button>`).join('') : `<p class="lead">${esc(t('No network card found.'))}</p>`;
      const mode = (k, label) => `<button type="button" role="radio" data-mode="${k}" aria-checked="${f.mode === k ? 'true' : 'false'}">${esc(label)}</button>`;
      const shown = shownErrors(state.netSel);
      const field = (name, label, hint) => `<label class="inst-field"><span>${esc(label)}</span>
        <input class="field" name="${name}" value="${esc(f[name])}" placeholder="${esc(hint)}" autocomplete="off" spellcheck="false" inputmode="decimal"${shown[name] ? ' aria-invalid="true"' : ''}>
        <span class="inst-field-err" data-err="${name}">${esc(shown[name] ? t(shown[name]) : '')}</span></label>`;
      const fixed = f && f.mode === 'static' ? `<div class="inst-fields">
          ${field('address', t('IP address'), t('For example 192.168.1.10/24'))}
          ${field('gateway', t('Gateway'), t('Usually your router, for example 192.168.1.1'))}
          ${field('dns', t('DNS servers'), t('For example 1.1.1.1 9.9.9.9'))}
          <p class="inst-hint">${esc(t('Leave the gateway empty on a card without internet, for example a direct cable to another computer.'))}</p></div>` : '';
      const status = state.netBusy ? t('Connecting…') : n.online ? t('Connected to the internet.') : t('No internet connection yet.');
      root.innerHTML = head + cards + (n.cards.length ? `
        <h2 class="inst-sub">${esc(t('Settings for {name}', { name: state.netSel }))}</h2>
        <div class="seg inst-seg" role="radiogroup" aria-label="${esc(t('Address'))}">${mode('dhcp', t('Automatic (DHCP)'))}${mode('static', t('Fixed address'))}${mode('off', t('Not used'))}</div>
        ${fixed}<p class="inst-net ${n.online && !state.netBusy ? 'ok' : ''}" role="status">${esc(status)}</p>` : '') + `
        <p class="inst-error" role="alert">${esc(state.error)}</p>
        ${actions(btn(t('Back'), 'data-go="welcome"') + btn(t('Continue'), 'data-go="disk"' + (state.netBusy || !n.cards.length ? ' disabled' : ''), true))}</section>`;
      return;
    }
    if (state.step === 'disk') {
      const cards = state.disks.length ? state.disks.map((d) => {
        const label = d.model || d.name;
        const extra = d.install ? t('The installer is running from this disk.') : kind(d);
        return `<button type="button" class="disk" data-disk="${esc(d.name)}" ${d.install ? 'disabled' : ''} aria-pressed="${state.disk === d.name ? 'true' : 'false'}">
          <span class="disk-ico">${HDD}</span><span><b>${esc(label)}</b><span>${esc(d.name)} · ${esc(bytes(d.size))} · ${esc(extra)}</span></span></button>`;
      }).join('') : `<p class="lead">${esc(t('No disk to install on.'))}</p>`;
      root.innerHTML = `<section class="inst-card">${brand()}<h1>${esc(t('Choose the disk'))}</h1>
        <p class="lead">${esc(t('MajaOS will be installed on this disk. Everything on it will be erased.'))}</p>
        ${cards}<p class="inst-error" role="alert">${esc(state.error)}</p>
        ${actions(btn(t('Back'), 'data-go="network"') + btn(t('Continue'), 'data-go="confirm"' + (state.disk ? '' : ' disabled'), true))}</section>`;
      return;
    }
    if (state.step === 'confirm') {
      const d = state.disks.find((x) => x.name === state.disk);
      root.innerHTML = `<section class="inst-card">${brand()}<h1>${esc(t('This erases {name}.', { name: state.disk || '' }))}</h1>
        <p class="lead">${esc(d && d.model ? d.model + ' · ' + bytes(d.size) : '')}</p>
        <label class="inst-check"><input type="checkbox" id="nvidia" ${state.nvidia ? 'checked' : ''}><span><b style="color:var(--text)">${esc(t('Install the NVIDIA driver'))}</b><br>${esc(t('For a computer with an NVIDIA graphics card.'))}</span></label>
        <p class="inst-error" role="alert">${esc(state.error)}</p>
        ${actions(btn(t('Back'), 'data-go="disk"') + btn(t('Erase and install'), 'data-go="install"', true))}</section>`;
      return;
    }
    if (state.step === 'progress' || state.step === 'done') {
      const job = state.job || { percent: 0, message: t('Preparing the installation'), state: 'running', log: '' };
      const failed = job.state === 'failed';
      const title = failed ? t('The installation failed. You can try again.') : (state.step === 'done' ? t('Installing MajaOS') : t('Installing MajaOS'));
      root.innerHTML = `<section class="inst-card" ${state.step === 'progress' && !failed ? 'data-step="progress"' : ''}>${brand()}<h1>${esc(title)}</h1>
        <p class="lead" data-msg>${esc(t(job.message || ''))}</p>
        <div class="bar" role="progressbar" aria-valuenow="${job.percent || 0}" aria-valuemin="0" aria-valuemax="100"><span style="width:${job.percent || 0}%"></span></div>
        ${state.step === 'done' ? `<p class="lead">${esc(t('Remove the USB stick when the computer restarts.'))}</p>` : ''}
        ${job.log ? `<details><summary>${esc(t('Details'))}</summary><pre>${esc(job.log)}</pre></details>` : ''}
        <p class="inst-error" role="alert">${esc(failed ? '' : state.error)}</p>
        ${failed ? actions(btn(t('Try again'), 'data-go="disk"', true)) : (state.step === 'done' ? actions(btn(t('Restart'), 'data-go="reboot"', true)) : '')}</section>`;
    }
  }

  // Later polls only change the text and the bar. Rebuilding the card closed Details on every tick.
  function paintProgress() {
    const card = $('#inst [data-step="progress"]');
    const job = state.job;
    if (!card || !job || state.step !== 'progress' || job.state === 'failed') return false;
    const lead = card.querySelector('[data-msg]');
    const text = t(job.message || '');
    if (lead && lead.textContent !== text) lead.textContent = text;
    const span = card.querySelector('.bar span');
    const bar = card.querySelector('.bar');
    if (span) span.style.width = (job.percent || 0) + '%';
    if (bar) bar.setAttribute('aria-valuenow', String(job.percent || 0));
    if (job.log) {
      let pre = card.querySelector('pre');
      if (!pre) {
        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = t('Details');
        pre = document.createElement('pre');
        det.append(sum, pre);
        const err = card.querySelector('.inst-error');
        if (err) err.before(det); else card.append(det);
      }
      if (pre.textContent !== job.log) pre.textContent = job.log;
    }
    return true;
  }

  async function loadDisks() {
    state.error = '';
    try { state.disks = await api.get('/api/install/disks'); }
    catch (e) { state.disks = []; state.error = e.message; }
    if (!state.disks.some((d) => d.name === state.disk && !d.install)) state.disk = null;
  }
  function speedText(mbit) {
    if (!mbit) return '';
    const num = new Intl.NumberFormat((LANGS[LANG] && LANGS[LANG].locale) || 'en-GB', { maximumFractionDigits: 1 });
    return mbit >= 1000 ? t('{n} Gbit/s', { n: num.format(mbit / 1000) }) : t('{n} Mbit/s', { n: num.format(mbit) });
  }
  // One form per card. It starts from what was chosen before, otherwise DHCP. The card with the internet is selected first.
  function form() { return state.netForms[state.netSel] || null; }
  function syncForms() {
    const n = state.net, chosen = n.chosen || [];
    for (const c of n.cards) {
      if (state.netForms[c.name]) continue;
      const cf = chosen.find((x) => x.interface === c.name);
      state.netForms[c.name] = cf ? { mode: cf.mode, address: cf.address || '', gateway: cf.gateway || '', dns: (cf.dns || []).join(' ') }
        : { mode: 'dhcp', address: '', gateway: '', dns: '' };
    }
    if (!n.cards.some((c) => c.name === state.netSel)) state.netSel = bestCard();
  }
  // The line under a card's name: cable, MAC, address and speed. With a fixed address it shows the address being
  // typed (red while it isn't valid); with DHCP the address the card has now.
  function cardInfo(c) {
    const f = state.netForms[c.name] || { mode: 'dhcp' };
    const link = `<span class="net-link">${esc(c.connected ? t('Connected') : t('No cable'))}</span>`;
    let addr = '';
    if (f.mode === 'static' && f.address.trim()) addr = `<span class="net-addr${netErrors(f).address ? ' bad' : ''}">${esc(f.address.trim())}</span>`;
    else if (f.mode === 'dhcp' && c.address) addr = esc(c.address);
    return [link, esc(c.mac), addr, esc(speedText(c.speed))].filter(Boolean).join(' · ');
  }
  // The same checks as installer.validateCards on the server, so a mistake shows while typing.
  const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  function sameNet(a, b, prefix) {
    const n = (ip) => ip.split('.').reduce((x, o) => (x << 8) + Number(o), 0) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (n(a) & mask) === (n(b) & mask);
  }
  function netErrors(f) {
    const e = {};
    if (!f || f.mode !== 'static') return e;
    const parts = String(f.address || '').trim().split('/');
    const prefix = Number(parts[1]);
    const okAddr = parts.length === 2 && IPV4.test(parts[0]) && /^\d{1,2}$/.test(parts[1]) && prefix >= 8 && prefix <= 32;
    if (!okAddr) e.address = 'Fill in the IP address with the netmask length, e.g. 192.168.1.10/24.';
    const gw = String(f.gateway || '').trim();
    if (gw && !IPV4.test(gw)) e.gateway = 'Fill in the gateway, usually your router\'s address (e.g. 192.168.1.1).';
    else if (gw && okAddr && !sameNet(parts[0], gw, prefix)) e.gateway = 'The gateway is not in the same network as the IP address.';
    const dns = String(f.dns || '').trim().split(/[\s,]+/).filter(Boolean);
    if (dns.some((d) => !IPV4.test(d) && !/^[0-9a-f:]+$/i.test(d))) e.dns = 'Fill in valid DNS addresses, separated by spaces.';
    else if (gw && !dns.length) e.dns = 'Fill in at least one DNS server, e.g. your router or 1.1.1.1.';
    return e;
  }
  // Messages show for a field once you leave it, or for all fields after Continue; never halfway through typing.
  function shownErrors(name) {
    const e = netErrors(state.netForms[name]), seen = state.netSeen[name] || {}, out = {};
    for (const k of Object.keys(e)) if (seen.all || seen[k]) out[k] = e[k];
    return out;
  }
  // While typing: only the card line and a message that is already there change, the field keeps its focus.
  function paintNet() {
    const c = cardOf(state.netSel), info = c && $(`#inst [data-card="${c.name}"] [data-card-info]`);
    if (info) info.innerHTML = cardInfo(c);
    const shown = shownErrors(state.netSel);
    for (const el of document.querySelectorAll('#inst [data-err]')) {
      const k = el.dataset.err, input = $(`#inst input[name="${k}"]`);
      el.textContent = shown[k] ? t(shown[k]) : '';
      if (input) { if (shown[k]) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
    }
  }

  // The card to show first: the one with the internet, else one with a cable, else the first.
  function bestCard() {
    const list = state.net ? state.net.cards : [];
    const c = list.find((x) => x.gateway) || list.find((x) => x.connected) || list[0];
    return c ? c.name : null;
  }
  async function loadNetwork() {
    state.error = '';
    try { state.net = await api.get('/api/install/network'); }
    catch (e) { state.net = null; state.error = t(e.message); return; }
    syncForms();
  }
  // While the step is open: a cable plugged in, or an address that comes later, shows up by itself (every 1.5 s).
  function watchNetwork() {
    if (state.netTimer) clearInterval(state.netTimer);
    state.netTimer = setInterval(async () => {
      if (state.step !== 'network') { clearInterval(state.netTimer); state.netTimer = null; return; }
      if (state.netBusy || !state.net) return;
      let n;
      try { n = await api.get('/api/install/network'); } catch (e) { return; }
      if (state.step !== 'network' || state.netBusy) return;
      const before = JSON.stringify([state.net.cards, state.net.online, state.netSel]);
      state.net = n;
      syncForms();
      // Not picked yet: follow the card that has the internet. The list itself keeps its order.
      if (!state.netPicked) state.netSel = bestCard();
      if (form() && form().mode === 'static') prefill(); // only fills fields that are still empty
      if (JSON.stringify([n.cards, n.online, state.netSel]) === before && !$('#inst input[name="address"][value=""]')) return;
      redrawKeepingFocus();
    }, 1500);
  }
  // Redrawing replaces the inputs: keep the one being typed in, with its cursor.
  function redrawKeepingFocus() {
    const el = document.activeElement;
    const name = el && el.name, start = el && el.selectionStart, end = el && el.selectionEnd;
    draw();
    if (!name) return;
    const again = document.querySelector(`#inst input[name="${name}"]`);
    if (again) { again.focus(); try { again.setSelectionRange(start, end); } catch (e) { /* not a text field */ } }
  }
  function cardOf(name) { return state.net && state.net.cards.find((c) => c.name === name); }
  // Fixed address: start from the address DHCP gave, so usually only the last number changes.
  function prefill() {
    const f = form(), c = cardOf(state.netSel);
    if (!f) return;
    if (!f.address && c && c.address) f.address = c.address;
    if (!f.gateway && c && c.gateway) f.gateway = c.gateway;
    if (c && !c.gateway && !f.dns) return; // a card without internet: no DNS needed
    if (!f.dns && state.net.dns.length) f.dns = state.net.dns.join(' ');
  }
  // Continue on the network step: nothing to change when every card stays on DHCP and the internet already works.
  async function applyNetwork() {
    const list = state.net.cards.map((c) => ({ interface: c.name, ...state.netForms[c.name] }));
    // A mistake in a field: show it on that card instead of asking the server.
    const wrong = state.net.cards.find((c) => Object.keys(netErrors(state.netForms[c.name])).length);
    if (wrong) {
      state.netSeen[wrong.name] = { all: true };
      state.netSel = wrong.name; state.error = t('Check the settings of {name}.', { name: wrong.name }); draw(); return;
    }
    if (list.every((c) => c.mode === 'dhcp') && state.net.online && !state.net.chosen) { state.step = 'disk'; draw(); await loadDisks(); draw(); return; }
    state.netBusy = true; state.error = ''; draw();
    try {
      const r = await api.post('/api/install/network', { cards: list });
      state.net = { ...state.net, ...r };
      state.netBusy = false;
      if (!r.online) { state.error = t('There is no internet connection with these settings. Check the cable and the settings.'); draw(); return; }
      state.step = 'disk'; draw(); await loadDisks(); draw();
    } catch (e) {
      state.netBusy = false; state.error = t(e.message);
      if (e.card && state.netForms[e.card]) state.netSel = e.card; // show the card the message is about
      draw();
    }
  }

  async function go(step) {
    if (step === 'network') { state.step = 'network'; state.error = ''; draw(); await loadNetwork(); draw(); watchNetwork(); return; }
    if (step === 'disk' && state.step === 'network') return applyNetwork();
    if (step === 'disk') { state.step = 'disk'; draw(); await loadDisks(); draw(); return; }
    if (step === 'confirm') {
      if (!state.disk) { state.error = t('Choose a disk.'); draw(); return; }
      state.error = ''; state.step = 'confirm'; draw(); return;
    }
    if (step === 'install') return startInstall();
    if (step === 'reboot') { try { await api.post('/api/install/reboot', {}); } catch (e) { /* the demo stays here */ } return; }
    state.step = step; state.error = ''; draw();
  }
  async function startInstall() {
    state.nvidia = !!($('#nvidia') && $('#nvidia').checked);
    state.error = ''; state.step = 'progress'; state.job = { percent: 3, message: 'Preparing the installation', state: 'running' }; draw();
    try {
      await api.post('/api/install', { name: state.disk, confirm: state.disk, language: LANG, nvidia: state.nvidia });
    } catch (e) {
      state.job = { state: 'failed', percent: 0, message: e.message }; draw(); return;
    }
    followProgress();
  }
  function resumeProgress(job) {
    state.job = job; state.step = job.state === 'done' ? 'done' : 'progress'; draw();
    if (job.state === 'running') followProgress();
  }
  async function followProgress() {
    const poll = async () => {
      try { state.job = await api.get('/api/install/progress'); }
      catch (e) { state.job = { state: 'failed', percent: 0, message: e.message }; }
      if (state.job.state === 'done') { state.step = 'done'; if (state.timer) clearInterval(state.timer); draw(); return; }
      if (state.job.state === 'failed') { if (state.timer) clearInterval(state.timer); draw(); return; }
      if (!paintProgress()) draw();
    };
    await poll();
    state.timer = setInterval(poll, 700);
  }

  $('#inst').addEventListener('click', (e) => {
    const lang = e.target.closest('[data-lang]');
    if (lang) { void setLang(lang.dataset.lang).then(draw).catch((err) => { state.error = err.message; draw(); }); return; }
    const card = e.target.closest('[data-card]');
    if (card && !state.netBusy) { state.netSel = card.dataset.card; state.netPicked = true; state.error = ''; draw(); return; }
    const mode = e.target.closest('[data-mode]');
    if (mode && !state.netBusy && form()) { form().mode = mode.dataset.mode; if (mode.dataset.mode === 'static') prefill(); state.error = ''; draw(); return; }
    const disk = e.target.closest('[data-disk]');
    if (disk && !disk.disabled) { state.disk = disk.dataset.disk; state.error = ''; draw(); return; }
    const goBtn = e.target.closest('[data-go]');
    if (goBtn) go(goBtn.dataset.go);
  });

  $('#inst').addEventListener('input', (e) => {
    const f = state.step === 'network' && form();
    if (!f || !(e.target.name in f)) return;
    f[e.target.name] = e.target.value;
    // The general message goes away once this card is right again.
    if (state.error && !Object.keys(netErrors(f)).length) { state.error = ''; const box = $('#inst .inst-error'); if (box) box.textContent = ''; }
    paintNet();
  });
  // Leaving a field shows what is wrong with it.
  $('#inst').addEventListener('focusout', (e) => {
    const f = state.step === 'network' && form();
    if (!f || !(e.target.name in f)) return;
    const seen = state.netSeen[state.netSel] = state.netSeen[state.netSel] || {};
    seen[e.target.name] = true;
    paintNet();
  });

  // Cog on the USB stick (WPE WebKit 2.48) sends mousedown and mouseup but never click. Make the click ourselves
  // when the browser didn't: the click event, if any, comes right after pointerup in the same task.
  let pressed = null;
  document.addEventListener('pointerdown', (e) => { pressed = e.button === 0 ? e.target : null; }, true);
  document.addEventListener('pointerup', (e) => {
    const el = pressed; pressed = null;
    if (!el || e.button !== 0 || el !== e.target) return;
    let clicked = false;
    const seen = () => { clicked = true; };
    document.addEventListener('click', seen, true);
    setTimeout(() => {
      document.removeEventListener('click', seen, true);
      if (!clicked && el.isConnected) el.click();
    }, 0);
  }, true);

  function realApi() {
    async function call(method, path, body) {
      const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const err = new Error(data.error || res.statusText); err.status = res.status; err.card = data.card; throw err; }
      return data;
    }
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
  }

  (function stars() {
    const g = $('.wallpaper .stars'); if (!g) return;
    let s = 7; const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    let html = '';
    for (let i = 0; i < 90; i++) html += `<circle cx="${(r() * 1600).toFixed(0)}" cy="${(r() * 560).toFixed(0)}" r="${(r() * 1.3 + .3).toFixed(2)}" opacity="${(r() * .7 + .2).toFixed(2)}"/>`;
    g.innerHTML = html;
  })();

  async function boot() {
    let cfg = {};
    try { cfg = await realApi().get('/api/config'); } catch (e) { cfg = {}; }
    if (cfg.demo) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script'); s.src = 'demo.js'; s.onload = resolve; s.onerror = reject; document.body.appendChild(s);
      });
      api = window.MajaOSDemo;
    } else if (cfg.installer) { api = realApi(); state.installer = true; }
    else { state.unavailable = true; draw(); return; }
    try { await setLang(localStorage.getItem('tb-lang') || 'en'); } catch (e) { await setLang('en'); }
    // The screen was started again while installing (iso/kiosk.sh): go straight back to the progress.
    try {
      const job = await api.get('/api/install/progress');
      if (job.state === 'running' || job.state === 'done') {
        if (job.language && job.language !== LANG) { try { await setLang(job.language); } catch (e) { /* stays in English */ } }
        resumeProgress(job); return;
      }
    } catch (e) { /* not started yet */ }
    draw();
  }
  boot();
})();
