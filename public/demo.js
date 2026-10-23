/* Demo-adapter: dezelfde endpoints als server.js, maar met voorbeelddata in de browser. */
(function () {
  'use strict';
  const GB = 1024 ** 3, TB = 1024 ** 4;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const copy = (o) => JSON.parse(JSON.stringify(o));
  function err(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

  /* ---- apps (Docker Compose) */
  const appDefs = [
    ['jellyfin', 'jellyfin/jellyfin:latest', 8096, 'running', 'media'],
    ['immich', 'ghcr.io/immich-app/immich-server:release', 2283, 'running', 'immich'],
    ['nextcloud', 'nextcloud:30', 8443, 'running', 'nextcloud'],
    ['ollama', 'ollama/ollama:latest', 11434, 'running', 'ai'],
    ['open-webui', 'ghcr.io/open-webui/open-webui:main', 3000, 'running', 'ai'],
    ['paperless-ngx', 'ghcr.io/paperless-ngx/paperless-ngx', 8000, 'running', 'paperless'],
    ['vaultwarden', 'vaultwarden/server:latest', 8222, 'running', 'vaultwarden'],
    ['nginx-proxy-manager', 'jc21/nginx-proxy-manager', 81, 'running', 'proxy'],
    ['mosquitto', 'eclipse-mosquitto:2', null, 'running', 'domotica'],
    ['zigbee2mqtt', 'koenkk/zigbee2mqtt', 8099, 'running', 'domotica'],
    ['frigate', 'ghcr.io/blakeblackshear/frigate:stable', 5000, 'running', 'frigate'],
    ['whisper', 'rhasspy/wyoming-whisper', null, 'running', 'domotica'],
    ['piper', 'rhasspy/wyoming-piper', null, 'running', 'domotica'],
    ['syncthing', 'syncthing/syncthing', 8384, 'running', 'syncthing'],
    ['uptime-kuma', 'louislam/uptime-kuma:1', 3001, 'running', 'monitoring'],
    ['dockge', 'louislam/dockge:1', 5001, 'running', 'dockge'],
    ['pihole', 'pihole/pihole:latest', 8053, 'exited', 'pihole'],
    ['duplicati', 'duplicati/duplicati', 8200, 'running', 'backup'],
    ['qbittorrent', 'linuxserver/qbittorrent', 8085, 'exited', 'media'],
    ['homepage', 'ghcr.io/gethomepage/homepage', 3010, 'running', 'homepage'],
  ];
  // Pictogrammen zoals de server ze vindt: uit de catalogus of uit dashboard-icons (Whisper en Piper staan daar niet in).
  const ICON = (n) => (n ? 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/' + n + '.png' : null);
  const ICON_NAME = { pihole: 'pi-hole', whisper: null, piper: null };
  // Opslaglocaties (Instellingen → Opslag): appgegevens kunnen verhuizen, de rest volgt dat pad.
  const sp = { appdata: '/snel/appdata', vms: '/tank/vms', isos: '/tank/isos', shares: '/tank' };
  const AD = () => sp.appdata;
  const apps = appDefs.map(([name, image, port, state, compose], i) => ({
    id: 'demo:' + name, name, image, state: state.toUpperCase(),
    status: state === 'running' ? 'Up ' + (2 + (i % 9)) + ' days' : 'Exited (0) 3 hours ago',
    autoStart: state === 'running', icon: ICON(name in ICON_NAME ? ICON_NAME[name] : name),
    webui: port ? 'http://[IP]:' + port + '/' : null,
    ports: port ? [{ public: port, private: port, type: 'TCP' }] : [],
    compose, canUpdate: true,
    // Zoals na een controle bij de registry: vier apps hebben een nieuwere versie.
    update: ['immich', 'open-webui', 'zigbee2mqtt', 'qbittorrent'].includes(name), updateChecked: Date.now() - 2 * 3600000, updateError: null,
    // Vaultwarden en Syncthing doen alsof ze uit de appstore komen, zodat je Verwijderen kan proberen.
    storeId: name === 'vaultwarden' ? 'a1b2c3d4e5f6' : name === 'syncthing' ? 'b2c3d4e5f6a1' : null,
    dataDirs: name === 'vaultwarden' || name === 'syncthing' ? [AD() + '/' + name] : [],
  }));
  // Pi-hole heeft een eigen adres in het thuisnetwerk (macvlan, zie Docker-netwerken hieronder).
  Object.assign(apps.find((a) => a.name === 'pihole'), { webui: 'http://192.168.1.53/admin/', ports: [] });

  /* ---- instellingen: taal, over en netwerk */
  const demoSecurity = { terminal: true, terminalPassword: true };
  /* ---- welkomstwizard: per browser onthouden of hij al afgerond is */
  const onb = { passwordChanged: null };
  const onbDone = () => { try { return localStorage.getItem('tb-onboarded') === '1'; } catch (e) { return true; } };
  const onbSet = (v) => { try { if (v) localStorage.setItem('tb-onboarded', '1'); else localStorage.removeItem('tb-onboarded'); } catch (e) { /* privévenster */ } };
  function onbGet() {
    const o = poolOptions();
    return { done: onbDone(), finished: null, skipped: false, hostname: net.hostname, timezone: dt.timezone, passwordChanged: onb.passwordChanged, user: acct.user, mfa: mfa.enabled, appdata: sp.appdata,
      pools: pools.map((x) => ({ name: x.name, total: x.total, health: x.health })),
      freeDisks: o.disks.filter((d) => d.available).map((d) => ({ name: d.name, size: d.size, model: d.model, rotational: d.rotational, transport: d.transport })) };
  }
  function demoPassword(body) {
    if (String(body.current || '') !== DEMO_PW) throw err('Je huidige wachtwoord klopt niet.', 401);
    const v = String(body.password || '');
    if (v.length < 10) throw err('Kies een wachtwoord van minstens 10 tekens.');
    if (v.length > 200) throw err('Het wachtwoord is te lang (maximaal 200 tekens).');
    if (/^(.)\1+$/.test(v) || /^(0123456789|1234567890|wachtwoord|password)/i.test(v)) throw err('Dit wachtwoord is te makkelijk te raden. Kies een ander.');
    onb.passwordChanged = new Date().toISOString(); // in de demo blijft aanmelden met "demo" werken
    return { ok: true, changed: onb.passwordChanged };
  }
  const demoClock = () => { try { return localStorage.getItem('tb-clock') || 'auto'; } catch (e) { return 'auto'; } };

  /* ---- software-update: een nagebootste nieuwe versie met release-notes */
  const upd = { auto: true, channel: 'stable', checked: new Date(Date.now() - 3 * 3600000).toISOString() };
  const demoReleases = [
    { version: '0.4.0-beta.1', name: 'v0.4.0-beta.1', prerelease: true, published: '2026-10-21T09:00:00Z',
      notes: '## Om te testen\n\n- Snapshots van VM\'s maken en terugzetten\n- **Let op:** nog niet geschikt voor dagelijks gebruik' },
    { version: '0.3.0', name: 'Datum, tijd en tweestapsverificatie', prerelease: false, published: '2026-10-20T18:00:00Z',
      notes: '## Nieuw\n\n- **Aanmelden met tweestapsverificatie** (TOTP) met herstelcodes\n- Datum, tijd en tijdzone instellen bij *Instellingen > Algemeen*\n- Tijdnotatie: 24 of 12 uur\n\n## Verbeterd\n\n- Snellere lijst met apps\n- De console onthoudt de grootte van het venster\n\n## Opgelost\n\n- Een share zonder gebruikers gaf een fout bij het opslaan\n\n**Volledige lijst**: https://github.com/lennertvh1/homebaseos/compare/v0.2.0...v0.3.0' },
    { version: '0.2.0', name: 'v0.2.0', prerelease: false, published: '2026-10-01T12:00:00Z',
      notes: '## Nieuw\n\n- Appstore met de catalogus van Unraid Community Apps\n- Schijfbays, ZFS-pools en gedeelde mappen\n- Terminal op de server' },
  ].map((r) => ({ ...r, url: 'https://github.com/lennertvh1/homebaseos/releases/tag/v' + r.version }));
  function updGet() {
    const list = demoReleases.filter((r) => upd.channel === 'beta' || !r.prerelease), cur = upd.current || '0.2.0';
    const i = Math.max(0, list.findIndex((r) => r.version === cur)), newer = list.slice(0, i);
    return { repo: 'lennertvh1/homebaseos', token: true, auto: upd.auto, channel: upd.channel, checked: upd.checked, error: null, current: cur,
      latest: list[0], updateAvailable: newer.length > 0, newer, installed: list[i] || null, history: list.slice(i),
      install: { ok: true, reason: null }, running: !!(upd.job && !upd.job.finished) };
  }
  // Nu bijwerken, nagebootst: dezelfde stappen als lib/updater.js + lib/update-helper.sh, met een herstart waarin de server even weg is.
  const UPD_PLAN = [[0, 'download', 2], [4000, 'extract', 42, 'Uitpakken…'], [5000, 'verify', 50, 'De nieuwe versie controleren…'],
    [6500, 'handover', 56, 'Klaar om te installeren…'], [7000, 'backup', 60, 'Reservekopie maken van versie {from}…'],
    [8500, 'install', 68, 'Nieuwe bestanden installeren…'], [10000, 'restart', 85, 'HomeBaseOS herstarten…'],
    [13500, 'check', 92, 'Controleren of versie {version} goed draait…'], [15500, 'done', 100, 'Bijgewerkt naar versie {version}.']];
  function updProgress() {
    const j = upd.job; if (!j) return { state: 'idle' };
    const ms = Date.now() - j.start;
    if (ms > 10500 && ms < 13500) throw err('Failed to fetch', 503); // de server herstart
    const [, step, pct, msg] = UPD_PLAN.filter((x) => x[0] <= ms).pop();
    const fill = (m) => m.replace('{from}', j.from).replace('{version}', j.version);
    const out = { state: step === 'done' ? 'done' : 'running', step, percent: pct, version: j.version, from: j.from, message: fill(msg || 'Versie {version} downloaden…') };
    if (step === 'download') { const total = 1.9 * 1024 * 1024; out.bytes = Math.round(total * Math.min(1, ms / 4000)); out.total = total; out.percent = Math.round(2 + 38 * out.bytes / total); }
    if (step === 'done' && !j.finished) { j.finished = true; upd.current = j.version; }
    return out;
  }

  /* ---- datum en tijd (zoals timedatectl): offset = verschil met de klok van de browser */
  const dt = { timezone: 'Europe/Brussels', ntp: true, servers: [], offset: 0 };
  const DEFAULT_NTP = ['0.debian.pool.ntp.org', '1.debian.pool.ntp.org', '2.debian.pool.ntp.org', '3.debian.pool.ntp.org'];
  let zones = null;
  const demoZones = () => zones || (zones = (() => { try { return Intl.supportedValuesOf('timeZone').concat('UTC').sort(); } catch (e) { return ['Europe/Brussels', 'UTC']; } })());
  function dtGet() {
    return { now: Date.now() + dt.offset, timezone: dt.timezone, ntp: dt.ntp, ntpAvailable: true, synced: dt.ntp, localRtc: false,
      server: dt.ntp ? (dt.servers[0] || DEFAULT_NTP[0]) : null, servers: dt.servers.slice(), defaultServers: DEFAULT_NTP, editable: true, timezones: demoZones() };
  }
  function dtSet(body) {
    if (body.timezone != null && !demoZones().includes(body.timezone)) throw err('Kies een tijdzone uit de lijst.');
    let servers = dt.servers;
    if (body.servers != null) {
      servers = [...new Set(String(body.servers).split(/[\s,;]+/).filter(Boolean))];
      if (servers.length > 6) throw err('Geef maximaal 6 tijdservers op.');
      const bad = servers.find((h) => !/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(h) || h.includes('..'));
      if (bad) throw err('"' + bad + '" is geen geldige tijdserver. Gebruik een naam zoals be.pool.ntp.org of een IP-adres.');
    }
    const ntp = body.ntp == null ? dt.ntp : !!body.ntp;
    let offset = ntp ? 0 : dt.offset;
    if (body.time) {
      if (ntp) throw err('Zet de automatische tijd eerst uit om de tijd zelf in te stellen.', 409);
      const m = String(body.time).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (!m) throw err('Vul een geldige datum en tijd in.');
      // De ingevulde tijd geldt in de tijdzone van de server: reken het verschil met die tijdzone uit.
      const tz = body.timezone || dt.timezone, guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)).map((x) => [x.type, +x.value || x.value]));
      const tzOff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess;
      offset = guess - tzOff - Date.now();
    }
    Object.assign(dt, { timezone: body.timezone || dt.timezone, servers, ntp, offset });
    return dtGet();
  }

  /* ---- aanmelden met tweestapsverificatie: echte TOTP-codes (RFC 6238), zodat je het met je eigen authenticator-app kan proberen.
     Wachtwoord in de demo: demo. Alles blijft in het geheugen van deze tab. */
  const DEMO_PW = 'demo';
  /* ---- account: de demo begint zoals een nieuwe server (account aanmaken in de welkomstwizard) */
  const acct = { user: (() => { try { return localStorage.getItem('tb-demo-user') || 'demo'; } catch (e) { return 'demo'; } })(), password: null };
  function demoSetup(b) {
    if (onbDone()) throw err('Er is al een account. Meld je aan.', 409);
    const u = String(b.user || '').trim().toLowerCase(), v = String(b.password || '');
    if (!/^[a-z][a-z0-9._-]{1,31}$/.test(u)) throw err('Kies een gebruikersnaam van 2 tot 32 tekens: kleine letters, cijfers, punt, - of _, en begin met een letter.');
    if (v !== String(b.repeat || '')) throw err('De twee wachtwoorden zijn niet gelijk.');
    if (v.length < 10) throw err('Kies een wachtwoord van minstens 10 tekens.');
    if (/^(.)\1+$/.test(v) || /^(0123456789|1234567890|wachtwoord|password)/i.test(v)) throw err('Dit wachtwoord is te makkelijk te raden. Kies een ander.');
    acct.user = u; acct.password = v; // het wachtwoord alleen in het geheugen; "demo" blijft ook werken
    try { localStorage.setItem('tb-demo-user', u); } catch (e) { /* privévenster */ }
    if (b.language) { try { localStorage.setItem('tb-lang', b.language); } catch (e) { /* privévenster */ } }
    onb.passwordChanged = new Date().toISOString();
    return { ok: true, user: u };
  }
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const b32enc = (bytes) => { let bits = 0, v = 0, o = ''; for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } return bits ? o + B32[(v << (5 - bits)) & 31] : o; };
  const b32dec = (str) => { let bits = 0, v = 0; const o = []; for (const ch of str) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(o); };
  async function hotp(secret, ctr) {
    const key = await crypto.subtle.importKey('raw', b32dec(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const msg = new DataView(new ArrayBuffer(8)); msg.setUint32(0, Math.floor(ctr / 2 ** 32)); msg.setUint32(4, ctr >>> 0);
    const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg.buffer)), o = h[19] & 15;
    return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
  }
  const mfa = { enabled: false, secret: null, setup: null, recovery: [], lastCounter: -1, since: null, pending: null };
  const RC = 'abcdefghjkmnpqrstuvwxyz23456789';
  const newCodes = () => Array.from({ length: 10 }, () => { const s = [...crypto.getRandomValues(new Uint8Array(10))].map((x) => RC[x % RC.length]).join(''); return s.slice(0, 5) + '-' + s.slice(5); });
  async function totpCheck(secret, code, last = -1) {
    const c = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(c)) return null;
    const base = Math.floor(Date.now() / 30000);
    for (let d = -1; d <= 1; d++) if (base + d > last && (await hotp(secret, base + d)) === c) return base + d;
    return null;
  }
  async function mfaCheck(code) {
    const ctr = await totpCheck(mfa.secret, code, mfa.lastCounter);
    if (ctr != null) { mfa.lastCounter = ctr; return { ok: true }; }
    const norm = String(code || '').toLowerCase().replace(/[^a-z0-9]/g, ''), i = mfa.recovery.findIndex((x) => x.replace('-', '') === norm);
    if (norm.length === 10 && i >= 0) { mfa.recovery.splice(i, 1); return { ok: true, recovery: true, recoveryLeft: mfa.recovery.length }; }
    return { ok: false };
  }
  async function authPost(path, body) {
    if (path === '/api/login') {
      const pwOk = String(body.password || '') === DEMO_PW || (acct.password && body.password === acct.password);
      if (!pwOk || String(body.user || '').trim().toLowerCase() !== acct.user) { await wait(800); throw err('Verkeerde gebruikersnaam of wachtwoord', 401); }
      if (mfa.enabled) { mfa.pending = { id: Math.random().toString(36).slice(2), until: Date.now() + 300000, tries: 0 }; return { mfa: true, pending: mfa.pending.id }; }
      return { ok: true };
    }
    if (path === '/api/login/mfa') {
      const p = mfa.pending;
      if (!p || p.id !== body.pending || p.until < Date.now()) throw Object.assign(err('Je aanmelding is verlopen. Typ je wachtwoord opnieuw.', 401), { expired: true });
      const r = await mfaCheck(body.code);
      if (!r.ok) { if (++p.tries >= 5) mfa.pending = null; await wait(800); throw err('Die code klopt niet.', 401); }
      mfa.pending = null;
      return { ok: true, recovery: !!r.recovery, recoveryLeft: r.recoveryLeft };
    }
    const action = path.slice('/api/mfa/'.length);
    if (action === 'enable') {
      if (!mfa.setup) throw err('Het koppelen duurde te lang. Begin opnieuw.', 410);
      const ctr = await totpCheck(mfa.setup, body.code);
      if (ctr == null) throw err('Die code klopt niet. Controleer de klok van je gsm en typ de code die nu in de app staat.');
      const codes = newCodes();
      Object.assign(mfa, { enabled: true, secret: mfa.setup, setup: null, recovery: codes.slice(), lastCounter: ctr, since: new Date().toISOString() });
      return { recovery: codes };
    }
    if (String(body.password || '') !== DEMO_PW) { await wait(800); throw err('Verkeerd wachtwoord', 401); }
    if (action === 'setup') {
      if (mfa.enabled) throw err('Tweestapsverificatie staat al aan. Zet ze eerst uit om opnieuw te koppelen.', 409);
      mfa.setup = b32enc(crypto.getRandomValues(new Uint8Array(20)));
      return { secret: mfa.setup, uri: `otpauth://totp/HomeBaseOS:freddy?secret=${mfa.setup}&issuer=HomeBaseOS&algorithm=SHA1&digits=6&period=30` };
    }
    if (!(await mfaCheck(body.code)).ok) { await wait(800); throw err('Die code klopt niet.', 401); }
    if (action === 'disable') { Object.assign(mfa, { enabled: false, secret: null, recovery: [], lastCounter: -1, since: null }); return { ok: true }; }
    if (action === 'recovery') { mfa.recovery = newCodes(); return { recovery: mfa.recovery.slice() }; }
    throw err('Onbekend endpoint', 404);
  }
  const demoLang = () => { try { return localStorage.getItem('tb-lang') || 'nl'; } catch (e) { return 'nl'; } };
  function demoAbout() {
    return {
      hostname: net.hostname, os: 'Debian GNU/Linux 13 (trixie)', kernel: '6.12.48+deb13-amd64', arch: 'x86_64', uptime: Math.round((Date.now() - bootTime) / 1000),
      timezone: 'Europe/Brussels', cpu: { brand: 'AMD Ryzen 7 5700X 8-Core Processor', cores: 8, threads: 16 }, memory: 32 * GB,
      ecc: { active: true, mode: 'SECDED', corrected: 0 }, gpus: ['NVIDIA GeForce RTX 3060 Ti'],
      board: { vendor: 'ASRock', product: 'B550M Steel Legend', boardVendor: 'ASRock', board: 'B550M Steel Legend', bios: 'P3.20', biosDate: '06/13/2025' },
      addresses: [{ interface: 'br0', address: net.links[1].ipv4[0].address.split('/')[0] }],
      versions: { homebaseos: '0.2.0', node: '20.19.2', docker: '28.5.1', compose: '2.40.0', zfs: '2.3.2', libvirt: '11.3.0', hypervisor: 'QEMU 10.0.2' },
    };
  }
  const net = {
    hostname: 'freddy', manager: 'ifupdown', editable: true, physical: ['enp5s0'], dns: ['192.168.1.1', '1.1.1.1'], resolvManaged: false, pending: null,
    links: [
      { name: 'enp5s0', mac: 'a8:a1:59:3c:21:7e', up: true, state: 'UP', kind: 'ethernet', master: 'br0', ipv4: [], ipv6: [], gateway: null, speed: 2500 },
      { name: 'br0', mac: 'a8:a1:59:3c:21:7e', up: true, state: 'UP', kind: 'bridge', master: null, ipv4: [{ address: '192.168.1.10/24', dynamic: false }], ipv6: [], gateway: '192.168.1.1', speed: null },
    ],
    config: { interface: 'enp5s0', mode: 'static', address: '192.168.1.10/24', gateway: '192.168.1.1', dns: ['192.168.1.1', '1.1.1.1'], bridge: true, bridgeName: 'br0' },
  };
  let netBackup = null;
  function tickNet() { if (net.pending && Date.now() > net.pending.until) { Object.assign(net, JSON.parse(netBackup)); net.pending = null; } }
  function demoNetPost(path, body) {
    tickNet();
    if (path === '/api/network/hostname') {
      const h = String(body.hostname || '').trim().toLowerCase();
      if (!/^(?=.{1,63}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(h)) throw err('Een hostnaam bestaat uit letters, cijfers en -, en is maximaal 63 tekens lang.');
      net.hostname = h; return { hostname: h };
    }
    if (path === '/api/network/confirm' || path === '/api/network/revert') {
      if (!net.pending) throw err('Er wachten geen netwerkinstellingen op bevestiging.', 409);
      if (path.endsWith('revert')) Object.assign(net, JSON.parse(netBackup));
      net.pending = null; return { ok: true };
    }
    if (net.pending) throw err('Er wachten al nieuwe netwerkinstellingen op bevestiging.', 409);
    const ip = /^(\d{1,3}\.){3}\d{1,3}$/;
    let address = null;
    if (body.mode === 'static') {
      const [a, pre] = String(body.address || '').split('/');
      if (!ip.test(a) || !(Number(pre) >= 8 && Number(pre) <= 32)) throw err('Vul het IP-adres in met de netmasker-lengte, bv. 192.168.1.10/24.');
      if (!ip.test(String(body.gateway || ''))) throw err('Vul de gateway in, meestal het adres van je router (bv. 192.168.1.1).');
      if (a.split('.').slice(0, 3).join('.') !== body.gateway.split('.').slice(0, 3).join('.')) throw err('De gateway ligt niet in hetzelfde netwerk als het IP-adres.');
      const dns = String(body.dns || '').split(/[\s,]+/).filter(Boolean);
      const bad = dns.find((d) => !ip.test(d)); if (bad) throw err('"' + bad + '" is geen geldig DNS-adres.');
      if (!dns.length) throw err('Vul minstens één DNS-server in, bv. je router of 1.1.1.1.');
      address = a;
    }
    const { pending, ...rest } = net; netBackup = JSON.stringify(rest);
    net.config = { ...net.config, mode: body.mode, address: body.address, gateway: body.gateway, dns: String(body.dns || '').split(/[\s,]+/).filter(Boolean), bridge: !!body.bridge };
    net.pending = { until: Date.now() + 120000 };
    // In de demo blijft de pagina op hetzelfde adres, zodat je meteen kan bevestigen.
    return { pending: net.pending, address: null };
  }

  /* ---- Docker-netwerken: pihole heeft een eigen adres in het thuisnetwerk (macvlan op br0) */
  const dnets = [
    { name: 'bridge', driver: 'bridge', subnet: '172.17.0.0/16', gateway: '172.17.0.1' },
    { name: 'host', driver: 'host' }, { name: 'none', driver: 'null' },
    { name: 'lan', driver: 'macvlan', subnet: '192.168.1.0/24', gateway: '192.168.1.1', ipRange: '192.168.1.192/27', parent: 'br0', ours: true },
    { name: 'proxy', driver: 'bridge', subnet: '172.20.0.0/24', gateway: '172.20.0.1', ours: true },
    { name: 'media_default', driver: 'bridge', subnet: '172.18.0.0/16', gateway: '172.18.0.1', compose: 'media' },
  ].map((n, i) => ({ id: (i + 1).toString(16).padStart(12, 'a'), builtin: ['bridge', 'host', 'none'].includes(n.name), internal: false,
    subnet: null, gateway: null, ipRange: null, parent: null, compose: null, ours: false, created: new Date(Date.now() - 30 * 86400000).toISOString(), ...n }));
  // Welke app in welk eigen netwerk zit (de rest zit in het standaardnetwerk van zijn compose-project).
  const appNet = { pihole: { net: 'lan', ip: '192.168.1.53' }, 'nginx-proxy-manager': { net: 'proxy', ip: '' }, vaultwarden: { net: 'proxy', ip: '' },
    nextcloud: { net: 'proxy', ip: '' }, jellyfin: { net: 'media_default', ip: '' }, qbittorrent: { net: 'media_default', ip: '' } };
  const ownIpNet = (name) => { const n = dnets.find((x) => x.name === name); return !!n && /^(macvlan|ipvlan)$/.test(n.driver); };
  const ip4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipN = (ip) => ip.split('.').reduce((x, o) => x * 256 + Number(o), 0);
  function cidr(sv, min = 8, max = 30) {
    const [ip, p] = String(sv || '').trim().split('/');
    if (!ip4.test(ip) || ip.split('.').some((o) => Number(o) > 255) || !/^\d{1,2}$/.test(p || '') || Number(p) < min || Number(p) > max) return null;
    const size = 2 ** (32 - Number(p)), base = ipN(ip) - (ipN(ip) % size);
    return { base, size, prefix: Number(p), text: [16777216, 65536, 256, 1].map((d) => Math.floor(base / d) % 256).join('.') + '/' + p };
  }
  const inCidr = (c, ip) => ipN(ip) >= c.base && ipN(ip) < c.base + c.size;
  const overlap = (a, b) => a.base < b.base + b.size && b.base < a.base + a.size;
  // Vrij adres in het IP-bereik van een netwerk, zoals Docker er een uitdeelt.
  function freeIp(n) {
    const r = cidr(n.ipRange || n.subnet, 8, 32); if (!r) return '';
    const used = new Set(Object.values(appNet).filter((x) => x.net === n.name).map((x) => x.ip).concat(n.gateway));
    for (let i = 2; i < r.size - 1; i++) { const ip = [16777216, 65536, 256, 1].map((d) => Math.floor((r.base + i) / d) % 256).join('.'); if (!used.has(ip)) return ip; }
    return '';
  }
  function dnetList() {
    const networks = dnets.map((n) => ({ ...copy(n), containers: apps.filter((a) => (appNet[a.name] ? appNet[a.name].net : a.compose + '_default') === n.name)
      .map((a) => ({ name: a.name, ip: appNet[a.name] && appNet[a.name].ip ? appNet[a.name].ip : null })).sort((x, y) => x.name.localeCompare(y.name)) }))
      .sort((a, b) => (a.builtin - b.builtin) || a.name.localeCompare(b.name));
    return { networks, parents: [{ name: 'br0', kind: 'bridge', address: '192.168.1.10', subnet: '192.168.1.0/24', gateway: '192.168.1.1' }] };
  }
  function dnetCreate(f) {
    const name = String(f.name || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name)) throw err('Kies een naam met letters, cijfers, -, _ of . (maximaal 63 tekens), bv. thuisnet.');
    if (dnets.some((n) => n.name === name)) throw err('Er bestaat al een netwerk met de naam ' + name + '. Kies een andere naam.', 409);
    const driver = String(f.driver || 'bridge'); if (!['bridge', 'macvlan', 'ipvlan'].includes(driver)) throw err('Kies een soort netwerk: bridge, macvlan of ipvlan.');
    const own = driver !== 'bridge';
    const st = String(f.subnet || '').trim(), sn = st ? cidr(st) : null;
    if (st && !sn) throw err('"' + st + '" is geen geldig subnet. Schrijf het als 192.168.1.0/24.');
    if (own && !sn) throw err('Vul het subnet van je thuisnetwerk in, bv. 192.168.1.0/24.');
    const gw = String(f.gateway || '').trim();
    if (gw && !ip4.test(gw)) throw err('"' + gw + '" is geen geldig IP-adres voor de gateway.');
    if (gw && !sn) throw err('Vul ook het subnet in als je een gateway kiest.');
    if (gw && !inCidr(sn, gw)) throw err('De gateway ' + gw + ' ligt niet in het subnet ' + sn.text + '.');
    if (own && !gw) throw err('Vul de gateway in, meestal het adres van je router (bv. 192.168.1.1).');
    const rt = own ? String(f.ipRange || '').trim() : '', rg = rt ? cidr(rt, 8, 32) : null;
    if (rt && !rg) throw err('"' + rt + '" is geen geldig IP-bereik. Schrijf het als 192.168.1.192/27.');
    if (rg && !(rg.prefix >= sn.prefix && inCidr(sn, rt.split('/')[0]))) throw err('Het IP-bereik ' + rg.text + ' ligt niet in het subnet ' + sn.text + '.');
    if (own && f.parent !== 'br0') throw err('Kies de netwerkkaart (of bridge) die met je thuisnetwerk verbonden is.');
    if (sn) {
      const clash = dnets.find((n) => n.subnet && overlap(sn, cidr(n.subnet, 0, 32)));
      if (clash) throw err('Het subnet ' + sn.text + ' overlapt met het netwerk ' + clash.name + ' (' + clash.subnet + '). Kies een ander subnet.', 409);
      if (!own && overlap(sn, cidr('192.168.1.0/24'))) throw err('Het subnet ' + sn.text + ' is het netwerk van br0. Een bridge heeft een eigen subnet nodig, bv. 172.30.0.0/24. Kies macvlan of ipvlan voor adressen in je thuisnetwerk.', 409);
    }
    let subnet = sn ? sn.text : null, gateway = gw || null;
    if (!sn) { for (let i = 21; dnets.some((n) => n.subnet === '172.' + i + '.0.0/16'); i++) subnet = '172.' + (i + 1) + '.0.0/16'; subnet = subnet || '172.21.0.0/16'; gateway = subnet.replace('0.0/16', '0.1'); }
    dnets.push({ id: Math.random().toString(16).slice(2, 14).padEnd(12, '0'), name, driver, builtin: false, internal: !own && !!f.internal, subnet, gateway,
      ipRange: rg ? rg.text : null, parent: own ? 'br0' : null, compose: null, ours: true, created: new Date().toISOString() });
    return { id: dnets[dnets.length - 1].id, name };
  }
  function dnetDelete(name) {
    const n = dnets.find((x) => x.name === name); if (!n) throw err('network ' + name + ' not found', 404);
    if (n.builtin) throw err('Het netwerk ' + n.name + ' hoort bij Docker zelf en kan je niet verwijderen.');
    const users = dnetList().networks.find((x) => x.name === name).containers;
    if (users.length) throw err('Het netwerk ' + n.name + ' wordt nog gebruikt door ' + users.map((c) => c.name).join(', ') + '. Haal die apps er eerst uit.', 409);
    dnets.splice(dnets.indexOf(n), 1);
    return { removed: n.name };
  }
  // Netwerk van een app zetten. Met een eigen adres zijn er geen poorten op de server en wijst de WebUI naar dat adres.
  function setAppNet(a, network, ip) {
    if (!network || network === 'host' || network === 'none' || network === 'bridge') { delete appNet[a.name]; return; }
    const n = dnets.find((x) => x.name === network); if (!n) throw err('Het netwerk ' + network + ' bestaat niet. Maak het aan bij Instellingen → Docker-netwerken of kies een ander netwerk.');
    if (ip && !ip4.test(ip)) throw err('"' + ip + '" is geen geldig IP-adres.');
    if (ip && !inCidr(cidr(n.subnet, 0, 32), ip)) throw err('Het adres ' + ip + ' ligt niet in het subnet ' + n.subnet + ' van dit netwerk.');
    appNet[a.name] = { net: network, ip: ip || (ownIpNet(network) ? freeIp(n) : '') };
  }

  /* ---- indeling van het startscherm: twee mappen, de rest volgt vanzelf */
  let layout = { items: ['jellyfin', 'immich', 'nextcloud', 'paperless-ngx', 'vaultwarden',
    { folder: 'fdomotica', name: 'Domotica', apps: ['mosquitto', 'zigbee2mqtt', 'whisper', 'piper', 'frigate'] },
    { folder: 'fai', name: 'AI', apps: ['ollama', 'open-webui'] }] };
  function saveLayout(b) {
    if (!b || !Array.isArray(b.items)) throw err('De indeling klopt niet.');
    const seen = new Set();
    const items = b.items.map((it) => {
      if (typeof it === 'string') { if (seen.has(it)) return null; seen.add(it); return it; }
      const apps = (it.apps || []).filter((n) => !seen.has(n) && seen.add(n));
      return apps.length > 1 ? { folder: it.folder, name: String(it.name || 'Map').slice(0, 40), apps } : apps[0] || null;
    }).filter(Boolean);
    const ok = (a) => [...new Set((Array.isArray(a) ? a : []).filter((x) => /^[a-z]{2,16}$/.test(x)))];
    layout = { items, widgets: { order: ok(b.widgets && b.widgets.order), hidden: ok(b.widgets && b.widgets.hidden) } };
    return copy(layout);
  }

  /* ---- gedeelde mappen (Samba) */
  const shareUsers = ['lies', 'tom'];
  const shareList = [
    { name: 'media', path: '/tank/media', comment: 'Films, series en muziek', users: { lies: 'rw', tom: 'ro' }, guest: false, timemachine: false },
    { name: 'fotos', path: '/tank/fotos', comment: '', users: { lies: 'rw', tom: 'rw' }, guest: false, timemachine: false },
    { name: 'TimeMachine', path: '/tank/timemachine', comment: 'Back-ups van de Macs', users: { lies: 'rw' }, guest: false, timemachine: true },
  ];
  const shareRoots = () => [{ name: 'tank', mountpoint: '/tank' }, { name: 'snel', mountpoint: '/snel' }]
    .concat(datasets.map((x) => ({ name: x.name, mountpoint: x.mountpoint }))).filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i);
  function sharesGet() {
    return { installed: true, running: true, hostname: net.hostname, shares: copy(shareList), appUser: 'lennert', roots: shareRoots(),
      connections: { total: 2, perShare: { media: 2, fotos: 1 } },
      users: shareUsers.slice().sort().map((name) => ({ name, managed: true, shares: shareList.filter((x) => x.users[name]).map((x) => x.name) })) };
  }
  function shareSave(b, original) {
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(name) || /^(global|homes|printers)$/i.test(name)) throw err('Kies een naam met letters, cijfers, -, _ of . (maximaal 32 tekens), bv. media.');
    if (shareList.some((x) => x.name !== original && x.name.toLowerCase() === name.toLowerCase())) throw err('Er bestaat al een gedeelde map met de naam ' + name + '.', 409);
    const users = {}; for (const [u, v] of Object.entries(b.users || {})) if ((v === 'ro' || v === 'rw') && shareUsers.includes(u)) users[u] = v;
    if (!b.guest && !Object.keys(users).length) throw err('Geef minstens één gebruiker toegang, of laat gasten lezen.');
    let p;
    if (b.create) { const r = shareRoots().find((x) => x.name === b.create.parent); if (!r) throw err('Kies de pool waarop de nieuwe map komt.'); p = r.mountpoint + '/' + name.toLowerCase(); }
    else { p = String(b.path || '').replace(/\/+$/, ''); if (!shareRoots().some((r) => p === r.mountpoint || p.startsWith(r.mountpoint + '/'))) throw err('Kies een map op een van je pools (bv. /tank/media).'); }
    const share = { name, path: p, comment: String(b.comment || '').trim().slice(0, 100), users, guest: !!b.guest, timemachine: !!b.timemachine };
    const i = shareList.findIndex((x) => x.name === original);
    if (original && i < 0) throw err('Deze gedeelde map bestaat niet (meer).', 404);
    if (i >= 0) shareList[i] = share; else shareList.push(share);
    return share;
  }
  function shareUserCreate(b) {
    const name = String(b.name || '').trim();
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw err('Kies een gebruikersnaam met kleine letters, cijfers, - of _ (maximaal 32 tekens), bv. lies.');
    if (String(b.password || '').length < 8) throw err('Kies een wachtwoord van minstens 8 tekens.');
    if (shareUsers.includes(name) || ['root', 'lennert', 'nobody'].includes(name)) throw err('De gebruiker ' + name + ' bestaat al op de server. Kies een andere naam.', 409);
    shareUsers.push(name); return { name };
  }
  function shareUserDelete(name) {
    const only = shareList.filter((x) => !x.guest && Object.keys(x.users).length === 1 && x.users[name]).map((x) => x.name);
    if (only.length) throw err(name + ' is de enige met toegang tot ' + only.join(', ') + '. Geef eerst iemand anders toegang, of verwijder die gedeelde map.', 409);
    shareList.forEach((x) => { delete x.users[name]; });
    shareUsers.splice(shareUsers.indexOf(name), 1); return { removed: name };
  }

  /* ---- back-ups: verbindingen (rclone), taken en toestellen */
  const MB = 1024 ** 2, HOUR = 3600000;
  const BK_PROVIDERS = {
    drive: { label: 'Google Drive', group: 'cloud', oauth: true, hint: '', fields: [] },
    onedrive: { label: 'OneDrive', group: 'cloud', oauth: true, hint: '', fields: [] },
    dropbox: { label: 'Dropbox', group: 'cloud', oauth: true, hint: '', fields: [] },
    s3: { label: 'S3-opslag', group: 'cloud', oauth: false, hint: 'Backblaze B2, Wasabi, Cloudflare R2, Amazon S3 of MinIO', fields: [
      { key: 'provider', label: 'Aanbieder', type: 'select', required: false, default: 'Other',
        options: [['Other', 'Andere (bv. Backblaze B2)'], ['AWS', 'Amazon S3'], ['Cloudflare', 'Cloudflare R2'], ['Wasabi', 'Wasabi'], ['Minio', 'MinIO']] },
      { key: 'endpoint', label: 'Endpoint', type: 'text', required: false, placeholder: 's3.eu-central-003.backblazeb2.com', help: 'Het adres van de opslag. Leeg laten bij Amazon S3.' },
      { key: 'region', label: 'Regio', type: 'text', required: false, placeholder: 'eu-central-003' },
      { key: 'access_key_id', label: 'Access key', type: 'text', required: true },
      { key: 'secret_access_key', label: 'Secret key', type: 'password', required: true }] },
    sftp: { label: 'Andere NAS of server (SFTP)', group: 'nas', oauth: false, hint: 'Via SSH: Synology, QNAP, TrueNAS, een andere HomeBaseOS of een Linux-server', fields: [
      { key: 'host', label: 'Adres', type: 'text', required: true, placeholder: '192.168.1.20' },
      { key: 'port', label: 'Poort', type: 'number', required: false, default: '22' },
      { key: 'user', label: 'Gebruiker', type: 'text', required: true },
      { key: 'pass', label: 'Wachtwoord', type: 'password', required: true }] },
    smb: { label: 'Andere NAS (SMB)', group: 'nas', oauth: false, hint: 'Een gedeelde map op een andere NAS of een Windows-pc', fields: [
      { key: 'host', label: 'Adres', type: 'text', required: true, placeholder: '192.168.1.20' },
      { key: 'user', label: 'Gebruiker', type: 'text', required: true },
      { key: 'pass', label: 'Wachtwoord', type: 'password', required: true },
      { key: 'domain', label: 'Werkgroep', type: 'text', required: false, placeholder: 'WORKGROUP' }] },
    webdav: { label: 'WebDAV', group: 'nas', oauth: false, hint: 'Nextcloud, ownCloud of een andere NAS met WebDAV', fields: [
      { key: 'url', label: 'Adres (URL)', type: 'text', required: true, placeholder: 'https://cloud.voorbeeld.be/remote.php/dav/files/lies' },
      { key: 'vendor', label: 'Soort server', type: 'select', required: false, default: 'other', options: [['nextcloud', 'Nextcloud'], ['owncloud', 'ownCloud'], ['other', 'Andere']] },
      { key: 'user', label: 'Gebruiker', type: 'text', required: true },
      { key: 'pass', label: 'Wachtwoord', type: 'password', required: true }] },
  };
  const bkRemotes = [{ name: 'google', type: 'drive', detail: '' }, { name: 'nas-mama', type: 'sftp', detail: 'freddy@nas-mama.thuis.be' }];
  const bkResult = (hoursAgo, mins, files, size, extra = {}) => ({ kind: 'backup', dryRun: false, scheduled: true, started: Date.now() - hoursAgo * HOUR,
    ended: Date.now() - hoursAgo * HOUR + mins * 60000, state: 'ok', bytes: size, files, checks: 1840, deletes: 0, errors: 0, error: null, ...extra });
  const bkJobs = [
    { id: 'a1b2c3d4', name: "Foto's naar Google Drive", direction: 'push', mode: 'copy', remote: 'google', remotePath: 'Back-ups/Freddy/fotos', localPath: '/tank/fotos',
      encrypt: false, versions: false, keepDays: 30, schedule: { every: 'daily', time: '02:00', day: 0 }, excludes: ['.DS_Store'], bwlimit: '',
      created: Date.now() - 40 * 86400000, lastScheduled: Date.now() - 7 * HOUR, lastRun: bkResult(7, 12, 34, 210 * MB) },
    { id: 'b2c3d4e5', name: 'Documenten naar de NAS van mama', direction: 'push', mode: 'sync', remote: 'nas-mama', remotePath: 'backup-freddy', localPath: '/tank/documenten',
      encrypt: true, versions: true, keepDays: 90, schedule: { every: 'weekly', time: '03:30', day: 0 }, excludes: [], bwlimit: '5M',
      created: Date.now() - 60 * 86400000, lastScheduled: Date.now() - 5 * 86400000, lastRun: bkResult(5 * 24, 4, 112, 380 * MB, { deletes: 3 }) },
    { id: 'c3d4e5f6', name: 'Google Drive thuis bewaren', direction: 'pull', mode: 'copy', remote: 'google', remotePath: '', localPath: '/tank/backups/google-drive',
      encrypt: false, versions: false, keepDays: 30, schedule: { every: 'daily', time: '04:00', day: 0 }, excludes: [], bwlimit: '',
      created: Date.now() - 20 * 86400000, lastScheduled: Date.now() - 5 * HOUR,
      lastRun: bkResult(5, 1, 0, 0, { state: 'failed', errors: 1, error: "couldn't connect: dial tcp: lookup www.googleapis.com: no such host" }) },
  ];
  bkJobs.forEach((j) => { j.history = [j.lastRun]; });
  const bkLogs = {};
  const bkDevs = [
    { name: 'MacBook-Lies', kind: 'mac', method: 'share', dataset: 'tank/backups/macbook-lies', path: '/tank/backups/macbook-lies', user: 'lies', created: Date.now() - 90 * 86400000,
      used: 412 * GB, quota: 1000 * GB, avail: 588 * GB, missing: false, lastChange: Date.now() - 40 * 60000, connected: 1 },
    { name: 'pc-tom', kind: 'windows', method: 'kopia', user: 'pc-tom@pc-tom', created: Date.now() - 30 * 86400000,
      used: 186 * GB, lastChange: Date.now() - 50 * 60000, snapshots: 212, folders: ['C:\\Users\\tom'] },
  ];
  // Back-up-app (Kopia) op de NAS: staat aan, met één pc.
  const demoKopia = { installed: true, version: '0.19.0', enabled: true, running: true, port: 51515, hostname: 'Freddy', addresses: ['192.168.1.10'],
    fingerprint: '3f9a1c0be47d52a86e0f1b93c4d7a2e5f60b8c1d9e2a3b4c5d6e7f8091a2b3c4', pool: 'tank', path: '/tank/backups/kopia', used: 141 * GB,
    appUrl: 'https://github.com/lennertvh1/kopia/releases/latest' };
  const demoCode = () => { const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; const c = Array.from({ length: 8 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); return c.slice(0, 4) + '-' + c.slice(4); };
  const demoPairing = () => ({ code: demoCode(), expires: Date.now() + 15 * 60000, password: demoPw() });
  const demoPw = () => Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 7).padEnd(5, 'x')).join('-');
  const bkLive = {};
  function bkNext(s, from) {
    if (!s || s.every === 'manual') return null;
    const [h, m] = s.time.split(':').map(Number), d = new Date(from);
    if (s.every === 'hourly') { d.setMinutes(m, 0, 0); if (d.getTime() <= from) d.setHours(d.getHours() + 1); return d.getTime(); }
    d.setHours(h, m, 0, 0);
    if (s.every === 'weekly') d.setDate(d.getDate() + ((s.day - d.getDay() + 7) % 7));
    if (d.getTime() <= from) d.setDate(d.getDate() + (s.every === 'weekly' ? 7 : 1));
    return d.getTime();
  }
  // Een lopende taak: de voortgang volgt de klok; is de tijd om, dan komt het resultaat in de geschiedenis.
  function bkInfo(id) {
    const r = bkLive[id]; if (!r) return null;
    const f = Math.min(1, (Date.now() - r.started) / r.dur);
    if (f >= 1 || r.cancelled) {
      const j = bkJobs.find((x) => x.id === id);
      const files = Math.round(r.files * f), bytesDone = Math.round(r.total * f);
      const entry = { kind: r.kind, dryRun: r.dryRun, scheduled: false, started: r.started, ended: Date.now(), state: r.cancelled ? 'cancelled' : 'ok',
        bytes: r.dryRun ? 0 : bytesDone, files: r.dryRun ? 0 : files, checks: 1840, deletes: 0, errors: 0, error: null };
      const t0 = new Date().toISOString();
      bkLogs[id] = r.lines.concat(Array.from({ length: Math.min(files, 12) }, (_, i) => ({ time: t0, level: r.dryRun ? 'notice' : 'info', text: `2026/IMG_${4100 + i}.HEIC: ${r.dryRun ? 'Skipped copy as --dry-run is set' : 'Copied (new)'}` })),
        [{ time: t0, level: r.cancelled ? 'error' : 'info', text: r.cancelled ? 'Gestopt.' : 'Klaar.' }]);
      if (j) { j.history = [entry, ...(j.history || [])].slice(0, 20); if (r.kind === 'backup' && !r.dryRun) j.lastRun = entry; }
      delete bkLive[id];
      return null;
    }
    const done = r.total * f;
    return { kind: r.kind, dryRun: r.dryRun, started: r.started, bytes: Math.round(done), totalBytes: r.total, files: Math.round(r.files * f), totalFiles: r.files,
      checks: 0, deletes: 0, errors: 0, speed: Math.round(r.total / (r.dur / 1000)), eta: Math.round((r.dur - (Date.now() - r.started)) / 1000), percent: Math.round(f * 1000) / 10 };
  }
  const bkPublic = (j) => ({ ...copy(j), history: (j.history || []).slice(0, 10), next: bkNext(j.schedule, j.lastScheduled || j.created), running: bkInfo(j.id) });
  const bkFolders = () => shareRoots().map((x) => x.mountpoint);
  function bkGet(brief) {
    const jobs = bkJobs.map(bkPublic);
    if (brief) return { installed: true, jobs, devices: bkDevs.length };
    return { installed: true, version: '1.69.1', providers: copy(BK_PROVIDERS), jobs, devices: copy(bkDevs), kopia: copy(demoKopia), samba: true, hostname: net.hostname,
      remotes: bkRemotes.map((r) => ({ name: r.name, type: r.type, label: BK_PROVIDERS[r.type].label, detail: r.detail, usedBy: bkJobs.filter((j) => j.remote === r.name).map((j) => j.name) })),
      users: shareUsers.slice().sort(), pools: pools.map((p) => ({ name: p.name, mountpoint: '/' + p.name, free: p.free })), folders: bkFolders() };
  }
  function bkNewRemote(name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name) || name.startsWith('hb-crypt-')) throw err('Kies een naam met letters, cijfers, - of _ (maximaal 32 tekens), bv. google.');
    if (bkRemotes.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw err('Er bestaat al een verbinding met de naam ' + name + '.', 409);
  }
  function bkRemoteCreate(b) {
    const name = String(b.name || '').trim(); bkNewRemote(name);
    const p = BK_PROVIDERS[b.type]; if (!p || p.oauth) throw err('Kies een soort verbinding.');
    for (const f of p.fields) if (f.required && !String(b[f.key] || '').trim()) throw err('Vul ' + f.label.toLowerCase() + ' in.');
    if (b.host && !/^[A-Za-z0-9._:[\]-]+$/.test(String(b.host).trim())) throw err('"' + b.host + '" is geen geldig adres. Gebruik een IP-adres of een naam, bv. 192.168.1.20.');
    if (b.url && !/^https?:\/\/\S+$/i.test(String(b.url).trim())) throw err('Het adres moet beginnen met http:// of https://.');
    const detail = b.type === 'webdav' ? b.url : b.type === 's3' ? (b.endpoint || b.provider) : String(b.user).trim() + '@' + String(b.host).trim();
    bkRemotes.push({ name, type: b.type, detail }); return { name };
  }
  function bkAuthFinish(b) {
    const name = String(b.name || '').trim();
    if (b.reconnect) { if (!bkRemotes.some((r) => r.name === name && r.type === b.type)) throw err('Deze verbinding bestaat niet (meer).', 404); } else bkNewRemote(name);
    if (!BK_PROVIDERS[b.type] || !BK_PROVIDERS[b.type].oauth) throw err('Kies Google Drive, OneDrive of Dropbox.');
    if (!b.token) {
      if (b.session !== 'demo') throw err('Het aanmelden is verlopen. Begin opnieuw.', 410);
      let u = null; try { u = new URL(String(b.url || '').trim()); } catch (e) { /* hieronder */ }
      if (!u || !u.searchParams.get('code') || !u.searchParams.get('state')) throw err('Plak het volledige adres uit de adresbalk. Het begint met http://127.0.0.1:53682/.');
    } else if (!/access_token|^[A-Za-z0-9+/=\s]{40,}$/.test(b.token)) throw err('Dat is geen geldige token. Plak alles tussen ---> en <---End paste.');
    if (!b.reconnect) bkRemotes.push({ name, type: b.type, detail: b.type === 'onedrive' ? 'OneDrive (persoonlijk)' : '' });
    return { name };
  }
  function bkJobSave(b, id) {
    const cur = id ? bkJobs.find((j) => j.id === id) : null;
    if (id && !cur) throw err('Deze taak bestaat niet (meer).', 404);
    if (id && bkInfo(id)) throw err('Deze taak loopt nu. Stop ze eerst, of wacht tot ze klaar is.', 409);
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw err("Geef de taak een naam, bv. Foto's naar Google Drive.");
    const direction = b.direction === 'pull' ? 'pull' : 'push', mode = b.mode === 'sync' ? 'sync' : 'copy';
    if (!bkRemotes.some((r) => r.name === b.remote)) throw err('Kies een verbinding. Maak er eerst een aan bij Verbindingen.');
    const remotePath = String(b.remotePath || '').trim().replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
    if (remotePath.split('/').some((x) => x === '..' || x === '.')) throw err('Die map op het doel kan niet. Gebruik gewone mapnamen, gescheiden door /.');
    const lp = String(b.localPath || '').trim().replace(/(.)\/+$/, '$1');
    if (!lp.startsWith('/') || !bkFolders().some((r) => lp === r || lp.startsWith(r + '/'))) throw err('Kies een map op een van je pools, bv. /tank/fotos.');
    if (direction === 'pull' && pools.some((p) => '/' + p.name === lp)) throw err('Kies een eigen map om in te bewaren, bv. /tank/backups/google-drive, niet de hele pool.');
    const encrypt = direction === 'push' && (cur ? !!cur.encrypt : !!b.encrypt);
    const root = remotePath === '' || remotePath === '/';
    if (mode === 'sync' && direction === 'push' && !encrypt && root) throw err('Kies een map op het doel. Synchroniseren naar de hoofdmap zou alles wissen wat daar nog staat.');
    const versions = direction === 'push' && !!b.versions;
    if (versions && !encrypt && root) throw err('Kies een map op het doel om oude versies te kunnen bewaren.');
    if (encrypt && !cur && String(b.password || '').length < 10) throw err('Kies een wachtwoord voor de versleuteling van minstens 10 tekens.');
    const bw = String(b.bwlimit || '').trim();
    if (bw && !/^\d+(\.\d+)?[KMG]?$/i.test(bw)) throw err('Schrijf de bandbreedte als een getal met K, M of G, bv. 10M (10 MB per seconde).');
    const s = b.schedule || {};
    const schedule = { every: ['manual', 'hourly', 'daily', 'weekly'].includes(s.every) ? s.every : 'manual', time: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '') ? s.time : '03:00', day: Number(s.day) >= 0 && Number(s.day) <= 6 ? Number(s.day) : 0 };
    const job = { name, direction, mode, remote: b.remote, remotePath, localPath: lp, encrypt, versions, keepDays: Math.min(3650, Math.max(1, Math.round(Number(b.keepDays) || 30))),
      schedule, excludes: String(b.excludes || '').split('\n').map((x) => x.trim()).filter(Boolean), bwlimit: bw };
    if (cur) { if (JSON.stringify(cur.schedule) !== JSON.stringify(schedule)) cur.lastScheduled = Date.now(); Object.assign(cur, job); return bkPublic(cur); }
    const out = { id: Math.random().toString(16).slice(2, 10).padEnd(8, '0'), ...job, created: Date.now(), lastScheduled: Date.now(), lastRun: null, history: [] };
    bkJobs.push(out); return bkPublic(out);
  }
  function bkStart(id, kind, dryRun, target) {
    const j = bkJobs.find((x) => x.id === id); if (!j) throw err('Deze taak bestaat niet (meer).', 404);
    if (bkInfo(id)) throw err('Deze taak loopt al.', 409);
    const t0 = new Date().toISOString(), dest = j.remote + ':' + j.remotePath;
    bkLive[id] = { kind, dryRun, started: Date.now(), dur: rnd(10000, 16000), total: rnd(80, 900) * MB, files: Math.round(rnd(20, 140)), cancelled: false,
      lines: [{ time: t0, level: 'info', text: kind === 'restore' ? 'Terugzetten naar ' + target : (dryRun ? 'Proef (er verandert niets): ' : '') + (j.direction === 'pull' ? dest + ' → ' + j.localPath : j.localPath + ' → ' + dest) }] };
    return { started: true, kind, dryRun };
  }
  function bkDeviceCreate(b) {
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) throw err('Kies een naam met letters, cijfers, - of _ (maximaal 32 tekens), bv. MacBook-Lies.');
    if (bkDevs.some((d) => d.name.toLowerCase() === name.toLowerCase())) throw err('Er bestaat al een toestel met de naam ' + name + '.', 409);
    if (b.method !== 'kopia' && shareList.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw err('Er bestaat al een gedeelde map met de naam ' + name + '.', 409);
    if (!['mac', 'windows', 'linux', 'phone'].includes(b.kind)) throw err('Kies wat voor toestel het is.');
    if (b.method === 'kopia') {
      if (!demoKopia.enabled) throw err('Zet eerst de back-up-app (Kopia) aan.', 409);
      if (b.kind === 'phone') throw err("De back-up-app bestaat niet voor gsm's. Kies een gedeelde map.");
      const dev = { name, kind: b.kind, method: 'kopia', user: name.toLowerCase() + '@' + name.toLowerCase(), created: Date.now(), used: 0, lastChange: null, snapshots: 0, folders: [] };
      bkDevs.push(dev); return { ...copy(dev), ...demoPairing() };
    }
    const pool = pools.find((p) => p.name === b.pool); if (!pool) throw err('Kies de pool waarop de back-ups komen.');
    const q = b.quotaGb === '' || b.quotaGb == null ? 0 : Number(b.quotaGb);
    if (!Number.isInteger(q) || q < 0 || q > 1e6) throw err('Vul de maximale grootte in als een getal in GB, of laat het leeg.');
    let user = b.user;
    if (b.newUser) user = shareUserCreate(b.newUser).name;
    else if (!shareUsers.includes(user)) throw err('Kies wie de back-ups mag maken.');
    const ds = pool.name + '/backups/' + name.toLowerCase();
    shareList.push({ name, path: '/' + ds, comment: 'Back-ups van ' + name, users: { [user]: 'rw' }, guest: false, timemachine: b.kind === 'mac' });
    const dev = { name, kind: b.kind, method: 'share', dataset: ds, path: '/' + ds, user, created: Date.now(), used: 0, quota: q * GB, avail: q ? q * GB : pool.free, missing: false, lastChange: null, connected: 0 };
    bkDevs.push(dev); return copy(dev);
  }
  function bkDeviceDelete(name, data) {
    const i = bkDevs.findIndex((d) => d.name === name); if (i < 0) throw err('Dit toestel bestaat niet (meer).', 404);
    if (bkDevs[i].method !== 'kopia') { const s = shareList.findIndex((x) => x.name === name); if (s >= 0) shareList.splice(s, 1); }
    const [d] = bkDevs.splice(i, 1); return { removed: name, dataset: data && d.method !== 'kopia' ? d.dataset : null };
  }
  async function bkPost(path, b) {
    if (path === '/api/backup/remotes') { await wait(rnd(900, 1600)); return bkRemoteCreate(b); }
    if (path === '/api/backup/auth') {
      if (!BK_PROVIDERS[b.type] || !BK_PROVIDERS[b.type].oauth) throw err('Kies Google Drive, OneDrive of Dropbox.');
      return { session: 'demo', url: 'https://accounts.google.com/o/oauth2/auth?client_id=demo&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2F&state=demo' };
    }
    if (path === '/api/backup/auth/finish') { await wait(rnd(800, 1400)); return bkAuthFinish(b); }
    if (path === '/api/backup/jobs') return bkJobSave(b, null);
    if (path === '/api/backup/devices') { await wait(rnd(600, 1000)); return bkDeviceCreate(b); }
    if (path === '/api/backup/kopia') {
      if (!b.enabled) { demoKopia.enabled = demoKopia.running = false; return { enabled: false }; }
      await wait(rnd(1200, 2000));
      const first = !demoKopia.pool;
      if (first) { const p = pools.find((x) => x.name === b.pool); if (!p) throw err('Kies de pool waarop de back-ups komen.'); demoKopia.pool = p.name; demoKopia.path = '/' + p.name + '/backups/kopia'; }
      demoKopia.enabled = demoKopia.running = true;
      return first ? { enabled: true, repoPassword: demoPw() } : { enabled: true };
    }
    const dpr = path.match(/^\/api\/backup\/devices\/([^/]+)\/pair$/);
    if (dpr) {
      const dev = bkDevs.find((x) => x.name === decodeURIComponent(dpr[1])); if (!dev) throw err('Dit toestel bestaat niet (meer).', 404);
      if (dev.method !== 'kopia') throw err('Koppelen kan alleen bij een toestel met de back-up-app.');
      if (!demoKopia.enabled) throw err('Zet eerst de back-up-app (Kopia) aan.', 409);
      return { name: dev.name, ...demoPairing() };
    }
    const dpw = path.match(/^\/api\/backup\/devices\/([^/]+)\/password$/);
    if (dpw) {
      const dev = bkDevs.find((x) => x.name === decodeURIComponent(dpw[1])); if (!dev) throw err('Dit toestel bestaat niet (meer).', 404);
      if (dev.method !== 'kopia') throw err('Het wachtwoord van een gedeelde map wijzig je bij Gedeelde mappen → Gebruikers.');
      if (!demoKopia.enabled) throw err('Zet eerst de back-up-app (Kopia) aan.', 409);
      return { name: dev.name, password: demoPw() };
    }
    let m = path.match(/^\/api\/backup\/remotes\/([^/]+)\/test$/);
    if (m) {
      await wait(rnd(700, 1300));
      const r = bkRemotes.find((x) => x.name === decodeURIComponent(m[1])); if (!r) throw err('Deze verbinding bestaat niet (meer).', 404);
      return { ok: true, about: r.type === 'drive' ? { total: 2048 * GB, used: 731 * GB, free: 1317 * GB } : r.type === 'sftp' ? { total: 3.6 * TB, used: 1.2 * TB, free: 2.4 * TB } : null };
    }
    m = path.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})$/);
    if (m) return bkJobSave(b, m[1]);
    m = path.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})\/(run|stop|restore)$/);
    if (!m) throw err('Onbekend endpoint', 404);
    if (m[2] === 'stop') { if (!bkInfo(m[1])) throw err('Deze taak loopt niet.', 409); bkLive[m[1]].cancelled = true; return { stopping: true }; }
    if (m[2] === 'run') return bkStart(m[1], 'backup', !!b.dryRun);
    const j = bkJobs.find((x) => x.id === m[1]); if (!j) throw err('Deze taak bestaat niet (meer).', 404);
    if (j.direction !== 'push') throw err('Terugzetten kan alleen bij een taak die naar de cloud of een andere NAS gaat.');
    const target = String(b.target || '').trim();
    if (!target.startsWith('/') || !bkFolders().some((r) => target === r || target.startsWith(r + '/'))) throw err('Kies een map op een van je pools, bv. /tank/fotos.');
    if (pools.some((p) => '/' + p.name === target)) throw err('Kies een eigen map om in te bewaren, bv. /tank/backups/google-drive, niet de hele pool.');
    return bkStart(j.id, 'restore', false, target);
  }
  function bkBrowse(name, p) {
    if (!bkRemotes.some((r) => r.name === name)) throw err('Deze verbinding bestaat niet (meer).', 404);
    const tree = { '': ['Back-ups', 'Documenten', "Foto's", 'Gedeeld'], 'Back-ups': ['Freddy', 'Laptop'], 'Back-ups/Freddy': ['fotos'], Documenten: ['Belastingen', 'Huis'], backup: [] };
    const clean = String(p || '').replace(/^\/+|\/+$/g, '');
    return { path: clean, dirs: tree[clean] || [] };
  }
  function bkDel(path) {
    let m = path.match(/^\/api\/backup\/remotes\/([^/]+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]), i = bkRemotes.findIndex((r) => r.name === name);
      if (i < 0) throw err('Deze verbinding bestaat niet (meer).', 404);
      const used = bkJobs.filter((j) => j.remote === name).map((j) => j.name);
      if (used.length) throw err('De verbinding ' + name + ' wordt nog gebruikt door ' + used.join(', ') + '. Verwijder of wijzig die taken eerst.', 409);
      bkRemotes.splice(i, 1); return { removed: name };
    }
    m = path.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})$/);
    if (m) {
      const i = bkJobs.findIndex((j) => j.id === m[1]); if (i < 0) throw err('Deze taak bestaat niet (meer).', 404);
      if (bkInfo(m[1])) throw err('Deze taak loopt nu. Stop ze eerst, of wacht tot ze klaar is.', 409);
      bkJobs.splice(i, 1); return { removed: m[1] };
    }
    m = path.match(/^\/api\/backup\/devices\/([^/?]+)(\?data=1)?$/);
    if (m) return bkDeviceDelete(decodeURIComponent(m[1]), !!m[2]);
    return null;
  }

  /* ---- instellingen, compose-bestand en console per app */
  const appOvr = {}, composeText = {};
  const findApp = (id) => { const a = apps.find((x) => x.id === decodeURIComponent(id)); if (!a) throw err('Deze app bestaat niet (meer).', 404); return a; };
  const resolvePorts = (tpl, ports) => tpl.replace(/\[PORT:(\d+)\]/g, (_, p) => { const x = ports.find((q) => String(q.private) === p); return x ? String(x.public) : p; });
  // Formulier per dienst, in dezelfde vorm als lib/composeform.js serviceForm() teruggeeft.
  const formState = {};
  function demoForm(a) {
    if (!formState[a.name]) {
      const gpu = a.name === 'jellyfin' || a.name === 'frigate';
      formState[a.name] = {
        service: a.name, image: a.image, restart: 'unless-stopped', privileged: false, networkOther: null, networks: [], build: false,
        ...(appNet[a.name] && !/_default$/.test(appNet[a.name].net) ? { network: appNet[a.name].net, ip: appNet[a.name].ip, networks: [appNet[a.name].net],
          projectNetworks: [{ key: appNet[a.name].net, name: appNet[a.name].net, external: true }] } : { network: '', ip: '', projectNetworks: [] }),
        ports: a.ports.map((p) => ({ host: String(p.public), container: String(p.private), protocol: p.type.toLowerCase(), ip: '' })),
        volumes: [{ host: AD() + '/' + a.name, container: '/config', mode: 'rw', kind: 'bind', locked: false }]
          .concat(a.name === 'jellyfin' ? [{ host: '/tank/media', container: '/media', mode: 'ro', kind: 'bind', locked: false },
            { host: '', container: '/transcode', mode: 'rw', kind: 'tmpfs', locked: true }] : []),
        env: [{ name: 'TZ', value: 'Europe/Brussels' }, { name: 'PUID', value: '1000' }, { name: 'PGID', value: '1000' }],
        devices: gpu ? [{ host: '/dev/dri', container: '/dev/dri', perm: '' }] : [], labels: [],
      };
    }
    return { ...copy(formState[a.name]), otherServices: apps.filter((x) => x.compose === a.compose && x !== a).map((x) => x.name) };
  }
  function demoCompose(a) {
    const q = (v) => JSON.stringify(String(v));
    return 'services:\n' + apps.filter((x) => x.compose === a.compose).map((x) => {
      const f = demoForm(x);
      const list = (k, items) => (items.length ? '    ' + k + ':\n' + items.map((i) => '      - ' + i + '\n').join('') : '');
      return '  ' + x.name + ':\n    image: ' + q(f.image) + '\n    container_name: ' + q(x.name) + '\n' + (f.restart ? '    restart: ' + q(f.restart) + '\n' : '') +
        (f.network === 'host' || f.network === 'none' ? '    network_mode: ' + q(f.network) + '\n' : '') +
        (f.network && f.network !== 'host' && f.network !== 'none' ? '    networks:\n      ' + f.network + (f.ip ? ':\n        ipv4_address: ' + q(f.ip) : ': null') + '\n' : '') +
        (f.privileged ? '    privileged: true\n' : '') +
        list('ports', f.ports.map((p) => q((p.host ? p.host + ':' : '') + p.container + '/' + p.protocol))) +
        list('volumes', f.volumes.map((v) => (v.locked ? '{ type: "tmpfs", target: ' + q(v.container) + ' }' : q(v.host + ':' + v.container + (v.mode === 'ro' ? ':ro' : ''))))) +
        list('devices', f.devices.map((d) => q(d.host + ':' + (d.container || d.host)))) +
        (f.env.length ? '    environment:\n' + f.env.map((e) => '      ' + e.name + ': ' + q(e.value) + '\n').join('') : '') +
        (f.labels.length ? '    labels:\n' + f.labels.map((e) => '      ' + q(e.name) + ': ' + q(e.value) + '\n').join('') : '');
    }).join('') + (() => {
      const ext = [...new Set(apps.filter((x) => x.compose === a.compose).map((x) => demoForm(x).network).filter((n) => n && n !== 'host' && n !== 'none'))];
      return ext.length ? 'networks:\n' + ext.map((n) => '  ' + n + ':\n    external: true\n').join('') : '';
    })();
  }
  // Een piepkleine nagebootste shell, zodat je de console in de demo kan proberen.
  function demoExec(a, cmd, cwd) {
    if (a.state !== 'RUNNING') throw err('Start de app eerst. De console werkt alleen als de app draait.', 409);
    const FS = { '/': ['app', 'bin', 'config', 'etc', 'tmp', 'usr', 'var'], '/config': ['config.yml', 'data', 'logs'], '/config/logs': [a.name + '.log'],
      '/config/data': ['database.db'], '/app': ['server', 'README.md'], '/etc': ['hostname', 'os-release'] };
    const abs = (p) => (p.startsWith('/') ? p : (cwd === '/' ? '' : cwd) + '/' + p).replace(/\/+$/, '') || '/';
    const [c, ...args] = cmd.trim().split(/\s+/);
    const ok = (output, ncwd = cwd) => ({ output, cwd: ncwd, exitCode: 0 });
    switch (c) {
      case 'pwd': return ok(cwd);
      case 'cd': { const t = abs(args[0] || '/'); return FS[t] ? ok('', t) : { output: 'sh: cd: can\'t cd to ' + args[0], cwd, exitCode: 2 }; }
      case 'ls': { const t = abs(args.find((x) => !x.startsWith('-')) || '.').replace(/\/\.$/, '') || '/';
        const items = FS[t === '.' ? cwd : t]; if (!items) return { output: 'ls: ' + args[0] + ': No such file or directory', cwd, exitCode: 1 };
        return ok(args.includes('-la') || args.includes('-l') ? items.map((n) => (FS[abs(n)] ? 'drwxr-xr-x' : '-rw-r--r--') + '  1 abc abc  4096 Oct 21 09:12 ' + n).join('\n') : items.join('  ')); }
      case 'whoami': return ok('abc');
      case 'id': return ok('uid=1000(abc) gid=1000(abc) groups=1000(abc)');
      case 'hostname': return ok(a.name);
      case 'uname': return ok(args.includes('-a') ? 'Linux ' + a.name + ' 6.12.48-amd64 #1 SMP Debian 6.12.48-1 x86_64 Linux' : 'Linux');
      case 'date': return ok(new Date().toString());
      case 'echo': return ok(args.join(' ').replace(/^["']|["']$/g, ''));
      case 'env': return ok('HOSTNAME=' + a.name + '\nTZ=Europe/Brussels\nPUID=1000\nPGID=1000\nHOME=/config\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
      case 'cat': { const f = abs(args[0] || '');
        if (/config\.yml$/.test(f)) return ok('# ' + a.name + '\nserver:\n  port: 8080\n  log_level: info');
        if (/os-release$/.test(f)) return ok('NAME="Alpine Linux"\nVERSION_ID=3.20.3');
        if (/hostname$/.test(f)) return ok(a.name);
        if (/\.log$/.test(f)) return ok(logLines(a.name).map((l) => l.timestamp + ' ' + l.message).join('\n'));
        return { output: 'cat: can\'t open \'' + (args[0] || '') + '\': No such file or directory', cwd, exitCode: 1 }; }
      case 'ps': return ok('PID   USER     TIME  COMMAND\n    1 abc       0:12 /app/server\n   42 abc       0:00 sh -c ' + cmd);
      case 'df': return ok('Filesystem      Size  Used Avail Use% Mounted on\noverlay         461G  190G  271G  42% /\nsnel/appdata    461G  190G  271G  42% /config');
      case 'top': case 'vi': case 'nano': case 'htop': case 'less':
        return { output: c + ': cannot open terminal (no tty)', cwd, exitCode: 1 }; // zoals een echte shell zonder terminal
      default: return { output: 'sh: ' + c + ': not found', cwd, exitCode: 127 };
    }
  }

  /* ---- appstore: kleine voorbeeldcatalogus in dezelfde vorm als lib/appstore.js */
  let fk = 0;
  const F = (type, name, target, value, o = {}) => ({ key: 'c' + fk++, type, name, target, value: String(value), mode: o.mode || '',
    description: o.desc || '', required: !!o.req, mask: !!o.mask, advanced: !!o.adv, options: o.options || null, auto: !!o.auto });
  const lsio = (port, dir) => [F('Port', 'WebUI', String(port), port, { mode: 'tcp', req: true }),
    F('Path', 'Appdata', '/config', AD() + '/' + dir, { mode: 'rw', req: true, adv: true, auto: true, desc: 'Instellingen en database van de app.' }),
    F('Variable', 'PUID', 'PUID', 1000, { req: true, adv: true }), F('Variable', 'PGID', 'PGID', 1000, { req: true, adv: true })];
  const storeDefs = [
    ['Jellyfin', 'lscr.io/linuxserver/jellyfin', 'linuxserver', ['MediaServer'], true, 'Vrije mediaserver: films, series en muziek streamen naar al je toestellen, zonder abonnement.',
      () => [...lsio(8096, 'jellyfin'), F('Port', 'Ontdekken', '7359', 7359, { mode: 'udp' }),
        F('Path', 'Films', '/data/movies', '', { mode: 'rw', req: true, desc: 'Map met je films.' }), F('Path', 'Series', '/data/tvshows', '', { mode: 'rw', req: true }),
        F('Device', 'GPU (hardware-transcodering)', '/dev/dri', '/dev/dri', { adv: true })], { webui: 'http://[IP]:[PORT:8096]' }],
    ['immich', 'ghcr.io/imagegenius/immich', 'imagegenius', ['MediaApp'], true, "Foto's en video's van je gsm automatisch back-uppen, met gezichten herkennen en zoeken.",
      () => [...lsio(8080, 'immich'), F('Path', "Foto's", '/photos', '/tank/fotos', { mode: 'rw', req: true }),
        F('Variable', 'Database host', 'DB_HOSTNAME', '', { req: true, desc: 'Adres van je PostgreSQL-database.' })],
      { webui: 'http://[IP]:[PORT:8080]', requires: 'Een PostgreSQL-database met pgvecto.rs en Redis.' }],
    ['Plex-Media-Server', 'plexinc/pms-docker', 'plexinc', ['MediaServer'], true, 'Plex organiseert je media en streamt ze naar elk scherm.',
      () => [F('Path', 'Config', '/config', AD() + '/plex', { mode: 'rw', req: true, auto: true }), F('Path', 'Media', '/data', '/tank/media', { mode: 'rw' }),
        F('Variable', 'Claim-token', 'PLEX_CLAIM', '', { mask: true, desc: 'Haal je token op via plex.tv/claim.' })], { network: 'host', official: true }],
    ['vaultwarden', 'vaultwarden/server', 'selfhosters', ['Security'], true, 'Lichte Bitwarden-server voor je wachtwoorden.',
      () => [F('Port', 'WebUI', '80', 8222, { mode: 'tcp', req: true }), F('Path', 'Data', '/data', AD() + '/vaultwarden', { mode: 'rw', req: true, auto: true }),
        F('Variable', 'Registraties toestaan', 'SIGNUPS_ALLOWED', 'true', { options: ['true', 'false'] }), F('Variable', 'Admin-token', 'ADMIN_TOKEN', '', { mask: true, adv: true })],
      { webui: 'http://[IP]:[PORT:80]', id: 'a1b2c3d4e5f6' }],
    ['audiobookshelf', 'ghcr.io/advplyr/audiobookshelf', 'selfhosters', ['MediaServer'], true, 'Server voor luisterboeken en podcasts, met apps voor je gsm.',
      () => [F('Port', 'WebUI', '80', 13378, { mode: 'tcp', req: true }), F('Path', 'Config', '/config', AD() + '/audiobookshelf', { req: true, auto: true }),
        F('Path', 'Luisterboeken', '/audiobooks', '/tank/media/luisterboeken', { req: true })], { webui: 'http://[IP]:[PORT:80]' }],
    ['mealie', 'ghcr.io/mealie-recipes/mealie', 'selfhosters', ['Productivity'], true, "Recepten bewaren, weekmenu's plannen en boodschappenlijstjes maken.",
      () => [F('Port', 'WebUI', '9000', 9925, { mode: 'tcp', req: true }), F('Path', 'Data', '/app/data', AD() + '/mealie', { req: true, auto: true })], { webui: 'http://[IP]:[PORT:9000]' }],
    ['paperless-ngx', 'ghcr.io/paperless-ngx/paperless-ngx', 'selfhosters', ['Productivity'], true, 'Scan je papieren, laat ze herkennen (OCR) en vind alles terug.',
      () => [F('Port', 'WebUI', '8000', 8001, { mode: 'tcp', req: true }), F('Path', 'Data', '/usr/src/paperless/data', AD() + '/paperless-ngx', { req: true, auto: true }),
        F('Variable', 'Redis', 'PAPERLESS_REDIS', 'redis://redis:6379', { req: true })], { webui: 'http://[IP]:[PORT:8000]', requires: 'Een Redis-server.' }],
    ['Home-Assistant-Container', 'ghcr.io/home-assistant/home-assistant', 'selfhosters', ['HomeAutomation'], true, 'Home Assistant als container (zonder add-ons). Wil je add-ons, gebruik dan een VM met Home Assistant OS.',
      () => [F('Path', 'Config', '/config', AD() + '/home-assistant', { req: true, auto: true })], { network: 'host', privileged: true }],
    ['AdGuard-Home', 'adguard/adguardhome', 'selfhosters', ['Network'], true, 'Blokkeert reclame en trackers voor je hele netwerk via DNS.',
      () => [F('Port', 'DNS', '53', 53, { mode: 'udp', req: true }), F('Port', 'WebUI', '3000', 3002, { mode: 'tcp', req: true }),
        F('Path', 'Config', '/opt/adguardhome/conf', AD() + '/adguard-home', { req: true, auto: true })], { webui: 'http://[IP]:[PORT:3000]', network: 'br0' }],
    ['navidrome', 'deluan/navidrome', 'selfhosters', ['MediaServer'], true, 'Je eigen Spotify voor je muziekcollectie.',
      () => [F('Port', 'WebUI', '4533', 4533, { mode: 'tcp', req: true }), F('Path', 'Data', '/data', AD() + '/navidrome', { req: true, auto: true }),
        F('Path', 'Muziek', '/music', '/tank/media/muziek', { mode: 'ro', req: true })], { webui: 'http://[IP]:[PORT:4533]' }],
    ['portainer-ce', 'portainer/portainer-ce', 'selfhosters', ['Tools'], false, 'Beheer je Docker-containers in detail.',
      () => [F('Port', 'WebUI', '9443', 9443, { mode: 'tcp', req: true }), F('Path', 'Docker', '/var/run/docker.sock', '/var/run/docker.sock', { req: true }),
        F('Path', 'Data', '/data', AD() + '/portainer', { req: true, auto: true })], { webui: 'https://[IP]:[PORT:9443]' }],
    ['stirling-pdf', 'frooodle/s-pdf', 'selfhosters', ['Productivity'], false, "Alles met pdf's: samenvoegen, splitsen, ondertekenen, OCR en meer.",
      () => [F('Port', 'WebUI', '8080', 8090, { mode: 'tcp', req: true })], { webui: 'http://[IP]:[PORT:8080]' }],
    ['ollama', 'ollama/ollama', 'selfhosters', ['AI'], true, 'Draai taalmodellen zoals Llama en Qwen op je eigen GPU.',
      () => [F('Port', 'API', '11434', 11434, { mode: 'tcp', req: true }), F('Path', 'Modellen', '/root/.ollama', AD() + '/ollama', { req: true, auto: true })], { gpu: true }],
    ['Grafana', 'grafana/grafana', 'selfhosters', ['Tools'], true, 'Grafieken en dashboards voor alles wat je meet.',
      () => [F('Port', 'WebUI', '3000', 3003, { mode: 'tcp', req: true }), F('Path', 'Data', '/var/lib/grafana', AD() + '/grafana', { req: true, auto: true })], { webui: 'http://[IP]:[PORT:3000]' }],
    ['Redis', 'redis', 'selfhosters', ['Tools'], false, 'Snelle database in het geheugen, vaak nodig voor andere apps.',
      () => [F('Port', 'Redis', '6379', 6379, { mode: 'tcp' }), F('Path', 'Data', '/data', AD() + '/redis', { auto: true })], {}],
    ['minecraft-server', 'itzg/minecraft-server', 'selfhosters', ['GameServers'], false, 'Je eigen Minecraft-server voor vrienden en familie.',
      () => [F('Port', 'Spel', '25565', 25565, { mode: 'tcp', req: true }), F('Path', 'Data', '/data', AD() + '/minecraft-server', { req: true, auto: true }),
        F('Variable', 'EULA aanvaarden', 'EULA', 'TRUE', { req: true, options: ['TRUE', 'FALSE'] }), F('Variable', 'Geheugen', 'MEMORY', '2G', { adv: true })], {}],
  ];
  const STORE_ICON = { 'Plex-Media-Server': 'plex', 'Home-Assistant-Container': 'home-assistant', 'AdGuard-Home': 'adguard-home',
    'portainer-ce': 'portainer', 'minecraft-server': 'minecraft' };
  const CATS_NL = { AI: 'AI', Security: 'Beveiliging', HomeAutomation: 'Domotica', GameServers: 'Gameservers', Tools: 'Hulpmiddelen', MediaApp: 'Media-apps',
    MediaServer: 'Mediaservers', Network: 'Netwerk', Productivity: 'Productiviteit' };
  const store = storeDefs.map(([name, image, maintainer, categories, featured, overview, fields, o], i) => ({
    id: o.id || (i.toString(16) + 'f0e1d2c3b4a5').slice(0, 12).padStart(12, '0'), name, image, maintainer, categories, featured, overview,
    summary: overview, icon: ICON(STORE_ICON[name] || name.toLowerCase()), official: !!o.official, beta: false, popularity: 1000 - i, webui: o.webui || null, network: o.network || 'bridge',
    requires: o.requires || null, project: 'https://example.org/' + name.toLowerCase(), support: null, privileged: !!o.privileged, gpu: !!o.gpu,
    fields: () => { fk = 0; return fields(); }, // vaste sleutels c0, c1, … zoals op de server
  }));
  const storeSlug = (n) => n.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  const storeInstalled = (a) => apps.some((x) => x.storeId === a.id || x.image.split(':')[0] === a.image);
  const storeJobs = {};
  function storeWarnings(a, network) {
    const w = [];
    const tpl = a.network || 'bridge';
    if (network === undefined && !['bridge', 'host', 'none'].includes(tpl)) network = 'bridge';
    if (!['bridge', 'host', 'none'].includes(tpl) && network === 'bridge') w.push('Het template gebruikt het netwerk "' + tpl + '". Kies hieronder een netwerk, of maak het aan bij Instellingen → Docker-netwerken.');
    if (network === 'host') w.push('Deze app gebruikt het netwerk van de server (host) en luistert dan op zijn eigen poorten. Wil je zelf poorten kiezen, pas dan een poort aan of kies het standaardnetwerk (bridge). Sommige apps (zoals Home Assistant en Plex) werken het best met host, omdat ze toestellen in je netwerk zoeken.');
    if (network && ownIpNet(network)) w.push('Deze app krijgt een eigen adres in je thuisnetwerk. De poorten zijn dan die van de app zelf; de server zelf kan de app via dit adres niet bereiken.');
    if (a.privileged) w.push('Deze app draait privileged: hij krijgt bijna volledige toegang tot je server.');
    if (a.gpu) w.push('Deze app gebruikt de NVIDIA-GPU. Daarvoor moet install.sh met --nvidia uitgevoerd zijn.');
    if (a.fields().some((f) => f.value === '/var/run/docker.sock')) w.push('Deze app krijgt toegang tot Docker en kan dus al je containers beheren.');
    return w;
  }
  function storeDetails(a) {
    let name = storeSlug(a.name);
    for (let n = 2; apps.some((x) => x.name === name); n++) name = storeSlug(a.name) + '-' + n;
    const fields = a.fields().map((f) => (f.auto ? { ...f, value: AD() + '/' + name } : f));
    const { fields: _, gpu: __, ...rest } = a;
    const networks = dnets.filter((n) => !n.builtin).map((n) => ({ name: n.name, driver: n.driver, subnet: n.subnet, gateway: n.gateway, ipRange: n.ipRange }));
    const tpl = a.network || 'bridge';
    const networkDefault = ['bridge', 'host', 'none'].includes(tpl) || networks.some((n) => n.name === tpl) ? tpl : 'bridge';
    return { ...rest, fields, warnings: storeWarnings(a, networkDefault), networks, networkDefault, templateNetwork: tpl, suggestedName: name, appdataDir: AD(), sharesDir: '/tank', stacksDir: '/opt/stacks',
      installed: storeInstalled(a), appdataMissing: false };
  }
  function storeInstall(a, body) {
    const name = String(body.name || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw err('Kies een naam met kleine letters, cijfers, - of _ (maximaal 63 tekens).');
    if (apps.some((x) => x.name === name)) throw err('Er bestaat al een app met de naam ' + name + '. Kies een andere naam.', 409);
    const fields = a.fields().map((f) => (f.key in (body.values || {}) ? { ...f, value: String(body.values[f.key]) } : f));
    const tpl = a.network || 'bridge';
    const network = body.network || (tpl === 'host' || tpl === 'none' ? tpl : 'bridge');
    if (!['bridge', 'host', 'none'].includes(network) && !dnets.some((n) => n.name === network)) throw err('Het netwerk ' + network + ' bestaat niet. Maak het aan bij Instellingen → Docker-netwerken of kies een ander netwerk.');
    if (body.ip && ['bridge', 'host', 'none'].includes(network)) throw err('Een vast IP-adres kan alleen in een eigen Docker-netwerk.');
    const noPorts = network === 'host' || network === 'none' || ownIpNet(network);
    let webPort = null;
    for (const f of fields) {
      if (f.required && !f.value.trim() && f.type !== 'Device') throw err('Vul ' + f.name + ' in.');
      if (f.type === 'Port' && f.value && !noPorts) {
        const clash = apps.find((x) => x.ports.some((p) => String(p.public) === f.value));
        if (clash) throw err('Poort ' + f.value + ' is al in gebruik door ' + clash.name + '. Kies een andere poort.', 409);
        if (a.webui && a.webui.includes('[PORT:' + f.target + ']')) webPort = Number(f.value);
      }
    }
    const id = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
    const extraPorts = (body.extraPorts || []).map((p) => {
      const h = String(p.host || '').trim(), c = String(p.container || '').trim();
      if (!/^\d{1,5}$/.test(h) || !/^\d{1,5}$/.test(c) || Number(h) > 65535 || Number(c) > 65535 || !Number(h) || !Number(c)) throw err('Vul bij elke extra poort twee poorten in tussen 1 en 65535.');
      return { public: Number(h), private: Number(c), type: p.protocol === 'udp' ? 'UDP' : 'TCP' };
    });
    if (extraPorts.length && noPorts) throw err('Met het host-netwerk luistert de app op zijn eigen poorten. Kies het standaardnetwerk (bridge) om poorten toe te voegen.');
    for (const p of extraPorts) {
      const clash = apps.find((x) => x.ports.some((q) => q.public === p.public));
      if (clash) throw err('Poort ' + p.public + ' is al in gebruik door ' + clash.name + '. Kies een andere poort.', 409);
    }
    setAppNet({ name: '__check' }, network, String(body.ip || '').trim()); // controleert het adres
    const own = appNet.__check; delete appNet.__check;
    storeJobs[id] = { started: Date.now(), name, a, fields, webPort, network, own, extraPorts };
    return { job: id, name, file: '/opt/stacks/' + name + '/compose.yaml', warnings: storeWarnings(a, network) };
  }
  function storeJob(id) {
    const j = storeJobs[id]; if (!j) throw err('Deze installatie is niet (meer) bekend.', 404);
    const t = (Date.now() - j.started) / 1000;
    const steps = [
      [0, 'Compose-bestand geschreven: /opt/stacks/' + j.name + '/compose.yaml'], [0, 'Image downloaden: ' + j.a.image],
      [0.6, j.name + ' Pulling'], [1.2, 'a2318d6c47ec Pulling fs layer'], [1.6, 'a2318d6c47ec Downloading [=====>     ] 12.4MB/31.2MB'],
      [2.4, 'a2318d6c47ec Download complete'], [2.8, 'a2318d6c47ec Pull complete'], [3.2, j.name + ' Pulled'], [3.4, 'App starten…'],
      ...(j.own ? [] : [[3.8, 'Network ' + j.name + '_default Created']]), [4.3, 'Container ' + j.name + ' Started'],
    ];
    const lines = steps.filter(([at]) => t >= at).map(([, l]) => l);
    const done = t >= 4.5;
    if (done && !j.added) {
      j.added = true;
      const ownIp = j.own && ownIpNet(j.network);
      const ports = j.network === 'host' || j.network === 'none' || ownIp ? [] : j.fields.filter((f) => f.type === 'Port' && f.value)
        .map((f) => ({ public: Number(f.value), private: Number(f.target), type: /udp/.test(f.mode) ? 'UDP' : 'TCP' })).concat(ownIp ? [] : j.extraPorts || []);
      if (j.own) appNet[j.name] = j.own;
      const tplPort = j.a.webui && (j.a.webui.match(/\[PORT:(\d+)\]/) || [])[1];
      apps.push({ id: 'demo:' + j.name, name: j.name, image: /:[^/]+$/.test(j.a.image) ? j.a.image : j.a.image + ':latest', state: 'RUNNING', status: 'Up minder dan een minuut', autoStart: true,
        icon: j.a.icon, webui: ownIp ? 'http://' + j.own.ip + (tplPort ? ':' + tplPort : '') + '/' : j.webPort ? 'http://[IP]:' + j.webPort + '/' : null, ports, compose: j.name, canUpdate: true, update: null,
        storeId: j.a.id, custom: !!j.custom,
        dataDirs: [...new Set(j.fields.filter((f) => f.type === 'Path' && f.value.startsWith(AD() + '/')).map((f) => f.value.split('/').slice(0, 4).join('/')))] });
      apps.sort((x, y) => x.name.localeCompare(y.name));
    }
    return { done, ok: done, error: null, name: j.name, webui: j.a.webui, lines };
  }

  /* ---- eigen app: een paar bekende images, zoals de registry ze zou melden */
  const IMAGES = {
    nginx: { ports: ['80/tcp'], volumes: [] }, 'louislam/uptime-kuma': { ports: ['3001/tcp'], volumes: ['/app/data'] },
    'linuxserver/jellyfin': { ports: ['8096/tcp', '8920/tcp'], volumes: ['/config'], lsio: true }, 'lscr.io/linuxserver/jellyfin': { ports: ['8096/tcp', '8920/tcp'], volumes: ['/config'], lsio: true },
    'ghcr.io/home-assistant/home-assistant': { ports: [], volumes: [] }, 'freshrss/freshrss': { ports: ['80/tcp'], volumes: ['/var/www/FreshRSS/data'] },
  };
  function demoNormalize(input) {
    let x = String(input || '').trim();
    const pull = x.match(/^docker\s+pull\s+(\S+)$/i); if (pull) x = pull[1];
    if (/\s/.test(x)) return null;
    const hub = x.match(/^https?:\/\/hub\.docker\.com\/(?:r\/([^/]+\/[^/?#]+)|_\/([^/?#]+))(?:\/tags\?name=([\w.-]+))?/i);
    if (hub) x = (hub[1] || hub[2]) + (hub[3] ? ':' + hub[3] : '');
    else if (/^https?:\/\//i.test(x)) return null;
    const c = x.lastIndexOf(':'), sl = x.lastIndexOf('/');
    const repo = (c > sl ? x.slice(0, c) : x).toLowerCase(), tag = c > sl ? x.slice(c + 1) : 'latest';
    return /^[a-z0-9][a-z0-9._\/-]*$/.test(repo) ? { repo, tag, image: repo + ':' + tag } : null;
  }
  function demoInspect(input) {
    const n = demoNormalize(input);
    if (!n) throw err('Plak de naam van een image (bv. nginx:latest of lscr.io/linuxserver/jellyfin) of een link naar Docker Hub.');
    const info = IMAGES[n.repo];
    if (!info) throw err('Het image ' + n.image + ' kon niet gelezen worden: deze tag bestaat niet (meer) in de registry.', 404);
    const base = n.repo.split('/').pop().replace(/[^a-z0-9_-]+/g, '-');
    let name = base; for (let i = 2; apps.some((a) => a.name === name); i++) name = base + '-' + i;
    const used = new Set(apps.flatMap((a) => a.ports.map((p) => p.public + '/' + p.type)));
    const ports = info.ports.map((k) => {
      const [port, proto] = k.split('/'); let host = Number(port);
      while (used.has(host + '/' + proto.toUpperCase())) host++;
      used.add(host + '/' + proto.toUpperCase());
      return { host: String(host), container: port, protocol: proto };
    });
    const st = store.find((a) => a.image.replace(/^lscr\.io\//, '') === n.repo.replace(/^lscr\.io\//, ''));
    return {
      image: n.image, name, ports,
      volumes: info.volumes.map((v) => ({ host: AD() + '/' + name + (v === '/config' ? '' : '/' + v.split('/').filter(Boolean).join('-')), container: v, mode: 'rw', auto: true })),
      env: (info.lsio ? [{ name: 'PUID', value: '1000' }, { name: 'PGID', value: '1000' }] : []).concat({ name: 'TZ', value: 'Europe/Brussels' }),
      webui: ports[0] ? 'http://[IP]:[PORT:' + ports[0].container + ']/' : '', icon: ICON(base) || '',
      storeMatch: st ? { id: st.id, name: st.name } : null,
      warnings: ports.length ? [] : ['Het image meldt geen poorten. Heeft de app een webinterface, voeg dan zelf een poort toe.'],
      networks: dnets.filter((x) => !x.builtin).map((x) => ({ name: x.name, driver: x.driver, subnet: x.subnet })), networkDefault: 'bridge',
      appdataDir: AD(), stacksDir: '/opt/stacks', appdataMissing: false,
    };
  }
  function demoInstallCustom(b) {
    const name = String(b.name || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw err('Kies een naam met kleine letters, cijfers, - of _ (maximaal 63 tekens).');
    if (apps.some((x) => x.name === name)) throw err('Er bestaat al een app met de naam ' + name + '. Kies een andere naam.', 409);
    const n = demoNormalize(b.image); if (!n) throw err('Plak de naam van een image (bv. nginx:latest of lscr.io/linuxserver/jellyfin) of een link naar Docker Hub.');
    const network = b.network || 'bridge';
    const noPorts = network === 'host' || network === 'none' || ownIpNet(network);
    const extraPorts = noPorts ? [] : (b.ports || []).filter((p) => p.host || p.container).map((p) => {
      if (!/^\d{1,5}$/.test(String(p.container))) throw err('Poort in de app "' + p.container + '" is geen geldige poort.');
      if (!/^\d{1,5}$/.test(String(p.host))) throw err('Poort op de server "' + p.host + '" is geen geldige poort.');
      const clash = apps.find((x) => x.ports.some((q) => String(q.public) === String(p.host)));
      if (clash) throw err('Poort ' + p.host + ' is al in gebruik door ' + clash.name + '. Kies een andere poort.', 409);
      return { public: Number(p.host), private: Number(p.container), type: p.protocol === 'udp' ? 'UDP' : 'TCP' };
    });
    for (const v of b.volumes || []) if (v.container && !String(v.container).startsWith('/')) throw err('De map in de app "' + v.container + '" moet met / beginnen.');
    setAppNet({ name: '__check' }, network, String(b.ip || '').trim());
    const own = appNet.__check; delete appNet.__check;
    const webPort = (() => { const m = String(b.webui || '').match(/\[PORT:(\d+)\]/); const p = m && extraPorts.find((x) => String(x.private) === m[1]); return p ? p.public : null; })();
    const id = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
    storeJobs[id] = { started: Date.now(), name, a: { id: null, image: n.image, webui: b.webui || null, icon: b.icon || ICON(n.repo.split('/').pop()) }, custom: true,
      fields: (b.volumes || []).map((v) => ({ type: 'Path', value: String(v.host || '') })), webPort, network, own, extraPorts };
    return { job: id, name, file: '/opt/stacks/' + name + '/compose.yaml' };
  }

  /* ---- VM's: Ubuntu toont het startuitstel (start 45 s na het openen van de demo) */
  const vms = [
    { name: 'Home Assistant OS', state: 'RUNNING', vcpus: 2, memory: 4 * GB, diskGb: 32, autostart: true, delay: 0,
      description: 'Domotica: lichten, verwarming en de slimme meter.', base: [3, 14], ram: [0.45, 0.55] },
    { name: 'Windows 11', state: 'SHUTOFF', vcpus: 4, memory: 8 * GB, diskGb: 64, autostart: false, delay: 0, description: '', base: [5, 30], ram: [0.6, 0.75] },
    { name: 'Ubuntu Server (test)', state: 'SHUTOFF', vcpus: 2, memory: 2 * GB, diskGb: 32, autostart: true, delay: 60,
      description: 'Om dingen uit te proberen.', base: [1, 8], ram: [0.3, 0.4], startsAt: Date.now() + 45000 },
  ];
  const DEMO_IPS = { 'Home Assistant OS': ['192.168.1.40', 'fd00::5054:ff:fe6b:3c58'], 'Windows 11': ['192.168.122.45'], 'Ubuntu Server (test)': ['10.10.0.130'] };
  const VNC_PW = { 'Home Assistant OS': 'q7Rk2mPa', 'Windows 11': 'Zt4wLs9e', 'Ubuntu Server (test)': 'Hn3vB8xc' };
  // Hardware per VM, in dezelfde vorm als lib/vmhw.js parseHardware().
  const nic = (type, source, model, mac) => ({ mac, type, source, model, locked: false });
  const vmHw = {
    'Home Assistant OS': { nics: [nic('bridge', 'br0', 'virtio', '52:54:00:6b:3c:58')], extra: [], cdrom: null, boot: 'disk', hostdevs: ['usb:10c4:ea60'], cpuPins: [2, 10] },
    'Windows 11': { nics: [nic('network', 'default', 'e1000e', '52:54:00:1f:a2:07')], extra: [], cdrom: '/tank/isos/Win11_25H2_Dutch_x64.iso', boot: 'cdrom', hostdevs: [], cpuPins: [] },
    'Ubuntu Server (test)': { nics: [nic('network', 'labo', 'virtio', '52:54:00:93:5e:c1')], extra: [], cdrom: null, boot: 'disk', hostdevs: [], cpuPins: [] },
  };
  const hwOf = (v) => vmHw[v.name] || (vmHw[v.name] = { nics: [nic('bridge', 'br0', 'virtio', '52:54:00:' + [0, 0, 0].map(() => Math.floor(rnd(16, 255)).toString(16)).join(':'))], extra: [], cdrom: null, boot: 'disk', hostdevs: [], cpuPins: [] });
  const vmNets = [
    { name: 'default', mode: 'nat', bridge: 'virbr0', hostBridge: null, address: '192.168.122.1', subnet: '192.168.122.0/24', dhcp: { start: '192.168.122.2', end: '192.168.122.254' }, active: true, autostart: true },
    { name: 'labo', mode: 'isolated', bridge: 'virbr1', hostBridge: null, address: '10.10.0.1', subnet: '10.10.0.0/24', dhcp: { start: '10.10.0.128', end: '10.10.0.254' }, active: true, autostart: true },
  ];
  function vmNetList() {
    const used = (type, name) => vms.filter((v) => hwOf(v).nics.some((n) => n.type === type && n.source === name)).map((v) => v.name).sort();
    return { networks: vmNets.map((n) => ({ ...copy(n), builtin: n.name === 'default', vms: used('network', n.name) })),
      bridges: [{ name: 'br0', address: '192.168.1.10/24', up: true, vms: used('bridge', 'br0') }] };
  }
  function vmNetCreate(b) {
    const name = String(b.name || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,31}$/.test(name)) throw err('Kies een naam met letters, cijfers, -, _ of . (maximaal 32 tekens), bv. labo.');
    if (vmNets.some((n) => n.name === name)) throw err('Er bestaat al een VM-netwerk met de naam ' + name + '. Kies een andere naam.', 409);
    const text = String(b.subnet || '').trim(), c = cidr(text, 16, 28);
    if (!c) throw err('"' + text + '" is geen geldig subnet. Kies iets als 192.168.150.0/24 (netmasker tussen /16 en /28).');
    if (!['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].some((p) => { const q = cidr(p, 8, 16); return overlap(q, c) && c.prefix >= q.prefix; })) throw err('Kies een privé-subnet: 10.x.x.x, 172.16–31.x.x of 192.168.x.x.');
    const clash = vmNets.concat([{ name: 'br0', subnet: '192.168.1.0/24' }, { name: 'docker0', subnet: '172.17.0.0/16' }]).find((n) => overlap(c, cidr(n.subnet, 0, 32)));
    if (clash) throw err('Het subnet ' + c.text + ' overlapt met ' + clash.name + ' (' + clash.subnet + '). Kies een ander subnet.', 409);
    const ip = (n) => [16777216, 65536, 256, 1].map((d) => Math.floor(n / d) % 256).join('.');
    vmNets.push({ name, mode: b.mode === 'isolated' ? 'isolated' : 'nat', bridge: 'virbr' + vmNets.length, hostBridge: null, address: ip(c.base + 1), subnet: c.text,
      dhcp: b.dhcp === false ? null : { start: ip(c.base + c.size / 2), end: ip(c.base + c.size - 2) }, active: true, autostart: true });
    return { name };
  }
  function vmNetDelete(name) {
    const n = vmNetList().networks.find((x) => x.name === name);
    if (!n) throw err('Dit VM-netwerk bestaat niet (meer).', 404);
    if (n.vms.length) throw err('Het VM-netwerk ' + name + ' wordt nog gebruikt door ' + n.vms.join(', ') + ". Kies voor die VM's eerst een ander netwerk.", 409);
    vmNets.splice(vmNets.findIndex((x) => x.name === name), 1);
    return { removed: name };
  }
  const USB = [{ key: 'usb:10c4:ea60', bus: 1, device: 4, vendor: '10c4', product: 'ea60', name: 'Silicon Labs CP210x UART Bridge (Sonoff Zigbee 3.0 Dongle Plus)' },
    { key: 'usb:0658:0200', bus: 1, device: 5, vendor: '0658', product: '0200', name: 'Sigma Designs Aeotec Z-Stick Gen5 (ZW090)' },
    { key: 'usb:0781:5583', bus: 2, device: 2, vendor: '0781', product: '5583', name: 'SanDisk Ultra Fit' }];
  const PCI = [
    { key: 'pci:0000:0a:00.0', address: '0000:0a:00.0', kind: 'Beeld', name: 'NVIDIA GeForce RTX 3060 Ti', group: '14', groupDevices: [{ address: '0000:0a:00.1', name: 'NVIDIA GA104 High Definition Audio Controller' }], driver: 'nvidia' },
    { key: 'pci:0000:0a:00.1', address: '0000:0a:00.1', kind: 'Geluid', name: 'NVIDIA GA104 High Definition Audio Controller', group: '14', groupDevices: [{ address: '0000:0a:00.0', name: 'NVIDIA GeForce RTX 3060 Ti' }], driver: 'snd_hda_intel' },
    { key: 'pci:0000:05:00.0', address: '0000:05:00.0', kind: 'Netwerk', name: 'Realtek RTL8125 2.5GbE Controller', group: '11', groupDevices: [], driver: 'r8169' },
    { key: 'pci:0000:0c:00.3', address: '0000:0c:00.3', kind: 'USB', name: 'Advanced Micro Devices Matisse USB 3.0 Host Controller', group: '17', groupDevices: [], driver: 'xhci_hcd' },
  ];
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vm';
  const isOn = (v) => v.state === 'RUNNING' || v.state === 'PAUSED';
  function tickVms() {
    vms.forEach((v) => { if (v.startsAt && Date.now() >= v.startsAt) { v.state = 'RUNNING'; v.startsAt = null; } });
  }
  function vmOut(v) {
    tickVms();
    const run = v.state === 'RUNNING';
    return {
      id: v.name, name: v.name, state: v.state, vcpus: v.vcpus, memory: v.memory,
      cpu: run ? Math.round(rnd(v.base[0], v.base[1]) * 10) / 10 : isOn(v) ? 0 : null,
      memUsed: isOn(v) ? Math.round(v.memory * rnd(v.ram[0], v.ram[1])) : null,
      autostart: v.autostart, delay: v.delay, startsAt: v.startsAt || null, description: v.description,
      ips: isOn(v) ? (DEMO_IPS[v.name] || (DEMO_IPS[v.name] = ['192.168.1.' + (60 + Object.keys(DEMO_IPS).length)])) : [],
    };
  }
  const findVm = (id) => { const v = vms.find((x) => x.name === decodeURIComponent(id)); if (!v) throw err('Deze VM bestaat niet (meer).', 404); return v; };
  const vmOptions = () => ({
    isos: [{ name: 'debian-13.1.0-amd64-netinst.iso', size: 754 * 1e6 }, { name: 'ubuntu-24.04.3-live-server-amd64.iso', size: 3.1 * 1e9 },
      { name: 'Win11_25H2_Dutch_x64.iso', size: 7.3 * 1e9 }],
    images: [{ name: 'haos_ova-16.2.qcow2', size: 1.1 * 1e9 }],
    isoDir: sp.isos, isoDirMissing: false, vmDir: sp.vms, vmDirMissing: false,
    network: 'bridge:br0', maxVcpus: 16, maxMemory: 32 * GB,
    networks: vmNets.map((n) => ({ name: n.name, mode: n.mode, subnet: n.subnet, active: n.active })), bridges: [{ name: 'br0', address: '192.168.1.10/24' }],
    usb: copy(USB), pci: copy(PCI), iommu: true,
    cpus: Array.from({ length: 16 }, (_, id) => ({ id, core: id % 8, siblings: [id % 8, id % 8 + 8] })),
  });
  // Hardware opslaan, met dezelfde controles als lib/vmhw.js validateHardware().
  function demoSaveHw(v, b) {
    const h = hwOf(v), opts = vmOptions();
    let changed = false;
    if (Array.isArray(b.nics)) {
      const macs = new Set();
      const nics = b.nics.map((n) => {
        if (n.locked) return h.nics.find((x) => x.mac === n.id);
        if (n.type === 'network' && !opts.networks.some((x) => x.name === n.source)) throw err('Het VM-netwerk "' + n.source + '" bestaat niet. Kies een ander netwerk.');
        if (n.type === 'bridge' && !opts.bridges.some((x) => x.name === n.source)) throw err('De bridge "' + n.source + '" bestaat niet op de server. Maak ze aan bij Instellingen → Netwerk.');
        const mac = String(n.mac || '').trim().toLowerCase() || '52:54:00:' + [0, 0, 0].map(() => Math.floor(rnd(16, 255)).toString(16)).join(':');
        if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || parseInt(mac.slice(0, 2), 16) & 1) throw err('"' + mac + '" is geen geldig MAC-adres, bv. 52:54:00:12:34:56.');
        if (macs.has(mac)) throw err('Het MAC-adres ' + mac + ' staat er twee keer in.');
        macs.add(mac);
        return nic(n.type, n.source, n.model || 'virtio', mac);
      });
      if (JSON.stringify(nics) !== JSON.stringify(h.nics)) { h.nics = nics; changed = true; }
    }
    if (b.cdrom !== undefined && b.cdrom !== '=') {
      if (b.cdrom && !opts.isos.some((f) => f.name === b.cdrom)) throw err('Kies een ISO uit /tank/isos.');
      h.cdrom = b.cdrom ? '/tank/isos/' + b.cdrom : null; // wisselt meteen, ook als de VM draait
    }
    if (b.boot && b.boot !== h.boot) { h.boot = b.boot; changed = true; }
    if (b.clipboard !== undefined && !!b.clipboard !== !!h.clipboard) { h.clipboard = !!b.clipboard; changed = true; }
    if (Array.isArray(b.hostdevs) && b.hostdevs.join() !== h.hostdevs.join()) {
      for (const k of b.hostdevs) if (!h.hostdevs.includes(k) && !USB.concat(PCI).some((x) => x.key === k)) throw err('Dit USB-apparaat is niet (meer) aangesloten. Steek het in en open het venster opnieuw.');
      h.hostdevs = [...b.hostdevs]; changed = true;
    }
    if (Array.isArray(b.cpuPins) && b.cpuPins.join() !== h.cpuPins.join()) {
      if (new Set(b.cpuPins).size !== b.cpuPins.length) throw err('Elke kern mag maar één keer gekozen worden.');
      h.cpuPins = [...b.cpuPins]; changed = true;
      if (h.cpuPins.length) b.vcpus = h.cpuPins.length;
    }
    const sizes = v.disks || (v.disks = [{ target: 'vda', size: v.diskGb * GB }]);
    for (const r of b.resizeDisks || []) {
      const dk = sizes.find((x) => x.target === r.target);
      if (dk && r.sizeGb * GB < dk.size) throw err('Een schijf kan alleen groter worden. ' + dk.target + ' is nu ' + Math.ceil(dk.size / GB) + ' GB.');
      if (dk) dk.size = r.sizeGb * GB;
    }
    if ((b.removeDisks || []).length) { v.disks = sizes.filter((x) => !b.removeDisks.includes(x.target)); changed = true; }
    for (const a of b.addDisks || []) {
      if (!(a.sizeGb >= 1 && a.sizeGb <= 16384)) throw err('De schijfgrootte (GB) moet tussen 1 en 16384 liggen.');
      const pre = a.bus === 'sata' ? 'sd' : 'vd', used = v.disks.map((x) => x.target);
      let tgt; for (let i = 0; i < 26 && !tgt; i++) if (!used.includes(pre + String.fromCharCode(97 + i))) tgt = pre + String.fromCharCode(97 + i);
      v.disks.push({ target: tgt, size: a.sizeGb * GB, file: '/tank/vms/' + slug(v.name) + '/' + slug(v.name) + '-' + (v.disks.length + 1) + '.qcow2' });
      changed = true;
    }
    return changed;
  }
  const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,62}$/;
  function checkFields(b) {
    if (b.name !== undefined && !NAME.test(String(b.name).trim())) throw err('Kies een naam van 1 tot 63 tekens: letters, cijfers, spaties en . _ - ( ).');
    if (!(b.vcpus >= 1 && b.vcpus <= 16)) throw err("Het aantal vCPU's moet tussen 1 en 16 liggen.");
    if (!(b.memoryGb >= 0.25 && b.memoryGb <= 32)) throw err('Geheugen moet tussen 0,25 en 32 GB liggen.');
    if (b.delay != null && !(b.delay >= 0 && b.delay <= 3600)) throw err('Startuitstel moet tussen 0 en 3600 liggen.');
  }

  /* ---- opslag: ZFS */
  const disk = (name, model, size, rot, tran, temp, pool, vdev, role = 'data') => ({
    id: name, key: 's:DEMO' + name.toUpperCase(), name, model, serial: 'DEMO' + name.toUpperCase(), size, rotational: rot, transport: tran, temp, smartOk: true,
    sectors: rot ? { reallocated: name === 'sdd' ? 8 : 0, pending: 0, uncorrectable: 0 } : null,
    pool, role, vdev, state: pool ? 'ONLINE' : null, errors: 0,
  });
  const disks = [
    disk('sda', 'WDC WD20EFZX', 2e12, true, 'sata', 34, 'tank', 'raidz1'),
    disk('sdb', 'WDC WD20EFZX', 2e12, true, 'sata', 35, 'tank', 'raidz1'),
    disk('sdc', 'WDC WD20EFZX', 2e12, true, 'sata', null, 'tank', 'raidz1'),
    disk('sdd', 'WDC WD20EFZX', 2e12, true, 'sata', 33, 'tank', 'raidz1'),
    disk('nvme0n1', 'Samsung 980', 512e9, false, 'nvme', 41, 'snel', 'mirror'),
    disk('nvme1n1', 'Samsung 980', 512e9, false, 'nvme', 39, 'snel', 'mirror'),
    // Nog vrij: twee nieuwe 4 TB-schijven en een oude met NTFS, om een pool aan te maken.
    disk('sde', 'ST4000VN006 IronWolf', 4e12, true, 'sata', 31, null, null),
    disk('sdf', 'ST4000VN006 IronWolf', 4e12, true, 'sata', 32, null, null),
    disk('sdg', 'WDC WD30EFRX', 3e12, true, 'sata', 30, null, null),
    disk('sdi', 'Samsung SSD 870 EVO', 1e12, false, 'sata', 29, null, null),
  ];
  // Wat lib/zpool.js poolOptions() teruggeeft (de systeemschijf sdh staat niet bij de schijven van Opslag).
  const SYS_DISK = { name: 'sdh', size: 240e9, model: 'KINGSTON SA400S37240G', serial: 'DEMOSDH', rotational: false, transport: 'sata', byId: '/dev/disk/by-id/ata-KINGSTON_SA400S37240G_DEMOSDH', available: false, reason: 'Systeemschijf (Debian staat erop)', warn: null };
  // Details van een schijf, zoals lib/disks.js parseSmart() ze geeft. sdc slaapt, sdd heeft een paar herplaatste sectoren.
  const smartState = {};
  function demoDisk(name, wake) {
    const d = disks.find((x) => x.name === name);
    if (!d) throw err('De schijf ' + name + ' bestaat niet (meer).', 404);
    if (name === 'sdc' && !wake && !smartState.sdcAwake) return { name, transport: d.transport, rotational: d.rotational, sleeping: true };
    if (name === 'sdc') { smartState.sdcAwake = true; d.temp = 30; }
    const st = smartState[name] || (smartState[name] = { tests: [] });
    if (st.running && Date.now() >= st.running.until) {
      st.tests.unshift({ type: st.running.type === 'short' ? 'Short offline' : 'Extended offline', passed: true, result: 'ok', text: 'Completed without error', hours: 0 });
      st.running = null;
    }
    const seed = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const hdd = d.rotational, nv = d.transport === 'nvme';
    const hours = { sda: 36812, sdb: 36790, sdc: 36801, sdd: 41220, sde: 112, sdf: 108, sdg: 23400, nvme0n1: 9120, nvme1n1: 9118 }[name] || 1000 + seed * 10;
    const baseTests = hours > 1000 ? [{ type: nv ? 'Short' : 'Short offline', passed: true, result: 'ok', text: 'Completed without error', hours: hours - 160 },
      { type: nv ? 'Extended' : 'Extended offline', passed: true, result: 'ok', text: 'Completed without error', hours: hours - 900 }] : [];
    const tests = st.tests.map((x) => ({ ...x, hours })).concat(baseTests);
    const attrs = hdd ? [[1, 'Raw_Read_Error_Rate', 200, 51, 0], [3, 'Spin_Up_Time', 172, 21, 4258], [4, 'Start_Stop_Count', 100, 0, 1204],
      [5, 'Reallocated_Sector_Ct', 200, 140, name === 'sdd' ? 8 : 0], [9, 'Power_On_Hours', 50, 0, hours], [12, 'Power_Cycle_Count', 100, 0, 87],
      [194, 'Temperature_Celsius', 116, 0, d.temp || 30], [197, 'Current_Pending_Sector', 200, 0, 0], [198, 'Offline_Uncorrectable', 100, 0, 0],
      [199, 'UDMA_CRC_Error_Count', 200, 0, name === 'sdb' ? 3 : 0]] : [];
    return {
      name, transport: d.transport, rotational: d.rotational, sleeping: false,
      model: d.model + (hdd ? '-68AWUN0' : nv ? ' 500GB' : ' 1TB'), family: hdd ? (/ST4000/.test(d.model) ? 'Seagate IronWolf' : 'Western Digital Red') : 'Samsung based SSDs',
      serial: d.serial, firmware: hdd ? '81.00B81' : '3B4QFXO7', size: d.size, rpm: hdd ? (/ST4000/.test(d.model) ? 5900 : 5400) : null,
      formFactor: hdd ? '3.5 inches' : nv ? 'M.2' : '2.5 inches', link: nv ? null : '6.0 Gb/s', smartOk: true, temp: d.temp,
      powerOnHours: hours, powerCycles: 40 + (seed % 60),
      watch: nv ? { mediaErrors: 0, criticalWarning: 0 } : { reallocated: name === 'sdd' ? 8 : 0, pending: 0, uncorrectable: 0, crcErrors: name === 'sdb' ? 3 : 0 },
      nvme: nv ? { percentUsed: name === 'nvme0n1' ? 4 : 3, spare: 100, spareThreshold: 10, written: (name === 'nvme0n1' ? 18.4 : 17.9) * 1e12, unsafeShutdowns: 12 } : null,
      errorLog: 0, testRunning: st.running ? { remaining: Math.min(90, Math.max(10, Math.round(((st.running.until - Date.now()) / st.running.total) * 10) * 10)) } : null,
      testMinutes: hdd ? { short: 2, long: /ST4000/.test(d.model) ? 412 : 252 } : null, tests,
      attributes: attrs.map(([id, n, value, thresh, raw]) => ({ id, name: n, value, worst: value, thresh, raw: String(raw), failing: false })),
    };
  }
  function demoDiskTest(name, type) {
    if (!['short', 'long'].includes(type)) throw err('Kies een korte of een lange test.');
    const st = smartState[name] || (smartState[name] = { tests: [] });
    if (st.running) throw err('De schijf weigerde de test. Misschien loopt er al een.', 409);
    const total = type === 'short' ? 20000 : 45000; // in de demo een stuk sneller dan echt
    st.running = { type, until: Date.now() + total, total };
    return { started: true, minutes: type === 'short' ? 2 : 252 };
  }
  function poolOptions() {
    const list = disks.map((d) => ({ name: d.name, size: d.size, model: d.model, serial: d.serial, rotational: d.rotational, transport: d.transport,
      byId: '/dev/disk/by-id/' + (d.transport === 'nvme' ? 'nvme-' : 'ata-') + d.model.replace(/\s+/g, '_') + '_' + d.serial,
      available: !d.pool, reason: d.pool ? 'In pool ' + d.pool : null, warn: d.name === 'sdg' ? 'Heeft partities (ntfs). Die worden gewist.' : null })).concat(copy(SYS_DISK));
    return { disks: list.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name, undefined, { numeric: true })),
      pools: pools.map((p) => p.name), layouts: ['stripe', 'mirror', 'raidz1', 'raidz2', 'raidz3', 'mirrors'], compression: ['lz4', 'zstd', 'off'] };
  }
  function demoCreatePool(b) {
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name) || /^(mirror|raidz\d?|draid\d?|spare|log|cache|special|dedup|c\d+)/i.test(name)) throw err('Kies een naam die met een letter begint, met letters, cijfers, - of _ (bv. tank of snel). Namen als mirror of raidz zijn niet toegelaten.');
    if (pools.some((p) => p.name === name)) throw err('Er bestaat al een pool met de naam ' + name + '.', 409);
    const MIN = { stripe: 1, mirror: 2, raidz1: 3, raidz2: 4, raidz3: 5, mirrors: 4 };
    if (!MIN[b.layout]) throw err('Kies een indeling: stripe, mirror, RAID-Z1, RAID-Z2, RAID-Z3 of mirror-paren.');
    const opts = poolOptions();
    const chosen = [...new Set(b.disks || [])].map((n) => {
      const d = opts.disks.find((x) => x.name === n);
      if (!d) throw err('De schijf ' + n + ' bestaat niet (meer). Open het venster opnieuw.');
      if (!d.available) throw err(n + ' kan je niet gebruiken: ' + d.reason + '.', 409);
      return d;
    });
    if (chosen.length < MIN[b.layout]) throw err('Deze indeling heeft minstens ' + MIN[b.layout] + ' schijven nodig.');
    if (b.layout === 'mirrors' && chosen.length % 2) throw err('Mirror-paren hebben een even aantal schijven nodig.');
    if (b.confirm !== name) throw err('Typ de naam van de pool om te bevestigen dat de schijven gewist mogen worden.');
    const sizes = chosen.map((d) => d.size), n = sizes.length, min = Math.min(...sizes), raw = sizes.reduce((x, y) => x + y, 0);
    let usable = b.layout === 'stripe' ? raw : b.layout === 'mirrors' ? (() => { const x = [...sizes].sort((p, q) => q - p); let u = 0; for (let i = 0; i < n; i += 2) u += Math.min(x[i], x[i + 1]); return u; })()
      : ({ mirror: 1, raidz1: n - 1, raidz2: n - 2, raidz3: n - 3 })[b.layout] * min;
    usable -= Math.min(Math.max(usable / 32, 128 * 1048576), 128 * GB);
    const label = b.layout === 'mirrors' ? 'mirror' : b.layout;
    pools.push({ name, health: 'ONLINE', used: 0, free: usable, total: usable, layout: b.layout === 'mirrors' ? 'mirror + mirror' : label, diskCount: n,
      scrub: { kind: null, running: false, progress: null, errors: null, last: null } });
    chosen.forEach((c) => { const d = disks.find((x) => x.name === c.name); Object.assign(d, { pool: name, role: 'data', vdev: label, state: 'ONLINE' }); });
    datasets.push({ name, used: 0, free: usable, mountpoint: '/' + name, compress: 1 });
    const folders = b.folders === false ? [] : ['appdata', 'media', 'backups', 'vms', 'isos'];
    folders.forEach((f) => datasets.push({ name: name + '/' + f, used: 0, free: usable, mountpoint: '/' + name + '/' + f, compress: 1 }));
    return { name, folders, uses: [] }; // in de demo hebben appgegevens, VM's en ISO's al een plek
  }
  /* ---- opslaglocaties (Instellingen → Opslag) en appgegevens verhuizen (nagebootst, ~10 s) */
  let spJob = null;
  const FOLDER = { appdata: 'appdata', vms: 'vms', isos: 'isos', shares: '' };
  const spPools = () => pools.map((p) => ({ name: p.name, mountpoint: '/' + p.name, free: p.free }));
  const spApps = () => apps.filter((a) => a.compose && a.dataDirs.some((x) => x.startsWith(sp.appdata + '/')));
  function spMigration() {
    if (!spJob) return null;
    const el = Date.now() - spJob.start, n = spJob.apps.length;
    const lines = [...spJob.apps.map((a) => a + ' stoppen…'), 'Kopiëren van ' + spJob.from + ' naar ' + spJob.to + '…'];
    let step = 'stop', percent = 0, state = 'running';
    if (el > 1500) { step = 'copy'; percent = Math.min(100, Math.round(((el - 1500) / 7000) * 100)); }
    if (el > 8500) { step = 'compose'; lines.push(...spJob.apps.map((a) => 'Aangepast: /opt/stacks/' + a + '/compose.yaml (reservekopie: compose.yaml.bak)')); }
    if (el > 9500) { step = 'start'; lines.push(...spJob.apps.map((a) => a + ' starten…')); }
    if (el > 10500) {
      step = 'done'; state = 'done'; lines.push('Klaar. De oude map ' + spJob.from + ' blijft staan: verwijder ze zelf als alles werkt.');
      if (!spJob.applied) {
        spJob.applied = true; sp.appdata = spJob.to;
        apps.forEach((a) => { a.dataDirs = a.dataDirs.map((x) => (x.startsWith(spJob.from + '/') ? spJob.to + x.slice(spJob.from.length) : x)); });
        if (!datasets.some((d) => d.mountpoint === spJob.to)) datasets.push({ name: spJob.to.slice(1), used: 162 * GB, free: 1e12, mountpoint: spJob.to, compress: 1.6 });
      }
    }
    return { from: spJob.from, to: spJob.to, state, step, percent, error: null, lines, manual: [], started: new Date(spJob.start).toISOString(), finished: state === 'done' ? new Date().toISOString() : null };
  }
  function spGet() {
    spMigration();
    return { paths: { ...sp }, exists: { appdata: true, vms: true, isos: true, shares: true }, pools: spPools(), folders: FOLDER,
      apps: spApps().map((a) => ({ project: a.compose, containers: [a.name], running: /RUNNING/.test(a.state) })), manual: [], migration: spMigration() };
  }
  function spSet(b) {
    const p = spPools().find((x) => x.name === b.pool);
    if (!p) throw err('Kies een pool.');
    if (b.kind === 'appdata') {
      const m = spMigration();
      if (m && m.state === 'running') throw err('Er loopt al een verhuis. Wacht tot die klaar is.', 409);
      const to = p.mountpoint + '/appdata';
      if (to === sp.appdata) throw err('De appgegevens staan al op ' + p.name + '.');
      spJob = { start: Date.now(), from: sp.appdata, to, apps: spApps().map((a) => a.compose) };
      return { started: true, migration: spMigration() };
    }
    if (!['vms', 'isos', 'shares'].includes(b.kind)) throw err('Onbekende soort map.');
    sp[b.kind] = p.mountpoint + (FOLDER[b.kind] ? '/' + FOLDER[b.kind] : '');
    return spGet();
  }
  const pools = [
    { name: 'tank', health: 'ONLINE', used: 3.3 * TB, free: 2.05 * TB, layout: 'raidz1', diskCount: 4,
      scrub: { kind: 'scrub', running: false, progress: null, errors: 0, last: new Date(Date.now() - 9 * 86400000).toISOString() } },
    { name: 'snel', health: 'ONLINE', used: 190 * GB, free: 271 * GB, layout: 'mirror', diskCount: 2,
      scrub: { kind: 'scrub', running: false, progress: null, errors: 0, last: new Date(Date.now() - 9 * 86400000).toISOString() } },
  ].map((p) => ({ ...p, total: p.used + p.free }));
  const datasets = [
    ['tank/media', 2.1 * TB, 1.0], ['tank/fotos', 610 * GB, 1.01], ['tank/documenten', 84 * GB, 1.42], ['tank/backups', 420 * GB, 1.18],
    ['tank/isos', 12 * GB, 1.0], ['tank/vms', 96 * GB, 1.31], ['snel/appdata', 162 * GB, 1.65], ['snel/docker', 28 * GB, 1.52],
  ].map(([name, used, compress]) => ({ name, used, free: name.startsWith('tank') ? 2.05 * TB : 271 * GB, mountpoint: '/' + name, compress }));
  // Schijfbays: 8 bays (de vier HDD's van tank, drie vrije schijven, één lege), 2 M.2-sleuven met de NVMe's van snel en 2 sleuven van 2,5" (één SSD).
  let bays = { count: 8, columns: 8, m2: 2, ssd: 2, slots: Object.fromEntries([['sda', 1], ['sdb', 2], ['sdc', 3], ['sdd', 4], ['sde', 5], ['sdf', 6], ['sdg', 7],
    ['nvme0n1', 'm1'], ['nvme1n1', 'm2'], ['sdi', 's1']].map(([n, id]) => [id, { key: 's:DEMO' + n.toUpperCase(), label: 'DEMO' + n.toUpperCase() }])) };
  function saveBays(b) {
    const count = Number(b.count), columns = Number(b.columns), m2 = Number(b.m2 || 0), ssd = Number(b.ssd || 0);
    if (!Number.isInteger(count) || count < 0 || count > 60) throw err('Kies tussen 0 en 60 bays.');
    if (!Number.isInteger(columns) || columns < 1 || columns > 12) throw err('Kies tussen 1 en 12 kolommen.');
    if (!Number.isInteger(m2) || m2 < 0 || m2 > 8) throw err('Kies tussen 0 en 8 M.2-sleuven.');
    if (!Number.isInteger(ssd) || ssd < 0 || ssd > 16) throw err('Kies tussen 0 en 16 2,5"-sleuven.');
    const slots = {}, seen = new Set();
    for (const [id, v] of Object.entries(b.slots || {})) {
      const m = String(id).match(/^([ms]?)(\d+)$/); const n = m ? Number(m[2]) : 0;
      if (!m || n < 1 || n > ({ '': count, m: m2, s: ssd })[m[1]]) continue;
      if (seen.has(v.key)) throw err('Een schijf kan maar in één bay zitten.');
      seen.add(v.key); slots[m[1] + n] = { key: String(v.key), label: String(v.label || '') };
    }
    bays = { count, columns, m2, ssd, slots };
    return copy(bays);
  }
  function storageSummary() {
    const total = pools.reduce((s, p) => s + p.total, 0), used = pools.reduce((s, p) => s + p.used, 0);
    return { health: 'ONLINE', total, used, free: total - used, pools: pools.length };
  }

  /* ---- AI */
  const models = [
    { name: 'llama3.1:8b', size: 4.9 * GB, family: 'llama', params: '8.0B', quant: 'Q4_K_M', loaded: true, vram: 5.6 * GB },
    { name: 'qwen3:8b', size: 5.2 * GB, family: 'qwen3', params: '8.2B', quant: 'Q4_K_M', loaded: false, vram: null },
    { name: 'gemma3:4b', size: 3.3 * GB, family: 'gemma3', params: '4.3B', quant: 'Q4_K_M', loaded: false, vram: null },
    { name: 'nomic-embed-text:latest', size: 274 * 1e6, family: 'nomic-bert', params: '137M', quant: 'F16', loaded: false, vram: null },
  ];

  const bootTime = Date.now() - (12 * 86400 + 5 * 3600 + 17 * 60) * 1000;

  function gpu() {
    const used = models.filter((m) => m.loaded).reduce((s, m) => s + (m.vram || 0), 0) + 0.4 * GB;
    return [{ name: 'NVIDIA GeForce RTX 3060 Ti', util: Math.round(rnd(2, 14)), memUsed: used, memTotal: 8 * GB,
      temp: Math.round(rnd(41, 47)), power: Math.round(rnd(18, 34)) }];
  }

  function overview() {
    const used = rnd(15.2, 16.6) * GB;
    return {
      hostname: 'Freddy', uptime: Math.round((Date.now() - bootTime) / 1000), version: 'Debian GNU/Linux 13 (trixie)',
      cpu: { brand: 'AMD Ryzen 7 5700X 8-Core Processor', cores: 8, threads: 16, percent: Math.round(rnd(6, 22)) },
      memory: { total: 32 * GB, used, zfsCache: 6 * GB, percent: Math.round((used / (32 * GB)) * 1000) / 10 },
      storage: storageSummary(), gpu: gpu(),
    };
  }

  const logLines = (name) => {
    const now = Date.now();
    const msgs = [
      'Starting ' + name + '…', 'Loaded configuration from /config', 'Listening on 0.0.0.0',
      'Health check passed', 'Scheduled task finished in 412 ms', 'Connected to database', 'Health check passed',
    ];
    return msgs.map((m, i) => ({ timestamp: new Date(now - (msgs.length - i) * 61000).toISOString(), message: m }));
  };

  async function get(path) {
    await wait(rnd(120, 300));
    if (path === '/api/config') return { demo: true, needsLogin: false, ollama: true, language: demoLang(), clock: demoClock(), onboarding: !onbDone(), setup: !onbDone(), loginUser: true };
    if (path === '/api/storage-paths') return spGet();
    if (path === '/api/backup' || path === '/api/backup?brief=1') return bkGet(path.endsWith('brief=1'));
    const bkb = path.match(/^\/api\/backup\/remotes\/([^/]+)\/browse\?path=(.*)$/);
    if (bkb) { await wait(rnd(300, 700)); return bkBrowse(decodeURIComponent(bkb[1]), decodeURIComponent(bkb[2])); }
    const bkl = path.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})\/log$/);
    if (bkl) {
      if (!bkJobs.some((j) => j.id === bkl[1])) throw err('Deze taak bestaat niet (meer).', 404);
      const running = bkInfo(bkl[1]), j = bkJobs.find((x) => x.id === bkl[1]);
      const t0 = new Date().toISOString(), live = bkLive[bkl[1]];
      const lines = running ? live.lines.concat(Array.from({ length: Math.min(12, running.files) }, (_, i) => ({ time: t0, level: live.dryRun ? 'notice' : 'info', text: `2026/IMG_${4100 + i}.HEIC: ${live.dryRun ? 'Skipped copy as --dry-run is set' : 'Copied (new)'}` })))
        : bkLogs[bkl[1]] || [];
      return { running, lines: copy(lines), last: (j.history || [])[0] || null };
    }
    if (path === '/api/storage-paths/migration') return { migration: spMigration() };
    if (path === '/api/settings') return { language: demoLang(), clock: demoClock(), ...demoSecurity };
    if (path === '/api/datetime') return dtGet();
    if (path === '/api/update') return updGet();
    if (path === '/api/onboarding') return onbGet();
    if (path === '/api/update/progress') return updProgress();
    if (path === '/api/mfa') return { enabled: mfa.enabled, since: mfa.since, recoveryLeft: mfa.recovery.length, available: true, demoPassword: DEMO_PW, passwordChanged: onb.passwordChanged };
    if (path === '/api/about') return demoAbout();
    if (path === '/api/network') { tickNet(); return copy(net); }
    if (path === '/api/docker-networks') return dnetList();
    if (path === '/api/layout') return copy(layout);
    if (path === '/api/shares') return sharesGet();
    if (path === '/api/overview') return overview();
    if (path === '/api/apps') {
      return apps.map((a) => { const o = appOvr[a.name] || {}; return { ...copy(a), webui: o.webui ? resolvePorts(o.webui, a.ports) : a.webui, icon: o.icon || a.icon }; });
    }
    const ms = path.match(/^\/api\/apps\/([^/]+)\/settings$/);
    if (ms) {
      const a = findApp(ms[1]), o = appOvr[a.name] || {};
      return { name: a.name, image: a.image, ports: copy(a.ports), restartPolicy: a.autoStart ? 'unless-stopped' : 'no', autoStart: a.autoStart,
        webui: o.webui || '', webuiDefault: '', webuiAuto: a.webui, icon: o.icon || '', iconDefault: a.icon || '',
        compose: a.compose ? { project: a.compose, files: ['/opt/stacks/' + a.compose + '/compose.yaml'], file: '/opt/stacks/' + a.compose + '/compose.yaml',
          workingDir: '/opt/stacks/' + a.compose, editable: true, service: a.name, text: composeText[a.compose] || demoCompose(a), form: demoForm(a),
          dockerNetworks: dnets.filter((n) => !n.builtin).map((n) => ({ name: n.name, driver: n.driver, subnet: n.subnet })).sort((x, y) => x.name.localeCompare(y.name)) } : null };
    }
    let m = path.match(/^\/api\/apps\/([^/]+)\/logs/);
    if (m) { const a = apps.find((x) => x.id === decodeURIComponent(m[1])); return a ? logLines(a.name) : []; }
    if (path === '/api/vms') return vms.map(vmOut).sort((a, b) => a.name.localeCompare(b.name));
    if (path === '/api/vm-options') return vmOptions();
    if (path === '/api/vm-networks') return vmNetList();
    m = path.match(/^\/api\/vms\/([^/]+)$/);
    if (m) {
      const v = findVm(m[1]);
      const i = vms.indexOf(v), s = slug(v.name);
      const h = hwOf(v);
      const dks = v.disks || [{ target: 'vda', size: v.diskGb * GB }];
      return { ...vmOut(v), firmware: 'uefi', vnc: { port: isOn(v) ? 5900 + i : null, password: VNC_PW[v.name] || 'Demo1234' },
        disks: dks.map((k, n) => ({ target: k.target, bus: k.target.startsWith('vd') ? 'virtio' : 'sata', format: 'qcow2',
          source: k.file || '/tank/vms/' + s + '/' + s + (n ? '-' + (n + 1) : '') + '.qcow2', size: k.size, used: k.size * (n ? 0.02 : 0.31) })),
        cdroms: h.cdrom ? [h.cdrom] : [], cdromDrive: !!h.cdrom || v.name === 'Windows 11',
        nics: copy(h.nics), boot: h.boot, hostdevs: [...h.hostdevs], cpuPins: [...h.cpuPins], clipboard: !!h.clipboard };
    }
    if (path === '/api/store' || path === '/api/store?refresh=1') {
      if (path.endsWith('refresh=1')) await wait(900);
      const used = new Set(store.flatMap((a) => a.categories));
      return { updated: Date.now() - 86400000, fetched: Date.now(), error: null, source: 'Unraid Community Apps (demo: 16 voorbeelden)', count: store.length,
        categories: Object.entries(CATS_NL).filter(([k]) => used.has(k)).map(([id, name]) => ({ id, name })),
        apps: store.map((a) => ({ id: a.id, name: a.name, image: a.image, icon: a.icon, summary: a.summary, categories: a.categories, maintainer: a.maintainer,
          popularity: a.popularity, featured: a.featured, official: a.official, beta: a.beta, installed: storeInstalled(a) })) };
    }
    m = path.match(/^\/api\/store\/apps\/([0-9a-f]{12})$/);
    if (m) { const a = store.find((x) => x.id === m[1]); if (!a) throw err('Deze app staat niet (meer) in de catalogus.', 404); return storeDetails(a); }
    m = path.match(/^\/api\/store\/jobs\/(\w+)$/);
    if (m) return storeJob(m[1]);
    if (path === '/api/pools/options') return poolOptions();
    const dk = path.match(/^\/api\/disks\/([^/?]+)(\?wake=1)?$/);
    if (dk) { await wait(rnd(250, 600)); return demoDisk(decodeURIComponent(dk[1]), !!dk[2]); }
    if (path === '/api/storage') return { ...storageSummary(), zfsError: null, pools: copy(pools), disks: copy(disks), datasets: copy(datasets), bays: copy(bays) };
    if (path === '/api/ai') return { version: '0.13.4', gpu: gpu(), models: copy(models) };
    throw err('Onbekend endpoint', 404);
  }

  async function post(path, body = {}) {
    if (path === '/api/login' || path === '/api/login/mfa' || path.startsWith('/api/mfa/')) { await wait(rnd(150, 300)); return authPost(path, body); }
    if (path === '/api/datetime') { await wait(rnd(300, 600)); return dtSet(body); }
    if (path === '/api/onboarding/finish') { onbSet(true); return { done: true, finished: new Date().toISOString(), skipped: !!body.skipped }; }
    if (path === '/api/onboarding/reset') { onbSet(false); return { done: false }; }
    if (path === '/api/password') { await wait(rnd(300, 600)); return demoPassword(body); }
    if (path === '/api/setup') { await wait(rnd(300, 600)); return demoSetup(body); }
    if (path === '/api/storage-paths') { await wait(rnd(300, 600)); return spSet(body); }
    if (path.startsWith('/api/backup/')) { await wait(rnd(200, 500)); return bkPost(path, body); }
    if (path === '/api/update/install') {
      const g = updGet();
      if (g.running) throw err('Er loopt al een update.', 409);
      if (!g.newer.some((r) => r.version === body.version)) throw err('Deze versie is niet (meer) beschikbaar. Zoek eerst opnieuw naar updates.', 404);
      upd.job = { start: Date.now(), version: body.version, from: g.current };
      return { started: true, version: body.version };
    }
    if (path === '/api/update/check') { await wait(rnd(600, 1200)); upd.checked = new Date().toISOString(); return updGet(); }
    if (path === '/api/settings' && (body.updateCheck != null || body.updateChannel != null)) {
      if (body.updateCheck != null) upd.auto = !!body.updateCheck;
      if (body.updateChannel != null) { if (!['stable', 'beta'].includes(body.updateChannel)) throw err('Kies stabiel of bèta.'); upd.channel = body.updateChannel; }
      return { language: demoLang(), clock: demoClock(), ...demoSecurity, updateCheck: upd.auto, updateChannel: upd.channel };
    }
    if (path === '/api/settings' && body.clock != null) {
      if (!['auto', '24', '12'].includes(String(body.clock))) throw err('Kies een tijdnotatie: automatisch, 24 uur of 12 uur.');
      try { localStorage.setItem('tb-clock', String(body.clock)); } catch (e) { /* privévenster */ }
      return { language: demoLang(), clock: String(body.clock), ...demoSecurity };
    }
    if (path === '/api/settings' && body.language == null) {
      // In de demo is er geen wachtwoord (zoals de server zonder APP_PASSWORD): minder streng maken mag zonder.
      Object.assign(demoSecurity, { terminal: body.terminal == null ? demoSecurity.terminal : !!body.terminal,
        terminalPassword: body.terminalPassword == null ? demoSecurity.terminalPassword : !!body.terminalPassword });
      return { language: demoLang(), ...demoSecurity };
    }
    if (path === '/api/settings') {
      if (!['nl', 'en'].includes(body.language)) throw err('Onbekende taal.');
      try { localStorage.setItem('tb-lang', body.language); } catch (e) { /* privévenster */ }
      return { language: body.language };
    }
    if (path.startsWith('/api/network')) { await wait(rnd(300, 700)); return demoNetPost(path, body); }
    if (path === '/api/docker-networks') { await wait(rnd(300, 700)); return dnetCreate(body); }
    if (path === '/api/vm-networks') { await wait(rnd(400, 800)); return vmNetCreate(body); }
    if (path === '/api/bays') return saveBays(body);
    if (path === '/api/layout') return saveLayout(body);
    if (path === '/api/shares') { await wait(rnd(400, 800)); return shareSave(body, null); }
    const shm = path.match(/^\/api\/shares\/([^/]+)$/);
    if (shm) { await wait(rnd(300, 600)); return shareSave(body, decodeURIComponent(shm[1])); }
    if (path === '/api/share-users') { await wait(rnd(300, 600)); return shareUserCreate(body); }
    const pwm = path.match(/^\/api\/share-users\/([^/]+)\/password$/);
    if (pwm) { if (String(body.password || '').length < 8) throw err('Kies een wachtwoord van minstens 8 tekens.'); return { ok: true }; }
    if (path === '/api/apps/custom/inspect') { await wait(rnd(500, 900)); return demoInspect(body.image); }
    if (path === '/api/apps/custom') { await wait(rnd(300, 600)); return demoInstallCustom(body); }
    const dt = path.match(/^\/api\/disks\/([^/]+)\/test$/);
    if (dt) return demoDiskTest(decodeURIComponent(dt[1]), body.type);
    if (path === '/api/pools') { await wait(rnd(1500, 2200)); return demoCreatePool(body); }
    const vs = path.match(/^\/api\/vm-networks\/([^/]+)\/start$/);
    if (vs) { const n = vmNets.find((x) => x.name === decodeURIComponent(vs[1])); if (!n) throw err('Dit VM-netwerk bestaat niet (meer).', 404); n.active = true; return { ok: true }; }
    if (/\/exec$/.test(path)) { await wait(rnd(60, 180)); return demoExec(findApp(path.split('/')[3]), String(body.cmd || ''), body.cwd || '/'); }
    await wait(rnd(500, 1100));
    let mm = path.match(/^\/api\/apps\/([^/]+)\/settings$/);
    if (mm) {
      const a = findApp(mm[1]);
      const w = String(body.webui || '').trim(), ic = String(body.icon || '').trim();
      if (w && !/^(https?:\/\/|\[IP\])/i.test(w)) throw err('Het adres van de webinterface moet beginnen met http:// of https://, bv. http://[IP]:[PORT:8080]/');
      if (ic && !/^https?:\/\//i.test(ic)) throw err('Het pictogram moet een adres zijn dat begint met http:// of https://.');
      appOvr[a.name] = { ...(w ? { webui: w } : {}), ...(ic ? { icon: ic } : {}) };
      a.autoStart = !!body.autoStart;
      return { ok: true };
    }
    mm = path.match(/^\/api\/apps\/([^/]+)\/compose-form$/);
    if (mm) {
      const a = findApp(mm[1]), f = body.form || {};
      if (!String(f.image || '').trim()) throw err('Vul het image in, bv. lscr.io/linuxserver/jellyfin:latest.');
      for (const p of f.ports || []) if (!p.locked && !/^\d{1,5}$/.test(String(p.container).trim())) throw err('Poort in de app "' + p.container + '" is geen geldige poort.');
      for (const v of f.volumes || []) if (!v.locked && !String(v.container).startsWith('/')) throw err('De map in de app "' + v.container + '" moet met / beginnen.');
      for (const d of f.devices || []) if (!/^\/dev\/\S+$/.test(String(d.host).trim())) throw err('Een apparaat begint met /dev/, bv. /dev/dri.');
      const names = (f.env || []).map((e) => e.name).filter(Boolean);
      const dup = names.find((n, i) => names.indexOf(n) !== i); if (dup) throw err('De variabele ' + dup + ' staat er twee keer in.');
      const ip = String(f.ip || '').trim();
      const wasOwn = appNet[a.name] && ownIpNet(appNet[a.name].net);
      if (f.network !== '*') setAppNet(a, f.network, ip);
      await wait(900);
      const { otherServices, ...keep } = f;
      formState[a.name] = { ...keep, ip: appNet[a.name] ? appNet[a.name].ip : '', env: (f.env || []).filter((e) => e.name), labels: (f.labels || []).filter((e) => e.name) };
      a.image = f.image.trim();
      const own = appNet[a.name] && ownIpNet(appNet[a.name].net);
      a.ports = f.network === 'host' || own ? [] : (f.ports || []).filter((p) => p.host).map((p) => ({ public: Number(p.host), private: Number(p.container), type: p.protocol.toUpperCase() }));
      if (own) { const c = (f.ports || [])[0]; a.webui = 'http://' + appNet[a.name].ip + (c ? ':' + c.container : '') + '/'; }
      else if (wasOwn) a.webui = a.ports[0] ? 'http://[IP]:' + a.ports[0].public + '/' : null;
      else if (/^(:?\d+|\d+\.\d+\.\d+\.\d+(:\d+)?)$/.test(String(a.webui || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').split(':').slice(-1)[0]) && a.ports[0]) a.webui = 'http://[IP]:' + a.ports[0].public + '/';
      delete composeText[a.compose]; a.state = 'RUNNING'; a.status = 'Up minder dan een minuut';
      return { ok: true, backup: '/opt/stacks/' + a.compose + '/compose.yaml.bak' };
    }
    mm = path.match(/^\/api\/apps\/([^/]+)\/compose$/);
    if (mm) {
      const a = findApp(mm[1]);
      if (!/^services:/m.test(body.text || '')) throw err('Het compose-bestand klopt niet: services ontbreekt.');
      await wait(800);
      composeText[a.compose] = body.text; a.state = 'RUNNING'; a.status = 'Up minder dan een minuut';
      return { ok: true, backup: '/opt/stacks/' + a.compose + '/compose.yaml.bak' };
    }
    if (path === '/api/apps/check-updates') {
      await wait(1200);
      apps.forEach((a) => { a.updateChecked = Date.now(); });
      return { checked: apps.length, updates: apps.filter((a) => a.update).length, errors: [] };
    }
    let m = path.match(/^\/api\/apps\/([^/]+)\/(start|stop|restart|update)$/);
    if (m) {
      const a = apps.find((x) => x.id === decodeURIComponent(m[1]));
      if (!a) throw err('Container niet gevonden', 404);
      if (m[2] === 'stop') { a.state = 'EXITED'; a.status = 'Exited (0) zojuist'; }
      else { a.state = 'RUNNING'; a.status = 'Up minder dan een minuut'; }
      if (m[2] === 'update') { await wait(800); a.update = false; a.updateChecked = Date.now(); }
      return { ok: true };
    }
    m = path.match(/^\/api\/store\/apps\/([0-9a-f]{12})\/install$/);
    if (m) { const a = store.find((x) => x.id === m[1]); if (!a) throw err('Deze app staat niet (meer) in de catalogus.', 404); return storeInstall(a, body); }
    if (path === '/api/vms') {
      const name = String(body.name || '').trim();
      checkFields({ ...body, name });
      if (vms.some((v) => v.name === name)) throw err('Er bestaat al een VM met de naam ' + name + '.', 409);
      const opts = vmOptions();
      if (!(body.kind === 'import' ? opts.images : opts.isos).some((f) => f.name === body.source)) throw err('Kies een bestand uit /tank/isos.');
      const [ntype, nsrc] = String(body.network || opts.network).split(':');
      if (!(ntype === 'network' ? opts.networks : ntype === 'bridge' ? opts.bridges : []).some((x) => x.name === nsrc)) throw err('Kies een netwerk voor de VM.');
      await wait(1200);
      vms.push({ name, state: 'RUNNING', vcpus: body.vcpus, memory: Math.round(body.memoryGb * 1024) * 1048576, diskGb: body.diskGb || 32,
        autostart: !!body.autostart, delay: body.autostart ? body.delay || 0 : 0, description: String(body.description || '').trim(),
        base: [20, 60], ram: [0.2, 0.35] });
      vmHw[name] = { nics: [nic(ntype, nsrc, body.kind === 'windows' ? 'e1000e' : 'virtio', '52:54:00:' + [0, 0, 0].map(() => Math.floor(rnd(16, 255)).toString(16)).join(':'))],
        extra: [], cdrom: body.kind === 'import' ? null : '/tank/isos/' + body.source, boot: body.kind === 'import' ? 'disk' : 'cdrom', hostdevs: [], cpuPins: [] };
      return { name, disk: '/tank/vms/' + slug(name) + '/' + slug(name) + '.qcow2' };
    }
    m = path.match(/^\/api\/vms\/([^/]+)\/settings$/);
    if (m) {
      const v = findVm(m[1]);
      const newName = body.name != null ? String(body.name).trim() : v.name;
      // Met vaste kernen volgt het aantal vCPU's daaruit (het veld is dan uitgeschakeld en wordt niet meegestuurd).
      if (Array.isArray(body.cpuPins) && body.cpuPins.length) body.vcpus = body.cpuPins.length; else if (body.vcpus == null) body.vcpus = v.vcpus;
      checkFields({ ...body, name: newName });
      if (newName !== v.name && v.state !== 'SHUTOFF') throw err('Zet de VM eerst uit om de naam te wijzigen.', 409);
      if (newName !== v.name && vms.some((x) => x.name === newName)) throw err('Er bestaat al een VM met de naam ' + newName + '.', 409);
      const memory = Math.round(body.memoryGb * 1024) * 1048576;
      const hwChanged = demoSaveHw(v, body);
      const restartNeeded = v.state !== 'SHUTOFF' && (hwChanged || body.vcpus !== v.vcpus || memory !== v.memory);
      if (newName !== v.name) { VNC_PW[newName] = VNC_PW[v.name]; vmHw[newName] = hwOf(v); v.name = newName; }
      Object.assign(v, { vcpus: body.vcpus, memory, description: String(body.description || '').trim(),
        autostart: !!body.autostart, delay: body.autostart ? body.delay || 0 : v.delay });
      return { name: v.name, restartNeeded };
    }
    m = path.match(/^\/api\/vms\/([^/]+)\/(start|stop|reboot|pause|resume|force-stop|reset)$/);
    if (m) {
      const v = findVm(m[1]);
      if (m[2] === 'start' || m[2] === 'force-stop') v.startsAt = null;
      v.state = m[2] === 'stop' || m[2] === 'force-stop' ? 'SHUTOFF' : m[2] === 'pause' ? 'PAUSED' : 'RUNNING';
      return { ok: true };
    }
    m = path.match(/^\/api\/ai\/models\/(.+)\/(load|unload)$/);
    if (m) {
      const md = models.find((x) => x.name === decodeURIComponent(m[1]));
      if (m[2] === 'load') { models.forEach((x) => { x.loaded = false; x.vram = null; }); md.loaded = true; md.vram = md.size * 1.15; }
      else { md.loaded = false; md.vram = null; }
      return { ok: true };
    }
    if (path === '/api/logout') return { ok: true };
    throw err('Onbekend endpoint', 404);
  }

  async function del(path) {
    await wait(400);
    let m = path.match(/^\/api\/apps\/([^/?]+)(\?data=1)?$/);
    if (m) {
      const i = apps.findIndex((x) => x.id === decodeURIComponent(m[1]));
      if (i < 0) throw err('Deze app bestaat niet (meer).', 404);
      if (!apps[i].storeId && !apps[i].custom) throw err('Alleen apps uit de appstore of eigen apps van HomeBaseOS kan je hier verwijderen. Verwijder andere apps via hun eigen compose-bestand.', 400);
      const [a] = apps.splice(i, 1);
      return { removed: m[2] ? a.dataDirs : [], kept: [] };
    }
    m = path.match(/^\/api\/vms\/([^/?]+)(\?disks=1)?$/);
    if (m) {
      const v = findVm(m[1]);
      if (v.state !== 'SHUTOFF') throw err('Zet de VM eerst uit. Daarna kan je hem verwijderen.', 409);
      vms.splice(vms.indexOf(v), 1);
      const s = slug(v.name);
      return { removed: m[2] ? ['/tank/vms/' + s + '/' + s + '.qcow2'] : [], kept: [] };
    }
    m = path.match(/^\/api\/docker-networks\/([^/]+)$/);
    if (m) return dnetDelete(decodeURIComponent(m[1]));
    m = path.match(/^\/api\/vm-networks\/([^/]+)$/);
    if (m) return vmNetDelete(decodeURIComponent(m[1]));
    if (path.startsWith('/api/backup/')) { const r = bkDel(path); if (r) return r; }
    m = path.match(/^\/api\/shares\/([^/]+)$/);
    if (m) { const i = shareList.findIndex((x) => x.name === decodeURIComponent(m[1])); if (i < 0) throw err('Deze gedeelde map bestaat niet (meer).', 404); shareList.splice(i, 1); return { removed: decodeURIComponent(m[1]) }; }
    m = path.match(/^\/api\/share-users\/([^/]+)$/);
    if (m) return shareUserDelete(decodeURIComponent(m[1]));
    m = path.match(/^\/api\/ai\/models\/(.+)$/);
    if (m) { const i = models.findIndex((x) => x.name === decodeURIComponent(m[1])); if (i >= 0) models.splice(i, 1); return { ok: true }; }
    throw err('Onbekend endpoint', 404);
  }

  async function stream(path, body, onLine) {
    if (path === '/api/ai/pull') {
      const total = rnd(1.8, 4.6) * GB;
      onLine({ status: 'pulling manifest' });
      await wait(500);
      for (let done = 0; done < total; done += total / 40) {
        onLine({ status: 'downloaden', total, completed: Math.min(done, total) });
        await wait(110);
      }
      onLine({ status: 'verifying sha256 digest' }); await wait(400);
      onLine({ status: 'success' });
      if (!models.find((x) => x.name === body.name)) {
        models.push({ name: body.name.includes(':') ? body.name : body.name + ':latest', size: total, family: body.name.split(/[:/]/)[0],
          params: '?', quant: 'Q4_K_M', loaded: false, vram: null });
      }
      return;
    }
    if (path === '/api/ai/chat') {
      const q = (body.messages[body.messages.length - 1] || {}).content || '';
      const reply = 'Dit is de demo-modus, dus ik draai niet echt op je GPU. Op je eigen server zou ' + body.model +
        ' hier antwoorden op: "' + q.slice(0, 80) + (q.length > 80 ? '…' : '') + '". Met een RTX 3060 Ti haal je met een 8B-model ongeveer 60 à 70 tokens per seconde.';
      await wait(350);
      for (const word of reply.split(/(\s+)/)) { onLine({ message: { content: word }, done: false }); await wait(28); }
      onLine({ done: true });
      return;
    }
    throw err('Onbekend endpoint', 404);
  }

  window.HomeBaseOSDemo = { get, post, del, stream, user: () => acct.user };
})();
