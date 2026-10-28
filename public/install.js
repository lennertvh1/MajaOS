/* HomeBaseOS installer. The same page runs in the demo and from the USB stick. */
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
  const state = { step: 'lang', disks: [], disk: null, nvidia: false, error: '', job: null, timer: null, unavailable: false };
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
    return `<div class="inst-brand">${MARK}<span>HomeBaseOS</span></div>`;
  }
  function actions(html) { return `<div class="inst-actions">${html}</div>`; }
  function btn(label, attrs, primary) {
    return `<button type="button" class="btn${primary ? ' primary' : ''}" ${attrs}>${esc(label)}</button>`;
  }

  function draw() {
    const root = $('#inst');
    if (state.unavailable) {
      root.innerHTML = `<section class="inst-card">${brand()}<h1>${esc(t('Install HomeBaseOS'))}</h1><p class="lead">${esc(t('This page is the installer. Start the computer from the HomeBaseOS USB stick to use it.'))}</p></section>`;
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
      root.innerHTML = `<section class="inst-card">${brand()}<h1>${esc(t('Welcome to HomeBaseOS'))}</h1>
        <p class="lead">${esc(t('This installs HomeBaseOS on this computer. You create your account in the browser afterwards.'))}</p>
        ${actions(btn(t('Back'), 'data-go="lang"') + btn(t('Continue'), 'data-go="disk"', true))}</section>`;
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
        <p class="lead">${esc(t('HomeBaseOS will be installed on this disk. Everything on it will be erased.'))}</p>
        ${cards}<p class="inst-error" role="alert">${esc(state.error)}</p>
        ${actions(btn(t('Back'), 'data-go="welcome"') + btn(t('Continue'), 'data-go="confirm"' + (state.disk ? '' : ' disabled'), true))}</section>`;
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
      const title = failed ? t('The installation failed. You can try again.') : (state.step === 'done' ? t('Installing HomeBaseOS') : t('Installing HomeBaseOS'));
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
  async function go(step) {
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
    const disk = e.target.closest('[data-disk]');
    if (disk && !disk.disabled) { state.disk = disk.dataset.disk; state.error = ''; draw(); return; }
    const goBtn = e.target.closest('[data-go]');
    if (goBtn) go(goBtn.dataset.go);
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
      if (!res.ok) { const err = new Error(data.error || res.statusText); err.status = res.status; throw err; }
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
      api = window.HomeBaseOSDemo;
    } else if (cfg.installer) { api = realApi(); state.installer = true; }
    else { state.unavailable = true; draw(); return; }
    try { await setLang(localStorage.getItem('tb-lang') || 'en'); } catch (e) { await setLang('en'); }
    draw();
  }
  boot();
})();
