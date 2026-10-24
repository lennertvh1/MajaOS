/* HomeBaseOS — frontend */
(function () {
  'use strict';

  /* ------------------------------------------------------------ helpers */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------ language */
  // The English text is the key itself (like gettext). Other languages are in public/lang/<code>.js (see languages.js).
  const LANG_INFO = window.TB_LANGS || { en: { name: 'English', locale: 'en-GB' } };
  const LANGS = Object.fromEntries(Object.entries(LANG_INFO).map(([k, v]) => [k, v.name]));
  const DICTS = window.TB_LANG || {};
  let LANG = 'en', LOCALE = 'en-GB';
  let nf = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
  let nf0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
  const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : String(s));
  // ctx: a context for a word with two meanings (like gettext's msgctxt), e.g. t('Devices', null, 'backup'): the dictionary key is
  // 'backup\u0004Devices'; without it, the plain word is used.
  function t(s, vars, ctx) {
    const d = DICTS[LANG], k = ctx && d && d[ctx + '\u0004' + s] != null ? ctx + '\u0004' + s : s;
    return fill(d && d[k] != null ? d[k] : s, vars);
  }
  // Server messages are always in English: recognise them by a template from the dictionary and fill in the values.
  let patterns = null;
  function tr(msg) {
    const m = String(msg == null ? '' : msg); const d = DICTS[LANG];
    if (!d || !m) return m;
    if (d[m] != null) return d[m];
    if (!patterns) {
      patterns = Object.keys(d).filter((k) => /\{\w+\}/.test(k)).map((k) => {
        const names = [];
        const src = k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([\\s\\S]+?)'; });
        return { re: new RegExp('^' + src + '$'), names, out: d[k] };
      }).sort((a, b) => b.re.source.length - a.re.source.length); // the most specific template first
    }
    for (const p of patterns) {
      const hit = m.match(p.re);
      if (hit) return fill(p.out, Object.fromEntries(p.names.map((n, i) => [n, tr(hit[i + 1])])));
    }
    return m;
  }
  // Fixed text from index.html: collect it once, fill it in again on every language change.
  const STATIC = [];
  (function collectStatic() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim() && !n.parentElement.closest('script,style,svg') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const [, lead, key, trail] = n.nodeValue.match(/^(\s*)([\s\S]*?)(\s*)$/);
      STATIC.push({ n, lead, key, trail });
    }
    document.querySelectorAll('[placeholder],[aria-label],[title]').forEach((el) => {
      ['placeholder', 'aria-label', 'title'].forEach((attr) => { if (el.hasAttribute(attr)) STATIC.push({ el, attr, key: el.getAttribute(attr) }); });
    });
  })();
  function setLang(l) {
    LANG = LANGS[l] ? l : 'en'; LOCALE = LANG_INFO[LANG].locale || LANG; patterns = null;
    nf = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
    nf0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
    document.documentElement.lang = LANG;
    STATIC.forEach((s) => { if (s.n) s.n.nodeValue = s.lead + t(s.key) + s.trail; else s.el.setAttribute(s.attr, t(s.key)); });
    try { localStorage.setItem('tb-lang', LANG); } catch (e) { /* private window */ }
  }
  try { setLang(localStorage.getItem('tb-lang') || 'en'); } catch (e) { setLang('en'); }

  // Theme per device: automatic (follows the system), light or dark.
  function setTheme(v) {
    if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('tb-theme', v || 'auto'); } catch (e) { /* private window */ }
  }
  const themeNow = () => { try { return localStorage.getItem('tb-theme') || 'auto'; } catch (e) { return 'auto'; } };
  setTheme(themeNow());

  function bytes(n) {
    if (n == null || Number.isNaN(n)) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; let v = Number(n);
    while (v >= 1000 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? nf0.format(v) : nf.format(v)) + ' ' + u[i];
  }
  function duration(sec) {
    if (sec == null) return '';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return t(d === 1 ? '{d} day {h} h' : '{d} days {h} h', { d, h });
    if (h) return t('{h} h {m} min', { h, m });
    return t('{m} min', { m });
  }
  function level(pct, warn = 75, bad = 90) { return pct >= bad ? 'bad' : pct >= warn ? 'warn' : ''; }
  function tempClass(t) { return t == null ? '' : t >= 50 ? 'temp-bad' : t >= 45 ? 'temp-warn' : 'temp-ok'; }
  const KNOWN = { 'open-webui': 'Open WebUI', pihole: 'Pi-hole', qbittorrent: 'qBittorrent', 'nginx-proxy-manager': 'Nginx Proxy Manager',
    'paperless-ngx': 'Paperless-ngx', 'uptime-kuma': 'Uptime Kuma', zigbee2mqtt: 'Zigbee2MQTT', homeassistant: 'Home Assistant',
    'home-assistant': 'Home Assistant', adguardhome: 'AdGuard Home', nextcloud: 'Nextcloud', immich: 'Immich' };
  function prettyName(n) {
    if (KNOWN[n.toLowerCase()]) return KNOWN[n.toLowerCase()];
    return n.replace(/[-_]+/g, ' ').replace(/\b(ngx|npm|mqtt|ai|vm|os|ui)\b/gi, (m) => m.toUpperCase())
      .replace(/^\w/, (c) => c.toUpperCase());
  }
  const PALETTE = ['#2f6f9f', '#3e8e7e', '#7a5ea8', '#b05a3c', '#3d7a3a', '#a2457a', '#4f5fb3', '#8a6d1f', '#26738a', '#9b4d4d'];
  function colorFor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
  function webuiUrl(tpl) { return tpl ? tpl.replace(/\[IP\]/g, location.hostname || 'localhost') : null; }

  /* ------------------------------------------------------------ API */
  const realApi = {
    async req(method, path, body) {
      const res = await fetch(path, {
        method, credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(tr(data.error) || t('Error {status}', { status: res.status })); e.status = res.status; e.data = data; throw e; }
      return data;
    },
    get(p) { return this.req('GET', p); },
    post(p, b) { return this.req('POST', p, b || {}); },
    del(p) { return this.req('DELETE', p); },
    async stream(path, body, onLine) {
      const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw new Error(tr(d.error) || t('Error {status}', { status: res.status })); }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (line) { const obj = JSON.parse(line); if (obj.error) throw new Error(tr(obj.error)); onLine(obj); }
        }
      }
      if (buf.trim()) onLine(JSON.parse(buf));
    },
  };
  let api = realApi;
  // The demo throws the same (English) messages as the server: translate those too.
  function translatedApi(src) {
    const wrap = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { e.message = tr(e.message); throw e; } };
    return { get: wrap(src.get), post: wrap(src.post), del: wrap(src.del), stream: wrap(src.stream) };
  }

  /* ------------------------------------------------------------ state */
  const S = { overview: null, apps: [], vms: [], ai: null, aiError: null, filter: 'all', search: '', config: {},
    vmsLoaded: false, vmError: null, vmFilter: 'all', vmSearch: '', vmBusy: {},
    store: null, storeQuery: '', storeCat: 'featured', storeShown: 48, appBusy: {},
    layout: { items: [] }, arrange: false, folder: null };

  /* ------------------------------------------------------------ notifications */
  function toast(msg, bad) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), bad ? 6000 : 3200);
  }

  /* ------------------------------------------------------------ clock */
  // Time format from Settings > General: 'auto' (following the language), '24' or '12'.
  function clockOpts(c = S.config && S.config.clock) { return c === '24' ? { hourCycle: 'h23' } : c === '12' ? { hourCycle: 'h12', hour: 'numeric' } : {}; }
  function tickClock() {
    const now = new Date();
    $('#clock').textContent = now.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', ...clockOpts() });
    const d = now.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
    $('#date').textContent = d.charAt(0).toUpperCase() + d.slice(1);
    const h = now.getHours();
    $('#greeting').textContent = t(h < 6 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening');
  }

  /* ------------------------------------------------------------ widgets */
  function setRing(id, pct) {
    const el = $(id); const c = 113.1;
    el.style.strokeDashoffset = pct == null ? c : String(c * (1 - Math.min(100, pct) / 100));
    el.classList.remove('warn', 'bad');
    const lv = level(pct || 0); if (lv) el.classList.add(lv);
  }

  function renderOverview() {
    const o = S.overview; if (!o) return;
    $('#host').textContent = o.hostname || '';
    document.title = (o.hostname ? o.hostname + ' – ' : '') + 'HomeBaseOS';
    const cpu = o.cpu && o.cpu.percent; const mem = o.memory && o.memory.percent;
    setRing('#cpuRing', cpu); $('#cpuPct').textContent = cpu == null ? '–' : Math.round(cpu) + '%';
    setRing('#memRing', mem); $('#memPct').textContent = mem == null ? '–' : Math.round(mem) + '%';
    const g = o.gpu && o.gpu[0];
    $('#gpuRingWrap').hidden = !g;
    if (g) { const vp = (g.memUsed / g.memTotal) * 100; setRing('#gpuRing', vp); $('#gpuPct').textContent = Math.round(vp) + '%'; }
    $('#uptime').textContent = o.uptime != null ? t('Up for {time}', { time: duration(o.uptime) }) : '';
    const facts = [];
    if (o.cpu && o.cpu.brand) facts.push([t('Processor'), o.cpu.brand.replace(/\s+\d+-Core Processor/i, '').replace(/\(R\)|\(TM\)/g, '')]);
    if (o.memory) facts.push([t('Memory'), t('{used} of {total}', { used: bytes(o.memory.used), total: bytes(o.memory.total) })]);
    if (g) facts.push(['GPU', g.name.replace(/^NVIDIA (GeForce )?/, '') + (g.temp != null ? ' · ' + g.temp + ' °C' : '')]);
    if (o.version) facts.push([t('System'), o.version.replace(' GNU/Linux', '')]);
    $('#sysFacts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('');

    const s = o.storage;
    const st = $('#arrayState');
    if (!s || !s.pools) {
      $('#storeFree').textContent = '–'; $('#storeBar').style.width = '0';
      $('#storeLine').textContent = t(s ? 'No ZFS pool yet. Create one (see README).' : 'ZFS is not reachable.');
      st.textContent = ''; st.className = 'pill'; return;
    }
    const pct = s.total ? (s.used / s.total) * 100 : 0;
    $('#storeFree').textContent = bytes(s.free);
    $('#storeFreeLabel').textContent = t('free');
    const bar = $('#storeBar'); bar.style.width = pct.toFixed(1) + '%'; bar.className = level(pct, 80, 92);
    $('#storeLine').textContent = t(s.pools > 1 ? '{used} of {total} used in {n} pools' : '{used} of {total} used', { used: bytes(s.used), total: bytes(s.total), n: s.pools });
    const [label, cls] = poolHealth(s.health);
    st.textContent = label; st.className = 'pill ' + cls;
  }
  function poolHealth(h) {
    if (h === 'ONLINE') return [t('Healthy'), 'ok'];
    if (h === 'DEGRADED') return [t('Degraded'), 'warn'];
    return [h ? t('Problem: {state}', { state: h.toLowerCase() }) : t('Unknown'), 'bad'];
  }

  function renderAiWidget() {
    const st = $('#aiState');
    if (S.aiError) {
      $('#aiLine').textContent = t(!S.config.ollama ? 'Ollama not set up' : S.aiDown ? 'Ollama is not installed' : 'Ollama not reachable');
      $('#aiSub').textContent = !S.config.ollama ? t('Set OLLAMA_URL in /etc/homebaseos/homebaseos.env.') : S.aiDown ? t('Install Ollama from the app store to run AI models locally.') : S.aiError;
      st.textContent = S.aiDown ? t('Not active') : ''; st.className = 'pill'; return;
    }
    const ai = S.ai; if (!ai) return;
    const loaded = ai.models.filter((m) => m.loaded);
    $('#aiLine').textContent = loaded.length ? loaded.map((m) => m.name).join(', ') : t('No model loaded');
    const g = ai.gpu && ai.gpu[0];
    $('#aiSub').textContent = t(ai.models.length === 1 ? '{n} model installed' : '{n} models installed', { n: ai.models.length }) +
      (g ? ' · ' + t('{used} of {total} VRAM', { used: bytes(g.memUsed), total: bytes(g.memTotal) }) : '');
    st.textContent = t(loaded.length ? 'Ready' : 'Idle'); st.className = 'pill ' + (loaded.length ? 'ok' : '');
  }

  function vmStateText(s) {
    const k = ({ RUNNING: 'Running', SHUTOFF: 'Off', SHUTDOWN: 'Shutting down', PAUSED: 'Paused', CRASHED: 'Crashed', IDLE: 'Idle',
      PMSUSPENDED: 'Suspended', NOSTATE: 'Unknown' })[String(s).toUpperCase()];
    return k ? t(k) : s;
  }
  function renderVmWidget() {
    const ul = $('#vmMini');
    const running = S.vms.filter((v) => vmKind(v.state) === 'on').length;
    $('#vmWidgetCount').textContent = S.vms.length ? t('{n} of {total} running', { n: running, total: S.vms.length }) : '';
    if (!S.vms.length) {
      ul.innerHTML = `<li class="muted small">${S.vmError ? t('VMs not available: {error}', { error: esc(S.vmError) }) : t('No virtual machines yet')}</li>`;
      return;
    }
    ul.innerHTML = S.vms.map((v) => {
      const kind = vmKind(v.state);
      const live = kind === 'on' || kind === 'paused';
      const sub = live ? 'CPU ' + vmCpuText(v) + ' · RAM ' + vmRamText(v) : vmPendingText(v);
      const bar = (pct) => `<span class="${level(pct || 0)}" style="width:${Math.min(100, pct || 0).toFixed(1)}%"></span>`;
      return `<li>
        <div class="vm-mini-row"><span class="vm-mini-name">${esc(v.name)}</span><span class="pill ${VM_PILL[kind]}">${esc(vmStateText(v.state))}</span></div>
        ${live ? `<div class="vm-mini-bars" aria-hidden="true"><div class="bar">${bar(vmCpuPct(v))}</div><div class="bar">${bar(vmRamPct(v))}</div></div>` : ''}
        ${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}
        ${live && v.ips && v.ips.length ? `<div class="vm-ip">${esc(v.ips[0])}${v.ips.length > 1 ? ' <span class="muted">+' + (v.ips.length - 1) + '</span>' : ''}</div>` : ''}
      </li>`;
    }).join('');
  }

  /* ------------------------------------------------------------ apps */
  function isRunning(a) { return /RUNNING/i.test(a.state); }
  // An update that is running: its job (lib/appstore.js startUpdate), with percent and phase.
  const updating = (a) => (a && a.updateJob && !a.updateJob.done ? a.updateJob : null);
  const progHtml = (job) => `<span class="app-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${job.percent || 0}"><span style="width:${job.percent || 0}%"></span></span>`;
  function iconHtml(a) {
    const job = updating(a);
    const dot = `<span class="dot ${isRunning(a) ? 'on' : ''}" aria-hidden="true"></span>` +
      (a.update && !job ? '<span class="upd-badge" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 19V6M6 11l6-6 6 6"/></svg></span>' : '') +
      (job ? progHtml(job) : '');
    if (a.icon) return `<span class="app-icon" data-letter="${esc(a.name.charAt(0).toUpperCase())}" data-color="${colorFor(a.name)}"><img src="${esc(a.icon)}" alt="" loading="lazy" draggable="false">${dot}</span>`;
    return `<span class="app-icon" style="background:${colorFor(a.name)}">${esc(a.name.charAt(0).toUpperCase())}${dot}</span>`;
  }

  function renderApps() {
    if (drag && drag.started) return; // don't redraw while dragging (and landing)
    const q = S.search.trim().toLowerCase();
    const list = S.apps.filter((a) => {
      if (q && !(a.name.toLowerCase().includes(q) || (a.image || '').toLowerCase().includes(q))) return false;
      if (S.filter === 'running') return isRunning(a);
      if (S.filter === 'stopped') return !isRunning(a);
      if (S.filter === 'update') return !!a.update;
      return true;
    });
    // The Updates filter only makes sense when the server can report updates.
    const updBtn = $('#filters [data-filter="update"]');
    updBtn.hidden = !S.apps.some((a) => a.update);
    if (updBtn.hidden && S.filter === 'update') { S.filter = 'all'; $$('#filters button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.filter === 'all'))); return renderApps(); }
    const running = S.apps.filter(isRunning).length;
    $('#appCount').textContent = S.apps.length ? t('{n} of {total} running', { n: running, total: S.apps.length }) : '';
    renderUpdateInfo();
    const grid = $('#appGrid');
    if (!list.length) {
      grid.innerHTML = `<p class="empty">${t(S.apps.length ? 'No apps match.' : 'No containers found yet.')}</p>`;
      return;
    }
    // Searching or filtering: a plain list. Otherwise the own layout with folders.
    const flat = !!q || S.filter !== 'all';
    $('#arrangeBtn').disabled = flat;
    $('#arrangeBtn').title = flat ? t('Clear the search and choose All to arrange.') : '';
    if (flat && S.arrange) setArrange(false);
    grid.classList.toggle('arranging', S.arrange);
    grid.innerHTML = flat ? list.map(appTile).join('') : homeItems().map((it) => (typeof it === 'string' ? appTile(appByName(it)) : folderTile(it))).join('');
    if (S.folder) renderFolder();
  }
  function appTile(a) {
    const label = prettyName(a.name);
    const busy = S.appBusy[a.id], job = updating(a);
    const state = job ? t('updating… {n}%', { n: job.percent || 0 }) : busy ? t(APP_ACTS[busy].noun).toLowerCase() + '…' : t(a.update ? 'update available' : isRunning(a) ? 'running' : 'stopped');
    const hint = t(job ? 'click to follow the update' : appUrl(a) ? 'click to open' : 'click for the menu');
    return `<div class="app ${isRunning(a) ? '' : 'stopped'}${busy ? ' busy' : ''}${job ? ' updating' : ''}" data-item="${esc(a.name)}">
        <button class="app-open" type="button" data-app="${esc(a.id)}" data-action="open" title="${esc(label)} – ${state}, ${hint}">
          ${iconHtml(a)}<span class="app-name">${esc(label)}</span>
        </button>
        <button class="app-more" type="button" data-app="${esc(a.id)}" data-action="menu" aria-haspopup="menu" aria-label="${esc(t('Menu for {name}', { name: label }))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
      </div>`;
  }
  // Folder: a frosted-glass tile with the icons of the first nine apps in a 3 × 3 grid, like on an iPad.
  function folderTile(f) {
    const apps = f.apps.map(appByName).filter(Boolean);
    const mini = apps.slice(0, 9).map((a) => (a.icon ? `<span class="mini" data-letter="${esc(a.name.charAt(0).toUpperCase())}" data-color="${colorFor(a.name)}"><img src="${esc(a.icon)}" alt="" draggable="false"></span>`
      : `<span class="mini" style="background:${colorFor(a.name)}">${esc(a.name.charAt(0).toUpperCase())}</span>`)).join('');
    const upd = apps.some((a) => a.update), on = apps.filter(isRunning).length;
    return `<div class="app folder" data-item="f:${esc(f.folder)}">
        <button class="app-open" type="button" data-folder-open="${esc(f.folder)}" title="${esc(t('{name} – folder with {n} apps, {on} running', { name: f.name, n: apps.length, on }))}">
          <span class="app-icon folder-icon">${mini}${upd ? '<span class="upd-badge" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 19V6M6 11l6-6 6 6"/></svg></span>' : ''}</span>
          <span class="app-name">${esc(f.name)}</span>
        </button>
      </div>`;
  }

  /* --- widgets on the dashboard: order and hiding (stored on the server, like the apps) */
  const WIDGET_NAMES = { clock: 'Clock', sys: 'System', storage: 'Storage', shares: 'Shared folders', backup: 'Backups', ai: 'AI', vms: 'Virtual machines' };
  const WIDGET_ICONS = {
    up: '<path d="M6 15l6-6 6 6"/>', down: '<path d="M6 9l6 6 6-6"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  };
  let widgetEdit = false, wdrag = null;
  const widgetBox = $('#widgets');
  const slots = () => [...widgetBox.querySelectorAll(':scope > .widget-slot')];
  function applyWidgets() {
    const cfg = (S.layout && S.layout.widgets) || { order: [], hidden: [] };
    const ids = slots().map((x) => x.dataset.widget);
    const order = [...cfg.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !cfg.order.includes(id))];
    const edit = $('#widgetsEdit');
    order.forEach((id) => widgetBox.insertBefore(widgetBox.querySelector(`:scope > [data-widget="${id}"]`), edit));
    widgetBox.classList.toggle('editing', widgetEdit);
    edit.textContent = t(widgetEdit ? 'Ready' : 'Customize widgets');
    edit.classList.toggle('btn', widgetEdit); edit.classList.toggle('primary', widgetEdit); edit.classList.toggle('linkish', !widgetEdit);
    const list = slots();
    list.forEach((x, i) => {
      const id = x.dataset.widget, hid = cfg.hidden.includes(id), name = t(WIDGET_NAMES[id] || id);
      x.hidden = hid && !widgetEdit;
      x.classList.toggle('is-hidden', hid);
      let ctl = x.querySelector(':scope > .widget-ctl');
      if (!widgetEdit) { if (ctl) ctl.remove(); return; }
      if (!ctl) { ctl = document.createElement('div'); ctl.className = 'widget-ctl'; x.appendChild(ctl); }
      const b = (act, icon, label, extra = '') => `<button type="button" data-wact="${act}" aria-label="${esc(label)}" title="${esc(label)}"${extra}><svg viewBox="0 0 24 24" aria-hidden="true">${WIDGET_ICONS[icon]}</svg></button>`;
      ctl.innerHTML = b('up', 'up', t('Move {name} up', { name }), i === 0 ? ' disabled' : '') + b('down', 'down', t('Move {name} down', { name }), i === list.length - 1 ? ' disabled' : '')
        + b('toggle', hid ? 'eyeOff' : 'eye', t(hid ? 'Show {name}' : 'Hide {name}', { name }), ` class="eye" aria-pressed="${!hid}"`);
    });
  }
  function saveWidgets() {
    const list = slots();
    S.layout = { ...S.layout, widgets: { order: list.map((x) => x.dataset.widget), hidden: list.filter((x) => x.classList.contains('is-hidden')).map((x) => x.dataset.widget) } };
    applyWidgets(); postLayout();
  }
  $('#widgetsEdit').addEventListener('click', () => { widgetEdit = !widgetEdit; applyWidgets(); });
  widgetBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wact]'); if (!b || !widgetEdit) return;
    e.stopPropagation();
    const slot = b.closest('.widget-slot');
    if (b.dataset.wact === 'toggle') slot.classList.toggle('is-hidden');
    else flip(widgetBox, () => {
      if (b.dataset.wact === 'up' && slot.previousElementSibling) widgetBox.insertBefore(slot, slot.previousElementSibling);
      if (b.dataset.wact === 'down' && slot.nextElementSibling && slot.nextElementSibling.classList.contains('widget-slot')) widgetBox.insertBefore(slot.nextElementSibling, slot);
    });
    saveWidgets();
    const again = $(`[data-widget="${slot.dataset.widget}"] [data-wact="${b.dataset.wact}"]`); if (again && !again.disabled) again.focus();
  });
  // Dragging: the widget moves along, the others make room.
  widgetBox.addEventListener('pointerdown', (e) => {
    if (!widgetEdit || e.button > 0 || e.target.closest('[data-wact]')) return;
    const slot = e.target.closest('.widget-slot'); if (!slot) return;
    e.preventDefault();
    wdrag = { slot, y0: e.clientY, started: false };
    const move = (ev) => {
      if (!wdrag.started && Math.abs(ev.clientY - wdrag.y0) < 6) return;
      wdrag.started = true; slot.classList.add('lifting');
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = over && over.closest('#widgets > .widget-slot');
      if (!target || target === slot) return;
      const r = target.getBoundingClientRect(), after = ev.clientY > r.top + r.height / 2;
      const ref = after ? target.nextElementSibling : target; // insert before ref
      if (ref === slot || slot.nextElementSibling === ref) return; // already there
      flip(widgetBox, () => widgetBox.insertBefore(slot, ref));
    };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
      slot.classList.remove('lifting');
      if (wdrag && wdrag.started) saveWidgets();
      wdrag = null;
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
  });

  /* --- widget: shared folders */
  async function loadShares() {
    try { S.shares = await api.get('/api/shares'); S.sharesError = null; } catch (e) { S.sharesError = e.message; }
    renderSharesWidget();
  }
  function renderSharesWidget() {
    const ul = $('#shareMini'), pill = $('#shareConn'), d = S.shares;
    if (!d) { ul.innerHTML = `<li class="muted small">${S.sharesError ? esc(S.sharesError) : t('Loading…')}</li>`; pill.textContent = ''; return; }
    if (!d.installed) { ul.innerHTML = `<li class="muted small">${t('Samba is not installed yet.')}</li>`; pill.textContent = ''; return; }
    const c = d.connections || { total: 0, perShare: {} };
    pill.textContent = c.total ? t('{n} connected', { n: c.total }) : (d.running ? t('Active') : t('Off'));
    pill.className = 'pill ' + (c.total || d.running ? 'ok' : 'warn');
    ul.innerHTML = d.shares.slice(0, 5).map((sh) => {
      // also those who have access through a group
      const members = new Set(Object.keys(sh.users));
      Object.keys(sh.groups || {}).forEach((g) => { const gr = (d.groups || []).find((x) => x.name === g); (gr ? gr.members : []).forEach((m) => members.add(m)); });
      const users = members.size, n = c.perShare[sh.name] || 0;
      const side = n ? t('{n} connected', { n }) : [users ? t(users === 1 ? '{n} user' : '{n} users', { n: users }) : null, sh.guest ? t('guests') : null].filter(Boolean).join(' · ');
      return `<li><span class="name">${esc(sh.name)}</span><span class="muted small">${esc(side)}</span></li>`;
    }).join('') + (d.shares.length > 5 ? `<li class="muted small">${t('and {n} more', { n: d.shares.length - 5 })}</li>` : '')
      || `<li class="muted small">${t('No shared folders yet. Click to create one.')}</li>`;
  }

  /* --- widget: backups */
  async function loadBackups() {
    try { S.backup = await api.get('/api/backup?brief=1'); S.backupError = null; } catch (e) { S.backupError = e.message; }
    renderBackupWidget();
  }
  function renderBackupWidget() {
    const ul = $('#bkMini'), pill = $('#bkState'), d = S.backup;
    if (!d) { ul.innerHTML = `<li class="muted small">${S.backupError ? esc(S.backupError) : t('Loading…')}</li>`; pill.textContent = ''; return; }
    const running = d.jobs.filter((j) => j.running).length, failed = d.jobs.filter((j) => !j.running && j.lastRun && j.lastRun.state === 'failed').length;
    pill.textContent = running ? t('In progress') : failed ? t('{n} failed', { n: failed }) : d.jobs.length ? t('All good') : '';
    pill.className = 'pill ' + (running ? '' : failed ? 'bad' : 'ok');
    const side = (j) => {
      if (j.running) return t('in progress') + (j.running.percent != null ? ' ' + Math.floor(j.running.percent) + '%' : '');
      if (!j.lastRun) return t('not done yet');
      return (j.lastRun.state === 'ok' ? '' : t(j.lastRun.state === 'failed' ? 'failed' : 'stopped') + ' · ') + ago(j.lastRun.ended);
    };
    ul.innerHTML = d.jobs.slice(0, 5).map((j) => `<li><span class="name">${esc(j.name)}</span><span class="muted small${!j.running && j.lastRun && j.lastRun.state === 'failed' ? ' temp-bad' : ''}">${esc(side(j))}</span></li>`).join('')
      + (d.jobs.length > 5 ? `<li class="muted small">${t('and {n} more', { n: d.jobs.length - 5 })}</li>` : '')
      + (d.devices ? `<li><span class="name">${t('Devices', null, 'backup')}</span><span class="muted small">${esc(t(d.devices === 1 ? '{n} device' : '{n} devices', { n: d.devices }))}</span></li>` : '')
      || `<li class="muted small">${t('No backups yet. Click to create one.')}</li>`;
  }

  /* --- home screen: order and folders (like on an iPad) */
  const appByName = (n) => S.apps.find((a) => a.name === n);
  // The saved layout, without apps that are gone and with new apps at the end.
  function homeItems() {
    const names = new Set(S.apps.map((a) => a.name)), placed = new Set(), out = [];
    for (const it of S.layout.items) {
      if (typeof it === 'string') { if (names.has(it) && !placed.has(it)) { out.push(it); placed.add(it); } continue; }
      const apps = it.apps.filter((n) => names.has(n) && !placed.has(n));
      apps.forEach((n) => placed.add(n));
      if (apps.length > 1) out.push({ ...it, apps }); else if (apps.length === 1) out.push(apps[0]);
    }
    S.apps.forEach((a) => { if (!placed.has(a.name)) out.push(a.name); });
    return out;
  }
  // Folders with one app become a plain app again; empty folders disappear.
  const tidy = (items) => items.flatMap((it) => (typeof it === 'string' ? [it] : it.apps.length > 1 ? [it] : it.apps));
  let layoutTimer = null;
  function setLayout(items) {
    S.layout = { ...S.layout, items: tidy(items) };
    if (S.folder && !S.layout.items.some((it) => it.folder === S.folder)) closeFolder();
    renderApps();
    postLayout();
  }
  function postLayout() {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => api.post('/api/layout', S.layout).catch((e) => toast(t('Saving the layout failed: {error}', { error: e.message }), true)), 300);
  }
  async function loadLayout() {
    try { S.layout = await api.get('/api/layout'); } catch (e) { S.layout = { items: [] }; }
    renderApps(); applyWidgets();
  }
  const newFolderId = () => 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  const folderOf = (name) => S.layout.items.find((it) => typeof it !== 'string' && it.apps.includes(name)) || null;
  // Take an app out of the layout (home or out of a folder). Returns the new list.
  function without(items, name) {
    return items.filter((it) => it !== name).map((it) => (typeof it === 'string' ? it : { ...it, apps: it.apps.filter((n) => n !== name) }));
  }
  function moveToFolder(name, folderId, folderName) {
    let items = without(homeItems(), name);
    if (folderId) items = items.map((it) => (it.folder === folderId ? { ...it, apps: [...it.apps, name] } : it));
    else items.push({ folder: newFolderId(), name: folderName || t('New folder'), apps: [name] });
    setLayout(items);
  }
  function takeOutOfFolder(name) {
    const items = homeItems(), at = items.findIndex((it) => typeof it !== 'string' && it.apps.includes(name));
    if (at < 0) return;
    const next = without(items, name);
    next.splice(at + 1, 0, name); // right after the folder
    setLayout(next);
  }

  // Arrange: icons wiggle, clicking opens nothing, dragging moves.
  function setArrange(on) {
    S.arrange = !!on;
    $('#arrangeBtn').setAttribute('aria-pressed', String(S.arrange));
    $('#arrangeBtn').textContent = t(S.arrange ? 'Ready' : 'Arrange');
    $('#arrangeBtn').classList.toggle('primary', S.arrange);
    $('#appGrid').classList.toggle('arranging', S.arrange);
    $('#folderGrid').classList.toggle('arranging', S.arrange);
    renderFolderHint();
  }
  $('#arrangeBtn').addEventListener('click', () => setArrange(!S.arrange));

  /* open a folder: a panel above the home screen */
  const folderPanel = $('#folderPanel'), folderOverlay = $('#folderOverlay');
  function openFolder(id) {
    // The panel zooms open from the folder tile.
    const tile = $(`#appGrid [data-item="f:${CSS.escape(id)}"] .app-icon`);
    if (tile) { const r = tile.getBoundingClientRect(); folderPanel.style.setProperty('--from-x', (r.left + r.width / 2 - innerWidth / 2) + 'px'); folderPanel.style.setProperty('--from-y', (r.top + r.height / 2 - innerHeight / 2) + 'px'); }
    S.folder = id; folderPanel.hidden = false; folderOverlay.hidden = false;
    renderFolder();
    const first = $('#folderGrid .app-open', folderPanel); if (first) first.focus();
  }
  function closeFolder() {
    if (!S.folder) return;
    const id = S.folder; S.folder = null; folderPanel.hidden = true; folderOverlay.hidden = true;
    const tile = $(`#appGrid [data-item="f:${CSS.escape(id)}"] .app-open`); if (tile) tile.focus();
  }
  function renderFolder() {
    const f = homeItems().find((it) => it.folder === S.folder);
    if (!f) { closeFolder(); return; }
    const name = $('#folderName');
    if (document.activeElement !== name) name.value = f.name;
    $('#folderGrid').innerHTML = f.apps.map(appByName).filter(Boolean).map(appTile).join('');
    $('#folderGrid').classList.toggle('arranging', S.arrange);
    renderFolderHint();
  }
  function renderFolderHint() {
    $('#folderHint').textContent = S.arrange ? t('Drag an app outside to take it out of the folder.') : t('Click the name to rename the folder.');
  }
  $('#folderClose').addEventListener('click', closeFolder);
  folderOverlay.addEventListener('click', () => { if (!drag) closeFolder(); });
  $('#folderName').addEventListener('change', (e) => {
    const name = e.target.value.trim().slice(0, 40) || t('Folder');
    setLayout(homeItems().map((it) => (it.folder === S.folder ? { ...it, name } : it)));
  });
  $('#folderName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#folderUngroup').addEventListener('click', () => {
    const items = homeItems(), at = items.findIndex((it) => it.folder === S.folder);
    if (at < 0) return;
    items.splice(at, 1, ...items[at].apps); // the apps take the place of the folder
    closeFolder(); setLayout(items);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.folder && menu.hidden) closeFolder(); });

  /* dragging (mouse and touch), like on an iPad: the other apps move aside; holding above an app for a moment makes a folder */
  let drag = null, pressTimer = null;
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // FLIP: after a change in the grid the tiles slide smoothly from their old to their new place.
  function flip(grid, change) {
    const before = new Map([...grid.children].map((el) => [el, el.getBoundingClientRect()]));
    change();
    if (calm()) return;
    for (const el of grid.children) {
      const b = before.get(el); if (!b || (drag && el === drag.el)) continue;
      const a = el.getBoundingClientRect(), dx = b.left - a.left, dy = b.top - a.top;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    }
  }
  // Briefly bounce (put in a folder) or appear (new folder).
  function bump(item, cls = 'bump') {
    const icon = $(`#appGrid [data-item="${CSS.escape(item)}"] .app-icon`); if (!icon || calm()) return;
    icon.classList.add(cls); icon.addEventListener('animationend', () => icon.classList.remove(cls), { once: true });
  }
  // Where is the pointer? Middle of an app = folder (only for an app on the home screen), elsewhere on a tile = move.
  function tileTarget(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    if (S.folder && drag.ctx === 'folder' && !folderPanel.contains(el)) return { out: true };
    const tile = el.closest('#appGrid [data-item], #folderGrid [data-item]');
    if (!tile || tile === drag.el) return null;
    if ((tile.closest('#folderGrid') ? 'folder' : 'home') !== drag.ctx) return null;
    const r = tile.querySelector('.app-icon').getBoundingClientRect();
    const inner = x > r.left + r.width * 0.2 && x < r.right - r.width * 0.2 && y > r.top + r.height * 0.2 && y < r.bottom - r.height * 0.2;
    if (inner && drag.ctx === 'home' && !drag.item.startsWith('f:')) return { tile, mode: 'merge' };
    return { tile, mode: 'move' };
  }
  function setMerge(tile) {
    if (drag.merge) drag.merge.classList.remove('merge');
    drag.merge = tile || null;
    if (tile) tile.classList.add('merge');
  }
  // The place of the app you are dragging (half transparent) moves to the app you hover over; the rest moves along.
  function movePlaceholder(tile) {
    const grid = drag.el.parentNode, kids = [...grid.children], from = kids.indexOf(drag.el), to = kids.indexOf(tile);
    if (from < 0 || to < 0) return;
    flip(grid, () => grid.insertBefore(drag.el, to > from ? tile.nextSibling : tile));
    drag.moved = true; drag.hoverKey = ''; drag.restX = null;
  }
  // Only react when you hold still: whoever just slides over it (on the way to the middle of an app) moves nothing.
  function hover(tg, x, y) {
    const key = !tg ? '' : tg.out ? 'out' : tg.tile.dataset.item + ':' + tg.mode;
    const still = drag.restX != null && Math.hypot(x - drag.restX, y - drag.restY) < 6;
    if (key === drag.hoverKey && still) return;
    drag.restX = x; drag.restY = y;
    if (key !== drag.hoverKey && drag.merge) setMerge(null);
    drag.hoverKey = key; drag.out = key === 'out';
    clearTimeout(drag.timer);
    folderOverlay.classList.toggle('drop-out', drag.out);
    if (!tg || tg.out) return;
    // Wait a moment, so nothing jumps when you just slide over it.
    if (tg.mode === 'merge') { if (drag.merge !== tg.tile) drag.timer = setTimeout(() => setMerge(tg.tile), 280); }
    else { setMerge(null); drag.timer = setTimeout(() => movePlaceholder(tg.tile), 160); }
  }
  function onDragStart(e) {
    if (e.button > 0 || drag) return;
    const tile = e.target.closest('#appGrid [data-item], #folderGrid [data-item]');
    if (!tile || e.target.closest('.app-more')) return;
    const ctx = tile.closest('#folderGrid') ? 'folder' : 'home';
    if (!S.arrange) {
      // A long press (like on an iPad) turns on Arrange.
      if ($('#arrangeBtn').disabled) return;
      const x0 = e.clientX, y0 = e.clientY;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { pressTimer = null; setArrange(true); ignoreNextClick(); }, 550);
      const cancel = (ev) => { if (ev.type !== 'pointermove' || Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) { clearTimeout(pressTimer); off(); } };
      const off = () => ['pointermove', 'pointerup', 'pointercancel'].forEach((t2) => document.removeEventListener(t2, cancel));
      ['pointermove', 'pointerup', 'pointercancel'].forEach((t2) => document.addEventListener(t2, cancel));
      return;
    }
    e.preventDefault(); // no text selection or focus jumps while dragging
    drag = { item: tile.dataset.item, ctx, el: tile, x0: e.clientX, y0: e.clientY, started: false, hoverKey: '', moved: false };
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
    document.addEventListener('pointercancel', onDragEnd);
  }
  function onDragMove(e) {
    if (!drag || drag.ending) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
      drag.started = true;
      const icon = drag.el.querySelector('.app-icon'), r = icon.getBoundingClientRect();
      drag.dx = drag.x0 - r.left; drag.dy = drag.y0 - r.top; // where you grabbed the icon
      drag.ghost = icon.cloneNode(true); drag.ghost.classList.add('drag-ghost');
      document.body.appendChild(drag.ghost);
      drag.el.classList.add('dragging');
    }
    e.preventDefault();
    drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px) scale(1.1)`;
    hover(tileTarget(e.clientX, e.clientY), e.clientX, e.clientY);
  }
  let suppressClick = false;
  const ignoreNextClick = () => { suppressClick = true; setTimeout(() => { suppressClick = false; }, 500); };
  function onDragEnd() {
    ['pointermove', 'pointerup', 'pointercancel'].forEach((t2) => document.removeEventListener(t2, t2 === 'pointermove' ? onDragMove : onDragEnd));
    const d = drag;
    if (!d || d.ending) return;
    clearTimeout(d.timer);
    if (!d.started) { drag = null; return; }
    d.ending = true;
    ignoreNextClick(); // the click after releasing must open nothing
    folderOverlay.classList.remove('drop-out');
    // The icon flies to its place (or shrinks into the folder); only then save the layout.
    const land = (rect, into, then) => {
      const done = () => { d.ghost.remove(); d.el.classList.remove('dragging'); drag = null; then(); };
      if (calm() || !rect) { done(); return; }
      const to = `translate(${rect.left}px, ${rect.top}px) scale(${into ? 0.3 : 1})`;
      const a = d.ghost.animate([{ transform: d.ghost.style.transform, opacity: 1 }, { transform: to, opacity: into ? 0 : 1 }],
        { duration: into ? 240 : 200, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'forwards' });
      a.onfinish = done;
    };
    if (d.merge) {
      const target = d.merge.dataset.item, r = d.merge.querySelector('.app-icon').getBoundingClientRect();
      const center = { left: r.left + r.width * 0.35, top: r.top + r.height * 0.35 };
      land(center, true, () => {
        d.merge.classList.remove('merge');
        if (target.startsWith('f:')) { moveToFolder(d.item, target.slice(2)); bump(target); return; }
        // New folder in the place of the app you dropped on.
        const id = newFolderId();
        setLayout(without(homeItems(), d.item).map((it) => (it === target ? { folder: id, name: t('New folder'), apps: [target, d.item] } : it)));
        bump('f:' + id, 'pop-in');
        setTimeout(() => { openFolder(id); const n = $('#folderName'); n.focus(); n.select(); }, calm() ? 0 : 260);
      });
      return;
    }
    if (d.out) { land(null, false, () => takeOutOfFolder(d.item)); return; }
    land(d.el.querySelector('.app-icon').getBoundingClientRect(), false, () => {
      if (!d.moved) return;
      // The order as it is in the grid now.
      const order = [...d.el.parentNode.children].map((x) => x.dataset.item).filter(Boolean);
      if (d.ctx === 'folder') setLayout(homeItems().map((it) => (it.folder === S.folder ? { ...it, apps: order } : it)));
      else { const by = new Map(homeItems().map((it) => [typeof it === 'string' ? it : 'f:' + it.folder, it])); setLayout(order.map((k) => by.get(k)).filter(Boolean)); }
    });
  }
  $('#appGrid').addEventListener('pointerdown', onDragStart);
  $('#folderGrid').addEventListener('pointerdown', onDragStart);
  // The browser's own dragging (image or link) breaks our dragging with pointercancel: always prevent it.
  ['#appGrid', '#folderGrid'].forEach((sel) => $(sel).addEventListener('dragstart', (e) => e.preventDefault()));
  // After dragging or a long press: ignore the click that follows.
  document.addEventListener('click', (e) => { if (suppressClick) { suppressClick = false; if (e.target.closest('#appGrid, #folderGrid')) { e.stopPropagation(); e.preventDefault(); } } }, true);
  $('#folderGrid').addEventListener('contextmenu', (e) => {
    const tg = e.target.closest('[data-app]'); if (!tg || S.arrange) return;
    const a = S.apps.find((x) => x.id === tg.dataset.app); if (!a) return;
    e.preventDefault();
    openAppMenu(a, e.clientX, e.clientY, tg);
  });

  // To folder…: choose an existing folder or make a new one.
  function folderPickWindow(a) {
    const folders = homeItems().filter((it) => typeof it !== 'string');
    const cur = folderOf(a.name);
    openWindow(t('Move {name} to a folder', { name: prettyName(a.name) }), `
      <ul class="rows">${folders.map((f) => `<li><div><div class="row-title">${esc(f.name)}</div><div class="row-sub">${esc(t('{n} apps', { n: f.apps.length }))}</div></div>
        <div class="row-side">${cur && cur.folder === f.folder ? `<span class="muted">${t('already here')}</span>` : `<button class="btn sm" type="button" data-pick="${esc(f.folder)}">${t('Move here')}</button>`}</div></li>`).join('')
        || `<li><span class="muted">${t('No folders yet.')}</span></li>`}</ul>
      <form class="inline-form" id="newFolderForm" style="margin-top:14px">
        <input class="field" name="name" maxlength="40" placeholder="${t('Name of a new folder, e.g. Media')}" aria-label="${t('Name of a new folder')}" autocomplete="off">
        <button class="btn primary" type="submit">${t('New folder')}</button>
      </form>`, (body) => {
      body.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) { moveToFolder(a.name, b.dataset.pick); win.close(); toast(t('{name} is now in the folder.', { name: prettyName(a.name) })); } });
      $('#newFolderForm', body).addEventListener('submit', (e) => {
        e.preventDefault();
        moveToFolder(a.name, null, e.target.elements.name.value.trim().slice(0, 40)); win.close();
        toast(t('{name} is now in the folder.', { name: prettyName(a.name) }));
      });
    });
  }

  // Under the title: how many updates there are, with View, Update all and Check now.
  function renderUpdateInfo() {
    const el = $('#updInfo');
    const upd = S.apps.filter((a) => a.update);
    const canAll = upd.filter((a) => a.canUpdate && !S.appBusy[a.id]);
    const checked = Math.max(0, ...S.apps.map((a) => a.updateChecked || 0));
    const when = checked ? t('Last checked: {when}', { when: new Date(checked).toLocaleString(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit', ...clockOpts() }) }) : t('Not checked yet');
    el.innerHTML = (upd.length
      ? `<button class="pill warn upd-pill" type="button" data-upd="show"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6"/></svg>${t(upd.length === 1 ? '{n} update' : '{n} updates', { n: upd.length })}</button>
         ${canAll.length ? `<button class="linkish" type="button" data-upd="all">${t('Update all')}</button>` : ''}`
      : (checked ? `<span class="muted small">${t('Everything is up to date')}</span>` : ''))
      + `<button class="linkish" type="button" data-upd="check" title="${esc(when)}"${S.updChecking ? ' disabled' : ''}>${t(S.updChecking ? 'Checking…' : 'Check now')}</button>`;
  }
  async function checkUpdatesNow() {
    S.updChecking = true; renderUpdateInfo();
    try {
      const r = await api.post('/api/apps/check-updates');
      toast(r.updates ? t(r.updates === 1 ? '{n} app has an update.' : '{n} apps have an update.', { n: r.updates }) : t('All apps are up to date.'));
      if (r.errors && r.errors.length) toast(t('Not checked: {list}', { list: r.errors.map(tr).join('; ') }), true);
    } catch (e) { toast(t('Checking for updates failed: {error}', { error: e.message }), true); }
    S.updChecking = false;
    await loadApps().catch(() => renderApps());
  }
  async function updateAll() {
    const list = S.apps.filter((a) => a.update && a.canUpdate && !S.appBusy[a.id]);
    if (!list.length) return;
    if (!(await ask(t(list.length === 1 ? 'Update {n} app? {names}. It will be unavailable for a moment while it restarts.'
      : 'Update {n} apps? {names}. Each will be unavailable for a moment while it restarts.', { n: list.length, names: list.map((a) => prettyName(a.name)).join(', ') }), t('Update all')))) return;
    for (const a of list) await startAppUpdate(a, true);
  }

  // Update an app: a job with progress (bar on the tile) and a log (click the tile, or Update log in the menu).
  async function startAppUpdate(a, quiet) {
    try {
      const r = await api.post(appPath(a, '/update'));
      a.updateJob = { job: r.job, done: false, ok: false, percent: 0, phase: 'pull' };
      renderApps(); watchUpdates();
      if (!quiet) toast(t('Updating {name}… Click the app to follow it.', { name: prettyName(a.name) }));
    } catch (e) { toast(t('Updating {name} failed: {error}', { name: prettyName(a.name), error: e.message }), true); }
  }
  // One poller for all running updates: the bar on each tile follows the job; when it is done, a notification and the new list.
  let updWatch = null;
  function watchUpdates() {
    if (updWatch) return;
    const tick = async () => {
      const list = S.apps.filter(updating);
      if (!list.length) { updWatch = null; return; }
      let finished = false;
      await Promise.all(list.map(async (a) => {
        let j; try { j = await api.get('/api/store/jobs/' + a.updateJob.job); } catch (e) { return; }
        Object.assign(a.updateJob, { done: j.done, ok: j.ok, error: j.error, percent: j.percent, phase: j.phase });
        const tile = $(`.app[data-item="${CSS.escape(a.name)}"]`);
        const bar = tile && $('.app-prog', tile);
        if (bar) { bar.firstElementChild.style.width = (j.percent || 0) + '%'; bar.setAttribute('aria-valuenow', String(j.percent || 0)); }
        const open = tile && $('.app-open', tile);
        if (open && !j.done) open.title = `${prettyName(a.name)} – ${t('updating… {n}%', { n: j.percent || 0 })}, ${t('click to follow the update')}`;
        if (j.done) {
          finished = true;
          if (j.ok) toast(t('Updated: {name}', { name: prettyName(a.name) }));
          else toast(t('Updating {name} failed: {error}', { name: prettyName(a.name), error: tr(j.error || '') }), true);
        }
      }));
      if (finished) await loadApps().catch(() => renderApps());
      updWatch = setTimeout(tick, 1000);
    };
    updWatch = setTimeout(tick, 600);
  }
  // The update's progress and log in a window, like when installing.
  function updateLogWindow(a) {
    const label = prettyName(a.name), id = a.updateJob && a.updateJob.job;
    if (!id) return;
    openWindow(t('{name} · update', { name: label }), jobHtml(), (body) => {
      $('#storeJob', body).hidden = false;
      const follow = async () => {
        let j;
        try { j = await api.get('/api/store/jobs/' + id); }
        catch (e) { $('#jobState', body).textContent = t('This update is no longer known (the log is kept for an hour).'); return; }
        if (!body.isConnected) return;
        drawJob(body, j);
        if (!j.done) { setTimeout(follow, 1000); return; }
        $('#jobState', body).innerHTML = j.ok ? esc(t('Updated: {name}', { name: label }))
          : `<span class="temp-bad">${esc(t('Updating {name} failed: {error}', { name: label, error: tr(j.error || '') }))}</span>`;
        if (!j.ok) $('.job-log', body).open = true;
        $('#jobBtns', body).innerHTML = `<button class="btn" type="button" data-close>${t('Close')}</button>`;
      };
      follow();
    });
  }
  $('#updInfo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-upd]'); if (!b) return;
    if (b.dataset.upd === 'check') return checkUpdatesNow();
    if (b.dataset.upd === 'all') return updateAll();
    S.filter = 'update'; $$('#filters button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.filter === 'update'))); renderApps();
  });

  /* ------------------------------------------------------------ window */
  const win = $('#win');
  let onWinClose = null;
  function openWindow(title, html, after) {
    win.classList.remove('win-wide'); // only the storage window is wide (for the case with bays)
    if (onWinClose) { try { onWinClose(); } catch (e) { /* ignore */ } onWinClose = null; }
    $('#winTitle').textContent = title;
    // New element, so listeners of a previous window don't hang around.
    const old = $('#winBody'), body = old.cloneNode(false);
    old.replaceWith(body);
    body.innerHTML = html;
    if (!win.open) win.showModal();
    if (after) after(body);
  }
  $('#winClose').addEventListener('click', () => win.close());
  // A link to Settings in a window: the window closes, Settings opens on top.
  win.addEventListener('click', (e) => { if (e.target.closest('a[href^="#settings"]')) win.close(); });
  win.addEventListener('click', (e) => { if (e.target === win || e.target.closest('[data-close]')) win.close(); });
  // The close event comes asynchronously: if a new window is already open by then, don't empty that one.
  win.addEventListener('close', () => { if (onWinClose) { onWinClose(); onWinClose = null; } if (!win.open) $('#winBody').innerHTML = ''; });

  // Own confirmation (also works where confirm() is blocked).
  // With checkLabel a checkbox is added and ask() returns { checked } instead of true.
  function ask(text, yesLabel, checkLabel) {
    const d = $('#ask');
    $('#askText').textContent = text; $('#askYes').textContent = yesLabel || t('Continue');
    $('#askCheckWrap').hidden = !checkLabel; $('#askCheck').checked = false; $('#askCheckText').textContent = checkLabel || '';
    d.showModal(); $('#askNo').focus();
    return new Promise((resolve) => {
      const done = (v) => { d.close(); $('#askYes').onclick = $('#askNo').onclick = null; d.onclose = null; resolve(v); };
      $('#askYes').onclick = () => done(checkLabel ? { checked: $('#askCheck').checked } : true);
      $('#askNo').onclick = () => done(false);
      d.onclose = () => resolve(false);
    });
  }

  async function withBusy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  }

  /* --- apps: menu (right click or ⋯), actions, log, console and settings */
  const APP_ACTS = {
    start: { noun: 'Start', done: 'Started' }, stop: { noun: 'Stop', done: 'Stopped' },
    restart: { noun: 'Restart', done: 'Restarted' }, update: { noun: 'Update', done: 'Updated' },
  };
  const appUrl = (a) => (isRunning(a) ? webuiUrl(a.webui) : null);
  const appPath = (a, suffix = '') => '/api/apps/' + encodeURIComponent(a.id) + suffix;

  function openAppUrl(a) {
    const url = appUrl(a); if (!url) return;
    if (api !== realApi) { toast(t('In the demo this opens {name} at {url}', { name: prettyName(a.name), url: url.replace(location.hostname || 'localhost', t('your server')) })); return; }
    window.open(url, '_blank', 'noopener');
  }

  const MENU_ICONS = {
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    start: '<path d="M7 5l12 7-12 7z"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    restart: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>', update: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    logs: '<path d="M6 4h9l4 4v12H6zM9 12h7M9 16h7M9 8h3"/>', updlog: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', console: '<path d="M4 5h16v14H4zM7 10l3 2-3 2M12 15h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    remove: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
    tofolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5"/>',
    outfolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9.5 13.5h5"/>',
  };
  const menu = $('#appMenu');
  let menuOpener = null;
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (refocus && menuOpener) menuOpener.focus();
    menuOpener = null;
  }
  function openAppMenu(a, x, y, opener) {
    const run = isRunning(a), busy = S.appBusy[a.id];
    const items = [
      appUrl(a) && ['open', t('Open')], '-',
      !run && ['start', t('Start')], run && ['restart', t('Restart')], run && ['stop', t('Stop'), 'danger'],
      a.canUpdate && !updating(a) && (a.update ? ['update', t('Update to the new version'), 'accent'] : ['update', t('Update')]),
      a.updateJob && ['updlog', updating(a) ? t('Update progress') : t('Update log')],
      !a.canUpdate && a.update && ['update', t('Updating only works for compose apps'), 'off'], '-',
      ['logs', t('Logs')], run && ['console', t('Console')], ['settings', t('Settings')], '-',
      ['tofolder', t('Move to folder…')], folderOf(a.name) && ['outfolder', t('Remove from folder')],
      (a.storeId || a.custom) && '-', (a.storeId || a.custom) && ['remove', t('Remove'), 'danger'],
    ].filter(Boolean).filter((it, i, arr) => it !== '-' || (i > 0 && arr[i - 1] !== '-' && i < arr.length - 1));
    menu.innerHTML = `<div class="menu-head"><b>${esc(prettyName(a.name))}</b><span>${esc(busy ? t(APP_ACTS[busy].noun) + '…' : a.status || a.state)}</span>
        ${a.update && !busy ? `<span class="menu-upd">${t('A new version is available')}</span>` : ''}</div>` +
      items.map((it) => (it === '-' ? '<hr>' : `<button type="button" role="menuitem" class="menu-item ${it[2] || ''}" data-menu="${it[0]}"
        ${(busy && APP_ACTS[it[0]]) || it[2] === 'off' ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${MENU_ICONS[it[0]]}</svg>${it[1]}</button>`)).join('');
    menu.dataset.forApp = a.id; // not data-app: the tiles' click handling reacts to that
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, y + r.height > innerHeight - 8 ? y - r.height : y) + 'px';
    menuOpener = opener || null;
    const first = $('.menu-item:not([disabled])', menu); if (first) first.focus();
  }
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-menu]'); if (!b) return;
    const a = S.apps.find((x) => x.id === menu.dataset.forApp);
    closeMenu(false);
    if (a) appCommand(a, b.dataset.menu);
  });
  menu.addEventListener('keydown', (e) => {
    const items = $$('.menu-item:not([disabled])', menu);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(false); }, true);
  window.addEventListener('resize', () => closeMenu(false));
  window.addEventListener('scroll', () => closeMenu(false), true);

  async function appCommand(a, act) {
    const label = prettyName(a.name);
    if (act === 'open') return openAppUrl(a);
    if (act === 'logs') return logWindow(a);
    if (act === 'update') return startAppUpdate(a);
    if (act === 'updlog') return updateLogWindow(a);
    if (act === 'console') return consoleWindow(a);
    if (act === 'settings') return appSettingsWindow(a);
    if (act === 'remove') return removeApp(a);
    if (act === 'tofolder') return folderPickWindow(a);
    if (act === 'outfolder') { takeOutOfFolder(a.name); return; }
    if (act === 'stop' && !(await ask(t('Stop {name}? Whatever runs on it will no longer be reachable.', { name: label }), t('Stop')))) return;
    S.appBusy[a.id] = act; renderApps();
    try { await api.post(appPath(a, '/' + act)); toast(t(APP_ACTS[act].done) + ': ' + label); }
    catch (e) { toast(t('{action} {name} failed: {error}', { action: t(APP_ACTS[act].noun), name: label, error: e.message }), true); }
    delete S.appBusy[a.id];
    await loadApps().catch(() => renderApps());
  }

  async function removeApp(a) {
    const label = prettyName(a.name);
    const r = await ask(t('Remove {name}? The app will be stopped and removed, together with its compose file.', { name: label }), t('Remove'),
      a.dataDirs.length ? t('Also delete the app\'s data ({dirs})', { dirs: a.dataDirs.join(', ') }) : null);
    if (!r) return;
    S.appBusy[a.id] = 'stop'; renderApps();
    try {
      const res = await api.del(appPath(a) + (r.checked ? '?data=1' : ''));
      toast(t('Removed: {name}', { name: label }) + (res.kept && res.kept.length ? '. ' + t('These folders were kept: {list}', { list: res.kept.join(', ') }) : ''));
      if (S.store) { const s = S.store.apps.find((x) => x.id === a.storeId); if (s) s.installed = false; }
    } catch (e) { toast(t('Removing {name} failed: {error}', { name: label, error: e.message }), true); }
    delete S.appBusy[a.id];
    await loadApps().catch(() => renderApps());
  }

  // Log: follow live while the window is open; only scroll along if you were at the bottom.
  function logWindow(a) {
    openWindow(prettyName(a.name) + ' · ' + t('logs'), `
      <div class="log-tools">
        <label class="check"><input type="checkbox" id="logFollow" checked> ${t('Follow live')}</label>
        <select class="field" id="logTail" aria-label="${t('Number of lines')}">${[100, 500, 2000].map((n) =>
          `<option value="${n}"${n === 500 ? ' selected' : ''}>${t('Last {n} lines', { n })}</option>`).join('')}</select>
        <button class="btn sm" type="button" id="logRefresh">${t('Refresh')}</button>
      </div>
      <pre class="logs logs-big" id="logs" tabindex="0">${t('Loading…')}</pre>`, (body) => {
      const pre = $('#logs', body);
      let timer = null;
      const load = async () => {
        const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        try {
          const lines = await api.get(appPath(a, '/logs?tail=' + $('#logTail', body).value));
          pre.innerHTML = lines.length ? lines.map((l) => {
            const ts = l.timestamp ? new Date(l.timestamp).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', ...clockOpts() }) : '';
            return (ts ? `<span class="ts">${esc(ts)}</span>  ` : '') + esc(l.message);
          }).join('\n') : t('No log lines yet.');
          if (atEnd) pre.scrollTop = pre.scrollHeight;
        } catch (e) { pre.textContent = t('The logs could not be loaded: {error}', { error: e.message }); }
      };
      const schedule = () => { clearTimeout(timer); if (body.isConnected && $('#logFollow', body).checked) timer = setTimeout(() => load().then(schedule), 3000); };
      load().then(() => { pre.scrollTop = pre.scrollHeight; schedule(); });
      $('#logFollow', body).addEventListener('change', schedule);
      $('#logTail', body).addEventListener('change', load);
      $('#logRefresh', body).addEventListener('click', load);
      onWinClose = () => clearTimeout(timer);
    });
  }

  // Console: each command runs separately with sh in the container. We remember cd ourselves.
  function consoleWindow(a) {
    let cwd = '/';
    const hist = []; let hi = 0;
    openWindow(prettyName(a.name) + ' · ' + t('console'), `
      <pre class="logs console-out" id="conOut" aria-live="polite"></pre>
      <form class="console-line" id="conForm">
        <label class="console-prompt" for="conIn" id="conPrompt">/ $</label>
        <input class="console-input" id="conIn" autocomplete="off" autocapitalize="off" spellcheck="false">
      </form>
      <p class="muted small">${t('Each command runs separately in the app. Programs that wait for your keyboard (such as top, vi or nano) do not work here. The up and down arrows bring back earlier commands. {clear} clears the screen.', { clear: '<code>clear</code>' })}</p>`, (body) => {
      const out = $('#conOut', body), input = $('#conIn', body), prompt = $('#conPrompt', body);
      const print = (html) => { out.insertAdjacentHTML('beforeend', html); out.scrollTop = out.scrollHeight; };
      print(`<span class="muted">${t('Connected to {name} ({image}).', { name: esc(prettyName(a.name)), image: esc(a.image) })}</span>\n`);
      input.focus();
      $('#conForm', body).addEventListener('submit', async (e) => {
        e.preventDefault();
        const cmd = input.value; if (!cmd.trim()) return;
        hist.push(cmd); hi = hist.length; input.value = '';
        if (cmd.trim() === 'clear') { out.innerHTML = ''; return; }
        print(`<span class="console-cmd">${esc(cwd)} $ ${esc(cmd)}</span>\n`);
        input.disabled = true;
        try {
          const r = await api.post(appPath(a, '/exec'), { cmd, cwd });
          if (r.output) print(esc(r.output) + '\n');
          if (r.exitCode) print(`<span class="console-err">[${t('exit code {code}', { code: r.exitCode })}]</span>\n`);
          cwd = r.cwd; prompt.textContent = cwd + ' $';
        } catch (ex) { print(`<span class="console-err">${esc(ex.message)}</span>\n`); }
        input.disabled = false; input.focus();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' && hi > 0) { e.preventDefault(); input.value = hist[--hi]; }
        else if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; }
        else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); out.innerHTML = ''; }
      });
    });
  }

  async function appSettingsWindow(a) {
    const label = prettyName(a.name);
    openWindow(label + ' · ' + t('settings'), `<p class="lead">${t('Loading…')}</p>`);
    let s;
    try { s = await api.get(appPath(a, '/settings')); }
    catch (e) { $('#winBody').innerHTML = `<p class="lead">${t('The settings could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    const ports = s.ports.length ? s.ports.map((p) => p.public + (p.public !== p.private ? ' → ' + p.private : '') + '/' + p.type.toLowerCase()).join(', ') : t('None');
    const c = s.compose;
    const body = $('#winBody');
    body.innerHTML = `
      <dl class="kv">
        <dt>${t('Status')}</dt><dd>${esc(a.status || a.state)}</dd>
        <dt>${t('Image')}</dt><dd>${esc(s.image)}</dd>
        <dt>${t('Version')}</dt><dd>${a.update ? `<span class="temp-warn">${t('A new version is available')}</span>` + (a.canUpdate ? ' · ' + t('choose Update in the menu') : '')
          : a.update === false ? t('Up to date') : esc(a.updateError ? t('Unknown: {reason}', { reason: tr(a.updateError) }) : t('Not checked yet'))}
          ${a.updateChecked ? `<span class="muted small"> · ${t('checked {when}', { when: esc(new Date(a.updateChecked).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...clockOpts() })) })}</span>` : ''}</dd>
        <dt>${t('Ports')}</dt><dd>${esc(ports)}</dd>
        ${c ? `<dt>${t('Compose project')}</dt><dd>${esc(c.project)}</dd>` : ''}
      </dl>
      <form class="form" id="appSetForm" novalidate style="margin-top:16px">
        <label class="fld"><span>${t('Web interface address (WebUI)')}</span>
          <input class="field" name="webui" value="${esc(s.webui)}" placeholder="${esc(s.webuiDefault || s.webuiAuto || 'http://[IP]:[PORT:8080]/')}" autocomplete="off" spellcheck="false">
          <small>${t('This opens when you click the app. {ip} becomes the address of your server, {port} the port on the server that is mapped to port 80 in the app.', { ip: '<code>[IP]</code>', port: '<code>[PORT:80]</code>' })}
            ${t('Leave empty = automatic ({value}).', { value: esc(s.webuiDefault || s.webuiAuto || t('none')) })}</small></label>
        <label class="fld"><span>${t('Icon')}</span>
          <input class="field" name="icon" value="${esc(s.icon)}" placeholder="${esc(s.iconDefault || 'https://…/logo.png')}" autocomplete="off" spellcheck="false">
          <small>${t('Address of an image. Leave empty = automatic.')}</small></label>
        <label class="check"><input type="checkbox" name="autoStart"${s.autoStart ? ' checked' : ''}> ${t('Start automatically when the server starts')}</label>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Save')}</button><button class="btn" type="button" data-close>${t('Close')}</button></div>
      </form>
      <h3>${t('Container')}</h3>
      ${!c ? `<p class="muted small">${t('This app was not started with Docker Compose. You change ports, folders and variables by recreating the container, e.g. from the app store.')}</p>`
        : !c.editable ? `<p class="muted small">${c.files.length > 1 ? t('This project uses several files ({files}). Edit them there yourself.', { files: esc(c.files.join(', ')) })
          : t('This project uses a file HomeBaseOS cannot read. Edit it there yourself.')}</p>`
        : `<p class="muted small">${esc(c.file)}${c.project !== a.name ? ' · ' + t('project {name}', { name: esc(c.project) }) : ''}</p>
          <div id="cfForm"${c.form ? '' : ' hidden'}></div>
          <div id="cfText"${c.form ? ' hidden' : ''}>
            ${c.form ? '' : `<p class="lead">${t('The form is not available for this file. You can still edit it as text.')}${c.formError ? ' (' + esc(tr(c.formError)) + ')' : ''}</p>`}
            <textarea class="field code" id="composeText" rows="18" spellcheck="false" aria-label="${t('Compose file')}">${esc(c.text)}</textarea>
          </div>
          <p class="form-error" id="composeErr" role="alert"></p>
          <div class="btn-row">
            <button class="btn primary" type="button" id="composeSave">${t('Save and restart')}</button>
            ${c.form ? `<button class="btn" type="button" id="cfToggle">${t('Code')}</button>` : ''}
          </div>`}`;
    const form = $('#appSetForm', body);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form), btn = $('[type=submit]', form);
      err.textContent = ''; btn.disabled = true;
      try {
        await api.post(appPath(a, '/settings'), { webui: form.elements.webui.value, icon: form.elements.icon.value, autoStart: form.elements.autoStart.checked });
        toast(t('Saved: {name}', { name: label }));
        await loadApps().catch(() => {});
      } catch (ex) { err.textContent = t('Saving failed: {error}', { error: ex.message }); }
      btn.disabled = false;
    });
    if (!c || !c.editable) return;

    // Form (like Unraid's container form) or text.
    const model = c.form ? JSON.parse(JSON.stringify(c.form)) : null;
    let mode = c.form ? 'form' : 'text';
    if (model) composeFormMount($('#cfForm', body), model, c.dockerNetworks || []);
    const toggle = $('#cfToggle', body);
    if (toggle) toggle.addEventListener('click', () => {
      mode = mode === 'form' ? 'text' : 'form';
      $('#cfForm', body).hidden = mode !== 'form'; $('#cfText', body).hidden = mode !== 'text';
      toggle.textContent = t(mode === 'form' ? 'Code' : 'Fields');
      if (mode === 'form') toast(t('The form shows the saved version. Save changes to the text in text mode.'));
    });
    const save = $('#composeSave', body);
    save.addEventListener('click', async () => {
      const err = $('#composeErr', body); err.textContent = '';
      if (mode === 'form') { const problem = composeFormCheck(model); if (problem) { err.textContent = problem; return; } }
      const who = c.project !== a.name ? t('the project {name}', { name: c.project }) : label;
      const note = mode === 'form' ? ' ' + t('Comments (#) in the file will disappear; the previous version is kept as .bak.') : '';
      if (!(await ask(t('Save the compose file and restart {who}?', { who }) + note, t('Save and start')))) return;
      save.disabled = true; save.textContent = t('Working…');
      try {
        const r = mode === 'form'
          ? await api.post(appPath(a, '/compose-form'), { form: model })
          : await api.post(appPath(a, '/compose'), { text: $('#composeText', body).value });
        toast(t('Saved and restarted. The previous version is in {file}.', { file: r.backup }));
        await loadApps().catch(() => {});
        const fresh = S.apps.find((x) => x.name === a.name) || a;
        return appSettingsWindow(fresh); // load again: that way you see what is really in the file
      } catch (ex) { err.textContent = ex.message; }
      save.disabled = false; save.textContent = t('Save and restart');
    });
  }

  /* --- compose form: rows for ports, folders, variables, devices and labels */
  const CF_KINDS = [
    ['ports', 'Ports', 'Port', { host: '', container: '', protocol: 'tcp' }],
    ['volumes', 'Folders', 'Folder', { host: '', container: '', mode: 'rw' }],
    ['env', 'Variables', 'Variable', { name: '', value: '' }],
    ['devices', 'Devices', 'Device', { host: '', container: '' }],
    ['labels', 'Labels', 'Label', { name: '', value: '' }],
  ];
  const SECRET = /pass|secret|token|key|pwd/i;
  function cfRow(kind, r, i) {
    const del = `<button class="cf-del" type="button" data-cf-del="${kind}:${i}" aria-label="${t('Remove')}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    const inp = (k, ph, extra = '') => `<input class="field" data-cf="${kind}:${i}:${k}" value="${esc(r[k] == null ? '' : r[k])}" placeholder="${ph}" autocomplete="off" spellcheck="false"${extra}>`;
    if (r.locked) {
      const what = kind === 'ports' ? (r.host || '?') + ' → ' + r.container + '/' + r.protocol : (r.host || r.kind || '') + ' → ' + r.container;
      return `<div class="cf-row cf-locked"><span class="cf-lock" title="${t('Advanced setting: change it in text mode')}">🔒</span>
        <span class="cf-text">${esc(what)} <span class="muted">· ${t('advanced, text mode only')}</span></span>${del}</div>`;
    }
    if (kind === 'ports') return `<div class="cf-row cf-pair">${inp('host', t('on the server'), ` inputmode="numeric" aria-label="${t('Port on the server')}"`)}<span class="cf-sep">→</span>
      ${inp('container', t('in the app'), ` inputmode="numeric" aria-label="${t('Port in the app')}"`)}
      <select class="field cf-small" data-cf="${kind}:${i}:protocol" aria-label="Protocol"><option${r.protocol !== 'udp' ? ' selected' : ''}>tcp</option><option${r.protocol === 'udp' ? ' selected' : ''}>udp</option></select>${del}</div>`;
    if (kind === 'volumes') return `<div class="cf-row cf-pair">${inp('host', t('folder on the server, e.g. /tank/media'), ` aria-label="${t('Folder on the server')}"`)}<span class="cf-sep">→</span>
      ${inp('container', t('folder in the app, e.g. /media'), ` aria-label="${t('Folder in the app')}"`)}
      <select class="field cf-small" data-cf="${kind}:${i}:mode" aria-label="${t('Access')}"><option value="rw"${r.mode !== 'ro' ? ' selected' : ''}>${t('read and write')}</option><option value="ro"${r.mode === 'ro' ? ' selected' : ''}>${t('read only')}</option></select>${del}</div>`;
    if (kind === 'devices') return `<div class="cf-row cf-pair">${inp('host', t('on the server, e.g. /dev/dri'), ` aria-label="${t('Device on the server')}"`)}<span class="cf-sep">→</span>
      ${inp('container', t('in the app (empty = the same)'), ` aria-label="${t('Device in the app')}"`)}<span></span>${del}</div>`;
    const secret = kind === 'env' && SECRET.test(r.name);
    return `<div class="cf-row cf-kv">${inp('name', kind === 'env' ? t('NAME') : t('name'), ` aria-label="${t('Name')}"`)}<span class="cf-sep">=</span>
      ${inp('value', t(r.unset ? '(passed on from the server)' : 'value'), ` aria-label="${t('Value')}"${secret ? ' type="password"' : ''}`)}${del}</div>`;
  }
  // Network choices: default, host, none, the networks from the compose file and the other Docker networks.
  function netChoices(f, dockerNets) {
    const out = [{ value: '', label: t('Default (bridge)') }, { value: 'host', label: t('Host (the server\'s network)') }, { value: 'none', label: t('None') }];
    if (f.network === '*') out.unshift({ value: '*', label: t('Custom networks ({list})', { list: f.networks.join(', ') }) });
    const pn = f.projectNetworks || [];
    pn.filter((x) => !x.external).forEach((x) => out.push({ value: x.key, label: t('{name} (from this compose file)', { name: x.key }) }));
    if (!dockerNets.some(ownNet)) out.push({ value: LAN_CHOICE, label: t('Own address in my home network') });
    dockerNets.filter((n) => !pn.some((x) => !x.external && x.name === n.name)).forEach((n) =>
      out.push({ value: n.name, label: netLabel(n) }));
    if (f.network && !out.some((o) => o.value === f.network)) out.push({ value: f.network, label: f.network });
    return out;
  }
  function composeFormMount(el, f, dockerNets = []) {
    const draw = (focus) => {
      el.innerHTML = `
        <div class="form">
          <label class="fld"><span>${t('Image')}</span><input class="field" data-cf-top="image" value="${esc(f.image)}" placeholder="${t('e.g. lscr.io/linuxserver/jellyfin:latest')}" spellcheck="false">
            <small>${t('Want a fixed version? Put it after the colon, e.g. :10.10.7 instead of :latest.')}</small></label>
          <div class="fld-row">
            <label class="fld"><span>${t('Restart')}</span><select class="field" data-cf-top="restart">
              ${[['unless-stopped', 'Always, unless I stop it'], ['always', 'Always'], ['on-failure', 'Only after a failure'], ['no', 'Never'], ['', 'Not set']]
                .map(([v, label]) => `<option value="${v}"${f.restart === v ? ' selected' : ''}>${t(label)}</option>`).join('')}</select></label>
            <label class="fld"><span>${t('Network')}</span><select class="field" data-cf-top="network"${f.networkOther ? ' disabled' : ''}>
              ${netChoices(f, dockerNets).map((o) => `<option value="${esc(o.value)}"${f.network === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
              ${f.networkOther ? `<small>${t('Uses {name}. Change that in text mode.', { name: esc(f.networkOther) })}</small>` : ''}</label>
          </div>
          ${f.networkOther ? '' : `<p class="muted small" style="margin-top:-6px">${t('Create new networks in Settings → Docker networks.')}</p>`}
          ${f.network === 'host' ? `<p class="lead small">${t('With the host network the app listens directly on its own ports and Docker ignores the ports below. Another port only works through the app\'s own port setting, e.g. a variable like WEBUI_PORT; then set the same port below, so the WebUI follows.')}</p>` : ''}
          ${['host', 'none', '*'].includes(f.network) || f.networkOther ? '' : (() => {
            const n = dockerNets.find((x) => x.name === f.network), ownIp = f.network === LAN_CHOICE || ownNet(n);
            return `<label class="fld"><span>${t('Fixed IP address (optional)')}</span><input class="field" data-cf-top="ip" value="${esc(f.ip || '')}" spellcheck="false" autocomplete="off"
              placeholder="${esc(n && n.subnet ? n.subnet.replace(/\.\d+\/\d+$/, '.200') : f.network === '' ? '172.30.0.10' : '')}">
              <small>${ownIp ? t('The app\'s address in your home network. Empty = Docker picks one from the network\'s IP range.')
                : f.network === '' ? t('Empty = Docker picks an address. With an address the app joins the HomeBaseOS network homebase (172.30.0.0/16), where apps also find each other by name.')
                : t('Empty = Docker picks an address. A fixed address only works in a network with its own subnet.')}</small></label>`;
          })()}
          <label class="check"><input type="checkbox" data-cf-top="privileged"${f.privileged ? ' checked' : ''}> ${t('Privileged (almost full access to the server, only if the app really needs it)')}</label>
          ${f.otherServices.length ? `<p class="muted small">${t('This file also contains: {list}. Those stay unchanged.', { list: esc(f.otherServices.join(', ')) })}</p>` : ''}
        </div>
        ${CF_KINDS.map(([kind, title]) => (f[kind].length ? `<h3>${t(title)}</h3><div class="cf-list">${f[kind].map((r, i) => cfRow(kind, r, i)).join('')}</div>` : '')).join('')}
        <div class="cf-add"><span class="muted small">${t('Add:')}</span>
          ${CF_KINDS.map(([kind, , one]) => `<button class="btn sm" type="button" data-cf-add="${kind}">+ ${t(one)}</button>`).join('')}</div>`;
      if (focus) { const x = $(`[data-cf^="${focus}:"]`, el); if (x) x.focus(); }
      // Own address in the home network: suggest a free one.
      const ipIn = $('[data-cf-top="ip"]', el);
      if (ipIn && (f.network === LAN_CHOICE || ownNet(dockerNets.find((x) => x.name === f.network)))) suggestLanIp(ipIn, ipIn.parentElement.querySelector('small'));
    };
    draw();
    el.addEventListener('input', (e) => {
      const tg = e.target;
      if (tg.dataset.cfTop) {
        f[tg.dataset.cfTop] = tg.type === 'checkbox' ? tg.checked : tg.value;
        if (tg.dataset.cfTop === 'network') { if (['host', 'none'].includes(f.network)) f.ip = ''; draw(); }
        return;
      }
      if (!tg.dataset.cf) return;
      const [kind, i, k] = tg.dataset.cf.split(':');
      f[kind][i][k] = tg.value;
      if (k === 'value') delete f[kind][i].unset;
    });
    el.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') e.target.dispatchEvent(new Event('input', { bubbles: true })); });
    el.addEventListener('click', (e) => {
      const add = e.target.closest('[data-cf-add]');
      if (add) {
        const kind = add.dataset.cfAdd, def = CF_KINDS.find((k) => k[0] === kind)[3];
        f[kind].push({ ...def }); draw(kind + ':' + (f[kind].length - 1));
        return;
      }
      const del = e.target.closest('[data-cf-del]');
      if (del) { const [kind, i] = del.dataset.cfDel.split(':'); f[kind].splice(Number(i), 1); draw(); }
    });
  }
  // Quick check in the browser; the server checks everything again.
  function composeFormCheck(f) {
    if (!f.image.trim() && !f.build) return t('Fill in the image.');
    if (f.ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(f.ip).trim())) return t('The fixed IP address is not a valid address, e.g. 192.168.1.200.');
    for (const p of f.ports) if (!p.locked && !/^\d{1,5}(-\d{1,5})?$/.test(String(p.container).trim())) return t('Fill in the port in the app for every port (a number).');
    for (const v of f.volumes) if (!v.locked && (!String(v.host).trim() || !String(v.container).trim().startsWith('/'))) return t('Fill in both sides for every folder; the folder in the app starts with /.');
    for (const d of f.devices) if (!/^\/dev\//.test(String(d.host).trim())) return t('A device starts with /dev/, e.g. /dev/dri.');
    for (const e of f.env) if (String(e.value).trim() && !String(e.name).trim()) return t('A variable needs a name.');
    return null;
  }

  /* --- storage */
  function scrubText(sc) {
    if (!sc || !sc.kind) return t('No check (scrub) done yet');
    if (sc.running) return t(sc.kind === 'resilver' ? 'Repair in progress: {pct}%' : 'Check (scrub) in progress: {pct}%', { pct: nf0.format(sc.progress || 0) });
    const when = sc.last ? new Date(sc.last).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    return sc.errors ? t('Last check {when}: {n} errors found', { when, n: sc.errors }) : t('Last check {when}: no errors', { when });
  }
  /* --- disk bays: which disk is in which bay (drag, or tap and then tap a bay) */
  function bayState(d) {
    if (!d) return 'missing';
    const sec = d.sectors || {};
    if ((d.state && d.state !== 'ONLINE') || d.errors || d.smartOk === false || sec.pending > 0 || sec.uncorrectable > 0) return 'bad';
    if ((d.temp != null && d.temp >= 50) || sec.reallocated > 0) return 'warn';
    return d.pool ? 'ok' : 'idle';
  }
  const diskLabel = (d) => [d.model || d.name, d.serial].filter(Boolean).join(' · ');
  function mountBays(el, s) {
    let cfg = JSON.parse(JSON.stringify(s.bays || { count: 0, columns: 12, m2: 0, ssd: 0, slots: {} }));
    if (cfg.m2 == null) cfg.m2 = 0;
    if (cfg.ssd == null) cfg.ssd = 0;
    // A place is a bay ("3"), an M.2 slot ("m1") or a 2.5" slot ("s1"), all in cfg.slots.
    const slotName = (id) => { const k = String(id)[0], n = String(id).replace(/^[ms]/, '');
      return k === 'm' ? t('M.2 slot {n}', { n }) : k === 's' ? t('2.5" slot {n}', { n }) : t('bay {n}', { n }); };
    let edit = false, picked = null, saveTimer = null;
    const byKey = new Map(s.disks.map((d) => [d.key, d]));
    const bayOf = (key) => Object.keys(cfg.slots).find((b) => cfg.slots[b].key === key);
    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try { cfg = await api.post('/api/bays', cfg); s.bays = cfg; }
        catch (e) { toast(t('Saving the layout failed: {error}', { error: e.message }), true); }
      }, 300);
    };
    const place = (key, bay) => {
      const from = bayOf(key), occupant = cfg.slots[bay];
      if (from === String(bay)) return;
      if (from) { if (occupant) cfg.slots[from] = occupant; else delete cfg.slots[from]; } // swap with the disk that was already there
      const d = byKey.get(key);
      cfg.slots[bay] = { key, label: d ? diskLabel(d) : (occupant && occupant.key === key ? occupant.label : '') };
      picked = null; save(); draw();
    };
    const unplace = (key) => { const b = bayOf(key); if (b) { delete cfg.slots[b]; save(); } picked = null; draw(); };

    // Chosen disk (click on a bay): details from smartctl in the panel next to the case.
    let sel = null; // { key, name, info, loading, error }
    const hoursText = (h) => (h == null ? '–' : h >= 8766 ? t('{years} years ({hours} hours)', { years: nf.format(h / 8766), hours: nf0.format(h) })
      : h >= 48 ? t('{days} days ({hours} hours)', { days: nf0.format(h / 24), hours: nf0.format(h) }) : t('{hours} hours', { hours: nf0.format(h) }));
    const WATCH = [
      ['reallocated', 'Reallocated sectors', 'Spots the disk had to replace. If this keeps rising, replace the disk.', 'warn'],
      ['pending', 'Pending sectors', 'Spots that could not be read. A bad sign.', 'bad'],
      ['uncorrectable', 'Uncorrectable sectors', 'Data the disk could not recover. ZFS covers this with the other disks.', 'bad'],
      ['reportedUncorrect', 'Reported read errors', 'Read errors the disk reported itself.', 'warn'],
      ['crcErrors', 'CRC errors (cable)', 'Usually a bad SATA cable or connection, not the disk.', 'warn'],
      ['mediaErrors', 'Media errors', 'Errors in the SSD\'s memory.', 'bad'],
    ];
    const panelBox = () => $('#diskPanel', el);
    function renderPanel() {
      const box = panelBox(); if (!box) return;
      box.hidden = !sel;
      const hint = $('#bayHint', el); if (hint) hint.hidden = !!sel;
      if (!sel) { box.innerHTML = ''; return; }
      const d = byKey.get(sel.key), bayNo = bayOf(sel.key);
      if (!d) {
        const slot = cfg.slots[bayNo];
        box.innerHTML = `<h4>${esc(slotName(bayNo))}: ${t('disk missing')}</h4><p class="small">${esc(slot ? slot.label : '')}</p>
          <p class="small muted">${t('This disk was in this bay, but the server can no longer find it. Is it broken or unplugged? Put in a new one and drag it to this bay.')}</p>`;
        return;
      }
      const head = `<div class="dp-head"><div><h4>${esc(d.name)}${bayNo ? ` <span class="muted">· ${esc(slotName(bayNo))}</span>` : ''}</h4>
          <p class="small muted">${esc([sel.info && sel.info.family, (sel.info && sel.info.model) || d.model].filter(Boolean).join(' · '))}</p></div>
          <button class="cf-del" type="button" data-dp-close aria-label="${t('Close')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
      if (sel.loading) { box.innerHTML = head + `<p class="muted small">${t('Reading SMART…')}</p>`; return; }
      if (sel.error) { box.innerHTML = head + `<p class="small temp-bad">${esc(sel.error)}</p><button class="btn sm" type="button" data-dp-retry>${t('Try again')}</button>`; return; }
      const i = sel.info;
      if (i.sleeping) {
        box.innerHTML = head + `<p class="small">${t('The disk is asleep to save power. Reading it wakes it up; afterwards it goes back to sleep by itself.')}</p>
          <button class="btn sm" type="button" data-dp-wake>${t('Read anyway')}</button>`;
        return;
      }
      const kind = d.transport === 'nvme' ? 'NVMe' : !d.rotational ? 'SSD' : i.rpm ? t('HDD, {rpm} rpm', { rpm: i.rpm }) : 'HDD';
      const tc = i.temp == null ? '' : i.temp >= 50 ? 'temp-bad' : i.temp >= 45 ? 'temp-warn' : 'temp-ok';
      const watch = WATCH.filter(([k]) => i.watch[k] != null && (i.watch[k] > 0 || ['reallocated', 'pending', 'uncorrectable', 'crcErrors', 'mediaErrors'].includes(k)))
        .map(([k, label, help, lvl]) => `<li title="${esc(t(help))}"><span>${t(label)}</span><b class="${i.watch[k] > 0 ? 'temp-' + lvl : 'temp-ok'}">${nf0.format(i.watch[k])}</b></li>`).join('');
      const nv = i.nvme;
      const nvRows = nv ? [
        [t('Wear'), nv.percentUsed != null ? nv.percentUsed + '%' : '–', nv.percentUsed >= 100 ? 'temp-bad' : nv.percentUsed >= 80 ? 'temp-warn' : 'temp-ok'],
        [t('Spare'), nv.spare != null ? nv.spare + '%' : '–', nv.spare != null && nv.spareThreshold != null && nv.spare <= nv.spareThreshold ? 'temp-bad' : 'temp-ok'],
        [t('Written'), nv.written != null ? bytes(nv.written) : '–', ''],
        [t('Unsafe shutdowns'), nv.unsafeShutdowns != null ? nf0.format(nv.unsafeShutdowns) + '×' : '–', ''],
      ].map(([k, v, c]) => `<li><span>${k}</span><b class="${c}">${esc(v)}</b></li>`).join('') : '';
      const RES = { ok: 'passed', failed: 'failed', aborted: 'aborted', interrupted: 'interrupted', fatal: 'error', running: 'in progress', unknown: 'unknown' };
      const running = i.testRunning;
      box.innerHTML = head + `
        <div class="dp-badges">
          <span class="pill ${i.smartOk === false ? 'bad' : i.smartOk ? 'ok' : ''}">${i.smartOk === false ? t('SMART: problem') : i.smartOk ? t('SMART: OK') : t('SMART: unknown')}</span>
          ${i.temp != null ? `<span class="pill ${tc.replace('temp-', '')}">${i.temp} °C</span>` : ''}
          ${d.pool ? `<span class="pill">${esc(d.pool)}${d.role && d.role !== 'data' ? ' · ' + esc(d.role) : ''}${d.state && d.state !== 'ONLINE' ? ' · ' + esc(d.state.toLowerCase()) : ''}</span>` : ''}
        </div>
        <dl class="kv dp-kv">
          <dt>${t('On')}</dt><dd>${esc(hoursText(i.powerOnHours))}</dd>
          <dt>${t('Power cycles')}</dt><dd>${i.powerCycles != null ? nf0.format(i.powerCycles) : '–'}</dd>
          <dt>${t('Size')}</dt><dd>${bytes(i.size || d.size)}</dd>
          <dt>${t('Type')}</dt><dd>${esc([kind, i.formFactor].filter(Boolean).join(' · '))}</dd>
          ${i.link ? `<dt>${t('Interface')}</dt><dd>${esc(i.link)}</dd>` : ''}
          <dt>${t('Serial number')}</dt><dd><code>${esc(i.serial || d.serial || '–')}</code></dd>
          ${i.firmware ? `<dt>${t('Firmware')}</dt><dd>${esc(i.firmware)}</dd>` : ''}
          ${d.pool ? `<dt>${t('ZFS errors')}</dt><dd class="${d.errors ? 'temp-bad' : ''}">${nf0.format(d.errors || 0)}</dd>` : ''}
          ${i.errorLog ? `<dt>${t('Error log')}</dt><dd class="temp-warn">${t('{n} errors reported', { n: i.errorLog })}</dd>` : ''}
        </dl>
        ${watch || nvRows ? `<h4 class="dp-sub">${t('Health')}</h4><ul class="dp-watch">${nvRows}${watch}</ul>` : ''}
        <h4 class="dp-sub">${t('Self-test')}</h4>
        ${running ? `<p class="small">${running.remaining != null ? t('Test running: {n}% to go.', { n: running.remaining }) : t('A test is running.')}</p>` : ''}
        ${i.tests.length ? `<ul class="dp-tests">${i.tests.slice(0, 3).map((x) => `<li><span>${esc(x.type)}</span>
            <b class="${x.result === 'ok' ? 'temp-ok' : x.result === 'running' ? '' : 'temp-bad'}">${t(RES[x.result] || x.result)}</b>
            <span class="muted">${x.hours != null ? t('at {hours} hours', { hours: nf0.format(x.hours) }) : ''}</span></li>`).join('')}</ul>`
          : `<p class="small muted">${t('No self-test done yet.')}</p>`}
        <div class="btn-row" style="margin-top:8px">
          <button class="btn sm" type="button" data-dp-test="short"${running ? ' disabled' : ''}>${t('Short test')}${i.testMinutes && i.testMinutes.short ? ' (' + t('{n} min', { n: i.testMinutes.short }) + ')' : ''}</button>
          <button class="btn sm" type="button" data-dp-test="long"${running ? ' disabled' : ''}>${t('Long test')}${i.testMinutes && i.testMinutes.long ? ' (' + t('{n} min', { n: i.testMinutes.long }) + ')' : ''}</button>
        </div>
        <p class="small muted" style="margin-top:6px">${t('A test checks the disk while it keeps working normally. The long test takes hours.')}</p>
        ${i.attributes.length ? `<details class="adv dp-attrs"><summary>${t('All SMART values ({n})', { n: i.attributes.length })}</summary>
          <table class="attr-table"><thead><tr><th>ID</th><th>${t('Name')}</th><th>${t('Value')}</th><th>${t('Threshold')}</th><th>Raw</th></tr></thead><tbody>
          ${i.attributes.map((a) => `<tr class="${a.failing ? 'temp-bad' : ''}"><td>${a.id}</td><td>${esc(a.name)}</td><td>${a.value}</td><td>${a.thresh}</td><td>${esc(a.raw)}</td></tr>`).join('')}
          </tbody></table></details>` : ''}`;
    }
    let testTimer = null;
    async function loadDisk(wake = false, quiet = false) {
      clearTimeout(testTimer);
      const d = byKey.get(sel.key); if (!d) { renderPanel(); return; }
      const key = sel.key;
      if (!quiet) { sel.loading = true; sel.error = null; renderPanel(); }
      try { const info = await api.get('/api/disks/' + encodeURIComponent(d.name) + (wake ? '?wake=1' : '')); if (sel && sel.key === key) { sel.info = info; sel.loading = false; } }
      catch (e) { if (sel && sel.key === key) { sel.error = e.message; sel.loading = false; } }
      renderPanel();
      // If a test is running, refresh every 10 s while the window is open.
      if (sel && sel.key === key && sel.info && sel.info.testRunning) testTimer = setTimeout(() => { if (el.isConnected && sel && sel.key === key) loadDisk(false, true); }, 10000);
    }
    // Clicking the same disk again: panel closed and nothing selected anymore.
    function selectDisk(key) {
      clearTimeout(testTimer);
      sel = sel && sel.key === key ? null : { key, info: null, loading: false, error: null };
      $$('[data-bay]', el).forEach((b) => { if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', String(!!(sel && cfg.slots[b.dataset.bay] && cfg.slots[b.dataset.bay].key === sel.key))); });
      if (sel) loadDisk(); else renderPanel();
    }

    // Labels on a drawer: the pool (each pool its own colour, with the role if it isn't a plain data disk) and the temperature.
    const poolNames = (s.pools || []).map((p) => p.name);
    const tags = (d) => {
      const pool = d.pool ? `<span class="tag pool p${(poolNames.indexOf(d.pool) % 5) + 1}">${esc(d.pool)}${d.role && d.role !== 'data' ? ' · ' + esc(d.role) : ''}</span>`
        : `<span class="tag">${t('No pool')}</span>`;
      const tc = d.temp == null ? 'sleep' : d.temp >= 50 ? 'bad' : d.temp >= 45 ? 'warn' : 'ok';
      return pool + `<span class="tag temp ${tc}">${d.temp != null ? d.temp + ' °C' : t('Standby')}</span>`;
    };
    async function runTest(type, btn) {
      const d = sel && byKey.get(sel.key); if (!d) return;
      btn.disabled = true;
      try {
        const r = await api.post('/api/disks/' + encodeURIComponent(d.name) + '/test', { type });
        toast(t(type === 'short' ? 'Short test started on {disk}.' : 'Long test started on {disk}.', { disk: d.name }) + (r.minutes ? ' ' + t('Done in about {n} minutes.', { n: r.minutes }) : ''));
        loadDisk();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    }
    const kindOf = (d) => (d.transport === 'nvme' ? 'NVMe' : d.rotational ? 'HDD' : 'SSD');
    const bayCard = (n) => {
      const slot = cfg.slots[n], d = slot && byKey.get(slot.key), st = slot ? bayState(d) : 'vacant';
      const title = !slot ? t('Bay {n}: empty', { n }) : d ? t('Bay {n}: {disk}', { n, disk: d.name }) : t('Bay {n}: disk missing', { n });
      const head = `<span class="tray-top"><span class="bay-no">${n}</span><span class="tray-leds" aria-hidden="true"><i class="led"></i></span></span>`;
      return `<button type="button" class="bay ${st}${slot && picked === slot.key ? ' picked' : ''}" data-bay="${n}"
          ${edit && slot ? `draggable="true" data-key="${esc(slot.key)}"` : ''} aria-label="${esc(title)}"${edit ? '' : slot ? ` aria-pressed="${!!(sel && sel.key === slot.key)}"` : ' tabindex="-1"'}>
        ${!slot ? `<span class="slot-hole">${head}<span class="bay-empty">${edit ? t('Drop a disk here') : t('Empty')}</span></span>`
          : `<span class="tray">${head}<span class="tray-vents" aria-hidden="true"></span>
            ${d ? `<span class="tray-info"><b class="bay-name">${esc(d.name)}</b>
                <span class="bay-sub" title="${esc(diskLabel(d))}">${esc(d.model || '')}</span>
                <span class="bay-sub">${esc(bytes(d.size))}</span><span class="bay-sub">${esc(kindOf(d))}</span></span>
              <span class="tray-tags">${tags(d)}</span>`
            : `<span class="tray-info"><b class="bay-name">${t('Disk missing')}</b><span class="bay-sub" title="${esc(slot.label)}">${esc(slot.label)}</span></span>`}
            <span class="tray-handle" aria-hidden="true"></span></span>`}
      </button>`;
    };
    // M.2 slot: a horizontal circuit board with chips and a gold-coloured connector.
    const m2Card = (n) => {
      const id = 'm' + n, slot = cfg.slots[id], d = slot && byKey.get(slot.key), st = slot ? bayState(d) : 'vacant';
      const title = !slot ? t('M.2 slot {n}: empty', { n }) : d ? t('M.2 slot {n}: {disk}', { n, disk: d.name }) : t('M.2 slot {n}: disk missing', { n });
      return `<button type="button" class="m2 ${st}${slot && picked === slot.key ? ' picked' : ''}" data-bay="${id}"
          ${edit && slot ? `draggable="true" data-key="${esc(slot.key)}"` : ''} aria-label="${esc(title)}"${edit ? '' : slot ? ` aria-pressed="${!!(sel && sel.key === slot.key)}"` : ' tabindex="-1"'}>
        <span class="m2-label">M.2 ${n}</span>
        ${!slot ? `<span class="m2-empty">${edit ? t('Drop an NVMe here') : t('Empty')}</span>`
          : `<span class="m2-stick"><span class="m2-gold" aria-hidden="true"></span><span class="m2-chip" aria-hidden="true"></span>
            <span class="m2-info"><b class="bay-name">${d ? esc(d.name) : t('Disk missing')}</b>
              <span class="bay-sub" title="${esc(d ? diskLabel(d) : slot.label)}">${esc(d ? [d.model, bytes(d.size)].filter(Boolean).join(' · ') : slot.label)}</span></span>
            ${d ? `<span class="m2-tags">${tags(d)}</span>` : ''}
            <span class="tray-leds" aria-hidden="true"><i class="led"></i></span><span class="m2-notch" aria-hidden="true"></span></span>`}
      </button>`;
    };
    // 2.5" slot: a horizontal, narrow drawer (like the hot-swap slots for SSDs).
    const ssdCard = (n) => {
      const id = 's' + n, slot = cfg.slots[id], d = slot && byKey.get(slot.key), st = slot ? bayState(d) : 'vacant';
      const title = !slot ? t('2.5" slot {n}: empty', { n }) : d ? t('2.5" slot {n}: {disk}', { n, disk: d.name }) : t('2.5" slot {n}: disk missing', { n });
      return `<button type="button" class="sff ${st}${slot && picked === slot.key ? ' picked' : ''}" data-bay="${id}"
          ${edit && slot ? `draggable="true" data-key="${esc(slot.key)}"` : ''} aria-label="${esc(title)}"${edit ? '' : slot ? ` aria-pressed="${!!(sel && sel.key === slot.key)}"` : ' tabindex="-1"'}>
        ${!slot ? `<span class="sff-hole"><span class="sff-no">${n}</span><span class="sff-empty">${edit ? t('Drop an SSD here') : t('Empty')}</span></span>`
          : `<span class="sff-tray"><span class="sff-no">${n}</span><span class="sff-vents" aria-hidden="true"></span>
            <span class="sff-info"><b class="bay-name">${d ? esc(d.name) : t('Disk missing')}</b>
              <span class="bay-sub" title="${esc(d ? diskLabel(d) : slot.label)}">${esc(d ? bytes(d.size) : slot.label)}</span></span>
            ${d ? `<span class="sff-tags">${tags(d)}</span>` : ''}
            <span class="tray-leds" aria-hidden="true"><i class="led"></i></span><span class="sff-handle" aria-hidden="true"></span></span>`}
      </button>`;
    };
    const draw = () => {
      const unplaced = s.disks.filter((d) => !bayOf(d.key));
      if (!cfg.count && !edit) {
        el.innerHTML = `<h3>${t('Drive bays')}</h3>
          <p class="muted small">${t('Give your case its number of bays and drag your disks to the right place. That way you see right away which disk to replace.')}</p>
          <div class="btn-row" style="margin-top:10px"><button class="btn sm" type="button" data-bay-edit>${t('Set up bays')}</button></div>`;
        return;
      }
      el.innerHTML = `
        <div class="bays-head"><h3>${t('Drive bays')}</h3>
          <button class="btn sm${edit ? ' primary' : ''}" type="button" data-bay-edit>${edit ? t('Ready') : t('Edit layout')}</button></div>
        ${edit ? `<div class="bays-cfg">
            <label class="fld"><span>${t('Number of bays')}</span><input class="field" type="number" min="1" max="60" step="1" data-bay-cfg="count" value="${cfg.count}"></label>
            <label class="fld"><span>${t('Bays per row')}</span><input class="field" type="number" min="1" max="12" step="1" data-bay-cfg="columns" value="${cfg.columns}"></label>
            <label class="fld"><span>${t('2.5" slots')}</span><input class="field" type="number" min="0" max="16" step="1" data-bay-cfg="ssd" value="${cfg.ssd}"></label>
            <label class="fld"><span>${t('M.2 slots')}</span><input class="field" type="number" min="0" max="8" step="1" data-bay-cfg="m2" value="${cfg.m2}"></label>
          </div>
          <p class="muted small">${t('Drag a disk to a bay. On a full bay the two swap places. Can\'t drag? Tap a disk and then a bay.')}</p>` : ''}
        <div class="bays-wrap"><div class="nas">
          <div class="nas-top"><span class="nas-name">${esc((S.overview && S.overview.hostname) || 'HomeBaseOS')}</span>
            <span class="nas-power" title="${t('On')}"><i class="led"></i></span></div>
          <div class="bay-grid" style="--bay-cols:${cfg.columns}">${Array.from({ length: cfg.count }, (_, i) => bayCard(i + 1)).join('')}</div>
          ${cfg.ssd ? `<div class="sff-row">${Array.from({ length: cfg.ssd }, (_, i) => ssdCard(i + 1)).join('')}</div>` : ''}
          ${cfg.m2 ? `<div class="m2-row">${Array.from({ length: cfg.m2 }, (_, i) => m2Card(i + 1)).join('')}</div>` : ''}
        </div>${edit ? '' : '<div class="disk-panel" id="diskPanel" aria-live="polite" hidden></div>'}</div>
        ${edit ? '' : `<p class="muted small" id="bayHint" style="margin-top:8px">${t('Click a bay to see the disk\'s details: hours, SMART, temperature and self-tests.')}</p>`}
        ${edit ? `<div class="bay-pool${picked && bayOf(picked) ? ' droppable' : ''}" data-unplace>
            <span class="muted small">${unplaced.length ? t('Not in a bay yet (drag a disk here to take it out of its bay):') : t('All disks are in a bay. Drag one here to take it out of its bay.')}</span>
            <div class="bay-chips">${unplaced.map((d) => `<button type="button" class="bay-chip ${bayState(d)}${picked === d.key ? ' picked' : ''}" draggable="true" data-key="${esc(d.key)}">
              <span class="bay-led" aria-hidden="true"></span><b>${esc(d.name)}</b> <span class="muted">${esc([d.model, bytes(d.size)].filter(Boolean).join(' · '))}</span>${tags(d)}</button>`).join('')}</div>
          </div>`
        : unplaced.length ? `<p class="muted small" style="margin-top:8px">${t(unplaced.length === 1 ? '{n} disk is not in a bay yet:' : '{n} disks are not in a bay yet:', { n: unplaced.length })}
            ${unplaced.map((d) => `<button type="button" class="link-btn" data-dp-disk="${esc(d.key)}">${esc(d.name)}</button>`).join(', ')}</p>` : ''}`;
      renderPanel();
    };
    draw();

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-bay-edit]')) {
        if (!edit && !cfg.count) {
          const nvme = s.disks.filter((d) => d.transport === 'nvme').length, sata = s.disks.filter((d) => d.transport !== 'nvme' && !d.rotational).length;
          cfg.count = Math.max(1, s.disks.length - nvme - sata); cfg.m2 = nvme; cfg.ssd = sata;
          cfg.columns = Math.min(12, cfg.count); // by default all bays next to each other on one row
          save();
        }
        edit = !edit; picked = null; draw(); return;
      }
      if (!edit) {
        if (e.target.closest('[data-dp-close]')) { sel = null; draw(); return; }
        if (e.target.closest('[data-dp-retry]')) { loadDisk(); return; }
        if (e.target.closest('[data-dp-wake]')) { loadDisk(true); return; }
        const tb = e.target.closest('[data-dp-test]');
        if (tb) { runTest(tb.dataset.dpTest, tb); return; }
        const pick = e.target.closest('[data-dp-disk]'); if (pick) { selectDisk(pick.dataset.dpDisk); return; }
        const bv = e.target.closest('[data-bay]'); const slot = bv && cfg.slots[bv.dataset.bay];
        if (slot) selectDisk(slot.key);
        return;
      }
      const bay = e.target.closest('[data-bay]'), chip = e.target.closest('.bay-chip');
      if (chip) { picked = picked === chip.dataset.key ? null : chip.dataset.key; draw(); return; }
      if (bay) {
        const slot = cfg.slots[bay.dataset.bay];
        if (picked) place(picked, bay.dataset.bay);
        else if (slot) { picked = slot.key; draw(); }
        return;
      }
      if (e.target.closest('[data-unplace]') && picked) unplace(picked);
    });
    el.addEventListener('change', (e) => {
      const k = e.target.dataset.bayCfg; if (!k) return;
      const v = Math.round(Number(e.target.value));
      if (k === 'count' && !(v >= 1 && v <= 60)) { toast(t('Choose between 1 and 60 bays.'), true); draw(); return; }
      if (k === 'columns' && !(v >= 1 && v <= 12)) { toast(t('Choose between 1 and 12 columns.'), true); draw(); return; }
      if (k === 'm2' && !(v >= 0 && v <= 8)) { toast(t('Choose between 0 and 8 M.2 slots.'), true); draw(); return; }
      if (k === 'ssd' && !(v >= 0 && v <= 16)) { toast(t('Choose between 0 and 16 2.5" slots.'), true); draw(); return; }
      // If all bays were on one row, that stays so with more or fewer bays.
      if (k === 'count' && cfg.columns === Math.min(12, cfg.count)) cfg.columns = Math.min(12, v);
      const prefix = { count: '', m2: 'm', ssd: 's' }[k];
      if (prefix != null) Object.keys(cfg.slots).forEach((b) => { const x = b.match(/^([ms]?)(\d+)$/); if (x && x[1] === prefix && Number(x[2]) > v) delete cfg.slots[b]; });
      cfg[k] = v; save(); draw();
    });
    // Dragging (mouse); on touch screens tapping works.
    el.addEventListener('dragstart', (e) => {
      const src = e.target.closest('[data-key]'); if (!src || !edit) return;
      e.dataTransfer.setData('text/plain', src.dataset.key); e.dataTransfer.effectAllowed = 'move';
      picked = src.dataset.key; requestAnimationFrame(() => src.classList.add('dragging'));
    });
    el.addEventListener('dragend', () => { picked = null; $$('.over, .dragging', el).forEach((x) => x.classList.remove('over', 'dragging')); });
    el.addEventListener('dragover', (e) => {
      const target = e.target.closest('[data-bay], [data-unplace]'); if (!target || !edit) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      $$('.over', el).forEach((x) => { if (x !== target) x.classList.remove('over'); }); target.classList.add('over');
    });
    el.addEventListener('dragleave', (e) => { const target = e.target.closest('.over'); if (target && !target.contains(e.relatedTarget)) target.classList.remove('over'); });
    el.addEventListener('drop', (e) => {
      const target = e.target.closest('[data-bay], [data-unplace]'); if (!target || !edit) return;
      e.preventDefault();
      const key = e.dataTransfer.getData('text/plain'); if (!key) return;
      if (target.dataset.bay) place(key, target.dataset.bay); else unplace(key);
    });
  }

  /* --- create a pool: choose disks and layout, with right away the storage it gives */
  const POOL_LAYOUTS = [
    ['stripe', 'Stripe', 1, 'All the space, but no protection: if one disk fails, you lose everything.'],
    ['mirror', 'Mirror', 2, 'Every disk holds the same data. Very safe, but you get the space of one disk.'],
    ['raidz1', 'RAID-Z1', 3, 'Like RAID 5: one disk may fail. Good for 3 to 5 disks.'],
    ['raidz2', 'RAID-Z2', 4, 'Like RAID 6: two disks may fail. Recommended from 6 disks or with large disks.'],
    ['raidz3', 'RAID-Z3', 5, 'Three disks may fail. For many large disks.'],
    ['mirrors', 'Mirror pairs (RAID 10)', 4, 'Pairs of two: fast, and one disk per pair may fail. An even number of disks.'],
  ];
  // Same calculation as capacity() in lib/zpool.js.
  function poolCapacity(layout, sizes) {
    const n = sizes.length, L = POOL_LAYOUTS.find((x) => x[0] === layout);
    if (!L || n < L[2] || (layout === 'mirrors' && n % 2)) return null;
    const raw = sizes.reduce((a, b) => a + b, 0), min = Math.min(...sizes);
    let usable, unused = 0;
    if (layout === 'stripe') usable = raw;
    else if (layout === 'mirrors') { const x = [...sizes].sort((a, b) => b - a); usable = 0; for (let i = 0; i < n; i += 2) usable += Math.min(x[i], x[i + 1]); unused = raw / 2 - usable; }
    else { usable = ({ mirror: 1, raidz1: n - 1, raidz2: n - 2, raidz3: n - 3 })[layout] * min; unused = sizes.reduce((a, b) => a + b - min, 0); }
    const slop = Math.min(Math.max(usable / 32, 128 * 1048576), 128 * 1073741824);
    const failures = ({ stripe: 0, mirror: n - 1, raidz1: 1, raidz2: 2, raidz3: 3, mirrors: 1 })[layout];
    return { raw, usable: Math.max(0, usable - slop), redundancy: Math.max(0, raw - usable - unused), unused, failures };
  }
  const suggestLayout = (n) => (n <= 1 ? 'stripe' : n === 2 ? 'mirror' : n <= 5 ? 'raidz1' : 'raidz2');

  async function poolCreateWindow(bays) {
    openWindow(t('Create pool'), `<p class="lead">${t('Looking for disks…')}</p>`);
    let o;
    try { o = await api.get('/api/pools/options'); }
    catch (e) { $('#winBody').innerHTML = `<p class="lead">${t('The disks could not be read: {error}', { error: esc(e.message) })}</p>`; return; }
    poolForm($('#winBody'), o, bays, { onCreated: () => storageWindow(), onBack: () => storageWindow() });
  }
  // Form to create a pool: in the Storage window and right in the welcome wizard (inline: without its own buttons,
  // the wizard calls submit() and hears through onPick whether disks were chosen).
  function poolForm(body, o, bays, { inline = false, onCreated = () => {}, onBack = null, onPick = () => {} } = {}) {
    const bayOfDisk = (d) => { const k = d.serial ? 's:' + d.serial : 'n:' + d.name; return Object.keys((bays && bays.slots) || {}).find((x) => bays.slots[x].key === k) || null; };
    const kind = (d) => (d.transport === 'nvme' ? 'NVMe' : d.rotational ? 'HDD' : 'SSD');
    let name = ['tank', 'fast', 'data', 'storage'].find((n) => !o.pools.includes(n)) || 'data' + (o.pools.length + 1);
    const picked = new Set(); let layout = 'stripe', chosenByUser = false;
    body.innerHTML = `
      <form class="form" id="poolForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Pool name')}</span><input class="field" name="name" value="${esc(name)}" maxlength="64" autocomplete="off" spellcheck="false">
            <small>${t('For example tank for the hard drives and fast for the SSDs. The pool is mounted at /name.')}</small></label>
          <label class="fld"><span>${t('Compression')}</span><select class="field" name="compression">
            <option value="lz4">${t('lz4 (recommended: fast and saves space)')}</option><option value="zstd">${t('zstd (saves more, a bit slower)')}</option><option value="off">${t('Off')}</option></select></label>
        </div>
        <fieldset class="fld"><span>${t('Disks')}</span><div class="dev-list" id="poolDisks"></div></fieldset>
        <fieldset class="fld"><span>${t('Layout')}</span><div class="layout-grid" id="poolLayouts" role="radiogroup" aria-label="${t('Layout')}"></div></fieldset>
        <div class="pool-sum" id="poolSum" aria-live="polite"></div>
        <label class="check"><input type="checkbox" name="folders" checked> <span>${t('Create default folders: {list}', { list: 'appdata, media, backups, vms, isos' })}
          <span class="muted small">${t('Apps, VMs and ISOs that have no place yet go on this pool. You can move them later in Settings → Storage.')}</span></span></label>
        <p class="form-error" role="alert"></p>
        ${inline ? '' : `<div class="btn-row"><button class="btn primary" type="submit">${t('Create pool')}</button>${onBack ? `<button class="btn" type="button" data-pool-back>${t('Back to storage')}</button>` : ''}</div>`}
      </form>`;
    const form = $('#poolForm', body);
    const sel = () => o.disks.filter((d) => picked.has(d.name));
    const drawDisks = () => {
      // Only free disks: what is in a pool or carries the system can't be chosen anyway.
      const free = o.disks.filter((d) => d.available);
      $('#poolDisks', form).innerHTML = free.map((d) => {
        const b = bayOfDisk(d);
        return `<label class="check dev"><input type="checkbox" data-pdisk="${esc(d.name)}"${picked.has(d.name) ? ' checked' : ''}>
          <span><b>${esc(d.name)}</b> <span class="muted small">${esc([d.model, bytes(d.size), kind(d), b ? (b.startsWith('m') ? t('M.2 slot {n}', { n: b.slice(1) }) : b.startsWith('s') ? t('2.5" slot {n}', { n: b.slice(1) }) : t('bay {n}', { n: b })) : null].filter(Boolean).join(' · '))}</span>
          ${d.warn && picked.has(d.name) ? `<span class="small temp-warn">${esc(tr(d.warn))}</span>` : ''}</span></label>`;
      }).join('') || `<p class="muted">${t('There are no free disks. Every disk is already in a pool or holds the system.')}</p>`;
    };
    const drawLayouts = () => {
      const n = picked.size;
      $('#poolLayouts', form).innerHTML = POOL_LAYOUTS.map(([k, label, min, help]) => {
        const short = n < min ? min - n : 0, odd = k === 'mirrors' && n >= min && n % 2;
        return `<label class="layout${layout === k ? ' on' : ''}${short || odd ? ' short' : ''}"><input type="radio" name="layout" value="${k}"${layout === k ? ' checked' : ''}>
          <b>${t(label)}</b><span class="small muted">${t(help)}</span>
          <span class="small">${short ? t(short === 1 ? '{n} more disk needed' : '{n} more disks needed', { n: short }) : odd ? t('Choose an even number') : t(min === 1 ? 'At least {n} disk' : 'At least {n} disks', { n: min })}</span></label>`;
      }).join('');
    };
    const drawSum = () => {
      const d = sel(), c = poolCapacity(layout, d.map((x) => x.size)), box = $('#poolSum', form);
      if (!d.length) { box.innerHTML = `<p class="muted">${t('Tick the disks that go into the pool.')}</p>`; return; }
      if (!c) {
        const L = POOL_LAYOUTS.find((x) => x[0] === layout);
        box.innerHTML = `<p class="muted">${layout === 'mirrors' && d.length >= L[2] ? t('Mirror pairs need an even number of disks.') : t('{layout} needs at least {n} disks.', { layout: t(L[1]), n: L[2] })}</p>`; return;
      }
      const pct = (v) => (c.raw ? (v / c.raw) * 100 : 0).toFixed(1);
      const warns = [];
      if (layout === 'stripe' && d.length > 1) warns.push(t('No protection: if one disk fails, you lose the whole pool.'));
      if (c.unused > 1e9) warns.push(t('{size} stays unused: with this layout, each disk only counts as much as the smallest one.', { size: bytes(c.unused) }));
      if (d.some((x) => x.rotational) && d.some((x) => !x.rotational)) warns.push(t('You are mixing hard drives and SSDs: the pool is as slow as the hard drives. Better make two pools.'));
      if (layout === 'raidz1' && d.length >= 6) warns.push(t('With 6 or more disks RAID-Z2 is safer: while a disk is being rebuilt, another one may still fail.'));
      box.innerHTML = `
        <div class="pool-big"><b>${bytes(c.usable)}</b> <span>${t('usable (approximately)')}</span></div>
        <div class="pool-bar" aria-hidden="true"><span class="u" style="width:${pct(c.usable)}%"></span><span class="r" style="width:${pct(c.redundancy)}%"></span><span class="x" style="width:${pct(c.unused)}%"></span></div>
        <div class="pool-legend small">
          <span><i class="u"></i>${t('Usable {size}', { size: bytes(c.usable) })}</span>
          <span><i class="r"></i>${t('Protection {size}', { size: bytes(c.redundancy) })}</span>
          ${c.unused > 1e9 ? `<span><i class="x"></i>${t('Unused {size}', { size: bytes(c.unused) })}</span>` : ''}
          <span class="muted">${t('Raw {size} on {n} disks', { size: bytes(c.raw), n: d.length })}</span>
        </div>
        <p class="${c.failures ? 'temp-ok' : 'temp-warn'}">${c.failures ? t(c.failures === 1 ? '{n} disk may fail without losing your data.' : '{n} disks may fail without losing your data.', { n: c.failures })
          + (layout === 'mirrors' ? ' ' + t('(one per pair)') : '') : t('No protection.')}</p>
        ${warns.map((w) => `<p class="small temp-warn">${esc(w)}</p>`).join('')}
        <p class="small muted">${t('ZFS keeps about 3% for itself; compression often gives you more back.')}</p>`;
    };
    const drawAll = () => { drawDisks(); drawLayouts(); drawSum(); };
    drawAll();
    form.addEventListener('change', (e) => {
      const tg = e.target;
      if (tg.dataset.pdisk) {
        if (tg.checked) picked.add(tg.dataset.pdisk); else picked.delete(tg.dataset.pdisk);
        if (!chosenByUser) layout = suggestLayout(picked.size);
        drawAll(); onPick(picked.size > 0); return;
      }
      if (tg.name === 'layout') { layout = tg.value; chosenByUser = true; drawLayouts(); drawSum(); }
    });
    if (onBack) body.addEventListener('click', (e) => { if (e.target.closest('[data-pool-back]')) onBack(); });
    // true = created, false = not (the error is in the form, or cancelled).
    async function submit() {
      const err = $('.form-error', form), btn = $('[type=submit]', form); err.textContent = '';
      name = form.elements.name.value.trim();
      const d = sel();
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name)) { err.textContent = t('Choose a name that starts with a letter, with letters, digits, - or _ (e.g. tank or fast). Names like mirror or raidz are not allowed.'); return false; }
      if (!poolCapacity(layout, d.map((x) => x.size))) { err.textContent = d.length ? t('This layout does not fit the number of chosen disks.') : t('Tick the disks that go into the pool.'); return false; }
      const r = await ask(t('Create pool {name} on {list}? Everything currently on these disks will be erased.', { name, list: d.map((x) => x.name).join(', ') }),
        t('Create pool'), t('I understand that all data on these disks will be lost'));
      if (!r) return false;
      if (!r.checked) { err.textContent = t('Tick that the data on the disks may be lost.'); return false; }
      if (btn) { btn.disabled = true; btn.textContent = t('Creating…'); }
      try {
        const res = await api.post('/api/pools', { name, layout, disks: d.map((x) => x.name), compression: form.elements.compression.value, confirm: name, folders: form.elements.folders.checked });
        const folders = res.folders || [];
        toast(folders.length ? t('Pool {name} was created with the folders {list}.', { name, list: folders.join(', ') }) : t('Pool {name} was created and is mounted at /{name}.', { name }));
        if (res.warning) toast(tr(res.warning), true);
        loadOverview().catch(() => {});
        onCreated(res);
        return true;
      } catch (ex) { err.textContent = ex.message; if (btn) { btn.disabled = false; btn.textContent = t('Create pool'); } return false; }
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    return { submit, picked: () => picked.size > 0 };
  }

  async function storageWindow() {
    openWindow(t('Storage'), `<p class="lead">${t('Loading disks…')}</p>`);
    win.classList.add('win-wide');
    let s;
    try { s = await api.get('/api/storage'); } catch (e) { $('#winBody').innerHTML = `<p class="lead">${esc(e.message)}</p>`; return; }
    const pct = s.total ? (s.used / s.total) * 100 : 0;
    const ROLE = { cache: 'Read cache', log: 'Write log', spare: 'Spare', special: 'Metadata', dedup: 'Dedup' };
    const diskRow = (d) => {
      const sub = [d.model, ROLE[d.role] && t(ROLE[d.role]), d.transport === 'nvme' ? 'NVMe' : d.rotational ? 'HDD' : 'SSD',
        d.state && d.state !== 'ONLINE' ? d.state.toLowerCase() : null, d.errors ? t('{n} errors', { n: d.errors }) : null,
        d.smartOk === false ? t('SMART reports a problem') : null].filter(Boolean).join(' · ');
      const bad = (d.state && d.state !== 'ONLINE') || d.errors || d.smartOk === false;
      return `<li>
        <div><div class="row-title">${esc(d.name)}</div><div class="row-sub${bad ? ' temp-bad' : ''}">${esc(sub)}</div></div>
        <div class="row-side"><div>${bytes(d.size)}</div><div class="${tempClass(d.temp)}">${d.temp != null ? d.temp + ' °C' : t('Standby')}</div></div>
      </li>`;
    };
    const poolBlock = (p) => {
      const used = p.total ? (p.used / p.total) * 100 : 0;
      const [label, cls] = poolHealth(p.health);
      const disks = s.disks.filter((d) => d.pool === p.name);
      return `<h3>${esc(p.name)} <span class="pill ${cls}">${esc(label)}</span></h3>
        <ul class="rows">
          <li>
            <div><div class="row-title">${t('{size} free', { size: bytes(p.free) })}</div>
              <div class="row-sub">${esc([p.layout, p.diskCount ? t(p.diskCount === 1 ? '{n} disk' : '{n} disks', { n: p.diskCount }) : null].filter(Boolean).join(' · '))}</div></div>
            <div class="row-side">${t('{used} of {total}', { used: bytes(p.used), total: bytes(p.total) })}</div>
            <div class="row-bar"><div class="bar"><span class="${level(used, 80, 92)}" style="width:${used.toFixed(1)}%"></span></div>
              <div class="row-sub">${esc(scrubText(p.scrub))}</div></div>
          </li>
          ${disks.map(diskRow).join('')}
        </ul>`;
    };
    const loose = s.disks.filter((d) => !d.pool);
    $('#winBody').innerHTML = `
      <div class="stat-strip">
        <div class="stat"><b>${bytes(s.free)}</b><span>${t('free')}</span></div>
        <div class="stat"><b>${nf0.format(pct)}%</b><span>${t('used of {total}', { total: bytes(s.total) })}</span></div>
        <div class="stat"><b>${s.disks.length}</b><span>${t('disks')}</span></div>
        <div class="stat"><b>${s.disks.reduce((n, d) => n + (d.errors || 0), 0)}</b><span>${t('disk errors')}</span></div>
      </div>
      <section class="bays-sec" id="baySec"></section>
      ${s.zfsError ? `<p class="lead temp-bad">${t('ZFS reported an error: {error}', { error: esc(tr(s.zfsError)) })}</p>` : ''}
      ${!s.zfsError && !s.pools.length ? `<p class="lead">${t('There is no ZFS pool yet. Click Create pool to combine your disks.')}</p>` : ''}
      <div class="bays-head"><h3>${t('Pools')}</h3><button class="btn sm" type="button" data-pool-new>${t('Create pool')}</button></div>
      ${s.pools.map(poolBlock).join('')}
      ${loose.length ? `<h3>${t('Not in a pool')}</h3><ul class="rows">${loose.map(diskRow).join('')}</ul>` : ''}
      <div class="bays-head"><h3>${t('Datasets')}</h3><button class="btn sm" type="button" data-open="shares">${t('Manage shared folders')}</button></div>
      <ul class="rows">${s.datasets.map((d) => `<li>
        <div><div class="row-title">${esc(d.name)}</div><div class="row-sub">${esc([d.mountpoint, d.compress > 1.01 ? t('compression {x}×', { x: nf.format(d.compress) }) : null].filter(Boolean).join(' · '))}</div></div>
        <div class="row-side">${bytes(d.used)}</div></li>`).join('') || `<li><span class="muted">${t('No datasets')}</span></li>`}</ul>`;
    mountBays($('#baySec'), s);
    $('[data-pool-new]').addEventListener('click', () => poolCreateWindow(s.bays));
  }

  /* --- VMs (own page at #vms) */
  const VM_ACTS = {
    start: { label: 'Start', noun: 'Start', done: 'Started' },
    stop: { label: 'Shut down', noun: 'Shut down', done: 'Shutdown started', yes: 'Shut down',
      ask: (n) => t('Shut down {name}? The VM gets the signal to shut down cleanly.', { name: n }) },
    reboot: { label: 'Restart', noun: 'Restart', done: 'Restarted', yes: 'Restart',
      ask: (n) => t('Restart {name}? Whatever runs on it will be unavailable for a moment.', { name: n }) },
    pause: { label: 'Pause', noun: 'Pause', done: 'Paused' },
    resume: { label: 'Resume', noun: 'Resume', done: 'Resumed' },
    'force-stop': { label: 'Force off', noun: 'Forcing off', done: 'Turned off', yes: 'Force off',
      ask: (n) => t('Force off {name}? That is like pulling the plug. Anything not saved will be lost.', { name: n }) },
    reset: { label: 'Hard reset', noun: 'Hard reset', done: 'Hard reset done', yes: 'Hard reset',
      ask: (n) => t('Hard reset {name}? Anything not saved will be lost.', { name: n }) },
    delete: { label: 'Remove', noun: 'Remove', done: 'Removed' },
  };
  const VM_HINT = {
    PAUSED: 'The memory stays in use until you resume.', PMSUSPENDED: 'The VM is suspended.',
    CRASHED: 'Start it again or force it off.', SHUTDOWN: 'Wait until it is off, or force it off.',
  };
  function vmKind(s) {
    s = String(s).toUpperCase();
    if (s === 'RUNNING' || s === 'IDLE') return 'on';
    if (s === 'PAUSED' || s === 'PMSUSPENDED') return 'paused';
    if (s === 'CRASHED') return 'bad';
    if (s === 'SHUTDOWN') return 'stopping';
    return 'off';
  }
  const VM_PILL = { on: 'ok', paused: 'warn', bad: 'bad', stopping: 'warn', off: '' };
  function vmMatches(v, filter) {
    const k = vmKind(v.state);
    if (filter === 'on') return k === 'on';
    if (filter === 'paused') return k === 'paused';
    if (filter === 'off') return k !== 'on' && k !== 'paused';
    return true;
  }
  function delayText(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? (s ? t('{m} min {s} s', { m, s }) : t('{m} min', { m })) : t('{n} s', { n: s });
  }
  function vmPendingText(v) {
    if (!v.startsAt) return '';
    const left = Math.ceil((v.startsAt - Date.now()) / 1000);
    return left > 0 ? t('Starts automatically in {time}', { time: delayText(left) }) : t('Starting automatically…');
  }
  function vmSubText(v) {
    const busy = S.vmBusy[v.id];
    const hint = VM_HINT[String(v.state).toUpperCase()];
    return busy ? t(VM_ACTS[busy].noun) + '…' : vmPendingText(v) || (hint ? t(hint) : '');
  }
  function vmSpecs(v) {
    const parts = [];
    if (v.vcpus) parts.push(t(v.vcpus === 1 ? '{n} vCPU' : "{n} vCPUs", { n: v.vcpus }));
    if (v.memory) parts.push(bytes(v.memory) + ' RAM');
    if (v.autostart) parts.push(v.delay ? t('starts automatically after {time}', { time: delayText(v.delay) }) : t('starts automatically'));
    return parts.join(' · ');
  }
  const vmCpuPct = (v) => (v.cpu == null ? null : v.cpu);
  const vmRamPct = (v) => (v.memUsed != null && v.memory ? (v.memUsed / v.memory) * 100 : null);
  const vmCpuText = (v) => (v.cpu == null ? '–' : nf0.format(v.cpu) + '%');
  const vmRamText = (v) => (v.memUsed == null ? '–' : t('{used} of {total}', { used: bytes(v.memUsed), total: bytes(v.memory) }));

  function meterHtml(label, pct, text) {
    return `<div class="meter"><div class="meter-head"><span>${label}</span><b>${esc(text)}</b></div>
      <div class="bar"><span class="${level(pct || 0)}" style="width:${Math.min(100, pct || 0).toFixed(1)}%"></span></div></div>`;
  }
  function setMeter(el, pct, text) {
    el.querySelector('b').textContent = text;
    const bar = el.querySelector('.bar span');
    bar.style.width = Math.min(100, pct || 0).toFixed(1) + '%'; bar.className = level(pct || 0);
  }

  // The console opens in its own tab (one per VM), like in Unraid.
  // The console opens large in HomeBaseOS; there you can move it to its own browser window with "Separate window".
  const consoleLink = (id, cls) => `<button class="${cls}" type="button" data-console="${esc(id)}">${t('Console')}</button>`;
  const conWin = $('#conWin'), conFrame = $('#conFrame');
  function openConsole(id) {
    if (win.open) win.close();
    conFrame.src = 'console.html#' + encodeURIComponent(id);
    if (!conWin.open) conWin.showModal();
    conFrame.focus();
  }
  // Terminal on the server: same window as the console, with terminal.html in it.
  function openTerminal() {
    if (win.open) win.close();
    conFrame.src = 'terminal.html';
    if (!conWin.open) conWin.showModal();
    conFrame.focus();
  }
  $('#termBtn').addEventListener('click', openTerminal);
  // The console (in the iframe) calls this on Close or Separate window. Emptying the iframe breaks the connection.
  window.TB_closeConsole = () => { conFrame.src = 'about:blank'; if (conWin.open) conWin.close(); };
  conWin.addEventListener('close', () => { conFrame.src = 'about:blank'; });
  conWin.addEventListener('click', (e) => { if (e.target === conWin) window.TB_closeConsole(); });
  // IP addresses (click to copy). Without an address: an explanation why.
  function vmIpHtml(v) {
    if (!v.ips || !v.ips.length) return `<span title="${esc(t('Install qemu-guest-agent in the VM, or wait until it gets an address from your router.'))}">${t('IP address not known yet')}</span>`;
    return `${t('IP')} ${v.ips.map((ip) => `<button class="linkish" type="button" data-copy="${esc(ip)}" title="${esc(t('Click to copy'))}"><b>${esc(ip)}</b></button>`).join(', ')}`;
  }
  function vmCardHtml(v) {
    const kind = vmKind(v.state), busy = S.vmBusy[v.id];
    const btn = (act, cls = '') => `<button class="btn ${cls}" type="button" data-vm="${esc(v.id)}" data-do="${act}"${busy ? ' disabled' : ''}>${t(VM_ACTS[act].label)}</button>`;
    const main = (kind === 'on' ? btn('pause') + btn('reboot') + btn('stop', 'danger')
      : kind === 'paused' ? btn('resume', 'primary')
      : kind === 'stopping' ? ''
      : btn('start', 'primary')) +
      (kind === 'on' || kind === 'paused' ? consoleLink(v.id, 'btn') : '') +
      `<button class="btn" type="button" data-vm-edit="${esc(v.id)}"${busy ? ' disabled' : ''}>${t('Edit')}</button>`;
    const force = kind === 'on' ? btn('force-stop', 'sm danger') + btn('reset', 'sm danger') : kind === 'off' ? '' : btn('force-stop', 'sm danger');
    const foot = kind === 'off' ? `<span class="row-sub">${t('No longer needed?')}</span>${btn('delete', 'sm danger')}`
      : `<span class="row-sub">${t('Not responding?')}</span>${force}`;
    return `<article class="widget vm-card ${kind}" data-card="${esc(v.id)}">
      <header class="vm-head">
        <span class="vm-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></span>
        <div class="vm-title"><h2 title="${esc(v.name)}">${esc(v.name)}</h2><p class="row-sub vm-sub">${esc(vmSubText(v))}</p></div>
        <span class="pill ${VM_PILL[kind]}">${esc(vmStateText(v.state))}</span>
      </header>
      ${v.description ? `<p class="vm-desc">${esc(tr(v.description))}</p>` : ''}
      ${kind === 'on' || kind === 'paused'
        ? `<div class="vm-meters">${meterHtml('CPU', vmCpuPct(v), vmCpuText(v))}${meterHtml('RAM', vmRamPct(v), vmRamText(v))}</div>` : ''}
      <p class="vm-specs">${esc(vmSpecs(v))}</p>
      ${kind === 'on' || kind === 'paused' ? `<p class="vm-ip">${vmIpHtml(v)}</p>` : ''}
      <div class="btn-row">${main}</div>
      <div class="vm-force">${foot}</div>
    </article>`;
  }

  // New numbers every 3 s: only update the meters, so focus and animations stay.
  let vmSig = '';
  function patchVmCard(v) {
    const card = $(`[data-card="${CSS.escape(v.id)}"]`, $('#vmList')); if (!card) return;
    $('.vm-sub', card).textContent = vmSubText(v);
    const meters = $$('.meter', card);
    if (meters.length === 2) { setMeter(meters[0], vmCpuPct(v), vmCpuText(v)); setMeter(meters[1], vmRamPct(v), vmRamText(v)); }
  }

  function renderVmPage() {
    if ($('#vmPage').hidden) return;
    const all = S.vms;
    const running = all.filter((v) => vmKind(v.state) === 'on').length;
    $('#vmCount').textContent = all.length ? t('{n} of {total} running', { n: running, total: all.length }) : '';
    const names = { all: 'All', on: 'Active', paused: 'Paused', off: 'Off' };
    $$('#vmFilters button').forEach((b) => {
      const n = all.filter((v) => vmMatches(v, b.dataset.filter)).length;
      b.textContent = t(names[b.dataset.filter]) + (all.length ? ' ' + n : '');
    });

    const list = $('#vmList');
    const show = (html) => { vmSig = ''; list.innerHTML = html; };
    if (!S.vmsLoaded) return show(`<p class="empty">${t("Loading VMs…")}</p>`);
    if (S.vmError && !all.length) {
      return show(`<div class="empty"><p>${t("The VMs could not be loaded: {error}", { error: esc(S.vmError) })}</p>
        <button class="btn sm" type="button" data-vm-retry style="margin-top:12px">${t('Try again')}</button></div>`);
    }
    if (!all.length) return show(`<p class="empty">${t('There are no virtual machines yet. Create one with the New VM button.')}</p>`);

    const q = S.vmSearch.trim().toLowerCase();
    const shown = all.filter((v) => vmMatches(v, S.vmFilter) && (!q || v.name.toLowerCase().includes(q)));
    if (!shown.length) return show(`<p class="empty">${t("No VMs match.")}</p>`);

    const sig = shown.map((v) => [v.id, v.state, S.vmBusy[v.id] || '', v.autostart, v.delay, !!v.startsAt, v.vcpus, v.memory, v.description, (v.ips || []).join(',')].join('|')).join('\n');
    if (sig === vmSig) { shown.forEach(patchVmCard); return; }
    vmSig = sig;
    list.innerHTML = shown.map(vmCardHtml).join('');
  }

  async function vmRun(v, act, request) {
    S.vmBusy[v.id] = act; renderVmPage();
    try { const r = await request(); toast(t(VM_ACTS[act].done) + ': ' + v.name + (r && r.kept && r.kept.length ? '. ' + t('These files were kept: {list}', { list: r.kept.join(', ') }) : '')); }
    catch (err) { toast(t('{action} {name} failed: {error}', { action: t(VM_ACTS[act].noun), name: v.name, error: err.message }), true); }
    delete S.vmBusy[v.id];
    await loadVms().catch(() => renderVmPage());
  }

  $('#vmList').addEventListener('click', async (e) => {
    if (e.target.closest('[data-vm-retry]')) { loadVms().catch(() => {}); return; }
    const edit = e.target.closest('[data-vm-edit]');
    if (edit) { vmEditWindow(edit.dataset.vmEdit); return; }
    const b = e.target.closest('[data-vm]'); if (!b) return;
    const v = S.vms.find((x) => x.id === b.dataset.vm); const act = b.dataset.do; const def = VM_ACTS[act];
    if (!v || !def || S.vmBusy[v.id]) return;
    if (act === 'delete') {
      const r = await ask(t('Remove {name}? The VM disappears from the list. This cannot be undone.', { name: v.name }), t('Remove'), t('Also delete the disk files'));
      if (!r) return;
      return vmRun(v, act, () => api.del('/api/vms/' + encodeURIComponent(v.id) + (r.checked ? '?disks=1' : '')));
    }
    if (def.ask && !(await ask(def.ask(v.name), t(def.yes)))) return;
    vmRun(v, act, () => api.post('/api/vms/' + encodeURIComponent(v.id) + '/' + act));
  });
  $('#vmSearch').addEventListener('input', (e) => { S.vmSearch = e.target.value; renderVmPage(); });
  $('#vmFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]'); if (!b) return;
    S.vmFilter = b.dataset.filter;
    $$('#vmFilters button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    renderVmPage();
  });
  $('#vmNew').addEventListener('click', () => vmCreateWindow());

  /* --- VM forms (create and edit) */
  function vmNameField(d, off = true) {
    return `<label class="fld"><span>${t('Name')}</span>
        <input class="field" name="name" required maxlength="63" autocomplete="off" value="${esc(d.name || '')}"${off ? '' : ' disabled'}>
        ${off ? '' : `<small>${t('Turn the VM off to change its name.')}</small>`}</label>`;
  }
  function vmSizeFields(d, opts, pinned = false) {
    const maxGb = Math.floor(opts.maxMemory / 1073741824);
    const gb = d.memory ? Math.round((d.memory / 1073741824) * 100) / 100 : '';
    return `<div class="fld-row">
        <label class="fld"><span>${t("vCPUs")}</span>
          <input class="field" name="vcpus" type="number" min="1" max="${opts.maxVcpus}" step="1" required value="${esc(d.vcpus || '')}"${pinned ? ' disabled' : ''}>
          <small>${pinned ? t('Follows from the cores chosen below.') : t('Your server has {n} threads.', { n: opts.maxVcpus })}</small></label>
        <label class="fld"><span>${t('Memory (GB)')}</span>
          <input class="field" name="memoryGb" type="number" min="0.25" max="${maxGb}" step="0.25" required value="${gb}">
          <small>${t('Your server has {size}.', { size: bytes(opts.maxMemory) })}</small></label>
        ${d.diskGb !== undefined ? `<label class="fld"><span>${t('Disk (GB)')}</span>
          <input class="field" name="diskGb" type="number" min="4" max="16384" step="1" required value="${esc(d.diskGb)}">
          <small>${t('Grows as needed, does not take everything at once.')}</small></label>` : ''}
      </div>`;
  }
  function vmDescAutoFields(d) {
    return `<label class="fld"><span>${t('Description')} <em class="muted">${t('(optional)')}</em></span>
        <textarea class="field" name="description" rows="2" maxlength="2000">${esc(d.description || '')}</textarea></label>
      <fieldset class="fld autostart">
        <label class="check"><input type="checkbox" name="autostart"${d.autostart ? ' checked' : ''}> ${t('Start automatically when the server starts')}</label>
        <label class="fld"><span>${t('Start delay (seconds)')}</span>
          <input class="field" name="delay" type="number" min="0" max="3600" step="5" value="${esc(d.delay || 0)}"${d.autostart ? '' : ' disabled'}>
          <small>${t('For example 60: the VM starts 1 minute after the server, so the server can start up calmly first.')}</small></label>
      </fieldset>`;
  }
  // List of networks: "network:<name>" (libvirt) or "bridge:<name>" (a bridge of the server).
  const NET_MODE = { nat: 'NAT', isolated: 'Isolated', bridge: 'Bridge', route: 'Routed', open: 'Open' };
  function vmNetOptions(opts, selected) {
    const opt = (v, label) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`;
    const known = [...opts.networks.map((n) => 'network:' + n.name), ...opts.bridges.map((b) => 'bridge:' + b.name)];
    return (opts.bridges.length ? `<optgroup label="${t('Home network (server bridge)')}">${opts.bridges.map((b) =>
        opt('bridge:' + b.name, [b.name, b.address].filter(Boolean).join(' · '))).join('')}</optgroup>` : '') +
      `<optgroup label="${t('VM networks')}">${opts.networks.map((n) =>
        opt('network:' + n.name, [n.name, t(NET_MODE[n.mode] || n.mode), n.subnet, n.active ? null : t('not active')].filter(Boolean).join(' · '))).join('')}</optgroup>` +
      (selected && !known.includes(selected) ? opt(selected, selected.replace(':', ': ') + ' (' + t('no longer exists') + ')') : '');
  }
  const VM_NET_HELP = 'Bridge (e.g. br0): the VM gets its own address in your home network, needed for Home Assistant. NAT: the VM can reach the internet, but you cannot reach it from your network.';
  function readForm(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || (el.disabled && el.name !== 'delay')) continue; // keep the delay, also when automatic start is off
      out[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    }
    return out;
  }
  function wireAutostart(form) {
    const box = form.elements.autostart, delay = form.elements.delay;
    box.addEventListener('change', () => { delay.disabled = !box.checked; });
  }
  function vncHtml(vnc) {
    if (!vnc) return `<p class="muted small">${t('This VM has no VNC screen.')}</p>`;
    const host = location.hostname || 'your-server';
    const addr = vnc.port ? host + ':' + vnc.port : null;
    return `<dl class="kv">
        <dt>${t('Address')}</dt><dd>${addr ? `<a href="vnc://${esc(addr)}" target="_blank" rel="noopener">${esc(addr)}</a>` : t('Start the VM to see the address')}</dd>
        <dt>${t('Password')}</dt><dd>${vnc.password ? `<code>${esc(vnc.password)}</code>` : t('None')}</dd>
      </dl>
      <p class="muted small">${t('On your Mac the link opens Screen Sharing. There you install the operating system or see the VM\'s screen.')}</p>`;
  }
  const vmOptions = () => api.get('/api/vm-options'); // always fresh: USB devices and ISOs change

  const GIB = 1073741824;
  const NIC_MODELS = [['virtio', 'virtio (fastest: Linux, Home Assistant)'], ['e1000e', 'e1000e (Windows without extra drivers)'], ['rtl8139', 'rtl8139 (old systems)']];
  const VM_TABS = [['general', 'General'], ['cpu', 'CPU and memory'], ['net', 'Network'], ['storage', 'Storage'], ['devices', 'Devices'], ['snapshots', 'Snapshots'], ['screen', 'Screen']];

  async function vmEditWindow(id, tab = 'general') {
    openWindow(t('Edit VM'), `<p class="lead">${t('Loading…')}</p>`);
    let d, opts;
    try { [d, opts] = await Promise.all([api.get('/api/vms/' + encodeURIComponent(id)), vmOptions()]); }
    catch (e) { $('#winBody').innerHTML = `<p class="lead">${t('The VM could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    $('#winTitle').textContent = d.name;
    const off = vmKind(d.state) === 'off';
    // What changes in the form but isn't a normal input field.
    const st = {
      nics: d.nics.map((n) => ({ id: n.mac, locked: n.locked, type: n.type, source: n.source, model: n.model || 'virtio', mac: n.mac || '' })),
      disks: d.disks.map((k) => ({ target: k.target, source: k.source, size: k.size, sizeGb: k.size ? Math.ceil(k.size / GIB) : '', remove: false })),
      add: [], hostdevs: new Set(d.hostdevs), pins: new Set(d.cpuPins),
    };
    const body = $('#winBody');
    body.innerHTML = `
      ${off ? '' : `<p class="lead">${t('The VM is running. Changes to CPU, memory, network and devices apply after you shut it down and start it again. Swapping an ISO and growing disks happen right away.')}</p>`}
      <div class="seg vm-tabs" role="tablist" aria-label="${t('Sections')}">${VM_TABS.map(([k, label]) =>
        `<button type="button" role="tab" id="vt-${k}" aria-controls="vp-${k}" aria-selected="${k === tab}" data-vtab="${k}">${t(label)}</button>`).join('')}</div>
      <form class="form" id="vmForm" novalidate>
        <section class="form" role="tabpanel" id="vp-general" aria-labelledby="vt-general" data-vpane="general">${vmNameField(d, off)}${vmDescAutoFields(d)}</section>
        <section class="form" role="tabpanel" id="vp-cpu" aria-labelledby="vt-cpu" data-vpane="cpu"></section>
        <section class="form" role="tabpanel" id="vp-net" aria-labelledby="vt-net" data-vpane="net"></section>
        <section class="form" role="tabpanel" id="vp-storage" aria-labelledby="vt-storage" data-vpane="storage"></section>
        <section class="form" role="tabpanel" id="vp-devices" aria-labelledby="vt-devices" data-vpane="devices"></section>
        <section class="form" role="tabpanel" id="vp-snapshots" aria-labelledby="vt-snapshots" data-vpane="snapshots"></section>
        <section role="tabpanel" id="vp-screen" aria-labelledby="vt-screen" data-vpane="screen">
          <div class="btn-row" style="margin-bottom:14px">${vmKind(d.state) === 'off' ? `<span class="muted">${t('Start the VM to see its screen.')}</span>` : consoleLink(d.id, 'btn primary')}</div>
          <p class="muted small" style="margin-bottom:10px">${t('The console shows the VM\'s screen, with keyboard and mouse. Pop out puts it in its own browser window. Pasting (Cmd/Ctrl+V) types your clipboard text into the VM.')}</p>
          <label class="check" style="margin-bottom:4px"><input type="checkbox" name="clipboard"${d.clipboard ? ' checked' : ''}> ${t('Share the clipboard with this VM')}</label>
          <p class="muted small" style="margin-bottom:14px">${t('Needed to get text you copy in the VM onto your PC. Install spice-vdagent (Linux) or the SPICE guest tools (Windows) in the VM and restart the VM afterwards.')}</p>
          <p class="muted small" style="margin-bottom:10px">${t('Prefer your own VNC app? Use this address and password.')}</p>
          ${vncHtml(d.vnc)}</section>
        <p class="form-error" role="alert"></p>
        <div class="btn-row" data-vsave><button class="btn primary" type="submit">${t('Save')}</button><button class="btn" type="button" data-close>${t('Cancel')}</button></div>
      </form>`;
    const form = $('#vmForm', body);
    const pane = (k) => $(`[data-vpane="${k}"]`, form);

    /* CPU and memory, with pinned cores */
    const cores = [];
    opts.cpus.forEach((c) => { let g = cores.find((x) => x.core === c.core && x.siblings.join() === c.siblings.join()); if (!g) cores.push(g = { core: c.core, siblings: c.siblings, ids: [] }); g.ids.push(c.id); });
    const drawCpu = () => {
      const memory = form.elements.memoryGb ? Number(form.elements.memoryGb.value) * GIB : d.memory;
      const vcpus = st.pins.size || (form.elements.vcpus ? Number(form.elements.vcpus.value) : d.vcpus);
      pane('cpu').innerHTML = vmSizeFields({ ...d, vcpus, memory }, opts, st.pins.size > 0) + `
        <fieldset class="fld"><span>${t('Pinned cores (optional)')}</span>
          <div class="pin-grid">${cores.map((c, i) => `<div class="pin-core"><span class="muted small">${t('Core {n}', { n: i })}</span><div>${c.ids.map((cpu) =>
            `<label class="pin"><input type="checkbox" data-pin="${cpu}"${st.pins.has(cpu) ? ' checked' : ''}><span>${cpu}</span></label>`).join('')}</div></div>`).join('')}</div>
          <small>${t('Choose cores to always run the VM on them, like in Unraid. Take both threads of a core and keep core 0 free for the server. Nothing chosen = the server spreads the load itself.')}</small>
          ${st.pins.size ? `<button class="btn sm" type="button" data-pin-clear style="justify-self:start">${t('No pinned cores')}</button>` : ''}</fieldset>`;
    };

    /* Network */
    const drawNet = () => {
      pane('net').innerHTML = `<div class="cf-list">${st.nics.map((n, i) => n.locked
        ? `<div class="cf-row cf-locked"><span class="cf-lock">🔒</span><span class="cf-text">${esc(n.type + (n.source ? ' (' + n.source + ')' : '') + ' · ' + (n.mac || ''))}
            <span class="muted">· ${t('advanced, change with virsh edit')}</span></span>
            <button class="cf-del" type="button" data-nic-del="${i}" aria-label="${t('Remove')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`
        : `<div class="cf-row nic-row">
            <select class="field" data-nic="${i}:net" aria-label="${t('Network')}">${vmNetOptions(opts, n.type + ':' + n.source)}</select>
            <select class="field" data-nic="${i}:model" aria-label="${t('Card type')}">${NIC_MODELS.map(([v, label]) => `<option value="${v}"${n.model === v ? ' selected' : ''}>${esc(t(label))}</option>`).join('')}</select>
            <input class="field" data-nic="${i}:mac" value="${esc(n.mac)}" placeholder="${t('MAC: automatic')}" aria-label="${t('MAC address')}" spellcheck="false" autocomplete="off">
            <button class="cf-del" type="button" data-nic-del="${i}" aria-label="${t('Remove')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('')
        || `<p class="muted">${t('This VM has no network card, so it cannot reach the network.')}</p>`}</div>
        <div class="btn-row"><button class="btn sm" type="button" data-nic-add${st.nics.length >= 8 ? ' disabled' : ''}>+ ${t('Network card')}</button></div>
        <p class="muted small">${t(VM_NET_HELP)} ${t('Create your own VM networks in')} <a href="#settings/vmnet">${t('Settings → VM networks')}</a>.</p>
        <p class="muted small">${t('The MAC address decides which IP address your router gives the VM. Keep it if your router has a fixed address for the VM.')}</p>`;
    };

    /* Storage: disks, cd-rom and boot */
    const drawStorage = () => {
      const cur = d.cdroms[0] || '';
      const curIso = cur && cur.startsWith(opts.isoDir + '/') ? cur.slice(opts.isoDir.length + 1) : null;
      const isoKnown = curIso && opts.isos.some((f) => f.name === curIso);
      pane('storage').innerHTML = `
        <div class="cf-list">${st.disks.map((k, i) => `<div class="cf-row disk-row${k.remove ? ' is-removed' : ''}">
            <div><div class="row-title">${esc(k.target || t('disk'))}</div><div class="row-sub">${esc(k.source || '')}</div></div>
            <label class="disk-size"><input class="field" type="number" min="${k.size ? Math.ceil(k.size / GIB) : 1}" max="16384" step="1" data-disk="${i}:sizeGb" value="${esc(k.sizeGb)}"${k.remove ? ' disabled' : ''} aria-label="${t('Size in GB')}"> GB</label>
            <label class="check small"><input type="checkbox" data-disk="${i}:remove"${k.remove ? ' checked' : ''}> ${t('Detach')}</label></div>`).join('')}
          ${st.add.map((k, i) => `<div class="cf-row disk-row is-new">
            <div><div class="row-title">${t('New disk')}</div><div class="row-sub">${t('Goes in {dir}', { dir: esc(opts.vmDir) })}</div></div>
            <label class="disk-size"><input class="field" type="number" min="1" max="16384" step="1" data-add="${i}:sizeGb" value="${esc(k.sizeGb)}" aria-label="${t('Size in GB')}"> GB</label>
            <div class="disk-new-side"><select class="field cf-small" data-add="${i}:bus" aria-label="${t('Interface')}"><option value="virtio"${k.bus !== 'sata' ? ' selected' : ''}>virtio</option><option value="sata"${k.bus === 'sata' ? ' selected' : ''}>SATA</option></select>
            <button class="cf-del" type="button" data-add-del="${i}" aria-label="${t('Remove')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div></div>`).join('')}</div>
        <div class="btn-row"><button class="btn sm" type="button" data-add-disk${st.add.length >= 4 ? ' disabled' : ''}>+ ${t('Disk')}</button></div>
        <p class="muted small">${t('A disk can only grow. Afterwards, also grow the partition inside the VM. Detach removes the disk from the VM; the file stays.')}</p>
        <div class="fld-row">
          <label class="fld"><span>${t('CD-ROM')}</span><select class="field" name="cdrom">
            <option value="">${t('Empty')}</option>
            ${cur && !isoKnown ? `<option value="=" selected>${esc(cur)}</option>` : ''}
            ${opts.isos.map((f) => `<option value="${esc(f.name)}"${f.name === curIso ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
            <small>${t('ISOs from {dir}', { dir: esc(opts.isoDir) })}</small></label>
          <label class="fld"><span>${t('Boot from')}</span><select class="field" name="boot">
            <option value="disk"${d.boot !== 'cdrom' ? ' selected' : ''}>${t('Disk first')}</option>
            <option value="cdrom"${d.boot === 'cdrom' ? ' selected' : ''}>${t('CD-ROM first')}</option></select>
            <small>${t('Choose the CD-ROM to install an operating system.')}</small></label>
        </div>`;
    };

    /* Devices: USB and PCI */
    const drawDevices = () => {
      const usb = [...opts.usb];
      [...st.hostdevs].filter((k) => k.startsWith('usb:') && !usb.some((u) => u.key === k)).forEach((k) => usb.push({ key: k, name: k.slice(4), missing: true }));
      const busy = (p) => p.driver && !/^vfio/.test(p.driver);
      const pciMissing = [...st.hostdevs].filter((k) => k.startsWith('pci:') && !opts.pci.some((p) => p.key === k));
      pane('devices').innerHTML = `
        <h3>${t('USB')}</h3>
        <div class="dev-list">${usb.map((u) => `<label class="check dev"><input type="checkbox" data-dev="${esc(u.key)}"${st.hostdevs.has(u.key) ? ' checked' : ''}>
            <span><b>${esc(u.name)}</b> <span class="muted small">${esc(u.vendor ? u.vendor + ':' + u.product : '')}${u.missing ? ' · ' + t('not plugged in') : ''}</span></span></label>`).join('')
          || `<p class="muted">${t('No USB devices found. Plug one in and open this window again.')}</p>`}</div>
        <p class="muted small">${t('For example a Zigbee or Z-Wave stick for Home Assistant. The VM gets the device to itself.')}</p>
        <h3>${t('PCI')}</h3>
        ${!opts.iommu ? `<p class="lead">${t('IOMMU is off. Turn on AMD-Vi (IOMMU) in the BIOS and restart the server to pass through PCI devices such as a GPU.')}</p>` : `
        <div class="dev-list">${opts.pci.map((p) => `<label class="check dev"><input type="checkbox" data-dev="${esc(p.key)}"${st.hostdevs.has(p.key) ? ' checked' : ''}>
            <span><b>${esc(p.name)}</b> <span class="muted small">${esc([t(p.kind), p.address, p.group != null ? t('group {n}', { n: p.group }) : null].filter(Boolean).join(' · '))}</span>
            ${busy(p) ? `<span class="small temp-warn">${t('Now in use by the server (driver {driver}).', { driver: esc(p.driver) })}${p.kind === 'Display' ? ' ' + t('If you pass it through, the server cannot use it while the VM runs (e.g. Ollama).') : ''}</span>` : ''}
            ${p.groupDevices.length ? `<span class="small muted">${t('Is in the same group as {list}. Pass them through together.', { list: esc(p.groupDevices.map((g) => g.name).join(', ')) })}</span>` : ''}</span></label>`).join('')}
          ${pciMissing.map((k) => `<label class="check dev"><input type="checkbox" data-dev="${esc(k)}" checked><span><b>${esc(k.slice(4))}</b> <span class="muted small">${t('not found')}</span></span></label>`).join('')}</div>`}`;
    };

    drawCpu(); drawNet(); drawStorage(); drawDevices();
    /* Snapshots: carried out right away, not through Save */
    const snapPane = pane('snapshots');
    async function drawSnaps() {
      snapPane.innerHTML = `<p class="muted">${t('Loading…')}</p>`;
      let r;
      try { r = await api.get('/api/vms/' + encodeURIComponent(id) + '/snapshots'); }
      catch (ex) { snapPane.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
      if (!snapPane.isConnected) return;
      const on = vmKind(d.state) === 'on';
      snapPane.innerHTML = `
        <p class="muted small">${t('A snapshot captures the VM as it is now. If you go back later, everything that changed afterwards is gone. Handy before an update. A snapshot is not a backup: it is on the same disk.')}</p>
        <div class="fld-row">
          <label class="fld"><span>${t('Name')}</span><input class="field" data-snap="name" maxlength="48" spellcheck="false" autocomplete="off" placeholder="${t('e.g. before-update')}"><small>${t('Empty = the date and time.')}</small></label>
          <label class="fld"><span>${t('Description')} <em class="muted">${t('(optional)')}</em></span><input class="field" data-snap="description" maxlength="200"></label>
        </div>
        ${on ? `<label class="check"><input type="checkbox" data-snap="diskOnly"> ${t('Disks only (faster, without memory)')}</label>
          <p class="muted small" style="margin-top:-6px">${t('With memory, the VM continues where it was after restoring. Without, it is as if the power failed at that moment.')}</p>` : ''}
        <div class="btn-row"><button class="btn primary" type="button" data-snap-make>${t('Create snapshot')}</button></div>
        <ul class="rows">${r.snapshots.map((x) => `<li>
            <div><div class="row-title">${esc(x.name)}${x.current ? ` <span class="pill ok">${t('now')}</span>` : ''} <span class="pill">${t(x.memory ? 'with memory' : x.state === 'shutoff' ? 'switched off' : 'disks only')}</span></div>
              <div class="row-sub">${esc([x.created ? new Date(x.created).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short', ...clockOpts() }) : '', x.description].filter(Boolean).join(' · '))}</div></div>
            <div class="row-side btn-row"><button class="btn sm" type="button" data-snap-revert="${esc(x.name)}">${t('Restore')}</button>
              <button class="btn sm danger" type="button" data-snap-del="${esc(x.name)}">${t('Remove')}</button></div></li>`).join('')
          || `<li><span class="muted">${t('No snapshots yet.')}</span></li>`}</ul>`;
    }
    snapPane.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const base = '/api/vms/' + encodeURIComponent(id) + '/snapshots';
      if (b.dataset.snapMake != null) {
        const v = (k) => $(`[data-snap="${k}"]`, snapPane);
        const bodyS = { name: v('name').value.trim(), description: v('description').value, diskOnly: v('diskOnly') ? v('diskOnly').checked : false };
        return withBusy(b, async () => { const r = await api.post(base, bodyS); toast(t('Snapshot {name} created.', { name: r.name })); drawSnaps(); });
      }
      if (b.dataset.snapRevert) {
        const n = b.dataset.snapRevert;
        if (!(await ask(t('Restore {vm} to {name}? Everything that changed in the VM since then is gone.', { vm: d.name, name: n }), t('Restore')))) return;
        return withBusy(b, async () => { await api.post(base + '/' + encodeURIComponent(n) + '/revert', {}); toast(t('{vm} is back at {name}.', { vm: d.name, name: n })); drawSnaps(); loadVms().catch(() => {}); });
      }
      if (b.dataset.snapDel) {
        const n = b.dataset.snapDel;
        if (!(await ask(t('Remove snapshot {name}? The VM itself doesn\'t change; you just can\'t go back to this moment anymore.', { name: n }), t('Remove')))) return;
        return withBusy(b, async () => { await api.del(base + '/' + encodeURIComponent(n)); toast(t('Snapshot {name} removed.', { name: n })); drawSnaps(); });
      }
    });
    // Enter in a snapshot field doesn't submit the VM's form, but creates the snapshot.
    snapPane.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); const mk = $('[data-snap-make]', snapPane); if (mk && !mk.disabled) mk.click(); } });
    let snapsLoaded = false;
    const showTab = (k) => {
      $$('[data-vtab]', body).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.vtab === k)));
      $$('[data-vpane]', body).forEach((p) => { p.hidden = p.dataset.vpane !== k; });
      $('[data-vsave]', form).hidden = k === 'snapshots';
      if (k === 'snapshots' && !snapsLoaded) { snapsLoaded = true; drawSnaps(); }
    };
    showTab(tab);
    wireAutostart(form);

    body.addEventListener('click', (e) => {
      const tb = e.target.closest('[data-vtab]'); if (tb) { showTab(tb.dataset.vtab); return; }
      if (e.target.closest('a[href^="#settings"]')) { win.close(); return; }
      if (e.target.closest('[data-pin-clear]')) { st.pins.clear(); drawCpu(); return; }
      if (e.target.closest('[data-nic-add]')) {
        const first = opts.bridges[0] ? { type: 'bridge', source: opts.bridges[0].name } : { type: 'network', source: (opts.networks[0] || {}).name || 'default' };
        st.nics.push({ ...first, model: 'virtio', mac: '' }); drawNet(); return;
      }
      const nd = e.target.closest('[data-nic-del]'); if (nd) { st.nics.splice(Number(nd.dataset.nicDel), 1); drawNet(); return; }
      if (e.target.closest('[data-add-disk]')) { st.add.push({ sizeGb: 32, bus: 'virtio' }); drawStorage(); return; }
      const ad = e.target.closest('[data-add-del]'); if (ad) { st.add.splice(Number(ad.dataset.addDel), 1); drawStorage(); }
    });
    body.addEventListener('change', (e) => {
      const tg = e.target;
      if (tg.dataset.pin != null) { if (tg.checked) st.pins.add(Number(tg.dataset.pin)); else st.pins.delete(Number(tg.dataset.pin)); drawCpu(); return; }
      if (tg.dataset.dev) { if (tg.checked) st.hostdevs.add(tg.dataset.dev); else st.hostdevs.delete(tg.dataset.dev); return; }
      if (tg.dataset.disk) { const [i, k] = tg.dataset.disk.split(':'); st.disks[i][k] = k === 'remove' ? tg.checked : tg.value; if (k === 'remove') drawStorage(); return; }
    });
    body.addEventListener('input', (e) => {
      const tg = e.target;
      if (tg.dataset.nic) {
        const [i, k] = tg.dataset.nic.split(':');
        if (k === 'net') { const [type, ...rest] = tg.value.split(':'); st.nics[i].type = type; st.nics[i].source = rest.join(':'); } else st.nics[i][k] = tg.value;
      } else if (tg.dataset.add) { const [i, k] = tg.dataset.add.split(':'); st.add[i][k] = tg.value; }
      else if (tg.dataset.disk) { const [i, k] = tg.dataset.disk.split(':'); if (k === 'sizeGb') st.disks[i].sizeGb = tg.value; }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('[type=submit]', form), err = $('.form-error', form);
      err.textContent = '';
      const badMac = st.nics.find((n) => !n.locked && n.mac && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(n.mac.trim()));
      if (badMac) { showTab('net'); err.textContent = t('"{mac}" is not a valid MAC address, e.g. 52:54:00:12:34:56.', { mac: badMac.mac }); return; }
      const small = st.disks.find((k) => !k.remove && k.size && Number(k.sizeGb) * GIB < k.size);
      if (small) { showTab('storage'); err.textContent = t('A disk can only grow. {disk} is now {size} GB.', { disk: small.target, size: Math.ceil(small.size / GIB) }); return; }
      const out = readForm(form);
      Object.assign(out, {
        nics: st.nics.map((n) => (n.locked ? { id: n.id, locked: true } : { id: n.id || null, type: n.type, source: n.source, model: n.model, mac: n.mac.trim() })),
        hostdevs: [...st.hostdevs], cpuPins: [...st.pins].sort((a, b) => a - b),
        removeDisks: st.disks.filter((k) => k.remove).map((k) => k.target),
        resizeDisks: st.disks.filter((k) => !k.remove && k.sizeGb && (!k.size || Number(k.sizeGb) * GIB > k.size)).map((k) => ({ target: k.target, sizeGb: Number(k.sizeGb) })),
        addDisks: st.add.map((k) => ({ sizeGb: Number(k.sizeGb), bus: k.bus })),
      });
      if (out.removeDisks.length && !(await ask(t('Detach {n} disk(s) from {name}? The files stay, but the VM no longer sees them.', { n: out.removeDisks.length, name: d.name }), t('Detach')))) return;
      btn.disabled = true;
      try {
        const r = await api.post('/api/vms/' + encodeURIComponent(d.id) + '/settings', out);
        toast(t('Saved: {name}', { name: r.name }) + (r.restartNeeded ? '. ' + t('Shut the VM down and start it again to use the new settings.') : ''));
        win.close();
        await loadVms().catch(() => {});
      } catch (ex) { err.textContent = t('Saving failed: {error}', { error: ex.message }); btn.disabled = false; }
    });
  }

  const VM_KINDS = {
    linux: { label: 'Linux', help: 'Install Linux from an ISO, for example Debian or Ubuntu Server.', vcpus: 2, memoryGb: 4, diskGb: 32 },
    windows: { label: 'Windows 11', help: 'Windows 11 with TPM and UEFI. The disk uses SATA so the installer sees it right away.', vcpus: 4, memoryGb: 8, diskGb: 64 },
    import: { label: 'Existing disk', help: 'Use an existing disk file, such as the qcow2 file of Home Assistant OS. HomeBaseOS makes a copy of it.', vcpus: 2, memoryGb: 4 },
  };
  async function vmCreateWindow() {
    openWindow(t('New VM'), `<p class="lead">${t('Loading…')}</p>`);
    let opts;
    try { opts = await vmOptions(); } catch (e) { $('#winBody').innerHTML = `<p class="lead">${esc(e.message)}</p>`; return; }
    let kind = 'linux';
    const draw = (keep) => {
      const k = VM_KINDS[kind];
      const files = kind === 'import' ? opts.images : opts.isos;
      const fileLabel = t(kind === 'import' ? 'Disk file' : 'Installation ISO');
      const blocked = opts.vmDirMissing || !files.length;
      $('#winBody').innerHTML = `
        <div class="seg kind-seg" role="radiogroup" aria-label="${t('Kind of VM')}">${Object.entries(VM_KINDS).map(([key, v]) =>
          `<button type="button" role="radio" aria-checked="${key === kind}" data-kind="${key}">${esc(t(v.label))}</button>`).join('')}</div>
        <p class="lead" style="margin-top:12px">${esc(t(k.help))}</p>
        ${opts.vmDirMissing ? `<p class="lead temp-bad">${t('The folder for VM disks ({dir}) does not exist. Create a pool in Storage first, or choose a folder in Settings → Storage.', { dir: esc(opts.vmDir) })}</p>` : ''}
        <form class="form" id="vmForm" novalidate>
          <input type="hidden" name="kind" value="${kind}">
          <label class="fld"><span>${fileLabel}</span>
            ${files.length ? `<select class="field" name="source" required>${files.map((f) =>
              `<option value="${esc(f.name)}"${keep && keep.source === f.name ? ' selected' : ''}>${esc(f.name)} (${bytes(f.size)})</option>`).join('')}</select>`
            : `<p class="muted small">${t(kind === 'import' ? 'There are no disk files (.qcow2, .img, .raw) in {dir} yet.' : 'There are no ISO files in {dir} yet.', { dir: esc(opts.isoDir) })}
                ${t('Put one there, for example via the shared folder or with scp, and open this window again.')}</p>`}
            <small>${t('From {dir}', { dir: esc(opts.isoDir) })}</small></label>
          ${(() => { const v = { name: keep ? keep.name : '', vcpus: k.vcpus, memory: k.memoryGb * 1073741824, diskGb: k.diskGb, autostart: false, delay: 0,
            description: keep ? keep.description : '' }; return vmNameField(v) + vmSizeFields(v, opts) + `
          <label class="fld"><span>${t('Network')}</span><select class="field" name="network">${vmNetOptions(opts, keep && keep.network || opts.network)}</select>
            <small>${t(VM_NET_HELP)}</small></label>` + vmDescAutoFields(v); })()}
          <p class="muted small">${t('The VM starts right after it is created. Change network cards, disks and devices afterwards in Edit.')}</p>
          <p class="form-error" role="alert"></p>
          <div class="btn-row"><button class="btn primary" type="submit"${blocked ? ' disabled' : ''}>${t('Create')}</button><button class="btn" type="button" data-close>${t('Cancel')}</button></div>
        </form>`;
      wireAutostart($('#vmForm'));
    };
    draw();
    const body = $('#winBody');
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-kind]'); if (!b || b.dataset.kind === kind) return;
      const f = $('#vmForm');
      const keep = { name: f.elements.name.value, description: f.elements.description.value, source: f.elements.source && f.elements.source.value, network: f.elements.network.value };
      kind = b.dataset.kind; draw(keep);
    });
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target, btn = $('[type=submit]', form), err = $('.form-error', form);
      err.textContent = ''; btn.disabled = true; btn.textContent = t('Creating…');
      try {
        const r = await api.post('/api/vms', readForm(form));
        toast(t('Created and started: {name}', { name: r.name }));
        await loadVms().catch(() => {});
        vmEditWindow(r.name, 'screen'); // straight to the console to do the installation
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = t('Create'); }
    });
  }

  /* --- app store (own page at #store) */
  const STORE_PAGE = 48;
  let storeLoading = null;
  function loadStore(refresh) {
    if (S.store && !refresh) { renderStore(); return Promise.resolve(); }
    if (storeLoading) return storeLoading;
    $('#storeMore').hidden = true;
    $('#storeGrid').innerHTML = `<p class="empty">${t(refresh ? 'Refreshing the catalogue…' : 'Loading the catalogue…')}</p>`;
    storeLoading = api.get('/api/store' + (refresh ? '?refresh=1' : ''))
      .then((c) => {
        S.store = c;
        const sel = $('#storeCat'), cur = sel.value;
        sel.innerHTML = `<option value="featured">${t('Recommended')}</option><option value="all">${t('All apps')}</option>` +
          c.categories.map((k) => `<option value="${esc(k.id)}">${esc(t(k.name))}</option>`).join('');
        sel.value = cur;
        renderStore();
      })
      .catch((e) => {
        $('#storeGrid').innerHTML = `<div class="empty"><p>${esc(e.message)}</p>
          <button class="btn sm" type="button" data-store-retry style="margin-top:12px">${t('Try again')}</button></div>`;
      })
      .finally(() => { storeLoading = null; });
    return storeLoading;
  }

  function storeIconHtml(a) {
    const letter = esc(prettyName(a.name).charAt(0).toUpperCase());
    if (a.icon) return `<span class="app-icon store-icon" data-letter="${letter}" data-color="${colorFor(a.name)}"><img src="${esc(a.icon)}" alt="" loading="lazy"></span>`;
    return `<span class="app-icon store-icon" style="background:${colorFor(a.name)}">${letter}</span>`;
  }

  function storeResults() {
    const c = S.store; const q = S.storeQuery.trim().toLowerCase(); const cat = S.storeCat;
    let list = c.apps.filter((a) => (cat === 'featured' ? (q ? true : a.featured) : cat === 'all' ? true : a.categories.includes(cat)));
    if (!q) return list.sort((a, b) => (b.featured - a.featured) || (b.popularity - a.popularity) || a.name.localeCompare(b.name));
    const score = (a) => {
      const n = a.name.toLowerCase(), p = prettyName(a.name).toLowerCase();
      if (n === q || p === q) return 0;
      if (n.startsWith(q) || p.startsWith(q)) return 1;
      if (n.includes(q) || p.includes(q)) return 2;
      if ((a.summary + ' ' + a.maintainer + ' ' + a.image).toLowerCase().includes(q)) return 3;
      return 9;
    };
    return list.map((a) => [score(a), a]).filter(([s]) => s < 9)
      .sort((x, y) => (x[0] - y[0]) || (y[1].featured - x[1].featured) || (y[1].popularity - x[1].popularity)).map(([, a]) => a);
  }

  function renderStore() {
    const c = S.store; if (!c || $('#storePage').hidden) return;
    const when = new Date(c.updated).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
    $('#storeCount').textContent = t('{n} apps', { n: nf0.format(c.count) });
    $('#storeSource').innerHTML = `${t('Catalogue from {source}, updated on {when}. The templates come from their own maintainers.', { source: esc(tr(c.source)), when: esc(when) })}
      ${c.error ? `<span class="temp-warn">${t('Refreshing failed ({error}); this is the previous version.', { error: esc(tr(c.error)) })}</span>` : ''}
      <button class="linkish" type="button" data-store-refresh>${t('Refresh now')}</button>`;
    const list = storeResults();
    const shown = list.slice(0, S.storeShown);
    $('#storeGrid').innerHTML = shown.length ? shown.map((a) => `
      <button class="widget store-card" type="button" data-store="${esc(a.id)}">
        ${storeIconHtml(a)}
        <span class="store-body">
          <span class="store-name">${esc(prettyName(a.name))}${a.installed ? ` <span class="pill ok">${t('Installed')}</span>` : ''}${a.beta ? ' <span class="pill warn">Beta</span>' : ''}</span>
          <span class="store-by">${esc([a.maintainer, a.official ? t('official') : null].filter(Boolean).join(' · '))}</span>
          <span class="store-sum">${esc(tr(a.summary))}</span>
        </span>
      </button>`).join('')
      : `<p class="empty">${S.storeQuery ? t('No apps found for "{q}".', { q: esc(S.storeQuery) }) : t('No apps in this category.')}</p>`;
    const more = $('#storeMore');
    more.hidden = list.length <= shown.length;
    more.textContent = t('Show more ({n} left)', { n: nf0.format(list.length - shown.length) });
  }

  $('#storeSearch').addEventListener('input', (e) => { S.storeQuery = e.target.value; S.storeShown = STORE_PAGE; renderStore(); });
  $('#storeCat').addEventListener('change', (e) => { S.storeCat = e.target.value; S.storeShown = STORE_PAGE; renderStore(); });
  $('#storeMore').addEventListener('click', () => { S.storeShown += STORE_PAGE; renderStore(); });
  $('#storePage').addEventListener('click', (e) => {
    if (e.target.closest('[data-store-retry]')) return loadStore();
    if (e.target.closest('[data-store-refresh]')) return loadStore(true);
    const card = e.target.closest('[data-store]');
    if (card) storeWindow(card.dataset.store);
  });

  const FIELD_GROUPS = [['Port', 'Ports'], ['Path', 'Folders'], ['Device', 'Devices'], ['Variable', 'Settings'], ['Label', 'Labels']];
  function storeFieldHtml(f, d) {
    const ro = /^ro\b|^r$/.test(f.mode);
    const where = f.type === 'Port' ? t('Port in the app: {port}', { port: f.target + '/' + (f.mode || 'tcp') })
      : f.type === 'Path' ? t(ro ? 'In the app: {path} (read only)' : 'In the app: {path}', { path: f.target })
      : f.type === 'Variable' || f.type === 'Label' ? f.target : t('Device on the server');
    const attrs = `name="${esc(f.key)}"${f.required ? ' required' : ''}${f.auto ? ' data-auto="1"' : ''}${f.type === 'Port' ? ' data-port="1"' : ''}${f.type === 'Path' ? ' data-path="1"' : ''}`;
    const input = f.options
      ? `<select class="field" ${attrs}>${f.options.map((o) => `<option${o === f.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
      : `<input class="field" ${attrs} type="${f.type === 'Port' ? 'number' : f.mask ? 'password' : 'text'}" value="${esc(f.value)}" autocomplete="off"
          ${f.type === 'Port' ? 'min="1" max="65535"' : ''}${f.type === 'Path' && !f.value ? ` placeholder="${t('e.g. {path}', { path: esc(d.sharesDir) + '/media' })}"` : ''}>`;
    return `<label class="fld"><span>${esc(tr(f.name))}${f.required ? ' <em class="req">*</em>' : ''}</span>${input}
      <small>${esc([tr(f.description), where].filter(Boolean).join(' · '))}</small></label>`;
  }
  // Does the app get ports on the server? Not with host, no network or its own address (macvlan/ipvlan).
  function storeNetPorts(d, value) {
    const n = (d.networks || []).find((x) => x.name === value);
    return !['host', 'none', LAN_CHOICE].includes(value) && !ownNet(n);
  }
  // Fill in a free address in the home network (once per form) when "own address" is chosen and the field is still empty.
  async function suggestLanIp(input, small) {
    if (input.value.trim() || input.dataset.suggested) return;
    input.dataset.suggested = '1';
    small.textContent = t('Looking for a free address…');
    try {
      const r = await api.get('/api/docker-networks/lan');
      if (!input.value.trim() && r.suggestion) { input.value = r.suggestion; input.dispatchEvent(new Event('input', { bubbles: true })); }
      small.textContent = r.home ? t('Free in {subnet} (through {card}). Reserve this address in your router, so it doesn\'t give it to another device.', { subnet: r.home.subnet, card: r.home.name })
        : t('HomeBaseOS can\'t find your home network. Create a macvlan network in Settings → Docker networks.');
    } catch (e) { small.textContent = e.message; }
  }
  // "Own address in my home network": an existing macvlan/ipvlan network, or LAN_CHOICE (HomeBaseOS creates it on install).
  const LAN_CHOICE = '@lan';
  const ownNet = (n) => n && /^(macvlan|ipvlan)$/.test(n.driver);
  const netLabel = (n) => (ownNet(n) ? t('Own address in my home network ({name})', { name: n.name }) : [n.name, n.driver, n.subnet].filter(Boolean).join(' · '));
  function storeNetHtml(d) {
    const nets = d.networks || [];
    const opts = [['bridge', t('Default (bridge)')], ['host', t('Host (the server\'s network)')],
      ...(nets.some(ownNet) ? [] : [[LAN_CHOICE, t('Own address in my home network')]]),
      ...nets.map((n) => [n.name, netLabel(n)])];
    return `<h3>${t('Network')}</h3><div class="form">
      <label class="fld"><span>${t('Network')}</span><select class="field" name="__network">${opts.map(([v, label]) =>
        `<option value="${esc(v)}"${v === d.networkDefault ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
        <small id="storeNetHelp"></small></label>
      <label class="fld" data-store-ip><span>${t('Fixed IP address (optional)')}</span><input class="field" name="__ip" spellcheck="false" autocomplete="off">
        <small>${t('Empty = Docker picks an address.')}</small></label></div>`;
  }
  function storeSections(fields, d) {
    return FIELD_GROUPS.map(([type, title]) => {
      const list = fields.filter((f) => f.type === type);
      return list.length ? `<h3>${t(title)}</h3><div class="form">${list.map((f) => storeFieldHtml(f, d)).join('')}</div>` : '';
    }).join('');
  }

  /* --- installing apps: folder for the data, and advanced (all fields or the code) */
  // A path under `from` moves to `to` (the rest of the path stays): /fast/appdata/x/config → /tank/apps/x/config.
  const rebasePath = (p, from, to) => (from && to && (p === from || String(p).startsWith(from + '/')) ? to + String(p).slice(from.length) : p);
  function dataDirHtml(d, name) {
    return `<label class="fld" data-datadir><span>${t('Data folder')}</span>
      <input class="field" name="__datadir" list="appFolders" value="${esc(d.appdataDir + '/' + name)}" spellcheck="false" autocomplete="off">
      <datalist id="appFolders">${(d.folders || []).map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
      <small>${t('Where the app keeps its settings and data. All folders below that are inside this folder move along. You can also change each folder separately.')}</small></label>`;
  }
  const advToggleHtml = () => `<label class="check adv-switch"><input type="checkbox" name="__adv">
      <span><b>${t('Advanced')}</b> <span class="muted small">${t('Set every option yourself: image, restart, network, and add your own ports, folders, variables, devices and labels. Or edit the compose file as code.')}</span></span></label>`;

  // The full container form (like in an app's settings) or the code. The draft goes back and forth
  // through the server (/api/apps/draft), so fields and code are always the same file and nothing gets lost.
  async function advancedEditor(box, name, start) {
    box.innerHTML = `<p class="muted">${t('Loading…')}</p>`;
    const r = await api.post('/api/apps/draft', { name, ...start });
    let text = r.text, form = r.form, mode = form ? 'fields' : 'code';
    box.innerHTML = `
      <div class="adv-bar"><div class="seg" role="radiogroup" aria-label="${t('View')}">
        <button type="button" role="radio" aria-checked="${mode === 'fields'}" data-advmode="fields"${form ? '' : ' disabled'}>${t('Fields')}</button>
        <button type="button" role="radio" aria-checked="${mode === 'code'}" data-advmode="code">${t('Code')}</button></div>
        <span class="muted small" data-adv-note></span></div>
      <div data-adv-fields></div>
      <div data-adv-code hidden><textarea class="field code" rows="22" spellcheck="false" aria-label="${t('Compose file')}"></textarea>
        <small class="muted">${t('Exactly this file is installed. Docker Compose checks it first.')}</small></div>
      <p class="form-error" data-adv-err role="alert"></p>`;
    const area = $('textarea', box), err = $('[data-adv-err]', box);
    const mountFields = () => {
      // A new element: composeFormMount attaches its listeners to the element itself.
      const old = $('[data-adv-fields]', box), el = old.cloneNode(false);
      old.replaceWith(el);
      if (form) composeFormMount(el, form, r.dockerNetworks || []);
    };
    const show = () => {
      $('[data-adv-fields]', box).hidden = mode !== 'fields'; $('[data-adv-code]', box).hidden = mode !== 'code';
      $$('[data-advmode]', box).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.advmode === mode)));
      $('[data-adv-note]', box).textContent = form ? '' : t('This file doesn\'t fit the form ({error}); you can still edit it as code.', { error: tr(r.formError || '') });
      box.dispatchEvent(new CustomEvent('advmode', { bubbles: true, detail: mode }));
    };
    area.value = text; mountFields(); show();
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-advmode]'); if (!b || b.dataset.advmode === mode || b.disabled) return;
      err.textContent = '';
      try {
        if (b.dataset.advmode === 'code') {
          const problem = composeFormCheck(form); if (problem) { err.textContent = problem; return; }
          text = (await api.post('/api/apps/draft', { name, text, form })).text; area.value = text; mode = 'code';
        } else {
          const x = await api.post('/api/apps/draft', { name, text: area.value });
          if (!x.form) { err.textContent = t('This code doesn\'t fit the form ({error}). Stay in the code, or change it.', { error: tr(x.formError || '') }); return; }
          text = x.text; form = x.form; mountFields(); mode = 'fields';
        }
        show();
      } catch (ex) { err.textContent = ex.message; }
    });
    return {
      mode: () => mode,
      // Move the data folder in the fields (in the code you change it yourself).
      rebase(from, to) {
        if (!form) return;
        form.volumes.forEach((v, i) => {
          if (v.locked) return;
          const h = rebasePath(v.host, from, to);
          if (h !== v.host) { v.host = h; const inp = $(`[data-cf="volumes:${i}:host"]`, box); if (inp) inp.value = h; }
        });
      },
      // The file to install.
      async finalText() {
        if (mode === 'code') return area.value;
        const problem = composeFormCheck(form); if (problem) throw new Error(problem);
        return (await api.post('/api/apps/draft', { name, text, form })).text;
      },
    };
  }

  async function storeWindow(id) {
    openWindow(t('App'), `<p class="lead">${t('Loading…')}</p>`);
    let d;
    try { d = await api.get('/api/store/apps/' + encodeURIComponent(id)); }
    catch (e) { $('#winBody').innerHTML = `<p class="lead">${t('The app could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    $('#winTitle').textContent = prettyName(d.name);
    // Always show required fields without a value, even if the template calls them "advanced".
    const basic = d.fields.filter((f) => !f.advanced || (f.required && !f.value));
    const adv = d.fields.filter((f) => !basic.includes(f));
    const links = [d.project && `<a href="${esc(d.project)}" target="_blank" rel="noopener">${t('Website')}</a>`,
      d.support && `<a href="${esc(d.support)}" target="_blank" rel="noopener">${t('Support')}</a>`].filter(Boolean).join(' · ');
    const body = $('#winBody');
    body.innerHTML = `
      <div class="store-head">${storeIconHtml(d)}
        <div><p class="store-by">${esc([d.maintainer, d.official ? t('official') : null].filter(Boolean).join(' · '))}</p>
          ${links ? `<p class="small">${links}</p>` : ''}</div>
      </div>
      <p class="store-overview">${esc(tr(d.overview))}</p>
      ${d.requires ? `<p class="lead"><b>${t('Requires:')}</b> ${esc(tr(d.requires))}</p>` : ''}
      ${d.installed ? `<p class="lead temp-ok">${t('This app is already on your server. You can install it again under another name.')}</p>` : ''}
      ${d.warnings.length ? `<ul class="warn-list">${d.warnings.map((w) => `<li>${esc(tr(w))}</li>`).join('')}</ul>` : ''}
      ${d.appdataMissing ? `<p class="lead temp-bad">${t('There is no folder for app data yet ({dir}). Create a pool in Storage first, or choose a folder in Settings → Storage.', { dir: esc(d.appdataDir) }) + ` <a href="#settings/storage">${t('Open Settings → Storage')}</a>`}</p>` : ''}
      <form class="form" id="storeForm" novalidate>
        <label class="fld"><span>${t('Name')} <em class="req">*</em></span>
          <input class="field" name="__name" required maxlength="63" autocomplete="off" value="${esc(d.suggestedName)}">
          <small>${t('Lowercase letters, digits, - and _. Becomes the name of the container and of the folder {dir}/name.', { dir: esc(d.stacksDir) })}</small></label>
        ${dataDirHtml(d, d.suggestedName)}
        ${advToggleHtml()}
        <div class="form" data-basic>
        ${storeNetHtml(d)}
        ${storeSections(basic, d)}
        <div class="cf-list" id="storeExtra"></div>
        <div class="btn-row"><button class="btn sm" type="button" data-xport-add>+ ${t('Port')}</button></div>
        ${adv.length ? `<details class="adv"><summary>${t('More settings ({n})', { n: adv.length })}</summary>${storeSections(adv, d)}</details>` : ''}
        </div>
        <div data-advanced hidden></div>
        <p class="muted small">${t('Image: {image}. HomeBaseOS turns it into a compose file that you can later open in Dockge too.', { image: esc(d.image) })}</p>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit"${d.appdataMissing ? ' disabled' : ''}>${t('Install')}</button>
          <button class="btn" type="button" data-close>${t('Cancel')}</button></div>
      </form>
      ${jobHtml()}`;
    const form = $('#storeForm', body);
    const syncNet = () => {
      const v = form.elements.__network.value, n = (d.networks || []).find((x) => x.name === v), ports = storeNetPorts(d, v);
      // A fixed address: in a network with its own subnet, or on the default network (then the app joins the shared homebase network).
      const lan = v === LAN_CHOICE || ownNet(n);
      const ipOk = v === 'bridge' || lan || !!(n && n.subnet);
      $('[data-store-ip]', form).hidden = !ipOk;
      if (!ipOk) form.elements.__ip.value = '';
      form.elements.__ip.placeholder = n && n.subnet ? n.subnet.replace(/\.\d+\/\d+$/, '.200') : v === 'bridge' ? '172.30.0.10' : '';
      $('[data-store-ip] small', form).textContent = v === 'bridge' ? t('Empty = Docker picks an address. With an address the app joins the HomeBaseOS network homebase (172.30.0.0/16), where apps also find each other by name.')
        : t('Empty = Docker picks an address.');
      if (lan) suggestLanIp(form.elements.__ip, $('[data-store-ip] small', form));
      $('#storeNetHelp', form).textContent = switched && v === 'bridge' ? t('You added an extra port, so the app now uses the default network (bridge): only there Docker can publish extra ports.')
        : v === 'host' ? t('The app uses the server\'s network and listens on its own ports. If you change a port below, HomeBaseOS sets the app\'s own port setting (when the template has one) and the WebUI follows.')
        : v === LAN_CHOICE ? t('The app gets its own address in your home network, like a separate device, and is reachable there on its own ports. HomeBaseOS sets up the network the first time. The server itself can\'t reach the app at that address (a Linux limitation); your other devices can.')
        : !ports ? t('The app gets its own address in your home network and is reachable there on the app\'s own ports. If you change a port below, HomeBaseOS sets the app\'s own port setting (when the template has one).')
        : n ? t('Apps in the same network find each other by name.') : t('Create new networks in Settings → Docker networks.');
    };
    let switched = false;
    form.elements.__network.addEventListener('change', () => { switched = false; syncNet(); });
    // Extra ports can only be published by Docker on a network with ports: then switch to the default network.
    // Changing a template port doesn't switch: with host or an own address it becomes the app's own port (see buildCompose).
    const needPorts = () => {
      if (storeNetPorts(d, form.elements.__network.value)) return;
      form.elements.__network.value = 'bridge'; switched = true; syncNet();
    };
    syncNet();
    // Extra ports that aren't in the template.
    const extra = [];
    const drawExtra = (focus) => {
      $('#storeExtra', form).innerHTML = extra.length ? `<h3>${t('Extra ports')}</h3>` + extra.map((p, i) => `<div class="cf-row cf-pair">
          <input class="field" data-xport="${i}:host" value="${esc(p.host)}" inputmode="numeric" placeholder="${t('on the server')}" aria-label="${t('Port on the server')}"><span class="cf-sep">→</span>
          <input class="field" data-xport="${i}:container" value="${esc(p.container)}" inputmode="numeric" placeholder="${t('in the app')}" aria-label="${t('Port in the app')}">
          <select class="field cf-small" data-xport="${i}:protocol" aria-label="Protocol"><option${p.protocol !== 'udp' ? ' selected' : ''}>tcp</option><option${p.protocol === 'udp' ? ' selected' : ''}>udp</option></select>
          <button class="cf-del" type="button" data-xport-del="${i}" aria-label="${t('Remove')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('') : '';
      if (focus) { const x = $(`[data-xport="${focus}:host"]`, form); if (x) x.focus(); }
    };
    form.addEventListener('click', (e) => {
      if (e.target.closest('[data-xport-add]')) { needPorts(); extra.push({ host: '', container: '', protocol: 'tcp' }); drawExtra(extra.length - 1); return; }
      const del = e.target.closest('[data-xport-del]'); if (del) { extra.splice(Number(del.dataset.xportDel), 1); drawExtra(); }
    });
    form.addEventListener('input', (e) => { if (!e.target.dataset.xport) return; const [i, k] = e.target.dataset.xport.split(':'); extra[i][k] = e.target.value; });
    form.addEventListener('change', (e) => { if (e.target.dataset.xport) e.target.dispatchEvent(new Event('input', { bubbles: true })); });
    // The data folder follows the name (as long as you didn't choose it yourself), and all folders below follow the data folder.
    let lastName = d.suggestedName, curDir = form.elements.__datadir.value.trim(), editor = null;
    const moveData = (to) => {
      if (!to.startsWith('/') || to === curDir) return;
      $$('[data-path]', form).forEach((el) => { el.value = rebasePath(el.value, curDir, to); });
      if (editor) editor.rebase(curDir, to);
      curDir = to;
    };
    form.elements.__name.addEventListener('input', (e) => {
      const n = e.target.value.trim();
      if (form.elements.__datadir.value.trim() === d.appdataDir + '/' + lastName && n) { form.elements.__datadir.value = d.appdataDir + '/' + n; moveData(d.appdataDir + '/' + n); }
      lastName = n;
    });
    form.elements.__datadir.addEventListener('input', (e) => moveData(e.target.value.trim().replace(/(.)\/+$/, '$1')));
    // What the simple form would install now (also the starting point for Advanced).
    const basicBody = () => {
      const values = {};
      for (const el of form.elements) if (el.name && !el.name.startsWith('__') && !el.disabled) values[el.name] = el.value;
      return { name: form.elements.__name.value.trim(), values, network: form.elements.__network.value, ip: form.elements.__ip.value.trim(),
        extraPorts: extra.filter((p) => String(p.host).trim() || String(p.container).trim()) };
    };
    // The first required field that is still empty: expand, focus and message.
    const missingField = (msg) => {
      const missing = [...form.elements].find((el) => el.required && !el.disabled && !el.value.trim());
      if (!missing) return false;
      const det = missing.closest('details'); if (det) det.open = true;
      $('.form-error', form).textContent = t(msg, { field: missing.closest('.fld').querySelector('span').textContent.replace('*', '').trim() });
      missing.focus(); return true;
    };
    // Advanced: the full container form or the code, starting from what you already filled in.
    form.elements.__adv.addEventListener('change', async (e) => {
      const err = $('.form-error', form); err.textContent = '';
      const on = e.target.checked, box = $('[data-advanced]', form);
      if (on && missingField('Fill in {field} first. Then you can change everything under Advanced.')) { e.target.checked = false; return; }
      if (!on) {
        if (!(await ask(t('Back to the simple fields? What you changed under Advanced will be lost.'), t('Back')))) { e.target.checked = true; return; }
        editor = null; box.hidden = true; box.innerHTML = ''; $('[data-basic]', form).hidden = false; form.elements.__name.readOnly = false; $('[data-datadir]', form).hidden = false;
        return;
      }
      try {
        const b = basicBody();
        editor = await advancedEditor(box, b.name, { store: d.id, ...b });
        box.hidden = false; $('[data-basic]', form).hidden = true; form.elements.__name.readOnly = true;
      } catch (ex) { e.target.checked = false; box.hidden = true; err.textContent = ex.message; }
    });
    form.addEventListener('advmode', (e) => { $('[data-datadir]', form).hidden = e.detail === 'code'; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form), btn = $('[type=submit]', form);
      err.textContent = '';
      if (editor) {
        btn.disabled = true;
        let r;
        try { r = await api.post('/api/apps/compose', { name: form.elements.__name.value.trim(), text: await editor.finalText() }); }
        catch (ex) { err.textContent = ex.message; btn.disabled = false; return; }
        form.hidden = true; $('#storeJob', body).hidden = false;
        followJob(r.job, prettyName(d.name), body, d.id);
        return;
      }
      if (missingField('Fill in {field}.')) return;
      const badX = extra.find((p) => (String(p.host).trim() || String(p.container).trim()) && !(/^\d{1,5}$/.test(String(p.host).trim()) && /^\d{1,5}$/.test(String(p.container).trim())));
      if (badX) { err.textContent = t('Enter two ports between 1 and 65535 for each extra port.'); return; }
      const values = {};
      for (const el of form.elements) if (el.name && !el.name.startsWith('__') && !el.disabled) values[el.name] = el.value;
      btn.disabled = true;
      let r;
      try {
        r = await api.post('/api/store/apps/' + encodeURIComponent(d.id) + '/install',
          { name: form.elements.__name.value.trim(), values, network: form.elements.__network.value, ip: form.elements.__ip.value.trim(),
            extraPorts: extra.filter((p) => String(p.host).trim() || String(p.container).trim()) });
      }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; return; }
      form.hidden = true; $('#storeJob', body).hidden = false;
      followJob(r.job, prettyName(d.name), body, d.id);
    });
  }

  /* --- own app: an image or a link to Docker Hub, GitHub or Quay */
  function customAppWindow(prefill = '') {
    openWindow(t('Add your own app'), `
      <p class="lead">${t('Paste the name of an image or a link to its page. HomeBaseOS reads from the registry which ports and folders the app uses and fills in the form for you.')}</p>
      <form class="inline-form" id="customImgForm">
        <input class="field" name="image" value="${esc(prefill)}" placeholder="${t('e.g. louislam/uptime-kuma or https://hub.docker.com/r/linuxserver/jellyfin')}" spellcheck="false" autocomplete="off" aria-label="${t('Image or link')}" required>
        <button class="btn primary" type="submit">${t('Fetch')}</button>
      </form>
      <p class="muted small" style="margin-top:8px">${t('Works with Docker Hub, ghcr.io, lscr.io, quay.io and other registries. Private images are not supported yet.')}</p>
      <p class="form-error" role="alert" id="customImgErr"></p>
      <div id="customForm"></div>`, (body) => {
      const imgForm = $('#customImgForm', body);
      imgForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('[type=submit]', imgForm), err = $('#customImgErr', body); err.textContent = '';
        btn.disabled = true; btn.textContent = t('Fetching…');
        try { customAppForm(body, await api.post('/api/apps/custom/inspect', { image: imgForm.elements.image.value })); }
        catch (ex) { err.textContent = ex.message; }
        btn.disabled = false; btn.textContent = t('Fetch');
      });
      if (prefill) imgForm.requestSubmit(); else imgForm.elements.image.focus();
    });
  }
  function customAppForm(body, d) {
    // Same shape as the compose form, so we simply reuse that form.
    const f = { image: d.image, restart: 'unless-stopped', privileged: false, network: d.networkDefault === 'bridge' ? '' : d.networkDefault, ip: '', networkOther: null,
      networks: [], projectNetworks: [], build: false, otherServices: [],
      ports: d.ports.map((p) => ({ ...p, ip: '' })), volumes: d.volumes.map((v) => ({ ...v, kind: 'bind', locked: false })),
      env: d.env.map((e) => ({ ...e })), devices: [], labels: [] };
    $('#customForm', body).innerHTML = `
      ${d.storeMatch ? `<p class="lead">${t('This app is also in the app store, with a ready-made form.')} <button class="linkish" type="button" data-store-match="${esc(d.storeMatch.id)}">${t('View {name} in the app store', { name: esc(prettyName(d.storeMatch.name)) })}</button></p>` : ''}
      ${d.warnings.length ? `<ul class="warn-list">${d.warnings.map((w) => `<li>${esc(tr(w))}</li>`).join('')}</ul>` : ''}
      ${d.appdataMissing ? `<p class="lead temp-bad">${t('There is no folder for app data yet ({dir}). Create a pool in Storage first, or choose a folder in Settings → Storage.', { dir: esc(d.appdataDir) }) + ` <a href="#settings/storage">${t('Open Settings → Storage')}</a>`}</p>` : ''}
      <form class="form" id="storeForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Name')} <em class="req">*</em></span><input class="field" name="__name" required maxlength="63" autocomplete="off" value="${esc(d.name)}">
            <small>${t('Lowercase letters, digits, - and _. Becomes the name of the container and of the folder {dir}/name.', { dir: esc(d.stacksDir) })}</small></label>
          <label class="fld"><span>${t('Icon')} <em class="muted">${t('(optional)')}</em></span><input class="field" name="__icon" value="${esc(d.icon)}" placeholder="https://…" spellcheck="false" autocomplete="off"></label>
        </div>
        <label class="fld"><span>${t('Web interface address (WebUI)')} <em class="muted">${t('(optional)')}</em></span><input class="field" name="__webui" value="${esc(d.webui)}" placeholder="http://[IP]:[PORT:8080]/" spellcheck="false" autocomplete="off">
          <small>${t('[IP] becomes your server\'s address, [PORT:80] the server port linked to port 80 in the app.')}</small></label>
        ${dataDirHtml(d, d.name)}
        <div class="adv-bar"><div class="seg" role="radiogroup" aria-label="${t('View')}">
          <button type="button" role="radio" aria-checked="true" data-cmode="fields">${t('Fields')}</button>
          <button type="button" role="radio" aria-checked="false" data-cmode="code">${t('Code')}</button></div></div>
        <div id="customCf"></div>
        <div data-ccode hidden><textarea class="field code" rows="22" spellcheck="false" aria-label="${t('Compose file')}"></textarea>
          <small class="muted">${t('Exactly this file is installed. Docker Compose checks it first.')}</small></div>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit"${d.appdataMissing ? ' disabled' : ''}>${t('Install')}</button>
          <button class="btn" type="button" data-close>${t('Cancel')}</button></div>
      </form>
      ${jobHtml()}`;
    const form = $('#storeForm', body);
    const mountCf = () => { const old = $('#customCf', form), el = old.cloneNode(false); old.replaceWith(el); composeFormMount(el, f, d.networks); };
    mountCf();
    // The data folder follows the name (as long as you didn't choose it yourself), and all folders below follow the data folder.
    let lastName = d.name, curDir = form.elements.__datadir.value.trim(), mode = 'fields';
    const moveData = (to) => {
      if (!to.startsWith('/') || to === curDir) return;
      f.volumes.forEach((v, i) => {
        const h = rebasePath(v.host, curDir, to);
        if (h !== v.host) { v.host = h; const inp = $(`[data-cf="volumes:${i}:host"]`, form); if (inp) inp.value = h; }
      });
      curDir = to;
    };
    form.elements.__name.addEventListener('input', (e) => {
      const n = e.target.value.trim();
      if (form.elements.__datadir.value.trim() === d.appdataDir + '/' + lastName && n) { form.elements.__datadir.value = d.appdataDir + '/' + n; moveData(d.appdataDir + '/' + n); }
      lastName = n;
    });
    form.elements.__datadir.addEventListener('input', (e) => moveData(e.target.value.trim().replace(/(.)\/+$/, '$1')));
    const customBody = () => ({
      image: f.image, restart: f.restart, privileged: f.privileged, network: f.network || 'bridge', ip: (f.ip || '').trim(),
      ports: f.ports, volumes: f.volumes, env: f.env, devices: f.devices, labels: f.labels,
      webui: form.elements.__webui.value.trim(), icon: form.elements.__icon.value.trim(),
    });
    // Fields or code: the draft goes through the server, so they are always the same file.
    const area = $('[data-ccode] textarea', form);
    form.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-cmode]'); if (!b || b.dataset.cmode === mode) return;
      const err = $('.form-error', form); err.textContent = '';
      const name = form.elements.__name.value.trim();
      try {
        if (b.dataset.cmode === 'code') {
          const problem = composeFormCheck(f); if (problem) { err.textContent = problem; return; }
          area.value = (await api.post('/api/apps/draft', { name, custom: customBody() })).text;
        } else {
          const x = await api.post('/api/apps/draft', { name, text: area.value });
          if (!x.form) { err.textContent = t('This code doesn\'t fit the form ({error}). Stay in the code, or change it.', { error: tr(x.formError || '') }); return; }
          Object.assign(f, x.form, { labels: x.form.labels.filter((l) => !String(l.name).startsWith('homebaseos.')) });
          mountCf();
        }
        mode = b.dataset.cmode;
        $('#customCf', form).hidden = mode !== 'fields'; $('[data-ccode]', form).hidden = mode !== 'code'; $('[data-datadir]', form).hidden = mode === 'code';
        $$('[data-cmode]', form).forEach((x) => x.setAttribute('aria-checked', String(x.dataset.cmode === mode)));
      } catch (ex) { err.textContent = ex.message; }
    });
    body.addEventListener('click', (e) => { const m = e.target.closest('[data-store-match]'); if (m) storeWindow(m.dataset.storeMatch); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form), btn = $('[type=submit]', form); err.textContent = '';
      const name = form.elements.__name.value.trim();
      if (!name) { err.textContent = t('Fill in {field}.', { field: t('Name') }); form.elements.__name.focus(); return; }
      if (mode === 'fields') { const problem = composeFormCheck(f); if (problem) { err.textContent = problem; return; } }
      btn.disabled = true;
      let r;
      try {
        r = mode === 'code' ? await api.post('/api/apps/compose', { name, text: area.value }) : await api.post('/api/apps/custom', { name, ...customBody() });
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; return; }
      form.hidden = true; $('#storeJob', body).hidden = false;
      $('#customImgForm', body).hidden = true;
      followJob(r.job, prettyName(name), body, null);
    });
    form.elements.__name.focus();
  }
  $('#customAppBtn').addEventListener('click', () => customAppWindow());

  // Progress of an installation: bar, what is happening now, and Docker's output to expand.
  const jobHtml = () => `
      <div id="storeJob" class="job" hidden>
        <p class="lead" id="jobState">${t('Installing…')}</p>
        <div class="bar job-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="${t('Progress')}"><span id="jobBar"></span></div>
        <p class="progress-note" id="jobNote"></p>
        <details class="job-log"><summary>${t('Details')}</summary><pre class="logs" id="jobLog"></pre></details>
        <div class="btn-row" id="jobBtns"></div>
      </div>`;
  function drawJob(body, j) {
    const bar = $('#jobBar', body), log = $('#jobLog', body);
    bar.style.width = (j.percent || 0) + '%'; bar.className = j.done && !j.ok ? 'bad' : '';
    bar.parentElement.setAttribute('aria-valuenow', String(j.percent || 0));
    if (!j.done) {
      $('#jobState', body).textContent = j.phase === 'start' ? t('Starting the app…') : t('Downloading the image…');
      $('#jobNote', body).textContent = j.phase === 'start' ? ''
        : j.layers ? t('{done} of {total} layers', { done: j.layersDone, total: j.layers }) + (j.size ? ' · ' + t('{done} of {total}', { done: bytes(j.downloaded), total: bytes(j.size) }) : '')
        : t('Connecting to the registry…');
    } else $('#jobNote', body).textContent = '';
    const end = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.textContent = j.lines.map(tr).join('\n');
    if (end) log.scrollTop = log.scrollHeight;
  }
  // Follow the installation. If you close the window, it just carries on and you get a notification at the end.
  async function followJob(jobId, label, body, storeId) {
    let j;
    try { j = await api.get('/api/store/jobs/' + jobId); } catch (e) { setTimeout(() => followJob(jobId, label, body, storeId), 2000); return; }
    const visible = body.isConnected;
    if (visible) drawJob(body, j);
    if (!j.done) { setTimeout(() => followJob(jobId, label, body, storeId), 1000); return; }
    if (j.ok) {
      toast(t('Installed: {name}', { name: label }));
      await loadApps().catch(() => {});
      if (S.store) { const s = S.store.apps.find((x) => x.id === storeId); if (s) s.installed = true; renderStore(); }
      if (!visible) return;
      const a = S.apps.find((x) => x.name === j.name);
      const url = a && webuiUrl(a.webui);
      $('#jobState', body).textContent = t('Done: {name} is installed and started.', { name: label });
      $('#jobBtns', body).innerHTML = (url ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">${t('Open')}</a>` : '') +
        `<button class="btn" type="button" data-close>${t('Close')}</button>`;
    } else {
      toast(t('Installing {name} failed: {error}', { name: label, error: tr(j.error) }), true);
      if (!visible) return;
      $('#jobState', body).innerHTML = `<span class="temp-bad">${t('Installation failed: {error}', { error: esc(tr(j.error)) })}</span>`;
      $('.job-log', body).open = true;
      $('#jobBtns', body).innerHTML = `<button class="btn primary" type="button" data-job-back>${t('Back to the form')}</button><button class="btn" type="button" data-close>${t('Close')}</button>`;
      $('[data-job-back]', body).addEventListener('click', () => {
        $('#storeJob', body).hidden = true; const f = $('#storeForm', body); f.hidden = false; $('[type=submit]', f).disabled = false;
      });
    }
  }

  /* --- settings (own page at #settings, #settings/network, #settings/docker, #settings/about) */
  const settingsTab = () => ({ '#settings/storage': 'storage', '#settings/network': 'network', '#settings/docker': 'docker', '#settings/vmnet': 'vmnet', '#settings/security': 'security', '#settings/users': 'users', '#settings/update': 'update', '#settings/about': 'about' })[location.hash] || 'general';
  let netTimer = null;
  function showSettings() {
    const tab = settingsTab();
    $$('#setTabs [role="tab"]').forEach((a) => { a.setAttribute('aria-selected', String(a.dataset.tab === tab)); a.setAttribute('aria-checked', String(a.dataset.tab === tab)); });
    $('#setPane').setAttribute('aria-labelledby', 'tab-' + tab);
    $('#setWinTitle').textContent = t({ general: 'General', storage: 'Storage', network: 'Network', docker: 'Docker networks', vmnet: 'VM networks', security: 'Security', users: 'Users', update: 'Software update', about: 'About' }[tab]);
    $('#setPane').scrollTop = 0;
    clearInterval(netTimer); netTimer = null;
    $('#setPane').onclick = null; $('#setPane').onchange = null;
    ({ general: generalPane, storage: storagePane, network: networkPane, docker: dockerNetPane, vmnet: vmNetPane, security: securityPane, users: usersPane, update: updatePane, about: aboutPane })[tab]($('#setPane'));
  }

  function generalPane(el) {
    const theme = themeNow(), clock = S.config.clock || 'auto';
    const sample = (c) => new Date(2026, 0, 1, 14, 30).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit', ...clockOpts(c) });
    el.innerHTML = `
      <h2 class="pane-title">${t('Language')}</h2>
      <p class="muted small">${t('Applies to everyone who uses HomeBaseOS on this server.')}</p>
      <div class="choice-row" role="radiogroup" aria-label="${t('Language')}">${Object.entries(LANGS).map(([k, name]) => `
        <label class="choice"><input type="radio" name="lang" value="${k}"${k === LANG ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}
      </div>
      <h2 class="pane-title">${t('Theme')}</h2>
      <p class="muted small">${t('Applies to this device only.')}</p>
      <div class="choice-row" role="radiogroup" aria-label="${t('Theme')}">${[['auto', t('Automatic')], ['light', t('Light (morning mist)')], ['dark', t('Dark (evening)')]].map(([k, name]) => `
        <label class="choice"><input type="radio" name="theme" value="${k}"${k === theme ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}
      </div>
      <h2 class="pane-title">${t('Time format')}</h2>
      <p class="muted small">${t('Applies to everyone who uses HomeBaseOS on this server.')}</p>
      <div class="choice-row" role="radiogroup" aria-label="${t('Time format')}">${[['auto', t('Follow the language')], ['24', t('24-hour')], ['12', t('12-hour')]].map(([k, name]) => `
        <label class="choice"><input type="radio" name="clock" value="${k}"${k === clock ? ' checked' : ''}><span>${esc(name)} · ${esc(sample(k))}</span></label>`).join('')}
      </div>
      <div id="dtBox"><h2 class="pane-title">${t('Date and time')}</h2><p class="muted small">${t('Loading…')}</p></div>
      <h2 class="pane-title">${t('Welcome wizard')}</h2>
      <p class="muted small">${t('Go through the basic settings again: account, name, time zone, storage and two-step verification.')}</p>
      <div class="btn-row"><button class="btn" type="button" data-onb-open>${t('Open welcome wizard')}</button></div>`;
    el.onclick = (e) => { if (e.target.closest('[data-onb-open]')) { closeSettings(); openOnboarding(0); } };
    el.onchange = async (e) => {
      if (e.target.name === 'theme') { setTheme(e.target.value); return; }
      if (e.target.name === 'clock') {
        try {
          const r = await api.post('/api/settings', { clock: e.target.value });
          S.config.clock = r.clock || e.target.value; tickClock(); toast(t('Time format saved.'));
        } catch (ex) { toast(ex.message, true); }
        return;
      }
      if (e.target.name !== 'lang') return;
      try {
        await api.post('/api/settings', { language: e.target.value });
        setLang(e.target.value);
        location.reload(); // rebuild everything in the new language
      } catch (ex) { toast(t('Saving the language failed: {error}', { error: ex.message }), true); }
    };
    dateTimeSection($('#dtBox', el));
  }

  /* --- Storage: where app data, VM disks, ISOs and shared folders are, and moving app data to another pool */
  const MIGRATE_STEPS = { prepare: 'Preparing', stop: 'Stopping apps', copy: 'Copy', compose: 'Updating compose files', start: 'Starting apps', done: 'Ready' };
  async function storagePane(el) {
    el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let d;
    try { d = await api.get('/api/storage-paths'); }
    catch (e) { el.innerHTML = `<p class="lead">${t('The storage locations could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'storage') return;
    const poolOf = (dir) => (dir ? d.pools.find((p) => dir === p.mountpoint || dir.startsWith(p.mountpoint + '/')) : null);
    const where = (k) => (d.paths[k] ? `<code>${esc(d.paths[k])}</code>${d.exists[k] ? '' : ` <span class="pill warn">${t('does not exist')}</span>`}` : `<span class="muted">${t('Not set yet')}</span>`);
    const select = (k) => {
      const cur = poolOf(d.paths[k]);
      return `<select class="field sm" data-sp-pool="${k}" aria-label="${t('Pool')}">${d.pools.map((p) => `<option value="${esc(p.name)}"${cur && cur.name === p.name ? ' selected' : ''}>${esc(p.name)} · ${esc(t('{size} free', { size: bytes(p.free) }))}</option>`).join('')}</select>`;
    };
    const busy = d.migration && d.migration.state === 'running';
    const row = (k, title, help, btn) => `<li>
        <div><div class="row-title">${title}</div><div class="row-sub">${where(k)}</div><div class="row-sub">${help}</div></div>
        <div class="row-side btn-row">${d.pools.length ? select(k) + `<button class="btn sm${k === 'appdata' ? ' primary' : ''}" type="button" data-sp-save="${k}"${busy ? ' disabled' : ''}>${btn}</button>` : ''}
          <button class="btn sm" type="button" data-sp-own="${k}"${busy ? ' disabled' : ''}>${t('Existing folder…')}</button></div>
        <form class="inline-form user-edit" data-sp-form="${k}" hidden>
          <input class="field" name="path" spellcheck="false" autocomplete="off" value="${esc(d.paths[k] || '')}" placeholder="/tank/${esc(d.folders[k] || '')}" aria-label="${t('Folder on the server')}">
          <button class="btn sm primary" type="submit">${t('Use this folder')}</button>
          <span class="muted small" style="flex-basis:100%">${t('Nothing moves: HomeBaseOS uses this folder from now on.')}</span></form></li>`;
    const appsText = d.apps.length ? t('Used by: {list}', { list: esc(d.apps.map((a) => a.project).join(', ')) }) : t('No apps yet.');
    el.innerHTML = `
      <p class="muted small">${t('Where HomeBaseOS keeps your data. A new pool gets the folders appdata, media, backups, vms and isos.')}</p>
      ${d.pools.length ? '' : `<p class="lead">${t('There is no pool yet. Create one in Storage.')} <button class="btn sm" type="button" data-open="storage">${t('Open storage')}</button></p>`}
      <ul class="rows">
        ${row('appdata', t('App data'), appsText + (d.manual.length ? ' · ' + t('Not moved (no compose file on the server): {list}', { list: esc(d.manual.join(', ')) }) : ''), t('Move'))}
        ${row('vms', t('VM disks'), t('New VMs go here. Existing VM disks stay where they are.'), t('Save'))}
        ${row('isos', t('ISOs and disk images'), t('Put installation ISOs here, e.g. through a shared folder.'), t('Save'))}
        ${row('shares', t('Shared folders for Unraid apps'), t('/mnt/user/… from the app store becomes this folder.'), t('Save'))}
      </ul>
      <div id="spMig"></div>`;
    const mig = $('#spMig', el);
    const drawMig = (m) => {
      if (!m) { mig.innerHTML = ''; return; }
      const pct = m.step === 'copy' ? m.percent : m.state === 'done' ? 100 : null;
      mig.innerHTML = `<h2 class="pane-title">${t('Moving app data')}</h2>
        <p class="${m.state === 'failed' ? 'temp-bad' : m.state === 'done' ? 'temp-ok' : ''}">${esc(m.state === 'failed' ? t('Failed: {error}', { error: tr(m.error) }) : m.state === 'done' ? t('Done: the app data is now in {dir}.', { dir: m.to }) : t(MIGRATE_STEPS[m.step] || m.step) + '…')}</p>
        ${pct != null ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
        <pre class="logs">${esc((m.lines || []).map(tr).join('\n'))}</pre>`;
    };
    drawMig(d.migration);
    // Follow the progress while a move is running.
    const follow = async () => {
      while (settingsTab() === 'storage' && setWin.open) {
        let r; try { r = await api.get('/api/storage-paths/migration'); } catch (e) { await new Promise((ok) => setTimeout(ok, 3000)); continue; }
        if (!mig.isConnected) return;
        drawMig(r.migration);
        if (!r.migration || r.migration.state !== 'running') { if (r.migration && r.migration.state === 'done') { toast(t('The app data has been moved.')); loadApps().catch(() => {}); } storagePaneKeep(el); return; }
        await new Promise((ok) => setTimeout(ok, 1500));
      }
    };
    // Afterwards refresh the list, but keep the report.
    const storagePaneKeep = async (box) => {
      const keep = mig.innerHTML; await storagePane(box); const m2 = $('#spMig', box); if (m2 && !m2.innerHTML) m2.innerHTML = keep;
    };
    if (busy) follow();
    // Point to an existing folder (e.g. where your app data already is): nothing moves.
    $$('[data-sp-form]', el).forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = f.dataset.spForm, dir = f.elements.path.value.trim();
      await withBusy($('[type=submit]', f), async () => {
        try { await api.post('/api/storage-paths', { kind, path: dir }); toast(t('HomeBaseOS now uses {dir}.', { dir })); storagePane(el); }
        catch (ex) { toast(ex.message, true); }
      });
    }));
    el.onclick = async (e) => {
      const own = e.target.closest('[data-sp-own]');
      if (own) { const f = $(`[data-sp-form="${own.dataset.spOwn}"]`, el); f.hidden = !f.hidden; if (!f.hidden) f.elements.path.focus(); return; }
      const b = e.target.closest('[data-sp-save]'); if (!b) return;
      const kind = b.dataset.spSave, pool = $(`[data-sp-pool="${kind}"]`, el).value, p = d.pools.find((x) => x.name === pool);
      const cur = poolOf(d.paths[kind]);
      if (cur && cur.name === pool && d.exists[kind]) { toast(t('This is already on {pool}.', { pool })); return; }
      if (kind === 'appdata') {
        const to = p.mountpoint + '/appdata';
        const ok = d.paths.appdata && d.exists.appdata ? await ask(t('Move app data from {from} to {to}? {apps}Everything is copied; the old folder stays until you remove it yourself.', {
          from: d.paths.appdata, to, apps: d.apps.length ? t('These apps stop until copying is done: {list}. ', { list: d.apps.map((a) => a.project).join(', ') }) : '' }), t('Move')) : true;
        if (!ok) return;
        await withBusy(b, async () => {
          try {
            const r = await api.post('/api/storage-paths', { kind, pool });
            if (r.started) { drawMig(r.migration); $$('[data-sp-save]', el).forEach((x) => { x.disabled = true; }); follow(); }
            else { toast(t('App data now goes to {dir}.', { dir: to })); storagePane(el); }
          } catch (ex) { toast(ex.message, true); }
        });
        return;
      }
      await withBusy(b, async () => {
        try { await api.post('/api/storage-paths', { kind, pool }); toast(t('Saved.')); storagePane(el); }
        catch (ex) { toast(ex.message, true); }
      });
    };
  }

  // Time zones for a <select>, grouped per continent (Europe/Brussels → Europe).
  function zoneOptions(zones, selected) {
    const groups = {};
    zones.forEach((z) => { const g = z.includes('/') ? z.split('/')[0] : t('Other'); (groups[g] = groups[g] || []).push(z); });
    return Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((z) =>
      `<option value="${esc(z)}"${z === selected ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('')}</optgroup>`).join('');
  }

  /* --- General: date, time and time zone of the server */
  async function dateTimeSection(box) {
    let d;
    try { d = await api.get('/api/datetime'); }
    catch (e) { box.innerHTML = `<h2 class="pane-title">${t('Date and time')}</h2><p class="form-error">${esc(e.message)}</p>`; return; }
    if (!box.isConnected) return;
    const offset = d.now - Date.now(); // difference between the server's clock and this computer's
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const zoneOpts = zoneOptions(d.timezones, d.timezone);
    const pad = (n) => String(n).padStart(2, '0');
    // Value for <input type="datetime-local"> in the server's time zone.
    const localValue = (ms, tz) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    };
    const sync = d.ntp == null ? '' : d.ntp
      ? (d.synced ? `<span class="pill ok">${d.server ? t('In sync with {server}', { server: esc(d.server) }) : t('Synchronized')}</span>` : `<span class="pill warn">${t('Not synchronized yet')}</span>`)
      : `<span class="pill">${t('Set manually')}</span>`;
    const skew = Math.abs(offset) > 120000 ? `<p class="small" style="color:var(--warn)">${t('The clocks of the server and this computer differ by {n} minutes.', { n: Math.round(Math.abs(offset) / 60000) })}</p>` : '';
    box.innerHTML = `
      <h2 class="pane-title">${t('Date and time')}</h2>
      <p class="muted small">${t('The server\'s clock. Apps from the app store get the same time zone (TZ).')}</p>
      <div class="dt-now"><div><div class="dt-clock" id="dtClock"></div><div class="muted small" id="dtDate"></div></div>${sync}</div>
      ${skew}
      <form class="form dt-form" id="dtForm">
        <label class="fld"><span>${t('Time zone')}</span>
          <select class="field" name="timezone"${d.editable ? '' : ' disabled'}>${zoneOpts}</select></label>
        ${browserTz && browserTz !== d.timezone && d.timezones.includes(browserTz) ? `<p class="small" style="margin-top:-4px"><button class="link-btn" type="button" data-tz="${esc(browserTz)}">${t('Use {zone}, the time zone of this computer', { zone: esc(browserTz.replace(/_/g, ' ')) })}</button></p>` : ''}
        <label class="check"><input type="checkbox" name="ntp"${d.ntp ? ' checked' : ''}${d.editable ? '' : ' disabled'}> ${t('Set time automatically over the internet (NTP)')}</label>
        <div data-dt="ntp"${d.ntp ? '' : ' hidden'}>
          <label class="fld"><span>${t('Time servers')}</span>
            <input class="field" name="servers" value="${esc(d.servers.join(' '))}" spellcheck="false" autocomplete="off"
              placeholder="${esc(d.defaultServers.length ? t('Default: {list}', { list: d.defaultServers.slice(0, 2).join(', ') + (d.defaultServers.length > 2 ? ', …' : '') }) : t('Debian default'))}"></label>
          <p class="muted small">${t('Leave empty for the Debian default. Or use e.g. be.pool.ntp.org or your router\'s address. Separate multiple servers with a space.')}</p>
        </div>
        <div data-dt="manual"${d.ntp ? ' hidden' : ''}>
          <label class="fld"><span>${t('Date and time')}</span>
            <input class="field" type="datetime-local" name="time" value="${localValue(d.now, d.timezone)}"></label>
          <p class="small"><button class="link-btn" type="button" data-dt-now>${t('Use this computer\'s time')}</button></p>
        </div>
        ${d.editable ? '' : `<p class="muted small">${t('timedatectl is not available on this server.')}</p>`}
        <p class="form-error" role="alert" id="dtErr"></p>
        <div class="btn-row"><button class="btn primary" type="submit"${d.editable ? '' : ' disabled'}>${t('Save')}</button></div>
      </form>`;
    const F = $('#dtForm', box).elements;
    let timeTouched = false;
    const tick = () => {
      if (!box.isConnected) return;
      const now = new Date(Date.now() + offset), tz = d.timezone;
      $('#dtClock', box).textContent = now.toLocaleTimeString(LOCALE, { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', ...clockOpts() });
      const ds = now.toLocaleDateString(LOCALE, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      $('#dtDate', box).textContent = ds.charAt(0).toUpperCase() + ds.slice(1) + ' · ' + tz.replace(/_/g, ' ');
    };
    clearInterval(netTimer); tick(); netTimer = setInterval(tick, 1000);
    box.onchange = (e) => {
      if (e.target.name === 'ntp') { $('[data-dt="ntp"]', box).hidden = !F.ntp.checked; $('[data-dt="manual"]', box).hidden = F.ntp.checked; }
      if (e.target.name === 'time') timeTouched = true;
      if (e.target.name === 'timezone' && !timeTouched) F.time.value = localValue(Date.now() + offset, F.timezone.value);
    };
    box.onclick = (e) => {
      const tz = e.target.closest('[data-tz]');
      if (tz) { F.timezone.value = tz.dataset.tz; F.timezone.dispatchEvent(new Event('change', { bubbles: true })); tz.parentNode.remove(); return; }
      if (e.target.closest('[data-dt-now]')) { F.time.value = localValue(Date.now(), F.timezone.value); timeTouched = true; }
    };
    $('#dtForm', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type="submit"]', e.target), err = $('#dtErr', box);
      const body = { timezone: F.timezone.value, ntp: F.ntp.checked };
      if (F.ntp.checked) body.servers = F.servers.value;
      else if (timeTouched || !d.ntp) body.time = F.time.value;
      err.textContent = ''; btn.disabled = true;
      try { await api.post('/api/datetime', body); toast(t('Date and time saved.')); dateTimeSection(box); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
  }

  async function networkPane(el) {
    el.onchange = null;
    el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let n;
    try { n = await api.get('/api/network'); }
    catch (e) { el.innerHTML = `<p class="lead">${t('The network settings could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'network') return;
    const c = n.config;
    const linkRows = n.links.map((l) => `<li>
        <div><div class="row-title">${esc(l.name)} <span class="pill ${l.up ? 'ok' : ''}">${l.up ? t('Connected') : t('Not connected')}</span></div>
          <div class="row-sub">${esc([l.kind === 'bridge' ? t('Bridge') : t('Network card'), l.speed ? (l.speed >= 1000 ? nf.format(l.speed / 1000) + ' Gbit/s' : l.speed + ' Mbit/s') : null,
            l.master ? t('in bridge {name}', { name: l.master }) : null, l.mac].filter(Boolean).join(' · '))}</div></div>
        <div class="row-side">${l.ipv4.map((a) => esc(a.address) + (a.dynamic ? ' <span class="muted">(DHCP)</span>' : '')).join('<br>') || '–'}
          ${l.gateway ? `<div>${t('gateway {ip}', { ip: esc(l.gateway) })}</div>` : ''}</div></li>`).join('');
    el.innerHTML = `
      <div id="netPending"></div>
      <h2 class="pane-title">${t('Now')}</h2>
      <ul class="rows">${linkRows || `<li><span class="muted">${t('No network cards found.')}</span></li>`}</ul>
      <p class="muted small" style="margin-top:8px">${t('DNS servers: {list}', { list: esc(n.dns.join(', ') || '–') })}</p>

      <h2 class="pane-title">${t('Hostname')}</h2>
      <form class="inline-form" id="hostForm">
        <input class="field" name="hostname" value="${esc(n.hostname)}" maxlength="63" autocomplete="off" spellcheck="false" aria-label="${t('Hostname')}">
        <button class="btn" type="submit">${t('Save')}</button>
      </form>
      <p class="muted small" style="margin-top:6px">${t('The name of the server in your network. The connection keeps working.')}</p>

      <h2 class="pane-title">${t('IP address')}</h2>
      ${!n.editable ? `<p class="lead">${t('This network is managed by {who}. HomeBaseOS can only change it when Debian uses ifupdown (/etc/network/interfaces), the default for a server without a desktop.', { who: esc(n.manager || t('another program')) })}</p>` : `
      <form class="form" id="netForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Network card')}</span><select class="field" name="interface">${n.physical.map((p) => `<option${c && c.interface === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
          <label class="fld"><span>${t('Get an address')}</span><select class="field" name="mode">
            <option value="dhcp"${c && c.mode === 'dhcp' ? ' selected' : ''}>${t('Automatic (DHCP from your router)')}</option>
            <option value="static"${c && c.mode === 'static' ? ' selected' : ''}>${t('Fixed address')}</option></select></label>
        </div>
        <div class="fld-row" data-static>
          <label class="fld"><span>${t('IP address and netmask')}</span><input class="field" name="address" value="${esc(c ? c.address : '')}" placeholder="192.168.1.10/24" spellcheck="false">
            <small>${t('/24 means netmask 255.255.255.0, which fits most home networks.')}</small></label>
          <label class="fld"><span>${t('Gateway')}</span><input class="field" name="gateway" value="${esc(c ? c.gateway : '')}" placeholder="192.168.1.1" spellcheck="false">
            <small>${t('Usually the address of your router.')}</small></label>
        </div>
        <label class="fld" data-static><span>${t('DNS servers')}</span><input class="field" name="dns" value="${esc(c ? c.dns.join(', ') : '')}" placeholder="192.168.1.1, 1.1.1.1" spellcheck="false">
          <small>${t('Separated by commas.')}</small></label>
        <label class="check"><input type="checkbox" name="bridge"${c && c.bridge ? ' checked' : ''}> ${t('Create bridge br0 for VMs')}</label>
        <p class="muted small" style="margin-top:-6px">${t('Needed to give VMs (such as Home Assistant) their own address in your home network. Then set VM_NETWORK=bridge=br0.')}</p>
        <p class="lead">${t('After applying you have 2 minutes to confirm. If you do not confirm, e.g. because the server became unreachable, HomeBaseOS restores the old settings by itself.')}</p>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit"${n.pending ? ' disabled' : ''}>${t('Apply')}</button></div>
      </form>`}`;

    const hostForm = $('#hostForm', el);
    hostForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button', hostForm); btn.disabled = true;
      try { const r = await api.post('/api/network/hostname', { hostname: hostForm.elements.hostname.value }); toast(t('The hostname is now {name}.', { name: r.hostname })); loadOverview().catch(() => {}); }
      catch (ex) { toast(ex.message, true); }
      btn.disabled = false;
    });
    const form = $('#netForm', el);
    if (form) {
      const sync = () => $$('[data-static]', form).forEach((x) => { x.hidden = form.elements.mode.value !== 'static'; });
      form.elements.mode.addEventListener('change', sync); sync();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = $('.form-error', form), btn = $('[type=submit]', form); err.textContent = '';
        const body = { interface: form.elements.interface.value, mode: form.elements.mode.value, address: form.elements.address.value.trim(),
          gateway: form.elements.gateway.value.trim(), dns: form.elements.dns.value, bridge: form.elements.bridge.checked };
        if (!(await ask(t('Apply the network settings? The connection drops for a moment. Then confirm within 2 minutes, or the old settings come back.'), t('Apply')))) return;
        btn.disabled = true;
        try {
          const r = await api.post('/api/network', body);
          const newUrl = r.address && r.address !== location.hostname ? location.protocol + '//' + r.address + (location.port ? ':' + location.port : '') + '/#settings/network' : null;
          renderPending(el, r.pending, newUrl, body.mode === 'dhcp');
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      });
    }
    if (n.pending) renderPending(el, n.pending, null, false);
  }

  // Waiting for confirmation, with a countdown. Meanwhile the page asks for the state (also at a new address).
  function renderPending(el, p, newUrl, dhcp) {
    const box = $('#netPending', el); if (!box) return;
    const btn = $('#netForm [type=submit]', el); if (btn) btn.disabled = true;
    box.innerHTML = `<div class="notice warn">
      <p><b>${t('New network settings are active.')}</b> ${t('Does everything work? Then confirm them. Otherwise they are restored in')} <b id="netLeft"></b>.</p>
      ${newUrl ? `<p>${t('The server\'s address changes. Open')} <a href="${esc(newUrl)}">${esc(newUrl)}</a> ${t('and confirm there (you may have to sign in again).')}</p>` : ''}
      ${dhcp ? `<p>${t('With DHCP your router picks the address. Look it up in your router if this page is no longer reachable.')}</p>` : ''}
      <div class="btn-row"><button class="btn primary" type="button" id="netConfirm">${t('Confirm')}</button><button class="btn" type="button" id="netRevert">${t('Restore now')}</button></div></div>`;
    const tick = () => {
      const left = Math.max(0, Math.ceil((p.until - Date.now()) / 1000));
      const lbl = $('#netLeft', box); if (lbl) lbl.textContent = t('{n} s', { n: left });
      if (!left) { clearInterval(netTimer); setTimeout(() => location.hash === '#settings/network' && showSettings(), 4000); }
    };
    clearInterval(netTimer); tick(); netTimer = setInterval(tick, 1000);
    $('#netConfirm', box).addEventListener('click', async () => {
      try { await api.post('/api/network/confirm'); clearInterval(netTimer); toast(t('Network settings confirmed.')); showSettings(); }
      catch (ex) { toast(ex.message, true); }
    });
    $('#netRevert', box).addEventListener('click', async () => {
      try { await api.post('/api/network/revert'); clearInterval(netTimer); toast(t('The old network settings have been restored.')); showSettings(); }
      catch (ex) { toast(ex.message, true); }
    });
  }

  /* --- Docker networks: custom bridges and networks with their own address in your home network (macvlan/ipvlan) */
  const ipNum = (ip) => ip.split('.').reduce((x, o) => x * 256 + Number(o), 0);
  const numIp = (n) => [16777216, 65536, 256, 1].map((d) => Math.floor(n / d) % 256).join('.');
  // Proposal for the IP range: the second-to-last eighth of the subnet, e.g. 192.168.1.192/27 in a /24.
  function suggestRange(subnet) {
    const m = String(subnet || '').match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (!m || Number(m[2]) > 27) return '';
    const size = 2 ** (32 - Number(m[2])), rs = size / 8, base = ipNum(m[1]) - (ipNum(m[1]) % size);
    return numIp(base + size - 2 * rs) + '/' + (Number(m[2]) + 3);
  }
  const NET_HELP = {
    bridge: 'Apps in the same network find each other by name, e.g. http://database:5432. You can leave subnet and gateway empty; Docker then picks them.',
    macvlan: 'Each app gets its own IP and MAC address in your home network, like br0 in Unraid. Note: the server itself cannot reach apps in this network.',
    ipvlan: 'Like macvlan, but all apps share the server\'s MAC address. Choose this if your router or switch has trouble with many MAC addresses. Here too, the server itself cannot reach the apps.',
  };
  const BUILTIN_NET = { bridge: 'For apps without their own network', host: 'The server\'s own network', none: 'No network' };
  async function dockerNetPane(el) {
    el.onchange = null;
    el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let d;
    try { d = await api.get('/api/docker-networks'); }
    catch (e) { el.innerHTML = `<p class="lead">${t('The Docker networks could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'docker') return;
    const own = d.networks.filter((n) => !n.builtin), builtin = d.networks.filter((n) => n.builtin);
    const lan = d.parents.find((p) => p.gateway) || d.parents[0] || null;
    const row = (n) => {
      const sub = [n.subnet, n.gateway && t('gateway {ip}', { ip: n.gateway }), n.ipRange && t('addresses from {range}', { range: n.ipRange }),
        n.parent && t('via {name}', { name: n.parent }), n.internal && t('no internet'), n.compose && t('from compose project {name}', { name: n.compose }),
        n.builtin && t(BUILTIN_NET[n.name] || '')].filter(Boolean).join(' · ');
      const apps = n.containers.map((c) => esc(c.name) + (c.ip && n.driver !== 'bridge' ? ' <span class="muted">(' + esc(c.ip) + ')</span>' : '')).join(', ');
      return `<li>
        <div><div class="row-title">${esc(n.name)} <span class="pill">${esc(n.driver || '–')}</span></div>
          <div class="row-sub">${esc(sub)}</div>
          <div class="row-sub">${n.containers.length ? t('Apps: {list}', { list: apps }) : t('No apps yet')}</div></div>
        <div class="row-side">${n.builtin ? `<span class="muted">${t('built-in')}</span>`
          : `<button class="btn sm danger" type="button" data-net-del="${esc(n.name)}"${n.containers.length ? ` disabled title="${t('Move the apps out of this network first.')}"` : ''}>${t('Remove')}</button>`}</div></li>`;
    };
    el.innerHTML = `
      <p class="muted small">${t('Choose a network in an app\'s settings (compose form) or when installing from the app store.')}</p>
      <h2 class="pane-title">${t('Custom networks')}</h2>
      <ul class="rows">${own.map(row).join('') || `<li><span class="muted">${t('No custom networks yet. Create one below.')}</span></li>`}</ul>
      <h2 class="pane-title">${t('Create network')}</h2>
      <form class="form" id="dnForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Name')}</span><input class="field" name="name" maxlength="63" placeholder="${t('e.g. homenet')}" autocomplete="off" spellcheck="false"></label>
          <label class="fld"><span>${t('Type')}</span><select class="field" name="driver">
            <option value="bridge">${t('Bridge (private network between apps)')}</option>
            <option value="macvlan"${d.parents.length ? '' : ' disabled'}>${t('macvlan (own address in your home network)')}</option>
            <option value="ipvlan"${d.parents.length ? '' : ' disabled'}>${t('ipvlan (own address, same MAC address)')}</option></select></label>
        </div>
        <p class="muted small" id="dnHelp"></p>
        <label class="fld" data-own><span>${t('Network card')}</span><select class="field" name="parent">${d.parents.map((p) =>
          `<option value="${esc(p.name)}"${lan && lan.name === p.name ? ' selected' : ''}>${esc(p.name + (p.subnet ? ' · ' + p.subnet : ''))}</option>`).join('')}</select>
          <small>${t('The network card (or bridge br0) connected to your home network.')}</small></label>
        <div class="fld-row">
          <label class="fld"><span>${t('Subnet')}</span><input class="field" name="subnet" spellcheck="false" autocomplete="off">
            <small data-bridge>${t('Empty = Docker picks one.')}</small><small data-own>${t('The subnet of your home network.')}</small></label>
          <label class="fld"><span>${t('Gateway')}</span><input class="field" name="gateway" spellcheck="false" autocomplete="off">
            <small data-bridge>${t('Empty = Docker picks one.')}</small><small data-own>${t('Usually the address of your router.')}</small></label>
        </div>
        <label class="fld" data-own><span>${t('IP range for apps')}</span><input class="field" name="ipRange" spellcheck="false" autocomplete="off">
          <small>${t('Docker hands out addresses from this range. Pick a part your router does not hand out via DHCP, otherwise addresses can clash.')}</small></label>
        <label class="check" data-bridge><input type="checkbox" name="internal"> ${t('No internet (only traffic between the apps in this network)')}</label>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Create')}</button></div>
      </form>
      <h2 class="pane-title">${t('Built-in')}</h2>
      <ul class="rows">${builtin.map(row).join('')}</ul>`;

    const form = $('#dnForm', el), F = form.elements;
    const parentOf = () => d.parents.find((p) => p.name === F.parent.value) || null;
    let filled = null; // what we filled in ourselves, so we can remove it again with another choice
    const sync = () => {
      const ownIp = F.driver.value !== 'bridge';
      $$('[data-own]', form).forEach((x) => { x.hidden = !ownIp; });
      $$('[data-bridge]', form).forEach((x) => { x.hidden = ownIp; });
      $('#dnHelp', form).textContent = t(NET_HELP[F.driver.value]);
      const p = parentOf();
      const want = ownIp && p ? { subnet: p.subnet || '', gateway: p.gateway || '', ipRange: suggestRange(p.subnet) } : { subnet: '', gateway: '', ipRange: '' };
      for (const k of ['subnet', 'gateway', 'ipRange']) if (!F[k].value || (filled && F[k].value === filled[k])) F[k].value = want[k];
      filled = want;
      F.subnet.placeholder = ownIp ? '192.168.1.0/24' : '172.30.0.0/24';
      F.gateway.placeholder = ownIp ? '192.168.1.1' : '172.30.0.1';
      F.ipRange.placeholder = '192.168.1.192/27';
    };
    F.driver.addEventListener('change', sync); F.parent.addEventListener('change', sync); sync();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form), btn = $('[type=submit]', form); err.textContent = '';
      if (!F.name.value.trim()) { err.textContent = t('Give the network a name.'); F.name.focus(); return; }
      const ownIp = F.driver.value !== 'bridge';
      const body = { name: F.name.value.trim(), driver: F.driver.value, subnet: F.subnet.value.trim(), gateway: F.gateway.value.trim(),
        ipRange: ownIp ? F.ipRange.value.trim() : '', parent: ownIp ? F.parent.value : '', internal: !ownIp && F.internal.checked };
      btn.disabled = true;
      try { await api.post('/api/docker-networks', body); toast(t('Network {name} created.', { name: body.name })); dockerNetPane(el); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    el.onclick = async (e) => {
      const del = e.target.closest('[data-net-del]');
      if (!del) return;
      const name = del.dataset.netDel;
      if (!(await ask(t('Delete network {name}? No apps use it anymore, so nothing breaks.', { name }), t('Remove')))) return;
      del.disabled = true;
      try { await api.del('/api/docker-networks/' + encodeURIComponent(name)); toast(t('Network {name} deleted.', { name })); dockerNetPane(el); }
      catch (ex) { toast(ex.message, true); del.disabled = false; }
    };
  }

  /* --- VM networks: libvirt networks (NAT or isolated) and the bridges of the server */
  async function vmNetPane(el) {
    el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let d;
    try { d = await api.get('/api/vm-networks'); }
    catch (e) { el.innerHTML = `<p class="lead">${t('The VM networks could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'vmnet') return;
    const vmsText = (list) => (list.length ? t("VMs: {list}", { list: esc(list.join(', ')) }) : t("No VMs yet"));
    // First free 192.168.1xx.0/24 as a proposal.
    let suggest = '';
    for (let i = 150; i < 250 && !suggest; i++) { const c = '192.168.' + i + '.0/24'; if (!d.networks.some((n) => n.subnet === c)) suggest = c; }
    el.innerHTML = `
      <p class="muted small">${t('Choose a VM\'s network in Edit → Network, or when creating it.')}</p>
      <h2 class="pane-title">${t('Home network (bridges)')}</h2>
      <ul class="rows">${d.bridges.map((b) => `<li>
          <div><div class="row-title">${esc(b.name)} <span class="pill ${b.up ? 'ok' : ''}">${t('Bridge')}</span></div>
            <div class="row-sub">${esc(b.address || t('no IP address'))}</div><div class="row-sub">${vmsText(b.vms)}</div></div>
          <div class="row-side"></div></li>`).join('')
        || `<li><span class="muted">${t('No bridge yet. Create br0 in')} <a href="#settings/network">${t('Settings → Network')}</a> ${t("to give VMs their own address in your home network.")}</span></li>`}</ul>
      <p class="muted small" style="margin-top:8px">${t('A VM on a bridge is a normal device in your home network: your router gives it an address. Needed for Home Assistant.')}</p>
      <h2 class="pane-title">${t('VM networks')}</h2>
      <ul class="rows">${d.networks.map((n) => `<li>
          <div><div class="row-title">${esc(n.name)} <span class="pill">${esc(t(NET_MODE[n.mode] || n.mode))}</span>${n.active ? '' : ` <span class="pill warn">${t('not active')}</span>`}</div>
            <div class="row-sub">${esc([n.subnet, n.dhcp && t('DHCP {start} – {end}', n.dhcp), n.bridge && t('via {name}', { name: n.bridge })].filter(Boolean).join(' · '))}</div>
            <div class="row-sub">${vmsText(n.vms)}</div></div>
          <div class="row-side btn-row">${n.active ? '' : `<button class="btn sm" type="button" data-vmnet-start="${esc(n.name)}">${t('Start')}</button>`}
            ${n.builtin ? `<span class="muted">${t('default')}</span>` : `<button class="btn sm danger" type="button" data-vmnet-del="${esc(n.name)}"${n.vms.length ? ` disabled title="${t("Choose another network for these VMs first.")}"` : ''}>${t('Remove')}</button>`}</div></li>`).join('')
        || `<li><span class="muted">${t('No VM networks yet.')}</span></li>`}</ul>
      <h2 class="pane-title">${t('Create VM network')}</h2>
      <form class="form" id="vnForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Name')}</span><input class="field" name="name" maxlength="32" placeholder="${t('e.g. lab')}" autocomplete="off" spellcheck="false"></label>
          <label class="fld"><span>${t('Type')}</span><select class="field" name="mode">
            <option value="nat">${t('NAT (with internet)')}</option><option value="isolated">${t('Isolated (no internet)')}</option></select></label>
        </div>
        <p class="muted small" id="vnHelp"></p>
        <label class="fld"><span>${t('Subnet')}</span><input class="field" name="subnet" value="${esc(suggest)}" spellcheck="false" autocomplete="off">
          <small>${t('A private subnet that is not used anywhere yet. The server gets the first address.')}</small></label>
        <label class="check"><input type="checkbox" name="dhcp" checked> ${t("Hand out addresses with DHCP (VMs get an address automatically)")}</label>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Create')}</button></div>
      </form>`;
    const form = $('#vnForm', el), F = form.elements;
    const help = { nat: "The VMs can reach the internet and each other, but you cannot reach them from your home network. Handy for trying things out.",
      isolated: "The VMs can only reach each other and the server, not the internet. Handy for an isolated lab." };
    const sync = () => { $('#vnHelp', form).textContent = t(help[F.mode.value]); };
    F.mode.addEventListener('change', sync); sync();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form), btn = $('[type=submit]', form); err.textContent = '';
      if (!F.name.value.trim()) { err.textContent = t('Give the network a name.'); F.name.focus(); return; }
      btn.disabled = true;
      try {
        const r = await api.post('/api/vm-networks', { name: F.name.value.trim(), mode: F.mode.value, subnet: F.subnet.value.trim(), dhcp: F.dhcp.checked });
        toast(t('Network {name} created.', { name: r.name })); vmNetPane(el);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    el.onclick = async (e) => {
      const st = e.target.closest('[data-vmnet-start]');
      if (st) {
        st.disabled = true;
        try { await api.post('/api/vm-networks/' + encodeURIComponent(st.dataset.vmnetStart) + '/start'); vmNetPane(el); }
        catch (ex) { toast(ex.message, true); st.disabled = false; }
        return;
      }
      const del = e.target.closest('[data-vmnet-del]');
      if (!del) return;
      const name = del.dataset.vmnetDel;
      if (!(await ask(t("Delete VM network {name}? No VM uses it anymore.", { name }), t('Remove')))) return;
      del.disabled = true;
      try { await api.del('/api/vm-networks/' + encodeURIComponent(name)); toast(t('Network {name} deleted.', { name })); vmNetPane(el); }
      catch (ex) { toast(ex.message, true); del.disabled = false; }
    };
  }

  /* --- Shared folders (Samba) and their users: a window of its own, in the menu at the top */
  function sharesWindow() {
    openWindow(t('Shared folders'), `<p class="lead">${t('Loading…')}</p>`, (body) => sharesPane(body));
    onWinClose = () => loadShares(); // update the widget after changes
  }
  const ACCESS = { ro: 'Read', rw: 'Read and write' };
  async function sharesPane(el, editing) {
    el.onchange = null;
    el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let d;
    try { d = await api.get('/api/shares'); } catch (e) { el.innerHTML = `<p class="lead">${t('The shared folders could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    if (!el.isConnected) return; // window closed in the meantime or something else opened
    if (!d.installed) {
      el.innerHTML = `<p class="lead">${t('Samba is not installed yet. Run install.sh again, or on the server: sudo apt install samba')}</p>`;
      return;
    }
    if (editing !== undefined) return shareForm(el, d, editing);
    const host = d.hostname;
    el.innerHTML = `
      ${d.running ? '' : `<p class="lead temp-warn">${t('Samba is not running. Start it on the server with: sudo systemctl start smbd')}</p>`}
      <div class="bays-head"><h2 class="pane-title" style="margin:0">${t('Folders')}</h2>
        <button class="btn sm primary" type="button" data-share-new>+ ${t('Shared folder')}</button></div>
      <ul class="rows">${d.shares.map((sh) => `<li>
          <div><div class="row-title">${esc(sh.name)}</div>
            <div class="row-sub">${esc([sh.path, sh.comment].filter(Boolean).join(' · '))}</div>
            <div class="share-access">${Object.entries(sh.users).map(([u, a]) => `<span class="pill${a === 'rw' ? ' ok' : ''}">${esc(u)} · ${t(a === 'rw' ? 'write' : 'read')}</span>`).join('')}
              ${Object.entries(sh.groups || {}).map(([g, a]) => `<span class="pill${a === 'rw' ? ' ok' : ''}">${t('group {name}', { name: esc(g) })} · ${t(a === 'rw' ? 'write' : 'read')}</span>`).join('')}
              ${sh.guest ? `<span class="pill warn">${t('guests · read')}</span>` : ''}${sh.timemachine ? `<span class="pill">Time Machine</span>` : ''}</div>
            <div class="share-addr">smb://${esc(host)}.local/${esc(sh.name)} · \\\\${esc(host)}\\${esc(sh.name)}</div></div>
          <div class="row-side btn-row"><button class="btn sm" type="button" data-share-edit="${esc(sh.name)}">${t('Edit')}</button>
            <button class="btn sm danger" type="button" data-share-del="${esc(sh.name)}">${t('Remove')}</button></div></li>`).join('')
        || `<li><span class="muted">${t(d.users.length ? 'No shared folders yet.' : 'No shared folders yet. First create a user under Settings → Users.')}</span></li>`}</ul>
      <p class="muted small" style="margin-top:8px">${t('On a Mac: Finder → Go → Connect to Server. On Windows: type the address with \\\\ in File Explorer.')}</p>

      <h2 class="pane-title">${t('Users and groups')}</h2>
      <p class="muted small">${t('{users} and {groups}. You manage users, passwords and who is in which group under Settings → Users.', { users: t(d.users.length === 1 ? '{n} user' : '{n} users', { n: d.users.length }), groups: t(d.groups.length === 1 ? '{n} group' : '{n} groups', { n: d.groups.length }) })}</p>
      <div class="btn-row" style="margin-top:8px"><a class="btn" href="#settings/users">${t('Manage users and groups')}</a></div>`;
    el.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.shareNew != null) return sharesPane(el, null);
      if (b.dataset.shareEdit) return sharesPane(el, b.dataset.shareEdit);
      if (b.dataset.shareDel) {
        const name = b.dataset.shareDel;
        if (!(await ask(t('Stop sharing {name}? The files stay where they are; only the sharing stops.', { name }), t('Remove')))) return;
        try { await api.del('/api/shares/' + encodeURIComponent(name)); toast(t('{name} is no longer shared.', { name })); sharesPane(el); } catch (ex) { toast(ex.message, true); }
        return;
      }
    };
  }

  // New or existing shared folder: name, folder, who may do what, guests and Time Machine.
  function shareForm(el, d, editName) {
    const cur = editName ? d.shares.find((x) => x.name === editName) : null;
    const pools = d.roots.filter((r) => !r.name.includes('/'));
    const sh = cur || { name: '', path: '', comment: '', users: {}, groups: {}, guest: false, timemachine: false };
    el.onclick = null;
    el.innerHTML = `
      <h2 class="pane-title">${cur ? t('Edit {name}', { name: esc(cur.name) }) : t('New shared folder')}</h2>
      <form class="form" id="shareForm" novalidate>
        <label class="fld"><span>${t('Name')}</span><input class="field" name="name" maxlength="32" value="${esc(sh.name)}" autocomplete="off" spellcheck="false" placeholder="${t('e.g. media')}">
          <small>${t('This is the folder\'s name on your computer: smb://{host}.local/name', { host: esc(d.hostname) })}</small></label>
        ${cur ? `<input type="hidden" name="where" value="existing">` : `
        <fieldset class="fld"><span>${t('Folder')}</span><div class="radio-row">
          <label class="check"><input type="radio" name="where" value="new"${pools.length ? ' checked' : ' disabled'}> ${t('New folder on a pool')}</label>
          <label class="check"><input type="radio" name="where" value="existing"${pools.length ? '' : ' checked'}> ${t('Existing folder')}</label></div></fieldset>`}
        <label class="fld" data-where="new"><span>${t('Pool')}</span><select class="field" name="parent">${pools.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} (${esc(p.mountpoint)})</option>`).join('')}</select>
          <small>${t('HomeBaseOS creates its own dataset, e.g. tank/media, owned by the app user.')}</small></label>
        <label class="fld" data-where="existing"><span>${t('Folder on the server')}</span><input class="field" name="path" list="shareRoots" value="${esc(sh.path)}" spellcheck="false" autocomplete="off" placeholder="/tank/media">
          <datalist id="shareRoots">${d.roots.map((r) => `<option value="${esc(r.mountpoint)}">`).join('')}</datalist>
          <small>${t('A folder on one of your pools.')}${d.appUser ? ' ' + t('Files are written as {user}, like your Docker apps.', { user: esc(d.appUser) }) : ''}</small></label>
        <label class="fld"><span>${t('Description')} <em class="muted">${t('(optional)')}</em></span><input class="field" name="comment" maxlength="100" value="${esc(sh.comment)}"></label>
        <fieldset class="fld"><span>${t('Who has access?')}</span>
          <div class="access-table">${d.users.map((u) => `<div class="access-row"><b>${esc(u.name)}</b>
            <select class="field" name="u:${esc(u.name)}" aria-label="${esc(t('Access for {name}', { name: u.name }))}">
              <option value="">${t('No access')}</option>${Object.entries(ACCESS).map(([k, label]) => `<option value="${k}"${sh.users[u.name] === k ? ' selected' : ''}>${t(label)}</option>`).join('')}</select></div>`).join('')}
            ${d.groups.map((g) => `<div class="access-row"><b>${t('group {name}', { name: esc(g.name) })}</b>
            <select class="field" name="g:${esc(g.name)}" aria-label="${esc(t('Access for group {name}', { name: g.name }))}">
              <option value="">${t('No access')}</option>${Object.entries(ACCESS).map(([k, label]) => `<option value="${k}"${(sh.groups || {})[g.name] === k ? ' selected' : ''}>${t(label)}</option>`).join('')}</select></div>`).join('')}</div>
          ${d.users.length ? '' : `<small>${t('No users yet. Create them under Settings → Users.')}</small>`}</fieldset>
        <label class="check"><input type="checkbox" name="guest"${sh.guest ? ' checked' : ''}> ${t('Guests may read without a password')}</label>
        <p class="muted small" style="margin-top:-6px">${t('Handy for e.g. music or documents for everyone at home. Only those with Read and write above can write.')}</p>
        <label class="check"><input type="checkbox" name="timemachine"${sh.timemachine ? ' checked' : ''}> ${t('Use for Time Machine (Mac backups)')}</label>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t(cur ? 'Save' : 'Share')}</button><button class="btn" type="button" data-share-cancel>${t('Cancel')}</button></div>
      </form>`;
    const f = $('#shareForm', el), F = f.elements;
    const sync = () => { const w = (f.querySelector('[name=where]:checked') || F.where).value; $$('[data-where]', f).forEach((x) => { x.hidden = x.dataset.where !== w; }); };
    f.addEventListener('change', (e) => { if (e.target.name === 'where') sync(); }); sync();
    f.querySelector('[data-share-cancel]').addEventListener('click', () => sharesPane(el));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', f), btn = $('[type=submit]', f); err.textContent = '';
      const users = {};
      d.users.forEach((u) => { const v = F['u:' + u.name].value; if (v) users[u.name] = v; });
      const groups = {};
      d.groups.forEach((g) => { const v = F['g:' + g.name].value; if (v) groups[g.name] = v; });
      const where = (f.querySelector('[name=where]:checked') || F.where).value;
      const body = { name: F.name.value.trim(), comment: F.comment.value, users, groups, guest: F.guest.checked, timemachine: F.timemachine.checked,
        ...(where === 'new' ? { create: { parent: F.parent.value } } : { path: F.path.value.trim() }) };
      btn.disabled = true;
      try {
        await api.post('/api/shares' + (cur ? '/' + encodeURIComponent(cur.name) : ''), body);
        toast(t(cur ? '{name} saved.' : '{name} is now shared.', { name: body.name }));
        sharesPane(el);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    F.name.focus();
  }

  /* --- Backups: the NAS to the cloud or another NAS (rclone), and devices to the NAS (a shared folder per device) */
  const BK_TABS = [['jobs', 'Sync'], ['system', "Apps and VMs"], ['devices', 'Devices'], ['remotes', 'Connections']];
  const DEV_KINDS = { mac: 'Mac', windows: 'Windows PC', linux: 'Linux PC', phone: 'Phone or tablet' };
  const bk = { tab: 'jobs', timer: null, openDevice: null, secret: null }; // secret: a password you see only once
  function backupWindow(tab) {
    if (tab) bk.tab = tab;
    openWindow(t('Backups'), `<p class="lead">${t('Loading…')}</p>`, (body) => backupPane(body));
    onWinClose = () => { clearTimeout(bk.timer); bk.timer = null; loadBackups(); }; // update the widget after changes
  }
  function ago(ms) {
    const s = Math.round((ms - Date.now()) / 1000), a = Math.abs(s);
    const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
    if (a < 60) return rtf.format(0, 'second');
    if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  }
  const hhmm = (v) => { const [h, m] = String(v || '03:00').split(':').map(Number); return new Date(2026, 0, 1, h, m).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', ...clockOpts() }); };
  const weekday = (n) => new Date(2026, 9, 18 + Number(n)).toLocaleDateString(LOCALE, { weekday: 'long' }); // 18 October 2026 is a Sunday
  const when = (ms) => new Date(ms).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...clockOpts() });
  function scheduleText(s) {
    if (!s || s.every === 'manual') return t('Manually only');
    if (s.every === 'hourly') return t('Every hour');
    if (s.every === 'daily') return t('Every day at {time}', { time: hhmm(s.time) });
    return t('Every {day} at {time}', { day: weekday(s.day), time: hhmm(s.time) });
  }
  const eta = (sec) => (sec == null ? '' : sec < 60 ? t('{s} s', { s: Math.max(1, Math.round(sec)) }) : duration(sec));
  function runSummary(x) {
    const parts = [t(x.files === 1 ? '{n} file transferred' : '{n} files transferred', { n: nf0.format(x.files || 0) }) + (x.bytes ? ' (' + bytes(x.bytes) + ')' : '')];
    if (x.deletes) parts.push(t('{n} deleted', { n: nf0.format(x.deletes) }));
    return parts.join(' · ');
  }
  function bkProgress(r) {
    const pct = r.percent == null ? 0 : r.percent;
    const line = r.totalBytes ? t('{done} of {total}', { done: bytes(r.bytes), total: bytes(r.totalBytes) }) : t('Comparing files…');
    return `<div class="bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <div class="row-sub">${esc(line)}${r.speed ? ' · ' + esc(bytes(r.speed)) + '/s' : ''}${r.eta ? ' · ' + esc(t('{time} left', { time: eta(r.eta) })) : ''}</div>`;
  }
  function runPill(j) {
    const r = j.running;
    if (r) return `<span class="pill">${t(r.kind === 'restore' ? 'Restore' : r.dryRun ? 'Dry run' : 'In progress')}${r.percent != null ? ' ' + Math.floor(r.percent) + '%' : '…'}</span>`;
    const l = j.lastRun;
    if (!l) return `<span class="pill">${t('Not done yet')}</span>`;
    return `<span class="pill ${l.state === 'ok' ? 'ok' : l.state === 'failed' ? 'bad' : 'warn'}">${t(l.state === 'ok' ? 'Succeeded' : l.state === 'failed' ? 'Failed' : 'Stopped')}</span>`;
  }

  async function backupPane(el, quiet) {
    clearTimeout(bk.timer); bk.timer = null;
    if (!quiet) el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let d;
    try { d = await api.get('/api/backup'); } catch (e) { if (!quiet) el.innerHTML = `<p class="lead">${t('The backups could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    if (!el.isConnected) return; // window closed in the meantime or something else opened
    S.backup = { installed: d.installed, jobs: d.jobs, devices: d.devices.length }; renderBackupWidget();
    const scroll = el.scrollTop;
    el.innerHTML = `
      <div class="seg vm-tabs" role="tablist" aria-label="${t('Sections')}">${BK_TABS.map(([k, label]) =>
        `<button type="button" role="tab" aria-selected="${k === bk.tab}" data-bktab="${k}">${t(label, null, 'backup')}</button>`).join('')}</div>
      <div id="bkBody"></div>`;
    el.onclick = (e) => { const b = e.target.closest('[data-bktab]'); if (b) { bk.tab = b.dataset.bktab; backupPane(el); } };
    const box = $('#bkBody', el);
    ({ jobs: bkJobs, system: bkSystem, devices: bkDevices, remotes: bkRemotes })[bk.tab](box, d, el);
    if (quiet) el.scrollTop = scroll;
    if (bk.tab === 'jobs' && d.jobs.some((j) => j.running)) bk.timer = setTimeout(() => { if (el.isConnected && $('#bkJobList', el)) backupPane(el, true); }, 2000);
  }

  /* tasks: sync with the cloud or another NAS */
  function bkJobs(box, d, el) {
    if (!d.installed) {
      box.innerHTML = `<div class="notice warn">${t('rclone is not installed on the server. Run install.sh again, or on the server: sudo apt install rclone')}</div>`;
      return;
    }
    const remote = (n) => d.remotes.find((r) => r.name === n);
    const row = (j) => {
      const dest = j.remote + ':' + (j.remotePath || '/');
      const route = j.direction === 'pull' ? `${dest} → ${j.localPath}` : `${j.localPath} → ${dest}`;
      const r = remote(j.remote), l = j.lastRun;
      const tags = [t(j.mode === 'sync' ? 'Sync' : 'Copy'), j.encrypt ? t('Encrypted') : null, j.versions ? t('Versions {n} days', { n: j.keepDays }) : null].filter(Boolean);
      return `<li>
        <div><div class="row-title">${esc(j.name)} ${runPill(j)}</div>
          <div class="row-sub">${esc(route)}${r ? ' · ' + esc(tr(r.label)) : ''}</div>
          <div class="row-sub">${esc(scheduleText(j.schedule))}${j.next ? ' · ' + esc(t('next: {when}', { when: when(j.next) })) : ''} · ${esc(tags.join(' · '))}</div>
          ${!j.running && l ? `<div class="row-sub">${esc(t('Last: {when}', { when: ago(l.ended) }))}${l.state === 'ok' ? ' · ' + esc(runSummary(l)) : ''}</div>` : ''}
          ${!j.running && l && l.state === 'failed' && l.error ? `<div class="row-sub temp-bad">${esc(tr(l.error))}</div>` : ''}</div>
        <div class="row-side btn-row">
          ${j.running ? `<button class="btn sm" type="button" data-bk-stop="${esc(j.id)}">${t('Stop')}</button>` : `<button class="btn sm primary" type="button" data-bk-run="${esc(j.id)}">${t('Start now')}</button>`}
          <button class="btn sm" type="button" data-bk-log="${esc(j.id)}">${t('Logs')}</button>
          <button class="btn sm" type="button" data-bk-edit="${esc(j.id)}"${j.running ? ' disabled' : ''}>${t('Edit')}</button></div>
        ${j.running ? `<div class="row-bar">${bkProgress(j.running)}</div>` : ''}</li>`;
    };
    box.innerHTML = `
      <p class="lead">${t('Put files from your NAS in the cloud (Google Drive, OneDrive, Dropbox, S3) or on another NAS, on a schedule. Or fetch them from there.')}</p>
      ${d.remotes.length ? '' : `<div class="notice">${t('First create a connection to your cloud or your other NAS.')}<div><button class="btn sm primary" type="button" data-bktab="remotes">${t('Add connection')}</button></div></div>`}
      <div class="bays-head"><h2 class="pane-title" style="margin:0">${t('Tasks')}</h2>
        <button class="btn sm primary" type="button" data-bk-new${d.remotes.length ? '' : ' disabled'}>+ ${t('Task')}</button></div>
      <ul class="rows bk-rows" id="bkJobList">${d.jobs.map(row).join('') || `<li><span class="muted">${t('No tasks yet.')}</span></li>`}</ul>`;
    const job = (id) => d.jobs.find((j) => j.id === id);
    box.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b || b.dataset.bktab) return;
      if (b.dataset.bkNew != null) return bkJobForm(box, d, el, null);
      if (b.dataset.bkEdit) return bkJobForm(box, d, el, job(b.dataset.bkEdit));
      if (b.dataset.bkLog) return bkLog(box, el, job(b.dataset.bkLog));
      if (b.dataset.bkRun) {
        const j = job(b.dataset.bkRun);
        return withBusy(b, async () => { await api.post('/api/backup/jobs/' + j.id + '/run', {}); toast(t('{name} started.', { name: j.name })); backupPane(el, true); });
      }
      if (b.dataset.bkStop) {
        const j = job(b.dataset.bkStop);
        if (!(await ask(t('Stop {name}? What has already been transferred stays.', { name: j.name }), t('Stop')))) return;
        return withBusy(b, async () => { await api.post('/api/backup/jobs/' + j.id + '/stop', {}); toast(t('{name} is stopping.', { name: j.name })); backupPane(el, true); });
      }
    };
  }

  function bkJobForm(box, d, el, job) {
    clearTimeout(bk.timer);
    const j = job || { name: '', direction: 'push', mode: 'copy', remote: d.remotes[0].name, remotePath: '', localPath: '', schedule: { every: 'daily', time: '03:00', day: 0 },
      versions: false, keepDays: 30, excludes: [], bwlimit: '', encrypt: false };
    const opt = (v, cur, label) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
    const radio = (name, v, cur, title, help) => `<label class="check dev"><input type="radio" name="${name}" value="${v}"${v === cur ? ' checked' : ''}><span><b>${title}</b><small class="muted">${help}</small></span></label>`;
    box.innerHTML = `
      <h2 class="pane-title">${job ? t('Edit {name}', { name: esc(job.name) }) : t('New task')}</h2>
      <form class="form" id="bkJobForm" novalidate>
        <label class="fld"><span>${t('Name')}</span><input class="field" name="name" maxlength="60" value="${esc(j.name)}" autocomplete="off" placeholder="${t("e.g. Photos to Google Drive")}"></label>
        <fieldset class="fld"><span>${t('Direction')}</span><div class="form" style="gap:8px">
          ${radio('direction', 'push', j.direction, t('From the NAS to the cloud or another NAS'), t('A backup of your files outside the house.'))}
          ${radio('direction', 'pull', j.direction, t('From the cloud or another NAS to the NAS'), t('E.g. also keep your Google Drive or OneDrive at home.'))}</div></fieldset>
        <label class="fld"><span>${t('Folder on the NAS')}</span><input class="field" name="localPath" list="bkFolders" value="${esc(j.localPath)}" spellcheck="false" autocomplete="off" placeholder="/tank/photos">
          <datalist id="bkFolders">${d.folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist><small data-local-help></small></label>
        <label class="fld"><span>${t('Connection')}</span><select class="field" name="remote">${d.remotes.map((r) => opt(r.name, j.remote, r.name + ' (' + tr(r.label) + ')')).join('')}</select></label>
        <label class="fld"><span>${t('Folder on the destination')}</span><span class="inline-form"><input class="field" name="remotePath" value="${esc(j.remotePath)}" spellcheck="false" autocomplete="off" placeholder="${t('e.g. Backups/Freddy')}">
          <button class="btn" type="button" data-browse>${t('Browse')}</button></span><small>${t('Empty = the top folder.')}</small></label>
        <div class="bk-browse" id="bkBrowse" hidden></div>
        <fieldset class="fld"><span>${t('How')}</span><div class="form" style="gap:8px">
          ${radio('mode', 'copy', j.mode, t('Copy'), t('Transfer new and changed files. What you delete stays on the other side.'))}
          ${radio('mode', 'sync', j.mode, t('Sync'), t('The destination becomes an exact copy: what you delete disappears there too.'))}</div></fieldset>
        <fieldset class="fld"><span>${t('When')}</span><span class="inline-form">
          <select class="field" name="every">${[['manual', 'Manually only'], ['hourly', 'Every hour'], ['daily', 'Every day'], ['weekly', 'Every week']].map(([v, l]) => opt(v, j.schedule.every, t(l))).join('')}</select>
          <select class="field" name="day" data-sched="weekly" aria-label="${t('Day')}">${[1, 2, 3, 4, 5, 6, 0].map((n) => opt(n, j.schedule.day, weekday(n))).join('')}</select>
          <input class="field" type="time" name="time" data-sched="time" value="${esc(j.schedule.time)}" aria-label="${t('Time')}"></span>
          <small data-sched-help>${t('At a fixed time, e.g. at night. If the server was off, it catches up as soon as it is back on.')}</small></fieldset>
        <div class="form" data-push>
          ${job ? (j.encrypt ? `<p class="muted small">${t('This task is encrypted. The password can no longer be changed.')}</p>` : '') : `
          <label class="check"><input type="checkbox" name="encrypt"> ${t('Encrypt')}</label>
          <div class="form" data-encrypt hidden>
            <p class="muted small">${t('Files and folder names are encrypted before they leave the NAS. Without this password nobody gets them back, not even you. Keep it safe, e.g. in your password manager.')}</p>
            <div class="fld-row">
              <label class="fld"><span>${t('Password')}</span><input class="field" type="password" name="password" autocomplete="new-password"><small>${t('At least 10 characters.')}</small></label>
              <label class="fld"><span>${t('Repeat password')}</span><input class="field" type="password" name="password2" autocomplete="new-password"></label></div></div>`}
          <label class="check"><input type="checkbox" name="versions"${j.versions ? ' checked' : ''}> ${t('Keep old versions')}</label>
          <div class="form" data-versions hidden>
            <p class="muted small">${t('What gets overwritten or deleted first goes to a folder next to it ("… (old versions)"). After the number of days below it disappears.')}</p>
            <label class="fld" style="max-width:220px"><span>${t('Days to keep')}</span><input class="field" type="number" name="keepDays" min="1" max="3650" value="${esc(j.keepDays)}"></label></div>
        </div>
        <details class="adv"><summary>${t('Advanced')}</summary><div class="form" style="margin-top:10px">
          <label class="fld"><span>${t('Exclude')}</span><textarea class="field" name="excludes" rows="3" spellcheck="false" placeholder="*.tmp&#10;.DS_Store&#10;cache/**">${esc((j.excludes || []).join('\n'))}</textarea>
            <small>${t('One pattern per line, as in rclone.')}</small></label>
          <label class="fld" style="max-width:260px"><span>${t('Maximum speed')}</span><input class="field" name="bwlimit" value="${esc(j.bwlimit)}" placeholder="${t('e.g. 10M')}">
            <small>${t('In bytes per second, with K, M or G. Empty = as fast as possible.')}</small></label></div></details>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t(job ? 'Save' : 'Create')}</button><button class="btn" type="button" data-cancel>${t('Cancel')}</button></div>
      </form>
      ${job ? `<h2 class="pane-title">${t('More')}</h2>
        <div class="btn-row"><button class="btn" type="button" data-bk-dry>${t('Dry run')}</button>
          ${job.direction === 'push' ? `<button class="btn" type="button" data-bk-restore>${t('Restore…')}</button>` : ''}
          <button class="btn danger" type="button" data-bk-del>${t('Remove')}</button></div>
        <p class="muted small" style="margin-top:8px">${t('A dry run shows in the log what the task would do, without changing anything.')}</p>` : ''}`;
    const f = $('#bkJobForm', box), F = f.elements, err = $('.form-error', f);
    const val = (n) => (f.querySelector(`[name=${n}]:checked`) || {}).value;
    const sync = () => {
      const push = val('direction') === 'push';
      $('[data-push]', f).hidden = !push;
      $('[data-local-help]', f).textContent = push ? t('The folder you want to keep safe.') : t('The files go here. HomeBaseOS creates the folder if it doesn\'t exist yet.');
      $$('[data-sched]', f).forEach((x) => { x.hidden = x.dataset.sched === 'weekly' ? F.every.value !== 'weekly' : F.every.value === 'manual'; });
      $('[data-sched-help]', f).hidden = F.every.value === 'manual';
      if ($('[data-encrypt]', f)) $('[data-encrypt]', f).hidden = !F.encrypt.checked;
      $('[data-versions]', f).hidden = !F.versions.checked;
    };
    f.addEventListener('change', sync); sync();
    $('[data-cancel]', f).addEventListener('click', () => backupPane(el));

    // Browse the folders of the connection.
    const br = $('#bkBrowse', box);
    async function browseTo(p) {
      br.hidden = false; br.innerHTML = `<p class="muted small">${t('Loading…')}</p>`;
      let r;
      try { r = await api.get('/api/backup/remotes/' + encodeURIComponent(F.remote.value) + '/browse?path=' + encodeURIComponent(p)); }
      catch (ex) { br.innerHTML = `<p class="form-error">${esc(ex.message)}</p>`; return; }
      F.remotePath.value = r.path;
      const up = r.path.replace(/\/?[^/]*$/, '');
      br.innerHTML = `<div class="bk-browse-head"><b>${esc(F.remote.value)}:${esc(r.path || '/')}</b>
          ${r.path && r.path !== '/' ? `<button class="btn sm" type="button" data-dir-up="${esc(up)}">${t('Up one folder')}</button>` : ''}
          <button class="btn sm primary" type="button" data-dir-close>${t('Choose this folder')}</button></div>
        <div class="bk-dirs">${r.dirs.map((x) => `<button class="btn sm" type="button" data-dir="${esc(x)}">${esc(x)}</button>`).join('') || `<span class="muted small">${t('No folders.')}</span>`}</div>`;
      br.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.dirClose != null) { br.hidden = true; return; }
        if (b.dataset.dirUp != null) return browseTo(b.dataset.dirUp);
        if (b.dataset.dir) return browseTo((r.path && r.path !== '/' ? r.path.replace(/\/$/, '') + '/' : r.path) + b.dataset.dir);
      };
    }
    $('[data-browse]', f).addEventListener('click', () => browseTo(F.remotePath.value));
    F.remote.addEventListener('change', () => { if (!br.hidden) browseTo(''); });

    f.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const body = {
        name: F.name.value, direction: val('direction'), mode: val('mode'), remote: F.remote.value, remotePath: F.remotePath.value, localPath: F.localPath.value.trim(),
        schedule: { every: F.every.value, time: F.time.value || '03:00', day: Number(F.day.value) },
        versions: F.versions.checked, keepDays: Number(F.keepDays.value), excludes: F.excludes.value, bwlimit: F.bwlimit.value,
      };
      if (F.encrypt && F.encrypt.checked && body.direction === 'push') {
        if (F.password.value.length < 10) { err.textContent = t('Choose an encryption password of at least 10 characters.'); return; }
        if (F.password.value !== F.password2.value) { err.textContent = t('The two passwords do not match.'); return; }
        body.encrypt = true; body.password = F.password.value;
      }
      if (body.mode === 'sync' && (!job || job.mode !== 'sync' || job.direction !== body.direction)) {
        const dest = body.remote + ':' + (body.remotePath || '/');
        const [src, dst] = body.direction === 'push' ? [body.localPath, dest] : [dest, body.localPath];
        if (!(await ask(t('Syncing makes {dest} an exact copy of {src}: what is in {dest} and not in {src} gets deleted. Continue?', { src, dest: dst }), t('Sync')))) return;
      }
      const btn = $('[type=submit]', f); btn.disabled = true;
      try {
        await api.post('/api/backup/jobs' + (job ? '/' + job.id : ''), body);
        toast(t(job ? '{name} saved.' : 'Task {name} created.', { name: body.name.trim() }));
        backupPane(el);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    if (!job) { F.name.focus(); return; }
    box.querySelector('[data-bk-dry]').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
      await api.post('/api/backup/jobs/' + job.id + '/run', { dryRun: true });
      bkLog(box, el, job);
    }));
    const rs = box.querySelector('[data-bk-restore]');
    if (rs) rs.addEventListener('click', () => bkRestore(box, el, job));
    box.querySelector('[data-bk-del]').addEventListener('click', async (e) => {
      const msg = t('Remove task {name}? The files on the NAS and on the destination stay.', { name: job.name })
        + (job.encrypt ? ' ' + t('Note: the encryption key is removed too. Without your password you can then no longer read the encrypted files.') : '');
      if (!(await ask(msg, t('Remove')))) return;
      withBusy(e.target, async () => { await api.del('/api/backup/jobs/' + job.id); toast(t('Task {name} removed.', { name: job.name })); backupPane(el); });
    });
  }

  // Restore: everything from the destination back to a folder on the NAS (by default a new folder next to the original).
  function bkRestore(box, el, job) {
    clearTimeout(bk.timer);
    box.innerHTML = `
      <h2 class="pane-title">${t('Restore {name}', { name: esc(job.name) })}</h2>
      <p class="lead">${t('HomeBaseOS fetches everything from {dest} and puts it in the folder below. Existing files with the same name are overwritten.', { dest: esc(job.remote + ':' + (job.remotePath || '/')) })}${job.encrypt ? ' ' + t('The files are decrypted right away.') : ''}</p>
      <form class="form" id="bkRestoreForm" novalidate>
        <label class="fld"><span>${t('Restore to')}</span><input class="field" name="target" value="${esc(job.localPath.replace(/\/$/, '') + '-teruggezet')}" spellcheck="false" autocomplete="off">
          <small>${t('A new folder is safest: you then choose yourself what to put back. Choose {path} to top up the original folder.', { path: esc(job.localPath) })}</small></label>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Restore')}</button><button class="btn" type="button" data-cancel>${t('Cancel')}</button></div>
      </form>`;
    const f = $('#bkRestoreForm', box);
    $('[data-cancel]', f).addEventListener('click', () => backupPane(el));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const target = f.elements.target.value.trim().replace(/\/+$/, '');
      if (target === job.localPath && !(await ask(t('Restore into {path}? Files with the same name are overwritten by the version from the destination.', { path: target }), t('Restore')))) return;
      const btn = $('[type=submit]', f); btn.disabled = true;
      try { await api.post('/api/backup/jobs/' + job.id + '/restore', { target }); toast(t('Restore started.')); bkLog(box, el, job); }
      catch (ex) { $('.form-error', f).textContent = ex.message; btn.disabled = false; }
    });
  }

  // base: /api/backup/jobs/ (sync) or /api/sysbackups/ (apps and VMs).
  async function bkLog(box, el, job, base = '/api/backup/jobs/') {
    clearTimeout(bk.timer);
    const sys = base.includes('sysbackups');
    let l;
    try { l = await api.get(base + job.id + '/log'); } catch (e) { toast(e.message, true); return; }
    if (!box.isConnected) return;
    const old = $('.logs', box), atEnd = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 20;
    const r = l.running, x = l.last;
    const time = (s) => (s ? new Date(s).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', ...clockOpts() }) : '');
    box.innerHTML = `
      <div class="bays-head"><h2 class="pane-title" style="margin:0">${esc(job.name)}</h2>
        <span class="btn-row">${r ? `<button class="btn sm" type="button" data-log-stop>${t('Stop')}</button>` : ''}<button class="btn sm" type="button" data-log-back>${t('Back')}</button></span></div>
      ${r ? `<p class="lead">${t(r.kind === 'restore' ? 'Restoring…' : r.dryRun ? 'Dry run in progress: nothing changes.' : 'Working…')}</p><div style="margin-bottom:14px">${sys ? sysProgress(r) : bkProgress(r)}</div>`
        : x ? `<p class="lead"><span class="pill ${x.state === 'ok' ? 'ok' : x.state === 'failed' ? 'bad' : 'warn'}">${t(x.state === 'ok' ? 'Succeeded' : x.state === 'failed' ? 'Failed' : 'Stopped')}</span>
            ${esc(t(x.kind === 'restore' ? 'Restore' : x.dryRun ? 'Dry run' : 'Backup'))} · ${esc(ago(x.ended))} · ${esc(sys ? sysSummary(x) : runSummary(x))}${x.error ? `<br><span class="temp-bad">${esc(tr(x.error))}</span>` : ''}</p>` : ''}
      <pre class="logs logs-big">${l.lines.map((z) => `<span class="ts">${esc(time(z.time))}</span> ${['error', 'critical', 'fatal'].includes(z.level) ? `<span class="err">${esc(tr(z.text))}</span>` : esc(tr(z.text))}`).join('\n') || esc(t('No log yet. Start the task to create one.'))}</pre>`;
    const pre = $('.logs', box);
    if (atEnd) pre.scrollTop = pre.scrollHeight;
    $('[data-log-back]', box).addEventListener('click', () => backupPane(el));
    const stop = $('[data-log-stop]', box);
    if (stop) stop.addEventListener('click', async () => {
      if (!(await ask(t('Stop {name}? What has already been transferred stays.', { name: job.name }), t('Stop')))) return;
      withBusy(stop, () => api.post(base + job.id + '/stop', {}));
    });
    if (r) bk.timer = setTimeout(() => { if (box.isConnected && $('.logs', box)) bkLog(box, el, job, base); }, 2000);
  }

  /* apps and VMs: a copy of the chosen apps (Docker) and VMs in a folder on the NAS (lib/sysbackup.js) */
  const sysProgress = (r) => `<div class="bar" aria-hidden="true"><span style="width:${r.total ? Math.round(((r.done + (r.percent || 0) / 100) / r.total) * 100) : 0}%"></span></div>
    <div class="row-sub">${esc(t('{done} of {total} done', { done: r.done, total: r.total }))}${r.current ? ' · ' + esc(t('now: {name}', { name: r.current })) : ''}${r.percent != null ? ' (' + Math.floor(r.percent) + '%)' : ''}</div>`;
  const sysSummary = (x) => [t(x.items === 1 ? '{n} item' : '{n} items', { n: x.items || 0 }), x.size ? bytes(x.size) : null, x.errors ? t('{n} errors', { n: x.errors }) : null].filter(Boolean).join(' · ');

  async function bkSystem(box, d, el) {
    box.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let s;
    try { s = await api.get('/api/sysbackups'); } catch (e) { box.innerHTML = `<p class="lead">${esc(e.message)}</p>`; return; }
    if (!box.isConnected) return;
    const label = (id) => { const a = s.apps.find((x) => x.id === id); return prettyName(a ? a.name : id.split(':')[1]); };
    const row = (j) => {
      const l = j.lastRun;
      const what = [...j.apps.map(label), ...j.vms].join(', ');
      return `<li>
        <div><div class="row-title">${esc(j.name)} ${runPill(j)}</div>
          <div class="row-sub">${esc(what)} → ${esc(j.dest)}</div>
          <div class="row-sub">${esc(scheduleText(j.schedule))}${j.next ? ' · ' + esc(t('next: {when}', { when: when(j.next) })) : ''} · ${esc(t('keep the last {n}', { n: j.keep }))}</div>
          ${!j.running && l ? `<div class="row-sub">${esc(t('Last: {when}', { when: ago(l.ended) }))} · ${esc(sysSummary(l))}</div>` : ''}
          ${!j.running && l && l.state === 'failed' && l.error ? `<div class="row-sub temp-bad">${esc(tr(l.error))}</div>` : ''}</div>
        <div class="row-side btn-row">
          ${j.running ? `<button class="btn sm" type="button" data-sys-stop="${esc(j.id)}">${t('Stop')}</button>` : `<button class="btn sm primary" type="button" data-sys-run="${esc(j.id)}">${t('Start now')}</button>`}
          <button class="btn sm" type="button" data-sys-log="${esc(j.id)}">${t('Logs')}</button>
          <button class="btn sm" type="button" data-sys-restore="${esc(j.id)}"${j.running ? ' disabled' : ''}>${t('Restore…')}</button>
          <button class="btn sm" type="button" data-sys-edit="${esc(j.id)}"${j.running ? ' disabled' : ''}>${t('Edit')}</button></div>
        ${j.running ? `<div class="row-bar">${sysProgress(j.running)}</div>` : ''}</li>`;
    };
    box.innerHTML = `
      <p class="lead">${t('A copy of your apps (settings and data) and VMs (disks and settings) in a folder on the NAS. Want them outside the house too? Create a task for that folder under Sync.')}</p>
      <div class="bays-head"><h2 class="pane-title" style="margin:0">${t('Tasks')}</h2>
        <button class="btn sm primary" type="button" data-sys-new>+ ${t('Task')}</button></div>
      <ul class="rows bk-rows" id="sysList">${s.jobs.map(row).join('') || `<li><span class="muted">${t('No tasks yet.')}</span></li>`}</ul>`;
    const job = (id) => s.jobs.find((j) => j.id === id);
    box.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b || b.dataset.bktab) return;
      if (b.dataset.sysNew != null) return sysJobForm(box, s, el, null);
      if (b.dataset.sysEdit) return sysJobForm(box, s, el, job(b.dataset.sysEdit));
      if (b.dataset.sysLog) return bkLog(box, el, job(b.dataset.sysLog), '/api/sysbackups/');
      if (b.dataset.sysRestore) return sysRestore(box, el, job(b.dataset.sysRestore), s);
      if (b.dataset.sysRun) {
        const j = job(b.dataset.sysRun);
        return withBusy(b, async () => { await api.post('/api/sysbackups/' + j.id + '/run', {}); toast(t('{name} started.', { name: j.name })); bkSystem(box, d, el); });
      }
      if (b.dataset.sysStop) {
        const j = job(b.dataset.sysStop);
        if (!(await ask(t('Stop {name}? What has been saved stays; the apps and VMs start again.', { name: j.name }), t('Stop')))) return;
        return withBusy(b, async () => { await api.post('/api/sysbackups/' + j.id + '/stop', {}); toast(t('{name} is stopping.', { name: j.name })); });
      }
    };
    clearTimeout(bk.timer);
    if (s.jobs.some((j) => j.running)) bk.timer = setTimeout(() => { if (box.isConnected && $('#sysList', box)) bkSystem(box, d, el); }, 3000);
  }

  function sysJobForm(box, s, el, job) {
    clearTimeout(bk.timer);
    const j = job || { name: '', dest: s.defaultDest || '', apps: [], vms: [], stopApps: true, vmMode: 'live', keep: 7, schedule: { every: 'daily', time: '02:00', day: 0 } };
    const opt = (v, cur, l) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
    const appRow = (a) => {
      const on = a.containers.some((c) => c.state === 'running');
      const extra = [t(a.containers.length === 1 ? '{n} container' : '{n} containers', { n: a.containers.length }), a.paths.length ? t('{n} folders', { n: a.paths.length }) : t('no data')];
      return `<label class="check dev"><input type="checkbox" name="app" value="${esc(a.id)}"${j.apps.includes(a.id) ? ' checked' : ''}>
        <span><span><b>${esc(prettyName(a.name))}</b> <span class="pill${on ? ' ok' : ''}">${t(on ? 'running' : 'stopped')}</span></span>
          <small class="muted">${esc(extra.join(' · '))}${a.paths.length ? ': ' + esc(a.paths.join(', ')) : ''}</small>
          ${a.skipped.length ? `<small class="muted">${esc(t('Not included: {list}', { list: a.skipped.map((x) => x.path + ' (' + t(x.reason) + ')').join(', ') }))}</small>` : ''}</span></label>`;
    };
    box.innerHTML = `
      <h2 class="pane-title">${job ? t('Edit {name}', { name: esc(job.name) }) : t('New task')}</h2>
      <form class="form" id="sysForm" novalidate>
        <label class="fld"><span>${t('Name')}</span><input class="field" name="name" maxlength="60" value="${esc(j.name)}" autocomplete="off" placeholder="${t('e.g. Apps and Home Assistant')}"></label>
        <label class="fld"><span>${t('Folder on the NAS')}</span><input class="field" name="dest" list="sysFolders" value="${esc(j.dest)}" spellcheck="false" autocomplete="off" placeholder="/tank/backups/systeem">
          <datalist id="sysFolders">${s.folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
          <small>${t('Each time a folder with the date is created here. Preferably choose a different pool than that of your apps and VMs.')}</small></label>
        <fieldset class="fld"><span>${t('Apps')}</span>
          ${s.apps.length ? `<div class="form" style="gap:6px">${s.apps.map(appRow).join('')}</div>` : `<span class="muted small">${t('No apps found.')}</span>`}
          <small>${t('Included: the compose files, folders in the app data and Docker volumes. Other mounted folders, such as your media, are not: keep those safe with Sync.')}</small></fieldset>
        <label class="check"><input type="checkbox" name="stopApps"${j.stopApps ? ' checked' : ''}> ${t('Stop apps briefly during the copy (recommended for databases)')}</label>
        <fieldset class="fld"><span>${t('VMs')}</span>
          ${s.vms.length ? `<div class="check-grid">${s.vms.map((v) => `<label class="check"><input type="checkbox" name="vm" value="${esc(v.name)}"${j.vms.includes(v.name) ? ' checked' : ''}> ${esc(v.name)} <span class="pill${vmKind(v.state) === 'on' ? ' ok' : ''}">${t(vmKind(v.state) === 'on' ? 'on' : 'off')}</span></label>`).join('')}</div>`
            : `<span class="muted small">${t('No VMs found.')}</span>`}</fieldset>
        <fieldset class="fld"><span>${t('VMs that are on')}</span><div class="form" style="gap:8px">
          <label class="check dev"><input type="radio" name="vmMode" value="live"${j.vmMode !== 'shutdown' ? ' checked' : ''}><span><b>${t('Copy while they run')}</b><small class="muted">${t('No interruption. Like a power failure at that moment: usually fine, but not for every database.')}</small></span></label>
          <label class="check dev"><input type="radio" name="vmMode" value="shutdown"${j.vmMode === 'shutdown' ? ' checked' : ''}><span><b>${t('Shut down briefly')}</b><small class="muted">${t('The VM shuts down properly, is copied and starts again. Certainly consistent, but unreachable for a few minutes.')}</small></span></label></div></fieldset>
        <div class="fld-row">
          <label class="fld"><span>${t('When')}</span><select class="field" name="every">${[['manual', 'Manually only'], ['daily', 'Every day'], ['weekly', 'Every week']].map(([v, l]) => opt(v, j.schedule.every, t(l))).join('')}</select></label>
          <label class="fld" data-sched="weekly"><span>${t('Day')}</span><select class="field" name="day">${[1, 2, 3, 4, 5, 6, 0].map((n) => opt(n, j.schedule.day, weekday(n))).join('')}</select></label>
          <label class="fld" data-sched="time"><span>${t('Time')}</span><input class="field" type="time" name="time" value="${esc(j.schedule.time)}"></label>
          <label class="fld"><span>${t('How many to keep')}</span><input class="field" type="number" name="keep" min="1" max="365" value="${esc(j.keep)}"></label>
        </div>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t(job ? 'Save' : 'Create')}</button><button class="btn" type="button" data-cancel>${t('Cancel')}</button>
          ${job ? `<button class="btn danger" type="button" data-sys-del>${t('Remove')}</button>` : ''}</div>
      </form>`;
    const f = $('#sysForm', box), F = f.elements, err = $('.form-error', f);
    const sync = () => { $$('[data-sched]', f).forEach((x) => { x.hidden = x.dataset.sched === 'weekly' ? F.every.value !== 'weekly' : F.every.value === 'manual'; }); };
    f.addEventListener('change', sync); sync();
    $('[data-cancel]', f).addEventListener('click', () => backupPane(el));
    const del = $('[data-sys-del]', f);
    if (del) del.addEventListener('click', async () => {
      if (!(await ask(t('Remove task {name}? The backups in {dir} stay.', { name: job.name, dir: job.dest }), t('Remove')))) return;
      withBusy(del, async () => { await api.del('/api/sysbackups/' + job.id); toast(t('Task {name} removed.', { name: job.name })); backupPane(el); });
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const body = { name: F.name.value, dest: F.dest.value.trim(), apps: $$('[name=app]:checked', f).map((x) => x.value), vms: $$('[name=vm]:checked', f).map((x) => x.value),
        stopApps: F.stopApps.checked, vmMode: (f.querySelector('[name=vmMode]:checked') || {}).value, keep: Number(F.keep.value),
        schedule: { every: F.every.value, time: F.time.value || '02:00', day: Number(F.day.value) } };
      const btn = $('[type=submit]', f); btn.disabled = true;
      try { await api.post('/api/sysbackups' + (job ? '/' + job.id : ''), body); toast(t(job ? '{name} saved.' : 'Task {name} created.', { name: body.name.trim() })); backupPane(el); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    if (!job) F.name.focus();
  }

  // Restore: per backup (date) an app or VM. What is there now moves aside (.before-restore-<date>), not away.
  async function sysRestore(box, el, job, s) {
    clearTimeout(bk.timer);
    box.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let r;
    try { r = await api.get('/api/sysbackups/' + job.id + '/runs'); } catch (e) { box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; return; }
    if (!box.isConnected) return;
    const item = (stamp, kind, x) => `<div class="access-row"><span><b>${esc(kind === 'app' ? prettyName(x.name) : x.name)}</b> <span class="muted small">${esc(t(kind === 'app' ? 'app' : 'VM'))}${x.size ? ' · ' + esc(bytes(x.size)) : ''}</span>
        ${x.error ? `<span class="small temp-bad">${esc(tr(x.error))}</span>` : ''}</span>
      ${x.error || (kind === 'app' && !x.file) ? '' : `<button class="btn sm" type="button" data-rs="${esc(stamp)}" data-rs-${kind}="${esc(kind === 'app' ? x.id : x.name)}" data-rs-name="${esc(x.name)}">${t('Restore')}</button>`}</div>`;
    box.innerHTML = `
      <div class="bays-head"><h2 class="pane-title" style="margin:0">${t('Restore {name}', { name: esc(job.name) })}</h2><button class="btn sm" type="button" data-rs-back>${t('Back')}</button></div>
      <p class="lead">${t('Choose a backup and what you want to restore. What is there now is first moved aside (name + .before-restore-<date>) and stays until you remove it yourself.')}</p>
      ${r.runs.length ? r.runs.map((x, i) => `<details class="adv" style="margin-bottom:8px"${i === 0 ? ' open' : ''}><summary>${esc(new Date(x.created).toLocaleString(LOCALE, { dateStyle: 'full', timeStyle: 'short', ...clockOpts() }))} · ${esc(bytes(x.size))}${x.errors.length ? ` · <span class="temp-bad">${t('{n} errors', { n: x.errors.length })}</span>` : ''}</summary>
          <div class="access-table" style="margin-top:8px">${x.apps.map((a) => item(x.stamp, 'app', a)).join('')}${x.vms.map((v) => item(x.stamp, 'vm', v)).join('')}</div></details>`).join('')
        : `<p class="muted">${t('No backups in {dir} yet.', { dir: esc(r.dest) })}</p>`}`;
    box.onclick = async (e) => {
      if (e.target.closest('[data-rs-back]')) return backupPane(el);
      const b = e.target.closest('[data-rs]'); if (!b) return;
      const app = b.dataset.rsApp, vm = b.dataset.rsVm, name = b.dataset.rsName;
      const q = app ? t('Restore {name} to this backup? The app stops briefly; the current data is moved aside.', { name: prettyName(name) })
        : t('Restore {name} to this backup? Turn the VM off first. The current disks are moved aside.', { name });
      if (!(await ask(q, t('Restore')))) return;
      withBusy(b, async () => {
        await api.post('/api/sysbackups/' + job.id + '/restore', { stamp: b.dataset.rs, ...(app ? { app } : { vm }) });
        toast(t('{name} has been restored.', { name: app ? prettyName(name) : name }));
      });
    };
  }

  /* devices: with the backup app (Kopia) or with a shared folder of their own on the NAS */
  function devHowTo(dev, d) {
    const host = d.hostname, smb = `smb://${host}.local/${dev.name}`, unc = `\\\\${host}\\${dev.name}`;
    const v = { name: '<b>' + esc(dev.name) + '</b>', host: esc(host), user: '<b>' + esc(dev.user) + '</b>', smb: '<code>' + esc(smb) + '</code>', unc: '<code>' + esc(unc) + '</code>' };
    const steps = {
      mac: ['Open System Settings → General → Time Machine.', 'Click + (Add Backup Disk) and choose {name} on {host}.', 'Sign in as {user} with that user\'s password. From now on Time Machine makes a backup every hour when your Mac is at home.'],
      windows: ['Open {unc} in File Explorer and sign in as {user}. Tick Remember my credentials.', 'Open Control Panel → File History → Select drive → Add network location, and choose {unc}.', 'Click Turn on. Another backup program works too: choose {unc} as the destination.'],
      linux: ['Open Backups (Déjà Dup) → Preferences → Storage location → Network server.', 'Type {smb} and sign in as {user}.', 'Turn on automatic backups.'],
      phone: ['Install an app that can back up to an SMB folder, e.g. PhotoSync (iPhone and Android) or FolderSync (Android).', 'Choose SMB (Windows share) as the destination: server {host}, folder {name}, user {user}.', 'Turn on automatic backups, e.g. at night while charging.'],
    }[dev.kind] || [];
    return `<ol class="bk-steps">${steps.map((s) => `<li>${t(s, v)}</li>`).join('')}</ol>
      ${dev.kind === 'mac' ? `<p class="muted small">${t('Don\'t see the folder? First connect to {smb} in the Finder (Go → Connect to Server).', v)}</p>` : ''}`;
  }
  const kopiaUrl = (k, d) => `https://${k.addresses[0] || d.hostname + '.local'}:${k.port}`;
  // Address of HomeBaseOS as you use it in your browser now (the app assumes port 8080).
  const nasAddress = () => location.hostname + (location.port && location.port !== '8080' ? ':' + location.port : !location.port ? ':' + (location.protocol === 'https:' ? 443 : 80) : '');
  // On the device: the HomeBase Backup app (pair with a code), or the plain KopiaUI / command line.
  function kopiaHowTo(dev, d) {
    const k = d.kopia, url = kopiaUrl(k, d), name = dev.user.split('@')[0];
    const home = { windows: 'C:\\Users\\…', mac: '/Users/…', linux: '/home/…' }[dev.kind] || '';
    const v = { app: `<a href="${esc(k.appUrl)}" target="_blank" rel="noopener">HomeBase Backup</a>`, nas: '<code>' + esc(nasAddress()) + '</code>',
      link: '<a href="https://kopia.io/docs/installation/" target="_blank" rel="noopener">kopia.io</a>', url: '<code>' + esc(url) + '</code>',
      fp: '<code>' + esc(k.fingerprint || '') + '</code>', user: '<code>' + esc(name) + '</code>', home: '<code>' + esc(home) + '</code>' };
    const cli = `kopia repository connect server --url=${url} --server-cert-fingerprint=${k.fingerprint || ''} --override-username=${name} --override-hostname=${name}`;
    const steps = (list) => `<ol class="bk-steps">${list.map((x) => `<li>${t(x, v)}</li>`).join('')}</ol>`;
    return steps([
      'Download {app} for Windows, Mac or Linux and install the app on the device.',
      'Click Pairing code here. Open the app and type {nas} as the address, and the code.',
      'Choose what you want to keep safe, e.g. Documents and Pictures. From now on the app makes a backup every hour and keeps old versions.',
    ]) + `<details class="adv" style="margin-top:10px"><summary>${t('With the regular KopiaUI or the command line')}</summary>
      ${steps([
        'Download KopiaUI from {link} and install it on the device.',
        'Open KopiaUI and choose Kopia Repository Server.',
        'Fill in {url} as the Server Address, and {fp} as the fingerprint (Trusted server certificate fingerprint).',
        'Open the advanced options (Show Advanced Options) and fill in {user} as both the username and the computer name (Override Username and Override Hostname).',
        'Click Next and type the password of this device.',
        'Click New Snapshot and choose your user folder ({home}). From now on Kopia backs it up every hour while KopiaUI is running, and keeps old versions.',
      ])}
      <p class="muted small" style="margin-top:8px">${t('You restore in KopiaUI: choose a backup and click Restore, or open it as a folder (Mount).')}</p>
      <p class="muted small" style="margin:8px 0 4px">${t('Prefer the command line?')}</p><pre class="logs">${esc(cli)}</pre></details>`;
  }
  // A password you see only once (repository or device), at the top until you confirm you saved it.
  const secretBox = (s) => `<div class="notice warn bk-secret"><b>${esc(s.title)}</b><code class="bk-secret-val${s.code ? ' bk-code' : ''}">${esc(s.value)}</code>
    <span class="muted small">${esc(s.text)}</span>
    ${s.password ? `<details class="adv"><summary>${t('Password for KopiaUI or the command line')}</summary><code class="bk-secret-val" style="margin-top:8px;display:inline-block">${esc(s.password)}</code></details>` : ''}
    <div class="btn-row"><button class="btn sm" type="button" data-copy="${esc(s.value)}">${t('Copy')}</button>
      <button class="btn sm primary" type="button" data-secret-done>${t('I\'ve saved it')}</button></div></div>`;
  const pairSecret = (name, r) => ({ title: t('Pairing code for {name}', { name }), value: r.code, code: true, password: r.password,
    text: t('Open HomeBase Backup on {name}, type {nas} as the address and this code. The code works once and until {time}.', { name, nas: nasAddress(), time: new Date(r.expires).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', ...clockOpts() }) }) });
  function kopiaCard(d) {
    const k = d.kopia, head = `<b>${t('Backup app (Kopia)')}</b>`;
    if (!k.installed) return `<div class="notice">${head}<span>${t('Kopia is not installed on the server. Run install.sh again.')}</span></div>`;
    if (!k.enabled) {
      return `<div class="notice">${head}
        <span>${t('With the free Kopia app, your Windows PCs, Macs and Linux PCs make an encrypted backup to the NAS every hour. Old versions are kept: 24 hourly, 14 days, 8 weeks, 12 months and 3 years.')}</span>
        <form class="inline-form" id="kopiaOn">${k.pool ? '' : `<select class="field" name="pool" aria-label="${t('Pool')}">${d.pools.map((p) => `<option value="${esc(p.name)}">${esc(t('Archive on {pool} ({size} free)', { pool: p.name, size: bytes(p.free) }))}</option>`).join('')}</select>`}
          <button class="btn primary" type="submit"${k.pool || d.pools.length ? '' : ' disabled'}>${t('Turn on')}</button></form></div>`;
    }
    return `<div class="notice">${head} <span class="pill ${k.running ? 'ok' : 'bad'}" style="justify-self:start">${t(k.running ? 'Active' : 'Not running')}</span>
      <dl class="kv" style="margin:0"><dt>${t('Address')}</dt><dd><code>${esc(kopiaUrl(k, d))}</code></dd>
        <dt>${t('Fingerprint')}</dt><dd><code>${esc(k.fingerprint || '–')}</code></dd>
        <dt>${t('Archive')}</dt><dd>${esc(k.path)}${k.used != null ? ' · ' + esc(bytes(k.used)) : ''}</dd></dl>
      <div class="btn-row"><button class="btn sm" type="button" data-kopia-off>${t('Turn off')}</button></div></div>`;
  }
  function bkDevices(box, d, el) {
    const k = d.kopia;
    const row = (x) => {
      const app = x.method === 'kopia';
      const pct = !app && x.quota ? Math.min(100, (x.used / x.quota) * 100) : null;
      const size = app ? (x.used ? bytes(x.used) : '') : x.used == null ? '' : x.quota ? t('{used} of {total}', { used: bytes(x.used), total: bytes(x.quota) }) : t('{used} used, no limit', { used: bytes(x.used) });
      const old = x.lastChange && Date.now() - x.lastChange > 3 * 86400000;
      const last = x.lastChange ? t(app ? 'last backup {when}' : 'last changed {when}', { when: ago(x.lastChange) }) : t('no backup yet');
      return `<li>
        <div><div class="row-title">${esc(x.name)} <span class="pill">${t(DEV_KINDS[x.kind] || x.kind)}</span> <span class="pill">${app ? 'Kopia' : t('Shared folder')}</span>${x.connected ? ` <span class="pill ok">${t('connected')}</span>` : ''}</div>
          <div class="row-sub"><span class="${old ? 'temp-warn' : ''}">${esc(last)}</span>${size ? ' · ' + esc(size) : ''}${app && x.folders && x.folders.length ? ' · ' + esc(t(x.folders.length === 1 ? '{n} folder' : '{n} folders', { n: x.folders.length })) : ''}</div>
          ${x.missing ? `<div class="row-sub temp-bad">${t('The dataset {name} is missing. Is the pool mounted?', { name: esc(x.dataset) })}</div>` : ''}
          ${app && !k.enabled ? `<div class="row-sub temp-warn">${t('The backup app is off: this device can\'t make backups.')}</div>` : ''}</div>
        <div class="row-side btn-row">${app ? `<button class="btn sm primary" type="button" data-dev-pair="${esc(x.name)}"${k.enabled ? '' : ' disabled'}>${t('Pairing code')}</button>
          <button class="btn sm" type="button" data-dev-pw="${esc(x.name)}"${k.enabled ? '' : ' disabled'}>${t('New password')}</button>` : ''}
          <button class="btn sm danger" type="button" data-dev-del="${esc(x.name)}">${t('Remove')}</button></div>
        <div class="row-bar">${pct != null ? `<div class="bar" aria-hidden="true"><span class="${level(pct, 80, 92)}" style="width:${pct.toFixed(1)}%"></span></div>` : ''}
          ${app && !k.enabled ? '' : `<details class="adv" style="margin-top:8px"${bk.openDevice === x.name ? ' open' : ''}><summary>${t('How to set it up')}</summary>${app ? kopiaHowTo(x, d) : devHowTo(x, d)}</details>`}</div></li>`;
    };
    const canAdd = d.pools.length && (k.enabled || d.samba);
    box.innerHTML = `
      ${bk.secret ? secretBox(bk.secret) : ''}
      <p class="lead">${t('Backups of your PCs, Macs and phones on the NAS. With the Kopia backup app (Windows, Mac and Linux), or with a shared folder of their own: for Time Machine on a Mac and apps on your phone.')}</p>
      ${kopiaCard(d)}
      ${d.samba ? '' : `<div class="notice warn">${t('Samba is not installed yet. Run install.sh again, or on the server: sudo apt install samba')}</div>`}
      <div class="bays-head"><h2 class="pane-title" style="margin:0">${t('Devices', null, 'backup')}</h2>
        <button class="btn sm primary" type="button" data-dev-new${canAdd ? '' : ` disabled title="${t('Create a pool first.')}"`}>+ ${t('Device', null, 'backup')}</button></div>
      <ul class="rows bk-rows">${d.devices.map(row).join('') || `<li><span class="muted">${t(d.pools.length ? 'No devices yet.' : 'No devices yet. First create a pool under Storage.')}</span></li>`}</ul>`;
    const on = $('#kopiaOn', box);
    if (on) on.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy($('[type=submit]', on), async () => {
        const r = await api.post('/api/backup/kopia', { enabled: true, pool: on.elements.pool ? on.elements.pool.value : undefined });
        if (r.repoPassword) bk.secret = { title: t('Archive password'), value: r.repoPassword, text: t('Keep it somewhere safe, e.g. in your password manager. Without this password nobody can open the archive, not even if the server breaks. It is also on the server in /var/lib/homebaseos/kopia/server.env.') };
        toast(t('The backup app is on.'));
        backupPane(el);
      });
    });
    box.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b || b.dataset.bktab) return;
      if (b.dataset.secretDone != null) { bk.secret = null; return backupPane(el); }
      if (b.dataset.devNew != null) return bkDeviceForm(box, d, el);
      if (b.dataset.kopiaOff != null) {
        if (!(await ask(t('Turn off the backup app? PCs and Macs with Kopia can then no longer make backups. The backups themselves stay.'), t('Turn off')))) return;
        return withBusy(b, async () => { await api.post('/api/backup/kopia', { enabled: false }); toast(t('The backup app is off.')); backupPane(el); });
      }
      if (b.dataset.devPair) {
        const name = b.dataset.devPair, x = d.devices.find((y) => y.name === name);
        if (x.lastChange && !(await ask(t('Create a pairing code for {name}? The device gets a new password: pair it again in the app afterwards.', { name }), t('Pairing code')))) return;
        return withBusy(b, async () => {
          const r = await api.post('/api/backup/devices/' + encodeURIComponent(name) + '/pair', {});
          bk.secret = pairSecret(name, r);
          bk.openDevice = name; backupPane(el);
        });
      }
      if (b.dataset.devPw) {
        const name = b.dataset.devPw;
        if (!(await ask(t('Create a new password for {name}? The old one stops working right away: type the new one in KopiaUI on the device.', { name }), t('New password')))) return;
        return withBusy(b, async () => {
          const r = await api.post('/api/backup/devices/' + encodeURIComponent(name) + '/password', {});
          bk.secret = { title: t('Password for {name}', { name }), value: r.password, text: t('Type this password in KopiaUI on the device. You only see it here once.') };
          bk.openDevice = name; backupPane(el);
        });
      }
      if (b.dataset.devDel) {
        const x = d.devices.find((y) => y.name === b.dataset.devDel), app = x.method === 'kopia';
        const r = await ask(t(app ? 'Remove {name}? The device can then no longer make backups.' : 'Remove {name}? The shared folder disappears; the device can no longer back up to it.', { name: x.name }), t('Remove'),
          t('Also erase all backups of this device ({size})', { size: bytes(x.used || 0) }));
        if (!r) return;
        withBusy(b, async () => {
          await api.del('/api/backup/devices/' + encodeURIComponent(x.name) + (r.checked ? '?data=1' : ''));
          toast(t(r.checked ? '{name} and its backups have been removed.' : app ? '{name} removed. The backups stay in the Kopia archive.' : '{name} removed. The backups are still in {path}.', { name: x.name, path: x.path }));
          backupPane(el);
        });
      }
    };
  }

  function bkDeviceForm(box, d, el) {
    const k = d.kopia;
    const radio = (v, title, help, off) => `<label class="check dev"><input type="radio" name="method" value="${v}"${off ? ' disabled' : ''}><span><b>${title}</b><small class="muted">${help}</small></span></label>`;
    box.innerHTML = `
      <h2 class="pane-title">${t('New device')}</h2>
      <form class="form" id="bkDevForm" novalidate>
        <fieldset class="fld"><span>${t('How does this device make backups?')}</span><div class="form" style="gap:8px">
          ${radio('kopia', t('With the HomeBase Backup app'), k.enabled ? t('For Windows, Mac and Linux. Pair with a code; encrypted, every hour, and old versions are kept.') : t('First turn on the backup app (under Devices, at the top).'), !k.enabled)}
          ${radio('share', t('With a shared folder of its own'), d.samba ? t('For Time Machine on a Mac, File History on Windows and apps on your phone.') : t('Samba is not installed yet.'), !d.samba)}</div></fieldset>
        <label class="fld"><span>${t('Name')}</span><input class="field" name="name" maxlength="32" autocomplete="off" spellcheck="false" placeholder="${t('e.g. MacBook-Lies')}">
          <small data-name-help></small></label>
        <fieldset class="fld"><span>${t('Kind of device')}</span><div class="choice-row">${Object.entries(DEV_KINDS).map(([kd, l]) =>
          `<label class="choice"><input type="radio" name="kind" value="${kd}"><span>${t(l)}</span></label>`).join('')}</div></fieldset>
        <div class="form" data-share>
          <div class="fld-row">
            <label class="fld"><span>${t('Pool')}</span><select class="field" name="pool">${d.pools.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} (${esc(t('{size} free', { size: bytes(p.free) }))})</option>`).join('')}</select></label>
            <label class="fld"><span>${t('Maximum size (GB)')}</span><input class="field" type="number" name="quotaGb" min="1" step="1" placeholder="${t('no limit')}"></label>
          </div>
          <p class="muted small" style="margin-top:-6px" data-quota-help></p>
          <label class="fld"><span>${t('Who makes the backups?')}</span><select class="field" name="user">${d.users.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join('')}
            <option value="">${t('New user…')}</option></select>
            <small>${t('The device signs in to the NAS with this user. Only that user can access the backups.')}</small></label>
          <div class="fld-row" data-new-user hidden>
            <label class="fld"><span>${t('User name')}</span><input class="field" name="newName" maxlength="32" autocomplete="off" spellcheck="false" placeholder="${t('e.g. lisa')}"></label>
            <label class="fld"><span>${t('Password')}</span><input class="field" type="password" name="newPw" autocomplete="new-password"><small>${t('At least 8 characters.')}</small></label>
            <label class="fld"><span>${t('Repeat password')}</span><input class="field" type="password" name="newPw2" autocomplete="new-password"></label>
          </div>
        </div>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Create')}</button><button class="btn" type="button" data-cancel>${t('Cancel')}</button></div>
      </form>`;
    const f = $('#bkDevForm', box), F = f.elements, err = $('.form-error', f);
    const val = (n) => (f.querySelector(`[name=${n}]:checked`) || {}).value;
    const pick = (n, v) => { const x = f.querySelector(`[name=${n}][value=${v}]`); if (x && !x.disabled) x.checked = true; };
    pick('method', k.enabled ? 'kopia' : 'share'); pick('kind', 'windows');
    const sync = (e) => {
      // A Mac prefers Time Machine; the app doesn't exist for phones.
      if (e && e.target.name === 'kind' && e.target.value === 'mac' && d.samba) pick('method', 'share');
      const app = val('method') === 'kopia';
      f.querySelector('[name=kind][value=phone]').disabled = app;
      if (app && val('kind') === 'phone') pick('kind', 'windows');
      $('[data-share]', f).hidden = app;
      $('[data-new-user]', f).hidden = F.user.value !== '';
      $('[data-name-help]', f).textContent = app ? t('Letters, digits, - and _. You also fill this in on the device.') : t('Letters, digits, - and _. The shared folder gets the same name.');
      $('[data-quota-help]', f).textContent = val('kind') === 'mac' ? t('For Time Machine: about twice the disk of your Mac. Time Machine removes old backups itself when the folder is full.')
        : t('This way one device can\'t fill the whole pool. Empty = no limit.');
    };
    f.addEventListener('change', sync); sync();
    $('[data-cancel]', f).addEventListener('click', () => backupPane(el));
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const method = val('method');
      const body = { name: F.name.value.trim(), kind: val('kind'), method };
      if (method === 'share') {
        Object.assign(body, { pool: F.pool.value, quotaGb: F.quotaGb.value === '' ? '' : Number(F.quotaGb.value) });
        if (F.user.value) body.user = F.user.value;
        else {
          if (F.newPw.value !== F.newPw2.value) { err.textContent = t('The two passwords do not match.'); return; }
          body.newUser = { name: F.newName.value.trim(), password: F.newPw.value };
        }
      }
      const btn = $('[type=submit]', f); btn.disabled = true;
      try {
        const r = await api.post('/api/backup/devices', body);
        if (r.code) bk.secret = pairSecret(body.name, r);
        toast(t(r.code ? '{name} is ready. Install HomeBase Backup on the device and pair with the code.' : 'The folder for {name} is ready. Follow the steps to turn on backups.', { name: body.name }));
        bk.openDevice = body.name; backupPane(el);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    F.name.focus();
  }

  /* connections: cloud and other NAS (rclone) */
  function bkRemotes(box, d, el) {
    if (!d.installed) { bkJobs(box, d, el); return; }
    box.innerHTML = `
      <p class="lead">${t('A connection is a place outside this NAS: your cloud or another NAS. Passwords and keys stay on the server.')}</p>
      <div class="bays-head"><h2 class="pane-title" style="margin:0">${t('Connections')}</h2>
        <button class="btn sm primary" type="button" data-rm-new>+ ${t('Connection')}</button></div>
      <ul class="rows bk-rows">${d.remotes.map((r) => `<li>
          <div><div class="row-title">${esc(r.name)}</div>
            <div class="row-sub">${esc([tr(r.label), tr(r.detail)].filter(Boolean).join(' · '))}</div>
            <div class="row-sub">${r.usedBy.length ? esc(t('Used by: {list}', { list: r.usedBy.join(', ') })) : t('Not used by any task yet.')}</div>
            <div class="row-sub" data-rm-about="${esc(r.name)}"></div></div>
          <div class="row-side btn-row"><button class="btn sm" type="button" data-rm-test="${esc(r.name)}">${t('Test')}</button>
            ${(d.providers[r.type] || {}).oauth ? `<button class="btn sm" type="button" data-rm-reauth="${esc(r.name)}">${t('Sign in again')}</button>` : ''}
            <button class="btn sm danger" type="button" data-rm-del="${esc(r.name)}"${r.usedBy.length ? ` disabled title="${esc(t('Still used by a task.'))}"` : ''}>${t('Remove')}</button></div></li>`).join('')
        || `<li><span class="muted">${t('No connections yet.')}</span></li>`}</ul>`;
    box.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b || b.dataset.bktab) return;
      if (b.dataset.rmNew != null) return bkRemoteForm(box, d, el, null);
      if (b.dataset.rmReauth) return bkRemoteForm(box, d, el, d.remotes.find((r) => r.name === b.dataset.rmReauth).type, b.dataset.rmReauth);
      if (b.dataset.rmTest) {
        const name = b.dataset.rmTest, out = $(`[data-rm-about="${CSS.escape(name)}"]`, box);
        out.textContent = t('Connecting…'); out.className = 'row-sub';
        return withBusy(b, async () => {
          try {
            const r = await api.post('/api/backup/remotes/' + encodeURIComponent(name) + '/test', {});
            out.className = 'row-sub temp-ok';
            out.textContent = r.about && r.about.free != null ? t('Works. {free} free{total}.', { free: bytes(r.about.free), total: r.about.total ? ' ' + t('of {total}', { total: bytes(r.about.total) }) : '' }) : t('Works.');
          } catch (ex) { out.className = 'row-sub temp-bad'; out.textContent = ex.message; }
        });
      }
      if (b.dataset.rmDel) {
        const name = b.dataset.rmDel;
        if (!(await ask(t('Remove connection {name}? The files on the other side stay.', { name }), t('Remove')))) return;
        withBusy(b, async () => { await api.del('/api/backup/remotes/' + encodeURIComponent(name)); toast(t('Connection {name} removed.', { name })); backupPane(el); });
      }
    };
  }

  const RM_NAME = { drive: 'google', onedrive: 'onedrive', dropbox: 'dropbox', s3: 's3', sftp: 'nas', smb: 'nas', webdav: 'webdav' };
  // reconnect: the name of an existing connection that has to sign in again.
  function bkRemoteForm(box, d, el, type, reconnect) {
    const P = d.providers;
    if (!type) {
      const group = (g, title) => `<h3>${t(title)}</h3><div class="bk-providers">${Object.entries(P).filter(([, p]) => p.group === g).map(([k, p]) =>
        `<button class="store-card widget" type="button" data-rm-type="${esc(k)}"><span><b>${esc(tr(p.label))}</b>${p.hint ? `<small class="muted">${esc(tr(p.hint))}</small>` : ''}</span></button>`).join('')}</div>`;
      box.innerHTML = `<h2 class="pane-title">${t('New connection')}</h2>${group('cloud', 'Cloud')}${group('nas', 'Other NAS or server')}
        <div class="btn-row" style="margin-top:16px"><button class="btn" type="button" data-cancel>${t('Cancel')}</button></div>`;
      box.onclick = (e) => {
        const b = e.target.closest('button'); if (!b || b.dataset.bktab) return;
        if (b.dataset.rmType) bkRemoteForm(box, d, el, b.dataset.rmType);
        if (b.dataset.cancel != null) backupPane(el);
      };
      return;
    }
    box.onclick = null;
    const p = P[type], label = tr(p.label);
    const taken = (n) => d.remotes.some((r) => r.name.toLowerCase() === n.toLowerCase());
    let name = reconnect || RM_NAME[type] || type; for (let i = 2; !reconnect && taken(name); i++) name = (RM_NAME[type] || type) + '-' + i;
    const field = (x) => {
      const attrs = `class="field" name="f:${esc(x.key)}" ${x.placeholder ? `placeholder="${esc(x.placeholder)}"` : ''} autocomplete="${x.type === 'password' ? 'new-password' : 'off'}" spellcheck="false"`;
      const input = x.type === 'select'
        ? `<select class="field" name="f:${esc(x.key)}">${x.options.map(([v, l]) => `<option value="${esc(v)}"${v === x.default ? ' selected' : ''}>${esc(tr(l))}</option>`).join('')}</select>`
        : `<input ${attrs} type="${x.type === 'password' ? 'password' : x.type === 'number' ? 'number' : 'text'}" value="${esc(x.type === 'select' ? '' : x.default || '')}">`;
      return `<label class="fld"><span>${esc(tr(x.label))}${x.required ? '' : ` <em class="muted">${t('(optional)')}</em>`}</span>${input}${x.help ? `<small>${esc(tr(x.help))}</small>` : ''}</label>`;
    };
    box.innerHTML = `
      <h2 class="pane-title">${reconnect ? t('Sign in again: {name}', { name: esc(reconnect) }) : esc(label)}</h2>
      <form class="form" id="bkRmForm" novalidate>
        ${reconnect ? `<input type="hidden" name="name" value="${esc(name)}"><p class="lead">${t('The tasks keep using this connection. Sign in with the same account, otherwise the files end up somewhere else.')}</p>` : `
        <label class="fld"><span>${t('Connection name')}</span><input class="field" name="name" maxlength="32" value="${esc(name)}" autocomplete="off" spellcheck="false">
          <small>${t('Letters, digits, - and _. This is how you\'ll see it in the tasks.')}</small></label>`}
        ${p.oauth ? `
        <ol class="bk-steps">
          <li>${t('Click Sign in. A new {label} tab opens.', { label: esc(label) })}
            <div style="margin-top:8px"><button class="btn primary" type="button" data-auth>${t('Sign in to {label}', { label: esc(label) })}</button> <span class="small" data-auth-link></span></div></li>
          <li>${t('Sign in and click Allow. That tab then shows an error, such as "This site can\'t be reached". That is normal.')}</li>
          <li>${t('Copy the address from the address bar of that tab (it starts with http://127.0.0.1:53682/) and paste it here:')}
            <input class="field" name="url" style="margin-top:8px" spellcheck="false" autocomplete="off" placeholder="http://127.0.0.1:53682/?state=…&amp;code=…" aria-label="${t('Address from the address bar')}"></li>
        </ol>
        <details class="adv"><summary>${t('Doesn\'t it work?')}</summary>
          <p class="muted small" style="margin:8px 0">${t('Install rclone on your computer (rclone.org) and run this in a terminal. Sign in, then paste everything between ---> and <---End paste below.')}</p>
          <pre class="logs">rclone authorize "${esc(type)}"</pre>
          <textarea class="field" name="token" rows="3" spellcheck="false" style="margin-top:8px" aria-label="${t('Token')}"></textarea></details>`
        : p.fields.map(field).join('')}
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t(p.oauth ? 'Save' : 'Connect')}</button><button class="btn" type="button" data-cancel>${t('Cancel')}</button></div>
      </form>`;
    const f = $('#bkRmForm', box), F = f.elements, err = $('.form-error', f);
    $('[data-cancel]', f).addEventListener('click', () => (reconnect ? backupPane(el) : bkRemoteForm(box, d, el, null)));
    let session = null;
    const authBtn = $('[data-auth]', f);
    if (authBtn) authBtn.addEventListener('click', async () => {
      err.textContent = '';
      // Open the tab right away (otherwise the browser blocks it), and fill in the address as soon as the server gives it.
      const w = api === realApi ? window.open('', '_blank') : null;
      authBtn.disabled = true;
      try {
        const r = await api.post('/api/backup/auth', { type });
        session = r.session;
        $('[data-auth-link]', f).innerHTML = `<a href="${esc(r.url)}" target="_blank" rel="noopener">${t('Nothing opens? Click here.')}</a>`;
        if (w) { w.opener = null; w.location.href = r.url; }
        if (api !== realApi) { F.url.value = 'http://127.0.0.1:53682/?state=demo&code=demo'; toast(t('In the demo you don\'t really sign in. The address to paste is already filled in.')); }
        F.url.focus();
      } catch (ex) { if (w) w.close(); err.textContent = ex.message; }
      finally { authBtn.disabled = false; }
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const btn = $('[type=submit]', f); btn.disabled = true; btn.textContent = t('Connecting…');
      try {
        if (p.oauth) {
          const token = F.token.value.trim();
          if (!token && !session) throw new Error(t('First click Sign in to {label}.', { label }));
          await api.post('/api/backup/auth/finish', { name: F.name.value.trim(), type, reconnect: !!reconnect, ...(token ? { token } : { session, url: F.url.value.trim() }) });
        } else {
          const body = { name: F.name.value.trim(), type };
          p.fields.forEach((x) => { body[x.key] = F['f:' + x.key].value; });
          await api.post('/api/backup/remotes', body);
        }
        toast(t(reconnect ? 'Signed in again: {name}' : 'Connection {name} added.', { name: F.name.value.trim() }));
        backupPane(el);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = t(p.oauth ? 'Save' : 'Connect'); }
    });
    if (!reconnect) F.name.select();
  }

  /* --- Settings > Users: who may access which shared folder, directly or through a group */
  const LEVEL = { ro: 'Read', rw: 'Read and write' };
  let usersTab = 'users';
  // Like effectiveUsers in lib/shares.js: directly or through a group, the highest right counts.
  function accessOf(share, groups, user) {
    const via = [];
    let level = share.users[user] || null;
    if (level) via.push(t('directly'));
    for (const [g, l] of Object.entries(share.groups || {})) {
      const gr = groups.find((x) => x.name === g);
      if (!gr || !gr.members.includes(user)) continue;
      via.push(t('via {group}', { group: g }));
      if (level !== 'rw') level = l;
    }
    return { level, via };
  }
  const levelSelect = (name, cur, label) => `<select class="field" name="${esc(name)}" aria-label="${esc(label)}">
    <option value="">${t('None')}</option>${Object.entries(LEVEL).map(([k, l]) => `<option value="${k}"${cur === k ? ' selected' : ''}>${t(l)}</option>`).join('')}</select>`;

  async function usersPane(el, opts = {}) {
    el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let d;
    try { d = await api.get('/api/shares'); } catch (e) { el.innerHTML = `<p class="lead">${t('The users could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'users') return;
    if (!d.installed) { el.innerHTML = `<p class="lead">${t('Samba is not installed yet. Run install.sh again, or on the server: sudo apt install samba')}</p>`; return; }
    el.innerHTML = `
      <div class="seg vm-tabs" role="tablist" aria-label="${t('Sections')}">
        <button type="button" role="tab" aria-selected="${usersTab === 'users'}" data-utab="users">${t('Users')} (${d.users.length})</button>
        <button type="button" role="tab" aria-selected="${usersTab === 'groups'}" data-utab="groups">${t('Groups')} (${d.groups.length})</button></div>
      <div id="usersBody"></div>`;
    el.onclick = (e) => { const b = e.target.closest('[data-utab]'); if (b) { usersTab = b.dataset.utab; usersPane(el); } };
    el.onchange = null;
    (usersTab === 'groups' ? groupsList : usersList)($('#usersBody', el), d, el, opts);
  }

  function usersList(box, d, el, opts) {
    const row = (u) => {
      const rights = d.shares.map((sh) => ({ sh, ...accessOf(sh, d.groups, u.name) })).filter((x) => x.level);
      const open = opts.open === u.name;
      return `<li>
        <div><div class="row-title">${esc(u.name)}${u.managed ? '' : ` <span class="pill">${t('already existed')}</span>`} ${u.groups.map((g) => `<span class="pill ok">${esc(g)}</span>`).join(' ')}</div>
          <div class="row-sub">${rights.length ? esc(rights.map((x) => x.sh.name + ' (' + t(x.level === 'rw' ? 'write' : 'read') + ')').join(', ')) : t('No access yet')}</div></div>
        <div class="row-side btn-row"><button class="btn sm" type="button" data-uedit="${esc(u.name)}" aria-expanded="${open}">${t('Permissions')}</button>
          <button class="btn sm" type="button" data-upw="${esc(u.name)}">${t('Password')}</button>
          ${u.managed ? `<button class="btn sm danger" type="button" data-udel="${esc(u.name)}">${t('Remove')}</button>` : ''}</div>
        <form class="inline-form user-edit" data-pw-form="${esc(u.name)}" hidden>
          <input class="field" type="password" name="password" autocomplete="new-password" placeholder="${t('New password (at least 8 characters)')}" aria-label="${t('New password')}">
          <button class="btn sm primary" type="submit">${t('Save')}</button></form>
        ${open ? userRightsForm(u, d) : ''}</li>`;
    };
    box.innerHTML = `
      ${d.admin ? `<div class="notice"><div><b>${esc(d.admin)}</b> <span class="pill">${t('Administrator')}</span></div>
        <span class="muted small">${t('Signs in to this dashboard and manages everything. You change the password and two-step verification under {link}.', { link: `<a href="#settings/security">${t('Security')}</a>` })}</span></div>` : ''}
      <p class="muted small">${t('With these users and their password you sign in to a shared folder and make backups. They can\'t sign in to the server itself or to this dashboard.')}</p>
      <div class="bays-head"><h2 class="pane-title" style="margin:0">${t('Users')}</h2>
        <button class="btn sm primary" type="button" data-unew>+ ${t('User')}</button></div>
      <div id="userNew"></div>
      <ul class="rows">${d.users.map(row).join('') || `<li><span class="muted">${t('No users yet.')}</span></li>`}</ul>`;
    box.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b || b.dataset.utab) return;
      if (b.dataset.unew != null) return newUserForm($('#userNew', box), d, el);
      if (b.dataset.uedit) return usersPane(el, { open: opts.open === b.dataset.uedit ? null : b.dataset.uedit });
      if (b.dataset.upw) { const f = $(`[data-pw-form="${CSS.escape(b.dataset.upw)}"]`, box); f.hidden = !f.hidden; if (!f.hidden) f.elements.password.focus(); return; }
      if (b.dataset.udel) {
        const name = b.dataset.udel;
        if (!(await ask(t('Remove user {name}? They can then no longer access the shared folders, and no longer make backups.', { name }), t('Remove')))) return;
        withBusy(b, async () => { await api.del('/api/share-users/' + encodeURIComponent(name)); toast(t('User {name} deleted.', { name })); usersPane(el); });
      }
    };
    $$('[data-pw-form]', box).forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.post('/api/share-users/' + encodeURIComponent(f.dataset.pwForm) + '/password', { password: f.elements.password.value }); toast(t('Password of {name} changed.', { name: f.dataset.pwForm })); f.hidden = true; f.reset(); }
      catch (ex) { toast(ex.message, true); }
    }));
    const rf = $('[data-rights-form]', box);
    if (rf) rf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = rf.dataset.rightsForm, F = rf.elements;
      const body = { groups: d.groups.filter((g) => F['g:' + g.name].checked).map((g) => g.name), access: {} };
      d.shares.forEach((sh) => { body.access[sh.name] = F['s:' + sh.name].value; });
      const btn = $('[type=submit]', rf); btn.disabled = true;
      try { await api.post('/api/share-users/' + encodeURIComponent(name), body); toast(t('Permissions of {name} saved.', { name })); usersPane(el, { open: name }); }
      catch (ex) { $('.form-error', rf).textContent = ex.message; btn.disabled = false; }
    });
  }

  // Rights of one user: tick groups, direct rights per folder, and what that adds up to.
  function userRightsForm(u, d) {
    return `<form class="form user-edit" data-rights-form="${esc(u.name)}" novalidate>
      <fieldset class="fld"><span>${t('Groups')}</span>
        ${d.groups.length ? `<div class="check-grid">${d.groups.map((g) => `<label class="check"><input type="checkbox" name="g:${esc(g.name)}"${g.members.includes(u.name) ? ' checked' : ''}> ${esc(g.name)}</label>`).join('')}</div>`
          : `<span class="muted small">${t('No groups yet. Create one under Groups.')}</span>`}</fieldset>
      ${d.shares.length ? `<table class="rights"><thead><tr><th>${t('Shared folder')}</th><th>${t('Directly')}</th><th>${t('Together')}</th></tr></thead><tbody>
        ${d.shares.map((sh) => { const a = accessOf(sh, d.groups, u.name); return `<tr><td><b>${esc(sh.name)}</b>${sh.timemachine ? ' <span class="pill">Time Machine</span>' : ''}${sh.guest ? ` <span class="pill warn">${t('guests')}</span>` : ''}</td>
          <td>${levelSelect('s:' + sh.name, sh.users[u.name] || '', t('Direct permission on {name}', { name: sh.name }))}</td>
          <td>${a.level ? `${t(LEVEL[a.level])} <span class="via">${esc(a.via.join(', '))}</span>` : `<span class="via">${t('No access')}</span>`}</td></tr>`; }).join('')}</tbody></table>
        <p class="muted small" style="margin-top:-4px">${t('"Together" is what the user may really do: directly or via a group, the highest permission counts. What you change here shows after saving.')}</p>`
        : `<p class="muted small">${t('No shared folders yet.')}</p>`}
      <p class="form-error" role="alert"></p>
      <div class="btn-row"><button class="btn primary" type="submit">${t('Save')}</button></div></form>`;
  }

  function newUserForm(box, d, el) {
    box.innerHTML = `<form class="form" id="userForm" novalidate style="margin-bottom:14px">
        <div class="fld-row">
          <label class="fld"><span>${t('User name')}</span><input class="field" name="name" maxlength="32" autocomplete="off" spellcheck="false" placeholder="${t('e.g. lisa')}">
            <small>${t('Lowercase letters, digits, - and _.')}</small></label>
          <label class="fld"><span>${t('Password')}</span><input class="field" type="password" name="password" autocomplete="new-password"><small>${t('At least 8 characters.')}</small></label>
          <label class="fld"><span>${t('Repeat password')}</span><input class="field" type="password" name="password2" autocomplete="new-password"></label>
        </div>
        ${d.groups.length ? `<fieldset class="fld"><span>${t('Groups')}</span><div class="check-grid">${d.groups.map((g) => `<label class="check"><input type="checkbox" name="g:${esc(g.name)}"> ${esc(g.name)}</label>`).join('')}</div></fieldset>` : ''}
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Add user')}</button><button class="btn" type="button" data-ucancel>${t('Cancel')}</button></div></form>`;
    const f = $('#userForm', box), F = f.elements;
    $('[data-ucancel]', f).addEventListener('click', () => { box.innerHTML = ''; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', f); err.textContent = '';
      if (F.password.value !== F.password2.value) { err.textContent = t('The two passwords do not match.'); return; }
      const name = F.name.value.trim(), btn = $('[type=submit]', f); btn.disabled = true;
      try {
        await api.post('/api/share-users', { name, password: F.password.value, groups: d.groups.filter((g) => F['g:' + g.name].checked).map((g) => g.name) });
        toast(t('User {name} added.', { name })); usersPane(el, { open: name });
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    F.name.focus();
  }

  function groupsList(box, d, el, opts) {
    if (opts.editGroup !== undefined) return groupForm(box, d, el, opts.editGroup);
    const rightsOf = (g) => d.shares.filter((sh) => sh.groups && sh.groups[g.name]).map((sh) => sh.name + ' (' + t(sh.groups[g.name] === 'rw' ? 'write' : 'read') + ')');
    box.innerHTML = `
      <p class="muted small">${t('A group gives all its members the same permissions on shared folders, e.g. Family may read media, Parents may write documents. Someone can be in several groups; the highest permission counts.')}</p>
      <div class="bays-head"><h2 class="pane-title" style="margin:0">${t('Groups')}</h2>
        <button class="btn sm primary" type="button" data-gnew${d.users.length ? '' : ` disabled title="${t('Create a user first.')}"`}>+ ${t('Group')}</button></div>
      <ul class="rows">${d.groups.map((g) => `<li>
          <div><div class="row-title">${esc(g.name)}${g.comment ? ` <span class="muted small">${esc(g.comment)}</span>` : ''}</div>
            <div class="share-access">${g.members.map((m) => `<span class="pill">${esc(m)}</span>`).join('') || `<span class="muted small">${t('No members yet')}</span>`}</div>
            <div class="row-sub">${rightsOf(g).length ? esc(t('Permissions: {list}', { list: rightsOf(g).join(', ') })) : t('No permissions on shared folders yet')}</div></div>
          <div class="row-side btn-row"><button class="btn sm" type="button" data-gedit="${esc(g.name)}">${t('Edit')}</button>
            <button class="btn sm danger" type="button" data-gdel="${esc(g.name)}">${t('Remove')}</button></div></li>`).join('')
        || `<li><span class="muted">${t('No groups yet.')}</span></li>`}</ul>`;
    box.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b || b.dataset.utab) return;
      if (b.dataset.gnew != null) return groupForm(box, d, el, null);
      if (b.dataset.gedit) return groupForm(box, d, el, b.dataset.gedit);
      if (b.dataset.gdel) {
        const name = b.dataset.gdel;
        if (!(await ask(t('Remove group {name}? The members lose the permissions they had through this group. The users themselves stay.', { name }), t('Remove')))) return;
        withBusy(b, async () => { await api.del('/api/share-groups/' + encodeURIComponent(name)); toast(t('Group {name} removed.', { name })); usersPane(el); });
      }
    };
  }

  function groupForm(box, d, el, editName) {
    const g = editName ? d.groups.find((x) => x.name === editName) : { name: '', comment: '', members: [] };
    box.onclick = null;
    box.innerHTML = `<h2 class="pane-title">${editName ? t('Edit {name}', { name: esc(editName) }) : t('New group')}</h2>
      <form class="form" id="groupForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Name')}</span><input class="field" name="name" maxlength="32" value="${esc(g.name)}" autocomplete="off" spellcheck="false" placeholder="${t('e.g. Family')}">
            <small>${t('Letters, digits, -, _ and .')}</small></label>
          <label class="fld"><span>${t('Description')} <em class="muted">${t('(optional)')}</em></span><input class="field" name="comment" maxlength="100" value="${esc(g.comment)}"></label>
        </div>
        <fieldset class="fld"><span>${t('Members')}</span>
          <div class="check-grid">${d.users.map((u) => `<label class="check"><input type="checkbox" name="m:${esc(u.name)}"${g.members.includes(u.name) ? ' checked' : ''}> ${esc(u.name)}</label>`).join('') || `<span class="muted small">${t('No users yet.')}</span>`}</div></fieldset>
        ${d.shares.length ? `<fieldset class="fld"><span>${t('Permissions on shared folders')}</span>
          <table class="rights"><tbody>${d.shares.map((sh) => `<tr><td><b>${esc(sh.name)}</b>${sh.comment ? ` <span class="via">${esc(sh.comment)}</span>` : ''}</td>
            <td style="width:45%">${levelSelect('s:' + sh.name, editName && sh.groups ? sh.groups[editName] || '' : '', t('Group permission on {name}', { name: sh.name }))}</td></tr>`).join('')}</tbody></table></fieldset>` : ''}
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t(editName ? 'Save' : 'Create')}</button><button class="btn" type="button" data-gcancel>${t('Cancel')}</button></div>
      </form>`;
    const f = $('#groupForm', box), F = f.elements;
    $('[data-gcancel]', f).addEventListener('click', () => usersPane(el));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', f); err.textContent = '';
      const body = { name: F.name.value.trim(), comment: F.comment.value, members: d.users.filter((u) => F['m:' + u.name].checked).map((u) => u.name), shares: {} };
      d.shares.forEach((sh) => { body.shares[sh.name] = F['s:' + sh.name].value; });
      const btn = $('[type=submit]', f); btn.disabled = true;
      try {
        await api.post('/api/share-groups' + (editName ? '/' + encodeURIComponent(editName) : ''), body);
        toast(t(editName ? '{name} saved.' : 'Group {name} created.', { name: body.name })); usersPane(el);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    F.name.focus();
  }

  /* --- Security: the terminal on the server */
  async function securityPane(el) {
    el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let cur;
    try { cur = await api.get('/api/settings'); } catch (e) { el.innerHTML = `<p class="lead">${esc(e.message)}</p>`; return; }
    if (settingsTab() !== 'security') return;
    const needsPw = !S.config.demo && S.config.passwordEnabled;
    el.innerHTML = `
      <div id="mfaBox"><p class="lead">${t('Loading…')}</p></div>
      ${S.config.passwordEnabled ? `<h2 class="pane-title">${t('Password')}</h2>
      <p class="muted small" id="pwChanged"></p>
      <form class="form" id="pwForm" style="max-width:440px">${passwordFields()}
        <p class="form-error" role="alert" data-pw-err></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Change password')}</button></div></form>` : ''}
      <h2 class="pane-title">${t('Terminal on the server')}</h2>
      <p class="muted small">${t('The terminal icon at the top right opens a root shell on the server. Whoever can open the terminal can do anything on the server: delete files, format disks, read passwords.')}</p>
      <div class="form" style="margin-top:12px">
        <label class="check"><input type="checkbox" name="terminal"${cur.terminal ? ' checked' : ''}> ${t('Allow the terminal on the server')}</label>
        <label class="check"><input type="checkbox" name="terminalPassword"${cur.terminalPassword ? ' checked' : ''}${cur.terminal ? '' : ' disabled'}> ${t('Ask for the password again when opening the terminal')}</label>
        <p class="muted small" style="margin-top:-4px">${t('Recommended. That way someone using a signed-in browser (e.g. a shared PC) cannot run root commands right away.')}</p>
      </div>
      <form class="inline-form sec-confirm" id="secConfirm" hidden>
        <input class="field" type="password" name="password" autocomplete="current-password" placeholder="${t('HomeBaseOS password')}" aria-label="${t('HomeBaseOS password')}">
        <button class="btn primary" type="submit">${t('Confirm')}</button><button class="btn" type="button" data-sec-cancel>${t('Cancel')}</button>
      </form>
      <p class="muted small" id="secHint" hidden>${t('This makes security less strict. Type your password to confirm.')}</p>
      <p class="form-error" role="alert" id="secErr"></p>
      <p class="muted small">${t('Every time someone opens or closes the terminal, it is written to the system log (journalctl -u homebaseos).')}</p>`;
    mfaSection($('#mfaBox', el));
    const pwForm = $('#pwForm', el);
    if (pwForm) {
      wirePasswordMeter(pwForm);
      api.get('/api/mfa').then((m) => { if ($('#pwChanged', el)) $('#pwChanged', el).textContent = m.passwordChanged ? t('Last changed on {date}.', { date: longDate(m.passwordChanged) }) : t('You\'re still using the password from the installation (in /etc/homebaseos/homebaseos.env).'); }, () => {});
      pwForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button[type="submit"]', pwForm); btn.disabled = true;
        try { await submitPassword(pwForm); pwForm.reset(); wirePasswordMeter(pwForm); toast(t('Your new password is set. Other browsers were signed out.')); securityPane(el); }
        catch (ex) { $('[data-pw-err]', pwForm).textContent = ex.message; }
        finally { btn.disabled = false; }
      });
    }
    const box = (n) => $(`[name="${n}"]`, el), confirmForm = $('#secConfirm', el);
    let pending = null;
    const save = async (body) => {
      $('#secErr', el).textContent = '';
      try {
        const r = await api.post('/api/settings', body);
        S.config.terminal = r.terminal; S.config.terminalPassword = r.terminalPassword && !!S.config.passwordEnabled;
        $('#termBtn').hidden = !r.terminal;
        toast(t('Security saved.'));
        securityPane(el);
      } catch (e) { $('#secErr', el).textContent = e.message; }
    };
    el.onchange = (e) => {
      const n = e.target.name; if (n !== 'terminal' && n !== 'terminalPassword') return;
      const body = { terminal: box('terminal').checked, terminalPassword: box('terminalPassword').checked };
      const looser = (body.terminal && !cur.terminal) || (!body.terminalPassword && cur.terminalPassword);
      if (looser && needsPw) {
        pending = body; confirmForm.hidden = false; $('#secHint', el).hidden = false;
        confirmForm.elements.password.focus();
      } else save(body);
    };
    confirmForm.addEventListener('submit', (e) => { e.preventDefault(); if (pending) save({ ...pending, password: confirmForm.elements.password.value }); });
    el.onclick = (e) => { if (e.target.closest('[data-sec-cancel]')) securityPane(el); };
  }

  /* --- Security: two-step verification (TOTP with an authenticator app) */
  async function mfaSection(box) {
    let st;
    try { st = await api.get('/api/mfa'); } catch (e) { box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; return; }
    if (!box.isConnected) return;
    const head = box.dataset.noHead ? '' : `<h2 class="pane-title">${t('Two-step verification')}</h2>
      <p class="muted small">${t('Besides your password, HomeBaseOS then asks for a 6-digit code from an authenticator app on your phone (e.g. Google Authenticator, Microsoft Authenticator, 1Password or Aegis). Someone who only knows your password can\'t sign in.')}</p>`;
    if (!st.available) { box.innerHTML = head + `<p class="muted small">${t('Set a password (APP_PASSWORD) first to use two-step verification.')}</p>`; return; }
    const demoHint = S.config.demo ? `<p class="muted small">${t('Demo: the password is {pw}.', { pw: '<b>demo</b>' })}</p>` : '';
    const since = st.since ? new Date(st.since).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    box.innerHTML = head + (st.enabled ? `
      <div class="mfa-state on"><span class="dot"></span><div><b>${t('On')}</b>
        <div class="muted small">${since ? t('Since {date}.', { date: esc(since) }) + ' ' : ''}${t('{n} recovery codes left.', { n: st.recoveryLeft })}</div></div></div>
      ${st.recoveryLeft < 3 ? `<p class="small" style="color:var(--warn)">${t('You\'re almost out of recovery codes. Create new ones.')}</p>` : ''}
      <div class="btn-row"><button class="btn" type="button" data-mfa="recovery">${t('New recovery codes')}</button>
        <button class="btn danger" type="button" data-mfa="disable">${t('Turn off')}</button></div>` : `
      <div class="mfa-state"><span class="dot"></span><div><b>${t('Off')}</b><div class="muted small">${t('Signing in only asks for your password.')}</div></div>
        <button class="btn primary" type="button" data-mfa="start">${t('Turn on')}</button></div>`) +
      `<div id="mfaStep"></div><p class="form-error" role="alert" id="mfaErr"></p>`;
    const step = $('#mfaStep', box), errEl = $('#mfaErr', box);
    const pwForm = (label, withCode) => `${demoHint}
      <form class="inline-form" data-mfa-form>
        <input class="field" type="password" name="password" autocomplete="current-password" required placeholder="${t('HomeBaseOS password')}" aria-label="${t('HomeBaseOS password')}">
        ${withCode ? `<input class="field mfa-code" name="code" required autocomplete="one-time-code" maxlength="11" placeholder="${t('Code')}" aria-label="${t('Code from the app or a recovery code')}">` : ''}
        <button class="btn primary" type="submit">${esc(label)}</button><button class="btn" type="button" data-mfa-cancel>${t('Cancel')}</button>
      </form>`;
    let action = null;
    const showStep = (html, act) => {
      action = act; errEl.textContent = ''; step.innerHTML = html;
      $$('[data-mfa]', box).forEach((b) => { b.disabled = true; });
      const first = $('input', step); if (first) first.focus();
    };
    const group = (sec) => sec.replace(/(.{4})/g, '$1 ').trim();
    function showSetup(r) {
      showStep(`
        <div class="mfa-setup">
          <div class="mfa-qr">${window.TBQR.svg(r.uri, { size: 180 })}</div>
          <ol class="mfa-steps">
            <li>${t('Open your authenticator app and scan this QR code.')}</li>
            <li>${t('Can\'t scan? Type this key into the app instead:')}<br>
              <button class="mfa-secret" type="button" data-copy="${esc(r.secret)}" title="${t('Copy')}">${esc(group(r.secret))}</button><br>
              <a class="small" href="${esc(r.uri)}">${t('Or open the key directly in an app on this device')}</a></li>
            <li>${t('Type the 6-digit code the app shows now:')}
              <form class="inline-form" data-mfa-form style="margin-top:6px">
                <input class="field mfa-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required aria-label="${t('Code from your authenticator app')}">
                <button class="btn primary" type="submit">${t('Confirm')}</button><button class="btn" type="button" data-mfa-cancel>${t('Cancel')}</button>
              </form></li>
          </ol>
        </div>`, 'enable');
      $('.mfa-code', step).focus();
    }
    function showRecovery(codes, fresh) {
      const text = t('Recovery codes for HomeBaseOS') + '\n\n' + codes.join('\n') + '\n\n' + t('Each code works only once.') + '\n';
      box.innerHTML = head + `
        <div class="mfa-state on"><span class="dot"></span><div><b>${fresh ? t('Two-step verification is on') : t('New recovery codes')}</b>
          <div class="muted small">${t('Keep these recovery codes somewhere safe, e.g. in your password manager. If you lose your phone, sign in with one of these codes. Each code works only once, and you only see them here once.')}</div></div></div>
        <ul class="recovery-list">${codes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
        <div class="btn-row"><button class="btn" type="button" data-rc="copy">${t('Copy')}</button>
          <button class="btn" type="button" data-rc="download">${t('Download')}</button>
          <button class="btn primary" type="button" data-rc="done">${t('I\'ve saved them')}</button></div>`;
      box.onclick = async (e) => {
        const b = e.target.closest('[data-rc]'); if (!b) return;
        if (b.dataset.rc === 'copy') {
          try { await navigator.clipboard.writeText(text); toast(t('Copied.')); } catch (ex) { toast(t('Copying did not work in this browser.'), true); }
        } else if (b.dataset.rc === 'download') {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = 'homebaseos-herstelcodes.txt';
          document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } else mfaSection(box);
      };
      box.onsubmit = null;
    }
    box.onclick = async (e) => {
      if (e.target.closest('[data-mfa-cancel]')) { mfaSection(box); return; }
      const b = e.target.closest('[data-mfa]'); if (!b) return;
      if (b.dataset.mfa === 'start') showStep(`<p class="small">${t('Type your password to start.')}</p>` + pwForm(t('Continue')), 'setup');
      if (b.dataset.mfa === 'recovery') showStep(`<p class="small">${t('Type your password and a code from the app. Your old recovery codes stop working.')}</p>` + pwForm(t('Create new codes'), true), 'recovery');
      if (b.dataset.mfa === 'disable') {
        if (!(await ask(t('Turn off two-step verification? Your password alone will be enough to sign in again.'), t('Turn off')))) return;
        showStep(`<p class="small">${t('Type your password and a code from the app to turn off two-step verification.')}</p>` + pwForm(t('Turn off'), true), 'disable');
      }
    };
    box.onsubmit = async (e) => {
      const f = e.target.closest('[data-mfa-form]'); if (!f) return;
      e.preventDefault();
      const btn = $('button[type="submit"]', f), body = {};
      if (f.elements.password) body.password = f.elements.password.value;
      if (f.elements.code) body.code = f.elements.code.value;
      errEl.textContent = ''; btn.disabled = true;
      try {
        const r = await api.post('/api/mfa/' + action, body);
        if (action === 'setup') return showSetup(r);
        if (action === 'enable') {
          if (!S.config.demo) toast(t('Other browsers were signed out. They need to sign in again, now with a code.'));
          return showRecovery(r.recovery, true);
        }
        if (action === 'recovery') return showRecovery(r.recovery, false);
        toast(t('Two-step verification is off.'));
        mfaSection(box);
      } catch (ex) {
        errEl.textContent = ex.message; btn.disabled = false;
        const inp = f.elements.code || f.elements.password; if (inp) inp.select();
        if (ex.status === 410) mfaSection(box).then(() => { $('#mfaErr', box).textContent = ex.message; });
      }
    };
  }

  /* --- Software update: new versions of HomeBaseOS itself (GitHub releases) */
  // Small Markdown reader for release notes. Everything through esc() first, only then formatting: no HTML from GitHub ever gets through.
  function mdToHtml(src) {
    const inline = (x) => esc(x)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>').replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,!?]|$)/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    const out = []; let list = null, para = [], code = null;
    const flush = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } if (list) { out.push(`</${list}>`); list = null; } };
    for (const line of String(src || '').replace(/\r/g, '').split('\n')) {
      if (code != null) { if (/^\s*```/.test(line)) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; } else code.push(line); continue; }
      if (/^\s*```/.test(line)) { flush(); code = []; continue; }
      let m;
      if (!line.trim()) { flush(); continue; }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) { flush(); out.push(`<h${Math.min(6, m[1].length + 3)}>${inline(m[2])}</h${Math.min(6, m[1].length + 3)}>`); continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
      if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
        const kind = /\d/.test(m[1]) ? 'ol' : 'ul';
        if (para.length) flush();
        if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
        out.push('<li>' + inline(m[2]) + '</li>'); continue;
      }
      if (list) { flush(); }
      para.push(line.trim());
    }
    if (code != null) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
    flush();
    return out.join('');
  }
  const longDate = (iso) => (iso ? new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) : '');

  // Notification: red dot on Settings and on the tab, and once per version a notification (per browser).
  S.update = null;
  async function loadUpdate() {
    try { S.update = await api.get('/api/update'); } catch (e) { return; }
    const u = S.update, on = !!(u && u.updateAvailable);
    $('#updDot').hidden = !on; $('#updTabBadge').hidden = !on;
    $('#updTabBadge').textContent = on ? String(u.newer.length) : '';
    if (!on) return;
    let seen = null;
    try { seen = localStorage.getItem('tb-update-seen'); } catch (e) { /* private window */ }
    if (seen === u.latest.version) return;
    try { localStorage.setItem('tb-update-seen', u.latest.version); } catch (e) { /* private window */ }
    toast(t('HomeBaseOS {version} is available. See what\'s new in Settings → Software update.', { version: u.latest.version }));
  }

  // Progress of "Update now". During the restart the server is briefly gone: then we just keep asking.
  const UPD_STEPS = [['download', 'Download'], ['extract', 'Unpack'], ['verify', 'Verify'], ['backup', 'Backup'],
    ['install', 'Install'], ['restart', 'Restart'], ['check', 'Test']];
  const UPD_ORDER = ['start', 'download', 'extract', 'verify', 'handover', 'backup', 'install', 'packages', 'restart', 'check', 'rollback', 'done'];
  function updateProgress(el) {
    el.onclick = null; el.onchange = null;
    el.innerHTML = `<div class="upd-run" aria-live="polite">
        <div class="upd-run-head"><b id="updTitle">${t('Updating…')}</b><span class="muted small" id="updPct">0%</span></div>
        <div class="upd-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-labelledby="updTitle"><span id="updFill"></span></div>
        <p class="small" id="updMsg">${t('Starting the update…')}</p>
        <ol class="upd-steps">${UPD_STEPS.map(([k, label]) => `<li data-step="${k}">${t(label)}</li>`).join('')}</ol>
        <p class="muted small" id="updNote">${t('Keep this window open. HomeBaseOS will restart briefly; your apps and VMs keep running.')}</p>
        <div class="btn-row" id="updBtns"></div></div>`;
    let lost = 0, shown = 0;
    const started = Date.now();
    const draw = (p) => {
      const pct = Math.max(shown, Math.min(100, Math.round(p.percent || 0))); shown = pct;
      $('#updFill', el).style.width = pct + '%';
      $('.upd-bar', el).setAttribute('aria-valuenow', String(pct));
      $('#updPct', el).textContent = pct + '%';
      let msg = tr(p.message || '');
      if (p.step === 'download' && p.bytes) msg = t('Downloading version {version}… {done}', { version: p.version, done: bytes(p.bytes) + (p.total ? ' / ' + bytes(p.total) : '') });
      $('#updMsg', el).textContent = msg;
      if (p.step === 'rollback') return; // when rolling back the steps stay as they were
      const at = UPD_ORDER.indexOf(p.step);
      $$('.upd-steps li', el).forEach((li) => {
        const i = UPD_ORDER.indexOf(li.dataset.step);
        li.className = p.state === 'done' || i < at ? 'done' : i === at || (li.dataset.step === 'install' && p.step === 'packages') ? 'now' : '';
      });
    };
    const finish = (p) => {
      const ok = p.state === 'done';
      $('.upd-run', el).classList.add(ok ? 'ok' : 'bad');
      $('#updTitle', el).textContent = ok ? t('Updated to version {version}', { version: p.version }) : p.state === 'rolledback' ? t('Update failed: previous version restored') : t('Update failed');
      $('#updMsg', el).textContent = tr(p.message || '') + (p.reason ? ' ' + tr(p.reason) : '');
      $('#updNote', el).textContent = ok ? t('The page will reload with the new version in a moment.') : t('Your settings, apps and VMs were not touched.');
      $('#updBtns', el).innerHTML = ok ? `<button class="btn primary" type="button" data-upd-reload>${t('Refresh now')}</button>`
        : `<button class="btn" type="button" data-upd-back>${t('Back')}</button>`;
      el.onclick = (e) => {
        if (e.target.closest('[data-upd-reload]')) { if (S.config.demo) updatePane(el); else location.reload(); }
        if (e.target.closest('[data-upd-back]')) updatePane(el);
      };
      $('#updDot').hidden = ok; $('#updTabBadge').hidden = ok;
      if (ok) { toast(t('Updated to version {version}', { version: p.version })); if (!S.config.demo) setTimeout(() => location.reload(), 4000); }
    };
    const poll = async () => {
      if (!el.isConnected || settingsTab() !== 'update') return; // window closed: it continues when opened again
      let p;
      try { p = await api.get('/api/update/progress'); lost = 0; }
      catch (e) {
        // Server restarting: no answer for a while. Give up after 3 minutes.
        if (++lost === 1) $('#updMsg', el).textContent = t('HomeBaseOS is restarting… please wait.');
        if (Date.now() - started > 180000) { finish({ state: 'failed', message: t('HomeBaseOS is not responding. Check on the server: journalctl -u homebaseos') }); return; }
        setTimeout(poll, 1500); return;
      }
      if (p.state === 'idle') { updatePane(el); return; }
      draw(p);
      if (p.state === 'running') { setTimeout(poll, 700); return; }
      finish(p);
    };
    poll();
  }

  async function updatePane(el) {
    el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let u;
    try { u = await api.get('/api/update'); } catch (e) { el.innerHTML = `<p class="lead">${esc(e.message)}</p>`; return; }
    if (settingsTab() !== 'update') return;
    S.update = u;
    // A development build: the version plus the commit it was built from.
    const cur = u.build ? `${u.current} (${u.build.branch} · ${String(u.build.commit).slice(0, 7)})` : u.current;
    const mark = '<span class="upd-logo" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M5 15.5 16 6l11 9.5V27H19.5v-7.5h-7V27H5z"/></svg></span>';
    const checked = u.checked ? t('Last checked: {when}', { when: esc(new Date(u.checked).toLocaleString(LOCALE, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', ...clockOpts() })) }) : t('Not checked for updates yet.');
    const notes = (r) => `<article class="notes">
        <div class="notes-head"><h3>${t('Version {version}', { version: esc(r.version) })}${r.name && r.name.replace(/^v/, '') !== r.version ? ' · ' + esc(r.name) : ''}
          ${r.dev ? ` <span class="pill warn">${t('Development')}</span>` : r.prerelease ? ` <span class="pill warn">${t('Beta')}</span>` : ''}</h3>
          <span class="muted small">${esc(longDate(r.published))}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">${t('On GitHub')}</a>` : ''}</span></div>
        <div class="md">${r.notes.trim() ? mdToHtml(r.notes) : `<p class="muted">${t('No release notes for this version.')}</p>`}</div></article>`;
    const card = u.updateAvailable ? `
      <div class="upd-card new">${mark}<div class="upd-text"><b>${t('HomeBaseOS {version} is available', { version: esc(u.latest.version) })}</b>
        <div class="muted small">${t('You have version {current}.', { current: esc(cur) })} ${u.newer.length > 1 ? t('There are {n} new versions.', { n: u.newer.length }) : ''}</div>
        <div class="muted small">${checked}</div></div>
        <div class="btn-row"><button class="btn" type="button" data-sw="check">${t('Check now')}</button>
          <button class="btn primary" type="button" data-sw="install"${u.install && u.install.ok ? '' : ' disabled'}>${t('Update now')}</button></div></div>
      ${u.install && !u.install.ok ? `<p class="muted small" style="margin-top:-6px">${esc(tr(u.install.reason))}</p>` : ''}` : `
      <div class="upd-card">${mark}<div class="upd-text"><b>${t('HomeBaseOS is up to date')}</b>
        <div class="muted small">${t('Version {current}', { current: esc(cur) })}</div><div class="muted small">${checked}</div></div>
        <button class="btn" type="button" data-sw="check">${t('Check now')}</button></div>`;
    el.innerHTML = card +
      (u.error ? `<div class="upd-error" role="alert">${esc(tr(u.error))}</div>` : '') +
      (u.updateAvailable ? `
        <h2 class="pane-title">${t('What\'s new')}</h2>${u.newer.map(notes).join('')}
        ${u.install && u.install.ok ? '' : `<h2 class="pane-title">${t('Update')}</h2>
        <div class="upd-how"><p class="muted small">${t('Get the new version in the folder with the HomeBaseOS code on the server, and run the install script again. Your settings, apps and VMs stay as they are.')}</p>
          <pre>cd ~/homebaseos
git pull
sudo ./install.sh</pre></div>`}` : '') +
      (u.history.length ? `<details class="upd-older"${u.updateAvailable ? '' : ' open'}><summary>${u.updateAvailable ? t('Earlier versions') : t('Release notes')}</summary>${u.history.map(notes).join('')}</details>` : '') + `
      <section id="debianBox" class="debian-box"><h2 class="pane-title">${t('Debian (the system)')}</h2><p class="muted">${t('Loading…')}</p></section>
      <h2 class="pane-title">${t('Settings')}</h2>
      <div class="form">
        <label class="check"><input type="checkbox" name="updateCheck"${u.auto ? ' checked' : ''}> ${t('Check for updates automatically (every 12 hours)')}</label>
        <div class="choice-row" role="radiogroup" aria-label="${t('Kind of versions')}">${[['stable', t('Stable versions only')], ['beta', t('Include beta versions')], ['dev', t('Dev versions (branch {branch})', { branch: u.branch || 'dev' })]].map(([k, name]) => `
          <label class="choice"><input type="radio" name="updateChannel" value="${k}"${k === u.channel ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}</div>
        ${u.channel === 'dev' ? `<p class="muted small">${t('Development: every new commit on the {branch} branch is an update. Only for a test server: these versions are not tested yet.', { branch: esc(u.branch || 'dev') })}</p>
        <div class="upd-how"><p class="muted small">${t('Update now installs the newest code of {branch}. In a terminal (SSH, or the terminal at the top right) it works too:', { branch: esc(u.branch || 'dev') })}</p>
          <pre>sudo bash /opt/homebaseos/deploy/install-branch.sh ${esc(u.branch || 'dev')}</pre>
          <p class="muted small">${t('Back to official versions: the same command with main.')}</p></div>` : ''}
        <p class="muted small">${t('HomeBaseOS looks for new versions on GitHub ({repo}).', { repo: esc(u.repo) })}${u.token ? '' : ' ' + t('If the repository is private, put a token in UPDATE_TOKEN.')}</p>
      </div>`;
    debianSection($('#debianBox', el));
    if (u.running) { updateProgress(el); return; } // an update is already running (e.g. after refreshing the page)
    el.onclick = async (e) => {
      if (e.target.closest('[data-sw="install"]')) {
        const v = u.latest.version;
        if (!(await ask(t('Update HomeBaseOS to version {version}? HomeBaseOS will restart briefly; your apps and VMs keep running.', { version: v }), t('Update now')))) return;
        try { await api.post('/api/update/install', { version: v }); updateProgress(el); }
        catch (ex) { toast(ex.message, true); }
        return;
      }
      const b = e.target.closest('[data-sw="check"]'); if (!b) return;
      b.disabled = true; b.textContent = t('Checking…');
      try { await api.post('/api/update/check'); } catch (ex) { toast(ex.message, true); }
      await loadUpdate(); updatePane(el);
    };
    el.onchange = async (e) => {
      const n = e.target.name; if (n !== 'updateCheck' && n !== 'updateChannel') return;
      try {
        await api.post('/api/settings', n === 'updateCheck' ? { updateCheck: e.target.checked } : { updateChannel: e.target.value });
        if (n === 'updateChannel') await api.post('/api/update/check').catch(() => {}); // another channel: look right away
        toast(t('Saved.'));
        await loadUpdate(); updatePane(el);
      } catch (ex) { toast(ex.message, true); }
    };
  }

  /* --- Software update > Debian: what is waiting, automatic security updates, restart needed (lib/debian.js) */
  async function debianSection(box) {
    let d;
    try { d = await api.get('/api/system-updates'); }
    catch (e) { box.innerHTML = `<h2 class="pane-title">${t('Debian (the system)')}</h2><p class="muted small">${esc(e.message)}</p>`; return; }
    if (!box.isConnected) return;
    const busy = d.job && d.job.running;
    const sec = d.security, n = d.updates.length;
    const title = n ? t(n === 1 ? '{n} update for Debian' : '{n} updates for Debian', { n }) + (sec ? ' · ' + t(sec === 1 ? '{n} security update' : '{n} security updates', { n: sec }) : '')
      : t('Debian is up to date');
    const when = (iso) => esc(new Date(iso).toLocaleString(LOCALE, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', ...clockOpts() }));
    const last = d.auto.last;
    const lastText = !d.auto.installed ? t('Automatic updates are not installed yet.')
      : last ? t('Last automatic run: {when}', { when: when(last.at) }) + ' · ' + (last.nothing ? t('nothing to install') : last.packages.length ? t('{n} packages updated', { n: last.packages.length }) : t('done')) + (last.ok ? '' : ' · ' + t('with errors'))
      : t('Automatic updates haven\'t run yet.');
    const reboot = d.reboot.required ? `<div class="upd-error deb-reboot" role="status">
        <b>${t('A restart is needed to finish the updates.')}</b>
        <div class="muted small">${d.newestKernel && d.newestKernel !== d.kernel ? t('New kernel {new} (now {old}).', { new: esc(d.newestKernel), old: esc(d.kernel) }) + ' ' : ''}${d.reboot.packages.length ? t('Updated: {list}.', { list: esc(d.reboot.packages.join(', ')) }) : ''}</div>
        ${d.reboot.zfsReady === false ? `<p class="small temp-bad">${t('Don\'t restart yet: the ZFS module isn\'t built for the new kernel, so your pools wouldn\'t come online. Run Update Debian now again, or check dkms status in the terminal.')}</p>`
          : `<div class="btn-row"><button class="btn" type="button" data-deb="reboot">${t('Restart now')}</button></div>`}</div>` : '';
    box.innerHTML = `<h2 class="pane-title">${t('Debian (the system)')}</h2>
      <div class="upd-card${n ? ' new' : ''}"><div class="upd-text"><b>${title}</b>
        <div class="muted small">${esc([d.os, d.kernel && t('kernel {k}', { k: d.kernel })].filter(Boolean).join(' · '))}</div>
        <div class="muted small">${d.listsAt ? t('Package lists: {when}', { when: when(d.listsAt) }) : ''}</div></div>
        <div class="btn-row"><button class="btn" type="button" data-deb="check"${busy ? ' disabled' : ''}>${t('Check now')}</button>
          ${n ? `<button class="btn primary" type="button" data-deb="upgrade"${busy ? ' disabled' : ''}>${t('Update Debian now')}</button>` : ''}</div></div>
      ${reboot}
      <label class="check"><input type="checkbox" data-deb-auto${d.auto.enabled ? ' checked' : ''}${busy ? ' disabled' : ''}> ${t('Install security updates automatically (every day, without restarting by itself)')}</label>
      <p class="muted small">${lastText}</p>
      ${n ? `<details class="upd-older"><summary>${t('Waiting updates ({n})', { n })}</summary><ul class="deb-list">${d.updates.map((x) =>
        `<li><b>${esc(x.name)}</b> <span class="muted small">${esc(x.from)} → ${esc(x.version)}</span>${x.security ? ` <span class="pill warn">${t('Security')}</span>` : ''}</li>`).join('')}</ul></details>` : ''}
      <div data-deb-job></div>`;
    const jobBox = $('[data-deb-job]', box);
    const follow = async () => {
      let p;
      try { p = await api.get('/api/system-updates/progress'); } catch (e) { if (box.isConnected) setTimeout(follow, 2000); return; } // HomeBaseOS restarting (needrestart)
      if (!box.isConnected) return;
      const label = { check: t('Checking for updates'), upgrade: t('Updating Debian'), 'auto-on': t('Turning on automatic updates'), 'auto-off': t('Turning off automatic updates') }[p.action] || '';
      jobBox.innerHTML = p.state === 'idle' ? '' : `<div class="deb-job">
        <p class="small"><b>${esc(label)}</b> · ${p.running ? esc(tr(p.message || '…')) : p.state === 'done' ? t('Done.') : `<span class="temp-bad">${esc(tr(p.message || t('Failed.')))}</span>`}</p>
        <details${p.state === 'failed' ? ' open' : ''}><summary>${t('Details')}</summary><pre class="logs">${esc(p.lines.join('\n'))}</pre></details></div>`;
      const pre = $('pre', jobBox); if (pre) pre.scrollTop = pre.scrollHeight;
      if (p.running) setTimeout(follow, 1500);
      else if (busy || jobBox.dataset.waiting) { delete jobBox.dataset.waiting; debianSection(box); }
    };
    if (busy || (d.job && d.job.state !== 'done')) follow();
    const startJob = async (action) => {
      try { await api.post('/api/system-updates/' + action); jobBox.dataset.waiting = '1'; $$('[data-deb]', box).forEach((b) => { b.disabled = true; }); follow(); }
      catch (ex) { toast(ex.message, true); }
    };
    box.onclick = async (e) => {
      const b = e.target.closest('[data-deb]'); if (!b) return;
      if (b.dataset.deb === 'reboot') return powerAction('reboot');
      if (b.dataset.deb === 'upgrade' && !(await ask(t('Install {n} updates for Debian now? Apps and VMs keep running; some services restart briefly.', { n }), t('Update Debian now')))) return;
      startJob(b.dataset.deb);
    };
    box.onchange = async (e) => {
      if (!e.target.matches('[data-deb-auto]')) return;
      if (!e.target.checked && !(await ask(t('Turn off automatic security updates? Then you have to install them yourself.'), t('Turn off')))) { e.target.checked = true; return; }
      startJob(e.target.checked ? 'auto-on' : 'auto-off');
    };
  }

  async function aboutPane(el) {
    el.onchange = null;
    el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
    let a;
    try { a = await api.get('/api/about'); }
    catch (e) { el.innerHTML = `<p class="lead">${t('The details could not be loaded: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'about') return;
    const b = a.board || {};
    const groups = [
      [t('Server'), [[t('Hostname'), a.hostname], [t('System'), [b.vendor, b.product].filter(Boolean).join(' ')],
        [t('Motherboard'), [b.boardVendor, b.board].filter(Boolean).join(' ')], [t('BIOS'), [b.bios, b.biosDate].filter(Boolean).join(' · ')]]],
      [t('Hardware'), [[t('Processor'), a.cpu && a.cpu.brand], [t('Cores'), a.cpu && a.cpu.threads ? t('{cores} cores, {threads} threads', { cores: a.cpu.cores || '?', threads: a.cpu.threads }) : null],
        [t('Memory'), bytes(a.memory)],
        [t('ECC'), a.ecc ? (a.ecc.active ? t('Active') + (a.ecc.mode ? ' (' + a.ecc.mode + ')' : '') + (a.ecc.corrected ? ' · ' + t('{n} errors corrected', { n: a.ecc.corrected }) : '') : t('Not active')) : t('Unknown')],
        [t('Graphics card'), (a.gpus || []).join(', ')]]],
      [t('Operating system'), [[t('System'), a.os], [t('Kernel'), a.kernel], [t('Architecture'), a.arch], [t('Time zone'), a.timezone],
        [t('Up for'), a.uptime != null ? duration(a.uptime) : null], [t('IP addresses'), (a.addresses || []).map((x) => x.address + ' (' + x.interface + ')').join(', ')]]],
      [t('Versions'), Object.entries({ HomeBaseOS: a.versions.homebaseos, 'Node.js': a.versions.node, Docker: a.versions.docker, 'Docker Compose': a.versions.compose,
        ZFS: a.versions.zfs, libvirt: a.versions.libvirt, [t('Hypervisor')]: a.versions.hypervisor })],
    ];
    const plain = groups.map(([title, rows]) => title + '\n' + rows.map(([k, v]) => '  ' + k + ': ' + (v || '–')).join('\n')).join('\n\n');
    el.innerHTML = groups.map(([title, rows]) => `<h2 class="pane-title">${esc(title)}</h2>
      <dl class="kv about-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v ? esc(v) : '<span class="muted">' + t('not found') + '</span>'}</dd>`).join('')}</dl>`).join('') +
      `<div class="btn-row" style="margin-top:18px"><button class="btn" type="button" id="aboutCopy">${t('Copy everything')}</button></div>
      <p class="muted small" style="margin-top:8px">${t('Handy when you ask for help somewhere.')}</p>`;
    $('#aboutCopy', el).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(plain); toast(t('Copied.')); } catch (e) { toast(t('Copying did not work in this browser.'), true); }
    });
  }

  /* --- AI */
  const chatHistory = [];
  async function aiWindow() {
    openWindow(t('AI'), `<p class="lead">${t('Loading…')}</p>`);
    try { await loadAi(true); } catch (e) { /* error is in S.aiError */ }
    if (S.aiError) {
      $('#winBody').innerHTML = S.aiDown
        ? `<p class="lead">${t('Ollama is not running on this server yet. Install the Ollama app from the app store: HomeBaseOS will find it by itself. With an NVIDIA card it uses the GPU.')}</p>
          <div class="btn-row"><button class="btn primary" type="button" data-ai-store>${t('Find Ollama in the app store')}</button></div>`
        : `<p class="lead">${esc(S.config.ollama ? t('Ollama is not reachable: {error}', { error: S.aiError })
          : t('Ollama is not connected yet. Set OLLAMA_URL in /etc/homebaseos/homebaseos.env, for example http://127.0.0.1:11434.'))}</p>`;
      const b = $('[data-ai-store]');
      if (b) b.onclick = () => { win.close(); S.storeQuery = 'ollama'; $('#storeSearch').value = 'ollama'; location.hash = 'store'; };
      return;
    }
    const draw = () => {
      const ai = S.ai; const g = ai.gpu && ai.gpu[0];
      const opts = ai.models.filter((m) => !/embed/i.test(m.name)).map((m) => `<option value="${esc(m.name)}" ${m.loaded ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
      $('#winBody').innerHTML = `
        <div class="stat-strip">
          ${g ? `<div class="stat"><b>${bytes(g.memUsed)}</b><span>${t('of {total} VRAM', { total: bytes(g.memTotal) })}</span></div>
                 <div class="stat"><b>${g.util ?? '–'}%</b><span>${t('GPU load')}</span></div>` : ''}
          <div class="stat"><b>${ai.models.length}</b><span>${t(ai.models.length === 1 ? 'model' : 'models')}</span></div>
          ${ai.version ? `<div class="stat"><b>${esc(ai.version)}</b><span>${t('Ollama version')}</span></div>` : ''}
        </div>
        <h3>${t('Models')}</h3>
        <ul class="rows" id="modelRows">${ai.models.map((m) => `<li>
          <div><div class="row-title">${esc(m.name)}</div>
            <div class="row-sub">${esc([m.params, m.quant, bytes(m.size), m.loaded ? t('loaded in {size} VRAM', { size: bytes(m.vram) }) : null].filter(Boolean).join(' · '))}</div></div>
          <div class="btn-row">
            ${m.loaded ? `<button class="btn sm" data-model="${esc(m.name)}" data-do="unload">${t('Unload')}</button>`
                       : `<button class="btn sm" data-model="${esc(m.name)}" data-do="load">${t('Load')}</button>`}
            <button class="btn sm danger" data-model="${esc(m.name)}" data-do="delete">${t('Remove')}</button>
          </div></li>`).join('') || `<li><span class="muted">${t('No models yet. Download one below.')}</span></li>`}</ul>

        <h3>${t('Download a model')}</h3>
        <form class="inline-form" id="pullForm">
          <input class="field" id="pullName" placeholder="${t('for example qwen3:8b')}" autocomplete="off" required>
          <button class="btn primary" type="submit">${t('Download')}</button>
        </form>
        <div class="bar" style="margin-top:10px" hidden id="pullBarWrap"><span id="pullBar"></span></div>
        <p class="progress-note" id="pullNote"></p>

        <h3>${t('Ask something quickly')}</h3>
        ${opts ? `<div class="chat">
          <select class="field" id="chatModel" aria-label="${t('Model')}">${opts}</select>
          <div class="chat-log" id="chatLog">${chatHistory.map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join('')}</div>
          <form class="inline-form" id="chatForm">
            <textarea class="field" id="chatInput" placeholder="${t('Ask your own model a question')}" required></textarea>
            <button class="btn primary" type="submit">${t('Send')}</button>
          </form>
        </div>` : `<p class="lead">${t('Download a model first to chat.')}</p>`}`;
    };
    draw();

    const body = $('#winBody');
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-model]'); if (!b) return;
      const name = b.dataset.model, act = b.dataset.do;
      if (act === 'delete' && !(await ask(t('Remove {name}?', { name }), t('Remove')))) return;
      withBusy(b, async () => {
        if (act === 'delete') await api.del('/api/ai/models/' + encodeURIComponent(name));
        else await api.post('/api/ai/models/' + encodeURIComponent(name) + '/' + act);
        toast(t({ delete: 'Removed', load: 'Loaded', unload: 'Unload' }[act]) + ': ' + name);
        await loadAi(); draw();
      });
    });
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (e.target.id === 'pullForm') {
        const name = $('#pullName').value.trim(); if (!name) return;
        const btn = e.target.querySelector('button'); btn.disabled = true;
        $('#pullBarWrap').hidden = false;
        try {
          await api.stream('/api/ai/pull', { name }, (l) => {
            if (l.total && l.completed != null) {
              const p = (l.completed / l.total) * 100;
              $('#pullBar').style.width = p.toFixed(1) + '%';
              $('#pullNote').textContent = t('Downloading: {done} of {total}', { done: bytes(l.completed), total: bytes(l.total) });
            } else if (l.status) $('#pullNote').textContent = l.status === 'success' ? t('Ready') : l.status;
          });
          toast(t('Downloaded: {name}', { name }));
          await loadAi(); draw();
        } catch (err) { $('#pullNote').textContent = t('Download failed: {error}', { error: err.message }); btn.disabled = false; }
      }
      if (e.target.id === 'chatForm') {
        const input = $('#chatInput'); const text = input.value.trim(); if (!text) return;
        const model = $('#chatModel').value; const log = $('#chatLog');
        const btn = e.target.querySelector('button'); btn.disabled = true; input.value = '';
        chatHistory.push({ role: 'user', content: text });
        log.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}</div>`);
        const out = document.createElement('div'); out.className = 'msg assistant'; out.textContent = '…'; log.appendChild(out);
        log.scrollTop = log.scrollHeight;
        let answer = '';
        try {
          await api.stream('/api/ai/chat', { model, messages: chatHistory }, (l) => {
            if (l.message && l.message.content) { answer += l.message.content; out.textContent = answer; log.scrollTop = log.scrollHeight; }
          });
          chatHistory.push({ role: 'assistant', content: answer });
        } catch (err) { out.textContent = t('No answer: {error}', { error: err.message }); chatHistory.pop(); }
        btn.disabled = false; input.focus();
      }
    });
    body.addEventListener('keydown', (e) => {
      if (e.target.id === 'chatInput' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); }
    });
  }

  /* ------------------------------------------------------------ loading */
  async function loadOverview() { S.overview = await api.get('/api/overview'); renderOverview(); }
  async function loadApps() { S.apps = await api.get('/api/apps'); renderApps(); if (S.apps.some(updating)) watchUpdates(); }
  async function loadVms() {
    try { S.vms = await api.get('/api/vms'); S.vmError = null; }
    catch (e) { S.vmError = e.message; throw e; }
    finally { S.vmsLoaded = true; renderVmWidget(); renderVmPage(); }
  }
  async function loadAi(quiet) {
    try { S.ai = await api.get('/api/ai'); S.aiError = null; S.aiDown = false; }
    catch (e) { S.aiError = e.message; S.aiDown = !!(e.data && e.data.notRunning); if (!quiet) { /* quiet in the widget */ } }
    renderAiWidget();
  }

  let failures = 0;
  async function refresh(all) {
    const jobs = [loadOverview(), loadApps()];
    // On the VM page a separate, faster timer fetches the VMs.
    if (all || currentView() !== 'vms') jobs.push(loadVms().catch(() => {}));
    if (all) jobs.push(loadAi(true), loadShares(), loadBackups());
    const results = await Promise.allSettled(jobs);
    const bad = results.find((r) => r.status === 'rejected');
    if (bad) {
      if (bad.reason && bad.reason.status === 401) return showLogin();
      if (++failures === 1) toast(t('Server not reachable: {error}', { error: bad.reason.message }), true);
    } else failures = 0;
  }

  /* ------------------------------------------------------------ screens */
  const VIEWS = { '#vms': 'vms', '#store': 'store' };
  // Settings is a window above the page you're on (like System Settings on macOS).
  // pageHash remembers that page; #settings/... in the address bar only opens the window.
  let pageHash = location.hash.startsWith('#settings') ? '' : location.hash;
  const settingsHash = () => location.hash.startsWith('#settings');
  function currentView() { return VIEWS[settingsHash() ? pageHash : location.hash] || 'home'; }
  let pageLoaded = false;
  function route() {
    const inSettings = settingsHash();
    const view = currentView();
    $('#desk').hidden = view !== 'home';
    $('#vmPage').hidden = view !== 'vms';
    $('#storePage').hidden = view !== 'store';
    $$('.nav-btn[data-open]').forEach((b) => {
      if (b.dataset.open === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $$('.nav-btn[data-nav="settings"]').forEach((b) => { if (inSettings) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (inSettings) { if (!setWin.open) setWin.showModal(); showSettings(); return; }
    // Always load the first time (also when the page opens right on #store or #vms).
    const pageChanged = location.hash !== pageHash || !pageLoaded;
    pageHash = location.hash; pageLoaded = true;
    if (setWin.open) closeSettings();
    if (!pageChanged && view !== 'home') return; // window closed: the page below just stays
    if (view === 'vms') { window.scrollTo(0, 0); renderVmPage(); loadVms().catch(() => {}); }
    if (view === 'store') { window.scrollTo(0, 0); loadStore(); }
  }
  const setWin = $('#setWin');
  // Close: straight back to the address of the page below, without rebuilding it.
  // (Not in the close event: that comes asynchronously and can lag behind a next click.)
  function closeSettings() {
    clearInterval(netTimer); netTimer = null;
    if (settingsHash()) history.replaceState(null, '', pageHash || location.pathname + location.search);
    $$('.nav-btn[data-nav="settings"]').forEach((b) => b.removeAttribute('aria-current'));
    if (setWin.open) setWin.close();
  }
  $('#setClose').addEventListener('click', closeSettings);
  setWin.addEventListener('click', (e) => { if (e.target === setWin) closeSettings(); });
  setWin.addEventListener('cancel', (e) => { e.preventDefault(); closeSettings(); }); // Escape
  window.addEventListener('hashchange', () => { if (!$('.topnav').hidden) route(); });

  function showDesk() {
    $('#loginScreen').hidden = true; $('.topnav').hidden = false; route();
  }
  function showLogin() {
    if (setWin.open) closeSettings();
    if (win.open) win.close();
    timers.forEach(clearInterval); timers = []; // stop refreshing (and don't empty the form) while signing in
    const wasHidden = $('#loginScreen').hidden;
    $('#desk').hidden = true; $('#vmPage').hidden = true; $('#storePage').hidden = true; $('#loginScreen').hidden = false; $('.topnav').hidden = true;
    const demoInfo = S.config && S.config.demo;
    $('#loginDemo').hidden = !demoInfo;
    if (demoInfo) $('#loginDemo').innerHTML = t('Demo: sign in as {user} with the password {pw}.', { user: '<b>' + esc(window.HomeBaseOSDemo.user()) + '</b>', pw: '<b>demo</b>' });
    if (wasHidden) loginStep('password');
  }

  let timers = [];
  function startDesk() {
    showDesk();
    $('#demoBadge').hidden = api === realApi;
    $('#logoutBtn').hidden = !S.config.passwordEnabled;
    $('#powerBtn').hidden = false;
    $('#termBtn').hidden = !S.config.terminal;
    if (S.config.onboarding && !onbWin.open) openOnboarding();
    refresh(true);
    loadLayout();
    loadUpdate();
    timers.forEach(clearInterval);
    timers = [
      setInterval(() => { if (!document.hidden) refresh(false); }, 10000),
      setInterval(() => { if (!document.hidden && currentView() === 'vms') loadVms().catch(() => {}); }, 3000), // live CPU/RAM
      setInterval(() => { if (!document.hidden) { loadAi(true); loadShares(); loadBackups(); loadUpdate(); } }, 30000),
    ];
  }

  /* --- power: restart or shut down the server (button at the top) */
  const powerMenu = $('#powerMenu'), powerBtn = $('#powerBtn'), powerWin = $('#powerWin');
  function closePowerMenu(focus) {
    powerMenu.hidden = true; powerBtn.setAttribute('aria-expanded', 'false');
    if (focus) powerBtn.focus();
  }
  powerBtn.addEventListener('click', () => {
    if (!powerMenu.hidden) { closePowerMenu(false); return; }
    powerMenu.hidden = false; powerBtn.setAttribute('aria-expanded', 'true');
    const b = powerBtn.getBoundingClientRect(), r = powerMenu.getBoundingClientRect();
    powerMenu.style.left = Math.max(8, Math.min(b.right - r.width, innerWidth - r.width - 8)) + 'px';
    powerMenu.style.top = (b.bottom + 6) + 'px';
    $('.menu-item', powerMenu).focus();
  });
  powerMenu.addEventListener('keydown', (e) => {
    const items = $$('.menu-item', powerMenu), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePowerMenu(true); }
    else if (e.key === 'Tab') closePowerMenu(false);
  });
  document.addEventListener('pointerdown', (e) => { if (!powerMenu.hidden && !powerMenu.contains(e.target) && !powerBtn.contains(e.target)) closePowerMenu(false); }, true);
  powerMenu.addEventListener('click', (e) => { const b = e.target.closest('[data-power]'); if (b) { closePowerMenu(false); powerAction(b.dataset.power); } });

  function showPower(title, text, spinning, buttons = '') {
    $('#powerTitle').textContent = title; $('#powerText').textContent = text;
    $('#powerSpin').hidden = !spinning; $('#powerBtns').innerHTML = buttons;
    if (!powerWin.open) powerWin.showModal();
  }
  powerWin.addEventListener('cancel', (e) => e.preventDefault()); // no clicking away while the server is gone
  powerWin.addEventListener('click', (e) => { if (e.target.closest('[data-power-reload]')) location.reload(); });

  async function powerAction(act) {
    const reboot = act === 'reboot';
    const vms = S.vms.filter((v) => vmKind(v.state) === 'on').length;
    const backups = S.backup ? S.backup.jobs.filter((j) => j.running).length : 0;
    const extra = [vms ? t(vms === 1 ? '{n} VM is shut down properly.' : '{n} VMs are shut down properly.', { n: vms }) : '',
      backups ? t('A backup that is running now stops.') : ''].filter(Boolean).join(' ');
    const q = reboot ? t('Restart the server? Apps, VMs and shared folders are unreachable for a few minutes.')
      : t('Shut down the server? Apps, VMs and shared folders stay unreachable until you turn it back on with the power button.');
    if (!(await ask(q + (extra ? ' ' + extra : ''), t(reboot ? 'Restart' : 'Shut down')))) return;
    try { await api.post('/api/system/power', { action: act }); } catch (e) { toast(e.message, true); return; }
    if (api !== realApi) { toast(t(reboot ? 'In the demo nothing restarts.' : 'In the demo nothing shuts down.')); return; }
    timers.forEach(clearInterval); timers = [];
    if (!reboot) {
      showPower(t('The server is shutting down'), t('Turn it back on with the power button. Then refresh this page.'), false,
        `<button class="btn" type="button" data-power-reload>${t('Refresh page')}</button>`);
      return;
    }
    showPower(t('The server is restarting…'), t('This usually takes a few minutes. This page comes back by itself.'), true);
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 15000)); // let it really go away first
    for (;;) {
      try { await realApi.get('/api/config'); location.reload(); return; } catch (e) { /* not back yet */ }
      if (Date.now() - start > 6 * 60000) {
        showPower(t('The server doesn\'t come back'), t('Check whether it is on and whether the network works. Then refresh this page.'), false,
          `<button class="btn primary" type="button" data-power-reload>${t('Refresh page')}</button>`);
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Overview: back to the dashboard, and close whatever is still open.
  function goHome() {
    if (win.open) win.close();
    if (conWin.open) window.TB_closeConsole();
    closeFolder();
    if (location.hash && location.hash !== '#') location.hash = ''; else window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  /* ------------------------------------------------------------ choosing a password (wizard and Security) */
  function passwordFields(currentLabel) {
    return `<label class="fld"><span>${esc(currentLabel || t('Current password'))}</span>
        <input class="field" type="password" name="current" autocomplete="current-password"></label>
      <label class="fld"><span>${t('New password')}</span>
        <input class="field" type="password" name="password" autocomplete="new-password" minlength="10">
        <div class="pw-meter" data-score="0" aria-hidden="true"><span></span></div>
        <span class="muted small" data-pw-hint>${t('At least 10 characters. A sentence of a few words is strong and easy to remember.')}</span></label>
      <label class="fld"><span>${t('Repeat the new password')}</span>
        <input class="field" type="password" name="repeat" autocomplete="new-password"></label>`;
  }
  // 0–4: length counts most, variety (lower/upper case, digits, symbols) a bit.
  function pwScore(v) {
    if (v.length < 10) return v ? 1 : 0;
    const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
    return Math.min(4, 1 + (v.length >= 14) + (v.length >= 20) + (kinds >= 3));
  }
  function wirePasswordMeter(root) {
    const inp = $('input[name="password"]', root), meter = $('.pw-meter', root), hint = $('[data-pw-hint]', root);
    const words = ['', t('Too short'), t('Fair'), t('Good'), t('Strong')];
    const upd = () => {
      const sc = pwScore(inp.value);
      meter.dataset.score = String(sc); $('span', meter).style.width = (sc * 25) + '%';
      hint.textContent = inp.value ? words[sc] + (sc === 1 ? ' · ' + t('{n} more characters', { n: Math.max(0, 10 - inp.value.length) }) : '') : t('At least 10 characters. A sentence of a few words is strong and easy to remember.');
    };
    inp.oninput = upd; upd();
  }
  async function submitPassword(root) {
    const f = (n) => $(`input[name="${n}"]`, root).value;
    if (f('password').length < 10) throw new Error(t('Choose a password of at least 10 characters.'));
    if (f('password') !== f('repeat')) throw new Error(t('The two new passwords don\'t match.'));
    return api.post('/api/password', { current: f('current'), password: f('password') });
  }

  /* ------------------------------------------------------------ welcome wizard (first time: create an account; afterwards after the first sign-in) */
  const onbWin = $('#onbWin');
  const ONB = { steps: [], i: 0, dir: 1, data: null, setup: false, pool: null };
  const HOUSE = '<svg viewBox="0 0 32 32"><path d="M5 15.5 16 6l11 9.5V27H19.5v-7.5h-7V27H5z"/></svg>';
  const hero = (svg, line) => `<div class="onb-hero${line ? ' line' : ''}" aria-hidden="true">${svg}</div>`;
  const LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>';
  function onbSteps() {
    const d = () => ONB.data;
    const pwOn = S.config.passwordEnabled || S.config.demo;
    // First time (no account yet): create an account. Otherwise (older installs): replace the password from the installation.
    const account = { id: 'account',
      render(el) {
        if (!ONB.setup) {
          el.innerHTML = hero('<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg>', true) +
            `<h1 id="onbTitle">${t('Your account')}</h1>
            <p class="lead">${t('Your account {user} has been created. You use it to sign in on every device.', { user: `<b>${esc(d().user || '')}</b>` })}</p>`;
          return;
        }
        el.innerHTML = hero('<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg>', true) +
          `<h1 id="onbTitle">${t('Create your account')}</h1>
          <p class="lead">${t('You use this to sign in to HomeBaseOS. Choose a password you can remember, or keep it in your password manager.')}</p>
          <form class="form" data-onb-form>
            <label class="fld"><span>${t('User name')}</span>
              <input class="field" name="user" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" value="admin">
              <span class="muted small">${t('Lowercase letters, digits, dot, - or _.')}</span></label>
            <label class="fld"><span>${t('Password')}</span>
              <input class="field" type="password" name="password" autocomplete="new-password" minlength="10">
              <div class="pw-meter" data-score="0" aria-hidden="true"><span></span></div>
              <span class="muted small" data-pw-hint></span></label>
            <label class="fld"><span>${t('Repeat the password')}</span>
              <input class="field" type="password" name="repeat" autocomplete="new-password"></label>
            ${S.config.demo ? `<p class="muted small">${t('Demo: the account only stays in this browser. Afterwards you can also sign in with the password {pw}.', { pw: '<b>demo</b>' })}</p>` : ''}
            <p class="form-error onb-err" role="alert"></p></form>`;
        wirePasswordMeter(el);
        $('input[name="user"]', el).select();
      },
      async next(el) {
        if (!ONB.setup) return true;
        const val = (n) => $(`input[name="${n}"]`, el).value;
        if (val('password').length < 10) throw new Error(t('Choose a password of at least 10 characters.'));
        if (val('password') !== val('repeat')) throw new Error(t('The two passwords do not match.'));
        const r = await api.post('/api/setup', { user: val('user'), password: val('password'), repeat: val('repeat'), language: LANG });
        ONB.setup = false;
        S.config = { ...S.config, setup: false, passwordEnabled: true, needsLogin: false, loginUser: true };
        ONB.data = await api.get('/api/onboarding');
        ONB.steps = onbSteps(); // now with the server's data
        toast(t('Account {user} created.', { user: r.user }));
        return true;
      } };
    const password = { id: 'password', skip: true,
      render(el) {
        const ch = d().passwordChanged;
        el.innerHTML = hero(LOCK, true) +
          `<h1 id="onbTitle">${t('Choose your own password')}</h1>
          <p class="lead">${ch ? t('You already have your own password (since {date}). Only fill this in if you want to change it.', { date: esc(longDate(ch)) })
            : t('The installation gave you a random password. Choose one you can remember now, or keep it in your password manager.')}</p>` +
          (pwOn ? `<form class="form" data-onb-form>${passwordFields(t('Current password (from the installation)'))}
            ${S.config.demo ? `<p class="muted small">${t('Demo: the current password is {pw}. Signing in keeps working with demo.', { pw: '<b>demo</b>' })}</p>` : ''}
            <p class="form-error onb-err" role="alert"></p></form>`
            : `<p class="muted">${t('HomeBaseOS runs without a password.')}</p>`);
        if (pwOn) wirePasswordMeter(el);
      },
      async next(el) {
        if (!pwOn) return true;
        const val = (n) => $(`input[name="${n}"]`, el).value;
        if (!val('current') && !val('password') && !val('repeat')) {
          if (d().passwordChanged) return true;
          throw new Error(t('Enter a new password, or click Skip.'));
        }
        const r = await submitPassword(el);
        d().passwordChanged = r.changed;
        toast(t('Your new password is set. Other browsers were signed out.'));
        return true;
      } };
    // Whoever has an account (created now or earlier) sees that step; older installs choose an own password.
    const second = ONB.setup || (d() && d().user) ? account : password;
    return [
      { id: 'welcome',
        render(el) {
          el.innerHTML = hero(HOUSE) + `<h1 id="onbTitle">${t('Welcome to HomeBaseOS')}</h1>
            <p class="lead">${ONB.setup ? t('In a few steps your server is ready: an account, a name, storage and extra security. You can change everything later in Settings.')
              : t('In a few steps your server is ready: your own password, a name, storage and extra security. You can change everything later in Settings.')}</p>
            <h2 class="pane-title">${t('Language')}</h2>
            <div class="choice-row" role="radiogroup" aria-label="${t('Language')}">${Object.entries(LANGS).map(([k, name]) => `
              <label class="choice"><input type="radio" name="lang" value="${k}"${k === LANG ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}</div>
            <h2 class="pane-title">${t('Theme')}</h2>
            <div class="choice-row" role="radiogroup" aria-label="${t('Theme')}">${[['auto', t('Automatic')], ['light', t('Light (morning mist)')], ['dark', t('Dark (evening)')]].map(([k, name]) => `
              <label class="choice"><input type="radio" name="theme" value="${k}"${k === themeNow() ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}</div>`;
          el.onchange = (e) => { if (e.target.name === 'theme') setTheme(e.target.value); };
        },
        async next(el) {
          const lang = $('input[name="lang"]:checked', el).value;
          if (lang === LANG) return true;
          // Without an account it is not on the server yet: the language goes along when the account is created.
          if (!ONB.setup) await api.post('/api/settings', { language: lang });
          setLang(lang);
          try { sessionStorage.setItem('tb-onb-step', '1'); } catch (e) { /* private window */ }
          location.reload(); // rebuild everything in the new language; the wizard continues at step 2
          return false;
        },
        focus: false },
      second,
      { id: 'server', skip: true,
        async render(el) {
          el.innerHTML = `<p class="lead">${t('Loading…')}</p>`;
          let dt;
          try { dt = await api.get('/api/datetime'); } catch (e) { dt = { timezones: [d().timezone], timezone: d().timezone }; }
          if (!el.isConnected) return;
          const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const suggest = /^(Etc\/)?UTC$/.test(d().timezone) && dt.timezones.includes(browserTz) ? browserTz : null;
          el.innerHTML = hero('<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>', true) +
            `<h1 id="onbTitle">${t('Your server')}</h1>
            <p class="lead">${t('Give your server a name and choose the time zone. Apps from the app store get the same time zone.')}</p>
            <form class="form" data-onb-form>
              <label class="fld"><span>${t('Server name')}</span>
                <input class="field" name="hostname" value="${esc(d().hostname)}" spellcheck="false" autocomplete="off" maxlength="63">
                <span class="muted small">${t('Lowercase letters, digits and -. This is how you find it on your network, e.g. {name}.local.', { name: esc(d().hostname) })}</span></label>
              <label class="fld"><span>${t('Time zone')}</span>
                <select class="field" name="timezone">${zoneOptions(dt.timezones, suggest || d().timezone)}</select>
                ${suggest ? `<span class="muted small">${t('Suggested based on this computer.')}</span>` : ''}</label>
              <p class="form-error onb-err" role="alert"></p></form>`;
          const hn = $('input[name="hostname"]', el);
          hn.oninput = () => { $('.fld .muted', el).textContent = t('Lowercase letters, digits and -. This is how you find it on your network, e.g. {name}.local.', { name: hn.value.trim().toLowerCase() || '…' }); };
        },
        async next(el) {
          const hn = $('input[name="hostname"]', el), tz = $('select[name="timezone"]', el);
          if (!hn) return true; // still loading
          const name = hn.value.trim().toLowerCase();
          if (name !== d().hostname) { const r = await api.post('/api/network/hostname', { hostname: name }); d().hostname = r.hostname; loadOverview().catch(() => {}); }
          if (tz.value !== d().timezone) { await api.post('/api/datetime', { timezone: tz.value }); d().timezone = tz.value; }
          return true;
        } },
      { id: 'storage', skip: true,
        render(el) {
          const pools = d().pools, free = d().freeDisks;
          ONB.pool = null;
          el.innerHTML = hero('<svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>', true) +
            `<h1 id="onbTitle">${t('Storage')}</h1>
            <p class="lead">${pools.length ? t('HomeBaseOS found these storage pools. Your apps, VMs and shared folders go there.')
              : t('A pool combines your disks into one large, protected storage (ZFS). Your apps, VMs and shared folders go there. Tick the disks and click Create pool, or skip this step.')}</p>
            ${pools.length ? `<ul class="onb-list">${pools.map((x) => `<li><span class="ok-mark">✓</span><span class="grow"><b>${esc(x.name)}</b></span>
              <span class="muted small">${x.total ? esc(bytes(x.total)) : ''}</span><span class="pill ${x.health === 'ONLINE' ? 'ok' : 'warn'}">${esc(tr(x.health || ''))}</span></li>`).join('')}</ul>
              ${d().appdata ? `<p class="muted small">${t('App data: {dir}', { dir: `<code>${esc(d().appdata)}</code>` })}</p>` : ''}` : ''}
            ${free.length ? (pools.length ? `<div class="btn-row" data-onb-more><button class="btn" type="button" data-onb-pool>${t('Create another pool')}</button></div>` : '') +
                `<div class="onb-pool" data-onb-poolbox${pools.length ? ' hidden' : ''}><p class="muted">${t('Looking for disks…')}</p></div>`
              : `<p class="muted small">${pools.length ? t('There are no free disks left.') : t('HomeBaseOS found no free disks. Insert one and open Storage again later.')}</p>`}`;
          const box = $('[data-onb-poolbox]', el);
          if (!box) return;
          const mount = async () => {
            let o;
            try { o = await api.get('/api/pools/options'); } catch (e) { box.innerHTML = `<p class="muted">${t('The disks could not be read: {error}', { error: esc(e.message) })}</p>`; return; }
            if (!el.isConnected) return;
            box.innerHTML = (pools.length ? `<h2 class="pane-title">${t('Create another pool')}</h2>` : '') + '<div></div>';
            ONB.pool = poolForm(box.lastElementChild, o, null, {
              inline: true,
              onPick: (any) => { $('#onbNext').textContent = any ? t('Create pool') : t('Next'); },
              onCreated: async () => {
                try { ONB.data = await api.get('/api/onboarding'); } catch (e) { /* show what we know */ }
                if (ONB.steps[ONB.i] && ONB.steps[ONB.i].id === 'storage') onbRender();
              },
            });
          };
          if (!pools.length) mount();
          el.onclick = (e) => {
            if (!e.target.closest('[data-onb-pool]')) return;
            $('[data-onb-more]', el).hidden = true; box.hidden = false; mount();
          };
        },
        // Disks ticked? Then Next creates the pool (and the step stays to show the result).
        async next() {
          if (ONB.pool && ONB.pool.picked()) { await ONB.pool.submit(); return false; }
          return true;
        },
        focus: false },
      { id: 'security', skip: true,
        render(el) {
          el.innerHTML = hero('<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>', true) +
            `<h1 id="onbTitle">${t('Two-step verification')}</h1>
            <p class="lead">${t('When signing in, HomeBaseOS then also asks for a code from an app on your phone. Someone who only knows your password can\'t get in. Recommended, especially if you use HomeBaseOS from outside your home.')}</p>
            <div id="onbMfa"><p class="muted">${t('Loading…')}</p></div>`;
          const box = $('#onbMfa', el); box.dataset.noHead = '1';
          mfaSection(box);
        },
        focus: false },
      { id: 'done', nextLabel: t('Go to the dashboard'),
        async render(el) {
          try { ONB.data = await api.get('/api/onboarding'); } catch (e) { /* show what we know */ }
          if (!el.isConnected) return;
          const row = (ok, label, value) => `<li><span class="${ok ? 'ok-mark' : 'no-mark'}">${ok ? '✓' : '–'}</span><span class="grow">${esc(label)}</span><span class="muted small">${esc(value)}</span></li>`;
          el.innerHTML = hero('<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>', true) +
            `<h1 id="onbTitle">${t('Done!')}</h1>
            <p class="lead">${t('HomeBaseOS is ready to use. This is what\'s set up:')}</p>
            <ul class="onb-list">
              ${d().user ? row(true, t('Account'), d().user) : row(!!d().passwordChanged, t('Password'), d().passwordChanged ? t('Own password') : t('Still the one from the installation'))}
              ${row(true, t('Server name'), d().hostname)}
              ${row(true, t('Time zone'), d().timezone.replace(/_/g, ' '))}
              ${row(d().pools.length > 0, t('Storage'), d().pools.length ? d().pools.map((x) => x.name).join(', ') : t('No pool yet'))}
              ${row(!!d().appdata, t('App data'), d().appdata || t('No place yet'))}
              ${row(d().mfa, t('Two-step verification'), d().mfa ? t('On') : t('Off'))}
            </ul>
            <h2 class="pane-title">${t('What\'s next?')}</h2>
            <div class="onb-next-links">
              <button type="button" data-onb-go="store"><b>${t('App store')}</b><span>${t('Install your first apps.')}</span></button>
              <button type="button" data-onb-go="vms"><b>${t('VMs')}</b><span>${t('E.g. Home Assistant OS.')}</span></button>
              <button type="button" data-onb-go="shares"><b>${t('Shared folders')}</b><span>${t('Share files with your computers.')}</span></button>
            </div>`;
          el.onclick = async (e) => {
            const b = e.target.closest('[data-onb-go]'); if (!b) return;
            await onbFinish(false);
            ({ store: () => { location.hash = 'store'; }, vms: () => { location.hash = 'vms'; }, shares: sharesWindow })[b.dataset.onbGo]();
          };
        },
        next: async () => { await onbFinish(false); return false; },
        focus: false },
    ];
  }
  async function openOnboarding(startAt = 0) {
    ONB.setup = !!S.config.setup;
    // Without an account the server reveals nothing yet: the data comes after the "account" step.
    if (ONB.setup) ONB.data = null;
    else { try { ONB.data = await api.get('/api/onboarding'); } catch (e) { toast(e.message, true); return; } }
    ONB.steps = onbSteps();
    let resume = null;
    try { resume = sessionStorage.getItem('tb-onb-step'); sessionStorage.removeItem('tb-onb-step'); } catch (e) { /* private window */ }
    ONB.i = Math.min(ONB.steps.length - 1, resume != null ? Number(resume) || 0 : startAt);
    if (ONB.setup) ONB.i = Math.min(ONB.i, 1); // the account first
    ONB.dir = 1;
    document.body.classList.add('onb-open'); // only the wizard, without the dashboard behind it
    if (!onbWin.open) onbWin.showModal();
    onbRender();
  }
  function onbRender() {
    const st = ONB.steps[ONB.i], body = $('#onbBody');
    $('#onbDots').innerHTML = ONB.steps.map((_, k) => `<li class="${k < ONB.i ? 'done' : k === ONB.i ? 'now' : ''}"></li>`).join('');
    $('#onbDots').setAttribute('aria-label', t('Step {n} of {total}', { n: ONB.i + 1, total: ONB.steps.length }));
    body.innerHTML = `<div class="onb-step${ONB.dir < 0 ? ' back' : ''}"></div>`;
    body.scrollTop = 0;
    const el = $('.onb-step', body);
    $('#onbBack').style.visibility = ONB.i === 0 ? 'hidden' : '';
    $('#onbSkip').hidden = !st.skip;
    $('#onbNext').textContent = st.nextLabel || t('Next');
    // Without an account you can't postpone the wizard: without an account you get in nowhere.
    $('#onbLater').hidden = ONB.i === ONB.steps.length - 1 || ONB.setup;
    Promise.resolve(st.render(el)).then(() => {
      const f = st.focus === false ? null : $('input:not([type=radio]):not([type=checkbox]), select', el);
      (f || $('#onbNext')).focus();
    });
  }
  async function onbGo(delta, run = true) {
    const st = ONB.steps[ONB.i], btn = $('#onbNext'), el = $('#onbBody .onb-step');
    if (delta > 0 && run && st.next) {
      btn.disabled = true;
      try { if ((await st.next(el)) === false) return; }
      catch (e) { const er = $('.onb-err', el); if (er) er.textContent = e.message; else toast(e.message, true); return; }
      finally { btn.disabled = false; }
    }
    const to = ONB.i + delta;
    if (to >= ONB.steps.length) { await onbFinish(false); return; }
    ONB.dir = delta; ONB.i = Math.max(0, to); onbRender();
  }
  async function onbFinish(skipped) {
    try { await api.post('/api/onboarding/finish', { skipped }); } catch (e) { toast(e.message, true); return; }
    S.config.onboarding = false;
    if (onbWin.open) onbWin.close();
    if (skipped) toast(t('You\'ll find the welcome wizard again in Settings → General.'));
    if (!timers.length) startDesk(); // the first time (account just created) the dashboard isn't ready yet
  }
  onbWin.addEventListener('close', () => document.body.classList.remove('onb-open'));
  $('#onbNext').addEventListener('click', () => onbGo(1));
  $('#onbBack').addEventListener('click', () => onbGo(-1, false));
  $('#onbSkip').addEventListener('click', () => onbGo(1, false));
  $('#onbLater').addEventListener('click', () => onbFinish(true));
  onbWin.addEventListener('cancel', (e) => e.preventDefault()); // Escape doesn't close the wizard by accident
  // Enter in a field of the wizard = Next (not in the two-step verification forms).
  $('#onbBody').addEventListener('submit', (e) => { if (!e.target.closest('[data-onb-form]')) return; e.preventDefault(); onbGo(1); });

  function demoOnboarded() { try { return localStorage.getItem('tb-onboarded') === '1'; } catch (e) { return true; } }
  function demoClock() { try { return localStorage.getItem('tb-clock') || 'auto'; } catch (e) { return 'auto'; } }
  // The demo starts like a new server: first create an account (until the wizard has been finished once).
  function useDemo() {
    api = translatedApi(window.HomeBaseOSDemo);
    S.config = { demo: true, ollama: true, terminal: true, passwordEnabled: true, loginUser: true, clock: demoClock(), onboarding: !demoOnboarded(), setup: !demoOnboarded() };
    startDesk();
  }

  /* ------------------------------------------------------------ events */
  document.addEventListener('click', (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      const text = cp.dataset.copy;
      const ok = () => toast(t('Copied: {text}', { text }));
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, () => toast(t('Copying did not work in this browser.'), true));
      else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); const r = document.execCommand('copy'); ta.remove(); if (r) ok(); else toast(t('Copying did not work in this browser.'), true); }
      return;
    }
    const con = e.target.closest('[data-console]');
    if (con) { openConsole(con.dataset.console); return; }
    const ext = e.target.closest('a[target="_blank"]');
    if (ext && api !== realApi) {
      e.preventDefault();
      toast(t(ext.href.startsWith('vnc:') ? 'In the demo this opens the VM\'s screen on your own server.' : 'In the demo this opens the app on your own server.'));
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      ({ home: goHome, storage: storageWindow, shares: sharesWindow, backup: () => backupWindow(), vms: () => { location.hash = 'vms'; }, store: () => { location.hash = 'store'; }, ai: aiWindow })[open.dataset.open]();
      return;
    }
    const fo = e.target.closest('[data-folder-open]');
    if (fo) { openFolder(fo.dataset.folderOpen); return; }
    if (S.arrange && e.target.closest('#appGrid, #folderGrid')) return; // arranging: clicking opens nothing
    // A left click opens the web interface (like in Unraid). No address or is the app off? Then the menu.
    const app = e.target.closest('[data-app]');
    if (app && !menu.contains(app)) {
      const a = S.apps.find((x) => x.id === app.dataset.app); if (!a) return;
      if (app.dataset.action === 'open' && updating(a)) return updateLogWindow(a);
      if (app.dataset.action === 'open' && appUrl(a)) return openAppUrl(a);
      const r = app.getBoundingClientRect();
      openAppMenu(a, app.dataset.action === 'menu' ? r.right - 8 : r.left + 8, r.bottom + 4, app);
    }
  });
  // Icon can't load → show the first letter on a coloured tile (apps, app store and windows).
  document.addEventListener('error', (e) => {
    const img = e.target; if (img.tagName !== 'IMG' || !(img.parentNode.classList.contains('app-icon') || img.parentNode.classList.contains('mini'))) return;
    const box = img.parentNode; box.style.background = box.dataset.color;
    img.replaceWith(document.createTextNode(box.dataset.letter || '?'));
  }, true);
  $('#appGrid').addEventListener('contextmenu', (e) => {
    const t = e.target.closest('[data-app]'); if (!t || S.arrange) return;
    const a = S.apps.find((x) => x.id === t.dataset.app); if (!a) return;
    e.preventDefault();
    openAppMenu(a, e.clientX, e.clientY, t);
  });
  $('#search').addEventListener('input', (e) => { S.search = e.target.value; renderApps(); });
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]'); if (!b) return;
    S.filter = b.dataset.filter;
    $$('#filters button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    renderApps();
  });
  $('#logoutBtn').addEventListener('click', async () => {
    await api.post('/api/logout').catch(() => {});
    if (S.config.demo) showLogin(); else location.reload(); // the demo shows the sign-in screen
  });

  /* --- sign-in: first the password, then (if it is on) a code from the authenticator app or a recovery code */
  const loginApi = () => (S.config && S.config.demo ? api : realApi);
  let mfaPending = null, mfaRecovery = false;
  function loginStep(step) {
    const two = step === 'mfa';
    $('#loginForm').hidden = two; $('#mfaForm').hidden = !two;
    $('#loginTitle').textContent = two ? t('Two-step verification') : t('Welcome back');
    $('#loginSub').textContent = two ? t('Type the 6-digit code from your authenticator app.') : t('Sign in to manage your server.');
    $('#loginError').textContent = ''; $('#mfaError').textContent = '';
    if (two) setRecoveryMode(false);
    else {
      mfaPending = null; $('#pw').value = '';
      const withUser = !!(S.config && S.config.loginUser);
      $('#userLabel').hidden = !withUser; $('#user').hidden = !withUser; $('#user').required = withUser;
      (withUser && !$('#user').value ? $('#user') : $('#pw')).focus();
    }
  }
  function setRecoveryMode(on) {
    mfaRecovery = on;
    const c = $('#mfaCode');
    c.value = ''; c.classList.toggle('recovery', on);
    c.inputMode = on ? 'text' : 'numeric'; c.maxLength = on ? 11 : 7; c.autocomplete = on ? 'off' : 'one-time-code';
    c.pattern = on ? '[A-Za-z0-9 \\-]*' : '[0-9 ]*'; c.placeholder = on ? 'xxxxx-xxxxx' : '';
    $('#mfaLabel').textContent = on ? t('Recovery code') : t('Code from your authenticator app');
    $('#loginSub').textContent = on ? t('Type one of the recovery codes you saved. Each code works only once.') : t('Type the 6-digit code from your authenticator app.');
    $('#mfaToggle').textContent = on ? t('Use the app') : t('Use a recovery code');
    $('#mfaError').textContent = '';
    c.focus();
  }
  function shake() { const c = $('.login-card'); c.classList.remove('login-shake'); void c.offsetWidth; c.classList.add('login-shake'); }
  function loggedIn(r) {
    if (r && r.recovery) toast(t('Signed in with a recovery code. You have {n} left.', { n: r.recoveryLeft }), r.recoveryLeft < 3);
    if (S.config.demo) { $('#pw').value = ''; startDesk(); } else boot();
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#loginError').textContent = '';
    const btn = $('#loginForm .login-go'); btn.disabled = true;
    try {
      const r = await loginApi().post('/api/login', { user: $('#user').value.trim(), password: $('#pw').value, remember: $('#remember').checked });
      if (r.mfa) { mfaPending = r.pending; loginStep('mfa'); } else loggedIn(r);
    } catch (err) { $('#loginError').textContent = err.message; shake(); $('#pw').select(); }
    finally { btn.disabled = false; }
  });
  $('#mfaForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#mfaForm .login-go'); if (btn.disabled) return;
    $('#mfaError').textContent = ''; btn.disabled = true;
    try { loggedIn(await loginApi().post('/api/login/mfa', { pending: mfaPending, code: $('#mfaCode').value, remember: $('#remember').checked })); }
    catch (err) {
      if (err.expired || (err.data && err.data.expired)) { loginStep('password'); $('#loginError').textContent = err.message; return; }
      $('#mfaError').textContent = err.message; shake(); $('#mfaCode').select();
    } finally { btn.disabled = false; }
  });
  // Six digits typed, pasted or filled in by the phone? Confirm right away.
  $('#mfaCode').addEventListener('input', (e) => {
    if (!mfaRecovery && /^\d{6}$/.test(e.target.value.replace(/\s/g, ''))) $('#mfaForm').requestSubmit();
  });
  $('#mfaToggle').addEventListener('click', () => setRecoveryMode(!mfaRecovery));
  $('#mfaBack').addEventListener('click', () => loginStep('password'));
  $('#pwShow').addEventListener('click', (e) => {
    const b = e.currentTarget, show = $('#pw').type === 'password';
    $('#pw').type = show ? 'text' : 'password'; b.setAttribute('aria-pressed', String(show));
    const label = show ? t('Hide password') : t('Show password');
    b.setAttribute('aria-label', label); b.title = label;
    $('#pw').focus();
  });

  /* stars for the evening sky */
  (function stars() {
    const g = $('.wallpaper .stars'); let s = 7; const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    let html = '';
    for (let i = 0; i < 90; i++) html += `<circle cx="${(r() * 1600).toFixed(0)}" cy="${(r() * 560).toFixed(0)}" r="${(r() * 1.3 + .3).toFixed(2)}" opacity="${(r() * .7 + .2).toFixed(2)}"/>`;
    g.innerHTML = html;
  })();

  /* ------------------------------------------------------------ start */
  async function boot() {
    if (window.HOMEBASEOS_FORCE_DEMO) return useDemo();
    let cfg;
    try { cfg = await realApi.get('/api/config'); } catch (e) { return useDemo(); } // no server: static demo
    S.config = cfg;
    if (cfg.demo) return useDemo(); // in the demo the browser keeps the language itself
    // No account yet: only the welcome wizard (you choose the language there; the server's applies only afterwards).
    if (cfg.setup) { $('.topnav').hidden = true; return openOnboarding(0); }
    if (cfg.language && cfg.language !== LANG) setLang(cfg.language); // the server's language applies to everyone
    if (cfg.needsLogin) return showLogin();
    startDesk();
  }
  tickClock(); setInterval(tickClock, 1000 * 15);
  boot();
})();
