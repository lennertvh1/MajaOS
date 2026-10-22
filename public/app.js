/* HomeBaseOS — frontend */
(function () {
  'use strict';

  /* ------------------------------------------------------------ hulpjes */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------ taal */
  // De Nederlandse tekst is zelf de sleutel (zoals gettext). Andere talen staan in public/lang/<taal>.js.
  const LANGS = { nl: 'Nederlands', en: 'English' };
  const DICTS = { en: window.TB_LANG_EN || {} };
  const LOCALES = { nl: 'nl-BE', en: 'en-GB' };
  let LANG = 'nl', LOCALE = 'nl-BE';
  let nf = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
  let nf0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
  const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : String(s));
  function t(s, vars) { const d = DICTS[LANG]; return fill(d && d[s] != null ? d[s] : s, vars); }
  // Meldingen van de server zijn altijd Nederlands: herken ze aan een sjabloon uit het woordenboek en vul de waarden in.
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
      }).sort((a, b) => b.re.source.length - a.re.source.length); // het meest specifieke sjabloon eerst
    }
    for (const p of patterns) {
      const hit = m.match(p.re);
      if (hit) return fill(p.out, Object.fromEntries(p.names.map((n, i) => [n, tr(hit[i + 1])])));
    }
    return m;
  }
  // Vaste tekst uit index.html: één keer verzamelen, bij elke taalwissel opnieuw invullen.
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
    LANG = LANGS[l] ? l : 'nl'; LOCALE = LOCALES[LANG]; patterns = null;
    nf = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
    nf0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
    document.documentElement.lang = LANG;
    STATIC.forEach((s) => { if (s.n) s.n.nodeValue = s.lead + t(s.key) + s.trail; else s.el.setAttribute(s.attr, t(s.key)); });
    try { localStorage.setItem('tb-lang', LANG); } catch (e) { /* privévenster */ }
  }
  try { setLang(localStorage.getItem('tb-lang') || 'nl'); } catch (e) { setLang('nl'); }

  // Thema per toestel: automatisch (volgt het systeem), licht of donker.
  function setTheme(v) {
    if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('tb-theme', v || 'auto'); } catch (e) { /* privévenster */ }
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
    if (d) return t(d === 1 ? '{d} dag {h} u' : '{d} dagen {h} u', { d, h });
    if (h) return t('{h} u {m} min', { h, m });
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
      if (!res.ok) { const e = new Error(tr(data.error) || t('Fout {status}', { status: res.status })); e.status = res.status; e.data = data; throw e; }
      return data;
    },
    get(p) { return this.req('GET', p); },
    post(p, b) { return this.req('POST', p, b || {}); },
    del(p) { return this.req('DELETE', p); },
    async stream(path, body, onLine) {
      const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw new Error(tr(d.error) || t('Fout {status}', { status: res.status })); }
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
  // De demo gooit dezelfde (Nederlandse) meldingen als de server: die ook vertalen.
  function translatedApi(src) {
    const wrap = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { e.message = tr(e.message); throw e; } };
    return { get: wrap(src.get), post: wrap(src.post), del: wrap(src.del), stream: wrap(src.stream) };
  }

  /* ------------------------------------------------------------ toestand */
  const S = { overview: null, apps: [], vms: [], ai: null, aiError: null, filter: 'all', search: '', config: {},
    vmsLoaded: false, vmError: null, vmFilter: 'all', vmSearch: '', vmBusy: {},
    store: null, storeQuery: '', storeCat: 'featured', storeShown: 48, appBusy: {},
    layout: { items: [] }, arrange: false, folder: null };

  /* ------------------------------------------------------------ meldingen */
  function toast(msg, bad) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), bad ? 6000 : 3200);
  }

  /* ------------------------------------------------------------ klok */
  // Tijdnotatie uit Instellingen > Algemeen: 'auto' (volgens de taal), '24' of '12'.
  function clockOpts(c = S.config && S.config.clock) { return c === '24' ? { hourCycle: 'h23' } : c === '12' ? { hourCycle: 'h12', hour: 'numeric' } : {}; }
  function tickClock() {
    const now = new Date();
    $('#clock').textContent = now.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', ...clockOpts() });
    const d = now.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
    $('#date').textContent = d.charAt(0).toUpperCase() + d.slice(1);
    const h = now.getHours();
    $('#greeting').textContent = t(h < 6 ? 'Goedenacht' : h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond');
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
    $('#uptime').textContent = o.uptime != null ? t('Aan sinds {time}', { time: duration(o.uptime) }) : '';
    const facts = [];
    if (o.cpu && o.cpu.brand) facts.push([t('Processor'), o.cpu.brand.replace(/\s+\d+-Core Processor/i, '').replace(/\(R\)|\(TM\)/g, '')]);
    if (o.memory) facts.push([t('Geheugen'), t('{used} van {total}', { used: bytes(o.memory.used), total: bytes(o.memory.total) })]);
    if (g) facts.push(['GPU', g.name.replace(/^NVIDIA (GeForce )?/, '') + (g.temp != null ? ' · ' + g.temp + ' °C' : '')]);
    if (o.version) facts.push([t('Systeem'), o.version.replace(' GNU/Linux', '')]);
    $('#sysFacts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('');

    const s = o.storage;
    const st = $('#arrayState');
    if (!s || !s.pools) {
      $('#storeFree').textContent = '–'; $('#storeBar').style.width = '0';
      $('#storeLine').textContent = t(s ? 'Nog geen ZFS-pool. Maak er een aan (zie README).' : 'ZFS is niet bereikbaar.');
      st.textContent = ''; st.className = 'pill'; return;
    }
    const pct = s.total ? (s.used / s.total) * 100 : 0;
    $('#storeFree').textContent = bytes(s.free);
    $('#storeFreeLabel').textContent = t('vrij');
    const bar = $('#storeBar'); bar.style.width = pct.toFixed(1) + '%'; bar.className = level(pct, 80, 92);
    $('#storeLine').textContent = t(s.pools > 1 ? '{used} van {total} gebruikt in {n} pools' : '{used} van {total} gebruikt', { used: bytes(s.used), total: bytes(s.total), n: s.pools });
    const [label, cls] = poolHealth(s.health);
    st.textContent = label; st.className = 'pill ' + cls;
  }
  function poolHealth(h) {
    if (h === 'ONLINE') return [t('Gezond'), 'ok'];
    if (h === 'DEGRADED') return [t('Aangetast'), 'warn'];
    return [h ? t('Probleem: {state}', { state: h.toLowerCase() }) : t('Onbekend'), 'bad'];
  }

  function renderAiWidget() {
    const st = $('#aiState');
    if (S.aiError) {
      $('#aiLine').textContent = t(!S.config.ollama ? 'Ollama niet ingesteld' : S.aiDown ? 'Ollama is niet geïnstalleerd' : 'Ollama niet bereikbaar');
      $('#aiSub').textContent = !S.config.ollama ? t('Zet OLLAMA_URL in /etc/homebaseos/homebaseos.env.') : S.aiDown ? t('Installeer Ollama uit de appstore om lokaal AI-modellen te draaien.') : S.aiError;
      st.textContent = S.aiDown ? t('Niet actief') : ''; st.className = 'pill'; return;
    }
    const ai = S.ai; if (!ai) return;
    const loaded = ai.models.filter((m) => m.loaded);
    $('#aiLine').textContent = loaded.length ? loaded.map((m) => m.name).join(', ') : t('Geen model geladen');
    const g = ai.gpu && ai.gpu[0];
    $('#aiSub').textContent = t(ai.models.length === 1 ? '{n} model geïnstalleerd' : '{n} modellen geïnstalleerd', { n: ai.models.length }) +
      (g ? ' · ' + t('{used} van {total} VRAM', { used: bytes(g.memUsed), total: bytes(g.memTotal) }) : '');
    st.textContent = t(loaded.length ? 'Klaar' : 'Inactief'); st.className = 'pill ' + (loaded.length ? 'ok' : '');
  }

  function vmStateText(s) {
    const k = ({ RUNNING: 'Draait', SHUTOFF: 'Uit', SHUTDOWN: 'Sluit af', PAUSED: 'Gepauzeerd', CRASHED: 'Gecrasht', IDLE: 'Inactief',
      PMSUSPENDED: 'Slaapstand', NOSTATE: 'Onbekend' })[String(s).toUpperCase()];
    return k ? t(k) : s;
  }
  function renderVmWidget() {
    const ul = $('#vmMini');
    const running = S.vms.filter((v) => vmKind(v.state) === 'on').length;
    $('#vmWidgetCount').textContent = S.vms.length ? t('{n} van {total} actief', { n: running, total: S.vms.length }) : '';
    if (!S.vms.length) {
      ul.innerHTML = `<li class="muted small">${S.vmError ? t('VM\'s niet beschikbaar: {error}', { error: esc(S.vmError) }) : t('Nog geen virtuele machines')}</li>`;
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
  function iconHtml(a) {
    const dot = `<span class="dot ${isRunning(a) ? 'on' : ''}" aria-hidden="true"></span>` +
      (a.update ? '<span class="upd-badge" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 19V6M6 11l6-6 6 6"/></svg></span>' : '');
    if (a.icon) return `<span class="app-icon" data-letter="${esc(a.name.charAt(0).toUpperCase())}" data-color="${colorFor(a.name)}"><img src="${esc(a.icon)}" alt="" loading="lazy" draggable="false">${dot}</span>`;
    return `<span class="app-icon" style="background:${colorFor(a.name)}">${esc(a.name.charAt(0).toUpperCase())}${dot}</span>`;
  }

  function renderApps() {
    if (drag && drag.started) return; // niet opnieuw tekenen tijdens het slepen (en het landen)
    const q = S.search.trim().toLowerCase();
    const list = S.apps.filter((a) => {
      if (q && !(a.name.toLowerCase().includes(q) || (a.image || '').toLowerCase().includes(q))) return false;
      if (S.filter === 'running') return isRunning(a);
      if (S.filter === 'stopped') return !isRunning(a);
      if (S.filter === 'update') return !!a.update;
      return true;
    });
    // Het filter Updates heeft pas zin als de server updates kan melden.
    const updBtn = $('#filters [data-filter="update"]');
    updBtn.hidden = !S.apps.some((a) => a.update);
    if (updBtn.hidden && S.filter === 'update') { S.filter = 'all'; $$('#filters button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.filter === 'all'))); return renderApps(); }
    const running = S.apps.filter(isRunning).length;
    $('#appCount').textContent = S.apps.length ? t('{n} van {total} actief', { n: running, total: S.apps.length }) : '';
    renderUpdateInfo();
    const grid = $('#appGrid');
    if (!list.length) {
      grid.innerHTML = `<p class="empty">${t(S.apps.length ? 'Geen apps die hierbij passen.' : 'Nog geen containers gevonden.')}</p>`;
      return;
    }
    // Zoeken of filteren: een gewone lijst. Anders de eigen indeling met mappen.
    const flat = !!q || S.filter !== 'all';
    $('#arrangeBtn').disabled = flat;
    $('#arrangeBtn').title = flat ? t('Wis de zoekopdracht en kies Alle om te rangschikken.') : '';
    if (flat && S.arrange) setArrange(false);
    grid.classList.toggle('arranging', S.arrange);
    grid.innerHTML = flat ? list.map(appTile).join('') : homeItems().map((it) => (typeof it === 'string' ? appTile(appByName(it)) : folderTile(it))).join('');
    if (S.folder) renderFolder();
  }
  function appTile(a) {
    const label = prettyName(a.name);
    const busy = S.appBusy[a.id];
    const state = busy ? t(APP_ACTS[busy].noun).toLowerCase() + '…' : t(a.update ? 'update beschikbaar' : isRunning(a) ? 'actief' : 'gestopt');
    const hint = t(appUrl(a) ? 'klik om te openen' : 'klik voor het menu');
    return `<div class="app ${isRunning(a) ? '' : 'stopped'}${busy ? ' busy' : ''}" data-item="${esc(a.name)}">
        <button class="app-open" type="button" data-app="${esc(a.id)}" data-action="open" title="${esc(label)} – ${state}, ${hint}">
          ${iconHtml(a)}<span class="app-name">${esc(label)}</span>
        </button>
        <button class="app-more" type="button" data-app="${esc(a.id)}" data-action="menu" aria-haspopup="menu" aria-label="${esc(t('Menu van {name}', { name: label }))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
      </div>`;
  }
  // Map: een matglazen tegel met de pictogrammen van de eerste negen apps in een raster van 3 × 3, zoals op een iPad.
  function folderTile(f) {
    const apps = f.apps.map(appByName).filter(Boolean);
    const mini = apps.slice(0, 9).map((a) => (a.icon ? `<span class="mini" data-letter="${esc(a.name.charAt(0).toUpperCase())}" data-color="${colorFor(a.name)}"><img src="${esc(a.icon)}" alt="" draggable="false"></span>`
      : `<span class="mini" style="background:${colorFor(a.name)}">${esc(a.name.charAt(0).toUpperCase())}</span>`)).join('');
    const upd = apps.some((a) => a.update), on = apps.filter(isRunning).length;
    return `<div class="app folder" data-item="f:${esc(f.folder)}">
        <button class="app-open" type="button" data-folder-open="${esc(f.folder)}" title="${esc(t('{name} – map met {n} apps, {on} actief', { name: f.name, n: apps.length, on }))}">
          <span class="app-icon folder-icon">${mini}${upd ? '<span class="upd-badge" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 19V6M6 11l6-6 6 6"/></svg></span>' : ''}</span>
          <span class="app-name">${esc(f.name)}</span>
        </button>
      </div>`;
  }

  /* --- widgets op het dashboard: volgorde en verbergen (bewaard op de server, zoals de apps) */
  const WIDGET_NAMES = { clock: 'Klok', sys: 'Systeem', storage: 'Opslag', shares: 'Gedeelde mappen', ai: 'AI', vms: 'Virtuele machines' };
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
    edit.textContent = t(widgetEdit ? 'Klaar' : 'Widgets aanpassen');
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
      ctl.innerHTML = b('up', 'up', t('{name} naar boven', { name }), i === 0 ? ' disabled' : '') + b('down', 'down', t('{name} naar beneden', { name }), i === list.length - 1 ? ' disabled' : '')
        + b('toggle', hid ? 'eyeOff' : 'eye', t(hid ? '{name} tonen' : '{name} verbergen', { name }), ` class="eye" aria-pressed="${!hid}"`);
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
  // Slepen: de widget schuift mee, de andere maken plaats.
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
      const ref = after ? target.nextElementSibling : target; // invoegen vóór ref
      if (ref === slot || slot.nextElementSibling === ref) return; // staat er al
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

  /* --- widget: gedeelde mappen */
  async function loadShares() {
    try { S.shares = await api.get('/api/shares'); S.sharesError = null; } catch (e) { S.sharesError = e.message; }
    renderSharesWidget();
  }
  function renderSharesWidget() {
    const ul = $('#shareMini'), pill = $('#shareConn'), d = S.shares;
    if (!d) { ul.innerHTML = `<li class="muted small">${S.sharesError ? esc(S.sharesError) : t('Laden…')}</li>`; pill.textContent = ''; return; }
    if (!d.installed) { ul.innerHTML = `<li class="muted small">${t('Samba is nog niet geïnstalleerd.')}</li>`; pill.textContent = ''; return; }
    const c = d.connections || { total: 0, perShare: {} };
    pill.textContent = c.total ? t('{n} verbonden', { n: c.total }) : (d.running ? t('Actief') : t('Uit'));
    pill.className = 'pill ' + (c.total || d.running ? 'ok' : 'warn');
    ul.innerHTML = d.shares.slice(0, 5).map((sh) => {
      const users = Object.keys(sh.users).length, n = c.perShare[sh.name] || 0;
      const side = n ? t('{n} verbonden', { n }) : [users ? t(users === 1 ? '{n} gebruiker' : '{n} gebruikers', { n: users }) : null, sh.guest ? t('gasten') : null].filter(Boolean).join(' · ');
      return `<li><span class="name">${esc(sh.name)}</span><span class="muted small">${esc(side)}</span></li>`;
    }).join('') + (d.shares.length > 5 ? `<li class="muted small">${t('en nog {n}', { n: d.shares.length - 5 })}</li>` : '')
      || `<li class="muted small">${t('Nog geen gedeelde mappen. Klik om er een te maken.')}</li>`;
  }

  /* --- startscherm: volgorde en mappen (zoals op een iPad) */
  const appByName = (n) => S.apps.find((a) => a.name === n);
  // De opgeslagen indeling, zonder verdwenen apps en met nieuwe apps achteraan.
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
  // Mappen met één app worden weer een gewone app; lege mappen verdwijnen.
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
    layoutTimer = setTimeout(() => api.post('/api/layout', S.layout).catch((e) => toast(t('De indeling opslaan lukte niet: {error}', { error: e.message }), true)), 300);
  }
  async function loadLayout() {
    try { S.layout = await api.get('/api/layout'); } catch (e) { S.layout = { items: [] }; }
    renderApps(); applyWidgets();
  }
  const newFolderId = () => 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  const folderOf = (name) => S.layout.items.find((it) => typeof it !== 'string' && it.apps.includes(name)) || null;
  // Een app uit de indeling halen (thuis of uit een map). Geeft de nieuwe lijst terug.
  function without(items, name) {
    return items.filter((it) => it !== name).map((it) => (typeof it === 'string' ? it : { ...it, apps: it.apps.filter((n) => n !== name) }));
  }
  function moveToFolder(name, folderId, folderName) {
    let items = without(homeItems(), name);
    if (folderId) items = items.map((it) => (it.folder === folderId ? { ...it, apps: [...it.apps, name] } : it));
    else items.push({ folder: newFolderId(), name: folderName || t('Nieuwe map'), apps: [name] });
    setLayout(items);
  }
  function takeOutOfFolder(name) {
    const items = homeItems(), at = items.findIndex((it) => typeof it !== 'string' && it.apps.includes(name));
    if (at < 0) return;
    const next = without(items, name);
    next.splice(at + 1, 0, name); // net na de map
    setLayout(next);
  }

  // Rangschikken: iconen wiebelen, klikken opent niets, slepen verplaatst.
  function setArrange(on) {
    S.arrange = !!on;
    $('#arrangeBtn').setAttribute('aria-pressed', String(S.arrange));
    $('#arrangeBtn').textContent = t(S.arrange ? 'Klaar' : 'Rangschikken');
    $('#arrangeBtn').classList.toggle('primary', S.arrange);
    $('#appGrid').classList.toggle('arranging', S.arrange);
    $('#folderGrid').classList.toggle('arranging', S.arrange);
    renderFolderHint();
  }
  $('#arrangeBtn').addEventListener('click', () => setArrange(!S.arrange));

  /* map openen: een paneel boven het startscherm */
  const folderPanel = $('#folderPanel'), folderOverlay = $('#folderOverlay');
  function openFolder(id) {
    // Het paneel zoomt open vanuit de map-tegel.
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
    $('#folderHint').textContent = S.arrange ? t('Sleep een app naar buiten om ze uit de map te halen.') : t('Klik op de naam om de map te hernoemen.');
  }
  $('#folderClose').addEventListener('click', closeFolder);
  folderOverlay.addEventListener('click', () => { if (!drag) closeFolder(); });
  $('#folderName').addEventListener('change', (e) => {
    const name = e.target.value.trim().slice(0, 40) || t('Map');
    setLayout(homeItems().map((it) => (it.folder === S.folder ? { ...it, name } : it)));
  });
  $('#folderName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#folderUngroup').addEventListener('click', () => {
    const items = homeItems(), at = items.findIndex((it) => it.folder === S.folder);
    if (at < 0) return;
    items.splice(at, 1, ...items[at].apps); // de apps komen op de plaats van de map
    closeFolder(); setLayout(items);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.folder && menu.hidden) closeFolder(); });

  /* slepen (muis en touch), zoals op een iPad: de andere apps schuiven opzij; even boven een app houden maakt een map */
  let drag = null, pressTimer = null;
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // FLIP: na een wijziging in het raster schuiven de tegels vloeiend van hun oude naar hun nieuwe plaats.
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
  // Even laten opveren (in een map gezet) of laten verschijnen (nieuwe map).
  function bump(item, cls = 'bump') {
    const icon = $(`#appGrid [data-item="${CSS.escape(item)}"] .app-icon`); if (!icon || calm()) return;
    icon.classList.add(cls); icon.addEventListener('animationend', () => icon.classList.remove(cls), { once: true });
  }
  // Waar is de pointer? Midden van een app = map (alleen voor een app op het startscherm), elders op een tegel = verplaatsen.
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
  // De plaats van de app die je sleept (half doorzichtig) schuift naar de app waar je boven hangt; de rest schuift mee.
  function movePlaceholder(tile) {
    const grid = drag.el.parentNode, kids = [...grid.children], from = kids.indexOf(drag.el), to = kids.indexOf(tile);
    if (from < 0 || to < 0) return;
    flip(grid, () => grid.insertBefore(drag.el, to > from ? tile.nextSibling : tile));
    drag.moved = true; drag.hoverKey = ''; drag.restX = null;
  }
  // Pas reageren als je stilhoudt: wie er alleen overheen schuift (op weg naar het midden van een app), verplaatst niets.
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
    // Even wachten, zodat er niets verspringt als je er alleen over schuift.
    if (tg.mode === 'merge') { if (drag.merge !== tg.tile) drag.timer = setTimeout(() => setMerge(tg.tile), 280); }
    else { setMerge(null); drag.timer = setTimeout(() => movePlaceholder(tg.tile), 160); }
  }
  function onDragStart(e) {
    if (e.button > 0 || drag) return;
    const tile = e.target.closest('#appGrid [data-item], #folderGrid [data-item]');
    if (!tile || e.target.closest('.app-more')) return;
    const ctx = tile.closest('#folderGrid') ? 'folder' : 'home';
    if (!S.arrange) {
      // Lang indrukken (zoals op een iPad) zet Rangschikken aan.
      if ($('#arrangeBtn').disabled) return;
      const x0 = e.clientX, y0 = e.clientY;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { pressTimer = null; setArrange(true); ignoreNextClick(); }, 550);
      const cancel = (ev) => { if (ev.type !== 'pointermove' || Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) { clearTimeout(pressTimer); off(); } };
      const off = () => ['pointermove', 'pointerup', 'pointercancel'].forEach((t2) => document.removeEventListener(t2, cancel));
      ['pointermove', 'pointerup', 'pointercancel'].forEach((t2) => document.addEventListener(t2, cancel));
      return;
    }
    e.preventDefault(); // geen tekst selecteren of focus verspringen tijdens het slepen
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
      drag.dx = drag.x0 - r.left; drag.dy = drag.y0 - r.top; // waar je het pictogram vastnam
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
    ignoreNextClick(); // de klik na het loslaten mag niets openen
    folderOverlay.classList.remove('drop-out');
    // Het pictogram vliegt naar zijn plaats (of krimpt in de map); daarna pas de indeling bewaren.
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
        // Nieuwe map op de plaats van de app waarop je liet vallen.
        const id = newFolderId();
        setLayout(without(homeItems(), d.item).map((it) => (it === target ? { folder: id, name: t('Nieuwe map'), apps: [target, d.item] } : it)));
        bump('f:' + id, 'pop-in');
        setTimeout(() => { openFolder(id); const n = $('#folderName'); n.focus(); n.select(); }, calm() ? 0 : 260);
      });
      return;
    }
    if (d.out) { land(null, false, () => takeOutOfFolder(d.item)); return; }
    land(d.el.querySelector('.app-icon').getBoundingClientRect(), false, () => {
      if (!d.moved) return;
      // De volgorde zoals ze nu in het raster staat.
      const order = [...d.el.parentNode.children].map((x) => x.dataset.item).filter(Boolean);
      if (d.ctx === 'folder') setLayout(homeItems().map((it) => (it.folder === S.folder ? { ...it, apps: order } : it)));
      else { const by = new Map(homeItems().map((it) => [typeof it === 'string' ? it : 'f:' + it.folder, it])); setLayout(order.map((k) => by.get(k)).filter(Boolean)); }
    });
  }
  $('#appGrid').addEventListener('pointerdown', onDragStart);
  $('#folderGrid').addEventListener('pointerdown', onDragStart);
  // Het eigen slepen van de browser (afbeelding of link) breekt ons slepen af met pointercancel: altijd tegenhouden.
  ['#appGrid', '#folderGrid'].forEach((sel) => $(sel).addEventListener('dragstart', (e) => e.preventDefault()));
  // Na slepen of lang indrukken: de klik die volgt negeren.
  document.addEventListener('click', (e) => { if (suppressClick) { suppressClick = false; if (e.target.closest('#appGrid, #folderGrid')) { e.stopPropagation(); e.preventDefault(); } } }, true);
  $('#folderGrid').addEventListener('contextmenu', (e) => {
    const tg = e.target.closest('[data-app]'); if (!tg || S.arrange) return;
    const a = S.apps.find((x) => x.id === tg.dataset.app); if (!a) return;
    e.preventDefault();
    openAppMenu(a, e.clientX, e.clientY, tg);
  });

  // Naar map…: kies een bestaande map of maak een nieuwe.
  function folderPickWindow(a) {
    const folders = homeItems().filter((it) => typeof it !== 'string');
    const cur = folderOf(a.name);
    openWindow(t('{name} naar een map', { name: prettyName(a.name) }), `
      <ul class="rows">${folders.map((f) => `<li><div><div class="row-title">${esc(f.name)}</div><div class="row-sub">${esc(t('{n} apps', { n: f.apps.length }))}</div></div>
        <div class="row-side">${cur && cur.folder === f.folder ? `<span class="muted">${t('zit hier al')}</span>` : `<button class="btn sm" type="button" data-pick="${esc(f.folder)}">${t('Hierin')}</button>`}</div></li>`).join('')
        || `<li><span class="muted">${t('Nog geen mappen.')}</span></li>`}</ul>
      <form class="inline-form" id="newFolderForm" style="margin-top:14px">
        <input class="field" name="name" maxlength="40" placeholder="${t('Naam van een nieuwe map, bv. Media')}" aria-label="${t('Naam van een nieuwe map')}" autocomplete="off">
        <button class="btn primary" type="submit">${t('Nieuwe map')}</button>
      </form>`, (body) => {
      body.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) { moveToFolder(a.name, b.dataset.pick); win.close(); toast(t('{name} staat nu in de map.', { name: prettyName(a.name) })); } });
      $('#newFolderForm', body).addEventListener('submit', (e) => {
        e.preventDefault();
        moveToFolder(a.name, null, e.target.elements.name.value.trim().slice(0, 40)); win.close();
        toast(t('{name} staat nu in de map.', { name: prettyName(a.name) }));
      });
    });
  }

  // Onder de titel: hoeveel updates er zijn, met Bekijken, Alles bijwerken en Nu controleren.
  function renderUpdateInfo() {
    const el = $('#updInfo');
    const upd = S.apps.filter((a) => a.update);
    const canAll = upd.filter((a) => a.canUpdate && !S.appBusy[a.id]);
    const checked = Math.max(0, ...S.apps.map((a) => a.updateChecked || 0));
    const when = checked ? t('Laatst gecontroleerd: {when}', { when: new Date(checked).toLocaleString(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit', ...clockOpts() }) }) : t('Nog niet gecontroleerd');
    el.innerHTML = (upd.length
      ? `<button class="pill warn upd-pill" type="button" data-upd="show"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6 11l6-6 6 6"/></svg>${t(upd.length === 1 ? '{n} update' : '{n} updates', { n: upd.length })}</button>
         ${canAll.length ? `<button class="linkish" type="button" data-upd="all">${t('Alles bijwerken')}</button>` : ''}`
      : (checked ? `<span class="muted small">${t('Alles is up-to-date')}</span>` : ''))
      + `<button class="linkish" type="button" data-upd="check" title="${esc(when)}"${S.updChecking ? ' disabled' : ''}>${t(S.updChecking ? 'Controleren…' : 'Nu controleren')}</button>`;
  }
  async function checkUpdatesNow() {
    S.updChecking = true; renderUpdateInfo();
    try {
      const r = await api.post('/api/apps/check-updates');
      toast(r.updates ? t(r.updates === 1 ? '{n} app heeft een update.' : '{n} apps hebben een update.', { n: r.updates }) : t('Alle apps zijn up-to-date.'));
      if (r.errors && r.errors.length) toast(t('Niet gecontroleerd: {list}', { list: r.errors.map(tr).join('; ') }), true);
    } catch (e) { toast(t('Controleren op updates lukte niet: {error}', { error: e.message }), true); }
    S.updChecking = false;
    await loadApps().catch(() => renderApps());
  }
  async function updateAll() {
    const list = S.apps.filter((a) => a.update && a.canUpdate && !S.appBusy[a.id]);
    if (!list.length) return;
    if (!(await ask(t(list.length === 1 ? '{n} app bijwerken? {names}. Ze zijn elk even onbereikbaar terwijl ze opnieuw starten.'
      : '{n} apps bijwerken? {names}. Ze zijn elk even onbereikbaar terwijl ze opnieuw starten.', { n: list.length, names: list.map((a) => prettyName(a.name)).join(', ') }), t('Alles bijwerken')))) return;
    let ok = 0;
    for (const a of list) {
      S.appBusy[a.id] = 'update'; renderApps();
      try { await api.post(appPath(a, '/update')); ok++; } catch (e) { toast(t('Bijwerken van {name} lukte niet: {error}', { name: prettyName(a.name), error: e.message }), true); }
      delete S.appBusy[a.id];
    }
    toast(t('{n} van {total} bijgewerkt.', { n: ok, total: list.length }));
    await loadApps().catch(() => renderApps());
  }
  $('#updInfo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-upd]'); if (!b) return;
    if (b.dataset.upd === 'check') return checkUpdatesNow();
    if (b.dataset.upd === 'all') return updateAll();
    S.filter = 'update'; $$('#filters button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.filter === 'update'))); renderApps();
  });

  /* ------------------------------------------------------------ venster */
  const win = $('#win');
  let onWinClose = null;
  function openWindow(title, html, after) {
    win.classList.remove('win-wide'); // alleen het opslagvenster is breed (voor de kast met bays)
    if (onWinClose) { try { onWinClose(); } catch (e) { /* negeer */ } onWinClose = null; }
    $('#winTitle').textContent = title;
    // Nieuw element, zodat listeners van een vorig venster niet blijven hangen.
    const old = $('#winBody'), body = old.cloneNode(false);
    old.replaceWith(body);
    body.innerHTML = html;
    if (!win.open) win.showModal();
    if (after) after(body);
  }
  $('#winClose').addEventListener('click', () => win.close());
  // Een link naar Instellingen in een venster: het venster gaat dicht, Instellingen opent erboven.
  win.addEventListener('click', (e) => { if (e.target.closest('a[href^="#settings"]')) win.close(); });
  win.addEventListener('click', (e) => { if (e.target === win || e.target.closest('[data-close]')) win.close(); });
  // Het close-event komt asynchroon: is er intussen al een nieuw venster open, dan dat niet leegmaken.
  win.addEventListener('close', () => { if (onWinClose) { onWinClose(); onWinClose = null; } if (!win.open) $('#winBody').innerHTML = ''; });

  // Eigen bevestiging (werkt ook waar confirm() geblokkeerd is).
  // Met checkLabel komt er een vinkje bij en geeft ask() { checked } terug in plaats van true.
  function ask(text, yesLabel, checkLabel) {
    const d = $('#ask');
    $('#askText').textContent = text; $('#askYes').textContent = yesLabel || t('Doorgaan');
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

  /* --- apps: menu (rechtsklik of ⋯), acties, logboek, console en instellingen */
  const APP_ACTS = {
    start: { noun: 'Starten', done: 'Gestart' }, stop: { noun: 'Stoppen', done: 'Gestopt' },
    restart: { noun: 'Herstarten', done: 'Herstart' }, update: { noun: 'Bijwerken', done: 'Bijgewerkt' },
  };
  const appUrl = (a) => (isRunning(a) ? webuiUrl(a.webui) : null);
  const appPath = (a, suffix = '') => '/api/apps/' + encodeURIComponent(a.id) + suffix;

  function openAppUrl(a) {
    const url = appUrl(a); if (!url) return;
    if (api !== realApi) { toast(t('In de demo opent dit {name} op {url}', { name: prettyName(a.name), url: url.replace(location.hostname || 'localhost', t('je server')) })); return; }
    window.open(url, '_blank', 'noopener');
  }

  const MENU_ICONS = {
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    start: '<path d="M7 5l12 7-12 7z"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    restart: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>', update: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    logs: '<path d="M6 4h9l4 4v12H6zM9 12h7M9 16h7M9 8h3"/>', console: '<path d="M4 5h16v14H4zM7 10l3 2-3 2M12 15h5"/>',
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
      appUrl(a) && ['open', t('Openen')], '-',
      !run && ['start', t('Starten')], run && ['restart', t('Herstarten')], run && ['stop', t('Stoppen'), 'danger'],
      a.canUpdate && (a.update ? ['update', t('Bijwerken naar de nieuwe versie'), 'accent'] : ['update', t('Bijwerken')]),
      !a.canUpdate && a.update && ['update', t('Bijwerken kan alleen voor compose-apps'), 'off'], '-',
      ['logs', t('Logboek')], run && ['console', t('Console')], ['settings', t('Instellingen')], '-',
      ['tofolder', t('Naar map…')], folderOf(a.name) && ['outfolder', t('Uit map halen')],
      (a.storeId || a.custom) && '-', (a.storeId || a.custom) && ['remove', t('Verwijderen'), 'danger'],
    ].filter(Boolean).filter((it, i, arr) => it !== '-' || (i > 0 && arr[i - 1] !== '-' && i < arr.length - 1));
    menu.innerHTML = `<div class="menu-head"><b>${esc(prettyName(a.name))}</b><span>${esc(busy ? t(APP_ACTS[busy].noun) + '…' : a.status || a.state)}</span>
        ${a.update && !busy ? `<span class="menu-upd">${t('Er is een nieuwe versie')}</span>` : ''}</div>` +
      items.map((it) => (it === '-' ? '<hr>' : `<button type="button" role="menuitem" class="menu-item ${it[2] || ''}" data-menu="${it[0]}"
        ${(busy && APP_ACTS[it[0]]) || it[2] === 'off' ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${MENU_ICONS[it[0]]}</svg>${it[1]}</button>`)).join('');
    menu.dataset.forApp = a.id; // niet data-app: daarop reageert de klik-afhandeling van de tegels
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
    if (act === 'console') return consoleWindow(a);
    if (act === 'settings') return appSettingsWindow(a);
    if (act === 'remove') return removeApp(a);
    if (act === 'tofolder') return folderPickWindow(a);
    if (act === 'outfolder') { takeOutOfFolder(a.name); return; }
    if (act === 'stop' && !(await ask(t('{name} stoppen? Wat erop draait, is dan niet meer bereikbaar.', { name: label }), t('Stoppen')))) return;
    S.appBusy[a.id] = act; renderApps();
    try { await api.post(appPath(a, '/' + act)); toast(t(APP_ACTS[act].done) + ': ' + label); }
    catch (e) { toast(t('{action} van {name} lukte niet: {error}', { action: t(APP_ACTS[act].noun), name: label, error: e.message }), true); }
    delete S.appBusy[a.id];
    await loadApps().catch(() => renderApps());
  }

  async function removeApp(a) {
    const label = prettyName(a.name);
    const r = await ask(t('{name} verwijderen? De app wordt gestopt en verwijderd, samen met zijn compose-bestand.', { name: label }), t('Verwijderen'),
      a.dataDirs.length ? t('Ook de gegevens van de app wissen ({dirs})', { dirs: a.dataDirs.join(', ') }) : null);
    if (!r) return;
    S.appBusy[a.id] = 'stop'; renderApps();
    try {
      const res = await api.del(appPath(a) + (r.checked ? '?data=1' : ''));
      toast(t('Verwijderd: {name}', { name: label }) + (res.kept && res.kept.length ? '. ' + t('Deze mappen bleven staan: {list}', { list: res.kept.join(', ') }) : ''));
      if (S.store) { const s = S.store.apps.find((x) => x.id === a.storeId); if (s) s.installed = false; }
    } catch (e) { toast(t('Verwijderen van {name} lukte niet: {error}', { name: label, error: e.message }), true); }
    delete S.appBusy[a.id];
    await loadApps().catch(() => renderApps());
  }

  // Logboek: live volgen zolang het venster open is; alleen meescrollen als je onderaan stond.
  function logWindow(a) {
    openWindow(prettyName(a.name) + ' · ' + t('logboek'), `
      <div class="log-tools">
        <label class="check"><input type="checkbox" id="logFollow" checked> ${t('Live volgen')}</label>
        <select class="field" id="logTail" aria-label="${t('Aantal regels')}">${[100, 500, 2000].map((n) =>
          `<option value="${n}"${n === 500 ? ' selected' : ''}>${t('Laatste {n} regels', { n })}</option>`).join('')}</select>
        <button class="btn sm" type="button" id="logRefresh">${t('Vernieuwen')}</button>
      </div>
      <pre class="logs logs-big" id="logs" tabindex="0">${t('Laden…')}</pre>`, (body) => {
      const pre = $('#logs', body);
      let timer = null;
      const load = async () => {
        const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        try {
          const lines = await api.get(appPath(a, '/logs?tail=' + $('#logTail', body).value));
          pre.innerHTML = lines.length ? lines.map((l) => {
            const ts = l.timestamp ? new Date(l.timestamp).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', ...clockOpts() }) : '';
            return (ts ? `<span class="ts">${esc(ts)}</span>  ` : '') + esc(l.message);
          }).join('\n') : t('Nog geen logregels.');
          if (atEnd) pre.scrollTop = pre.scrollHeight;
        } catch (e) { pre.textContent = t('Het logboek kon niet geladen worden: {error}', { error: e.message }); }
      };
      const schedule = () => { clearTimeout(timer); if (body.isConnected && $('#logFollow', body).checked) timer = setTimeout(() => load().then(schedule), 3000); };
      load().then(() => { pre.scrollTop = pre.scrollHeight; schedule(); });
      $('#logFollow', body).addEventListener('change', schedule);
      $('#logTail', body).addEventListener('change', load);
      $('#logRefresh', body).addEventListener('click', load);
      onWinClose = () => clearTimeout(timer);
    });
  }

  // Console: elk commando draait apart met sh in de container. cd onthouden we zelf.
  function consoleWindow(a) {
    let cwd = '/';
    const hist = []; let hi = 0;
    openWindow(prettyName(a.name) + ' · ' + t('console'), `
      <pre class="logs console-out" id="conOut" aria-live="polite"></pre>
      <form class="console-line" id="conForm">
        <label class="console-prompt" for="conIn" id="conPrompt">/ $</label>
        <input class="console-input" id="conIn" autocomplete="off" autocapitalize="off" spellcheck="false">
      </form>
      <p class="muted small">${t('Elk commando draait apart in de app. Programma\'s die op je toetsenbord wachten (zoals top, vi of nano) werken hier niet. Pijltjes omhoog en omlaag halen vorige commando\'s terug. {clear} maakt het scherm leeg.', { clear: '<code>clear</code>' })}</p>`, (body) => {
      const out = $('#conOut', body), input = $('#conIn', body), prompt = $('#conPrompt', body);
      const print = (html) => { out.insertAdjacentHTML('beforeend', html); out.scrollTop = out.scrollHeight; };
      print(`<span class="muted">${t('Verbonden met {name} ({image}).', { name: esc(prettyName(a.name)), image: esc(a.image) })}</span>\n`);
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
          if (r.exitCode) print(`<span class="console-err">[${t('foutcode {code}', { code: r.exitCode })}]</span>\n`);
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
    openWindow(label + ' · ' + t('instellingen'), `<p class="lead">${t('Laden…')}</p>`);
    let s;
    try { s = await api.get(appPath(a, '/settings')); }
    catch (e) { $('#winBody').innerHTML = `<p class="lead">${t('De instellingen konden niet geladen worden: {error}', { error: esc(e.message) })}</p>`; return; }
    const ports = s.ports.length ? s.ports.map((p) => p.public + (p.public !== p.private ? ' → ' + p.private : '') + '/' + p.type.toLowerCase()).join(', ') : t('Geen');
    const c = s.compose;
    const body = $('#winBody');
    body.innerHTML = `
      <dl class="kv">
        <dt>${t('Status')}</dt><dd>${esc(a.status || a.state)}</dd>
        <dt>${t('Image')}</dt><dd>${esc(s.image)}</dd>
        <dt>${t('Versie')}</dt><dd>${a.update ? `<span class="temp-warn">${t('Er is een nieuwe versie')}</span>` + (a.canUpdate ? ' · ' + t('kies Bijwerken in het menu') : '')
          : a.update === false ? t('Up-to-date') : esc(a.updateError ? t('Onbekend: {reason}', { reason: tr(a.updateError) }) : t('Nog niet gecontroleerd'))}
          ${a.updateChecked ? `<span class="muted small"> · ${t('gecontroleerd {when}', { when: esc(new Date(a.updateChecked).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...clockOpts() })) })}</span>` : ''}</dd>
        <dt>${t('Poorten')}</dt><dd>${esc(ports)}</dd>
        ${c ? `<dt>${t('Compose-project')}</dt><dd>${esc(c.project)}</dd>` : ''}
      </dl>
      <form class="form" id="appSetForm" novalidate style="margin-top:16px">
        <label class="fld"><span>${t('Adres van de webinterface (WebUI)')}</span>
          <input class="field" name="webui" value="${esc(s.webui)}" placeholder="${esc(s.webuiDefault || s.webuiAuto || 'http://[IP]:[PORT:8080]/')}" autocomplete="off" spellcheck="false">
          <small>${t('Dit opent als je op de app klikt. {ip} wordt het adres van je server, {port} de poort op de server die aan poort 80 in de app hangt.', { ip: '<code>[IP]</code>', port: '<code>[PORT:80]</code>' })}
            ${t('Leeg laten = automatisch ({value}).', { value: esc(s.webuiDefault || s.webuiAuto || t('geen')) })}</small></label>
        <label class="fld"><span>${t('Pictogram')}</span>
          <input class="field" name="icon" value="${esc(s.icon)}" placeholder="${esc(s.iconDefault || 'https://…/logo.png')}" autocomplete="off" spellcheck="false">
          <small>${t('Adres van een afbeelding. Leeg laten = automatisch.')}</small></label>
        <label class="check"><input type="checkbox" name="autoStart"${s.autoStart ? ' checked' : ''}> ${t('Automatisch starten als de server opstart')}</label>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Opslaan')}</button><button class="btn" type="button" data-close>${t('Sluiten')}</button></div>
      </form>
      <h3>${t('Container')}</h3>
      ${!c ? `<p class="muted small">${t('Deze app is niet met Docker Compose gestart. Poorten, mappen en variabelen pas je dan aan door de container opnieuw te maken, bv. vanuit de appstore.')}</p>`
        : !c.editable ? `<p class="muted small">${c.files.length > 1 ? t('Dit project gebruikt meerdere bestanden ({files}). Pas het daar zelf aan.', { files: esc(c.files.join(', ')) })
          : t('Dit project gebruikt een bestand dat HomeBaseOS niet kan lezen. Pas het daar zelf aan.')}</p>`
        : `<p class="muted small">${esc(c.file)}${c.project !== a.name ? ' · ' + t('project {name}', { name: esc(c.project) }) : ''}</p>
          <div id="cfForm"${c.form ? '' : ' hidden'}></div>
          <div id="cfText"${c.form ? ' hidden' : ''}>
            ${c.form ? '' : `<p class="lead">${t('Het formulier is niet beschikbaar voor dit bestand. Je kan het wel als tekst aanpassen.')}${c.formError ? ' (' + esc(tr(c.formError)) + ')' : ''}</p>`}
            <textarea class="field code" id="composeText" rows="18" spellcheck="false" aria-label="${t('Compose-bestand')}">${esc(c.text)}</textarea>
          </div>
          <p class="form-error" id="composeErr" role="alert"></p>
          <div class="btn-row">
            <button class="btn primary" type="button" id="composeSave">${t('Opslaan en opnieuw starten')}</button>
            ${c.form ? `<button class="btn" type="button" id="cfToggle">${t('Als tekst bewerken')}</button>` : ''}
          </div>`}`;
    const form = $('#appSetForm', body);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form), btn = $('[type=submit]', form);
      err.textContent = ''; btn.disabled = true;
      try {
        await api.post(appPath(a, '/settings'), { webui: form.elements.webui.value, icon: form.elements.icon.value, autoStart: form.elements.autoStart.checked });
        toast(t('Opgeslagen: {name}', { name: label }));
        await loadApps().catch(() => {});
      } catch (ex) { err.textContent = t('Opslaan lukte niet: {error}', { error: ex.message }); }
      btn.disabled = false;
    });
    if (!c || !c.editable) return;

    // Formulier (zoals het containerformulier van Unraid) of tekst.
    const model = c.form ? JSON.parse(JSON.stringify(c.form)) : null;
    let mode = c.form ? 'form' : 'text';
    if (model) composeFormMount($('#cfForm', body), model, c.dockerNetworks || []);
    const toggle = $('#cfToggle', body);
    if (toggle) toggle.addEventListener('click', () => {
      mode = mode === 'form' ? 'text' : 'form';
      $('#cfForm', body).hidden = mode !== 'form'; $('#cfText', body).hidden = mode !== 'text';
      toggle.textContent = t(mode === 'form' ? 'Als tekst bewerken' : 'Terug naar het formulier');
      if (mode === 'form') toast(t('Het formulier toont de opgeslagen versie. Wijzigingen in de tekst sla je op in de tekstmodus.'));
    });
    const save = $('#composeSave', body);
    save.addEventListener('click', async () => {
      const err = $('#composeErr', body); err.textContent = '';
      if (mode === 'form') { const problem = composeFormCheck(model); if (problem) { err.textContent = problem; return; } }
      const who = c.project !== a.name ? t('het project {name}', { name: c.project }) : label;
      const note = mode === 'form' ? ' ' + t('Opmerkingen (#) in het bestand verdwijnen; de vorige versie blijft als .bak bewaard.') : '';
      if (!(await ask(t('Compose-bestand opslaan en {who} opnieuw starten?', { who }) + note, t('Opslaan en starten')))) return;
      save.disabled = true; save.textContent = t('Bezig…');
      try {
        const r = mode === 'form'
          ? await api.post(appPath(a, '/compose-form'), { form: model })
          : await api.post(appPath(a, '/compose'), { text: $('#composeText', body).value });
        toast(t('Opgeslagen en opnieuw gestart. De vorige versie staat in {file}.', { file: r.backup }));
        await loadApps().catch(() => {});
        const fresh = S.apps.find((x) => x.name === a.name) || a;
        return appSettingsWindow(fresh); // opnieuw laden: zo zie je wat er echt in het bestand staat
      } catch (ex) { err.textContent = ex.message; }
      save.disabled = false; save.textContent = t('Opslaan en opnieuw starten');
    });
  }

  /* --- compose-formulier: rijen voor poorten, mappen, variabelen, apparaten en labels */
  const CF_KINDS = [
    ['ports', 'Poorten', 'Poort', { host: '', container: '', protocol: 'tcp' }],
    ['volumes', 'Mappen', 'Map', { host: '', container: '', mode: 'rw' }],
    ['env', 'Variabelen', 'Variabele', { name: '', value: '' }],
    ['devices', 'Apparaten', 'Apparaat', { host: '', container: '' }],
    ['labels', 'Labels', 'Label', { name: '', value: '' }],
  ];
  const SECRET = /pass|secret|token|key|pwd/i;
  function cfRow(kind, r, i) {
    const del = `<button class="cf-del" type="button" data-cf-del="${kind}:${i}" aria-label="${t('Weghalen')}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    const inp = (k, ph, extra = '') => `<input class="field" data-cf="${kind}:${i}:${k}" value="${esc(r[k] == null ? '' : r[k])}" placeholder="${ph}" autocomplete="off" spellcheck="false"${extra}>`;
    if (r.locked) {
      const what = kind === 'ports' ? (r.host || '?') + ' → ' + r.container + '/' + r.protocol : (r.host || r.kind || '') + ' → ' + r.container;
      return `<div class="cf-row cf-locked"><span class="cf-lock" title="${t('Geavanceerde instelling: pas die aan in de tekstmodus')}">🔒</span>
        <span class="cf-text">${esc(what)} <span class="muted">· ${t('geavanceerd, alleen in de tekstmodus')}</span></span>${del}</div>`;
    }
    if (kind === 'ports') return `<div class="cf-row cf-pair">${inp('host', t('op de server'), ` inputmode="numeric" aria-label="${t('Poort op de server')}"`)}<span class="cf-sep">→</span>
      ${inp('container', t('in de app'), ` inputmode="numeric" aria-label="${t('Poort in de app')}"`)}
      <select class="field cf-small" data-cf="${kind}:${i}:protocol" aria-label="Protocol"><option${r.protocol !== 'udp' ? ' selected' : ''}>tcp</option><option${r.protocol === 'udp' ? ' selected' : ''}>udp</option></select>${del}</div>`;
    if (kind === 'volumes') return `<div class="cf-row cf-pair">${inp('host', t('map op de server, bv. /tank/media'), ` aria-label="${t('Map op de server')}"`)}<span class="cf-sep">→</span>
      ${inp('container', t('map in de app, bv. /media'), ` aria-label="${t('Map in de app')}"`)}
      <select class="field cf-small" data-cf="${kind}:${i}:mode" aria-label="${t('Toegang')}"><option value="rw"${r.mode !== 'ro' ? ' selected' : ''}>${t('lezen en schrijven')}</option><option value="ro"${r.mode === 'ro' ? ' selected' : ''}>${t('alleen lezen')}</option></select>${del}</div>`;
    if (kind === 'devices') return `<div class="cf-row cf-pair">${inp('host', t('op de server, bv. /dev/dri'), ` aria-label="${t('Apparaat op de server')}"`)}<span class="cf-sep">→</span>
      ${inp('container', t('in de app (leeg = hetzelfde)'), ` aria-label="${t('Apparaat in de app')}"`)}<span></span>${del}</div>`;
    const secret = kind === 'env' && SECRET.test(r.name);
    return `<div class="cf-row cf-kv">${inp('name', kind === 'env' ? t('NAAM') : t('naam'), ` aria-label="${t('Naam')}"`)}<span class="cf-sep">=</span>
      ${inp('value', t(r.unset ? '(doorgegeven van de server)' : 'waarde'), ` aria-label="${t('Waarde')}"${secret ? ' type="password"' : ''}`)}${del}</div>`;
  }
  // Keuzes voor het netwerk: standaard, host, geen, de netwerken uit het compose-bestand en de andere Docker-netwerken.
  function netChoices(f, dockerNets) {
    const out = [{ value: '', label: t('Standaard (bridge)') }, { value: 'host', label: t('Host (netwerk van de server)') }, { value: 'none', label: t('Geen') }];
    if (f.network === '*') out.unshift({ value: '*', label: t('Eigen netwerken ({list})', { list: f.networks.join(', ') }) });
    const pn = f.projectNetworks || [];
    pn.filter((x) => !x.external).forEach((x) => out.push({ value: x.key, label: t('{name} (uit dit compose-bestand)', { name: x.key }) }));
    dockerNets.filter((n) => !pn.some((x) => !x.external && x.name === n.name)).forEach((n) =>
      out.push({ value: n.name, label: [n.name, n.driver, n.subnet].filter(Boolean).join(' · ') }));
    if (f.network && !out.some((o) => o.value === f.network)) out.push({ value: f.network, label: f.network });
    return out;
  }
  function composeFormMount(el, f, dockerNets = []) {
    const draw = (focus) => {
      el.innerHTML = `
        <div class="form">
          <label class="fld"><span>${t('Image')}</span><input class="field" data-cf-top="image" value="${esc(f.image)}" placeholder="${t('bv. lscr.io/linuxserver/jellyfin:latest')}" spellcheck="false">
            <small>${t('Wil je een vaste versie? Zet ze achter de dubbele punt, bv. :10.10.7 in plaats van :latest.')}</small></label>
          <div class="fld-row">
            <label class="fld"><span>${t('Herstarten')}</span><select class="field" data-cf-top="restart">
              ${[['unless-stopped', 'Altijd, behalve als ik hem stop'], ['always', 'Altijd'], ['on-failure', 'Alleen na een fout'], ['no', 'Nooit'], ['', 'Niet ingesteld']]
                .map(([v, label]) => `<option value="${v}"${f.restart === v ? ' selected' : ''}>${t(label)}</option>`).join('')}</select></label>
            <label class="fld"><span>${t('Netwerk')}</span><select class="field" data-cf-top="network"${f.networkOther ? ' disabled' : ''}>
              ${netChoices(f, dockerNets).map((o) => `<option value="${esc(o.value)}"${f.network === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
              ${f.networkOther ? `<small>${t('Gebruikt {name}. Pas dat aan in de tekstmodus.', { name: esc(f.networkOther) })}</small>` : ''}</label>
          </div>
          ${f.networkOther ? '' : `<p class="muted small" style="margin-top:-6px">${t('Nieuwe netwerken maak je bij Instellingen → Docker-netwerken.')}</p>`}
          ${f.network === 'host' ? `<p class="lead small">${t('Met het host-netwerk luistert de app rechtstreeks op zijn eigen poorten en negeert Docker de poorten hieronder. Wil je zelf poorten kiezen, zet Netwerk dan op Standaard (bridge) en voeg ze toe met + Poort.')}</p>` : ''}
          ${['', 'host', 'none', '*'].includes(f.network) || f.networkOther ? '' : (() => {
            const n = dockerNets.find((x) => x.name === f.network), ownIp = n && /^(macvlan|ipvlan)$/.test(n.driver);
            return `<label class="fld"><span>${t('Vast IP-adres (optioneel)')}</span><input class="field" data-cf-top="ip" value="${esc(f.ip || '')}" spellcheck="false" autocomplete="off"
              placeholder="${esc(n && n.subnet ? n.subnet.replace(/\.\d+\/\d+$/, '.200') : '')}">
              <small>${ownIp ? t('Het adres van de app in je thuisnetwerk. Leeg = Docker kiest er een uit het IP-bereik van het netwerk.')
                : t('Leeg = Docker kiest zelf een adres. Een vast adres kan alleen in een netwerk met een eigen subnet.')}</small></label>`;
          })()}
          <label class="check"><input type="checkbox" data-cf-top="privileged"${f.privileged ? ' checked' : ''}> ${t('Privileged (bijna volledige toegang tot de server, alleen als de app het echt nodig heeft)')}</label>
          ${f.otherServices.length ? `<p class="muted small">${t('Dit bestand bevat ook: {list}. Die blijven ongewijzigd.', { list: esc(f.otherServices.join(', ')) })}</p>` : ''}
        </div>
        ${CF_KINDS.map(([kind, title]) => (f[kind].length ? `<h3>${t(title)}</h3><div class="cf-list">${f[kind].map((r, i) => cfRow(kind, r, i)).join('')}</div>` : '')).join('')}
        <div class="cf-add"><span class="muted small">${t('Toevoegen:')}</span>
          ${CF_KINDS.map(([kind, , one]) => `<button class="btn sm" type="button" data-cf-add="${kind}">+ ${t(one)}</button>`).join('')}</div>`;
      if (focus) { const x = $(`[data-cf^="${focus}:"]`, el); if (x) x.focus(); }
    };
    draw();
    el.addEventListener('input', (e) => {
      const tg = e.target;
      if (tg.dataset.cfTop) {
        f[tg.dataset.cfTop] = tg.type === 'checkbox' ? tg.checked : tg.value;
        if (tg.dataset.cfTop === 'network') { if (['', 'host', 'none'].includes(f.network)) f.ip = ''; draw(); }
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
  // Snelle controle in de browser; de server controleert alles nog eens.
  function composeFormCheck(f) {
    if (!f.image.trim() && !f.build) return t('Vul het image in.');
    if (f.ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(f.ip).trim())) return t('Het vaste IP-adres is geen geldig adres, bv. 192.168.1.200.');
    for (const p of f.ports) if (!p.locked && !/^\d{1,5}(-\d{1,5})?$/.test(String(p.container).trim())) return t('Vul bij elke poort de poort in de app in (een getal).');
    for (const v of f.volumes) if (!v.locked && (!String(v.host).trim() || !String(v.container).trim().startsWith('/'))) return t('Vul bij elke map beide kanten in; de map in de app begint met /.');
    for (const d of f.devices) if (!/^\/dev\//.test(String(d.host).trim())) return t('Een apparaat begint met /dev/, bv. /dev/dri.');
    for (const e of f.env) if (String(e.value).trim() && !String(e.name).trim()) return t('Een variabele heeft een naam nodig.');
    return null;
  }

  /* --- opslag */
  function scrubText(sc) {
    if (!sc || !sc.kind) return t('Nog geen controle (scrub) gedaan');
    if (sc.running) return t(sc.kind === 'resilver' ? 'Herstel loopt: {pct}%' : 'Controle (scrub) loopt: {pct}%', { pct: nf0.format(sc.progress || 0) });
    const when = sc.last ? new Date(sc.last).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    return sc.errors ? t('Laatste controle {when}: {n} fouten gevonden', { when, n: sc.errors }) : t('Laatste controle {when}: geen fouten', { when });
  }
  /* --- schijfbays: welke schijf in welke bay zit (slepen, of tikken en dan op een bay tikken) */
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
    // Een plaats is een bay ("3"), een M.2-sleuf ("m1") of een 2,5"-sleuf ("s1"), allemaal in cfg.slots.
    const slotName = (id) => { const k = String(id)[0], n = String(id).replace(/^[ms]/, '');
      return k === 'm' ? t('M.2-sleuf {n}', { n }) : k === 's' ? t('2,5"-sleuf {n}', { n }) : t('bay {n}', { n }); };
    let edit = false, picked = null, saveTimer = null;
    const byKey = new Map(s.disks.map((d) => [d.key, d]));
    const bayOf = (key) => Object.keys(cfg.slots).find((b) => cfg.slots[b].key === key);
    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try { cfg = await api.post('/api/bays', cfg); s.bays = cfg; }
        catch (e) { toast(t('De indeling opslaan lukte niet: {error}', { error: e.message }), true); }
      }, 300);
    };
    const place = (key, bay) => {
      const from = bayOf(key), occupant = cfg.slots[bay];
      if (from === String(bay)) return;
      if (from) { if (occupant) cfg.slots[from] = occupant; else delete cfg.slots[from]; } // wisselen met de schijf die er al zat
      const d = byKey.get(key);
      cfg.slots[bay] = { key, label: d ? diskLabel(d) : (occupant && occupant.key === key ? occupant.label : '') };
      picked = null; save(); draw();
    };
    const unplace = (key) => { const b = bayOf(key); if (b) { delete cfg.slots[b]; save(); } picked = null; draw(); };

    // Gekozen schijf (klik op een bay): details uit smartctl in het paneel naast de kast.
    let sel = null; // { key, name, info, loading, error }
    const hoursText = (h) => (h == null ? '–' : h >= 8766 ? t('{years} jaar ({hours} uur)', { years: nf.format(h / 8766), hours: nf0.format(h) })
      : h >= 48 ? t('{days} dagen ({hours} uur)', { days: nf0.format(h / 24), hours: nf0.format(h) }) : t('{hours} uur', { hours: nf0.format(h) }));
    const WATCH = [
      ['reallocated', 'Herplaatste sectoren', 'Plekken die de schijf heeft moeten vervangen. Loopt dit op, vervang dan de schijf.', 'warn'],
      ['pending', 'Wachtende sectoren', 'Plekken die niet gelezen konden worden. Een slecht teken.', 'bad'],
      ['uncorrectable', 'Onherstelbare sectoren', 'Gegevens die de schijf niet kon herstellen. ZFS vangt dit op met de andere schijven.', 'bad'],
      ['reportedUncorrect', 'Gemelde leesfouten', 'Leesfouten die de schijf zelf meldde.', 'warn'],
      ['crcErrors', 'CRC-fouten (kabel)', 'Meestal een slechte SATA-kabel of aansluiting, niet de schijf.', 'warn'],
      ['mediaErrors', 'Mediafouten', 'Fouten in het geheugen van de SSD.', 'bad'],
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
        box.innerHTML = `<h4>${esc(slotName(bayNo))}: ${t('schijf weg')}</h4><p class="small">${esc(slot ? slot.label : '')}</p>
          <p class="small muted">${t('Deze schijf zat in deze bay, maar de server vindt ze niet meer. Is ze kapot of losgekoppeld? Zet er een nieuwe in en sleep die naar deze bay.')}</p>`;
        return;
      }
      const head = `<div class="dp-head"><div><h4>${esc(d.name)}${bayNo ? ` <span class="muted">· ${esc(slotName(bayNo))}</span>` : ''}</h4>
          <p class="small muted">${esc([sel.info && sel.info.family, (sel.info && sel.info.model) || d.model].filter(Boolean).join(' · '))}</p></div>
          <button class="cf-del" type="button" data-dp-close aria-label="${t('Sluiten')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
      if (sel.loading) { box.innerHTML = head + `<p class="muted small">${t('SMART uitlezen…')}</p>`; return; }
      if (sel.error) { box.innerHTML = head + `<p class="small temp-bad">${esc(sel.error)}</p><button class="btn sm" type="button" data-dp-retry>${t('Opnieuw proberen')}</button>`; return; }
      const i = sel.info;
      if (i.sleeping) {
        box.innerHTML = head + `<p class="small">${t('De schijf slaapt om stroom te besparen. Uitlezen maakt ze wakker; daarna valt ze vanzelf weer in slaap.')}</p>
          <button class="btn sm" type="button" data-dp-wake>${t('Toch uitlezen')}</button>`;
        return;
      }
      const kind = d.transport === 'nvme' ? 'NVMe' : !d.rotational ? 'SSD' : i.rpm ? t('HDD, {rpm} toeren', { rpm: i.rpm }) : 'HDD';
      const tc = i.temp == null ? '' : i.temp >= 50 ? 'temp-bad' : i.temp >= 45 ? 'temp-warn' : 'temp-ok';
      const watch = WATCH.filter(([k]) => i.watch[k] != null && (i.watch[k] > 0 || ['reallocated', 'pending', 'uncorrectable', 'crcErrors', 'mediaErrors'].includes(k)))
        .map(([k, label, help, lvl]) => `<li title="${esc(t(help))}"><span>${t(label)}</span><b class="${i.watch[k] > 0 ? 'temp-' + lvl : 'temp-ok'}">${nf0.format(i.watch[k])}</b></li>`).join('');
      const nv = i.nvme;
      const nvRows = nv ? [
        [t('Slijtage'), nv.percentUsed != null ? nv.percentUsed + '%' : '–', nv.percentUsed >= 100 ? 'temp-bad' : nv.percentUsed >= 80 ? 'temp-warn' : 'temp-ok'],
        [t('Reserve'), nv.spare != null ? nv.spare + '%' : '–', nv.spare != null && nv.spareThreshold != null && nv.spare <= nv.spareThreshold ? 'temp-bad' : 'temp-ok'],
        [t('Geschreven'), nv.written != null ? bytes(nv.written) : '–', ''],
        [t('Onveilig uitgeschakeld'), nv.unsafeShutdowns != null ? nf0.format(nv.unsafeShutdowns) + '×' : '–', ''],
      ].map(([k, v, c]) => `<li><span>${k}</span><b class="${c}">${esc(v)}</b></li>`).join('') : '';
      const RES = { ok: 'geslaagd', failed: 'mislukt', aborted: 'afgebroken', interrupted: 'onderbroken', fatal: 'fout', running: 'loopt', unknown: 'onbekend' };
      const running = i.testRunning;
      box.innerHTML = head + `
        <div class="dp-badges">
          <span class="pill ${i.smartOk === false ? 'bad' : i.smartOk ? 'ok' : ''}">${i.smartOk === false ? t('SMART: probleem') : i.smartOk ? t('SMART: in orde') : t('SMART: onbekend')}</span>
          ${i.temp != null ? `<span class="pill ${tc.replace('temp-', '')}">${i.temp} °C</span>` : ''}
          ${d.pool ? `<span class="pill">${esc(d.pool)}${d.role && d.role !== 'data' ? ' · ' + esc(d.role) : ''}${d.state && d.state !== 'ONLINE' ? ' · ' + esc(d.state.toLowerCase()) : ''}</span>` : ''}
        </div>
        <dl class="kv dp-kv">
          <dt>${t('Aan')}</dt><dd>${esc(hoursText(i.powerOnHours))}</dd>
          <dt>${t('Keer aangezet')}</dt><dd>${i.powerCycles != null ? nf0.format(i.powerCycles) : '–'}</dd>
          <dt>${t('Grootte')}</dt><dd>${bytes(i.size || d.size)}</dd>
          <dt>${t('Soort')}</dt><dd>${esc([kind, i.formFactor].filter(Boolean).join(' · '))}</dd>
          ${i.link ? `<dt>${t('Aansluiting')}</dt><dd>${esc(i.link)}</dd>` : ''}
          <dt>${t('Serienummer')}</dt><dd><code>${esc(i.serial || d.serial || '–')}</code></dd>
          ${i.firmware ? `<dt>${t('Firmware')}</dt><dd>${esc(i.firmware)}</dd>` : ''}
          ${d.pool ? `<dt>${t('ZFS-fouten')}</dt><dd class="${d.errors ? 'temp-bad' : ''}">${nf0.format(d.errors || 0)}</dd>` : ''}
          ${i.errorLog ? `<dt>${t('Foutenlogboek')}</dt><dd class="temp-warn">${t('{n} fouten gemeld', { n: i.errorLog })}</dd>` : ''}
        </dl>
        ${watch || nvRows ? `<h4 class="dp-sub">${t('Gezondheid')}</h4><ul class="dp-watch">${nvRows}${watch}</ul>` : ''}
        <h4 class="dp-sub">${t('Zelftest')}</h4>
        ${running ? `<p class="small">${running.remaining != null ? t('Test loopt: nog {n}% te gaan.', { n: running.remaining }) : t('Er loopt een test.')}</p>` : ''}
        ${i.tests.length ? `<ul class="dp-tests">${i.tests.slice(0, 3).map((x) => `<li><span>${esc(x.type)}</span>
            <b class="${x.result === 'ok' ? 'temp-ok' : x.result === 'running' ? '' : 'temp-bad'}">${t(RES[x.result] || x.result)}</b>
            <span class="muted">${x.hours != null ? t('bij {hours} uur', { hours: nf0.format(x.hours) }) : ''}</span></li>`).join('')}</ul>`
          : `<p class="small muted">${t('Nog geen zelftest gedaan.')}</p>`}
        <div class="btn-row" style="margin-top:8px">
          <button class="btn sm" type="button" data-dp-test="short"${running ? ' disabled' : ''}>${t('Korte test')}${i.testMinutes && i.testMinutes.short ? ' (' + t('{n} min', { n: i.testMinutes.short }) + ')' : ''}</button>
          <button class="btn sm" type="button" data-dp-test="long"${running ? ' disabled' : ''}>${t('Lange test')}${i.testMinutes && i.testMinutes.long ? ' (' + t('{n} min', { n: i.testMinutes.long }) + ')' : ''}</button>
        </div>
        <p class="small muted" style="margin-top:6px">${t('Een test leest de schijf na terwijl ze gewoon blijft werken. De lange test duurt uren.')}</p>
        ${i.attributes.length ? `<details class="adv dp-attrs"><summary>${t('Alle SMART-waarden ({n})', { n: i.attributes.length })}</summary>
          <table class="attr-table"><thead><tr><th>ID</th><th>${t('Naam')}</th><th>${t('Waarde')}</th><th>${t('Drempel')}</th><th>Raw</th></tr></thead><tbody>
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
      // Loopt er een test, dan elke 10 s bijwerken zolang het venster open is.
      if (sel && sel.key === key && sel.info && sel.info.testRunning) testTimer = setTimeout(() => { if (el.isConnected && sel && sel.key === key) loadDisk(false, true); }, 10000);
    }
    // Nog eens op dezelfde schijf klikken: paneel dicht en niets meer geselecteerd.
    function selectDisk(key) {
      clearTimeout(testTimer);
      sel = sel && sel.key === key ? null : { key, info: null, loading: false, error: null };
      $$('[data-bay]', el).forEach((b) => { if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', String(!!(sel && cfg.slots[b.dataset.bay] && cfg.slots[b.dataset.bay].key === sel.key))); });
      if (sel) loadDisk(); else renderPanel();
    }

    // Labels op een lade: de pool (elke pool zijn eigen kleur, met de rol als het geen gewone dataschijf is) en de temperatuur.
    const poolNames = (s.pools || []).map((p) => p.name);
    const tags = (d) => {
      const pool = d.pool ? `<span class="tag pool p${(poolNames.indexOf(d.pool) % 5) + 1}">${esc(d.pool)}${d.role && d.role !== 'data' ? ' · ' + esc(d.role) : ''}</span>`
        : `<span class="tag">${t('Geen pool')}</span>`;
      const tc = d.temp == null ? 'sleep' : d.temp >= 50 ? 'bad' : d.temp >= 45 ? 'warn' : 'ok';
      return pool + `<span class="tag temp ${tc}">${d.temp != null ? d.temp + ' °C' : t('In rust')}</span>`;
    };
    async function runTest(type, btn) {
      const d = sel && byKey.get(sel.key); if (!d) return;
      btn.disabled = true;
      try {
        const r = await api.post('/api/disks/' + encodeURIComponent(d.name) + '/test', { type });
        toast(t(type === 'short' ? 'Korte test gestart op {disk}.' : 'Lange test gestart op {disk}.', { disk: d.name }) + (r.minutes ? ' ' + t('Klaar over ongeveer {n} minuten.', { n: r.minutes }) : ''));
        loadDisk();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    }
    const kindOf = (d) => (d.transport === 'nvme' ? 'NVMe' : d.rotational ? 'HDD' : 'SSD');
    const bayCard = (n) => {
      const slot = cfg.slots[n], d = slot && byKey.get(slot.key), st = slot ? bayState(d) : 'vacant';
      const title = !slot ? t('Bay {n}: leeg', { n }) : d ? t('Bay {n}: {disk}', { n, disk: d.name }) : t('Bay {n}: schijf weg', { n });
      const head = `<span class="tray-top"><span class="bay-no">${n}</span><span class="tray-leds" aria-hidden="true"><i class="led"></i></span></span>`;
      return `<button type="button" class="bay ${st}${slot && picked === slot.key ? ' picked' : ''}" data-bay="${n}"
          ${edit && slot ? `draggable="true" data-key="${esc(slot.key)}"` : ''} aria-label="${esc(title)}"${edit ? '' : slot ? ` aria-pressed="${!!(sel && sel.key === slot.key)}"` : ' tabindex="-1"'}>
        ${!slot ? `<span class="slot-hole">${head}<span class="bay-empty">${edit ? t('Sleep hier een schijf') : t('Leeg')}</span></span>`
          : `<span class="tray">${head}<span class="tray-vents" aria-hidden="true"></span>
            ${d ? `<span class="tray-info"><b class="bay-name">${esc(d.name)}</b>
                <span class="bay-sub" title="${esc(diskLabel(d))}">${esc(d.model || '')}</span>
                <span class="bay-sub">${esc(bytes(d.size))}</span><span class="bay-sub">${esc(kindOf(d))}</span></span>
              <span class="tray-tags">${tags(d)}</span>`
            : `<span class="tray-info"><b class="bay-name">${t('Schijf weg')}</b><span class="bay-sub" title="${esc(slot.label)}">${esc(slot.label)}</span></span>`}
            <span class="tray-handle" aria-hidden="true"></span></span>`}
      </button>`;
    };
    // M.2-sleuf: een liggend printplaatje met chips en een goudkleurige connector.
    const m2Card = (n) => {
      const id = 'm' + n, slot = cfg.slots[id], d = slot && byKey.get(slot.key), st = slot ? bayState(d) : 'vacant';
      const title = !slot ? t('M.2-sleuf {n}: leeg', { n }) : d ? t('M.2-sleuf {n}: {disk}', { n, disk: d.name }) : t('M.2-sleuf {n}: schijf weg', { n });
      return `<button type="button" class="m2 ${st}${slot && picked === slot.key ? ' picked' : ''}" data-bay="${id}"
          ${edit && slot ? `draggable="true" data-key="${esc(slot.key)}"` : ''} aria-label="${esc(title)}"${edit ? '' : slot ? ` aria-pressed="${!!(sel && sel.key === slot.key)}"` : ' tabindex="-1"'}>
        <span class="m2-label">M.2 ${n}</span>
        ${!slot ? `<span class="m2-empty">${edit ? t('Sleep hier een NVMe') : t('Leeg')}</span>`
          : `<span class="m2-stick"><span class="m2-gold" aria-hidden="true"></span><span class="m2-chip" aria-hidden="true"></span>
            <span class="m2-info"><b class="bay-name">${d ? esc(d.name) : t('Schijf weg')}</b>
              <span class="bay-sub" title="${esc(d ? diskLabel(d) : slot.label)}">${esc(d ? [d.model, bytes(d.size)].filter(Boolean).join(' · ') : slot.label)}</span></span>
            ${d ? `<span class="m2-tags">${tags(d)}</span>` : ''}
            <span class="tray-leds" aria-hidden="true"><i class="led"></i></span><span class="m2-notch" aria-hidden="true"></span></span>`}
      </button>`;
    };
    // 2,5"-sleuf: een liggende, smalle lade (zoals de hot-swap-sleuven voor SSD's).
    const ssdCard = (n) => {
      const id = 's' + n, slot = cfg.slots[id], d = slot && byKey.get(slot.key), st = slot ? bayState(d) : 'vacant';
      const title = !slot ? t('2,5"-sleuf {n}: leeg', { n }) : d ? t('2,5"-sleuf {n}: {disk}', { n, disk: d.name }) : t('2,5"-sleuf {n}: schijf weg', { n });
      return `<button type="button" class="sff ${st}${slot && picked === slot.key ? ' picked' : ''}" data-bay="${id}"
          ${edit && slot ? `draggable="true" data-key="${esc(slot.key)}"` : ''} aria-label="${esc(title)}"${edit ? '' : slot ? ` aria-pressed="${!!(sel && sel.key === slot.key)}"` : ' tabindex="-1"'}>
        ${!slot ? `<span class="sff-hole"><span class="sff-no">${n}</span><span class="sff-empty">${edit ? t('Sleep hier een SSD') : t('Leeg')}</span></span>`
          : `<span class="sff-tray"><span class="sff-no">${n}</span><span class="sff-vents" aria-hidden="true"></span>
            <span class="sff-info"><b class="bay-name">${d ? esc(d.name) : t('Schijf weg')}</b>
              <span class="bay-sub" title="${esc(d ? diskLabel(d) : slot.label)}">${esc(d ? bytes(d.size) : slot.label)}</span></span>
            ${d ? `<span class="sff-tags">${tags(d)}</span>` : ''}
            <span class="tray-leds" aria-hidden="true"><i class="led"></i></span><span class="sff-handle" aria-hidden="true"></span></span>`}
      </button>`;
    };
    const draw = () => {
      const unplaced = s.disks.filter((d) => !bayOf(d.key));
      if (!cfg.count && !edit) {
        el.innerHTML = `<h3>${t('Schijfbays')}</h3>
          <p class="muted small">${t('Geef je kast zijn aantal bays en sleep je schijven naar de juiste plaats. Zo zie je meteen welke schijf je moet vervangen.')}</p>
          <div class="btn-row" style="margin-top:10px"><button class="btn sm" type="button" data-bay-edit>${t('Bays instellen')}</button></div>`;
        return;
      }
      el.innerHTML = `
        <div class="bays-head"><h3>${t('Schijfbays')}</h3>
          <button class="btn sm${edit ? ' primary' : ''}" type="button" data-bay-edit>${edit ? t('Klaar') : t('Indeling aanpassen')}</button></div>
        ${edit ? `<div class="bays-cfg">
            <label class="fld"><span>${t('Aantal bays')}</span><input class="field" type="number" min="1" max="60" step="1" data-bay-cfg="count" value="${cfg.count}"></label>
            <label class="fld"><span>${t('Bays per rij')}</span><input class="field" type="number" min="1" max="12" step="1" data-bay-cfg="columns" value="${cfg.columns}"></label>
            <label class="fld"><span>${t('2,5"-sleuven')}</span><input class="field" type="number" min="0" max="16" step="1" data-bay-cfg="ssd" value="${cfg.ssd}"></label>
            <label class="fld"><span>${t('M.2-sleuven')}</span><input class="field" type="number" min="0" max="8" step="1" data-bay-cfg="m2" value="${cfg.m2}"></label>
          </div>
          <p class="muted small">${t('Sleep een schijf naar een bay. Op een volle bay wisselen de twee van plaats. Slepen gaat niet? Tik op een schijf en daarna op een bay.')}</p>` : ''}
        <div class="bays-wrap"><div class="nas">
          <div class="nas-top"><span class="nas-name">${esc((S.overview && S.overview.hostname) || 'HomeBaseOS')}</span>
            <span class="nas-power" title="${t('Aan')}"><i class="led"></i></span></div>
          <div class="bay-grid" style="--bay-cols:${cfg.columns}">${Array.from({ length: cfg.count }, (_, i) => bayCard(i + 1)).join('')}</div>
          ${cfg.ssd ? `<div class="sff-row">${Array.from({ length: cfg.ssd }, (_, i) => ssdCard(i + 1)).join('')}</div>` : ''}
          ${cfg.m2 ? `<div class="m2-row">${Array.from({ length: cfg.m2 }, (_, i) => m2Card(i + 1)).join('')}</div>` : ''}
        </div>${edit ? '' : '<div class="disk-panel" id="diskPanel" aria-live="polite" hidden></div>'}</div>
        ${edit ? '' : `<p class="muted small" id="bayHint" style="margin-top:8px">${t('Klik op een bay om de details van de schijf te zien: uren, SMART, temperatuur en zelftesten.')}</p>`}
        ${edit ? `<div class="bay-pool${picked && bayOf(picked) ? ' droppable' : ''}" data-unplace>
            <span class="muted small">${unplaced.length ? t('Nog niet in een bay (sleep een schijf hierheen om ze uit haar bay te halen):') : t('Alle schijven zitten in een bay. Sleep er een hierheen om ze uit haar bay te halen.')}</span>
            <div class="bay-chips">${unplaced.map((d) => `<button type="button" class="bay-chip ${bayState(d)}${picked === d.key ? ' picked' : ''}" draggable="true" data-key="${esc(d.key)}">
              <span class="bay-led" aria-hidden="true"></span><b>${esc(d.name)}</b> <span class="muted">${esc([d.model, bytes(d.size)].filter(Boolean).join(' · '))}</span>${tags(d)}</button>`).join('')}</div>
          </div>`
        : unplaced.length ? `<p class="muted small" style="margin-top:8px">${t(unplaced.length === 1 ? '{n} schijf zit nog niet in een bay:' : '{n} schijven zitten nog niet in een bay:', { n: unplaced.length })}
            ${unplaced.map((d) => `<button type="button" class="link-btn" data-dp-disk="${esc(d.key)}">${esc(d.name)}</button>`).join(', ')}</p>` : ''}`;
      renderPanel();
    };
    draw();

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-bay-edit]')) {
        if (!edit && !cfg.count) {
          const nvme = s.disks.filter((d) => d.transport === 'nvme').length, sata = s.disks.filter((d) => d.transport !== 'nvme' && !d.rotational).length;
          cfg.count = Math.max(1, s.disks.length - nvme - sata); cfg.m2 = nvme; cfg.ssd = sata;
          cfg.columns = Math.min(12, cfg.count); // standaard alle bays naast elkaar op één rij
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
      if (k === 'count' && !(v >= 1 && v <= 60)) { toast(t('Kies tussen 1 en 60 bays.'), true); draw(); return; }
      if (k === 'columns' && !(v >= 1 && v <= 12)) { toast(t('Kies tussen 1 en 12 kolommen.'), true); draw(); return; }
      if (k === 'm2' && !(v >= 0 && v <= 8)) { toast(t('Kies tussen 0 en 8 M.2-sleuven.'), true); draw(); return; }
      if (k === 'ssd' && !(v >= 0 && v <= 16)) { toast(t('Kies tussen 0 en 16 2,5"-sleuven.'), true); draw(); return; }
      // Stonden alle bays op één rij, dan blijft dat zo bij meer of minder bays.
      if (k === 'count' && cfg.columns === Math.min(12, cfg.count)) cfg.columns = Math.min(12, v);
      const prefix = { count: '', m2: 'm', ssd: 's' }[k];
      if (prefix != null) Object.keys(cfg.slots).forEach((b) => { const x = b.match(/^([ms]?)(\d+)$/); if (x && x[1] === prefix && Number(x[2]) > v) delete cfg.slots[b]; });
      cfg[k] = v; save(); draw();
    });
    // Slepen (muis); op aanraakschermen werkt tikken.
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

  /* --- pool aanmaken: schijven en indeling kiezen, met meteen de opslag die het oplevert */
  const POOL_LAYOUTS = [
    ['stripe', 'Stripe', 1, 'Alle ruimte, maar geen bescherming: valt één schijf uit, dan ben je alles kwijt.'],
    ['mirror', 'Mirror', 2, 'Elke schijf bevat dezelfde gegevens. Heel veilig, maar je hebt de ruimte van één schijf.'],
    ['raidz1', 'RAID-Z1', 3, 'Zoals RAID 5: één schijf mag uitvallen. Goed voor 3 tot 5 schijven.'],
    ['raidz2', 'RAID-Z2', 4, 'Zoals RAID 6: twee schijven mogen uitvallen. Aanbevolen vanaf 6 schijven of bij grote schijven.'],
    ['raidz3', 'RAID-Z3', 5, 'Drie schijven mogen uitvallen. Voor veel grote schijven.'],
    ['mirrors', 'Mirror-paren (RAID 10)', 4, 'Paren van twee: snel, en per paar mag één schijf uitvallen. Een even aantal schijven.'],
  ];
  // Zelfde berekening als capacity() in lib/zpool.js.
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
    openWindow(t('Pool aanmaken'), `<p class="lead">${t('Schijven zoeken…')}</p>`);
    let o;
    try { o = await api.get('/api/pools/options'); }
    catch (e) { $('#winBody').innerHTML = `<p class="lead">${t('De schijven konden niet gelezen worden: {error}', { error: esc(e.message) })}</p>`; return; }
    poolForm($('#winBody'), o, bays, { onCreated: () => storageWindow(), onBack: () => storageWindow() });
  }
  // Formulier om een pool aan te maken: in het venster Opslag en meteen in de welkomstwizard (inline: zonder eigen knoppen,
  // de wizard roept submit() op en hoort via onPick of er schijven gekozen zijn).
  function poolForm(body, o, bays, { inline = false, onCreated = () => {}, onBack = null, onPick = () => {} } = {}) {
    const bayOfDisk = (d) => { const k = d.serial ? 's:' + d.serial : 'n:' + d.name; return Object.keys((bays && bays.slots) || {}).find((x) => bays.slots[x].key === k) || null; };
    const kind = (d) => (d.transport === 'nvme' ? 'NVMe' : d.rotational ? 'HDD' : 'SSD');
    let name = ['tank', 'snel', 'data', 'opslag'].find((n) => !o.pools.includes(n)) || 'data' + (o.pools.length + 1);
    const picked = new Set(); let layout = 'stripe', chosenByUser = false;
    body.innerHTML = `
      <form class="form" id="poolForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Naam van de pool')}</span><input class="field" name="name" value="${esc(name)}" maxlength="64" autocomplete="off" spellcheck="false">
            <small>${t('Bijvoorbeeld tank voor de harde schijven en snel voor de SSD\'s. De pool komt op /naam.')}</small></label>
          <label class="fld"><span>${t('Compressie')}</span><select class="field" name="compression">
            <option value="lz4">${t('lz4 (aanbevolen: snel en bespaart ruimte)')}</option><option value="zstd">${t('zstd (bespaart meer, iets trager)')}</option><option value="off">${t('Uit')}</option></select></label>
        </div>
        <fieldset class="fld"><span>${t('Schijven')}</span><div class="dev-list" id="poolDisks"></div></fieldset>
        <fieldset class="fld"><span>${t('Indeling')}</span><div class="layout-grid" id="poolLayouts" role="radiogroup" aria-label="${t('Indeling')}"></div></fieldset>
        <div class="pool-sum" id="poolSum" aria-live="polite"></div>
        <label class="check"><input type="checkbox" name="folders" checked> <span>${t('Standaardmappen aanmaken: {list}', { list: 'appdata, media, backups, vms, isos' })}
          <span class="muted small">${t('Apps, VM\'s en ISO\'s die nog geen plek hebben, komen op deze pool. Verhuizen kan later bij Instellingen → Opslag.')}</span></span></label>
        <p class="form-error" role="alert"></p>
        ${inline ? '' : `<div class="btn-row"><button class="btn primary" type="submit">${t('Pool aanmaken')}</button>${onBack ? `<button class="btn" type="button" data-pool-back>${t('Terug naar opslag')}</button>` : ''}</div>`}
      </form>`;
    const form = $('#poolForm', body);
    const sel = () => o.disks.filter((d) => picked.has(d.name));
    const drawDisks = () => {
      // Alleen vrije schijven: wat in een pool zit of het systeem draagt, kan je toch niet kiezen.
      const free = o.disks.filter((d) => d.available);
      $('#poolDisks', form).innerHTML = free.map((d) => {
        const b = bayOfDisk(d);
        return `<label class="check dev"><input type="checkbox" data-pdisk="${esc(d.name)}"${picked.has(d.name) ? ' checked' : ''}>
          <span><b>${esc(d.name)}</b> <span class="muted small">${esc([d.model, bytes(d.size), kind(d), b ? (b.startsWith('m') ? t('M.2-sleuf {n}', { n: b.slice(1) }) : b.startsWith('s') ? t('2,5"-sleuf {n}', { n: b.slice(1) }) : t('bay {n}', { n: b })) : null].filter(Boolean).join(' · '))}</span>
          ${d.warn && picked.has(d.name) ? `<span class="small temp-warn">${esc(tr(d.warn))}</span>` : ''}</span></label>`;
      }).join('') || `<p class="muted">${t('Er zijn geen vrije schijven. Elke schijf zit al in een pool of draagt het systeem.')}</p>`;
    };
    const drawLayouts = () => {
      const n = picked.size;
      $('#poolLayouts', form).innerHTML = POOL_LAYOUTS.map(([k, label, min, help]) => {
        const short = n < min ? min - n : 0, odd = k === 'mirrors' && n >= min && n % 2;
        return `<label class="layout${layout === k ? ' on' : ''}${short || odd ? ' short' : ''}"><input type="radio" name="layout" value="${k}"${layout === k ? ' checked' : ''}>
          <b>${t(label)}</b><span class="small muted">${t(help)}</span>
          <span class="small">${short ? t(short === 1 ? 'Nog {n} schijf nodig' : 'Nog {n} schijven nodig', { n: short }) : odd ? t('Kies een even aantal') : t(min === 1 ? 'Minstens {n} schijf' : 'Minstens {n} schijven', { n: min })}</span></label>`;
      }).join('');
    };
    const drawSum = () => {
      const d = sel(), c = poolCapacity(layout, d.map((x) => x.size)), box = $('#poolSum', form);
      if (!d.length) { box.innerHTML = `<p class="muted">${t('Vink de schijven aan die in de pool komen.')}</p>`; return; }
      if (!c) {
        const L = POOL_LAYOUTS.find((x) => x[0] === layout);
        box.innerHTML = `<p class="muted">${layout === 'mirrors' && d.length >= L[2] ? t('Mirror-paren hebben een even aantal schijven nodig.') : t('{layout} heeft minstens {n} schijven nodig.', { layout: t(L[1]), n: L[2] })}</p>`; return;
      }
      const pct = (v) => (c.raw ? (v / c.raw) * 100 : 0).toFixed(1);
      const warns = [];
      if (layout === 'stripe' && d.length > 1) warns.push(t('Zonder bescherming: valt één schijf uit, dan ben je de hele pool kwijt.'));
      if (c.unused > 1e9) warns.push(t('{size} blijft ongebruikt: bij deze indeling telt van elke schijf alleen zoveel als de kleinste.', { size: bytes(c.unused) }));
      if (d.some((x) => x.rotational) && d.some((x) => !x.rotational)) warns.push(t('Je mengt harde schijven en SSD\'s: de pool is zo traag als de harde schijven. Maak liever twee pools.'));
      if (layout === 'raidz1' && d.length >= 6) warns.push(t('Met 6 of meer schijven is RAID-Z2 veiliger: tijdens het herstellen van een schijf mag er dan nog een uitvallen.'));
      box.innerHTML = `
        <div class="pool-big"><b>${bytes(c.usable)}</b> <span>${t('bruikbaar (ongeveer)')}</span></div>
        <div class="pool-bar" aria-hidden="true"><span class="u" style="width:${pct(c.usable)}%"></span><span class="r" style="width:${pct(c.redundancy)}%"></span><span class="x" style="width:${pct(c.unused)}%"></span></div>
        <div class="pool-legend small">
          <span><i class="u"></i>${t('Bruikbaar {size}', { size: bytes(c.usable) })}</span>
          <span><i class="r"></i>${t('Bescherming {size}', { size: bytes(c.redundancy) })}</span>
          ${c.unused > 1e9 ? `<span><i class="x"></i>${t('Ongebruikt {size}', { size: bytes(c.unused) })}</span>` : ''}
          <span class="muted">${t('Ruw {size} op {n} schijven', { size: bytes(c.raw), n: d.length })}</span>
        </div>
        <p class="${c.failures ? 'temp-ok' : 'temp-warn'}">${c.failures ? t(c.failures === 1 ? 'Er mag {n} schijf uitvallen zonder dat je gegevens kwijt bent.' : 'Er mogen {n} schijven uitvallen zonder dat je gegevens kwijt bent.', { n: c.failures })
          + (layout === 'mirrors' ? ' ' + t('(één per paar)') : '') : t('Geen bescherming.')}</p>
        ${warns.map((w) => `<p class="small temp-warn">${esc(w)}</p>`).join('')}
        <p class="small muted">${t('ZFS houdt ongeveer 3% achter voor zichzelf; compressie maakt er vaak weer meer van.')}</p>`;
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
    // true = aangemaakt, false = niet (fout staat in het formulier, of geannuleerd).
    async function submit() {
      const err = $('.form-error', form), btn = $('[type=submit]', form); err.textContent = '';
      name = form.elements.name.value.trim();
      const d = sel();
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name)) { err.textContent = t('Kies een naam die met een letter begint, met letters, cijfers, - of _ (bv. tank of snel). Namen als mirror of raidz zijn niet toegelaten.'); return false; }
      if (!poolCapacity(layout, d.map((x) => x.size))) { err.textContent = d.length ? t('Deze indeling past niet bij het aantal gekozen schijven.') : t('Vink de schijven aan die in de pool komen.'); return false; }
      const r = await ask(t('Pool {name} aanmaken op {list}? Alles wat nu op deze schijven staat, wordt gewist.', { name, list: d.map((x) => x.name).join(', ') }),
        t('Pool aanmaken'), t('Ik begrijp dat alle gegevens op deze schijven verloren gaan'));
      if (!r) return false;
      if (!r.checked) { err.textContent = t('Vink aan dat de gegevens op de schijven verloren mogen gaan.'); return false; }
      if (btn) { btn.disabled = true; btn.textContent = t('Aanmaken…'); }
      try {
        const res = await api.post('/api/pools', { name, layout, disks: d.map((x) => x.name), compression: form.elements.compression.value, confirm: name, folders: form.elements.folders.checked });
        const folders = res.folders || [];
        toast(folders.length ? t('Pool {name} is aangemaakt met de mappen {list}.', { name, list: folders.join(', ') }) : t('Pool {name} is aangemaakt en staat op /{name}.', { name }));
        if (res.warning) toast(tr(res.warning), true);
        loadOverview().catch(() => {});
        onCreated(res);
        return true;
      } catch (ex) { err.textContent = ex.message; if (btn) { btn.disabled = false; btn.textContent = t('Pool aanmaken'); } return false; }
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    return { submit, picked: () => picked.size > 0 };
  }

  async function storageWindow() {
    openWindow(t('Opslag'), `<p class="lead">${t('Schijven laden…')}</p>`);
    win.classList.add('win-wide');
    let s;
    try { s = await api.get('/api/storage'); } catch (e) { $('#winBody').innerHTML = `<p class="lead">${esc(e.message)}</p>`; return; }
    const pct = s.total ? (s.used / s.total) * 100 : 0;
    const ROLE = { cache: 'Leescache', log: 'Schrijflog', spare: 'Reserve', special: 'Metadata', dedup: 'Dedup' };
    const diskRow = (d) => {
      const sub = [d.model, ROLE[d.role] && t(ROLE[d.role]), d.transport === 'nvme' ? 'NVMe' : d.rotational ? 'HDD' : 'SSD',
        d.state && d.state !== 'ONLINE' ? d.state.toLowerCase() : null, d.errors ? t('{n} fouten', { n: d.errors }) : null,
        d.smartOk === false ? t('SMART meldt een probleem') : null].filter(Boolean).join(' · ');
      const bad = (d.state && d.state !== 'ONLINE') || d.errors || d.smartOk === false;
      return `<li>
        <div><div class="row-title">${esc(d.name)}</div><div class="row-sub${bad ? ' temp-bad' : ''}">${esc(sub)}</div></div>
        <div class="row-side"><div>${bytes(d.size)}</div><div class="${tempClass(d.temp)}">${d.temp != null ? d.temp + ' °C' : t('In rust')}</div></div>
      </li>`;
    };
    const poolBlock = (p) => {
      const used = p.total ? (p.used / p.total) * 100 : 0;
      const [label, cls] = poolHealth(p.health);
      const disks = s.disks.filter((d) => d.pool === p.name);
      return `<h3>${esc(p.name)} <span class="pill ${cls}">${esc(label)}</span></h3>
        <ul class="rows">
          <li>
            <div><div class="row-title">${t('{size} vrij', { size: bytes(p.free) })}</div>
              <div class="row-sub">${esc([p.layout, p.diskCount ? t(p.diskCount === 1 ? '{n} schijf' : '{n} schijven', { n: p.diskCount }) : null].filter(Boolean).join(' · '))}</div></div>
            <div class="row-side">${t('{used} van {total}', { used: bytes(p.used), total: bytes(p.total) })}</div>
            <div class="row-bar"><div class="bar"><span class="${level(used, 80, 92)}" style="width:${used.toFixed(1)}%"></span></div>
              <div class="row-sub">${esc(scrubText(p.scrub))}</div></div>
          </li>
          ${disks.map(diskRow).join('')}
        </ul>`;
    };
    const loose = s.disks.filter((d) => !d.pool);
    $('#winBody').innerHTML = `
      <div class="stat-strip">
        <div class="stat"><b>${bytes(s.free)}</b><span>${t('vrij')}</span></div>
        <div class="stat"><b>${nf0.format(pct)}%</b><span>${t('gebruikt van {total}', { total: bytes(s.total) })}</span></div>
        <div class="stat"><b>${s.disks.length}</b><span>${t('schijven')}</span></div>
        <div class="stat"><b>${s.disks.reduce((n, d) => n + (d.errors || 0), 0)}</b><span>${t('schijffouten')}</span></div>
      </div>
      <section class="bays-sec" id="baySec"></section>
      ${s.zfsError ? `<p class="lead temp-bad">${t('ZFS gaf een fout: {error}', { error: esc(tr(s.zfsError)) })}</p>` : ''}
      ${!s.zfsError && !s.pools.length ? `<p class="lead">${t('Er is nog geen ZFS-pool. Klik op Pool aanmaken om je schijven te bundelen.')}</p>` : ''}
      <div class="bays-head"><h3>${t('Pools')}</h3><button class="btn sm" type="button" data-pool-new>${t('Pool aanmaken')}</button></div>
      ${s.pools.map(poolBlock).join('')}
      ${loose.length ? `<h3>${t('Niet in een pool')}</h3><ul class="rows">${loose.map(diskRow).join('')}</ul>` : ''}
      <div class="bays-head"><h3>${t('Datasets')}</h3><button class="btn sm" type="button" data-open="shares">${t('Gedeelde mappen beheren')}</button></div>
      <ul class="rows">${s.datasets.map((d) => `<li>
        <div><div class="row-title">${esc(d.name)}</div><div class="row-sub">${esc([d.mountpoint, d.compress > 1.01 ? t('compressie {x}×', { x: nf.format(d.compress) }) : null].filter(Boolean).join(' · '))}</div></div>
        <div class="row-side">${bytes(d.used)}</div></li>`).join('') || `<li><span class="muted">${t('Geen datasets')}</span></li>`}</ul>`;
    mountBays($('#baySec'), s);
    $('[data-pool-new]').addEventListener('click', () => poolCreateWindow(s.bays));
  }

  /* --- VM's (eigen pagina op #vms) */
  const VM_ACTS = {
    start: { label: 'Starten', noun: 'Starten', done: 'Gestart' },
    stop: { label: 'Afsluiten', noun: 'Afsluiten', done: 'Afsluiten gestart', yes: 'Afsluiten',
      ask: (n) => t('{name} afsluiten? De VM krijgt het signaal om netjes af te sluiten.', { name: n }) },
    reboot: { label: 'Herstarten', noun: 'Herstarten', done: 'Herstart', yes: 'Herstarten',
      ask: (n) => t('{name} herstarten? Wat erop draait, is even onbereikbaar.', { name: n }) },
    pause: { label: 'Pauzeren', noun: 'Pauzeren', done: 'Gepauzeerd' },
    resume: { label: 'Hervatten', noun: 'Hervatten', done: 'Hervat' },
    'force-stop': { label: 'Forceer uit', noun: 'Geforceerd uitzetten', done: 'Uitgezet', yes: 'Forceer uit',
      ask: (n) => t('{name} geforceerd uitzetten? Dat is alsof je de stekker uittrekt. Wat niet opgeslagen is, gaat verloren.', { name: n }) },
    reset: { label: 'Hard herstarten', noun: 'Hard herstarten', done: 'Hard herstart', yes: 'Hard herstarten',
      ask: (n) => t('{name} hard herstarten? Wat niet opgeslagen is, gaat verloren.', { name: n }) },
    delete: { label: 'Verwijderen', noun: 'Verwijderen', done: 'Verwijderd' },
  };
  const VM_HINT = {
    PAUSED: 'Het geheugen blijft bezet tot je hervat.', PMSUSPENDED: 'De VM staat in slaapstand.',
    CRASHED: 'Start hem opnieuw of zet hem geforceerd uit.', SHUTDOWN: 'Wacht tot hij uit is, of zet hem geforceerd uit.',
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
    return left > 0 ? t('Start automatisch over {time}', { time: delayText(left) }) : t('Start nu automatisch…');
  }
  function vmSubText(v) {
    const busy = S.vmBusy[v.id];
    const hint = VM_HINT[String(v.state).toUpperCase()];
    return busy ? t(VM_ACTS[busy].noun) + '…' : vmPendingText(v) || (hint ? t(hint) : '');
  }
  function vmSpecs(v) {
    const parts = [];
    if (v.vcpus) parts.push(t(v.vcpus === 1 ? '{n} vCPU' : "{n} vCPU's", { n: v.vcpus }));
    if (v.memory) parts.push(bytes(v.memory) + ' RAM');
    if (v.autostart) parts.push(v.delay ? t('start automatisch na {time}', { time: delayText(v.delay) }) : t('start automatisch'));
    return parts.join(' · ');
  }
  const vmCpuPct = (v) => (v.cpu == null ? null : v.cpu);
  const vmRamPct = (v) => (v.memUsed != null && v.memory ? (v.memUsed / v.memory) * 100 : null);
  const vmCpuText = (v) => (v.cpu == null ? '–' : nf0.format(v.cpu) + '%');
  const vmRamText = (v) => (v.memUsed == null ? '–' : t('{used} van {total}', { used: bytes(v.memUsed), total: bytes(v.memory) }));

  function meterHtml(label, pct, text) {
    return `<div class="meter"><div class="meter-head"><span>${label}</span><b>${esc(text)}</b></div>
      <div class="bar"><span class="${level(pct || 0)}" style="width:${Math.min(100, pct || 0).toFixed(1)}%"></span></div></div>`;
  }
  function setMeter(el, pct, text) {
    el.querySelector('b').textContent = text;
    const bar = el.querySelector('.bar span');
    bar.style.width = Math.min(100, pct || 0).toFixed(1) + '%'; bar.className = level(pct || 0);
  }

  // De console opent in een eigen tabblad (één per VM), zoals in Unraid.
  // De console opent groot in HomeBaseOS; daar kan je ze met "Los venster" in een eigen browservenster zetten.
  const consoleLink = (id, cls) => `<button class="${cls}" type="button" data-console="${esc(id)}">${t('Console')}</button>`;
  const conWin = $('#conWin'), conFrame = $('#conFrame');
  function openConsole(id) {
    if (win.open) win.close();
    conFrame.src = 'console.html#' + encodeURIComponent(id);
    if (!conWin.open) conWin.showModal();
    conFrame.focus();
  }
  // Terminal op de server: zelfde venster als de console, met terminal.html erin.
  function openTerminal() {
    if (win.open) win.close();
    conFrame.src = 'terminal.html';
    if (!conWin.open) conWin.showModal();
    conFrame.focus();
  }
  $('#termBtn').addEventListener('click', openTerminal);
  // De console (in de iframe) roept dit op bij Sluiten of Los venster. De iframe leegmaken verbreekt de verbinding.
  window.TB_closeConsole = () => { conFrame.src = 'about:blank'; if (conWin.open) conWin.close(); };
  conWin.addEventListener('close', () => { conFrame.src = 'about:blank'; });
  conWin.addEventListener('click', (e) => { if (e.target === conWin) window.TB_closeConsole(); });
  // IP-adressen (klikbaar om te kopiëren). Zonder adres: uitleg waarom.
  function vmIpHtml(v) {
    if (!v.ips || !v.ips.length) return `<span title="${esc(t('Installeer qemu-guest-agent in de VM, of wacht tot ze een adres van je router heeft.'))}">${t('IP-adres nog onbekend')}</span>`;
    return `${t('IP')} ${v.ips.map((ip) => `<button class="linkish" type="button" data-copy="${esc(ip)}" title="${esc(t('Klik om te kopiëren'))}"><b>${esc(ip)}</b></button>`).join(', ')}`;
  }
  function vmCardHtml(v) {
    const kind = vmKind(v.state), busy = S.vmBusy[v.id];
    const btn = (act, cls = '') => `<button class="btn ${cls}" type="button" data-vm="${esc(v.id)}" data-do="${act}"${busy ? ' disabled' : ''}>${t(VM_ACTS[act].label)}</button>`;
    const main = (kind === 'on' ? btn('pause') + btn('reboot') + btn('stop', 'danger')
      : kind === 'paused' ? btn('resume', 'primary')
      : kind === 'stopping' ? ''
      : btn('start', 'primary')) +
      (kind === 'on' || kind === 'paused' ? consoleLink(v.id, 'btn') : '') +
      `<button class="btn" type="button" data-vm-edit="${esc(v.id)}"${busy ? ' disabled' : ''}>${t('Bewerken')}</button>`;
    const force = kind === 'on' ? btn('force-stop', 'sm danger') + btn('reset', 'sm danger') : kind === 'off' ? '' : btn('force-stop', 'sm danger');
    const foot = kind === 'off' ? `<span class="row-sub">${t('Niet meer nodig?')}</span>${btn('delete', 'sm danger')}`
      : `<span class="row-sub">${t('Reageert hij niet meer?')}</span>${force}`;
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

  // Elke 3 s nieuwe cijfers: alleen de meters bijwerken, zodat focus en animaties blijven.
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
    $('#vmCount').textContent = all.length ? t('{n} van {total} actief', { n: running, total: all.length }) : '';
    const names = { all: 'Alle', on: 'Actief', paused: 'Gepauzeerd', off: 'Uit' };
    $$('#vmFilters button').forEach((b) => {
      const n = all.filter((v) => vmMatches(v, b.dataset.filter)).length;
      b.textContent = t(names[b.dataset.filter]) + (all.length ? ' ' + n : '');
    });

    const list = $('#vmList');
    const show = (html) => { vmSig = ''; list.innerHTML = html; };
    if (!S.vmsLoaded) return show(`<p class="empty">${t("VM's laden…")}</p>`);
    if (S.vmError && !all.length) {
      return show(`<div class="empty"><p>${t("De VM's konden niet geladen worden: {error}", { error: esc(S.vmError) })}</p>
        <button class="btn sm" type="button" data-vm-retry style="margin-top:12px">${t('Opnieuw proberen')}</button></div>`);
    }
    if (!all.length) return show(`<p class="empty">${t('Er zijn nog geen virtuele machines. Maak er een aan met de knop Nieuwe VM.')}</p>`);

    const q = S.vmSearch.trim().toLowerCase();
    const shown = all.filter((v) => vmMatches(v, S.vmFilter) && (!q || v.name.toLowerCase().includes(q)));
    if (!shown.length) return show(`<p class="empty">${t("Geen VM's die hierbij passen.")}</p>`);

    const sig = shown.map((v) => [v.id, v.state, S.vmBusy[v.id] || '', v.autostart, v.delay, !!v.startsAt, v.vcpus, v.memory, v.description, (v.ips || []).join(',')].join('|')).join('\n');
    if (sig === vmSig) { shown.forEach(patchVmCard); return; }
    vmSig = sig;
    list.innerHTML = shown.map(vmCardHtml).join('');
  }

  async function vmRun(v, act, request) {
    S.vmBusy[v.id] = act; renderVmPage();
    try { const r = await request(); toast(t(VM_ACTS[act].done) + ': ' + v.name + (r && r.kept && r.kept.length ? '. ' + t('Deze bestanden bleven staan: {list}', { list: r.kept.join(', ') }) : '')); }
    catch (err) { toast(t('{action} van {name} lukte niet: {error}', { action: t(VM_ACTS[act].noun), name: v.name, error: err.message }), true); }
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
      const r = await ask(t('{name} verwijderen? De VM verdwijnt uit de lijst. Dit kan je niet ongedaan maken.', { name: v.name }), t('Verwijderen'), t('Ook de schijfbestanden wissen'));
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

  /* --- VM-formulieren (aanmaken en bewerken) */
  function vmNameField(d, off = true) {
    return `<label class="fld"><span>${t('Naam')}</span>
        <input class="field" name="name" required maxlength="63" autocomplete="off" value="${esc(d.name || '')}"${off ? '' : ' disabled'}>
        ${off ? '' : `<small>${t('Zet de VM uit om de naam te wijzigen.')}</small>`}</label>`;
  }
  function vmSizeFields(d, opts, pinned = false) {
    const maxGb = Math.floor(opts.maxMemory / 1073741824);
    const gb = d.memory ? Math.round((d.memory / 1073741824) * 100) / 100 : '';
    return `<div class="fld-row">
        <label class="fld"><span>${t("vCPU's")}</span>
          <input class="field" name="vcpus" type="number" min="1" max="${opts.maxVcpus}" step="1" required value="${esc(d.vcpus || '')}"${pinned ? ' disabled' : ''}>
          <small>${pinned ? t('Volgt uit de gekozen kernen hieronder.') : t('Je server heeft {n} threads.', { n: opts.maxVcpus })}</small></label>
        <label class="fld"><span>${t('Geheugen (GB)')}</span>
          <input class="field" name="memoryGb" type="number" min="0.25" max="${maxGb}" step="0.25" required value="${gb}">
          <small>${t('Je server heeft {size}.', { size: bytes(opts.maxMemory) })}</small></label>
        ${d.diskGb !== undefined ? `<label class="fld"><span>${t('Schijf (GB)')}</span>
          <input class="field" name="diskGb" type="number" min="4" max="16384" step="1" required value="${esc(d.diskGb)}">
          <small>${t('Groeit mee, neemt niet meteen alles in.')}</small></label>` : ''}
      </div>`;
  }
  function vmDescAutoFields(d) {
    return `<label class="fld"><span>${t('Beschrijving')} <em class="muted">${t('(optioneel)')}</em></span>
        <textarea class="field" name="description" rows="2" maxlength="2000">${esc(d.description || '')}</textarea></label>
      <fieldset class="fld autostart">
        <label class="check"><input type="checkbox" name="autostart"${d.autostart ? ' checked' : ''}> ${t('Automatisch starten als de server opstart')}</label>
        <label class="fld"><span>${t('Startuitstel (seconden)')}</span>
          <input class="field" name="delay" type="number" min="0" max="3600" step="5" value="${esc(d.delay || 0)}"${d.autostart ? '' : ' disabled'}>
          <small>${t('Bijvoorbeeld 60: de VM start 1 minuut na de server, zodat die eerst rustig kan opstarten.')}</small></label>
      </fieldset>`;
  }
  // Keuzelijst met netwerken: "network:<naam>" (libvirt) of "bridge:<naam>" (bridge van de server).
  const NET_MODE = { nat: 'NAT', isolated: 'Afgeschermd', bridge: 'Bridge', route: 'Gerouteerd', open: 'Open' };
  function vmNetOptions(opts, selected) {
    const opt = (v, label) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`;
    const known = [...opts.networks.map((n) => 'network:' + n.name), ...opts.bridges.map((b) => 'bridge:' + b.name)];
    return (opts.bridges.length ? `<optgroup label="${t('Thuisnetwerk (bridge van de server)')}">${opts.bridges.map((b) =>
        opt('bridge:' + b.name, [b.name, b.address].filter(Boolean).join(' · '))).join('')}</optgroup>` : '') +
      `<optgroup label="${t('VM-netwerken')}">${opts.networks.map((n) =>
        opt('network:' + n.name, [n.name, t(NET_MODE[n.mode] || n.mode), n.subnet, n.active ? null : t('niet actief')].filter(Boolean).join(' · '))).join('')}</optgroup>` +
      (selected && !known.includes(selected) ? opt(selected, selected.replace(':', ': ') + ' (' + t('bestaat niet meer') + ')') : '');
  }
  const VM_NET_HELP = 'Bridge (bv. br0): de VM krijgt een eigen adres in je thuisnetwerk, nodig voor Home Assistant. NAT: de VM kan naar internet, maar je bereikt hem niet vanuit je netwerk.';
  function readForm(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || (el.disabled && el.name !== 'delay')) continue; // uitstel bewaren, ook als automatisch starten uit staat
      out[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    }
    return out;
  }
  function wireAutostart(form) {
    const box = form.elements.autostart, delay = form.elements.delay;
    box.addEventListener('change', () => { delay.disabled = !box.checked; });
  }
  function vncHtml(vnc) {
    if (!vnc) return `<p class="muted small">${t('Deze VM heeft geen VNC-scherm.')}</p>`;
    const host = location.hostname || 'je-server';
    const addr = vnc.port ? host + ':' + vnc.port : null;
    return `<dl class="kv">
        <dt>${t('Adres')}</dt><dd>${addr ? `<a href="vnc://${esc(addr)}" target="_blank" rel="noopener">${esc(addr)}</a>` : t('Start de VM om het adres te zien')}</dd>
        <dt>${t('Wachtwoord')}</dt><dd>${vnc.password ? `<code>${esc(vnc.password)}</code>` : t('Geen')}</dd>
      </dl>
      <p class="muted small">${t('Op je Mac opent de link Schermdeling. Daar installeer je het besturingssysteem of zie je het scherm van de VM.')}</p>`;
  }
  const vmOptions = () => api.get('/api/vm-options'); // altijd vers: USB-apparaten en ISO's veranderen

  const GIB = 1073741824;
  const NIC_MODELS = [['virtio', 'virtio (snelst: Linux, Home Assistant)'], ['e1000e', 'e1000e (Windows zonder extra drivers)'], ['rtl8139', 'rtl8139 (oude systemen)']];
  const VM_TABS = [['general', 'Algemeen'], ['cpu', 'CPU en geheugen'], ['net', 'Netwerk'], ['storage', 'Opslag'], ['devices', 'Apparaten'], ['screen', 'Scherm']];

  async function vmEditWindow(id, tab = 'general') {
    openWindow(t('VM bewerken'), `<p class="lead">${t('Laden…')}</p>`);
    let d, opts;
    try { [d, opts] = await Promise.all([api.get('/api/vms/' + encodeURIComponent(id)), vmOptions()]); }
    catch (e) { $('#winBody').innerHTML = `<p class="lead">${t('De VM kon niet geladen worden: {error}', { error: esc(e.message) })}</p>`; return; }
    $('#winTitle').textContent = d.name;
    const off = vmKind(d.state) === 'off';
    // Wat in het formulier verandert, maar geen gewoon invoerveld is.
    const st = {
      nics: d.nics.map((n) => ({ id: n.mac, locked: n.locked, type: n.type, source: n.source, model: n.model || 'virtio', mac: n.mac || '' })),
      disks: d.disks.map((k) => ({ target: k.target, source: k.source, size: k.size, sizeGb: k.size ? Math.ceil(k.size / GIB) : '', remove: false })),
      add: [], hostdevs: new Set(d.hostdevs), pins: new Set(d.cpuPins),
    };
    const body = $('#winBody');
    body.innerHTML = `
      ${off ? '' : `<p class="lead">${t('De VM draait. Wijzigingen aan CPU, geheugen, netwerk en apparaten gelden pas nadat je hem afsluit en opnieuw start. Een ISO wisselen en schijven groter maken gaat meteen.')}</p>`}
      <div class="seg vm-tabs" role="tablist" aria-label="${t('Onderdelen')}">${VM_TABS.map(([k, label]) =>
        `<button type="button" role="tab" id="vt-${k}" aria-controls="vp-${k}" aria-selected="${k === tab}" data-vtab="${k}">${t(label)}</button>`).join('')}</div>
      <form class="form" id="vmForm" novalidate>
        <section class="form" role="tabpanel" id="vp-general" aria-labelledby="vt-general" data-vpane="general">${vmNameField(d, off)}${vmDescAutoFields(d)}</section>
        <section class="form" role="tabpanel" id="vp-cpu" aria-labelledby="vt-cpu" data-vpane="cpu"></section>
        <section class="form" role="tabpanel" id="vp-net" aria-labelledby="vt-net" data-vpane="net"></section>
        <section class="form" role="tabpanel" id="vp-storage" aria-labelledby="vt-storage" data-vpane="storage"></section>
        <section class="form" role="tabpanel" id="vp-devices" aria-labelledby="vt-devices" data-vpane="devices"></section>
        <section role="tabpanel" id="vp-screen" aria-labelledby="vt-screen" data-vpane="screen">
          <div class="btn-row" style="margin-bottom:14px">${vmKind(d.state) === 'off' ? `<span class="muted">${t('Start de VM om het scherm te zien.')}</span>` : consoleLink(d.id, 'btn primary')}</div>
          <p class="muted small" style="margin-bottom:10px">${t('De console toont het scherm van de VM, met toetsenbord en muis. Met Los venster zet je ze in een eigen browservenster. Plakken (Cmd/Ctrl+V) typt de tekst van je klembord in de VM.')}</p>
          <label class="check" style="margin-bottom:4px"><input type="checkbox" name="clipboard"${d.clipboard ? ' checked' : ''}> ${t('Klembord delen met deze VM')}</label>
          <p class="muted small" style="margin-bottom:14px">${t('Nodig om tekst die je in de VM kopieert op je pc te krijgen. Installeer in de VM spice-vdagent (Linux) of de SPICE guest tools (Windows) en start de VM daarna opnieuw.')}</p>
          <p class="muted small" style="margin-bottom:10px">${t('Liever een eigen VNC-programma? Gebruik dan dit adres en wachtwoord.')}</p>
          ${vncHtml(d.vnc)}</section>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Opslaan')}</button><button class="btn" type="button" data-close>${t('Annuleren')}</button></div>
      </form>`;
    const form = $('#vmForm', body);
    const pane = (k) => $(`[data-vpane="${k}"]`, form);

    /* CPU en geheugen, met vaste kernen */
    const cores = [];
    opts.cpus.forEach((c) => { let g = cores.find((x) => x.core === c.core && x.siblings.join() === c.siblings.join()); if (!g) cores.push(g = { core: c.core, siblings: c.siblings, ids: [] }); g.ids.push(c.id); });
    const drawCpu = () => {
      const memory = form.elements.memoryGb ? Number(form.elements.memoryGb.value) * GIB : d.memory;
      const vcpus = st.pins.size || (form.elements.vcpus ? Number(form.elements.vcpus.value) : d.vcpus);
      pane('cpu').innerHTML = vmSizeFields({ ...d, vcpus, memory }, opts, st.pins.size > 0) + `
        <fieldset class="fld"><span>${t('Vaste kernen (optioneel)')}</span>
          <div class="pin-grid">${cores.map((c, i) => `<div class="pin-core"><span class="muted small">${t('Kern {n}', { n: i })}</span><div>${c.ids.map((cpu) =>
            `<label class="pin"><input type="checkbox" data-pin="${cpu}"${st.pins.has(cpu) ? ' checked' : ''}><span>${cpu}</span></label>`).join('')}</div></div>`).join('')}</div>
          <small>${t('Kies kernen om de VM altijd op die kernen te laten draaien, zoals in Unraid. Neem beide threads van een kern en laat kern 0 vrij voor de server. Niets gekozen = de server verdeelt zelf.')}</small>
          ${st.pins.size ? `<button class="btn sm" type="button" data-pin-clear style="justify-self:start">${t('Geen vaste kernen')}</button>` : ''}</fieldset>`;
    };

    /* Netwerk */
    const drawNet = () => {
      pane('net').innerHTML = `<div class="cf-list">${st.nics.map((n, i) => n.locked
        ? `<div class="cf-row cf-locked"><span class="cf-lock">🔒</span><span class="cf-text">${esc(n.type + (n.source ? ' (' + n.source + ')' : '') + ' · ' + (n.mac || ''))}
            <span class="muted">· ${t('geavanceerd, pas aan met virsh edit')}</span></span>
            <button class="cf-del" type="button" data-nic-del="${i}" aria-label="${t('Weghalen')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`
        : `<div class="cf-row nic-row">
            <select class="field" data-nic="${i}:net" aria-label="${t('Netwerk')}">${vmNetOptions(opts, n.type + ':' + n.source)}</select>
            <select class="field" data-nic="${i}:model" aria-label="${t('Soort kaart')}">${NIC_MODELS.map(([v, label]) => `<option value="${v}"${n.model === v ? ' selected' : ''}>${esc(t(label))}</option>`).join('')}</select>
            <input class="field" data-nic="${i}:mac" value="${esc(n.mac)}" placeholder="${t('MAC: automatisch')}" aria-label="${t('MAC-adres')}" spellcheck="false" autocomplete="off">
            <button class="cf-del" type="button" data-nic-del="${i}" aria-label="${t('Weghalen')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('')
        || `<p class="muted">${t('Deze VM heeft geen netwerkkaart en kan dus niet op het netwerk.')}</p>`}</div>
        <div class="btn-row"><button class="btn sm" type="button" data-nic-add${st.nics.length >= 8 ? ' disabled' : ''}>+ ${t('Netwerkkaart')}</button></div>
        <p class="muted small">${t(VM_NET_HELP)} ${t('Eigen VM-netwerken maak je bij')} <a href="#settings/vmnet">${t('Instellingen → VM-netwerken')}</a>.</p>
        <p class="muted small">${t('Het MAC-adres bepaalt welk IP-adres je router de VM geeft. Laat het staan als je router een vast adres voor de VM heeft.')}</p>`;
    };

    /* Opslag: schijven, cd-rom en opstarten */
    const drawStorage = () => {
      const cur = d.cdroms[0] || '';
      const curIso = cur && cur.startsWith(opts.isoDir + '/') ? cur.slice(opts.isoDir.length + 1) : null;
      const isoKnown = curIso && opts.isos.some((f) => f.name === curIso);
      pane('storage').innerHTML = `
        <div class="cf-list">${st.disks.map((k, i) => `<div class="cf-row disk-row${k.remove ? ' is-removed' : ''}">
            <div><div class="row-title">${esc(k.target || t('schijf'))}</div><div class="row-sub">${esc(k.source || '')}</div></div>
            <label class="disk-size"><input class="field" type="number" min="${k.size ? Math.ceil(k.size / GIB) : 1}" max="16384" step="1" data-disk="${i}:sizeGb" value="${esc(k.sizeGb)}"${k.remove ? ' disabled' : ''} aria-label="${t('Grootte in GB')}"> GB</label>
            <label class="check small"><input type="checkbox" data-disk="${i}:remove"${k.remove ? ' checked' : ''}> ${t('Loskoppelen')}</label></div>`).join('')}
          ${st.add.map((k, i) => `<div class="cf-row disk-row is-new">
            <div><div class="row-title">${t('Nieuwe schijf')}</div><div class="row-sub">${t('Komt in {dir}', { dir: esc(opts.vmDir) })}</div></div>
            <label class="disk-size"><input class="field" type="number" min="1" max="16384" step="1" data-add="${i}:sizeGb" value="${esc(k.sizeGb)}" aria-label="${t('Grootte in GB')}"> GB</label>
            <div class="disk-new-side"><select class="field cf-small" data-add="${i}:bus" aria-label="${t('Aansluiting')}"><option value="virtio"${k.bus !== 'sata' ? ' selected' : ''}>virtio</option><option value="sata"${k.bus === 'sata' ? ' selected' : ''}>SATA</option></select>
            <button class="cf-del" type="button" data-add-del="${i}" aria-label="${t('Weghalen')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div></div>`).join('')}</div>
        <div class="btn-row"><button class="btn sm" type="button" data-add-disk${st.add.length >= 4 ? ' disabled' : ''}>+ ${t('Schijf')}</button></div>
        <p class="muted small">${t('Een schijf kan alleen groter worden. Vergroot daarna ook de partitie in de VM zelf. Loskoppelen haalt de schijf uit de VM; het bestand blijft staan.')}</p>
        <div class="fld-row">
          <label class="fld"><span>${t('Cd-rom')}</span><select class="field" name="cdrom">
            <option value="">${t('Leeg')}</option>
            ${cur && !isoKnown ? `<option value="=" selected>${esc(cur)}</option>` : ''}
            ${opts.isos.map((f) => `<option value="${esc(f.name)}"${f.name === curIso ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
            <small>${t('ISO\'s uit {dir}', { dir: esc(opts.isoDir) })}</small></label>
          <label class="fld"><span>${t('Opstarten van')}</span><select class="field" name="boot">
            <option value="disk"${d.boot !== 'cdrom' ? ' selected' : ''}>${t('Eerst de schijf')}</option>
            <option value="cdrom"${d.boot === 'cdrom' ? ' selected' : ''}>${t('Eerst de cd-rom')}</option></select>
            <small>${t('Kies de cd-rom om een besturingssysteem te installeren.')}</small></label>
        </div>`;
    };

    /* Apparaten: USB en PCI */
    const drawDevices = () => {
      const usb = [...opts.usb];
      [...st.hostdevs].filter((k) => k.startsWith('usb:') && !usb.some((u) => u.key === k)).forEach((k) => usb.push({ key: k, name: k.slice(4), missing: true }));
      const busy = (p) => p.driver && !/^vfio/.test(p.driver);
      const pciMissing = [...st.hostdevs].filter((k) => k.startsWith('pci:') && !opts.pci.some((p) => p.key === k));
      pane('devices').innerHTML = `
        <h3>${t('USB')}</h3>
        <div class="dev-list">${usb.map((u) => `<label class="check dev"><input type="checkbox" data-dev="${esc(u.key)}"${st.hostdevs.has(u.key) ? ' checked' : ''}>
            <span><b>${esc(u.name)}</b> <span class="muted small">${esc(u.vendor ? u.vendor + ':' + u.product : '')}${u.missing ? ' · ' + t('niet aangesloten') : ''}</span></span></label>`).join('')
          || `<p class="muted">${t('Geen USB-apparaten gevonden. Steek er een in en open dit venster opnieuw.')}</p>`}</div>
        <p class="muted small">${t('Bijvoorbeeld een Zigbee- of Z-Wave-stick voor Home Assistant. De VM krijgt het apparaat voor zich alleen.')}</p>
        <h3>${t('PCI')}</h3>
        ${!opts.iommu ? `<p class="lead">${t('IOMMU staat uit. Zet AMD-Vi (IOMMU) aan in het BIOS en start de server opnieuw om PCI-apparaten zoals een GPU door te geven.')}</p>` : `
        <div class="dev-list">${opts.pci.map((p) => `<label class="check dev"><input type="checkbox" data-dev="${esc(p.key)}"${st.hostdevs.has(p.key) ? ' checked' : ''}>
            <span><b>${esc(p.name)}</b> <span class="muted small">${esc([t(p.kind), p.address, p.group != null ? t('groep {n}', { n: p.group }) : null].filter(Boolean).join(' · '))}</span>
            ${busy(p) ? `<span class="small temp-warn">${t('Nu in gebruik door de server (driver {driver}).', { driver: esc(p.driver) })}${p.kind === 'Beeld' ? ' ' + t('Geef je hem door, dan kan de server hem niet gebruiken zolang de VM draait (bv. Ollama).') : ''}</span>` : ''}
            ${p.groupDevices.length ? `<span class="small muted">${t('Zit in dezelfde groep als {list}. Geef die samen door.', { list: esc(p.groupDevices.map((g) => g.name).join(', ')) })}</span>` : ''}</span></label>`).join('')}
          ${pciMissing.map((k) => `<label class="check dev"><input type="checkbox" data-dev="${esc(k)}" checked><span><b>${esc(k.slice(4))}</b> <span class="muted small">${t('niet gevonden')}</span></span></label>`).join('')}</div>`}`;
    };

    drawCpu(); drawNet(); drawStorage(); drawDevices();
    const showTab = (k) => {
      $$('[data-vtab]', body).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.vtab === k)));
      $$('[data-vpane]', body).forEach((p) => { p.hidden = p.dataset.vpane !== k; });
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
      if (badMac) { showTab('net'); err.textContent = t('"{mac}" is geen geldig MAC-adres, bv. 52:54:00:12:34:56.', { mac: badMac.mac }); return; }
      const small = st.disks.find((k) => !k.remove && k.size && Number(k.sizeGb) * GIB < k.size);
      if (small) { showTab('storage'); err.textContent = t('Een schijf kan alleen groter worden. {disk} is nu {size} GB.', { disk: small.target, size: Math.ceil(small.size / GIB) }); return; }
      const out = readForm(form);
      Object.assign(out, {
        nics: st.nics.map((n) => (n.locked ? { id: n.id, locked: true } : { id: n.id || null, type: n.type, source: n.source, model: n.model, mac: n.mac.trim() })),
        hostdevs: [...st.hostdevs], cpuPins: [...st.pins].sort((a, b) => a - b),
        removeDisks: st.disks.filter((k) => k.remove).map((k) => k.target),
        resizeDisks: st.disks.filter((k) => !k.remove && k.sizeGb && (!k.size || Number(k.sizeGb) * GIB > k.size)).map((k) => ({ target: k.target, sizeGb: Number(k.sizeGb) })),
        addDisks: st.add.map((k) => ({ sizeGb: Number(k.sizeGb), bus: k.bus })),
      });
      if (out.removeDisks.length && !(await ask(t('{n} schijf/schijven loskoppelen van {name}? De bestanden blijven staan, maar de VM ziet ze niet meer.', { n: out.removeDisks.length, name: d.name }), t('Loskoppelen')))) return;
      btn.disabled = true;
      try {
        const r = await api.post('/api/vms/' + encodeURIComponent(d.id) + '/settings', out);
        toast(t('Opgeslagen: {name}', { name: r.name }) + (r.restartNeeded ? '. ' + t('Sluit de VM af en start hem opnieuw om de nieuwe instellingen te gebruiken.') : ''));
        win.close();
        await loadVms().catch(() => {});
      } catch (ex) { err.textContent = t('Opslaan lukte niet: {error}', { error: ex.message }); btn.disabled = false; }
    });
  }

  const VM_KINDS = {
    linux: { label: 'Linux', help: 'Installeer Linux vanaf een ISO, bijvoorbeeld Debian of Ubuntu Server.', vcpus: 2, memoryGb: 4, diskGb: 32 },
    windows: { label: 'Windows 11', help: 'Windows 11 met TPM en UEFI. De schijf gebruikt SATA, zodat de installer hem meteen ziet.', vcpus: 4, memoryGb: 8, diskGb: 64 },
    import: { label: 'Bestaande schijf', help: 'Gebruik een bestaand schijfbestand, zoals het qcow2-bestand van Home Assistant OS. HomeBaseOS maakt er een kopie van.', vcpus: 2, memoryGb: 4 },
  };
  async function vmCreateWindow() {
    openWindow(t('Nieuwe VM'), `<p class="lead">${t('Laden…')}</p>`);
    let opts;
    try { opts = await vmOptions(); } catch (e) { $('#winBody').innerHTML = `<p class="lead">${esc(e.message)}</p>`; return; }
    let kind = 'linux';
    const draw = (keep) => {
      const k = VM_KINDS[kind];
      const files = kind === 'import' ? opts.images : opts.isos;
      const fileLabel = t(kind === 'import' ? 'Schijfbestand' : 'Installatie-ISO');
      const blocked = opts.vmDirMissing || !files.length;
      $('#winBody').innerHTML = `
        <div class="seg kind-seg" role="radiogroup" aria-label="${t('Soort VM')}">${Object.entries(VM_KINDS).map(([key, v]) =>
          `<button type="button" role="radio" aria-checked="${key === kind}" data-kind="${key}">${esc(t(v.label))}</button>`).join('')}</div>
        <p class="lead" style="margin-top:12px">${esc(t(k.help))}</p>
        ${opts.vmDirMissing ? `<p class="lead temp-bad">${t('De map voor VM-schijven ({dir}) bestaat niet. Maak eerst een pool aan bij Opslag, of kies een map bij Instellingen → Opslag.', { dir: esc(opts.vmDir) })}</p>` : ''}
        <form class="form" id="vmForm" novalidate>
          <input type="hidden" name="kind" value="${kind}">
          <label class="fld"><span>${fileLabel}</span>
            ${files.length ? `<select class="field" name="source" required>${files.map((f) =>
              `<option value="${esc(f.name)}"${keep && keep.source === f.name ? ' selected' : ''}>${esc(f.name)} (${bytes(f.size)})</option>`).join('')}</select>`
            : `<p class="muted small">${t(kind === 'import' ? 'Er staan nog geen schijfbestanden (.qcow2, .img, .raw) in {dir}.' : 'Er staan nog geen ISO-bestanden in {dir}.', { dir: esc(opts.isoDir) })}
                ${t('Zet er een in, bijvoorbeeld via de gedeelde map of met scp, en open dit venster opnieuw.')}</p>`}
            <small>${t('Uit {dir}', { dir: esc(opts.isoDir) })}</small></label>
          ${(() => { const v = { name: keep ? keep.name : '', vcpus: k.vcpus, memory: k.memoryGb * 1073741824, diskGb: k.diskGb, autostart: false, delay: 0,
            description: keep ? keep.description : '' }; return vmNameField(v) + vmSizeFields(v, opts) + `
          <label class="fld"><span>${t('Netwerk')}</span><select class="field" name="network">${vmNetOptions(opts, keep && keep.network || opts.network)}</select>
            <small>${t(VM_NET_HELP)}</small></label>` + vmDescAutoFields(v); })()}
          <p class="muted small">${t('De VM start meteen na het aanmaken. Netwerkkaarten, schijven en apparaten pas je daarna aan bij Bewerken.')}</p>
          <p class="form-error" role="alert"></p>
          <div class="btn-row"><button class="btn primary" type="submit"${blocked ? ' disabled' : ''}>${t('Aanmaken')}</button><button class="btn" type="button" data-close>${t('Annuleren')}</button></div>
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
      err.textContent = ''; btn.disabled = true; btn.textContent = t('Aanmaken…');
      try {
        const r = await api.post('/api/vms', readForm(form));
        toast(t('Aangemaakt en gestart: {name}', { name: r.name }));
        await loadVms().catch(() => {});
        vmEditWindow(r.name, 'screen'); // meteen naar de console om de installatie te doen
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = t('Aanmaken'); }
    });
  }

  /* --- appstore (eigen pagina op #store) */
  const STORE_PAGE = 48;
  let storeLoading = null;
  function loadStore(refresh) {
    if (S.store && !refresh) { renderStore(); return Promise.resolve(); }
    if (storeLoading) return storeLoading;
    $('#storeMore').hidden = true;
    $('#storeGrid').innerHTML = `<p class="empty">${t(refresh ? 'Catalogus vernieuwen…' : 'Catalogus laden…')}</p>`;
    storeLoading = api.get('/api/store' + (refresh ? '?refresh=1' : ''))
      .then((c) => {
        S.store = c;
        const sel = $('#storeCat'), cur = sel.value;
        sel.innerHTML = `<option value="featured">${t('Aanbevolen')}</option><option value="all">${t('Alle apps')}</option>` +
          c.categories.map((k) => `<option value="${esc(k.id)}">${esc(t(k.name))}</option>`).join('');
        sel.value = cur;
        renderStore();
      })
      .catch((e) => {
        $('#storeGrid').innerHTML = `<div class="empty"><p>${esc(e.message)}</p>
          <button class="btn sm" type="button" data-store-retry style="margin-top:12px">${t('Opnieuw proberen')}</button></div>`;
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
    $('#storeSource').innerHTML = `${t('Catalogus van {source}, bijgewerkt op {when}. De templates komen van hun eigen maintainers.', { source: esc(tr(c.source)), when: esc(when) })}
      ${c.error ? `<span class="temp-warn">${t('Vernieuwen lukte niet ({error}), dit is de vorige versie.', { error: esc(tr(c.error)) })}</span>` : ''}
      <button class="linkish" type="button" data-store-refresh>${t('Nu vernieuwen')}</button>`;
    const list = storeResults();
    const shown = list.slice(0, S.storeShown);
    $('#storeGrid').innerHTML = shown.length ? shown.map((a) => `
      <button class="widget store-card" type="button" data-store="${esc(a.id)}">
        ${storeIconHtml(a)}
        <span class="store-body">
          <span class="store-name">${esc(prettyName(a.name))}${a.installed ? ` <span class="pill ok">${t('Geïnstalleerd')}</span>` : ''}${a.beta ? ' <span class="pill warn">Beta</span>' : ''}</span>
          <span class="store-by">${esc([a.maintainer, a.official ? t('officieel') : null].filter(Boolean).join(' · '))}</span>
          <span class="store-sum">${esc(tr(a.summary))}</span>
        </span>
      </button>`).join('')
      : `<p class="empty">${S.storeQuery ? t('Geen apps gevonden voor "{q}".', { q: esc(S.storeQuery) }) : t('Geen apps in deze categorie.')}</p>`;
    const more = $('#storeMore');
    more.hidden = list.length <= shown.length;
    more.textContent = t('Meer tonen ({n} over)', { n: nf0.format(list.length - shown.length) });
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

  const FIELD_GROUPS = [['Port', 'Poorten'], ['Path', 'Mappen'], ['Device', 'Apparaten'], ['Variable', 'Instellingen'], ['Label', 'Labels']];
  function storeFieldHtml(f, d) {
    const ro = /^ro\b|^r$/.test(f.mode);
    const where = f.type === 'Port' ? t('Poort in de app: {port}', { port: f.target + '/' + (f.mode || 'tcp') })
      : f.type === 'Path' ? t(ro ? 'In de app: {path} (alleen lezen)' : 'In de app: {path}', { path: f.target })
      : f.type === 'Variable' || f.type === 'Label' ? f.target : t('Apparaat op de server');
    const attrs = `name="${esc(f.key)}"${f.required ? ' required' : ''}${f.auto ? ' data-auto="1"' : ''}${f.type === 'Port' ? ' data-port="1"' : ''}`;
    const input = f.options
      ? `<select class="field" ${attrs}>${f.options.map((o) => `<option${o === f.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
      : `<input class="field" ${attrs} type="${f.type === 'Port' ? 'number' : f.mask ? 'password' : 'text'}" value="${esc(f.value)}" autocomplete="off"
          ${f.type === 'Port' ? 'min="1" max="65535"' : ''}${f.type === 'Path' && !f.value ? ` placeholder="${t('bv. {path}', { path: esc(d.sharesDir) + '/media' })}"` : ''}>`;
    return `<label class="fld"><span>${esc(tr(f.name))}${f.required ? ' <em class="req">*</em>' : ''}</span>${input}
      <small>${esc([tr(f.description), where].filter(Boolean).join(' · '))}</small></label>`;
  }
  // Krijgt de app poorten op de server? Niet bij host, geen netwerk of een eigen adres (macvlan/ipvlan).
  function storeNetPorts(d, value) {
    const n = (d.networks || []).find((x) => x.name === value);
    return !['host', 'none'].includes(value) && !(n && /^(macvlan|ipvlan)$/.test(n.driver));
  }
  function storeNetHtml(d) {
    const opts = [['bridge', t('Standaard (bridge)')], ['host', t('Host (netwerk van de server)')],
      ...(d.networks || []).map((n) => [n.name, [n.name, n.driver, n.subnet].filter(Boolean).join(' · ')])];
    return `<h3>${t('Netwerk')}</h3><div class="form">
      <label class="fld"><span>${t('Netwerk')}</span><select class="field" name="__network">${opts.map(([v, label]) =>
        `<option value="${esc(v)}"${v === d.networkDefault ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
        <small id="storeNetHelp"></small></label>
      <label class="fld" data-store-ip><span>${t('Vast IP-adres (optioneel)')}</span><input class="field" name="__ip" spellcheck="false" autocomplete="off">
        <small>${t('Leeg = Docker kiest zelf een adres.')}</small></label></div>`;
  }
  function storeSections(fields, d) {
    return FIELD_GROUPS.map(([type, title]) => {
      const list = fields.filter((f) => f.type === type);
      return list.length ? `<h3>${t(title)}</h3><div class="form">${list.map((f) => storeFieldHtml(f, d)).join('')}</div>` : '';
    }).join('');
  }

  async function storeWindow(id) {
    openWindow(t('App'), `<p class="lead">${t('Laden…')}</p>`);
    let d;
    try { d = await api.get('/api/store/apps/' + encodeURIComponent(id)); }
    catch (e) { $('#winBody').innerHTML = `<p class="lead">${t('De app kon niet geladen worden: {error}', { error: esc(e.message) })}</p>`; return; }
    $('#winTitle').textContent = prettyName(d.name);
    // Verplichte velden zonder waarde altijd tonen, ook als het template ze "geavanceerd" noemt.
    const basic = d.fields.filter((f) => !f.advanced || (f.required && !f.value));
    const adv = d.fields.filter((f) => !basic.includes(f));
    const links = [d.project && `<a href="${esc(d.project)}" target="_blank" rel="noopener">${t('Website')}</a>`,
      d.support && `<a href="${esc(d.support)}" target="_blank" rel="noopener">${t('Hulp')}</a>`].filter(Boolean).join(' · ');
    const body = $('#winBody');
    body.innerHTML = `
      <div class="store-head">${storeIconHtml(d)}
        <div><p class="store-by">${esc([d.maintainer, d.official ? t('officieel') : null].filter(Boolean).join(' · '))}</p>
          ${links ? `<p class="small">${links}</p>` : ''}</div>
      </div>
      <p class="store-overview">${esc(tr(d.overview))}</p>
      ${d.requires ? `<p class="lead"><b>${t('Vereist:')}</b> ${esc(tr(d.requires))}</p>` : ''}
      ${d.installed ? `<p class="lead temp-ok">${t('Deze app staat al op je server. Je kan hem nog eens installeren onder een andere naam.')}</p>` : ''}
      ${d.warnings.length ? `<ul class="warn-list">${d.warnings.map((w) => `<li>${esc(tr(w))}</li>`).join('')}</ul>` : ''}
      ${d.appdataMissing ? `<p class="lead temp-bad">${t('Er is nog geen map voor appgegevens ({dir}). Maak eerst een pool aan bij Opslag, of kies een map bij Instellingen → Opslag.', { dir: esc(d.appdataDir) })}</p>` : ''}
      <form class="form" id="storeForm" novalidate>
        <label class="fld"><span>${t('Naam')} <em class="req">*</em></span>
          <input class="field" name="__name" required maxlength="63" autocomplete="off" value="${esc(d.suggestedName)}">
          <small>${t('Kleine letters, cijfers, - en _. Wordt de naam van de container en van de map {dir}/naam.', { dir: esc(d.stacksDir) })}</small></label>
        ${storeNetHtml(d)}
        ${storeSections(basic, d)}
        <div class="cf-list" id="storeExtra"></div>
        <div class="btn-row"><button class="btn sm" type="button" data-xport-add>+ ${t('Poort')}</button></div>
        ${adv.length ? `<details class="adv"><summary>${t('Geavanceerd ({n})', { n: adv.length })}</summary>${storeSections(adv, d)}</details>` : ''}
        <p class="muted small">${t('Image: {image}. HomeBaseOS maakt er een compose-bestand van, dat je later ook in Dockge kan openen.', { image: esc(d.image) })}</p>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit"${d.appdataMissing ? ' disabled' : ''}>${t('Installeren')}</button>
          <button class="btn" type="button" data-close>${t('Annuleren')}</button></div>
      </form>
      <div id="storeJob" hidden>
        <p class="lead" id="jobState">${t('Installeren…')}</p>
        <pre class="logs" id="jobLog"></pre>
        <div class="btn-row" id="jobBtns" style="margin-top:12px"></div>
      </div>`;
    const form = $('#storeForm', body);
    const syncNet = () => {
      const v = form.elements.__network.value, n = (d.networks || []).find((x) => x.name === v), ports = storeNetPorts(d, v);
      $('[data-store-ip]', form).hidden = !(n && n.subnet);
      if (!(n && n.subnet)) form.elements.__ip.value = '';
      form.elements.__ip.placeholder = n && n.subnet ? n.subnet.replace(/\.\d+\/\d+$/, '.200') : '';
      $('#storeNetHelp', form).textContent = switched && v === 'bridge' ? t('Je koos zelf een poort, daarom gebruikt de app nu het standaardnetwerk (bridge). Met host luistert de app altijd op zijn eigen poorten.')
        : v === 'host' ? t('De app gebruikt het netwerk van de server en luistert op zijn eigen poorten. Pas je hieronder een poort aan, dan kiest HomeBaseOS het standaardnetwerk (bridge).')
        : !ports ? t('De app krijgt een eigen adres in je thuisnetwerk en is daar bereikbaar op de poorten van de app zelf. Pas je een poort aan, dan kiest HomeBaseOS het standaardnetwerk (bridge).')
        : n ? t('Apps in hetzelfde netwerk vinden elkaar op naam.') : t('Nieuwe netwerken maak je bij Instellingen → Docker-netwerken.');
    };
    let switched = false;
    form.elements.__network.addEventListener('change', () => { switched = false; syncNet(); });
    // Een poort aanpassen kan alleen als Docker de poorten regelt: dan zelf naar het standaardnetwerk.
    const needPorts = () => {
      if (storeNetPorts(d, form.elements.__network.value)) return;
      form.elements.__network.value = 'bridge'; switched = true; syncNet();
    };
    form.addEventListener('input', (e) => { if (e.target.dataset.port) needPorts(); });
    syncNet();
    // Extra poorten die niet in het template staan.
    const extra = [];
    const drawExtra = (focus) => {
      $('#storeExtra', form).innerHTML = extra.length ? `<h3>${t('Extra poorten')}</h3>` + extra.map((p, i) => `<div class="cf-row cf-pair">
          <input class="field" data-xport="${i}:host" value="${esc(p.host)}" inputmode="numeric" placeholder="${t('op de server')}" aria-label="${t('Poort op de server')}"><span class="cf-sep">→</span>
          <input class="field" data-xport="${i}:container" value="${esc(p.container)}" inputmode="numeric" placeholder="${t('in de app')}" aria-label="${t('Poort in de app')}">
          <select class="field cf-small" data-xport="${i}:protocol" aria-label="Protocol"><option${p.protocol !== 'udp' ? ' selected' : ''}>tcp</option><option${p.protocol === 'udp' ? ' selected' : ''}>udp</option></select>
          <button class="cf-del" type="button" data-xport-del="${i}" aria-label="${t('Weghalen')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('') : '';
      if (focus) { const x = $(`[data-xport="${focus}:host"]`, form); if (x) x.focus(); }
    };
    form.addEventListener('click', (e) => {
      if (e.target.closest('[data-xport-add]')) { needPorts(); extra.push({ host: '', container: '', protocol: 'tcp' }); drawExtra(extra.length - 1); return; }
      const del = e.target.closest('[data-xport-del]'); if (del) { extra.splice(Number(del.dataset.xportDel), 1); drawExtra(); }
    });
    form.addEventListener('input', (e) => { if (!e.target.dataset.xport) return; const [i, k] = e.target.dataset.xport.split(':'); extra[i][k] = e.target.value; });
    form.addEventListener('change', (e) => { if (e.target.dataset.xport) e.target.dispatchEvent(new Event('input', { bubbles: true })); });
    // Automatisch ingevulde appdata-mappen volgen de naam: /snel/appdata/<naam>.
    let lastName = d.suggestedName;
    form.elements.__name.addEventListener('input', (e) => {
      const n = e.target.value.trim();
      $$('[data-auto]', form).forEach((el) => { if (el.value === d.appdataDir + '/' + lastName) el.value = d.appdataDir + '/' + n; });
      lastName = n;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form), btn = $('[type=submit]', form);
      err.textContent = '';
      const missing = [...form.elements].find((el) => el.required && !el.disabled && !el.value.trim());
      if (missing) {
        const det = missing.closest('details'); if (det) det.open = true;
        err.textContent = t('Vul {field} in.', { field: missing.closest('.fld').querySelector('span').textContent.replace('*', '').trim() });
        missing.focus(); return;
      }
      const badX = extra.find((p) => (String(p.host).trim() || String(p.container).trim()) && !(/^\d{1,5}$/.test(String(p.host).trim()) && /^\d{1,5}$/.test(String(p.container).trim())));
      if (badX) { err.textContent = t('Vul bij elke extra poort twee poorten in tussen 1 en 65535.'); return; }
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

  /* --- eigen app: een image of een link naar Docker Hub, GitHub of Quay */
  function customAppWindow(prefill = '') {
    openWindow(t('Eigen app toevoegen'), `
      <p class="lead">${t('Plak de naam van een image of een link naar de pagina ervan. HomeBaseOS leest bij de registry welke poorten en mappen de app gebruikt en vult het formulier al in.')}</p>
      <form class="inline-form" id="customImgForm">
        <input class="field" name="image" value="${esc(prefill)}" placeholder="${t('bv. louislam/uptime-kuma of https://hub.docker.com/r/linuxserver/jellyfin')}" spellcheck="false" autocomplete="off" aria-label="${t('Image of link')}" required>
        <button class="btn primary" type="submit">${t('Ophalen')}</button>
      </form>
      <p class="muted small" style="margin-top:8px">${t('Werkt met Docker Hub, ghcr.io, lscr.io, quay.io en andere registries. Privé-images kunnen nog niet.')}</p>
      <p class="form-error" role="alert" id="customImgErr"></p>
      <div id="customForm"></div>`, (body) => {
      const imgForm = $('#customImgForm', body);
      imgForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('[type=submit]', imgForm), err = $('#customImgErr', body); err.textContent = '';
        btn.disabled = true; btn.textContent = t('Ophalen…');
        try { customAppForm(body, await api.post('/api/apps/custom/inspect', { image: imgForm.elements.image.value })); }
        catch (ex) { err.textContent = ex.message; }
        btn.disabled = false; btn.textContent = t('Ophalen');
      });
      if (prefill) imgForm.requestSubmit(); else imgForm.elements.image.focus();
    });
  }
  function customAppForm(body, d) {
    // Zelfde vorm als het compose-formulier, zodat we dat formulier gewoon hergebruiken.
    const f = { image: d.image, restart: 'unless-stopped', privileged: false, network: d.networkDefault === 'bridge' ? '' : d.networkDefault, ip: '', networkOther: null,
      networks: [], projectNetworks: [], build: false, otherServices: [],
      ports: d.ports.map((p) => ({ ...p, ip: '' })), volumes: d.volumes.map((v) => ({ ...v, kind: 'bind', locked: false })),
      env: d.env.map((e) => ({ ...e })), devices: [], labels: [] };
    $('#customForm', body).innerHTML = `
      ${d.storeMatch ? `<p class="lead">${t('Deze app staat ook in de appstore, met een uitgewerkt formulier.')} <button class="linkish" type="button" data-store-match="${esc(d.storeMatch.id)}">${t('Bekijk {name} in de appstore', { name: esc(prettyName(d.storeMatch.name)) })}</button></p>` : ''}
      ${d.warnings.length ? `<ul class="warn-list">${d.warnings.map((w) => `<li>${esc(tr(w))}</li>`).join('')}</ul>` : ''}
      ${d.appdataMissing ? `<p class="lead temp-bad">${t('Er is nog geen map voor appgegevens ({dir}). Maak eerst een pool aan bij Opslag, of kies een map bij Instellingen → Opslag.', { dir: esc(d.appdataDir) })}</p>` : ''}
      <form class="form" id="storeForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Naam')} <em class="req">*</em></span><input class="field" name="__name" required maxlength="63" autocomplete="off" value="${esc(d.name)}">
            <small>${t('Kleine letters, cijfers, - en _. Wordt de naam van de container en van de map {dir}/naam.', { dir: esc(d.stacksDir) })}</small></label>
          <label class="fld"><span>${t('Pictogram')} <em class="muted">${t('(optioneel)')}</em></span><input class="field" name="__icon" value="${esc(d.icon)}" placeholder="https://…" spellcheck="false" autocomplete="off"></label>
        </div>
        <label class="fld"><span>${t('Adres van de webinterface (WebUI)')} <em class="muted">${t('(optioneel)')}</em></span><input class="field" name="__webui" value="${esc(d.webui)}" placeholder="http://[IP]:[PORT:8080]/" spellcheck="false" autocomplete="off">
          <small>${t('[IP] wordt het adres van je server, [PORT:80] de poort op de server die aan poort 80 in de app hangt.')}</small></label>
        <div id="customCf"></div>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit"${d.appdataMissing ? ' disabled' : ''}>${t('Installeren')}</button>
          <button class="btn" type="button" data-close>${t('Annuleren')}</button></div>
      </form>
      <div id="storeJob" hidden>
        <p class="lead" id="jobState">${t('Installeren…')}</p>
        <pre class="logs" id="jobLog"></pre>
        <div class="btn-row" id="jobBtns" style="margin-top:12px"></div>
      </div>`;
    const form = $('#storeForm', body);
    composeFormMount($('#customCf', form), f, d.networks);
    // Mappen in de appgegevens volgen de naam: /snel/appdata/<naam>/…
    let lastName = d.name;
    form.elements.__name.addEventListener('input', (e) => {
      const n = e.target.value.trim(), from = d.appdataDir + '/' + lastName;
      f.volumes.forEach((v, i) => {
        if (v.host === from || v.host.startsWith(from + '/')) {
          v.host = d.appdataDir + '/' + n + v.host.slice(from.length);
          const inp = $(`[data-cf="volumes:${i}:host"]`, form); if (inp) inp.value = v.host;
        }
      });
      lastName = n;
    });
    body.addEventListener('click', (e) => { const m = e.target.closest('[data-store-match]'); if (m) storeWindow(m.dataset.storeMatch); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form), btn = $('[type=submit]', form); err.textContent = '';
      const name = form.elements.__name.value.trim();
      if (!name) { err.textContent = t('Vul {field} in.', { field: t('Naam') }); form.elements.__name.focus(); return; }
      const problem = composeFormCheck(f); if (problem) { err.textContent = problem; return; }
      btn.disabled = true;
      let r;
      try {
        r = await api.post('/api/apps/custom', {
          name, image: f.image, restart: f.restart, privileged: f.privileged, network: f.network || 'bridge', ip: (f.ip || '').trim(),
          ports: f.ports, volumes: f.volumes, env: f.env, devices: f.devices, labels: f.labels,
          webui: form.elements.__webui.value.trim(), icon: form.elements.__icon.value.trim(),
        });
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; return; }
      form.hidden = true; $('#storeJob', body).hidden = false;
      $('#customImgForm', body).hidden = true;
      followJob(r.job, prettyName(name), body, null);
    });
    form.elements.__name.focus();
  }
  $('#customAppBtn').addEventListener('click', () => customAppWindow());

  // Volg de installatie. Sluit je het venster, dan loopt ze gewoon door en krijg je op het einde een melding.
  async function followJob(jobId, label, body, storeId) {
    let j;
    try { j = await api.get('/api/store/jobs/' + jobId); } catch (e) { setTimeout(() => followJob(jobId, label, body, storeId), 2000); return; }
    const visible = body.isConnected;
    if (visible) { const log = $('#jobLog', body); log.textContent = j.lines.map(tr).join('\n'); log.scrollTop = log.scrollHeight; }
    if (!j.done) { setTimeout(() => followJob(jobId, label, body, storeId), 1000); return; }
    if (j.ok) {
      toast(t('Geïnstalleerd: {name}', { name: label }));
      await loadApps().catch(() => {});
      if (S.store) { const s = S.store.apps.find((x) => x.id === storeId); if (s) s.installed = true; renderStore(); }
      if (!visible) return;
      const a = S.apps.find((x) => x.name === j.name);
      const url = a && webuiUrl(a.webui);
      $('#jobState', body).textContent = t('Klaar: {name} is geïnstalleerd en gestart.', { name: label });
      $('#jobBtns', body).innerHTML = (url ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">${t('Openen')}</a>` : '') +
        `<button class="btn" type="button" data-close>${t('Sluiten')}</button>`;
    } else {
      toast(t('Installeren van {name} mislukt: {error}', { name: label, error: tr(j.error) }), true);
      if (!visible) return;
      $('#jobState', body).innerHTML = `<span class="temp-bad">${t('Installeren mislukt: {error}', { error: esc(tr(j.error)) })}</span>`;
      $('#jobBtns', body).innerHTML = `<button class="btn primary" type="button" data-job-back>${t('Terug naar het formulier')}</button><button class="btn" type="button" data-close>${t('Sluiten')}</button>`;
      $('[data-job-back]', body).addEventListener('click', () => {
        $('#storeJob', body).hidden = true; const f = $('#storeForm', body); f.hidden = false; $('[type=submit]', f).disabled = false;
      });
    }
  }

  /* --- instellingen (eigen pagina op #settings, #settings/network, #settings/docker, #settings/about) */
  const settingsTab = () => ({ '#settings/storage': 'storage', '#settings/network': 'network', '#settings/docker': 'docker', '#settings/vmnet': 'vmnet', '#settings/security': 'security', '#settings/update': 'update', '#settings/about': 'about' })[location.hash] || 'general';
  let netTimer = null;
  function showSettings() {
    const tab = settingsTab();
    $$('#setTabs [role="tab"]').forEach((a) => { a.setAttribute('aria-selected', String(a.dataset.tab === tab)); a.setAttribute('aria-checked', String(a.dataset.tab === tab)); });
    $('#setPane').setAttribute('aria-labelledby', 'tab-' + tab);
    $('#setWinTitle').textContent = t({ general: 'Algemeen', storage: 'Opslag', network: 'Netwerk', docker: 'Docker-netwerken', vmnet: 'VM-netwerken', security: 'Beveiliging', update: 'Software-update', about: 'Over' }[tab]);
    $('#setPane').scrollTop = 0;
    clearInterval(netTimer); netTimer = null;
    $('#setPane').onclick = null; $('#setPane').onchange = null;
    ({ general: generalPane, storage: storagePane, network: networkPane, docker: dockerNetPane, vmnet: vmNetPane, security: securityPane, update: updatePane, about: aboutPane })[tab]($('#setPane'));
  }

  function generalPane(el) {
    const theme = themeNow(), clock = S.config.clock || 'auto';
    const sample = (c) => new Date(2026, 0, 1, 14, 30).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit', ...clockOpts(c) });
    el.innerHTML = `
      <h2 class="pane-title">${t('Taal')}</h2>
      <p class="muted small">${t('Geldt voor iedereen die HomeBaseOS op deze server gebruikt.')}</p>
      <div class="choice-row" role="radiogroup" aria-label="${t('Taal')}">${Object.entries(LANGS).map(([k, name]) => `
        <label class="choice"><input type="radio" name="lang" value="${k}"${k === LANG ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}
      </div>
      <h2 class="pane-title">${t('Thema')}</h2>
      <p class="muted small">${t('Geldt alleen voor dit toestel.')}</p>
      <div class="choice-row" role="radiogroup" aria-label="${t('Thema')}">${[['auto', t('Automatisch')], ['light', t('Licht (ochtendnevel)')], ['dark', t('Donker (avond)')]].map(([k, name]) => `
        <label class="choice"><input type="radio" name="theme" value="${k}"${k === theme ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}
      </div>
      <h2 class="pane-title">${t('Tijdnotatie')}</h2>
      <p class="muted small">${t('Geldt voor iedereen die HomeBaseOS op deze server gebruikt.')}</p>
      <div class="choice-row" role="radiogroup" aria-label="${t('Tijdnotatie')}">${[['auto', t('Volgens de taal')], ['24', t('24 uur')], ['12', t('12 uur')]].map(([k, name]) => `
        <label class="choice"><input type="radio" name="clock" value="${k}"${k === clock ? ' checked' : ''}><span>${esc(name)} · ${esc(sample(k))}</span></label>`).join('')}
      </div>
      <div id="dtBox"><h2 class="pane-title">${t('Datum en tijd')}</h2><p class="muted small">${t('Laden…')}</p></div>
      <h2 class="pane-title">${t('Welkomstwizard')}</h2>
      <p class="muted small">${t('Overloop de basisinstellingen opnieuw: account, naam, tijdzone, opslag en tweestapsverificatie.')}</p>
      <div class="btn-row"><button class="btn" type="button" data-onb-open>${t('Welkomstwizard openen')}</button></div>`;
    el.onclick = (e) => { if (e.target.closest('[data-onb-open]')) { closeSettings(); openOnboarding(0); } };
    el.onchange = async (e) => {
      if (e.target.name === 'theme') { setTheme(e.target.value); return; }
      if (e.target.name === 'clock') {
        try {
          const r = await api.post('/api/settings', { clock: e.target.value });
          S.config.clock = r.clock || e.target.value; tickClock(); toast(t('Tijdnotatie opgeslagen.'));
        } catch (ex) { toast(ex.message, true); }
        return;
      }
      if (e.target.name !== 'lang') return;
      try {
        await api.post('/api/settings', { language: e.target.value });
        setLang(e.target.value);
        location.reload(); // alles opnieuw opbouwen in de nieuwe taal
      } catch (ex) { toast(t('Taal opslaan lukte niet: {error}', { error: ex.message }), true); }
    };
    dateTimeSection($('#dtBox', el));
  }

  /* --- Opslag: waar appgegevens, VM-schijven, ISO's en gedeelde mappen staan, en appgegevens verhuizen naar een andere pool */
  const MIGRATE_STEPS = { prepare: 'Voorbereiden', stop: 'Apps stoppen', copy: 'Kopiëren', compose: 'Compose-bestanden aanpassen', start: 'Apps starten', done: 'Klaar' };
  async function storagePane(el) {
    el.innerHTML = `<p class="lead">${t('Laden…')}</p>`;
    let d;
    try { d = await api.get('/api/storage-paths'); }
    catch (e) { el.innerHTML = `<p class="lead">${t('De opslaglocaties konden niet geladen worden: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'storage') return;
    const poolOf = (dir) => (dir ? d.pools.find((p) => dir === p.mountpoint || dir.startsWith(p.mountpoint + '/')) : null);
    const where = (k) => (d.paths[k] ? `<code>${esc(d.paths[k])}</code>${d.exists[k] ? '' : ` <span class="pill warn">${t('bestaat niet')}</span>`}` : `<span class="muted">${t('Nog niet ingesteld')}</span>`);
    const select = (k) => {
      const cur = poolOf(d.paths[k]);
      return `<select class="field sm" data-sp-pool="${k}" aria-label="${t('Pool')}">${d.pools.map((p) => `<option value="${esc(p.name)}"${cur && cur.name === p.name ? ' selected' : ''}>${esc(p.name)} · ${esc(t('{size} vrij', { size: bytes(p.free) }))}</option>`).join('')}</select>`;
    };
    const busy = d.migration && d.migration.state === 'running';
    const row = (k, title, help, btn) => `<li>
        <div><div class="row-title">${title}</div><div class="row-sub">${where(k)}</div><div class="row-sub">${help}</div></div>
        <div class="row-side btn-row">${d.pools.length ? select(k) + `<button class="btn sm${k === 'appdata' ? ' primary' : ''}" type="button" data-sp-save="${k}"${busy ? ' disabled' : ''}>${btn}</button>` : ''}</div></li>`;
    const appsText = d.apps.length ? t('Gebruikt door: {list}', { list: esc(d.apps.map((a) => a.project).join(', ')) }) : t('Nog geen apps.');
    el.innerHTML = `
      <p class="muted small">${t('Waar HomeBaseOS je gegevens bewaart. Een nieuwe pool krijgt de mappen appdata, media, backups, vms en isos.')}</p>
      ${d.pools.length ? '' : `<p class="lead">${t('Er is nog geen pool. Maak er een bij Opslag.')} <button class="btn sm" type="button" data-open="storage">${t('Opslag openen')}</button></p>`}
      <ul class="rows">
        ${row('appdata', t('Appgegevens'), appsText + (d.manual.length ? ' · ' + t('Niet met Docker Compose gestart (verhuizen niet mee): {list}', { list: esc(d.manual.join(', ')) }) : ''), t('Verhuizen'))}
        ${row('vms', t('VM-schijven'), t('Nieuwe VM\'s komen hier. Bestaande VM-schijven blijven waar ze zijn.'), t('Opslaan'))}
        ${row('isos', t('ISO\'s en schijfbestanden'), t('Zet hier installatie-ISO\'s, bv. via een gedeelde map.'), t('Opslaan'))}
        ${row('shares', t('Gedeelde mappen van Unraid-apps'), t('/mnt/user/… uit de appstore wordt deze map.'), t('Opslaan'))}
      </ul>
      <div id="spMig"></div>`;
    const mig = $('#spMig', el);
    const drawMig = (m) => {
      if (!m) { mig.innerHTML = ''; return; }
      const pct = m.step === 'copy' ? m.percent : m.state === 'done' ? 100 : null;
      mig.innerHTML = `<h2 class="pane-title">${t('Appgegevens verhuizen')}</h2>
        <p class="${m.state === 'failed' ? 'temp-bad' : m.state === 'done' ? 'temp-ok' : ''}">${esc(m.state === 'failed' ? t('Mislukt: {error}', { error: tr(m.error) }) : m.state === 'done' ? t('Klaar: de appgegevens staan nu in {dir}.', { dir: m.to }) : t(MIGRATE_STEPS[m.step] || m.step) + '…')}</p>
        ${pct != null ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
        <pre class="logs">${esc((m.lines || []).map(tr).join('\n'))}</pre>`;
    };
    drawMig(d.migration);
    // Voortgang volgen zolang een verhuis loopt.
    const follow = async () => {
      while (settingsTab() === 'storage' && setWin.open) {
        let r; try { r = await api.get('/api/storage-paths/migration'); } catch (e) { await new Promise((ok) => setTimeout(ok, 3000)); continue; }
        if (!mig.isConnected) return;
        drawMig(r.migration);
        if (!r.migration || r.migration.state !== 'running') { if (r.migration && r.migration.state === 'done') { toast(t('De appgegevens zijn verhuisd.')); loadApps().catch(() => {}); } storagePaneKeep(el); return; }
        await new Promise((ok) => setTimeout(ok, 1500));
      }
    };
    // Na afloop de lijst verversen, maar het verslag laten staan.
    const storagePaneKeep = async (box) => {
      const keep = mig.innerHTML; await storagePane(box); const m2 = $('#spMig', box); if (m2 && !m2.innerHTML) m2.innerHTML = keep;
    };
    if (busy) follow();
    el.onclick = async (e) => {
      const b = e.target.closest('[data-sp-save]'); if (!b) return;
      const kind = b.dataset.spSave, pool = $(`[data-sp-pool="${kind}"]`, el).value, p = d.pools.find((x) => x.name === pool);
      const cur = poolOf(d.paths[kind]);
      if (cur && cur.name === pool && d.exists[kind]) { toast(t('Dit staat al op {pool}.', { pool })); return; }
      if (kind === 'appdata') {
        const to = p.mountpoint + '/appdata';
        const ok = d.paths.appdata && d.exists.appdata ? await ask(t('Appgegevens verhuizen van {from} naar {to}? {apps}Alles wordt gekopieerd; de oude map blijft staan tot je ze zelf verwijdert.', {
          from: d.paths.appdata, to, apps: d.apps.length ? t('Deze apps stoppen tot het kopiëren klaar is: {list}. ', { list: d.apps.map((a) => a.project).join(', ') }) : '' }), t('Verhuizen')) : true;
        if (!ok) return;
        await withBusy(b, async () => {
          try {
            const r = await api.post('/api/storage-paths', { kind, pool });
            if (r.started) { drawMig(r.migration); $$('[data-sp-save]', el).forEach((x) => { x.disabled = true; }); follow(); }
            else { toast(t('Appgegevens komen nu in {dir}.', { dir: to })); storagePane(el); }
          } catch (ex) { toast(ex.message, true); }
        });
        return;
      }
      await withBusy(b, async () => {
        try { await api.post('/api/storage-paths', { kind, pool }); toast(t('Opgeslagen.')); storagePane(el); }
        catch (ex) { toast(ex.message, true); }
      });
    };
  }

  // Tijdzones voor een <select>, gegroepeerd per werelddeel (Europe/Brussels → Europe).
  function zoneOptions(zones, selected) {
    const groups = {};
    zones.forEach((z) => { const g = z.includes('/') ? z.split('/')[0] : t('Andere'); (groups[g] = groups[g] || []).push(z); });
    return Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((z) =>
      `<option value="${esc(z)}"${z === selected ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('')}</optgroup>`).join('');
  }

  /* --- Algemeen: datum, tijd en tijdzone van de server */
  async function dateTimeSection(box) {
    let d;
    try { d = await api.get('/api/datetime'); }
    catch (e) { box.innerHTML = `<h2 class="pane-title">${t('Datum en tijd')}</h2><p class="form-error">${esc(e.message)}</p>`; return; }
    if (!box.isConnected) return;
    const offset = d.now - Date.now(); // verschil tussen de klok van de server en die van deze computer
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const zoneOpts = zoneOptions(d.timezones, d.timezone);
    const pad = (n) => String(n).padStart(2, '0');
    // Waarde voor <input type="datetime-local"> in de tijdzone van de server.
    const localValue = (ms, tz) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    };
    const sync = d.ntp == null ? '' : d.ntp
      ? (d.synced ? `<span class="pill ok">${d.server ? t('Gelijk met {server}', { server: esc(d.server) }) : t('Gesynchroniseerd')}</span>` : `<span class="pill warn">${t('Nog niet gesynchroniseerd')}</span>`)
      : `<span class="pill">${t('Zelf ingesteld')}</span>`;
    const skew = Math.abs(offset) > 120000 ? `<p class="small" style="color:var(--warn)">${t('De klok van de server en die van deze computer verschillen {n} minuten.', { n: Math.round(Math.abs(offset) / 60000) })}</p>` : '';
    box.innerHTML = `
      <h2 class="pane-title">${t('Datum en tijd')}</h2>
      <p class="muted small">${t('De klok van de server. Apps uit de appstore krijgen dezelfde tijdzone (TZ).')}</p>
      <div class="dt-now"><div><div class="dt-clock" id="dtClock"></div><div class="muted small" id="dtDate"></div></div>${sync}</div>
      ${skew}
      <form class="form dt-form" id="dtForm">
        <label class="fld"><span>${t('Tijdzone')}</span>
          <select class="field" name="timezone"${d.editable ? '' : ' disabled'}>${zoneOpts}</select></label>
        ${browserTz && browserTz !== d.timezone && d.timezones.includes(browserTz) ? `<p class="small" style="margin-top:-4px"><button class="link-btn" type="button" data-tz="${esc(browserTz)}">${t('Gebruik {zone}, de tijdzone van deze computer', { zone: esc(browserTz.replace(/_/g, ' ')) })}</button></p>` : ''}
        <label class="check"><input type="checkbox" name="ntp"${d.ntp ? ' checked' : ''}${d.editable ? '' : ' disabled'}> ${t('Tijd automatisch instellen via internet (NTP)')}</label>
        <div data-dt="ntp"${d.ntp ? '' : ' hidden'}>
          <label class="fld"><span>${t('Tijdservers')}</span>
            <input class="field" name="servers" value="${esc(d.servers.join(' '))}" spellcheck="false" autocomplete="off"
              placeholder="${esc(d.defaultServers.length ? t('Standaard: {list}', { list: d.defaultServers.slice(0, 2).join(', ') + (d.defaultServers.length > 2 ? ', …' : '') }) : t('Standaard van Debian'))}"></label>
          <p class="muted small">${t('Laat leeg voor de standaard van Debian. Of gebruik bv. be.pool.ntp.org of het adres van je router. Meerdere servers scheid je met een spatie.')}</p>
        </div>
        <div data-dt="manual"${d.ntp ? ' hidden' : ''}>
          <label class="fld"><span>${t('Datum en tijd')}</span>
            <input class="field" type="datetime-local" name="time" value="${localValue(d.now, d.timezone)}"></label>
          <p class="small"><button class="link-btn" type="button" data-dt-now>${t('Neem de tijd van deze computer')}</button></p>
        </div>
        ${d.editable ? '' : `<p class="muted small">${t('timedatectl is niet beschikbaar op deze server.')}</p>`}
        <p class="form-error" role="alert" id="dtErr"></p>
        <div class="btn-row"><button class="btn primary" type="submit"${d.editable ? '' : ' disabled'}>${t('Opslaan')}</button></div>
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
      try { await api.post('/api/datetime', body); toast(t('Datum en tijd opgeslagen.')); dateTimeSection(box); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
  }

  async function networkPane(el) {
    el.onchange = null;
    el.innerHTML = `<p class="lead">${t('Laden…')}</p>`;
    let n;
    try { n = await api.get('/api/network'); }
    catch (e) { el.innerHTML = `<p class="lead">${t('De netwerkinstellingen konden niet geladen worden: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'network') return;
    const c = n.config;
    const linkRows = n.links.map((l) => `<li>
        <div><div class="row-title">${esc(l.name)} <span class="pill ${l.up ? 'ok' : ''}">${l.up ? t('Verbonden') : t('Niet verbonden')}</span></div>
          <div class="row-sub">${esc([l.kind === 'bridge' ? t('Bridge') : t('Netwerkkaart'), l.speed ? (l.speed >= 1000 ? nf.format(l.speed / 1000) + ' Gbit/s' : l.speed + ' Mbit/s') : null,
            l.master ? t('in bridge {name}', { name: l.master }) : null, l.mac].filter(Boolean).join(' · '))}</div></div>
        <div class="row-side">${l.ipv4.map((a) => esc(a.address) + (a.dynamic ? ' <span class="muted">(DHCP)</span>' : '')).join('<br>') || '–'}
          ${l.gateway ? `<div>${t('gateway {ip}', { ip: esc(l.gateway) })}</div>` : ''}</div></li>`).join('');
    el.innerHTML = `
      <div id="netPending"></div>
      <h2 class="pane-title">${t('Nu')}</h2>
      <ul class="rows">${linkRows || `<li><span class="muted">${t('Geen netwerkkaarten gevonden.')}</span></li>`}</ul>
      <p class="muted small" style="margin-top:8px">${t('DNS-servers: {list}', { list: esc(n.dns.join(', ') || '–') })}</p>

      <h2 class="pane-title">${t('Hostnaam')}</h2>
      <form class="inline-form" id="hostForm">
        <input class="field" name="hostname" value="${esc(n.hostname)}" maxlength="63" autocomplete="off" spellcheck="false" aria-label="${t('Hostnaam')}">
        <button class="btn" type="submit">${t('Opslaan')}</button>
      </form>
      <p class="muted small" style="margin-top:6px">${t('De naam van de server in je netwerk. De verbinding blijft gewoon werken.')}</p>

      <h2 class="pane-title">${t('IP-adres')}</h2>
      ${!n.editable ? `<p class="lead">${t('Dit netwerk wordt beheerd door {who}. HomeBaseOS kan het alleen aanpassen als Debian ifupdown gebruikt (/etc/network/interfaces), de standaard voor een server zonder desktop.', { who: esc(n.manager || t('een ander programma')) })}</p>` : `
      <form class="form" id="netForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Netwerkkaart')}</span><select class="field" name="interface">${n.physical.map((p) => `<option${c && c.interface === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
          <label class="fld"><span>${t('Adres krijgen')}</span><select class="field" name="mode">
            <option value="dhcp"${c && c.mode === 'dhcp' ? ' selected' : ''}>${t('Automatisch (DHCP van je router)')}</option>
            <option value="static"${c && c.mode === 'static' ? ' selected' : ''}>${t('Vast adres')}</option></select></label>
        </div>
        <div class="fld-row" data-static>
          <label class="fld"><span>${t('IP-adres en netmasker')}</span><input class="field" name="address" value="${esc(c ? c.address : '')}" placeholder="192.168.1.10/24" spellcheck="false">
            <small>${t('/24 betekent netmasker 255.255.255.0, wat bij de meeste thuisnetwerken past.')}</small></label>
          <label class="fld"><span>${t('Gateway')}</span><input class="field" name="gateway" value="${esc(c ? c.gateway : '')}" placeholder="192.168.1.1" spellcheck="false">
            <small>${t('Meestal het adres van je router.')}</small></label>
        </div>
        <label class="fld" data-static><span>${t('DNS-servers')}</span><input class="field" name="dns" value="${esc(c ? c.dns.join(', ') : '')}" placeholder="192.168.1.1, 1.1.1.1" spellcheck="false">
          <small>${t('Gescheiden door komma\'s.')}</small></label>
        <label class="check"><input type="checkbox" name="bridge"${c && c.bridge ? ' checked' : ''}> ${t('Bridge br0 maken voor VM\'s')}</label>
        <p class="muted small" style="margin-top:-6px">${t('Nodig om VM\'s (zoals Home Assistant) een eigen adres in je thuisnetwerk te geven. Zet daarna VM_NETWORK=bridge=br0.')}</p>
        <p class="lead">${t('Na het toepassen heb je 2 minuten om te bevestigen. Bevestig je niet, bv. omdat de server onbereikbaar werd, dan zet HomeBaseOS vanzelf de oude instellingen terug.')}</p>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit"${n.pending ? ' disabled' : ''}>${t('Toepassen')}</button></div>
      </form>`}`;

    const hostForm = $('#hostForm', el);
    hostForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button', hostForm); btn.disabled = true;
      try { const r = await api.post('/api/network/hostname', { hostname: hostForm.elements.hostname.value }); toast(t('Hostnaam is nu {name}.', { name: r.hostname })); loadOverview().catch(() => {}); }
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
        if (!(await ask(t('Netwerkinstellingen toepassen? De verbinding valt even weg. Bevestig daarna binnen 2 minuten, anders komen de oude instellingen terug.'), t('Toepassen')))) return;
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

  // Wachten op bevestiging, met aftellen. De pagina vraagt intussen de toestand op (ook bij een nieuw adres).
  function renderPending(el, p, newUrl, dhcp) {
    const box = $('#netPending', el); if (!box) return;
    const btn = $('#netForm [type=submit]', el); if (btn) btn.disabled = true;
    box.innerHTML = `<div class="notice warn">
      <p><b>${t('Nieuwe netwerkinstellingen actief.')}</b> ${t('Werkt alles? Bevestig ze dan. Anders worden ze teruggezet over')} <b id="netLeft"></b>.</p>
      ${newUrl ? `<p>${t('Het adres van de server verandert. Open')} <a href="${esc(newUrl)}">${esc(newUrl)}</a> ${t('en bevestig daar (je moet misschien opnieuw aanmelden).')}</p>` : ''}
      ${dhcp ? `<p>${t('Met DHCP kiest je router het adres. Zoek het op in je router als deze pagina niet meer bereikbaar is.')}</p>` : ''}
      <div class="btn-row"><button class="btn primary" type="button" id="netConfirm">${t('Bevestigen')}</button><button class="btn" type="button" id="netRevert">${t('Nu terugzetten')}</button></div></div>`;
    const tick = () => {
      const left = Math.max(0, Math.ceil((p.until - Date.now()) / 1000));
      const lbl = $('#netLeft', box); if (lbl) lbl.textContent = t('{n} s', { n: left });
      if (!left) { clearInterval(netTimer); setTimeout(() => location.hash === '#settings/network' && showSettings(), 4000); }
    };
    clearInterval(netTimer); tick(); netTimer = setInterval(tick, 1000);
    $('#netConfirm', box).addEventListener('click', async () => {
      try { await api.post('/api/network/confirm'); clearInterval(netTimer); toast(t('Netwerkinstellingen bevestigd.')); showSettings(); }
      catch (ex) { toast(ex.message, true); }
    });
    $('#netRevert', box).addEventListener('click', async () => {
      try { await api.post('/api/network/revert'); clearInterval(netTimer); toast(t('De oude netwerkinstellingen zijn teruggezet.')); showSettings(); }
      catch (ex) { toast(ex.message, true); }
    });
  }

  /* --- Docker-netwerken: eigen bridges en netwerken met een eigen adres in je thuisnetwerk (macvlan/ipvlan) */
  const ipNum = (ip) => ip.split('.').reduce((x, o) => x * 256 + Number(o), 0);
  const numIp = (n) => [16777216, 65536, 256, 1].map((d) => Math.floor(n / d) % 256).join('.');
  // Voorstel voor het IP-bereik: het voorlaatste achtste van het subnet, bv. 192.168.1.192/27 in een /24.
  function suggestRange(subnet) {
    const m = String(subnet || '').match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (!m || Number(m[2]) > 27) return '';
    const size = 2 ** (32 - Number(m[2])), rs = size / 8, base = ipNum(m[1]) - (ipNum(m[1]) % size);
    return numIp(base + size - 2 * rs) + '/' + (Number(m[2]) + 3);
  }
  const NET_HELP = {
    bridge: 'Apps in hetzelfde netwerk vinden elkaar op naam, bv. http://database:5432. Subnet en gateway mag je leeg laten, dan kiest Docker ze zelf.',
    macvlan: 'Elke app krijgt een eigen IP- en MAC-adres in je thuisnetwerk, zoals br0 in Unraid. Let op: de server zelf kan apps in dit netwerk niet bereiken.',
    ipvlan: 'Zoals macvlan, maar alle apps delen het MAC-adres van de server. Kies dit als je router of switch moeilijk doet met veel MAC-adressen. Ook hier kan de server zelf de apps niet bereiken.',
  };
  const BUILTIN_NET = { bridge: 'Voor apps zonder eigen netwerk', host: 'Het netwerk van de server zelf', none: 'Geen netwerk' };
  async function dockerNetPane(el) {
    el.onchange = null;
    el.innerHTML = `<p class="lead">${t('Laden…')}</p>`;
    let d;
    try { d = await api.get('/api/docker-networks'); }
    catch (e) { el.innerHTML = `<p class="lead">${t('De Docker-netwerken konden niet geladen worden: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'docker') return;
    const own = d.networks.filter((n) => !n.builtin), builtin = d.networks.filter((n) => n.builtin);
    const lan = d.parents.find((p) => p.gateway) || d.parents[0] || null;
    const row = (n) => {
      const sub = [n.subnet, n.gateway && t('gateway {ip}', { ip: n.gateway }), n.ipRange && t('adressen uit {range}', { range: n.ipRange }),
        n.parent && t('via {name}', { name: n.parent }), n.internal && t('zonder internet'), n.compose && t('van compose-project {name}', { name: n.compose }),
        n.builtin && t(BUILTIN_NET[n.name] || '')].filter(Boolean).join(' · ');
      const apps = n.containers.map((c) => esc(c.name) + (c.ip && n.driver !== 'bridge' ? ' <span class="muted">(' + esc(c.ip) + ')</span>' : '')).join(', ');
      return `<li>
        <div><div class="row-title">${esc(n.name)} <span class="pill">${esc(n.driver || '–')}</span></div>
          <div class="row-sub">${esc(sub)}</div>
          <div class="row-sub">${n.containers.length ? t('Apps: {list}', { list: apps }) : t('Nog geen apps')}</div></div>
        <div class="row-side">${n.builtin ? `<span class="muted">${t('ingebouwd')}</span>`
          : `<button class="btn sm danger" type="button" data-net-del="${esc(n.name)}"${n.containers.length ? ` disabled title="${t('Haal eerst de apps uit dit netwerk.')}"` : ''}>${t('Verwijderen')}</button>`}</div></li>`;
    };
    el.innerHTML = `
      <p class="muted small">${t('Kies een netwerk bij de instellingen van een app (compose-formulier) of bij het installeren uit de appstore.')}</p>
      <h2 class="pane-title">${t('Eigen netwerken')}</h2>
      <ul class="rows">${own.map(row).join('') || `<li><span class="muted">${t('Nog geen eigen netwerken. Maak er hieronder een aan.')}</span></li>`}</ul>
      <h2 class="pane-title">${t('Netwerk aanmaken')}</h2>
      <form class="form" id="dnForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Naam')}</span><input class="field" name="name" maxlength="63" placeholder="${t('bv. thuisnet')}" autocomplete="off" spellcheck="false"></label>
          <label class="fld"><span>${t('Soort')}</span><select class="field" name="driver">
            <option value="bridge">${t('Bridge (eigen netwerk tussen apps)')}</option>
            <option value="macvlan"${d.parents.length ? '' : ' disabled'}>${t('macvlan (eigen adres in je thuisnetwerk)')}</option>
            <option value="ipvlan"${d.parents.length ? '' : ' disabled'}>${t('ipvlan (eigen adres, zelfde MAC-adres)')}</option></select></label>
        </div>
        <p class="muted small" id="dnHelp"></p>
        <label class="fld" data-own><span>${t('Netwerkkaart')}</span><select class="field" name="parent">${d.parents.map((p) =>
          `<option value="${esc(p.name)}"${lan && lan.name === p.name ? ' selected' : ''}>${esc(p.name + (p.subnet ? ' · ' + p.subnet : ''))}</option>`).join('')}</select>
          <small>${t('De kaart (of bridge br0) die met je thuisnetwerk verbonden is.')}</small></label>
        <div class="fld-row">
          <label class="fld"><span>${t('Subnet')}</span><input class="field" name="subnet" spellcheck="false" autocomplete="off">
            <small data-bridge>${t('Leeg = Docker kiest zelf.')}</small><small data-own>${t('Het subnet van je thuisnetwerk.')}</small></label>
          <label class="fld"><span>${t('Gateway')}</span><input class="field" name="gateway" spellcheck="false" autocomplete="off">
            <small data-bridge>${t('Leeg = Docker kiest zelf.')}</small><small data-own>${t('Meestal het adres van je router.')}</small></label>
        </div>
        <label class="fld" data-own><span>${t('IP-bereik voor apps')}</span><input class="field" name="ipRange" spellcheck="false" autocomplete="off">
          <small>${t('Docker deelt adressen uit dit bereik uit. Kies een stuk dat je router niet via DHCP uitdeelt, anders kunnen er dubbele adressen komen.')}</small></label>
        <label class="check" data-bridge><input type="checkbox" name="internal"> ${t('Zonder internet (alleen verkeer tussen de apps in dit netwerk)')}</label>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Aanmaken')}</button></div>
      </form>
      <h2 class="pane-title">${t('Ingebouwd')}</h2>
      <ul class="rows">${builtin.map(row).join('')}</ul>`;

    const form = $('#dnForm', el), F = form.elements;
    const parentOf = () => d.parents.find((p) => p.name === F.parent.value) || null;
    let filled = null; // wat we zelf invulden, zodat we het bij een andere keuze weer kunnen weghalen
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
      if (!F.name.value.trim()) { err.textContent = t('Geef het netwerk een naam.'); F.name.focus(); return; }
      const ownIp = F.driver.value !== 'bridge';
      const body = { name: F.name.value.trim(), driver: F.driver.value, subnet: F.subnet.value.trim(), gateway: F.gateway.value.trim(),
        ipRange: ownIp ? F.ipRange.value.trim() : '', parent: ownIp ? F.parent.value : '', internal: !ownIp && F.internal.checked };
      btn.disabled = true;
      try { await api.post('/api/docker-networks', body); toast(t('Netwerk {name} aangemaakt.', { name: body.name })); dockerNetPane(el); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    el.onclick = async (e) => {
      const del = e.target.closest('[data-net-del]');
      if (!del) return;
      const name = del.dataset.netDel;
      if (!(await ask(t('Netwerk {name} verwijderen? Apps gebruiken het niet meer, dus er valt niets weg.', { name }), t('Verwijderen')))) return;
      del.disabled = true;
      try { await api.del('/api/docker-networks/' + encodeURIComponent(name)); toast(t('Netwerk {name} verwijderd.', { name })); dockerNetPane(el); }
      catch (ex) { toast(ex.message, true); del.disabled = false; }
    };
  }

  /* --- VM-netwerken: libvirt-netwerken (NAT of afgeschermd) en de bridges van de server */
  async function vmNetPane(el) {
    el.innerHTML = `<p class="lead">${t('Laden…')}</p>`;
    let d;
    try { d = await api.get('/api/vm-networks'); }
    catch (e) { el.innerHTML = `<p class="lead">${t('De VM-netwerken konden niet geladen worden: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'vmnet') return;
    const vmsText = (list) => (list.length ? t("VM's: {list}", { list: esc(list.join(', ')) }) : t("Nog geen VM's"));
    // Eerste vrije 192.168.1xx.0/24 als voorstel.
    let suggest = '';
    for (let i = 150; i < 250 && !suggest; i++) { const c = '192.168.' + i + '.0/24'; if (!d.networks.some((n) => n.subnet === c)) suggest = c; }
    el.innerHTML = `
      <p class="muted small">${t('Kies het netwerk van een VM bij Bewerken → Netwerk, of bij het aanmaken.')}</p>
      <h2 class="pane-title">${t('Thuisnetwerk (bridges)')}</h2>
      <ul class="rows">${d.bridges.map((b) => `<li>
          <div><div class="row-title">${esc(b.name)} <span class="pill ${b.up ? 'ok' : ''}">${t('Bridge')}</span></div>
            <div class="row-sub">${esc(b.address || t('geen IP-adres'))}</div><div class="row-sub">${vmsText(b.vms)}</div></div>
          <div class="row-side"></div></li>`).join('')
        || `<li><span class="muted">${t('Nog geen bridge. Maak br0 aan bij')} <a href="#settings/network">${t('Instellingen → Netwerk')}</a> ${t("om VM's een eigen adres in je thuisnetwerk te geven.")}</span></li>`}</ul>
      <p class="muted small" style="margin-top:8px">${t('Een VM op een bridge is een gewoon toestel in je thuisnetwerk: je router geeft hem een adres. Nodig voor Home Assistant.')}</p>
      <h2 class="pane-title">${t('VM-netwerken')}</h2>
      <ul class="rows">${d.networks.map((n) => `<li>
          <div><div class="row-title">${esc(n.name)} <span class="pill">${esc(t(NET_MODE[n.mode] || n.mode))}</span>${n.active ? '' : ` <span class="pill warn">${t('niet actief')}</span>`}</div>
            <div class="row-sub">${esc([n.subnet, n.dhcp && t('DHCP {start} – {end}', n.dhcp), n.bridge && t('via {name}', { name: n.bridge })].filter(Boolean).join(' · '))}</div>
            <div class="row-sub">${vmsText(n.vms)}</div></div>
          <div class="row-side btn-row">${n.active ? '' : `<button class="btn sm" type="button" data-vmnet-start="${esc(n.name)}">${t('Starten')}</button>`}
            ${n.builtin ? `<span class="muted">${t('standaard')}</span>` : `<button class="btn sm danger" type="button" data-vmnet-del="${esc(n.name)}"${n.vms.length ? ` disabled title="${t("Kies voor deze VM's eerst een ander netwerk.")}"` : ''}>${t('Verwijderen')}</button>`}</div></li>`).join('')
        || `<li><span class="muted">${t('Nog geen VM-netwerken.')}</span></li>`}</ul>
      <h2 class="pane-title">${t('VM-netwerk aanmaken')}</h2>
      <form class="form" id="vnForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Naam')}</span><input class="field" name="name" maxlength="32" placeholder="${t('bv. labo')}" autocomplete="off" spellcheck="false"></label>
          <label class="fld"><span>${t('Soort')}</span><select class="field" name="mode">
            <option value="nat">${t('NAT (met internet)')}</option><option value="isolated">${t('Afgeschermd (zonder internet)')}</option></select></label>
        </div>
        <p class="muted small" id="vnHelp"></p>
        <label class="fld"><span>${t('Subnet')}</span><input class="field" name="subnet" value="${esc(suggest)}" spellcheck="false" autocomplete="off">
          <small>${t('Een privé-subnet dat nog nergens gebruikt wordt. De server krijgt het eerste adres.')}</small></label>
        <label class="check"><input type="checkbox" name="dhcp" checked> ${t("Adressen uitdelen met DHCP (de VM's krijgen vanzelf een adres)")}</label>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Aanmaken')}</button></div>
      </form>`;
    const form = $('#vnForm', el), F = form.elements;
    const help = { nat: "De VM's kunnen naar internet en naar elkaar, maar je bereikt ze niet vanuit je thuisnetwerk. Handig om iets uit te proberen.",
      isolated: "De VM's kunnen alleen elkaar en de server bereiken, niet het internet. Handig voor een afgeschermd labo." };
    const sync = () => { $('#vnHelp', form).textContent = t(help[F.mode.value]); };
    F.mode.addEventListener('change', sync); sync();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', form), btn = $('[type=submit]', form); err.textContent = '';
      if (!F.name.value.trim()) { err.textContent = t('Geef het netwerk een naam.'); F.name.focus(); return; }
      btn.disabled = true;
      try {
        const r = await api.post('/api/vm-networks', { name: F.name.value.trim(), mode: F.mode.value, subnet: F.subnet.value.trim(), dhcp: F.dhcp.checked });
        toast(t('Netwerk {name} aangemaakt.', { name: r.name })); vmNetPane(el);
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
      if (!(await ask(t("VM-netwerk {name} verwijderen? Geen enkele VM gebruikt het nog.", { name }), t('Verwijderen')))) return;
      del.disabled = true;
      try { await api.del('/api/vm-networks/' + encodeURIComponent(name)); toast(t('Netwerk {name} verwijderd.', { name })); vmNetPane(el); }
      catch (ex) { toast(ex.message, true); del.disabled = false; }
    };
  }

  /* --- Gedeelde mappen (Samba) en hun gebruikers: een eigen venster, bovenaan in het menu */
  function sharesWindow() {
    openWindow(t('Gedeelde mappen'), `<p class="lead">${t('Laden…')}</p>`, (body) => sharesPane(body));
    onWinClose = () => loadShares(); // de widget bijwerken na wijzigingen
  }
  const ACCESS = { ro: 'Lezen', rw: 'Lezen en schrijven' };
  async function sharesPane(el, editing) {
    el.onchange = null;
    el.innerHTML = `<p class="lead">${t('Laden…')}</p>`;
    let d;
    try { d = await api.get('/api/shares'); } catch (e) { el.innerHTML = `<p class="lead">${t('De gedeelde mappen konden niet geladen worden: {error}', { error: esc(e.message) })}</p>`; return; }
    if (!el.isConnected) return; // venster intussen dicht of iets anders geopend
    if (!d.installed) {
      el.innerHTML = `<p class="lead">${t('Samba is nog niet geïnstalleerd. Voer install.sh opnieuw uit, of op de server: sudo apt install samba')}</p>`;
      return;
    }
    if (editing !== undefined) return shareForm(el, d, editing);
    const host = d.hostname;
    el.innerHTML = `
      ${d.running ? '' : `<p class="lead temp-warn">${t('Samba draait niet. Start het op de server met: sudo systemctl start smbd')}</p>`}
      <div class="bays-head"><h2 class="pane-title" style="margin:0">${t('Mappen')}</h2>
        <button class="btn sm primary" type="button" data-share-new${d.users.length ? '' : ` disabled title="${t('Maak eerst een gebruiker aan.')}"`}>+ ${t('Gedeelde map')}</button></div>
      <ul class="rows">${d.shares.map((sh) => `<li>
          <div><div class="row-title">${esc(sh.name)}</div>
            <div class="row-sub">${esc([sh.path, sh.comment].filter(Boolean).join(' · '))}</div>
            <div class="share-access">${Object.entries(sh.users).map(([u, a]) => `<span class="pill${a === 'rw' ? ' ok' : ''}">${esc(u)} · ${t(a === 'rw' ? 'schrijven' : 'lezen')}</span>`).join('')}
              ${sh.guest ? `<span class="pill warn">${t('gasten · lezen')}</span>` : ''}${sh.timemachine ? `<span class="pill">Time Machine</span>` : ''}</div>
            <div class="share-addr">smb://${esc(host)}.local/${esc(sh.name)} · \\\\${esc(host)}\\${esc(sh.name)}</div></div>
          <div class="row-side btn-row"><button class="btn sm" type="button" data-share-edit="${esc(sh.name)}">${t('Bewerken')}</button>
            <button class="btn sm danger" type="button" data-share-del="${esc(sh.name)}">${t('Verwijderen')}</button></div></li>`).join('')
        || `<li><span class="muted">${t(d.users.length ? 'Nog geen gedeelde mappen.' : 'Nog geen gedeelde mappen. Maak eerst hieronder een gebruiker aan.')}</span></li>`}</ul>
      <p class="muted small" style="margin-top:8px">${t('Op een Mac: Finder → Ga → Verbind met server. Op Windows: typ het adres met \\\\ in de Verkenner.')}</p>

      <h2 class="pane-title">${t('Gebruikers')}</h2>
      <p class="muted small">${t('Met deze gebruikers en hun wachtwoord meld je aan bij een gedeelde map. Ze kunnen niet aanmelden op de server zelf.')}</p>
      <ul class="rows" style="margin-top:8px">${d.users.map((u) => `<li>
          <div><div class="row-title">${esc(u.name)}${u.managed ? '' : ` <span class="pill">${t('bestond al')}</span>`}</div>
            <div class="row-sub">${u.shares.length ? t('Toegang tot: {list}', { list: esc(u.shares.join(', ')) }) : t('Nog geen toegang')}</div>
            <form class="inline-form" data-pw-form="${esc(u.name)}" hidden style="margin-top:8px">
              <input class="field" type="password" name="password" autocomplete="new-password" placeholder="${t('Nieuw wachtwoord (minstens 8 tekens)')}" aria-label="${t('Nieuw wachtwoord')}">
              <button class="btn sm primary" type="submit">${t('Opslaan')}</button></form></div>
          <div class="row-side btn-row"><button class="btn sm" type="button" data-pw="${esc(u.name)}">${t('Wachtwoord')}</button>
            ${u.managed ? `<button class="btn sm danger" type="button" data-user-del="${esc(u.name)}">${t('Verwijderen')}</button>` : ''}</div></li>`).join('')
        || `<li><span class="muted">${t('Nog geen gebruikers.')}</span></li>`}</ul>
      <h2 class="pane-title">${t('Gebruiker toevoegen')}</h2>
      <form class="form" id="userForm" novalidate>
        <div class="fld-row">
          <label class="fld"><span>${t('Gebruikersnaam')}</span><input class="field" name="name" maxlength="32" autocomplete="off" spellcheck="false" placeholder="${t('bv. lies')}">
            <small>${t('Kleine letters, cijfers, - en _.')}</small></label>
          <label class="fld"><span>${t('Wachtwoord')}</span><input class="field" type="password" name="password" autocomplete="new-password">
            <small>${t('Minstens 8 tekens.')}</small></label>
          <label class="fld"><span>${t('Wachtwoord herhalen')}</span><input class="field" type="password" name="password2" autocomplete="new-password"></label>
        </div>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Gebruiker toevoegen')}</button></div>
      </form>`;
    const uf = $('#userForm', el);
    uf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('.form-error', uf), F = uf.elements; err.textContent = '';
      if (F.password.value !== F.password2.value) { err.textContent = t('De twee wachtwoorden zijn niet gelijk.'); return; }
      const btn = $('[type=submit]', uf); btn.disabled = true;
      try { await api.post('/api/share-users', { name: F.name.value.trim(), password: F.password.value }); toast(t('Gebruiker {name} toegevoegd.', { name: F.name.value.trim() })); sharesPane(el); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    $$('[data-pw-form]', el).forEach((f) => f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.post('/api/share-users/' + encodeURIComponent(f.dataset.pwForm) + '/password', { password: f.elements.password.value }); toast(t('Wachtwoord van {name} gewijzigd.', { name: f.dataset.pwForm })); f.hidden = true; f.reset(); }
      catch (ex) { toast(ex.message, true); }
    }));
    el.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.shareNew != null) return sharesPane(el, null);
      if (b.dataset.shareEdit) return sharesPane(el, b.dataset.shareEdit);
      if (b.dataset.pw) { const f = $(`[data-pw-form="${CSS.escape(b.dataset.pw)}"]`, el); f.hidden = !f.hidden; if (!f.hidden) f.elements.password.focus(); return; }
      if (b.dataset.shareDel) {
        const name = b.dataset.shareDel;
        if (!(await ask(t('{name} niet meer delen? De bestanden blijven gewoon staan; alleen het delen stopt.', { name }), t('Verwijderen')))) return;
        try { await api.del('/api/shares/' + encodeURIComponent(name)); toast(t('{name} wordt niet meer gedeeld.', { name })); sharesPane(el); } catch (ex) { toast(ex.message, true); }
        return;
      }
      if (b.dataset.userDel) {
        const name = b.dataset.userDel;
        if (!(await ask(t('Gebruiker {name} verwijderen? Die kan dan niet meer aan de gedeelde mappen.', { name }), t('Verwijderen')))) return;
        try { await api.del('/api/share-users/' + encodeURIComponent(name)); toast(t('Gebruiker {name} verwijderd.', { name })); sharesPane(el); } catch (ex) { toast(ex.message, true); }
      }
    };
  }

  // Nieuwe of bestaande gedeelde map: naam, map, wie mag wat, gasten en Time Machine.
  function shareForm(el, d, editName) {
    const cur = editName ? d.shares.find((x) => x.name === editName) : null;
    const pools = d.roots.filter((r) => !r.name.includes('/'));
    const sh = cur || { name: '', path: '', comment: '', users: {}, guest: false, timemachine: false };
    el.onclick = null;
    el.innerHTML = `
      <h2 class="pane-title">${cur ? t('{name} bewerken', { name: esc(cur.name) }) : t('Nieuwe gedeelde map')}</h2>
      <form class="form" id="shareForm" novalidate>
        <label class="fld"><span>${t('Naam')}</span><input class="field" name="name" maxlength="32" value="${esc(sh.name)}" autocomplete="off" spellcheck="false" placeholder="${t('bv. media')}">
          <small>${t('Zo heet de map op je pc: smb://{host}.local/naam', { host: esc(d.hostname) })}</small></label>
        ${cur ? `<input type="hidden" name="where" value="existing">` : `
        <fieldset class="fld"><span>${t('Map')}</span><div class="radio-row">
          <label class="check"><input type="radio" name="where" value="new"${pools.length ? ' checked' : ' disabled'}> ${t('Nieuwe map op een pool')}</label>
          <label class="check"><input type="radio" name="where" value="existing"${pools.length ? '' : ' checked'}> ${t('Bestaande map')}</label></div></fieldset>`}
        <label class="fld" data-where="new"><span>${t('Pool')}</span><select class="field" name="parent">${pools.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} (${esc(p.mountpoint)})</option>`).join('')}</select>
          <small>${t('HomeBaseOS maakt een eigen dataset, bv. tank/media, met de app-gebruiker als eigenaar.')}</small></label>
        <label class="fld" data-where="existing"><span>${t('Map op de server')}</span><input class="field" name="path" list="shareRoots" value="${esc(sh.path)}" spellcheck="false" autocomplete="off" placeholder="/tank/media">
          <datalist id="shareRoots">${d.roots.map((r) => `<option value="${esc(r.mountpoint)}">`).join('')}</datalist>
          <small>${t('Een map op een van je pools.')}${d.appUser ? ' ' + t('Bestanden worden geschreven als {user}, zoals je Docker-apps.', { user: esc(d.appUser) }) : ''}</small></label>
        <label class="fld"><span>${t('Beschrijving')} <em class="muted">${t('(optioneel)')}</em></span><input class="field" name="comment" maxlength="100" value="${esc(sh.comment)}"></label>
        <fieldset class="fld"><span>${t('Wie mag erbij?')}</span>
          <div class="access-table">${d.users.map((u) => `<div class="access-row"><b>${esc(u.name)}</b>
            <select class="field" name="u:${esc(u.name)}" aria-label="${esc(t('Toegang voor {name}', { name: u.name }))}">
              <option value="">${t('Geen toegang')}</option>${Object.entries(ACCESS).map(([k, label]) => `<option value="${k}"${sh.users[u.name] === k ? ' selected' : ''}>${t(label)}</option>`).join('')}</select></div>`).join('')}</div></fieldset>
        <label class="check"><input type="checkbox" name="guest"${sh.guest ? ' checked' : ''}> ${t('Gasten mogen lezen zonder wachtwoord')}</label>
        <p class="muted small" style="margin-top:-6px">${t('Handig voor bv. muziek of documenten voor iedereen thuis. Schrijven kan alleen wie hierboven Lezen en schrijven heeft.')}</p>
        <label class="check"><input type="checkbox" name="timemachine"${sh.timemachine ? ' checked' : ''}> ${t('Gebruiken voor Time Machine (back-ups van een Mac)')}</label>
        <p class="form-error" role="alert"></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t(cur ? 'Opslaan' : 'Delen')}</button><button class="btn" type="button" data-share-cancel>${t('Annuleren')}</button></div>
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
      const where = (f.querySelector('[name=where]:checked') || F.where).value;
      const body = { name: F.name.value.trim(), comment: F.comment.value, users, guest: F.guest.checked, timemachine: F.timemachine.checked,
        ...(where === 'new' ? { create: { parent: F.parent.value } } : { path: F.path.value.trim() }) };
      btn.disabled = true;
      try {
        await api.post('/api/shares' + (cur ? '/' + encodeURIComponent(cur.name) : ''), body);
        toast(t(cur ? '{name} opgeslagen.' : '{name} wordt nu gedeeld.', { name: body.name }));
        sharesPane(el);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    F.name.focus();
  }

  /* --- Beveiliging: de terminal op de server */
  async function securityPane(el) {
    el.innerHTML = `<p class="lead">${t('Laden…')}</p>`;
    let cur;
    try { cur = await api.get('/api/settings'); } catch (e) { el.innerHTML = `<p class="lead">${esc(e.message)}</p>`; return; }
    if (settingsTab() !== 'security') return;
    const needsPw = !S.config.demo && S.config.passwordEnabled;
    el.innerHTML = `
      <div id="mfaBox"><p class="lead">${t('Laden…')}</p></div>
      ${S.config.passwordEnabled ? `<h2 class="pane-title">${t('Wachtwoord')}</h2>
      <p class="muted small" id="pwChanged"></p>
      <form class="form" id="pwForm" style="max-width:440px">${passwordFields()}
        <p class="form-error" role="alert" data-pw-err></p>
        <div class="btn-row"><button class="btn primary" type="submit">${t('Wachtwoord wijzigen')}</button></div></form>` : ''}
      <h2 class="pane-title">${t('Terminal op de server')}</h2>
      <p class="muted small">${t('Rechtsboven opent het terminal-icoon een root-shell op de server. Wie de terminal kan openen, kan alles op de server doen: bestanden wissen, schijven formatteren, wachtwoorden lezen.')}</p>
      <div class="form" style="margin-top:12px">
        <label class="check"><input type="checkbox" name="terminal"${cur.terminal ? ' checked' : ''}> ${t('Terminal op de server toestaan')}</label>
        <label class="check"><input type="checkbox" name="terminalPassword"${cur.terminalPassword ? ' checked' : ''}${cur.terminal ? '' : ' disabled'}> ${t('Wachtwoord opnieuw vragen bij het openen van de terminal')}</label>
        <p class="muted small" style="margin-top:-4px">${t('Aanbevolen. Zo kan iemand die een aangemelde browser gebruikt (bv. een gedeelde pc) niet meteen root-commando\'s uitvoeren.')}</p>
      </div>
      <form class="inline-form sec-confirm" id="secConfirm" hidden>
        <input class="field" type="password" name="password" autocomplete="current-password" placeholder="${t('Wachtwoord van HomeBaseOS')}" aria-label="${t('Wachtwoord van HomeBaseOS')}">
        <button class="btn primary" type="submit">${t('Bevestigen')}</button><button class="btn" type="button" data-sec-cancel>${t('Annuleren')}</button>
      </form>
      <p class="muted small" id="secHint" hidden>${t('Dit maakt de beveiliging minder streng. Typ je wachtwoord om te bevestigen.')}</p>
      <p class="form-error" role="alert" id="secErr"></p>
      <p class="muted small">${t('Elke keer dat iemand de terminal opent of sluit, komt dat in het systeemlogboek (journalctl -u homebaseos).')}</p>`;
    mfaSection($('#mfaBox', el));
    const pwForm = $('#pwForm', el);
    if (pwForm) {
      wirePasswordMeter(pwForm);
      api.get('/api/mfa').then((m) => { if ($('#pwChanged', el)) $('#pwChanged', el).textContent = m.passwordChanged ? t('Laatst gewijzigd op {date}.', { date: longDate(m.passwordChanged) }) : t('Je gebruikt nog het wachtwoord uit de installatie (in /etc/homebaseos/homebaseos.env).'); }, () => {});
      pwForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button[type="submit"]', pwForm); btn.disabled = true;
        try { await submitPassword(pwForm); pwForm.reset(); wirePasswordMeter(pwForm); toast(t('Je nieuwe wachtwoord is ingesteld. Andere browsers zijn afgemeld.')); securityPane(el); }
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
        toast(t('Beveiliging opgeslagen.'));
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

  /* --- Beveiliging: tweestapsverificatie (TOTP met een authenticator-app) */
  async function mfaSection(box) {
    let st;
    try { st = await api.get('/api/mfa'); } catch (e) { box.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; return; }
    if (!box.isConnected) return;
    const head = box.dataset.noHead ? '' : `<h2 class="pane-title">${t('Tweestapsverificatie')}</h2>
      <p class="muted small">${t('Naast je wachtwoord vraagt HomeBaseOS dan een code van 6 cijfers uit een authenticator-app op je gsm (bv. Google Authenticator, Microsoft Authenticator, 1Password of Aegis). Wie alleen je wachtwoord kent, kan zo niet aanmelden.')}</p>`;
    if (!st.available) { box.innerHTML = head + `<p class="muted small">${t('Zet eerst een wachtwoord (APP_PASSWORD) om tweestapsverificatie te gebruiken.')}</p>`; return; }
    const demoHint = S.config.demo ? `<p class="muted small">${t('Demo: het wachtwoord is {pw}.', { pw: '<b>demo</b>' })}</p>` : '';
    const since = st.since ? new Date(st.since).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    box.innerHTML = head + (st.enabled ? `
      <div class="mfa-state on"><span class="dot"></span><div><b>${t('Aan')}</b>
        <div class="muted small">${since ? t('Sinds {date}.', { date: esc(since) }) + ' ' : ''}${t('Nog {n} herstelcodes over.', { n: st.recoveryLeft })}</div></div></div>
      ${st.recoveryLeft < 3 ? `<p class="small" style="color:var(--warn)">${t('Je hebt bijna geen herstelcodes meer. Maak nieuwe aan.')}</p>` : ''}
      <div class="btn-row"><button class="btn" type="button" data-mfa="recovery">${t('Nieuwe herstelcodes')}</button>
        <button class="btn danger" type="button" data-mfa="disable">${t('Uitzetten')}</button></div>` : `
      <div class="mfa-state"><span class="dot"></span><div><b>${t('Uit')}</b><div class="muted small">${t('Aanmelden vraagt alleen je wachtwoord.')}</div></div>
        <button class="btn primary" type="button" data-mfa="start">${t('Aanzetten')}</button></div>`) +
      `<div id="mfaStep"></div><p class="form-error" role="alert" id="mfaErr"></p>`;
    const step = $('#mfaStep', box), errEl = $('#mfaErr', box);
    const pwForm = (label, withCode) => `${demoHint}
      <form class="inline-form" data-mfa-form>
        <input class="field" type="password" name="password" autocomplete="current-password" required placeholder="${t('Wachtwoord van HomeBaseOS')}" aria-label="${t('Wachtwoord van HomeBaseOS')}">
        ${withCode ? `<input class="field mfa-code" name="code" required autocomplete="one-time-code" maxlength="11" placeholder="${t('Code')}" aria-label="${t('Code uit de app of een herstelcode')}">` : ''}
        <button class="btn primary" type="submit">${esc(label)}</button><button class="btn" type="button" data-mfa-cancel>${t('Annuleren')}</button>
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
            <li>${t('Open je authenticator-app en scan deze QR-code.')}</li>
            <li>${t('Lukt scannen niet? Typ dan deze sleutel in de app:')}<br>
              <button class="mfa-secret" type="button" data-copy="${esc(r.secret)}" title="${t('Kopiëren')}">${esc(group(r.secret))}</button><br>
              <a class="small" href="${esc(r.uri)}">${t('Of open de sleutel meteen in een app op dit toestel')}</a></li>
            <li>${t('Typ de code van 6 cijfers die de app nu toont:')}
              <form class="inline-form" data-mfa-form style="margin-top:6px">
                <input class="field mfa-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required aria-label="${t('Code uit je authenticator-app')}">
                <button class="btn primary" type="submit">${t('Bevestigen')}</button><button class="btn" type="button" data-mfa-cancel>${t('Annuleren')}</button>
              </form></li>
          </ol>
        </div>`, 'enable');
      $('.mfa-code', step).focus();
    }
    function showRecovery(codes, fresh) {
      const text = t('Herstelcodes voor HomeBaseOS') + '\n\n' + codes.join('\n') + '\n\n' + t('Elke code werkt maar één keer.') + '\n';
      box.innerHTML = head + `
        <div class="mfa-state on"><span class="dot"></span><div><b>${fresh ? t('Tweestapsverificatie staat aan') : t('Nieuwe herstelcodes')}</b>
          <div class="muted small">${t('Bewaar deze herstelcodes op een veilige plaats, bv. in je wachtwoordbeheerder. Ben je je gsm kwijt, dan meld je je aan met een van deze codes. Elke code werkt maar één keer, en je ziet ze hier maar één keer.')}</div></div></div>
        <ul class="recovery-list">${codes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
        <div class="btn-row"><button class="btn" type="button" data-rc="copy">${t('Kopiëren')}</button>
          <button class="btn" type="button" data-rc="download">${t('Downloaden')}</button>
          <button class="btn primary" type="button" data-rc="done">${t('Ik heb ze bewaard')}</button></div>`;
      box.onclick = async (e) => {
        const b = e.target.closest('[data-rc]'); if (!b) return;
        if (b.dataset.rc === 'copy') {
          try { await navigator.clipboard.writeText(text); toast(t('Gekopieerd.')); } catch (ex) { toast(t('Kopiëren lukte niet in deze browser.'), true); }
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
      if (b.dataset.mfa === 'start') showStep(`<p class="small">${t('Typ je wachtwoord om te beginnen.')}</p>` + pwForm(t('Verder')), 'setup');
      if (b.dataset.mfa === 'recovery') showStep(`<p class="small">${t('Typ je wachtwoord en een code uit de app. Je oude herstelcodes werken daarna niet meer.')}</p>` + pwForm(t('Nieuwe codes maken'), true), 'recovery');
      if (b.dataset.mfa === 'disable') {
        if (!(await ask(t('Tweestapsverificatie uitzetten? Dan volstaat je wachtwoord weer om aan te melden.'), t('Uitzetten')))) return;
        showStep(`<p class="small">${t('Typ je wachtwoord en een code uit de app om tweestapsverificatie uit te zetten.')}</p>` + pwForm(t('Uitzetten'), true), 'disable');
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
          if (!S.config.demo) toast(t('Andere browsers zijn afgemeld. Ze moeten opnieuw aanmelden, nu met een code.'));
          return showRecovery(r.recovery, true);
        }
        if (action === 'recovery') return showRecovery(r.recovery, false);
        toast(t('Tweestapsverificatie staat uit.'));
        mfaSection(box);
      } catch (ex) {
        errEl.textContent = ex.message; btn.disabled = false;
        const inp = f.elements.code || f.elements.password; if (inp) inp.select();
        if (ex.status === 410) mfaSection(box).then(() => { $('#mfaErr', box).textContent = ex.message; });
      }
    };
  }

  /* --- Software-update: nieuwe versies van HomeBaseOS zelf (GitHub-releases) */
  // Kleine Markdown-lezer voor release-notes. Eerst alles door esc(), daarna pas opmaak: er komt nooit HTML van GitHub door.
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

  // Melding: rood bolletje op Instellingen en op het tabblad, en één keer per versie een melding (per browser).
  S.update = null;
  async function loadUpdate() {
    try { S.update = await api.get('/api/update'); } catch (e) { return; }
    const u = S.update, on = !!(u && u.updateAvailable);
    $('#updDot').hidden = !on; $('#updTabBadge').hidden = !on;
    $('#updTabBadge').textContent = on ? String(u.newer.length) : '';
    if (!on) return;
    let seen = null;
    try { seen = localStorage.getItem('tb-update-seen'); } catch (e) { /* privévenster */ }
    if (seen === u.latest.version) return;
    try { localStorage.setItem('tb-update-seen', u.latest.version); } catch (e) { /* privévenster */ }
    toast(t('HomeBaseOS {version} is beschikbaar. Bekijk de nieuwigheden bij Instellingen → Software-update.', { version: u.latest.version }));
  }

  // Voortgang van "Nu bijwerken". Tijdens de herstart is de server even weg: dan blijven we gewoon vragen.
  const UPD_STEPS = [['download', 'Downloaden'], ['extract', 'Uitpakken'], ['verify', 'Controleren'], ['backup', 'Reservekopie'],
    ['install', 'Installeren'], ['restart', 'Herstarten'], ['check', 'Testen']];
  const UPD_ORDER = ['start', 'download', 'extract', 'verify', 'handover', 'backup', 'install', 'packages', 'restart', 'check', 'rollback', 'done'];
  function updateProgress(el) {
    el.onclick = null; el.onchange = null;
    el.innerHTML = `<div class="upd-run" aria-live="polite">
        <div class="upd-run-head"><b id="updTitle">${t('Bijwerken…')}</b><span class="muted small" id="updPct">0%</span></div>
        <div class="upd-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-labelledby="updTitle"><span id="updFill"></span></div>
        <p class="small" id="updMsg">${t('Bijwerken starten…')}</p>
        <ol class="upd-steps">${UPD_STEPS.map(([k, label]) => `<li data-step="${k}">${t(label)}</li>`).join('')}</ol>
        <p class="muted small" id="updNote">${t('Laat dit venster open. HomeBaseOS herstart straks even; je apps en VM\'s blijven draaien.')}</p>
        <div class="btn-row" id="updBtns"></div></div>`;
    let lost = 0, shown = 0;
    const started = Date.now();
    const draw = (p) => {
      const pct = Math.max(shown, Math.min(100, Math.round(p.percent || 0))); shown = pct;
      $('#updFill', el).style.width = pct + '%';
      $('.upd-bar', el).setAttribute('aria-valuenow', String(pct));
      $('#updPct', el).textContent = pct + '%';
      let msg = tr(p.message || '');
      if (p.step === 'download' && p.bytes) msg = t('Versie {version} downloaden… {done}', { version: p.version, done: bytes(p.bytes) + (p.total ? ' / ' + bytes(p.total) : '') });
      $('#updMsg', el).textContent = msg;
      if (p.step === 'rollback') return; // bij terugzetten blijven de stappen staan zoals ze waren
      const at = UPD_ORDER.indexOf(p.step);
      $$('.upd-steps li', el).forEach((li) => {
        const i = UPD_ORDER.indexOf(li.dataset.step);
        li.className = p.state === 'done' || i < at ? 'done' : i === at || (li.dataset.step === 'install' && p.step === 'packages') ? 'now' : '';
      });
    };
    const finish = (p) => {
      const ok = p.state === 'done';
      $('.upd-run', el).classList.add(ok ? 'ok' : 'bad');
      $('#updTitle', el).textContent = ok ? t('Bijgewerkt naar versie {version}', { version: p.version }) : p.state === 'rolledback' ? t('Bijwerken mislukt: vorige versie teruggezet') : t('Bijwerken mislukt');
      $('#updMsg', el).textContent = tr(p.message || '') + (p.reason ? ' ' + tr(p.reason) : '');
      $('#updNote', el).textContent = ok ? t('De pagina wordt zo vernieuwd met de nieuwe versie.') : t('Je instellingen, apps en VM\'s zijn niet aangeraakt.');
      $('#updBtns', el).innerHTML = ok ? `<button class="btn primary" type="button" data-upd-reload>${t('Nu vernieuwen')}</button>`
        : `<button class="btn" type="button" data-upd-back>${t('Terug')}</button>`;
      el.onclick = (e) => {
        if (e.target.closest('[data-upd-reload]')) { if (S.config.demo) updatePane(el); else location.reload(); }
        if (e.target.closest('[data-upd-back]')) updatePane(el);
      };
      $('#updDot').hidden = ok; $('#updTabBadge').hidden = ok;
      if (ok) { toast(t('Bijgewerkt naar versie {version}', { version: p.version })); if (!S.config.demo) setTimeout(() => location.reload(), 4000); }
    };
    const poll = async () => {
      if (!el.isConnected || settingsTab() !== 'update') return; // venster dicht: bij opnieuw openen gaat het verder
      let p;
      try { p = await api.get('/api/update/progress'); lost = 0; }
      catch (e) {
        // Server herstart: even geen antwoord. Na 3 minuten opgeven.
        if (++lost === 1) $('#updMsg', el).textContent = t('HomeBaseOS herstart… even geduld.');
        if (Date.now() - started > 180000) { finish({ state: 'failed', message: t('HomeBaseOS antwoordt niet meer. Kijk op de server: journalctl -u homebaseos') }); return; }
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
    el.innerHTML = `<p class="lead">${t('Laden…')}</p>`;
    let u;
    try { u = await api.get('/api/update'); } catch (e) { el.innerHTML = `<p class="lead">${esc(e.message)}</p>`; return; }
    if (settingsTab() !== 'update') return;
    S.update = u;
    const mark = '<span class="upd-logo" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M5 15.5 16 6l11 9.5V27H19.5v-7.5h-7V27H5z"/></svg></span>';
    const checked = u.checked ? t('Laatst gezocht: {when}', { when: esc(new Date(u.checked).toLocaleString(LOCALE, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', ...clockOpts() })) }) : t('Nog niet gezocht naar updates.');
    const notes = (r) => `<article class="notes">
        <div class="notes-head"><h3>${t('Versie {version}', { version: esc(r.version) })}${r.name && r.name.replace(/^v/, '') !== r.version ? ' · ' + esc(r.name) : ''}
          ${r.prerelease ? ` <span class="pill warn">${t('Bèta')}</span>` : ''}</h3>
          <span class="muted small">${esc(longDate(r.published))}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">${t('Op GitHub')}</a>` : ''}</span></div>
        <div class="md">${r.notes.trim() ? mdToHtml(r.notes) : `<p class="muted">${t('Geen release-notes bij deze versie.')}</p>`}</div></article>`;
    const card = u.updateAvailable ? `
      <div class="upd-card new">${mark}<div class="upd-text"><b>${t('HomeBaseOS {version} is beschikbaar', { version: esc(u.latest.version) })}</b>
        <div class="muted small">${t('Je hebt versie {current}.', { current: esc(u.current) })} ${u.newer.length > 1 ? t('Er zijn {n} nieuwe versies.', { n: u.newer.length }) : ''}</div>
        <div class="muted small">${checked}</div></div>
        <div class="btn-row"><button class="btn" type="button" data-sw="check">${t('Nu zoeken')}</button>
          <button class="btn primary" type="button" data-sw="install"${u.install && u.install.ok ? '' : ' disabled'}>${t('Nu bijwerken')}</button></div></div>
      ${u.install && !u.install.ok ? `<p class="muted small" style="margin-top:-6px">${esc(tr(u.install.reason))}</p>` : ''}` : `
      <div class="upd-card">${mark}<div class="upd-text"><b>${t('HomeBaseOS is up-to-date')}</b>
        <div class="muted small">${t('Versie {current}', { current: esc(u.current) })}</div><div class="muted small">${checked}</div></div>
        <button class="btn" type="button" data-sw="check">${t('Nu zoeken')}</button></div>`;
    el.innerHTML = card +
      (u.error ? `<div class="upd-error" role="alert">${esc(tr(u.error))}</div>` : '') +
      (u.updateAvailable ? `
        <h2 class="pane-title">${t('Wat is er nieuw')}</h2>${u.newer.map(notes).join('')}
        ${u.install && u.install.ok ? '' : `<h2 class="pane-title">${t('Bijwerken')}</h2>
        <div class="upd-how"><p class="muted small">${t('Haal de nieuwe versie op in de map met de code van HomeBaseOS op de server, en voer het installatiescript opnieuw uit. Je instellingen, apps en VM\'s blijven staan.')}</p>
          <pre>cd ~/homebaseos
git pull
sudo ./install.sh</pre></div>`}` : '') +
      (u.history.length ? `<details class="upd-older"${u.updateAvailable ? '' : ' open'}><summary>${u.updateAvailable ? t('Eerdere versies') : t('Release-notes')}</summary>${u.history.map(notes).join('')}</details>` : '') + `
      <h2 class="pane-title">${t('Instellingen')}</h2>
      <div class="form">
        <label class="check"><input type="checkbox" name="updateCheck"${u.auto ? ' checked' : ''}> ${t('Automatisch zoeken naar updates (elke 12 uur)')}</label>
        <div class="choice-row" role="radiogroup" aria-label="${t('Soort versies')}">${[['stable', t('Alleen stabiele versies')], ['beta', t('Ook bètaversies')]].map(([k, name]) => `
          <label class="choice"><input type="radio" name="updateChannel" value="${k}"${k === u.channel ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}</div>
        <p class="muted small">${t('HomeBaseOS zoekt naar nieuwe versies op GitHub ({repo}).', { repo: esc(u.repo) })}${u.token ? '' : ' ' + t('Is de repository privé, zet dan een token in UPDATE_TOKEN.')}</p>
      </div>`;
    if (u.running) { updateProgress(el); return; } // er loopt al een update (bv. na het vernieuwen van de pagina)
    el.onclick = async (e) => {
      if (e.target.closest('[data-sw="install"]')) {
        const v = u.latest.version;
        if (!(await ask(t('HomeBaseOS bijwerken naar versie {version}? HomeBaseOS herstart even; je apps en VM\'s blijven gewoon draaien.', { version: v }), t('Nu bijwerken')))) return;
        try { await api.post('/api/update/install', { version: v }); updateProgress(el); }
        catch (ex) { toast(ex.message, true); }
        return;
      }
      const b = e.target.closest('[data-sw="check"]'); if (!b) return;
      b.disabled = true; b.textContent = t('Zoeken…');
      try { await api.post('/api/update/check'); } catch (ex) { toast(ex.message, true); }
      await loadUpdate(); updatePane(el);
    };
    el.onchange = async (e) => {
      const n = e.target.name; if (n !== 'updateCheck' && n !== 'updateChannel') return;
      try {
        await api.post('/api/settings', n === 'updateCheck' ? { updateCheck: e.target.checked } : { updateChannel: e.target.value });
        toast(t('Opgeslagen.'));
        await loadUpdate(); updatePane(el);
      } catch (ex) { toast(ex.message, true); }
    };
  }

  async function aboutPane(el) {
    el.onchange = null;
    el.innerHTML = `<p class="lead">${t('Laden…')}</p>`;
    let a;
    try { a = await api.get('/api/about'); }
    catch (e) { el.innerHTML = `<p class="lead">${t('De gegevens konden niet geladen worden: {error}', { error: esc(e.message) })}</p>`; return; }
    if (settingsTab() !== 'about') return;
    const b = a.board || {};
    const groups = [
      [t('Server'), [[t('Hostnaam'), a.hostname], [t('Systeem'), [b.vendor, b.product].filter(Boolean).join(' ')],
        [t('Moederbord'), [b.boardVendor, b.board].filter(Boolean).join(' ')], [t('BIOS'), [b.bios, b.biosDate].filter(Boolean).join(' · ')]]],
      [t('Hardware'), [[t('Processor'), a.cpu && a.cpu.brand], [t('Kernen'), a.cpu && a.cpu.threads ? t('{cores} kernen, {threads} threads', { cores: a.cpu.cores || '?', threads: a.cpu.threads }) : null],
        [t('Geheugen'), bytes(a.memory)],
        [t('ECC'), a.ecc ? (a.ecc.active ? t('Actief') + (a.ecc.mode ? ' (' + a.ecc.mode + ')' : '') + (a.ecc.corrected ? ' · ' + t('{n} fouten gecorrigeerd', { n: a.ecc.corrected }) : '') : t('Niet actief')) : t('Onbekend')],
        [t('Grafische kaart'), (a.gpus || []).join(', ')]]],
      [t('Besturingssysteem'), [[t('Systeem'), a.os], [t('Kernel'), a.kernel], [t('Architectuur'), a.arch], [t('Tijdzone'), a.timezone],
        [t('Aan sinds'), a.uptime != null ? duration(a.uptime) : null], [t('IP-adressen'), (a.addresses || []).map((x) => x.address + ' (' + x.interface + ')').join(', ')]]],
      [t('Versies'), Object.entries({ HomeBaseOS: a.versions.homebaseos, 'Node.js': a.versions.node, Docker: a.versions.docker, 'Docker Compose': a.versions.compose,
        ZFS: a.versions.zfs, libvirt: a.versions.libvirt, [t('Hypervisor')]: a.versions.hypervisor })],
    ];
    const plain = groups.map(([title, rows]) => title + '\n' + rows.map(([k, v]) => '  ' + k + ': ' + (v || '–')).join('\n')).join('\n\n');
    el.innerHTML = groups.map(([title, rows]) => `<h2 class="pane-title">${esc(title)}</h2>
      <dl class="kv about-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v ? esc(v) : '<span class="muted">' + t('niet gevonden') + '</span>'}</dd>`).join('')}</dl>`).join('') +
      `<div class="btn-row" style="margin-top:18px"><button class="btn" type="button" id="aboutCopy">${t('Alles kopiëren')}</button></div>
      <p class="muted small" style="margin-top:8px">${t('Handig als je ergens hulp vraagt.')}</p>`;
    $('#aboutCopy', el).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(plain); toast(t('Gekopieerd.')); } catch (e) { toast(t('Kopiëren lukte niet in deze browser.'), true); }
    });
  }

  /* --- AI */
  const chatHistory = [];
  async function aiWindow() {
    openWindow(t('AI'), `<p class="lead">${t('Laden…')}</p>`);
    try { await loadAi(true); } catch (e) { /* fout staat in S.aiError */ }
    if (S.aiError) {
      $('#winBody').innerHTML = S.aiDown
        ? `<p class="lead">${t('Ollama draait nog niet op deze server. Installeer de app Ollama uit de appstore: HomeBaseOS vindt ze dan vanzelf. Met een NVIDIA-kaart gebruikt ze de GPU.')}</p>
          <div class="btn-row"><button class="btn primary" type="button" data-ai-store>${t('Ollama zoeken in de appstore')}</button></div>`
        : `<p class="lead">${esc(S.config.ollama ? t('Ollama is niet bereikbaar: {error}', { error: S.aiError })
          : t('Ollama is nog niet gekoppeld. Zet OLLAMA_URL in /etc/homebaseos/homebaseos.env, bijvoorbeeld http://127.0.0.1:11434.'))}</p>`;
      const b = $('[data-ai-store]');
      if (b) b.onclick = () => { win.close(); S.storeQuery = 'ollama'; $('#storeSearch').value = 'ollama'; location.hash = 'store'; };
      return;
    }
    const draw = () => {
      const ai = S.ai; const g = ai.gpu && ai.gpu[0];
      const opts = ai.models.filter((m) => !/embed/i.test(m.name)).map((m) => `<option value="${esc(m.name)}" ${m.loaded ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
      $('#winBody').innerHTML = `
        <div class="stat-strip">
          ${g ? `<div class="stat"><b>${bytes(g.memUsed)}</b><span>${t('van {total} VRAM', { total: bytes(g.memTotal) })}</span></div>
                 <div class="stat"><b>${g.util ?? '–'}%</b><span>${t('GPU-belasting')}</span></div>` : ''}
          <div class="stat"><b>${ai.models.length}</b><span>${t(ai.models.length === 1 ? 'model' : 'modellen')}</span></div>
          ${ai.version ? `<div class="stat"><b>${esc(ai.version)}</b><span>${t('Ollama-versie')}</span></div>` : ''}
        </div>
        <h3>${t('Modellen')}</h3>
        <ul class="rows" id="modelRows">${ai.models.map((m) => `<li>
          <div><div class="row-title">${esc(m.name)}</div>
            <div class="row-sub">${esc([m.params, m.quant, bytes(m.size), m.loaded ? t('geladen in {size} VRAM', { size: bytes(m.vram) }) : null].filter(Boolean).join(' · '))}</div></div>
          <div class="btn-row">
            ${m.loaded ? `<button class="btn sm" data-model="${esc(m.name)}" data-do="unload">${t('Ontladen')}</button>`
                       : `<button class="btn sm" data-model="${esc(m.name)}" data-do="load">${t('Laden')}</button>`}
            <button class="btn sm danger" data-model="${esc(m.name)}" data-do="delete">${t('Verwijderen')}</button>
          </div></li>`).join('') || `<li><span class="muted">${t('Nog geen modellen. Download er hieronder een.')}</span></li>`}</ul>

        <h3>${t('Model downloaden')}</h3>
        <form class="inline-form" id="pullForm">
          <input class="field" id="pullName" placeholder="${t('bijvoorbeeld qwen3:8b')}" autocomplete="off" required>
          <button class="btn primary" type="submit">${t('Downloaden')}</button>
        </form>
        <div class="bar" style="margin-top:10px" hidden id="pullBarWrap"><span id="pullBar"></span></div>
        <p class="progress-note" id="pullNote"></p>

        <h3>${t('Snel iets vragen')}</h3>
        ${opts ? `<div class="chat">
          <select class="field" id="chatModel" aria-label="${t('Model')}">${opts}</select>
          <div class="chat-log" id="chatLog">${chatHistory.map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join('')}</div>
          <form class="inline-form" id="chatForm">
            <textarea class="field" id="chatInput" placeholder="${t('Stel een vraag aan je eigen model')}" required></textarea>
            <button class="btn primary" type="submit">${t('Versturen')}</button>
          </form>
        </div>` : `<p class="lead">${t('Download eerst een model om te kunnen chatten.')}</p>`}`;
    };
    draw();

    const body = $('#winBody');
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-model]'); if (!b) return;
      const name = b.dataset.model, act = b.dataset.do;
      if (act === 'delete' && !(await ask(t('{name} verwijderen?', { name }), t('Verwijderen')))) return;
      withBusy(b, async () => {
        if (act === 'delete') await api.del('/api/ai/models/' + encodeURIComponent(name));
        else await api.post('/api/ai/models/' + encodeURIComponent(name) + '/' + act);
        toast(t({ delete: 'Verwijderd', load: 'Geladen', unload: 'Ontladen' }[act]) + ': ' + name);
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
              $('#pullNote').textContent = t('Downloaden: {done} van {total}', { done: bytes(l.completed), total: bytes(l.total) });
            } else if (l.status) $('#pullNote').textContent = l.status === 'success' ? t('Klaar') : l.status;
          });
          toast(t('Gedownload: {name}', { name }));
          await loadAi(); draw();
        } catch (err) { $('#pullNote').textContent = t('Downloaden mislukt: {error}', { error: err.message }); btn.disabled = false; }
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
        } catch (err) { out.textContent = t('Geen antwoord: {error}', { error: err.message }); chatHistory.pop(); }
        btn.disabled = false; input.focus();
      }
    });
    body.addEventListener('keydown', (e) => {
      if (e.target.id === 'chatInput' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); }
    });
  }

  /* ------------------------------------------------------------ laden */
  async function loadOverview() { S.overview = await api.get('/api/overview'); renderOverview(); }
  async function loadApps() { S.apps = await api.get('/api/apps'); renderApps(); }
  async function loadVms() {
    try { S.vms = await api.get('/api/vms'); S.vmError = null; }
    catch (e) { S.vmError = e.message; throw e; }
    finally { S.vmsLoaded = true; renderVmWidget(); renderVmPage(); }
  }
  async function loadAi(quiet) {
    try { S.ai = await api.get('/api/ai'); S.aiError = null; S.aiDown = false; }
    catch (e) { S.aiError = e.message; S.aiDown = !!(e.data && e.data.notRunning); if (!quiet) { /* stil in widget */ } }
    renderAiWidget();
  }

  let failures = 0;
  async function refresh(all) {
    const jobs = [loadOverview(), loadApps()];
    // Op de VM-pagina haalt een eigen, snellere timer de VM's op.
    if (all || currentView() !== 'vms') jobs.push(loadVms().catch(() => {}));
    if (all) jobs.push(loadAi(true), loadShares());
    const results = await Promise.allSettled(jobs);
    const bad = results.find((r) => r.status === 'rejected');
    if (bad) {
      if (bad.reason && bad.reason.status === 401) return showLogin();
      if (++failures === 1) toast(t('Server niet bereikbaar: {error}', { error: bad.reason.message }), true);
    } else failures = 0;
  }

  /* ------------------------------------------------------------ schermen */
  const VIEWS = { '#vms': 'vms', '#store': 'store' };
  // Instellingen is een venster boven de pagina waar je bent (zoals Systeeminstellingen op macOS).
  // pageHash onthoudt die pagina; #settings/... in de adresbalk opent alleen het venster.
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
    // De eerste keer altijd laden (ook als de pagina meteen op #store of #vms opent).
    const pageChanged = location.hash !== pageHash || !pageLoaded;
    pageHash = location.hash; pageLoaded = true;
    if (setWin.open) closeSettings();
    if (!pageChanged && view !== 'home') return; // venster dicht: de pagina eronder blijft gewoon staan
    if (view === 'vms') { window.scrollTo(0, 0); renderVmPage(); loadVms().catch(() => {}); }
    if (view === 'store') { window.scrollTo(0, 0); loadStore(); }
  }
  const setWin = $('#setWin');
  // Sluiten: meteen terug naar het adres van de pagina eronder, zonder die opnieuw op te bouwen.
  // (Niet in het close-event: dat komt asynchroon en kan achterlopen op een volgende klik.)
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
    timers.forEach(clearInterval); timers = []; // niet verder vernieuwen (en het formulier niet leegmaken) tijdens het aanmelden
    const wasHidden = $('#loginScreen').hidden;
    $('#desk').hidden = true; $('#vmPage').hidden = true; $('#storePage').hidden = true; $('#loginScreen').hidden = false; $('.topnav').hidden = true;
    const demoInfo = S.config && S.config.demo;
    $('#loginDemo').hidden = !demoInfo;
    if (demoInfo) $('#loginDemo').innerHTML = t('Demo: meld je aan als {user} met het wachtwoord {pw}.', { user: '<b>' + esc(window.HomeBaseOSDemo.user()) + '</b>', pw: '<b>demo</b>' });
    if (wasHidden) loginStep('password');
  }

  let timers = [];
  function startDesk() {
    showDesk();
    $('#demoBadge').hidden = api === realApi;
    $('#logoutBtn').hidden = !S.config.passwordEnabled;
    $('#termBtn').hidden = !S.config.terminal;
    if (S.config.onboarding && !onbWin.open) openOnboarding();
    refresh(true);
    loadLayout();
    loadUpdate();
    timers.forEach(clearInterval);
    timers = [
      setInterval(() => { if (!document.hidden) refresh(false); }, 10000),
      setInterval(() => { if (!document.hidden && currentView() === 'vms') loadVms().catch(() => {}); }, 3000), // live CPU/RAM
      setInterval(() => { if (!document.hidden) { loadAi(true); loadShares(); loadUpdate(); } }, 30000),
    ];
  }

  // Overzicht: terug naar het dashboard, en wat er nog open staat dicht.
  function goHome() {
    if (win.open) win.close();
    if (conWin.open) window.TB_closeConsole();
    closeFolder();
    if (location.hash && location.hash !== '#') location.hash = ''; else window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  /* ------------------------------------------------------------ wachtwoord kiezen (wizard en Beveiliging) */
  function passwordFields(currentLabel) {
    return `<label class="fld"><span>${esc(currentLabel || t('Huidig wachtwoord'))}</span>
        <input class="field" type="password" name="current" autocomplete="current-password"></label>
      <label class="fld"><span>${t('Nieuw wachtwoord')}</span>
        <input class="field" type="password" name="password" autocomplete="new-password" minlength="10">
        <div class="pw-meter" data-score="0" aria-hidden="true"><span></span></div>
        <span class="muted small" data-pw-hint>${t('Minstens 10 tekens. Een zin van een paar woorden is sterk én makkelijk te onthouden.')}</span></label>
      <label class="fld"><span>${t('Herhaal het nieuwe wachtwoord')}</span>
        <input class="field" type="password" name="repeat" autocomplete="new-password"></label>`;
  }
  // 0–4: lengte telt het meest, afwisseling (kleine/hoofdletters, cijfers, tekens) een beetje.
  function pwScore(v) {
    if (v.length < 10) return v ? 1 : 0;
    const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
    return Math.min(4, 1 + (v.length >= 14) + (v.length >= 20) + (kinds >= 3));
  }
  function wirePasswordMeter(root) {
    const inp = $('input[name="password"]', root), meter = $('.pw-meter', root), hint = $('[data-pw-hint]', root);
    const words = ['', t('Te kort'), t('Redelijk'), t('Goed'), t('Sterk')];
    const upd = () => {
      const sc = pwScore(inp.value);
      meter.dataset.score = String(sc); $('span', meter).style.width = (sc * 25) + '%';
      hint.textContent = inp.value ? words[sc] + (sc === 1 ? ' · ' + t('nog {n} tekens', { n: Math.max(0, 10 - inp.value.length) }) : '') : t('Minstens 10 tekens. Een zin van een paar woorden is sterk én makkelijk te onthouden.');
    };
    inp.oninput = upd; upd();
  }
  async function submitPassword(root) {
    const f = (n) => $(`input[name="${n}"]`, root).value;
    if (f('password').length < 10) throw new Error(t('Kies een wachtwoord van minstens 10 tekens.'));
    if (f('password') !== f('repeat')) throw new Error(t('De twee nieuwe wachtwoorden zijn niet gelijk.'));
    return api.post('/api/password', { current: f('current'), password: f('password') });
  }

  /* ------------------------------------------------------------ welkomstwizard (eerste keer: account aanmaken; daarna na de eerste aanmelding) */
  const onbWin = $('#onbWin');
  const ONB = { steps: [], i: 0, dir: 1, data: null, setup: false, pool: null };
  const HOUSE = '<svg viewBox="0 0 32 32"><path d="M5 15.5 16 6l11 9.5V27H19.5v-7.5h-7V27H5z"/></svg>';
  const hero = (svg, line) => `<div class="onb-hero${line ? ' line' : ''}" aria-hidden="true">${svg}</div>`;
  const LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>';
  function onbSteps() {
    const d = () => ONB.data;
    const pwOn = S.config.passwordEnabled || S.config.demo;
    // Eerste keer (nog geen account): een account aanmaken. Anders (installaties van vroeger): het wachtwoord uit de installatie vervangen.
    const account = { id: 'account',
      render(el) {
        if (!ONB.setup) {
          el.innerHTML = hero('<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg>', true) +
            `<h1 id="onbTitle">${t('Je account')}</h1>
            <p class="lead">${t('Je account {user} is aangemaakt. Je meldt je ermee aan op elk toestel.', { user: `<b>${esc(d().user || '')}</b>` })}</p>`;
          return;
        }
        el.innerHTML = hero('<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg>', true) +
          `<h1 id="onbTitle">${t('Maak je account aan')}</h1>
          <p class="lead">${t('Hiermee meld je je aan op HomeBaseOS. Kies een wachtwoord dat je kan onthouden, of bewaar het in je wachtwoordbeheerder.')}</p>
          <form class="form" data-onb-form>
            <label class="fld"><span>${t('Gebruikersnaam')}</span>
              <input class="field" name="user" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" value="admin">
              <span class="muted small">${t('Kleine letters, cijfers, punt, - of _.')}</span></label>
            <label class="fld"><span>${t('Wachtwoord')}</span>
              <input class="field" type="password" name="password" autocomplete="new-password" minlength="10">
              <div class="pw-meter" data-score="0" aria-hidden="true"><span></span></div>
              <span class="muted small" data-pw-hint></span></label>
            <label class="fld"><span>${t('Herhaal het wachtwoord')}</span>
              <input class="field" type="password" name="repeat" autocomplete="new-password"></label>
            ${S.config.demo ? `<p class="muted small">${t('Demo: het account blijft alleen in deze browser. Aanmelden kan daarna ook met het wachtwoord {pw}.', { pw: '<b>demo</b>' })}</p>` : ''}
            <p class="form-error onb-err" role="alert"></p></form>`;
        wirePasswordMeter(el);
        $('input[name="user"]', el).select();
      },
      async next(el) {
        if (!ONB.setup) return true;
        const val = (n) => $(`input[name="${n}"]`, el).value;
        if (val('password').length < 10) throw new Error(t('Kies een wachtwoord van minstens 10 tekens.'));
        if (val('password') !== val('repeat')) throw new Error(t('De twee wachtwoorden zijn niet gelijk.'));
        const r = await api.post('/api/setup', { user: val('user'), password: val('password'), repeat: val('repeat'), language: LANG });
        ONB.setup = false;
        S.config = { ...S.config, setup: false, passwordEnabled: true, needsLogin: false, loginUser: true };
        ONB.data = await api.get('/api/onboarding');
        ONB.steps = onbSteps(); // nu met de gegevens van de server
        toast(t('Account {user} aangemaakt.', { user: r.user }));
        return true;
      } };
    const password = { id: 'password', skip: true,
      render(el) {
        const ch = d().passwordChanged;
        el.innerHTML = hero(LOCK, true) +
          `<h1 id="onbTitle">${t('Kies je eigen wachtwoord')}</h1>
          <p class="lead">${ch ? t('Je hebt al een eigen wachtwoord (sinds {date}). Vul alleen iets in als je het wil wijzigen.', { date: esc(longDate(ch)) })
            : t('Bij de installatie kreeg je een willekeurig wachtwoord. Kies er nu een dat je zelf kan onthouden, of bewaar het in je wachtwoordbeheerder.')}</p>` +
          (pwOn ? `<form class="form" data-onb-form>${passwordFields(t('Huidig wachtwoord (uit de installatie)'))}
            ${S.config.demo ? `<p class="muted small">${t('Demo: het huidige wachtwoord is {pw}. Aanmelden blijft met demo werken.', { pw: '<b>demo</b>' })}</p>` : ''}
            <p class="form-error onb-err" role="alert"></p></form>`
            : `<p class="muted">${t('HomeBaseOS draait zonder wachtwoord.')}</p>`);
        if (pwOn) wirePasswordMeter(el);
      },
      async next(el) {
        if (!pwOn) return true;
        const val = (n) => $(`input[name="${n}"]`, el).value;
        if (!val('current') && !val('password') && !val('repeat')) {
          if (d().passwordChanged) return true;
          throw new Error(t('Vul een nieuw wachtwoord in, of klik op Overslaan.'));
        }
        const r = await submitPassword(el);
        d().passwordChanged = r.changed;
        toast(t('Je nieuwe wachtwoord is ingesteld. Andere browsers zijn afgemeld.'));
        return true;
      } };
    // Wie een account heeft (nu of eerder aangemaakt), ziet die stap; installaties van vroeger kiezen een eigen wachtwoord.
    const second = ONB.setup || (d() && d().user) ? account : password;
    return [
      { id: 'welcome',
        render(el) {
          el.innerHTML = hero(HOUSE) + `<h1 id="onbTitle">${t('Welkom bij HomeBaseOS')}</h1>
            <p class="lead">${ONB.setup ? t('In een paar stappen is je server klaar: een account, een naam, opslag en extra beveiliging. Alles kan je later nog aanpassen bij Instellingen.')
              : t('In een paar stappen is je server klaar: een eigen wachtwoord, een naam, opslag en extra beveiliging. Alles kan je later nog aanpassen bij Instellingen.')}</p>
            <h2 class="pane-title">${t('Taal')}</h2>
            <div class="choice-row" role="radiogroup" aria-label="${t('Taal')}">${Object.entries(LANGS).map(([k, name]) => `
              <label class="choice"><input type="radio" name="lang" value="${k}"${k === LANG ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}</div>
            <h2 class="pane-title">${t('Thema')}</h2>
            <div class="choice-row" role="radiogroup" aria-label="${t('Thema')}">${[['auto', t('Automatisch')], ['light', t('Licht (ochtendnevel)')], ['dark', t('Donker (avond)')]].map(([k, name]) => `
              <label class="choice"><input type="radio" name="theme" value="${k}"${k === themeNow() ? ' checked' : ''}><span>${esc(name)}</span></label>`).join('')}</div>`;
          el.onchange = (e) => { if (e.target.name === 'theme') setTheme(e.target.value); };
        },
        async next(el) {
          const lang = $('input[name="lang"]:checked', el).value;
          if (lang === LANG) return true;
          // Zonder account nog niet op de server: de taal gaat mee bij het aanmaken van het account.
          if (!ONB.setup) await api.post('/api/settings', { language: lang });
          setLang(lang);
          try { sessionStorage.setItem('tb-onb-step', '1'); } catch (e) { /* privévenster */ }
          location.reload(); // alles opnieuw opbouwen in de nieuwe taal; de wizard gaat verder bij stap 2
          return false;
        },
        focus: false },
      second,
      { id: 'server', skip: true,
        async render(el) {
          el.innerHTML = `<p class="lead">${t('Laden…')}</p>`;
          let dt;
          try { dt = await api.get('/api/datetime'); } catch (e) { dt = { timezones: [d().timezone], timezone: d().timezone }; }
          if (!el.isConnected) return;
          const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const suggest = /^(Etc\/)?UTC$/.test(d().timezone) && dt.timezones.includes(browserTz) ? browserTz : null;
          el.innerHTML = hero('<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>', true) +
            `<h1 id="onbTitle">${t('Je server')}</h1>
            <p class="lead">${t('Geef je server een naam en kies de tijdzone. Apps uit de appstore krijgen dezelfde tijdzone.')}</p>
            <form class="form" data-onb-form>
              <label class="fld"><span>${t('Naam van de server')}</span>
                <input class="field" name="hostname" value="${esc(d().hostname)}" spellcheck="false" autocomplete="off" maxlength="63">
                <span class="muted small">${t('Kleine letters, cijfers en -. Zo vind je hem in je netwerk, bv. {name}.local.', { name: esc(d().hostname) })}</span></label>
              <label class="fld"><span>${t('Tijdzone')}</span>
                <select class="field" name="timezone">${zoneOptions(dt.timezones, suggest || d().timezone)}</select>
                ${suggest ? `<span class="muted small">${t('Voorgesteld op basis van deze computer.')}</span>` : ''}</label>
              <p class="form-error onb-err" role="alert"></p></form>`;
          const hn = $('input[name="hostname"]', el);
          hn.oninput = () => { $('.fld .muted', el).textContent = t('Kleine letters, cijfers en -. Zo vind je hem in je netwerk, bv. {name}.local.', { name: hn.value.trim().toLowerCase() || '…' }); };
        },
        async next(el) {
          const hn = $('input[name="hostname"]', el), tz = $('select[name="timezone"]', el);
          if (!hn) return true; // nog aan het laden
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
            `<h1 id="onbTitle">${t('Opslag')}</h1>
            <p class="lead">${pools.length ? t('HomeBaseOS vond deze opslagpools. Daar komen je apps, VM\'s en gedeelde mappen.')
              : t('Een pool bundelt je schijven tot één grote, beschermde opslag (ZFS). Daar komen je apps, VM\'s en gedeelde mappen. Vink de schijven aan en klik op Pool aanmaken, of sla deze stap over.')}</p>
            ${pools.length ? `<ul class="onb-list">${pools.map((x) => `<li><span class="ok-mark">✓</span><span class="grow"><b>${esc(x.name)}</b></span>
              <span class="muted small">${x.total ? esc(bytes(x.total)) : ''}</span><span class="pill ${x.health === 'ONLINE' ? 'ok' : 'warn'}">${esc(tr(x.health || ''))}</span></li>`).join('')}</ul>
              ${d().appdata ? `<p class="muted small">${t('Appgegevens: {dir}', { dir: `<code>${esc(d().appdata)}</code>` })}</p>` : ''}` : ''}
            ${free.length ? (pools.length ? `<div class="btn-row" data-onb-more><button class="btn" type="button" data-onb-pool>${t('Nog een pool aanmaken')}</button></div>` : '') +
                `<div class="onb-pool" data-onb-poolbox${pools.length ? ' hidden' : ''}><p class="muted">${t('Schijven zoeken…')}</p></div>`
              : `<p class="muted small">${pools.length ? t('Er zijn geen vrije schijven meer.') : t('HomeBaseOS vond geen vrije schijven. Steek er een in en open Opslag later opnieuw.')}</p>`}`;
          const box = $('[data-onb-poolbox]', el);
          if (!box) return;
          const mount = async () => {
            let o;
            try { o = await api.get('/api/pools/options'); } catch (e) { box.innerHTML = `<p class="muted">${t('De schijven konden niet gelezen worden: {error}', { error: esc(e.message) })}</p>`; return; }
            if (!el.isConnected) return;
            box.innerHTML = (pools.length ? `<h2 class="pane-title">${t('Nog een pool aanmaken')}</h2>` : '') + '<div></div>';
            ONB.pool = poolForm(box.lastElementChild, o, null, {
              inline: true,
              onPick: (any) => { $('#onbNext').textContent = any ? t('Pool aanmaken') : t('Volgende'); },
              onCreated: async () => {
                try { ONB.data = await api.get('/api/onboarding'); } catch (e) { /* toon wat we weten */ }
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
        // Schijven aangevinkt? Dan maakt Volgende de pool (en blijft de stap staan om het resultaat te tonen).
        async next() {
          if (ONB.pool && ONB.pool.picked()) { await ONB.pool.submit(); return false; }
          return true;
        },
        focus: false },
      { id: 'security', skip: true,
        render(el) {
          el.innerHTML = hero('<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>', true) +
            `<h1 id="onbTitle">${t('Tweestapsverificatie')}</h1>
            <p class="lead">${t('Bij het aanmelden vraagt HomeBaseOS dan ook een code uit een app op je gsm. Wie alleen je wachtwoord kent, raakt er zo niet in. Aanbevolen, zeker als je HomeBaseOS ook van buitenaf gebruikt.')}</p>
            <div id="onbMfa"><p class="muted">${t('Laden…')}</p></div>`;
          const box = $('#onbMfa', el); box.dataset.noHead = '1';
          mfaSection(box);
        },
        focus: false },
      { id: 'done', nextLabel: t('Naar het dashboard'),
        async render(el) {
          try { ONB.data = await api.get('/api/onboarding'); } catch (e) { /* toon wat we weten */ }
          if (!el.isConnected) return;
          const row = (ok, label, value) => `<li><span class="${ok ? 'ok-mark' : 'no-mark'}">${ok ? '✓' : '–'}</span><span class="grow">${esc(label)}</span><span class="muted small">${esc(value)}</span></li>`;
          el.innerHTML = hero('<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>', true) +
            `<h1 id="onbTitle">${t('Klaar!')}</h1>
            <p class="lead">${t('HomeBaseOS is klaar voor gebruik. Dit is ingesteld:')}</p>
            <ul class="onb-list">
              ${d().user ? row(true, t('Account'), d().user) : row(!!d().passwordChanged, t('Wachtwoord'), d().passwordChanged ? t('Eigen wachtwoord') : t('Nog dat uit de installatie'))}
              ${row(true, t('Naam van de server'), d().hostname)}
              ${row(true, t('Tijdzone'), d().timezone.replace(/_/g, ' '))}
              ${row(d().pools.length > 0, t('Opslag'), d().pools.length ? d().pools.map((x) => x.name).join(', ') : t('Nog geen pool'))}
              ${row(!!d().appdata, t('Appgegevens'), d().appdata || t('Nog geen plek'))}
              ${row(d().mfa, t('Tweestapsverificatie'), d().mfa ? t('Aan') : t('Uit'))}
            </ul>
            <h2 class="pane-title">${t('Wat nu?')}</h2>
            <div class="onb-next-links">
              <button type="button" data-onb-go="store"><b>${t('Appstore')}</b><span>${t('Installeer je eerste apps.')}</span></button>
              <button type="button" data-onb-go="vms"><b>${t('VM\'s')}</b><span>${t('Bv. Home Assistant OS.')}</span></button>
              <button type="button" data-onb-go="shares"><b>${t('Gedeelde mappen')}</b><span>${t('Bestanden delen met je computers.')}</span></button>
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
    // Zonder account geeft de server nog niets prijs: de gegevens komen na de stap "account".
    if (ONB.setup) ONB.data = null;
    else { try { ONB.data = await api.get('/api/onboarding'); } catch (e) { toast(e.message, true); return; } }
    ONB.steps = onbSteps();
    let resume = null;
    try { resume = sessionStorage.getItem('tb-onb-step'); sessionStorage.removeItem('tb-onb-step'); } catch (e) { /* privévenster */ }
    ONB.i = Math.min(ONB.steps.length - 1, resume != null ? Number(resume) || 0 : startAt);
    if (ONB.setup) ONB.i = Math.min(ONB.i, 1); // eerst het account
    ONB.dir = 1;
    document.body.classList.add('onb-open'); // alleen de wizard, zonder het dashboard erachter
    if (!onbWin.open) onbWin.showModal();
    onbRender();
  }
  function onbRender() {
    const st = ONB.steps[ONB.i], body = $('#onbBody');
    $('#onbDots').innerHTML = ONB.steps.map((_, k) => `<li class="${k < ONB.i ? 'done' : k === ONB.i ? 'now' : ''}"></li>`).join('');
    $('#onbDots').setAttribute('aria-label', t('Stap {n} van {total}', { n: ONB.i + 1, total: ONB.steps.length }));
    body.innerHTML = `<div class="onb-step${ONB.dir < 0 ? ' back' : ''}"></div>`;
    body.scrollTop = 0;
    const el = $('.onb-step', body);
    $('#onbBack').style.visibility = ONB.i === 0 ? 'hidden' : '';
    $('#onbSkip').hidden = !st.skip;
    $('#onbNext').textContent = st.nextLabel || t('Volgende');
    // Zonder account kan je de wizard niet uitstellen: zonder account kom je nergens binnen.
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
    if (skipped) toast(t('Je vindt de welkomstwizard terug bij Instellingen → Algemeen.'));
    if (!timers.length) startDesk(); // de eerste keer (account net aangemaakt) staat het dashboard nog niet klaar
  }
  onbWin.addEventListener('close', () => document.body.classList.remove('onb-open'));
  $('#onbNext').addEventListener('click', () => onbGo(1));
  $('#onbBack').addEventListener('click', () => onbGo(-1, false));
  $('#onbSkip').addEventListener('click', () => onbGo(1, false));
  $('#onbLater').addEventListener('click', () => onbFinish(true));
  onbWin.addEventListener('cancel', (e) => e.preventDefault()); // Escape sluit de wizard niet per ongeluk
  // Enter in een veld van de wizard = Volgende (niet in de formulieren van tweestapsverificatie).
  $('#onbBody').addEventListener('submit', (e) => { if (!e.target.closest('[data-onb-form]')) return; e.preventDefault(); onbGo(1); });

  function demoOnboarded() { try { return localStorage.getItem('tb-onboarded') === '1'; } catch (e) { return true; } }
  function demoClock() { try { return localStorage.getItem('tb-clock') || 'auto'; } catch (e) { return 'auto'; } }
  // De demo begint zoals een nieuwe server: eerst een account aanmaken (tot de wizard één keer afgerond is).
  function useDemo() {
    api = translatedApi(window.HomeBaseOSDemo);
    S.config = { demo: true, ollama: true, terminal: true, passwordEnabled: true, loginUser: true, clock: demoClock(), onboarding: !demoOnboarded(), setup: !demoOnboarded() };
    startDesk();
  }

  /* ------------------------------------------------------------ gebeurtenissen */
  document.addEventListener('click', (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      const text = cp.dataset.copy;
      const ok = () => toast(t('Gekopieerd: {text}', { text }));
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, () => toast(t('Kopiëren lukte niet in deze browser.'), true));
      else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); const r = document.execCommand('copy'); ta.remove(); if (r) ok(); else toast(t('Kopiëren lukte niet in deze browser.'), true); }
      return;
    }
    const con = e.target.closest('[data-console]');
    if (con) { openConsole(con.dataset.console); return; }
    const ext = e.target.closest('a[target="_blank"]');
    if (ext && api !== realApi) {
      e.preventDefault();
      toast(t(ext.href.startsWith('vnc:') ? 'In de demo opent dit het scherm van de VM op je eigen server.' : 'In de demo opent dit de app op je eigen server.'));
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      ({ home: goHome, storage: storageWindow, shares: sharesWindow, vms: () => { location.hash = 'vms'; }, store: () => { location.hash = 'store'; }, ai: aiWindow })[open.dataset.open]();
      return;
    }
    const fo = e.target.closest('[data-folder-open]');
    if (fo) { openFolder(fo.dataset.folderOpen); return; }
    if (S.arrange && e.target.closest('#appGrid, #folderGrid')) return; // rangschikken: klikken opent niets
    // Linksklik opent de webinterface (zoals in Unraid). Geen adres of staat de app uit? Dan het menu.
    const app = e.target.closest('[data-app]');
    if (app && !menu.contains(app)) {
      const a = S.apps.find((x) => x.id === app.dataset.app); if (!a) return;
      if (app.dataset.action === 'open' && appUrl(a)) return openAppUrl(a);
      const r = app.getBoundingClientRect();
      openAppMenu(a, app.dataset.action === 'menu' ? r.right - 8 : r.left + 8, r.bottom + 4, app);
    }
  });
  // Pictogram kan niet laden → toon de beginletter op een gekleurde tegel (apps, appstore en vensters).
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
    if (S.config.demo) showLogin(); else location.reload(); // de demo toont het aanmeldscherm
  });

  /* --- aanmelden: eerst het wachtwoord, daarna (als het aan staat) een code uit de authenticator-app of een herstelcode */
  const loginApi = () => (S.config && S.config.demo ? api : realApi);
  let mfaPending = null, mfaRecovery = false;
  function loginStep(step) {
    const two = step === 'mfa';
    $('#loginForm').hidden = two; $('#mfaForm').hidden = !two;
    $('#loginTitle').textContent = two ? t('Tweestapsverificatie') : t('Welkom terug');
    $('#loginSub').textContent = two ? t('Typ de code van 6 cijfers uit je authenticator-app.') : t('Meld je aan om je server te beheren.');
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
    $('#mfaLabel').textContent = on ? t('Herstelcode') : t('Code uit je authenticator-app');
    $('#loginSub').textContent = on ? t('Typ een van de herstelcodes die je bewaard hebt. Elke code werkt maar één keer.') : t('Typ de code van 6 cijfers uit je authenticator-app.');
    $('#mfaToggle').textContent = on ? t('Gebruik de app') : t('Gebruik een herstelcode');
    $('#mfaError').textContent = '';
    c.focus();
  }
  function shake() { const c = $('.login-card'); c.classList.remove('login-shake'); void c.offsetWidth; c.classList.add('login-shake'); }
  function loggedIn(r) {
    if (r && r.recovery) toast(t('Aangemeld met een herstelcode. Je hebt er nog {n} over.', { n: r.recoveryLeft }), r.recoveryLeft < 3);
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
  // Zes cijfers getypt, geplakt of ingevuld door de gsm? Meteen bevestigen.
  $('#mfaCode').addEventListener('input', (e) => {
    if (!mfaRecovery && /^\d{6}$/.test(e.target.value.replace(/\s/g, ''))) $('#mfaForm').requestSubmit();
  });
  $('#mfaToggle').addEventListener('click', () => setRecoveryMode(!mfaRecovery));
  $('#mfaBack').addEventListener('click', () => loginStep('password'));
  $('#pwShow').addEventListener('click', (e) => {
    const b = e.currentTarget, show = $('#pw').type === 'password';
    $('#pw').type = show ? 'text' : 'password'; b.setAttribute('aria-pressed', String(show));
    const label = show ? t('Wachtwoord verbergen') : t('Wachtwoord tonen');
    b.setAttribute('aria-label', label); b.title = label;
    $('#pw').focus();
  });

  /* sterren voor de avondhemel */
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
    try { cfg = await realApi.get('/api/config'); } catch (e) { return useDemo(); } // geen server: statische demo
    S.config = cfg;
    if (cfg.demo) return useDemo(); // in de demo bewaart de browser zelf de taal
    // Nog geen account: alleen de welkomstwizard (de taal kies je daar; die van de server geldt pas daarna).
    if (cfg.setup) { $('.topnav').hidden = true; return openOnboarding(0); }
    if (cfg.language && cfg.language !== LANG) setLang(cfg.language); // de taal van de server geldt voor iedereen
    if (cfg.needsLogin) return showLogin();
    startDesk();
  }
  tickClock(); setInterval(tickClock, 1000 * 15);
  boot();
})();
