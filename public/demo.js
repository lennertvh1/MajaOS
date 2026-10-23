/* Demo adapter: the same endpoints as server.js, but with sample data in the browser. */
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
    ['mosquitto', 'eclipse-mosquitto:2', null, 'running', 'smarthome'],
    ['zigbee2mqtt', 'koenkk/zigbee2mqtt', 8099, 'running', 'smarthome'],
    ['frigate', 'ghcr.io/blakeblackshear/frigate:stable', 5000, 'running', 'frigate'],
    ['whisper', 'rhasspy/wyoming-whisper', null, 'running', 'smarthome'],
    ['piper', 'rhasspy/wyoming-piper', null, 'running', 'smarthome'],
    ['syncthing', 'syncthing/syncthing', 8384, 'running', 'syncthing'],
    ['uptime-kuma', 'louislam/uptime-kuma:1', 3001, 'running', 'monitoring'],
    ['dockge', 'louislam/dockge:1', 5001, 'running', 'dockge'],
    ['pihole', 'pihole/pihole:latest', 8053, 'exited', 'pihole'],
    ['duplicati', 'duplicati/duplicati', 8200, 'running', 'backup'],
    ['qbittorrent', 'linuxserver/qbittorrent', 8085, 'exited', 'media'],
    ['homepage', 'ghcr.io/gethomepage/homepage', 3010, 'running', 'homepage'],
  ];
  // Icons the way the server finds them: from the catalogue or from dashboard-icons (Whisper and Piper aren't in there).
  const ICON = (n) => (n ? 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/' + n + '.png' : null);
  const ICON_NAME = { pihole: 'pi-hole', whisper: null, piper: null };
  // Storage locations (Settings → Storage): app data can move, the rest follows that path.
  const sp = { appdata: '/fast/appdata', vms: '/tank/vms', isos: '/tank/isos', shares: '/tank' };
  const AD = () => sp.appdata;
  const apps = appDefs.map(([name, image, port, state, compose], i) => ({
    id: 'demo:' + name, name, image, state: state.toUpperCase(),
    status: state === 'running' ? 'Up ' + (2 + (i % 9)) + ' days' : 'Exited (0) 3 hours ago',
    autoStart: state === 'running', icon: ICON(name in ICON_NAME ? ICON_NAME[name] : name),
    webui: port ? 'http://[IP]:' + port + '/' : null,
    ports: port ? [{ public: port, private: port, type: 'TCP' }] : [],
    compose, canUpdate: true,
    // As after a check at the registry: four apps have a newer version.
    update: ['immich', 'open-webui', 'zigbee2mqtt', 'qbittorrent'].includes(name), updateChecked: Date.now() - 2 * 3600000, updateError: null,
    // Vaultwarden and Syncthing pretend to come from the app store, so you can try Remove.
    storeId: name === 'vaultwarden' ? 'a1b2c3d4e5f6' : name === 'syncthing' ? 'b2c3d4e5f6a1' : null,
    dataDirs: name === 'vaultwarden' || name === 'syncthing' ? [AD() + '/' + name] : [],
  }));
  // Pi-hole has its own address in the home network (macvlan, see Docker networks below).
  Object.assign(apps.find((a) => a.name === 'pihole'), { webui: 'http://192.168.1.53/admin/', ports: [] });

  /* ---- settings: language, about and network */
  const demoSecurity = { terminal: true, terminalPassword: true };
  /* ---- welcome wizard: remembered per browser whether it is finished */
  const onb = { passwordChanged: null };
  const onbDone = () => { try { return localStorage.getItem('tb-onboarded') === '1'; } catch (e) { return true; } };
  const onbSet = (v) => { try { if (v) localStorage.setItem('tb-onboarded', '1'); else localStorage.removeItem('tb-onboarded'); } catch (e) { /* private window */ } };
  function onbGet() {
    const o = poolOptions();
    return { done: onbDone(), finished: null, skipped: false, hostname: net.hostname, timezone: dt.timezone, passwordChanged: onb.passwordChanged, user: acct.user, mfa: mfa.enabled, appdata: sp.appdata,
      pools: pools.map((x) => ({ name: x.name, total: x.total, health: x.health })),
      freeDisks: o.disks.filter((d) => d.available).map((d) => ({ name: d.name, size: d.size, model: d.model, rotational: d.rotational, transport: d.transport })) };
  }
  function demoPassword(body) {
    if (String(body.current || '') !== DEMO_PW) throw err('Your current password is not correct.', 401);
    const v = String(body.password || '');
    if (v.length < 10) throw err('Choose a password of at least 10 characters.');
    if (v.length > 200) throw err('The password is too long (at most 200 characters).');
    if (/^(.)\1+$/.test(v) || /^(0123456789|1234567890|wachtwoord|password)/i.test(v)) throw err('This password is too easy to guess. Choose another one.');
    onb.passwordChanged = new Date().toISOString(); // in the demo signing in with "demo" keeps working
    return { ok: true, changed: onb.passwordChanged };
  }
  const demoClock = () => { try { return localStorage.getItem('tb-clock') || 'auto'; } catch (e) { return 'auto'; } };

  /* ---- software update: a simulated new version with release notes */
  const upd = { auto: true, channel: 'stable', checked: new Date(Date.now() - 3 * 3600000).toISOString() };
  const demoReleases = [
    { version: '0.4.0-beta.1', name: 'v0.4.0-beta.1', prerelease: true, published: '2026-10-21T09:00:00Z',
      notes: '## For testing\n\n- Take and restore snapshots of VMs\n- **Note:** not yet suitable for daily use' },
    { version: '0.3.0', name: 'Date, time and two-step verification', prerelease: false, published: '2026-10-20T18:00:00Z',
      notes: '## New\n\n- **Sign in with two-step verification** (TOTP) with recovery codes\n- Set date, time and time zone in *Settings > General*\n- Time format: 24 or 12 hour\n\n## Improved\n\n- Faster list of apps\n- The console remembers the window size\n\n## Fixed\n\n- A share without users gave an error when saving\n\n**Full list**: https://github.com/lennertvh1/homebaseos/compare/v0.2.0...v0.3.0' },
    { version: '0.2.0', name: 'v0.2.0', prerelease: false, published: '2026-10-01T12:00:00Z',
      notes: '## New\n\n- App store with the Unraid Community Apps catalogue\n- Disk bays, ZFS pools and shared folders\n- Terminal on the server' },
  ].map((r) => ({ ...r, url: 'https://github.com/lennertvh1/homebaseos/releases/tag/v' + r.version }));
  // Channel dev, like devSummary() in lib/release.js: the newest commit of the dev branch.
  const DEV_HEAD = { sha: 'c0ffee15deadbeef0123456789abcdef01234567', version: '0.6.0', date: new Date(Date.now() - 3 * 3600000).toISOString(),
    commits: [['c0ffee15deadbeef0123456789abcdef01234567', 'Apps: progress bar while installing'], ['b4d5e6f70123456789abcdef0123456789abcdef', 'Translate the whole project to English']] };
  function updDev() {
    const cur = upd.current || '0.2.0', short = DEV_HEAD.sha.slice(0, 7);
    const latest = { version: DEV_HEAD.version + '+dev.' + short, tag: DEV_HEAD.sha, commit: DEV_HEAD.sha, pkgVersion: DEV_HEAD.version, dev: true, prerelease: true,
      name: DEV_HEAD.commits[0][1], notes: DEV_HEAD.commits.map(([h, m]) => `- ${m} (${h.slice(0, 7)})`).join('\n'),
      url: 'https://github.com/lennertvh1/homebaseos/commit/' + DEV_HEAD.sha, published: DEV_HEAD.date };
    const updateAvailable = !upd.build || upd.build.commit !== DEV_HEAD.sha;
    return { repo: 'lennertvh1/homebaseos', token: true, auto: upd.auto, channel: 'dev', branch: 'dev', checked: upd.checked, error: null, current: cur, build: upd.build || null,
      latest, updateAvailable, newer: updateAvailable ? [latest] : [], installed: updateAvailable ? null : latest, history: [],
      install: { ok: true, reason: null }, running: !!(upd.job && !upd.job.finished) };
  }
  function updGet() {
    if (upd.channel === 'dev') return updDev();
    const list = demoReleases.filter((r) => upd.channel === 'beta' || !r.prerelease), cur = upd.current || '0.2.0';
    const i = Math.max(0, list.findIndex((r) => r.version === cur)), newer = list.slice(0, i);
    return { repo: 'lennertvh1/homebaseos', token: true, auto: upd.auto, channel: upd.channel, checked: upd.checked, error: null, current: cur,
      build: upd.build || null, latest: list[0], updateAvailable: newer.length > 0, newer, installed: list[i] || null, history: list.slice(i),
      install: { ok: true, reason: null }, running: !!(upd.job && !upd.job.finished) };
  }
  // Update now, simulated: the same steps as lib/updater.js + lib/update-helper.sh, with a restart during which the server is briefly gone.
  const UPD_PLAN = [[0, 'download', 2], [4000, 'extract', 42, 'Unpacking…'], [5000, 'verify', 50, 'Verifying the new version…'],
    [6500, 'handover', 56, 'Ready to install…'], [7000, 'backup', 60, 'Backing up version {from}…'],
    [8500, 'install', 68, 'Installing new files…'], [10000, 'restart', 85, 'Restarting HomeBaseOS…'],
    [13500, 'check', 92, 'Checking that version {version} runs properly…'], [15500, 'done', 100, 'Updated to version {version}.']];
  function updProgress() {
    const j = upd.job; if (!j) return { state: 'idle' };
    const ms = Date.now() - j.start;
    if (ms > 10500 && ms < 13500) throw err('Failed to fetch', 503); // the server restarts
    const [, step, pct, msg] = UPD_PLAN.filter((x) => x[0] <= ms).pop();
    const fill = (m) => m.replace('{from}', j.from).replace('{version}', j.version);
    const out = { state: step === 'done' ? 'done' : 'running', step, percent: pct, version: j.version, from: j.from, message: fill(msg || 'Downloading version {version}…') };
    if (step === 'download') { const total = 1.9 * 1024 * 1024; out.bytes = Math.round(total * Math.min(1, ms / 4000)); out.total = total; out.percent = Math.round(2 + 38 * out.bytes / total); }
    if (step === 'done' && !j.finished) {
      j.finished = true;
      const dev = String(j.version).match(/^(.+)\+dev\.([0-9a-f]+)$/);
      if (dev) { upd.current = dev[1]; upd.build = { branch: 'dev', commit: DEV_HEAD.sha, date: DEV_HEAD.date }; } else { upd.current = j.version; upd.build = null; }
    }
    return out;
  }

  /* ---- date and time (like timedatectl): offset = difference with the browser's clock */
  const dt = { timezone: 'Europe/Brussels', ntp: true, servers: [], offset: 0 };
  const DEFAULT_NTP = ['0.debian.pool.ntp.org', '1.debian.pool.ntp.org', '2.debian.pool.ntp.org', '3.debian.pool.ntp.org'];
  let zones = null;
  const demoZones = () => zones || (zones = (() => { try { return Intl.supportedValuesOf('timeZone').concat('UTC').sort(); } catch (e) { return ['Europe/Brussels', 'UTC']; } })());
  function dtGet() {
    return { now: Date.now() + dt.offset, timezone: dt.timezone, ntp: dt.ntp, ntpAvailable: true, synced: dt.ntp, localRtc: false,
      server: dt.ntp ? (dt.servers[0] || DEFAULT_NTP[0]) : null, servers: dt.servers.slice(), defaultServers: DEFAULT_NTP, editable: true, timezones: demoZones() };
  }
  function dtSet(body) {
    if (body.timezone != null && !demoZones().includes(body.timezone)) throw err('Choose a time zone from the list.');
    let servers = dt.servers;
    if (body.servers != null) {
      servers = [...new Set(String(body.servers).split(/[\s,;]+/).filter(Boolean))];
      if (servers.length > 6) throw err('Enter at most 6 time servers.');
      const bad = servers.find((h) => !/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(h) || h.includes('..'));
      if (bad) throw err('"' + bad + '" is not a valid time server. Use a name like be.pool.ntp.org or an IP address.');
    }
    const ntp = body.ntp == null ? dt.ntp : !!body.ntp;
    let offset = ntp ? 0 : dt.offset;
    if (body.time) {
      if (ntp) throw err('Turn off automatic time first to set the time yourself.', 409);
      const m = String(body.time).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (!m) throw err('Enter a valid date and time.');
      // The entered time applies in the server's time zone: work out the difference with that time zone.
      const tz = body.timezone || dt.timezone, guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)).map((x) => [x.type, +x.value || x.value]));
      const tzOff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess;
      offset = guess - tzOff - Date.now();
    }
    Object.assign(dt, { timezone: body.timezone || dt.timezone, servers, ntp, offset });
    return dtGet();
  }

  /* ---- sign-in with two-step verification: real TOTP codes (RFC 6238), so you can try it with your own authenticator app.
     Password in the demo: demo. Everything stays in the memory of this tab. */
  const DEMO_PW = 'demo';
  /* ---- account: the demo starts like a new server (create an account in the welcome wizard) */
  const acct = { user: (() => { try { return localStorage.getItem('tb-demo-user') || 'demo'; } catch (e) { return 'demo'; } })(), password: null };
  function demoSetup(b) {
    if (onbDone()) throw err('There is already an account. Sign in.', 409);
    const u = String(b.user || '').trim().toLowerCase(), v = String(b.password || '');
    if (!/^[a-z][a-z0-9._-]{1,31}$/.test(u)) throw err('Choose a user name of 2 to 32 characters: lowercase letters, digits, dot, - or _, starting with a letter.');
    if (v !== String(b.repeat || '')) throw err('The two passwords do not match.');
    if (v.length < 10) throw err('Choose a password of at least 10 characters.');
    if (/^(.)\1+$/.test(v) || /^(0123456789|1234567890|wachtwoord|password)/i.test(v)) throw err('This password is too easy to guess. Choose another one.');
    acct.user = u; acct.password = v; // the password only in memory; "demo" keeps working too
    try { localStorage.setItem('tb-demo-user', u); } catch (e) { /* private window */ }
    if (b.language) { try { localStorage.setItem('tb-lang', b.language); } catch (e) { /* private window */ } }
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
      if (!pwOk || String(body.user || '').trim().toLowerCase() !== acct.user) { await wait(800); throw err('Wrong user name or password', 401); }
      if (mfa.enabled) { mfa.pending = { id: Math.random().toString(36).slice(2), until: Date.now() + 300000, tries: 0 }; return { mfa: true, pending: mfa.pending.id }; }
      return { ok: true };
    }
    if (path === '/api/login/mfa') {
      const p = mfa.pending;
      if (!p || p.id !== body.pending || p.until < Date.now()) throw Object.assign(err('Your sign-in expired. Type your password again.', 401), { expired: true });
      const r = await mfaCheck(body.code);
      if (!r.ok) { if (++p.tries >= 5) mfa.pending = null; await wait(800); throw err('That code is not correct.', 401); }
      mfa.pending = null;
      return { ok: true, recovery: !!r.recovery, recoveryLeft: r.recoveryLeft };
    }
    const action = path.slice('/api/mfa/'.length);
    if (action === 'enable') {
      if (!mfa.setup) throw err('Linking took too long. Start again.', 410);
      const ctr = await totpCheck(mfa.setup, body.code);
      if (ctr == null) throw err('That code is not correct. Check the clock on your phone and type the code the app shows now.');
      const codes = newCodes();
      Object.assign(mfa, { enabled: true, secret: mfa.setup, setup: null, recovery: codes.slice(), lastCounter: ctr, since: new Date().toISOString() });
      return { recovery: codes };
    }
    if (String(body.password || '') !== DEMO_PW) { await wait(800); throw err('Wrong password', 401); }
    if (action === 'setup') {
      if (mfa.enabled) throw err('Two-step verification is already on. Turn it off first to link again.', 409);
      mfa.setup = b32enc(crypto.getRandomValues(new Uint8Array(20)));
      return { secret: mfa.setup, uri: `otpauth://totp/HomeBaseOS:freddy?secret=${mfa.setup}&issuer=HomeBaseOS&algorithm=SHA1&digits=6&period=30` };
    }
    if (!(await mfaCheck(body.code)).ok) { await wait(800); throw err('That code is not correct.', 401); }
    if (action === 'disable') { Object.assign(mfa, { enabled: false, secret: null, recovery: [], lastCounter: -1, since: null }); return { ok: true }; }
    if (action === 'recovery') { mfa.recovery = newCodes(); return { recovery: mfa.recovery.slice() }; }
    throw err('Unknown endpoint', 404);
  }
  const demoLang = () => { try { return localStorage.getItem('tb-lang') || 'en'; } catch (e) { return 'en'; } };
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
      if (!/^(?=.{1,63}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(h)) throw err('A hostname consists of letters, digits and -, and is at most 63 characters long.');
      net.hostname = h; return { hostname: h };
    }
    if (path === '/api/network/confirm' || path === '/api/network/revert') {
      if (!net.pending) throw err('No network settings are waiting for confirmation.', 409);
      if (path.endsWith('revert')) Object.assign(net, JSON.parse(netBackup));
      net.pending = null; return { ok: true };
    }
    if (net.pending) throw err('New network settings are already waiting for confirmation.', 409);
    const ip = /^(\d{1,3}\.){3}\d{1,3}$/;
    let address = null;
    if (body.mode === 'static') {
      const [a, pre] = String(body.address || '').split('/');
      if (!ip.test(a) || !(Number(pre) >= 8 && Number(pre) <= 32)) throw err('Fill in the IP address with the netmask length, e.g. 192.168.1.10/24.');
      if (!ip.test(String(body.gateway || ''))) throw err('Fill in the gateway, usually your router\'s address (e.g. 192.168.1.1).');
      if (a.split('.').slice(0, 3).join('.') !== body.gateway.split('.').slice(0, 3).join('.')) throw err('The gateway is not in the same network as the IP address.');
      const dns = String(body.dns || '').split(/[\s,]+/).filter(Boolean);
      const bad = dns.find((d) => !ip.test(d)); if (bad) throw err('"' + bad + '" is not a valid DNS address.');
      if (!dns.length) throw err('Fill in at least one DNS server, e.g. your router or 1.1.1.1.');
      address = a;
    }
    const { pending, ...rest } = net; netBackup = JSON.stringify(rest);
    net.config = { ...net.config, mode: body.mode, address: body.address, gateway: body.gateway, dns: String(body.dns || '').split(/[\s,]+/).filter(Boolean), bridge: !!body.bridge };
    net.pending = { until: Date.now() + 120000 };
    // In the demo the page stays at the same address, so you can confirm right away.
    return { pending: net.pending, address: null };
  }

  /* ---- Docker networks: pihole has its own address in the home network (macvlan on br0) */
  const dnets = [
    { name: 'bridge', driver: 'bridge', subnet: '172.17.0.0/16', gateway: '172.17.0.1' },
    { name: 'host', driver: 'host' }, { name: 'none', driver: 'null' },
    { name: 'lan', driver: 'macvlan', subnet: '192.168.1.0/24', gateway: '192.168.1.1', ipRange: '192.168.1.192/27', parent: 'br0', ours: true },
    { name: 'proxy', driver: 'bridge', subnet: '172.20.0.0/24', gateway: '172.20.0.1', ours: true },
    { name: 'media_default', driver: 'bridge', subnet: '172.18.0.0/16', gateway: '172.18.0.1', compose: 'media' },
  ].map((n, i) => ({ id: (i + 1).toString(16).padStart(12, 'a'), builtin: ['bridge', 'host', 'none'].includes(n.name), internal: false,
    subnet: null, gateway: null, ipRange: null, parent: null, compose: null, ours: false, created: new Date(Date.now() - 30 * 86400000).toISOString(), ...n }));
  // Which app is in which custom network (the rest is in the default network of its compose project).
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
  // Free address in a network's IP range, the way Docker hands one out.
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
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name)) throw err('Choose a name with letters, digits, -, _ or . (at most 63 characters), e.g. homenet.');
    if (dnets.some((n) => n.name === name)) throw err('A network named ' + name + ' already exists. Choose another name.', 409);
    const driver = String(f.driver || 'bridge'); if (!['bridge', 'macvlan', 'ipvlan'].includes(driver)) throw err('Choose a network type: bridge, macvlan or ipvlan.');
    const own = driver !== 'bridge';
    const st = String(f.subnet || '').trim(), sn = st ? cidr(st) : null;
    if (st && !sn) throw err('"' + st + '" is not a valid subnet. Write it as 192.168.1.0/24.');
    if (own && !sn) throw err('Enter the subnet of your home network, e.g. 192.168.1.0/24.');
    const gw = String(f.gateway || '').trim();
    if (gw && !ip4.test(gw)) throw err('"' + gw + '" is not a valid IP address for the gateway.');
    if (gw && !sn) throw err('Also enter the subnet when you choose a gateway.');
    if (gw && !inCidr(sn, gw)) throw err('The gateway ' + gw + ' is not in the subnet ' + sn.text + '.');
    if (own && !gw) throw err('Fill in the gateway, usually your router\'s address (e.g. 192.168.1.1).');
    const rt = own ? String(f.ipRange || '').trim() : '', rg = rt ? cidr(rt, 8, 32) : null;
    if (rt && !rg) throw err('"' + rt + '" is not a valid IP range. Write it as 192.168.1.192/27.');
    if (rg && !(rg.prefix >= sn.prefix && inCidr(sn, rt.split('/')[0]))) throw err('The IP range ' + rg.text + ' is not in the subnet ' + sn.text + '.');
    if (own && f.parent !== 'br0') throw err('Choose the network card (or bridge) connected to your home network.');
    if (sn) {
      const clash = dnets.find((n) => n.subnet && overlap(sn, cidr(n.subnet, 0, 32)));
      if (clash) throw err('The subnet ' + sn.text + ' overlaps with the network ' + clash.name + ' (' + clash.subnet + '). Choose another subnet.', 409);
      if (!own && overlap(sn, cidr('192.168.1.0/24'))) throw err('The subnet ' + sn.text + ' is the network of br0. A bridge needs its own subnet, e.g. 172.30.0.0/24. Choose macvlan or ipvlan for addresses in your home network.', 409);
    }
    let subnet = sn ? sn.text : null, gateway = gw || null;
    if (!sn) { for (let i = 21; dnets.some((n) => n.subnet === '172.' + i + '.0.0/16'); i++) subnet = '172.' + (i + 1) + '.0.0/16'; subnet = subnet || '172.21.0.0/16'; gateway = subnet.replace('0.0/16', '0.1'); }
    dnets.push({ id: Math.random().toString(16).slice(2, 14).padEnd(12, '0'), name, driver, builtin: false, internal: !own && !!f.internal, subnet, gateway,
      ipRange: rg ? rg.text : null, parent: own ? 'br0' : null, compose: null, ours: true, created: new Date().toISOString() });
    return { id: dnets[dnets.length - 1].id, name };
  }
  function dnetDelete(name) {
    const n = dnets.find((x) => x.name === name); if (!n) throw err('network ' + name + ' not found', 404);
    if (n.builtin) throw err('The network ' + n.name + ' belongs to Docker itself and cannot be deleted.');
    const users = dnetList().networks.find((x) => x.name === name).containers;
    if (users.length) throw err('The network ' + n.name + ' is still used by ' + (users.map((c) => c.name).join(', ')) + '. Move those apps out first.', 409);
    dnets.splice(dnets.indexOf(n), 1);
    return { removed: n.name };
  }
  // Set the network of an app. With its own address there are no ports on the server and the WebUI points to that address.
  // Like networkFor() in lib/dockernet.js: a fixed address on the default network → the shared homebase network.
  function homebaseNet() {
    let n = dnets.find((x) => x.name === 'homebase');
    if (!n) { n = { id: 'homebase0000', name: 'homebase', driver: 'bridge', builtin: false, internal: false, subnet: '172.30.0.0/16', gateway: '172.30.0.1', ipRange: null, parent: null, compose: null, ours: true, containers: [] }; dnets.push(n); }
    return n;
  }
  function setAppNet(a, network, ip) {
    if (ip && (network === 'host' || network === 'none')) throw err('A fixed IP address doesn\'t work with the host network or without a network.');
    if (ip && (!network || network === 'bridge')) network = homebaseNet().name;
    if (network === '@lan') network = (dnets.find((n) => /^(macvlan|ipvlan)$/.test(n.driver)) || {}).name || 'lan';
    if (ip && Object.entries(appNet).some(([app, x]) => x.ip === ip && app !== a.name)) {
      throw err(ip + ' is already used by ' + Object.entries(appNet).find(([app, x]) => x.ip === ip && app !== a.name)[0] + '. Choose another address.', 409);
    }
    if (!network || network === 'host' || network === 'none' || network === 'bridge') { delete appNet[a.name]; return; }
    const n = dnets.find((x) => x.name === network); if (!n) throw err('The network ' + network + ' does not exist. Create it in Settings → Docker networks or choose another network.');
    if (ip && !ip4.test(ip)) throw err('"' + ip + '" is not a valid IP address.');
    if (ip && !inCidr(cidr(n.subnet, 0, 32), ip)) throw err('The address ' + ip + ' is not in this network\'s subnet ' + n.subnet + '.');
    appNet[a.name] = { net: network, ip: ip || (ownIpNet(network) ? freeIp(n) : '') };
  }

  /* ---- layout of the home screen: two folders, the rest follows by itself */
  let layout = { items: ['jellyfin', 'immich', 'nextcloud', 'paperless-ngx', 'vaultwarden',
    { folder: 'fsmarthome', name: 'Home automation', apps: ['mosquitto', 'zigbee2mqtt', 'whisper', 'piper', 'frigate'] },
    { folder: 'fai', name: 'AI', apps: ['ollama', 'open-webui'] }] };
  function saveLayout(b) {
    if (!b || !Array.isArray(b.items)) throw err('The layout is not valid.');
    const seen = new Set();
    const items = b.items.map((it) => {
      if (typeof it === 'string') { if (seen.has(it)) return null; seen.add(it); return it; }
      const apps = (it.apps || []).filter((n) => !seen.has(n) && seen.add(n));
      return apps.length > 1 ? { folder: it.folder, name: String(it.name || 'Folder').slice(0, 40), apps } : apps[0] || null;
    }).filter(Boolean);
    const ok = (a) => [...new Set((Array.isArray(a) ? a : []).filter((x) => /^[a-z]{2,16}$/.test(x)))];
    layout = { items, widgets: { order: ok(b.widgets && b.widgets.order), hidden: ok(b.widgets && b.widgets.hidden) } };
    return copy(layout);
  }

  /* ---- shared folders (Samba) */
  const shareUsers = ['kim', 'lisa', 'tom'];
  const shareGroups = [
    { name: 'Family', comment: 'Everyone at home', members: ['kim', 'lisa', 'tom'] },
    { name: 'Parents', comment: '', members: ['lisa', 'tom'] },
  ];
  const shareList = [
    { name: 'media', path: '/tank/media', comment: 'Films, series and music', users: { lisa: 'rw' }, groups: { Family: 'ro' }, guest: false, timemachine: false },
    { name: 'photos', path: '/tank/photos', comment: '', users: {}, groups: { Parents: 'rw', Family: 'ro' }, guest: false, timemachine: false },
    { name: 'documents', path: '/tank/documents', comment: 'Taxes, house and school', users: {}, groups: { Parents: 'rw' }, guest: false, timemachine: false },
    { name: 'TimeMachine', path: '/tank/timemachine', comment: 'Backups of the Macs', users: { lisa: 'rw' }, groups: {}, guest: false, timemachine: true },
  ];
  // Like effectiveUsers in lib/shares.js.
  function shareEffective(sh, groups = shareGroups) {
    const out = { ...sh.users };
    for (const [g, l] of Object.entries(sh.groups || {})) { const gr = groups.find((x) => x.name === g); (gr ? gr.members : []).forEach((m) => { if (out[m] !== 'rw') out[m] = l; }); }
    return out;
  }
  const shareEmpty = (groups = shareGroups) => shareList.filter((x) => !x.guest && !Object.keys(shareEffective(x, groups)).length).map((x) => x.name);
  const shareRoots = () => [{ name: 'tank', mountpoint: '/tank' }, { name: 'fast', mountpoint: '/fast' }]
    .concat(datasets.map((x) => ({ name: x.name, mountpoint: x.mountpoint }))).filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i);
  function sharesGet() {
    return { installed: true, running: true, hostname: net.hostname, shares: copy(shareList), groups: copy(shareGroups), appUser: 'lennert', roots: shareRoots(),
      connections: { total: 2, perShare: { media: 2, photos: 1 } }, admin: acct.user,
      users: shareUsers.slice().sort().map((name) => ({ name, managed: true, shares: shareList.filter((x) => shareEffective(x)[name]).map((x) => x.name),
        groups: shareGroups.filter((g) => g.members.includes(name)).map((g) => g.name) })) };
  }
  function shareSave(b, original) {
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(name) || /^(global|homes|printers)$/i.test(name)) throw err('Choose a name with letters, digits, -, _ or . (at most 32 characters), e.g. media.');
    if (shareList.some((x) => x.name !== original && x.name.toLowerCase() === name.toLowerCase())) throw err('A shared folder named ' + name + ' already exists.', 409);
    const users = {}; for (const [u, v] of Object.entries(b.users || {})) if ((v === 'ro' || v === 'rw') && shareUsers.includes(u)) users[u] = v;
    const groups = {}; for (const [g, v] of Object.entries(b.groups || {})) if ((v === 'ro' || v === 'rw') && shareGroups.some((x) => x.name === g)) groups[g] = v;
    if (!b.guest && !Object.keys(users).length && !Object.keys(groups).length) throw err('Give at least one user or group access, or let guests read.');
    let p;
    if (b.create) { const r = shareRoots().find((x) => x.name === b.create.parent); if (!r) throw err('Choose the pool for the new folder.'); p = r.mountpoint + '/' + name.toLowerCase(); }
    else { p = String(b.path || '').replace(/\/+$/, ''); if (!shareRoots().some((r) => p === r.mountpoint || p.startsWith(r.mountpoint + '/'))) throw err('Choose a folder on one of your pools (e.g. /tank/media).'); }
    const share = { name, path: p, comment: String(b.comment || '').trim().slice(0, 100), users, groups, guest: !!b.guest, timemachine: !!b.timemachine };
    const i = shareList.findIndex((x) => x.name === original);
    if (original && i < 0) throw err('This shared folder no longer exists.', 404);
    if (i >= 0) shareList[i] = share; else shareList.push(share);
    return share;
  }
  function shareUserCreate(b) {
    const name = String(b.name || '').trim();
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw err('Choose a user name with lowercase letters, digits, - or _ (at most 32 characters), e.g. lisa.');
    if (String(b.password || '').length < 8) throw err('Choose a password of at least 8 characters.');
    if (shareUsers.includes(name) || ['root', 'lennert', 'nobody'].includes(name)) throw err('The user ' + name + ' already exists on the server. Choose another name.', 409);
    shareUsers.push(name);
    (Array.isArray(b.groups) ? b.groups : []).forEach((g) => { const gr = shareGroups.find((x) => x.name === g); if (gr && !gr.members.includes(name)) gr.members.push(name); });
    return { name };
  }
  function shareUserDelete(name) {
    const without = shareGroups.map((g) => ({ ...g, members: g.members.filter((m) => m !== name) }));
    const only = shareList.filter((x) => { if (x.guest || !shareEffective(x)[name]) return false; const u = { ...x.users }; delete u[name]; return !Object.keys(shareEffective({ ...x, users: u }, without)).length; }).map((x) => x.name);
    if (only.length) throw err(name + ' is the only one with access to ' + (only.join(', ')) + '. Give someone else access first, or delete that shared folder.', 409);
    shareList.forEach((x) => { delete x.users[name]; });
    shareGroups.forEach((g) => { g.members = g.members.filter((m) => m !== name); });
    shareUsers.splice(shareUsers.indexOf(name), 1); return { removed: name };
  }
  function shareUserAccess(name, b) {
    if (!shareUsers.includes(name)) throw err('This user no longer exists.', 404);
    const groups = copy(shareGroups), saved = copy(shareList);
    if (Array.isArray(b.groups)) groups.forEach((g) => { g.members = g.members.filter((m) => m !== name); if (b.groups.includes(g.name)) g.members.push(name); });
    for (const [sh, level] of Object.entries(b.access || {})) {
      const x = shareList.find((y) => y.name === sh); if (!x) throw err('The shared folder ' + sh + ' doesn\'t exist (anymore).');
      if (level === 'ro' || level === 'rw') x.users[name] = level; else delete x.users[name];
    }
    const empty = shareEmpty(groups);
    if (empty.length) { shareList.splice(0, shareList.length, ...saved); throw err('Then nobody can access ' + (empty.join(', ')) + ' anymore. First give someone else access, or remove that shared folder.', 409); }
    shareGroups.splice(0, shareGroups.length, ...groups);
    return { name, groups: groups.filter((g) => g.members.includes(name)).map((g) => g.name) };
  }
  function shareGroupSave(b, original) {
    if (original && !shareGroups.some((g) => g.name === original)) throw err('This group doesn\'t exist (anymore).', 404);
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(name)) throw err('Choose a group name with letters, digits, -, _ or . (at most 32 characters), e.g. Family.');
    if (shareGroups.some((g) => g.name !== original && g.name.toLowerCase() === name.toLowerCase())) throw err('A group named ' + name + ' already exists.', 409);
    const members = [...new Set(Array.isArray(b.members) ? b.members : [])];
    const bad = members.find((m) => !shareUsers.includes(m)); if (bad) throw err('The user ' + bad + ' no longer exists.');
    const group = { name, comment: String(b.comment || '').trim().slice(0, 100), members: members.sort() };
    const groups = shareGroups.filter((g) => g.name !== original).concat(group).sort((x, y) => x.name.localeCompare(y.name));
    const saved = copy(shareList);
    shareList.forEach((x) => { const g = { ...(x.groups || {}) }; const old = original && g[original]; delete g[original]; const w = b.shares ? b.shares[x.name] : old; if (w === 'ro' || w === 'rw') g[name] = w; x.groups = g; });
    const empty = shareEmpty(groups);
    if (empty.length) { shareList.splice(0, shareList.length, ...saved); throw err('Then nobody can access ' + (empty.join(', ')) + ' anymore. First give someone else access, or remove that shared folder.', 409); }
    shareGroups.splice(0, shareGroups.length, ...groups);
    return group;
  }
  function shareGroupDelete(name) {
    if (!shareGroups.some((g) => g.name === name)) throw err('This group doesn\'t exist (anymore).', 404);
    const groups = shareGroups.filter((g) => g.name !== name);
    const saved = copy(shareList);
    shareList.forEach((x) => { delete (x.groups || {})[name]; });
    const empty = shareEmpty(groups);
    if (empty.length) { shareList.splice(0, shareList.length, ...saved); throw err('Only this group has access to ' + (empty.join(', ')) + '. First give someone else access, or remove that shared folder.', 409); }
    shareGroups.splice(0, shareGroups.length, ...groups);
    return { removed: name };
  }

  /* ---- backups: connections (rclone), tasks and devices */
  const MB = 1024 ** 2, HOUR = 3600000;
  const BK_PROVIDERS = {
    drive: { label: 'Google Drive', group: 'cloud', oauth: true, hint: '', fields: [] },
    onedrive: { label: 'OneDrive', group: 'cloud', oauth: true, hint: '', fields: [] },
    dropbox: { label: 'Dropbox', group: 'cloud', oauth: true, hint: '', fields: [] },
    s3: { label: 'S3 storage', group: 'cloud', oauth: false, hint: 'Backblaze B2, Wasabi, Cloudflare R2, Amazon S3 or MinIO', fields: [
      { key: 'provider', label: 'Provider', type: 'select', required: false, default: 'Other',
        options: [['Other', 'Other (e.g. Backblaze B2)'], ['AWS', 'Amazon S3'], ['Cloudflare', 'Cloudflare R2'], ['Wasabi', 'Wasabi'], ['Minio', 'MinIO']] },
      { key: 'endpoint', label: 'Endpoint', type: 'text', required: false, placeholder: 's3.eu-central-003.backblazeb2.com', help: 'The address of the storage. Leave empty for Amazon S3.' },
      { key: 'region', label: 'Region', type: 'text', required: false, placeholder: 'eu-central-003' },
      { key: 'access_key_id', label: 'Access key', type: 'text', required: true },
      { key: 'secret_access_key', label: 'Secret key', type: 'password', required: true }] },
    sftp: { label: 'Other NAS or server (SFTP)', group: 'nas', oauth: false, hint: 'Over SSH: Synology, QNAP, TrueNAS, another HomeBaseOS or a Linux server', fields: [
      { key: 'host', label: 'Address', type: 'text', required: true, placeholder: '192.168.1.20' },
      { key: 'port', label: 'Port', type: 'number', required: false, default: '22' },
      { key: 'user', label: 'User', type: 'text', required: true },
      { key: 'pass', label: 'Password', type: 'password', required: true }] },
    smb: { label: 'Other NAS (SMB)', group: 'nas', oauth: false, hint: 'A shared folder on another NAS or a Windows PC', fields: [
      { key: 'host', label: 'Address', type: 'text', required: true, placeholder: '192.168.1.20' },
      { key: 'user', label: 'User', type: 'text', required: true },
      { key: 'pass', label: 'Password', type: 'password', required: true },
      { key: 'domain', label: 'Workgroup', type: 'text', required: false, placeholder: 'WORKGROUP' }] },
    webdav: { label: 'WebDAV', group: 'nas', oauth: false, hint: 'Nextcloud, ownCloud or another NAS with WebDAV', fields: [
      { key: 'url', label: 'Address (URL)', type: 'text', required: true, placeholder: 'https://cloud.example.com/remote.php/dav/files/lisa' },
      { key: 'vendor', label: 'Kind of server', type: 'select', required: false, default: 'other', options: [['nextcloud', 'Nextcloud'], ['owncloud', 'ownCloud'], ['other', 'Other']] },
      { key: 'user', label: 'User', type: 'text', required: true },
      { key: 'pass', label: 'Password', type: 'password', required: true }] },
  };
  const bkRemotes = [{ name: 'google', type: 'drive', detail: '' }, { name: 'nas-mum', type: 'sftp', detail: 'freddy@nas-mum.home.arpa' }];
  const bkResult = (hoursAgo, mins, files, size, extra = {}) => ({ kind: 'backup', dryRun: false, scheduled: true, started: Date.now() - hoursAgo * HOUR,
    ended: Date.now() - hoursAgo * HOUR + mins * 60000, state: 'ok', bytes: size, files, checks: 1840, deletes: 0, errors: 0, error: null, ...extra });
  const bkJobs = [
    { id: 'a1b2c3d4', name: 'Photos to Google Drive', direction: 'push', mode: 'copy', remote: 'google', remotePath: 'Backups/Freddy/photos', localPath: '/tank/photos',
      encrypt: false, versions: false, keepDays: 30, schedule: { every: 'daily', time: '02:00', day: 0 }, excludes: ['.DS_Store'], bwlimit: '',
      created: Date.now() - 40 * 86400000, lastScheduled: Date.now() - 7 * HOUR, lastRun: bkResult(7, 12, 34, 210 * MB) },
    { id: 'b2c3d4e5', name: "Documents to Mum's NAS", direction: 'push', mode: 'sync', remote: 'nas-mum', remotePath: 'backup-freddy', localPath: '/tank/documents',
      encrypt: true, versions: true, keepDays: 90, schedule: { every: 'weekly', time: '03:30', day: 0 }, excludes: [], bwlimit: '5M',
      created: Date.now() - 60 * 86400000, lastScheduled: Date.now() - 5 * 86400000, lastRun: bkResult(5 * 24, 4, 112, 380 * MB, { deletes: 3 }) },
    { id: 'c3d4e5f6', name: 'Keep Google Drive at home', direction: 'pull', mode: 'copy', remote: 'google', remotePath: '', localPath: '/tank/backups/google-drive',
      encrypt: false, versions: false, keepDays: 30, schedule: { every: 'daily', time: '04:00', day: 0 }, excludes: [], bwlimit: '',
      created: Date.now() - 20 * 86400000, lastScheduled: Date.now() - 5 * HOUR,
      lastRun: bkResult(5, 1, 0, 0, { state: 'failed', errors: 1, error: "couldn't connect: dial tcp: lookup www.googleapis.com: no such host" }) },
  ];
  bkJobs.forEach((j) => { j.history = [j.lastRun]; });
  const bkLogs = {};
  const bkDevs = [
    { name: 'MacBook-Lisa', kind: 'mac', method: 'share', dataset: 'tank/backups/macbook-lisa', path: '/tank/backups/macbook-lisa', user: 'lisa', created: Date.now() - 90 * 86400000,
      used: 412 * GB, quota: 1000 * GB, avail: 588 * GB, missing: false, lastChange: Date.now() - 40 * 60000, connected: 1 },
    { name: 'pc-tom', kind: 'windows', method: 'kopia', user: 'pc-tom@pc-tom', created: Date.now() - 30 * 86400000,
      used: 186 * GB, lastChange: Date.now() - 50 * 60000, snapshots: 212, folders: ['C:\\Users\\tom'] },
  ];
  // Backup app (Kopia) on the NAS: turned on, with one PC.
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
  // A running task: the progress follows the clock; when the time is up, the result goes into the history.
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
        [{ time: t0, level: r.cancelled ? 'error' : 'info', text: r.cancelled ? 'Stopped.' : 'Done.' }]);
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
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name) || name.startsWith('hb-crypt-')) throw err('Choose a name with letters, digits, - or _ (at most 32 characters), e.g. google.');
    if (bkRemotes.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw err('A connection named ' + name + ' already exists.', 409);
  }
  function bkRemoteCreate(b) {
    const name = String(b.name || '').trim(); bkNewRemote(name);
    const p = BK_PROVIDERS[b.type]; if (!p || p.oauth) throw err('Choose a kind of connection.');
    for (const f of p.fields) if (f.required && !String(b[f.key] || '').trim()) throw err('Fill in ' + f.label.toLowerCase() + '.');
    if (b.host && !/^[A-Za-z0-9._:[\]-]+$/.test(String(b.host).trim())) throw err('"' + b.host + '" is not a valid address. Use an IP address or a name, e.g. 192.168.1.20.');
    if (b.url && !/^https?:\/\/\S+$/i.test(String(b.url).trim())) throw err('The address must start with http:// or https://.');
    const detail = b.type === 'webdav' ? b.url : b.type === 's3' ? (b.endpoint || b.provider) : String(b.user).trim() + '@' + String(b.host).trim();
    bkRemotes.push({ name, type: b.type, detail }); return { name };
  }
  function bkAuthFinish(b) {
    const name = String(b.name || '').trim();
    if (b.reconnect) { if (!bkRemotes.some((r) => r.name === name && r.type === b.type)) throw err('This connection doesn\'t exist (anymore).', 404); } else bkNewRemote(name);
    if (!BK_PROVIDERS[b.type] || !BK_PROVIDERS[b.type].oauth) throw err('Choose Google Drive, OneDrive or Dropbox.');
    if (!b.token) {
      if (b.session !== 'demo') throw err('Signing in expired. Start again.', 410);
      let u = null; try { u = new URL(String(b.url || '').trim()); } catch (e) { /* below */ }
      if (!u || !u.searchParams.get('code') || !u.searchParams.get('state')) throw err('Paste the full address from the address bar. It starts with http://127.0.0.1:53682/.');
    } else if (!/access_token|^[A-Za-z0-9+/=\s]{40,}$/.test(b.token)) throw err('That is not a valid token. Paste everything between ---> and <---End paste.');
    if (!b.reconnect) bkRemotes.push({ name, type: b.type, detail: b.type === 'onedrive' ? 'OneDrive (personal)' : '' });
    return { name };
  }
  function bkJobSave(b, id) {
    const cur = id ? bkJobs.find((j) => j.id === id) : null;
    if (id && !cur) throw err('This task doesn\'t exist (anymore).', 404);
    if (id && bkInfo(id)) throw err('This task is running now. Stop it first, or wait until it is done.', 409);
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw err("Give the task a name, e.g. Photos to Google Drive.");
    const direction = b.direction === 'pull' ? 'pull' : 'push', mode = b.mode === 'sync' ? 'sync' : 'copy';
    if (!bkRemotes.some((r) => r.name === b.remote)) throw err('Choose a connection. Create one first under Connections.');
    const remotePath = String(b.remotePath || '').trim().replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
    if (remotePath.split('/').some((x) => x === '..' || x === '.')) throw err('That destination folder isn\'t possible. Use plain folder names, separated by /.');
    const lp = String(b.localPath || '').trim().replace(/(.)\/+$/, '$1');
    if (!lp.startsWith('/') || !bkFolders().some((r) => lp === r || lp.startsWith(r + '/'))) throw err('Choose a folder on one of your pools, e.g. /tank/photos.');
    if (direction === 'pull' && pools.some((p) => '/' + p.name === lp)) throw err('Choose a folder of its own to store in, e.g. /tank/backups/google-drive, not the whole pool.');
    const encrypt = direction === 'push' && (cur ? !!cur.encrypt : !!b.encrypt);
    const root = remotePath === '' || remotePath === '/';
    if (mode === 'sync' && direction === 'push' && !encrypt && root) throw err('Choose a folder on the destination. Syncing to the top folder would delete everything else that is there.');
    const versions = direction === 'push' && !!b.versions;
    if (versions && !encrypt && root) throw err('Choose a folder on the destination to be able to keep old versions.');
    if (encrypt && !cur && String(b.password || '').length < 10) throw err('Choose an encryption password of at least 10 characters.');
    const bw = String(b.bwlimit || '').trim();
    if (bw && !/^\d+(\.\d+)?[KMG]?$/i.test(bw)) throw err('Write the bandwidth as a number with K, M or G, e.g. 10M (10 MB per second).');
    const s = b.schedule || {};
    const schedule = { every: ['manual', 'hourly', 'daily', 'weekly'].includes(s.every) ? s.every : 'manual', time: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '') ? s.time : '03:00', day: Number(s.day) >= 0 && Number(s.day) <= 6 ? Number(s.day) : 0 };
    const job = { name, direction, mode, remote: b.remote, remotePath, localPath: lp, encrypt, versions, keepDays: Math.min(3650, Math.max(1, Math.round(Number(b.keepDays) || 30))),
      schedule, excludes: String(b.excludes || '').split('\n').map((x) => x.trim()).filter(Boolean), bwlimit: bw };
    if (cur) { if (JSON.stringify(cur.schedule) !== JSON.stringify(schedule)) cur.lastScheduled = Date.now(); Object.assign(cur, job); return bkPublic(cur); }
    const out = { id: Math.random().toString(16).slice(2, 10).padEnd(8, '0'), ...job, created: Date.now(), lastScheduled: Date.now(), lastRun: null, history: [] };
    bkJobs.push(out); return bkPublic(out);
  }
  function bkStart(id, kind, dryRun, target) {
    const j = bkJobs.find((x) => x.id === id); if (!j) throw err('This task doesn\'t exist (anymore).', 404);
    if (bkInfo(id)) throw err('This task is already running.', 409);
    const t0 = new Date().toISOString(), dest = j.remote + ':' + j.remotePath;
    bkLive[id] = { kind, dryRun, started: Date.now(), dur: rnd(10000, 16000), total: rnd(80, 900) * MB, files: Math.round(rnd(20, 140)), cancelled: false,
      lines: [{ time: t0, level: 'info', text: kind === 'restore' ? 'Restoring to ' + target : (dryRun ? 'Dry run (nothing changes): ' : '') + (j.direction === 'pull' ? dest + ' → ' + j.localPath : j.localPath + ' → ' + dest) }] };
    return { started: true, kind, dryRun };
  }
  function bkDeviceCreate(b) {
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) throw err('Choose a name with letters, digits, - or _ (at most 32 characters), e.g. MacBook-Lisa.');
    if (bkDevs.some((d) => d.name.toLowerCase() === name.toLowerCase())) throw err('A device named ' + name + ' already exists.', 409);
    if (b.method !== 'kopia' && shareList.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw err('A shared folder named ' + name + ' already exists.', 409);
    if (!['mac', 'windows', 'linux', 'phone'].includes(b.kind)) throw err('Choose what kind of device it is.');
    if (b.method === 'kopia') {
      if (!demoKopia.enabled) throw err('First turn on the backup app (Kopia).', 409);
      if (b.kind === 'phone') throw err("The backup app doesn't exist for phones. Choose a shared folder.");
      const dev = { name, kind: b.kind, method: 'kopia', user: name.toLowerCase() + '@' + name.toLowerCase(), created: Date.now(), used: 0, lastChange: null, snapshots: 0, folders: [] };
      bkDevs.push(dev); return { ...copy(dev), ...demoPairing() };
    }
    const pool = pools.find((p) => p.name === b.pool); if (!pool) throw err('Choose the pool for the backups.');
    const q = b.quotaGb === '' || b.quotaGb == null ? 0 : Number(b.quotaGb);
    if (!Number.isInteger(q) || q < 0 || q > 1e6) throw err('Fill in the maximum size as a number in GB, or leave it empty.');
    let user = b.user;
    if (b.newUser) user = shareUserCreate(b.newUser).name;
    else if (!shareUsers.includes(user)) throw err('Choose who may make the backups.');
    const ds = pool.name + '/backups/' + name.toLowerCase();
    shareList.push({ name, path: '/' + ds, comment: 'Backups of ' + name, users: { [user]: 'rw' }, guest: false, timemachine: b.kind === 'mac' });
    const dev = { name, kind: b.kind, method: 'share', dataset: ds, path: '/' + ds, user, created: Date.now(), used: 0, quota: q * GB, avail: q ? q * GB : pool.free, missing: false, lastChange: null, connected: 0 };
    bkDevs.push(dev); return copy(dev);
  }
  function bkDeviceDelete(name, data) {
    const i = bkDevs.findIndex((d) => d.name === name); if (i < 0) throw err('This device doesn\'t exist (anymore).', 404);
    if (bkDevs[i].method !== 'kopia') { const s = shareList.findIndex((x) => x.name === name); if (s >= 0) shareList.splice(s, 1); }
    const [d] = bkDevs.splice(i, 1); return { removed: name, dataset: data && d.method !== 'kopia' ? d.dataset : null };
  }
  async function bkPost(path, b) {
    if (path === '/api/backup/remotes') { await wait(rnd(900, 1600)); return bkRemoteCreate(b); }
    if (path === '/api/backup/auth') {
      if (!BK_PROVIDERS[b.type] || !BK_PROVIDERS[b.type].oauth) throw err('Choose Google Drive, OneDrive or Dropbox.');
      return { session: 'demo', url: 'https://accounts.google.com/o/oauth2/auth?client_id=demo&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2F&state=demo' };
    }
    if (path === '/api/backup/auth/finish') { await wait(rnd(800, 1400)); return bkAuthFinish(b); }
    if (path === '/api/backup/jobs') return bkJobSave(b, null);
    if (path === '/api/backup/devices') { await wait(rnd(600, 1000)); return bkDeviceCreate(b); }
    if (path === '/api/backup/kopia') {
      if (!b.enabled) { demoKopia.enabled = demoKopia.running = false; return { enabled: false }; }
      await wait(rnd(1200, 2000));
      const first = !demoKopia.pool;
      if (first) { const p = pools.find((x) => x.name === b.pool); if (!p) throw err('Choose the pool for the backups.'); demoKopia.pool = p.name; demoKopia.path = '/' + p.name + '/backups/kopia'; }
      demoKopia.enabled = demoKopia.running = true;
      return first ? { enabled: true, repoPassword: demoPw() } : { enabled: true };
    }
    const dpr = path.match(/^\/api\/backup\/devices\/([^/]+)\/pair$/);
    if (dpr) {
      const dev = bkDevs.find((x) => x.name === decodeURIComponent(dpr[1])); if (!dev) throw err('This device doesn\'t exist (anymore).', 404);
      if (dev.method !== 'kopia') throw err('Pairing only works for a device with the backup app.');
      if (!demoKopia.enabled) throw err('First turn on the backup app (Kopia).', 409);
      return { name: dev.name, ...demoPairing() };
    }
    const dpw = path.match(/^\/api\/backup\/devices\/([^/]+)\/password$/);
    if (dpw) {
      const dev = bkDevs.find((x) => x.name === decodeURIComponent(dpw[1])); if (!dev) throw err('This device doesn\'t exist (anymore).', 404);
      if (dev.method !== 'kopia') throw err('You change the password of a shared folder under Shared folders → Users.');
      if (!demoKopia.enabled) throw err('First turn on the backup app (Kopia).', 409);
      return { name: dev.name, password: demoPw() };
    }
    let m = path.match(/^\/api\/backup\/remotes\/([^/]+)\/test$/);
    if (m) {
      await wait(rnd(700, 1300));
      const r = bkRemotes.find((x) => x.name === decodeURIComponent(m[1])); if (!r) throw err('This connection doesn\'t exist (anymore).', 404);
      return { ok: true, about: r.type === 'drive' ? { total: 2048 * GB, used: 731 * GB, free: 1317 * GB } : r.type === 'sftp' ? { total: 3.6 * TB, used: 1.2 * TB, free: 2.4 * TB } : null };
    }
    m = path.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})$/);
    if (m) return bkJobSave(b, m[1]);
    m = path.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})\/(run|stop|restore)$/);
    if (!m) throw err('Unknown endpoint', 404);
    if (m[2] === 'stop') { if (!bkInfo(m[1])) throw err('This task isn\'t running.', 409); bkLive[m[1]].cancelled = true; return { stopping: true }; }
    if (m[2] === 'run') return bkStart(m[1], 'backup', !!b.dryRun);
    const j = bkJobs.find((x) => x.id === m[1]); if (!j) throw err('This task doesn\'t exist (anymore).', 404);
    if (j.direction !== 'push') throw err('Restoring only works for a task that goes to the cloud or another NAS.');
    const target = String(b.target || '').trim();
    if (!target.startsWith('/') || !bkFolders().some((r) => target === r || target.startsWith(r + '/'))) throw err('Choose a folder on one of your pools, e.g. /tank/photos.');
    if (pools.some((p) => '/' + p.name === target)) throw err('Choose a folder of its own to store in, e.g. /tank/backups/google-drive, not the whole pool.');
    return bkStart(j.id, 'restore', false, target);
  }
  function bkBrowse(name, p) {
    if (!bkRemotes.some((r) => r.name === name)) throw err('This connection doesn\'t exist (anymore).', 404);
    const tree = { '': ['Backups', 'Documents', 'Photos', 'Shared'], Backups: ['Freddy', 'Laptop'], 'Backups/Freddy': ['photos'], Documents: ['Taxes', 'House'], backup: [] };
    const clean = String(p || '').replace(/^\/+|\/+$/g, '');
    return { path: clean, dirs: tree[clean] || [] };
  }
  function bkDel(path) {
    let m = path.match(/^\/api\/backup\/remotes\/([^/]+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]), i = bkRemotes.findIndex((r) => r.name === name);
      if (i < 0) throw err('This connection doesn\'t exist (anymore).', 404);
      const used = bkJobs.filter((j) => j.remote === name).map((j) => j.name);
      if (used.length) throw err('The connection ' + name + ' is still used by ' + (used.join(', ')) + '. Remove or change those tasks first.', 409);
      bkRemotes.splice(i, 1); return { removed: name };
    }
    m = path.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})$/);
    if (m) {
      const i = bkJobs.findIndex((j) => j.id === m[1]); if (i < 0) throw err('This task doesn\'t exist (anymore).', 404);
      if (bkInfo(m[1])) throw err('This task is running now. Stop it first, or wait until it is done.', 409);
      bkJobs.splice(i, 1); return { removed: m[1] };
    }
    m = path.match(/^\/api\/backup\/devices\/([^/?]+)(\?data=1)?$/);
    if (m) return bkDeviceDelete(decodeURIComponent(m[1]), !!m[2]);
    return null;
  }

  /* ---- settings, compose file and console per app */
  const appOvr = {}, composeText = {};
  const findApp = (id) => { const a = apps.find((x) => x.id === decodeURIComponent(id)); if (!a) throw err('This app does not exist (anymore).', 404); return a; };
  const resolvePorts = (tpl, ports) => tpl.replace(/\[PORT:(\d+)\]/g, (_, p) => { const x = ports.find((q) => String(q.private) === p); return x ? String(x.public) : p; });
  // Form per service, in the same shape as lib/composeform.js serviceForm() returns.
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
  // A tiny simulated shell, so you can try the console in the demo.
  function demoExec(a, cmd, cwd) {
    if (a.state !== 'RUNNING') throw err('Start the app first. The console only works while the app is running.', 409);
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
        return { output: c + ': cannot open terminal (no tty)', cwd, exitCode: 1 }; // like a real shell without a terminal
      default: return { output: 'sh: ' + c + ': not found', cwd, exitCode: 127 };
    }
  }

  /* ---- app store: small sample catalogue in the same shape as lib/appstore.js */
  let fk = 0;
  const F = (type, name, target, value, o = {}) => ({ key: 'c' + fk++, type, name, target, value: String(value), mode: o.mode || '',
    description: o.desc || '', required: !!o.req, mask: !!o.mask, advanced: !!o.adv, options: o.options || null, auto: !!o.auto });
  const lsio = (port, dir) => [F('Port', 'WebUI', String(port), port, { mode: 'tcp', req: true }),
    F('Path', 'Appdata', '/config', AD() + '/' + dir, { mode: 'rw', req: true, adv: true, auto: true, desc: 'The app\'s settings and database.' }),
    F('Variable', 'PUID', 'PUID', 1000, { req: true, adv: true }), F('Variable', 'PGID', 'PGID', 1000, { req: true, adv: true })];
  const storeDefs = [
    ['Jellyfin', 'lscr.io/linuxserver/jellyfin', 'linuxserver', ['MediaServer'], true, 'Free media server: stream films, series and music to all your devices, without a subscription.',
      () => [...lsio(8096, 'jellyfin'), F('Port', 'Discovery', '7359', 7359, { mode: 'udp' }),
        F('Path', 'Films', '/data/movies', '', { mode: 'rw', req: true, desc: 'Folder with your films.' }), F('Path', 'Series', '/data/tvshows', '', { mode: 'rw', req: true }),
        F('Device', 'GPU (hardware transcoding)', '/dev/dri', '/dev/dri', { adv: true })], { webui: 'http://[IP]:[PORT:8096]' }],
    ['immich', 'ghcr.io/imagegenius/immich', 'imagegenius', ['MediaApp'], true, "Back up photos and videos from your phone automatically, with face recognition and search.",
      () => [...lsio(8080, 'immich'), F('Path', "Photos", '/photos', '/tank/photos', { mode: 'rw', req: true }),
        F('Variable', 'Database host', 'DB_HOSTNAME', '', { req: true, desc: 'Address of your PostgreSQL database.' })],
      { webui: 'http://[IP]:[PORT:8080]', requires: 'A PostgreSQL database with pgvecto.rs and Redis.' }],
    ['Plex-Media-Server', 'plexinc/pms-docker', 'plexinc', ['MediaServer'], true, 'Plex organises your media and streams it to every screen.',
      () => [F('Path', 'Config', '/config', AD() + '/plex', { mode: 'rw', req: true, auto: true }), F('Path', 'Media', '/data', '/tank/media', { mode: 'rw' }),
        F('Variable', 'Claim token', 'PLEX_CLAIM', '', { mask: true, desc: 'Get your token at plex.tv/claim.' })], { network: 'host', official: true }],
    ['vaultwarden', 'vaultwarden/server', 'selfhosters', ['Security'], true, 'Lightweight Bitwarden server for your passwords.',
      () => [F('Port', 'WebUI', '80', 8222, { mode: 'tcp', req: true }), F('Path', 'Data', '/data', AD() + '/vaultwarden', { mode: 'rw', req: true, auto: true }),
        F('Variable', 'Allow sign-ups', 'SIGNUPS_ALLOWED', 'true', { options: ['true', 'false'] }), F('Variable', 'Admin token', 'ADMIN_TOKEN', '', { mask: true, adv: true })],
      { webui: 'http://[IP]:[PORT:80]', id: 'a1b2c3d4e5f6' }],
    ['audiobookshelf', 'ghcr.io/advplyr/audiobookshelf', 'selfhosters', ['MediaServer'], true, 'Server for audiobooks and podcasts, with apps for your phone.',
      () => [F('Port', 'WebUI', '80', 13378, { mode: 'tcp', req: true }), F('Path', 'Config', '/config', AD() + '/audiobookshelf', { req: true, auto: true }),
        F('Path', 'Audiobooks', '/audiobooks', '/tank/media/audiobooks', { req: true })], { webui: 'http://[IP]:[PORT:80]' }],
    ['mealie', 'ghcr.io/mealie-recipes/mealie', 'selfhosters', ['Productivity'], true, "Store recipes, plan weekly menus and make shopping lists.",
      () => [F('Port', 'WebUI', '9000', 9925, { mode: 'tcp', req: true }), F('Path', 'Data', '/app/data', AD() + '/mealie', { req: true, auto: true })], { webui: 'http://[IP]:[PORT:9000]' }],
    ['paperless-ngx', 'ghcr.io/paperless-ngx/paperless-ngx', 'selfhosters', ['Productivity'], true, 'Scan your papers, have them recognised (OCR) and find everything again.',
      () => [F('Port', 'WebUI', '8000', 8001, { mode: 'tcp', req: true }), F('Path', 'Data', '/usr/src/paperless/data', AD() + '/paperless-ngx', { req: true, auto: true }),
        F('Variable', 'Redis', 'PAPERLESS_REDIS', 'redis://redis:6379', { req: true })], { webui: 'http://[IP]:[PORT:8000]', requires: 'A Redis server.' }],
    ['Home-Assistant-Container', 'ghcr.io/home-assistant/home-assistant', 'selfhosters', ['HomeAutomation'], true, 'Home Assistant as a container (without add-ons). Want add-ons? Use a VM with Home Assistant OS.',
      () => [F('Path', 'Config', '/config', AD() + '/home-assistant', { req: true, auto: true })], { network: 'host', privileged: true }],
    ['AdGuard-Home', 'adguard/adguardhome', 'selfhosters', ['Network'], true, 'Blocks ads and trackers for your whole network via DNS.',
      () => [F('Port', 'DNS', '53', 53, { mode: 'udp', req: true }), F('Port', 'WebUI', '3000', 3002, { mode: 'tcp', req: true }),
        F('Path', 'Config', '/opt/adguardhome/conf', AD() + '/adguard-home', { req: true, auto: true })], { webui: 'http://[IP]:[PORT:3000]', network: 'br0' }],
    ['navidrome', 'deluan/navidrome', 'selfhosters', ['MediaServer'], true, 'Your own Spotify for your music collection.',
      () => [F('Port', 'WebUI', '4533', 4533, { mode: 'tcp', req: true }), F('Path', 'Data', '/data', AD() + '/navidrome', { req: true, auto: true }),
        F('Path', 'Music', '/music', '/tank/media/music', { mode: 'ro', req: true })], { webui: 'http://[IP]:[PORT:4533]' }],
    ['portainer-ce', 'portainer/portainer-ce', 'selfhosters', ['Tools'], false, 'Manage your Docker containers in detail.',
      () => [F('Port', 'WebUI', '9443', 9443, { mode: 'tcp', req: true }), F('Path', 'Docker', '/var/run/docker.sock', '/var/run/docker.sock', { req: true }),
        F('Path', 'Data', '/data', AD() + '/portainer', { req: true, auto: true })], { webui: 'https://[IP]:[PORT:9443]' }],
    ['stirling-pdf', 'frooodle/s-pdf', 'selfhosters', ['Productivity'], false, "Everything with PDFs: merge, split, sign, OCR and more.",
      () => [F('Port', 'WebUI', '8080', 8090, { mode: 'tcp', req: true })], { webui: 'http://[IP]:[PORT:8080]' }],
    ['ollama', 'ollama/ollama', 'selfhosters', ['AI'], true, 'Run language models such as Llama and Qwen on your own GPU.',
      () => [F('Port', 'API', '11434', 11434, { mode: 'tcp', req: true }), F('Path', 'Models', '/root/.ollama', AD() + '/ollama', { req: true, auto: true })], { gpu: true }],
    ['Grafana', 'grafana/grafana', 'selfhosters', ['Tools'], true, 'Charts and dashboards for everything you measure.',
      () => [F('Port', 'WebUI', '3000', 3003, { mode: 'tcp', req: true }), F('Path', 'Data', '/var/lib/grafana', AD() + '/grafana', { req: true, auto: true })], { webui: 'http://[IP]:[PORT:3000]' }],
    ['Redis', 'redis', 'selfhosters', ['Tools'], false, 'Fast in-memory database, often needed by other apps.',
      () => [F('Port', 'Redis', '6379', 6379, { mode: 'tcp' }), F('Path', 'Data', '/data', AD() + '/redis', { auto: true })], {}],
    ['minecraft-server', 'itzg/minecraft-server', 'selfhosters', ['GameServers'], false, 'Your own Minecraft server for friends and family.',
      () => [F('Port', 'Game', '25565', 25565, { mode: 'tcp', req: true }), F('Path', 'Data', '/data', AD() + '/minecraft-server', { req: true, auto: true }),
        F('Variable', 'Accept EULA', 'EULA', 'TRUE', { req: true, options: ['TRUE', 'FALSE'] }), F('Variable', 'Memory', 'MEMORY', '2G', { adv: true })], {}],
  ];
  const STORE_ICON = { 'Plex-Media-Server': 'plex', 'Home-Assistant-Container': 'home-assistant', 'AdGuard-Home': 'adguard-home',
    'portainer-ce': 'portainer', 'minecraft-server': 'minecraft' };
  const CATS_NL = { AI: 'AI', Security: 'Security', HomeAutomation: 'Home automation', GameServers: 'Game servers', Tools: 'Tools', MediaApp: 'Media apps',
    MediaServer: 'Media servers', Network: 'Network', Productivity: 'Productivity' };
  const store = storeDefs.map(([name, image, maintainer, categories, featured, overview, fields, o], i) => ({
    id: o.id || (i.toString(16) + 'f0e1d2c3b4a5').slice(0, 12).padStart(12, '0'), name, image, maintainer, categories, featured, overview,
    summary: overview, icon: ICON(STORE_ICON[name] || name.toLowerCase()), official: !!o.official, beta: false, popularity: 1000 - i, webui: o.webui || null, network: o.network || 'bridge',
    requires: o.requires || null, project: 'https://example.org/' + name.toLowerCase(), support: null, privileged: !!o.privileged, gpu: !!o.gpu,
    fields: () => { fk = 0; return fields(); }, // fixed keys c0, c1, … as on the server
  }));
  const storeSlug = (n) => n.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  const storeInstalled = (a) => apps.some((x) => x.storeId === a.id || x.image.split(':')[0] === a.image);
  const storeJobs = {};
  function storeWarnings(a, network) {
    const w = [];
    const tpl = a.network || 'bridge';
    if (network === undefined && !['bridge', 'host', 'none'].includes(tpl)) network = 'bridge';
    if (!['bridge', 'host', 'none'].includes(tpl) && network === 'bridge') w.push('The template uses the network "' + tpl + '". Choose a network below, or create it in Settings → Docker networks.');
    if (network === 'host') w.push('This app uses the server\'s network (host) and then listens on its own ports. Want to choose ports yourself? Change a port or pick the default network (bridge). Some apps (like Home Assistant and Plex) work best with host, because they look for devices in your network.');
    if (network && ownIpNet(network)) w.push('This app gets its own address in your home network. The ports are then the app\'s own; the server itself cannot reach the app at this address.');
    if (a.privileged) w.push('This app runs privileged: it gets almost full access to your server.');
    if (a.gpu) w.push('This app uses the NVIDIA GPU. That requires install.sh to have been run with --nvidia.');
    if (a.fields().some((f) => f.value === '/var/run/docker.sock')) w.push('This app gets access to Docker and can therefore manage all your containers.');
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
      installed: storeInstalled(a), appdataMissing: false, folders: bkFolders() };
  }
  function storeInstall(a, body) {
    const name = String(body.name || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw err('Choose a name with lowercase letters, digits, - or _ (at most 63 characters).');
    if (apps.some((x) => x.name === name)) throw err('An app named ' + name + ' already exists. Choose another name.', 409);
    const fields = a.fields().map((f) => (f.key in (body.values || {}) ? { ...f, value: String(body.values[f.key]) } : f));
    const tpl = a.network || 'bridge';
    const network = body.network || (tpl === 'host' || tpl === 'none' ? tpl : 'bridge');
    if (!['bridge', 'host', 'none'].includes(network) && !dnets.some((n) => n.name === network)) throw err('The network ' + network + ' does not exist. Create it in Settings → Docker networks or choose another network.');
    if (body.ip && ['bridge', 'host', 'none'].includes(network)) throw err('A fixed IP address only works in a custom Docker network.');
    const noPorts = network === 'host' || network === 'none' || ownIpNet(network);
    let webPort = null;
    for (const f of fields) {
      if (f.required && !f.value.trim() && f.type !== 'Device') throw err('Fill in ' + f.name + '.');
      if (f.type === 'Port' && f.value && !noPorts) {
        const clash = apps.find((x) => x.ports.some((p) => String(p.public) === f.value));
        if (clash) throw err('Port ' + f.value + ' is already used by ' + clash.name + '. Choose another port.', 409);
        if (a.webui && a.webui.includes('[PORT:' + f.target + ']')) webPort = Number(f.value);
      }
    }
    const id = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
    const extraPorts = (body.extraPorts || []).map((p) => {
      const h = String(p.host || '').trim(), c = String(p.container || '').trim();
      if (!/^\d{1,5}$/.test(h) || !/^\d{1,5}$/.test(c) || Number(h) > 65535 || Number(c) > 65535 || !Number(h) || !Number(c)) throw err('Enter two ports between 1 and 65535 for each extra port.');
      return { public: Number(h), private: Number(c), type: p.protocol === 'udp' ? 'UDP' : 'TCP' };
    });
    if (extraPorts.length && noPorts) throw err('With the host network the app listens on its own ports. Choose the default network (bridge) to add ports.');
    for (const p of extraPorts) {
      const clash = apps.find((x) => x.ports.some((q) => q.public === p.public));
      if (clash) throw err('Port ' + p.public + ' is already used by ' + clash.name + '. Choose another port.', 409);
    }
    setAppNet({ name: '__check' }, network, String(body.ip || '').trim()); // checks the address
    const own = appNet.__check; delete appNet.__check;
    storeJobs[id] = { started: Date.now(), name, a, fields, webPort, network, own, extraPorts };
    return { job: id, name, file: '/opt/stacks/' + name + '/compose.yaml', warnings: storeWarnings(a, network) };
  }
  function storeJob(id) {
    const j = storeJobs[id]; if (!j) throw err('This installation is not (or no longer) known.', 404);
    const t = (Date.now() - j.started) / 1000;
    // Like the server: one line per layer that updates in place, and the progress from the layers.
    const layers = [['a2318d6c47ec', 31.2e6, 0.4, 2.6], ['3f4ca61aafcd', 0, 0, 0], ['9b0c51e7d2aa', 84.7e6, 0.6, 4.4], ['e11f0a3c88b2', 2.1e6, 0.8, 1.4]];
    const mb = (n) => (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'MB';
    const barTxt = (f) => '[' + '='.repeat(Math.max(0, Math.round(f * 50) - 1)) + '>' + ' '.repeat(50 - Math.max(1, Math.round(f * 50))) + ']';
    const pullEnd = 5.2, end = pullEnd + 1.6, done = t >= end;
    const state = layers.map(([id, size, from, to]) => {
      if (!size) return { id, line: id + ' Already exists', done: 1, cur: 0, size: 0 };
      if (t < from) return { id, line: id + ' Pulling fs layer', done: 0, cur: 0, size };
      if (t < to) { const f = (t - from) / (to - from); return { id, line: id + ' Downloading ' + barTxt(f) + '  ' + mb(f * size) + '/' + mb(size), done: 0.75 * f, cur: f * size, size }; }
      const x = Math.min(1, (t - to) / 0.7);
      if (x < 1) return { id, line: id + ' Extracting ' + barTxt(x) + '  ' + mb(x * size) + '/' + mb(size), done: 0.75 + 0.25 * x, cur: size, size };
      return { id, line: id + ' Pull complete', done: 1, cur: size, size };
    });
    const phase = t < pullEnd ? 'pull' : 'start';
    const lines = ['Compose file written: /opt/stacks/' + j.name + '/compose.yaml', 'Downloading image: ' + j.a.image,
      j.name + (phase === 'pull' ? ' Pulling' : ' Pulled'), ...state.map((x) => x.line)];
    if (phase === 'start') {
      lines.push('Starting the app…');
      if (!j.own) lines.push('Network ' + j.name + '_default  ' + (t < pullEnd + 0.4 ? 'Creating' : 'Created'));
      lines.push('Container ' + j.name + '  ' + (t < pullEnd + 0.8 ? 'Creating' : t < pullEnd + 1.3 ? 'Starting' : 'Started'));
    }
    const percent = done ? 100 : phase === 'start' ? 90 : 3 + Math.round(82 * state.reduce((acc, x) => acc + x.done, 0) / state.length);
    const progress = { phase: done ? 'done' : phase, percent, layers: state.length, layersDone: state.filter((x) => x.done >= 1).length,
      downloaded: state.reduce((acc, x) => acc + x.cur, 0), size: state.reduce((acc, x) => acc + x.size, 0) };
    if (done && !j.added) {
      j.added = true;
      const ownIp = j.own && ownIpNet(j.network);
      const ports = j.network === 'host' || j.network === 'none' || ownIp ? [] : j.fields.filter((f) => f.type === 'Port' && f.value)
        .map((f) => ({ public: Number(f.value), private: Number(f.target), type: /udp/.test(f.mode) ? 'UDP' : 'TCP' })).concat(ownIp ? [] : j.extraPorts || []);
      if (j.own) appNet[j.name] = j.own;
      const tplPort = j.a.webui && (j.a.webui.match(/\[PORT:(\d+)\]/) || [])[1];
      apps.push({ id: 'demo:' + j.name, name: j.name, image: /:[^/]+$/.test(j.a.image) ? j.a.image : j.a.image + ':latest', state: 'RUNNING', status: 'Up Less than a second', autoStart: true,
        icon: j.a.icon, webui: ownIp ? 'http://' + j.own.ip + (tplPort ? ':' + tplPort : '') + '/' : j.webPort ? 'http://[IP]:' + j.webPort + '/' : null, ports, compose: j.name, canUpdate: true, update: null,
        storeId: j.a.id, custom: !!j.custom,
        dataDirs: [...new Set(j.fields.filter((f) => f.type === 'Path' && f.value.startsWith(AD() + '/')).map((f) => f.value.split('/').slice(0, 4).join('/')))] });
      apps.sort((x, y) => x.name.localeCompare(y.name));
    }
    return { done, ok: done, error: null, name: j.name, webui: j.a.webui, lines, ...progress };
  }

  /* ---- own app: a few known images, as the registry would report them */
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
    if (!n) throw err('Paste the name of an image (e.g. nginx:latest or lscr.io/linuxserver/jellyfin) or a link to Docker Hub.');
    const info = IMAGES[n.repo];
    if (!info) throw err('The image ' + n.image + ' could not be read: this tag does not exist (anymore) in the registry.', 404);
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
      warnings: ports.length ? [] : ['The image reports no ports. If the app has a web interface, add a port yourself.'],
      networks: dnets.filter((x) => !x.builtin).map((x) => ({ name: x.name, driver: x.driver, subnet: x.subnet })), networkDefault: 'bridge',
      appdataDir: AD(), stacksDir: '/opt/stacks', appdataMissing: false, folders: bkFolders(),
    };
  }
  // Advanced install: the draft as a form and as code. The demo writes simple YAML and remembers the
  // form per code; code you changed yourself is read back as far as that is simple (image, and the rest of the last form).
  const drafts = {};
  const q = (v) => JSON.stringify(String(v));
  function draftYaml(name, f, labels) {
    const out = ['# Created with HomeBaseOS (demo).', 'name: ' + q(name), 'services:', '  ' + name + ':', '    image: ' + q(f.image), '    container_name: ' + q(name)];
    if (f.restart) out.push('    restart: ' + q(f.restart));
    if (f.network === 'host' || f.network === 'none') out.push('    network_mode: ' + q(f.network));
    else if (f.network) out.push('    networks:', '      ' + f.network + ':' + (f.ip ? '\n        ipv4_address: ' + q(f.ip) : ' null'));
    if (f.privileged) out.push('    privileged: true');
    const list = (k, arr) => { if (arr.length) out.push('    ' + k + ':', ...arr.map((x) => '      - ' + q(x))); };
    list('ports', f.ports.filter((p) => p.host || p.container).map((p) => p.host + ':' + p.container + '/' + (p.protocol || 'tcp')));
    list('volumes', f.volumes.filter((v) => v.host || v.container).map((v) => v.host + ':' + v.container + (v.mode === 'ro' ? ':ro' : '')));
    list('devices', f.devices.filter((d) => d.host).map((d) => d.host + ':' + (d.container || d.host)));
    const map = (k, arr) => { const a = arr.filter((x) => x.name); if (a.length) out.push('    ' + k + ':', ...a.map((x) => '      ' + x.name + ': ' + q(x.value))); };
    map('environment', f.env); map('labels', [...f.labels, ...labels]);
    if (f.network && !['host', 'none'].includes(f.network)) out.push('networks:', '  ' + f.network + ':', '    external: true');
    return out.join('\n') + '\n';
  }
  function demoDraft(b) {
    const name = String(b.name || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw err('Choose a name with lowercase letters, digits, - or _ (at most 63 characters).');
    const base = { service: name, restart: 'unless-stopped', privileged: false, network: '', ip: '', networkOther: null, networks: [], projectNetworks: [], build: false, otherServices: [] };
    let form, labels = [];
    if (b.store) {
      const a = store.find((x) => x.id === b.store); if (!a) throw err('This app is not (or no longer) in the catalogue.', 404);
      const fields = a.fields().map((f) => (f.key in (b.values || {}) ? { ...f, value: String(b.values[f.key]) } : f));
      const miss = fields.find((f) => f.required && !String(f.value).trim() && f.type !== 'Device'); if (miss) throw err('Fill in ' + miss.name + '.');
      const by = (t) => fields.filter((f) => f.type === t);
      form = { ...base, image: a.image, privileged: !!a.privileged, network: !b.network || b.network === 'bridge' ? '' : b.network, ip: String(b.ip || ''),
        ports: by('Port').filter((f) => f.value).map((f) => ({ host: f.value, container: f.target, protocol: /udp/i.test(f.mode) ? 'udp' : 'tcp' })).concat((b.extraPorts || []).map((p) => ({ ...p }))),
        volumes: by('Path').filter((f) => f.value).map((f) => ({ host: f.value, container: f.target, mode: /^ro\b|^r$/.test(f.mode || '') ? 'ro' : 'rw', kind: 'bind' })),
        env: by('Variable').map((f) => ({ name: f.target, value: f.value })), devices: by('Device').filter((f) => f.value).map((f) => ({ host: f.value, container: f.value })),
        labels: by('Label').map((f) => ({ name: f.target, value: f.value })) };
      labels = [{ name: 'homebaseos.store', value: a.id }];
    } else if (b.custom) {
      const c = b.custom;
      form = { ...base, image: c.image, restart: c.restart || 'unless-stopped', privileged: !!c.privileged, network: c.network === 'bridge' ? '' : c.network || '', ip: c.ip || '',
        ports: copy(c.ports || []), volumes: copy(c.volumes || []), env: copy(c.env || []), devices: copy(c.devices || []), labels: copy(c.labels || []) };
      labels = [{ name: 'homebaseos.custom', value: '1' }];
    } else {
      const text = String(b.text || '');
      if (!text.trim()) throw err('The compose file is empty.');
      if (!/^services:/m.test(text)) throw err('The compose file has no service (services).');
      const prev = drafts[name] || { form: { ...base, image: '', ports: [], volumes: [], env: [], devices: [], labels: [] }, labels: [] };
      if (b.form) { const f = { ...copy(b.form), service: name }; drafts[name] = { form: f, labels: prev.labels, text: draftYaml(name, f, prev.labels) }; return { text: drafts[name].text, form: copy(f), dockerNetworks: [] }; }
      if (prev.text === text) return { text, form: copy(prev.form), dockerNetworks: [] };
      const img = text.match(/^\s*image:\s*"?([^"\n]+)"?/m);
      const f = { ...copy(prev.form), image: img ? img[1].trim() : prev.form.image };
      // Ports and folders in the short syntax ("8080:80/tcp", "/folder:/target:ro") are read back too.
      const block = (k) => { const m = text.match(new RegExp('^\\s+' + k + ':\\s*\\n((?:\\s+-\\s.*\\n?)*)', 'm')); return m ? m[1].split('\n').map((l) => l.replace(/^\s*-\s*"?|"?\s*$/g, '')).filter(Boolean) : []; };
      f.ports = block('ports').map((x) => x.match(/^(\d+):(\d+)(?:\/(tcp|udp))?$/)).filter(Boolean).map((m) => ({ host: m[1], container: m[2], protocol: m[3] || 'tcp', ip: '' }));
      f.volumes = block('volumes').map((x) => x.split(':')).filter((a) => a.length >= 2).map(([h, c, m]) => ({ host: h, container: c, mode: m === 'ro' ? 'ro' : 'rw', kind: 'bind', locked: false }));
      drafts[name] = { form: f, labels: prev.labels, text };
      return { text, form: copy(f), dockerNetworks: [] };
    }
    const text = draftYaml(name, form, labels);
    drafts[name] = { form, labels, text };
    return { text, form: copy(form), dockerNetworks: dnets.filter((n) => !n.builtin).map((n) => ({ name: n.name, driver: n.driver, subnet: n.subnet })) };
  }
  function demoInstallCompose(b) {
    const name = String(b.name || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw err('Choose a name with lowercase letters, digits, - or _ (at most 63 characters).');
    if (apps.some((x) => x.name === name)) throw err('An app named ' + name + ' already exists. Choose another name.', 409);
    const text = String(b.text || '');
    if (!/^services:/m.test(text)) throw err('The compose file has no service (services).');
    const img = text.match(/^\s*image:\s*"?([^"\n]+)"?/m);
    const sid = (text.match(/homebaseos\.store:\s*"?([\w-]+)/) || [])[1], a = store.find((x) => x.id === sid);
    // Ports from the code ("8080:80/tcp"), so the app gets its ports and WebUI in the list.
    const fields = [...text.matchAll(/^\s*-\s*"?(\d+):(\d+)(?:\/(tcp|udp))?"?\s*$/gm)].map((m) => ({ type: 'Port', value: m[1], target: m[2], mode: m[3] || 'tcp' }))
      .concat([...text.matchAll(/^\s*-\s*"?(\/[^:"\s]+):\/[^"\s]*"?\s*$/gm)].map((m) => ({ type: 'Path', value: m[1] })));
    const port = a && a.webui && (a.webui.match(/\[PORT:(\d+)\]/) || [])[1], web = fields.find((f) => f.type === 'Port' && (!port || f.target === port));
    const id = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
    storeJobs[id] = { started: Date.now(), name, a: { id: a ? a.id : null, image: img ? img[1].trim() : 'app', webui: a ? a.webui : null, icon: a ? a.icon : ICON(name) }, custom: !a,
      fields, webPort: web ? web.value : null, network: 'bridge', own: null, extraPorts: [] };
    return { job: id, name, file: '/opt/stacks/' + name + '/compose.yaml' };
  }
  function demoInstallCustom(b) {
    const name = String(b.name || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw err('Choose a name with lowercase letters, digits, - or _ (at most 63 characters).');
    if (apps.some((x) => x.name === name)) throw err('An app named ' + name + ' already exists. Choose another name.', 409);
    const n = demoNormalize(b.image); if (!n) throw err('Paste the name of an image (e.g. nginx:latest or lscr.io/linuxserver/jellyfin) or a link to Docker Hub.');
    const network = b.network || 'bridge';
    const noPorts = network === 'host' || network === 'none' || ownIpNet(network);
    const extraPorts = noPorts ? [] : (b.ports || []).filter((p) => p.host || p.container).map((p) => {
      if (!/^\d{1,5}$/.test(String(p.container))) throw err('Port in the app "' + p.container + '" is not a valid port.');
      if (!/^\d{1,5}$/.test(String(p.host))) throw err('Port on the server "' + p.host + '" is not a valid port.');
      const clash = apps.find((x) => x.ports.some((q) => String(q.public) === String(p.host)));
      if (clash) throw err('Port ' + p.host + ' is already used by ' + clash.name + '. Choose another port.', 409);
      return { public: Number(p.host), private: Number(p.container), type: p.protocol === 'udp' ? 'UDP' : 'TCP' };
    });
    for (const v of b.volumes || []) if (v.container && !String(v.container).startsWith('/')) throw err('The folder in the app "' + v.container + '" must start with /.');
    setAppNet({ name: '__check' }, network, String(b.ip || '').trim());
    const own = appNet.__check; delete appNet.__check;
    const webPort = (() => { const m = String(b.webui || '').match(/\[PORT:(\d+)\]/); const p = m && extraPorts.find((x) => String(x.private) === m[1]); return p ? p.public : null; })();
    const id = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
    storeJobs[id] = { started: Date.now(), name, a: { id: null, image: n.image, webui: b.webui || null, icon: b.icon || ICON(n.repo.split('/').pop()) }, custom: true,
      fields: (b.volumes || []).map((v) => ({ type: 'Path', value: String(v.host || '') })), webPort, network, own, extraPorts };
    return { job: id, name, file: '/opt/stacks/' + name + '/compose.yaml' };
  }

  /* ---- VMs: Ubuntu shows the start delay (starts 45 s after opening the demo) */
  const vms = [
    { name: 'Home Assistant OS', state: 'RUNNING', vcpus: 2, memory: 4 * GB, diskGb: 32, autostart: true, delay: 0,
      description: 'Home automation: lights, heating and the smart meter.', base: [3, 14], ram: [0.45, 0.55] },
    { name: 'Windows 11', state: 'SHUTOFF', vcpus: 4, memory: 8 * GB, diskGb: 64, autostart: false, delay: 0, description: '', base: [5, 30], ram: [0.6, 0.75] },
    { name: 'Ubuntu Server (test)', state: 'SHUTOFF', vcpus: 2, memory: 2 * GB, diskGb: 32, autostart: true, delay: 60,
      description: 'For trying things out.', base: [1, 8], ram: [0.3, 0.4], startsAt: Date.now() + 45000 },
  ];
  const DEMO_IPS = { 'Home Assistant OS': ['192.168.1.40', 'fd00::5054:ff:fe6b:3c58'], 'Windows 11': ['192.168.122.45'], 'Ubuntu Server (test)': ['10.10.0.130'] };
  const VNC_PW = { 'Home Assistant OS': 'q7Rk2mPa', 'Windows 11': 'Zt4wLs9e', 'Ubuntu Server (test)': 'Hn3vB8xc' };
  // Hardware per VM, in the same shape as lib/vmhw.js parseHardware().
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
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,31}$/.test(name)) throw err('Choose a name with letters, digits, -, _ or . (at most 32 characters), e.g. lab.');
    if (vmNets.some((n) => n.name === name)) throw err('A VM network named ' + name + ' already exists. Choose another name.', 409);
    const text = String(b.subnet || '').trim(), c = cidr(text, 16, 28);
    if (!c) throw err('"' + text + '" is not a valid subnet. Choose something like 192.168.150.0/24 (netmask between /16 and /28).');
    if (!['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].some((p) => { const q = cidr(p, 8, 16); return overlap(q, c) && c.prefix >= q.prefix; })) throw err('Choose a private subnet: 10.x.x.x, 172.16–31.x.x or 192.168.x.x.');
    const clash = vmNets.concat([{ name: 'br0', subnet: '192.168.1.0/24' }, { name: 'docker0', subnet: '172.17.0.0/16' }]).find((n) => overlap(c, cidr(n.subnet, 0, 32)));
    if (clash) throw err('The subnet ' + c.text + ' overlaps with ' + clash.name + ' (' + clash.subnet + '). Choose another subnet.', 409);
    const ip = (n) => [16777216, 65536, 256, 1].map((d) => Math.floor(n / d) % 256).join('.');
    vmNets.push({ name, mode: b.mode === 'isolated' ? 'isolated' : 'nat', bridge: 'virbr' + vmNets.length, hostBridge: null, address: ip(c.base + 1), subnet: c.text,
      dhcp: b.dhcp === false ? null : { start: ip(c.base + c.size / 2), end: ip(c.base + c.size - 2) }, active: true, autostart: true });
    return { name };
  }
  function vmNetDelete(name) {
    const n = vmNetList().networks.find((x) => x.name === name);
    if (!n) throw err('This VM network no longer exists.', 404);
    if (n.vms.length) throw err('The VM network ' + name + ' is still used by ' + (n.vms.join(', ')) + '. Choose another network for those VMs first.', 409);
    vmNets.splice(vmNets.findIndex((x) => x.name === name), 1);
    return { removed: name };
  }
  const USB = [{ key: 'usb:10c4:ea60', bus: 1, device: 4, vendor: '10c4', product: 'ea60', name: 'Silicon Labs CP210x UART Bridge (Sonoff Zigbee 3.0 Dongle Plus)' },
    { key: 'usb:0658:0200', bus: 1, device: 5, vendor: '0658', product: '0200', name: 'Sigma Designs Aeotec Z-Stick Gen5 (ZW090)' },
    { key: 'usb:0781:5583', bus: 2, device: 2, vendor: '0781', product: '5583', name: 'SanDisk Ultra Fit' }];
  const PCI = [
    { key: 'pci:0000:0a:00.0', address: '0000:0a:00.0', kind: 'Display', name: 'NVIDIA GeForce RTX 3060 Ti', group: '14', groupDevices: [{ address: '0000:0a:00.1', name: 'NVIDIA GA104 High Definition Audio Controller' }], driver: 'nvidia' },
    { key: 'pci:0000:0a:00.1', address: '0000:0a:00.1', kind: 'Audio', name: 'NVIDIA GA104 High Definition Audio Controller', group: '14', groupDevices: [{ address: '0000:0a:00.0', name: 'NVIDIA GeForce RTX 3060 Ti' }], driver: 'snd_hda_intel' },
    { key: 'pci:0000:05:00.0', address: '0000:05:00.0', kind: 'Network', name: 'Realtek RTL8125 2.5GbE Controller', group: '11', groupDevices: [], driver: 'r8169' },
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
  const findVm = (id) => { const v = vms.find((x) => x.name === decodeURIComponent(id)); if (!v) throw err('This VM does not exist (anymore).', 404); return v; };
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
  // Save hardware, with the same checks as lib/vmhw.js validateHardware().
  function demoSaveHw(v, b) {
    const h = hwOf(v), opts = vmOptions();
    let changed = false;
    if (Array.isArray(b.nics)) {
      const macs = new Set();
      const nics = b.nics.map((n) => {
        if (n.locked) return h.nics.find((x) => x.mac === n.id);
        if (n.type === 'network' && !opts.networks.some((x) => x.name === n.source)) throw err('The VM network "' + n.source + '" does not exist. Choose another network.');
        if (n.type === 'bridge' && !opts.bridges.some((x) => x.name === n.source)) throw err('The bridge "' + n.source + '" does not exist on the server. Create it in Settings → Network.');
        const mac = String(n.mac || '').trim().toLowerCase() || '52:54:00:' + [0, 0, 0].map(() => Math.floor(rnd(16, 255)).toString(16)).join(':');
        if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || parseInt(mac.slice(0, 2), 16) & 1) throw err('"' + mac + '" is not a valid MAC address, e.g. 52:54:00:12:34:56.');
        if (macs.has(mac)) throw err('The MAC address ' + mac + ' is listed twice.');
        macs.add(mac);
        return nic(n.type, n.source, n.model || 'virtio', mac);
      });
      if (JSON.stringify(nics) !== JSON.stringify(h.nics)) { h.nics = nics; changed = true; }
    }
    if (b.cdrom !== undefined && b.cdrom !== '=') {
      if (b.cdrom && !opts.isos.some((f) => f.name === b.cdrom)) throw err('Choose an ISO from /tank/isos.');
      h.cdrom = b.cdrom ? '/tank/isos/' + b.cdrom : null; // swaps right away, also while the VM runs
    }
    if (b.boot && b.boot !== h.boot) { h.boot = b.boot; changed = true; }
    if (b.clipboard !== undefined && !!b.clipboard !== !!h.clipboard) { h.clipboard = !!b.clipboard; changed = true; }
    if (Array.isArray(b.hostdevs) && b.hostdevs.join() !== h.hostdevs.join()) {
      for (const k of b.hostdevs) if (!h.hostdevs.includes(k) && !USB.concat(PCI).some((x) => x.key === k)) throw err('This USB device is not plugged in (anymore). Plug it in and open the window again.');
      h.hostdevs = [...b.hostdevs]; changed = true;
    }
    if (Array.isArray(b.cpuPins) && b.cpuPins.join() !== h.cpuPins.join()) {
      if (new Set(b.cpuPins).size !== b.cpuPins.length) throw err('Each core can only be chosen once.');
      h.cpuPins = [...b.cpuPins]; changed = true;
      if (h.cpuPins.length) b.vcpus = h.cpuPins.length;
    }
    const sizes = v.disks || (v.disks = [{ target: 'vda', size: v.diskGb * GB }]);
    for (const r of b.resizeDisks || []) {
      const dk = sizes.find((x) => x.target === r.target);
      if (dk && r.sizeGb * GB < dk.size) throw err('A disk can only grow. ' + dk.target + ' is now ' + (Math.ceil(dk.size / GB)) + ' GB.');
      if (dk) dk.size = r.sizeGb * GB;
    }
    if ((b.removeDisks || []).length) { v.disks = sizes.filter((x) => !b.removeDisks.includes(x.target)); changed = true; }
    for (const a of b.addDisks || []) {
      if (!(a.sizeGb >= 1 && a.sizeGb <= 16384)) throw err('The disk size (GB) must be between 1 and 16384.');
      const pre = a.bus === 'sata' ? 'sd' : 'vd', used = v.disks.map((x) => x.target);
      let tgt; for (let i = 0; i < 26 && !tgt; i++) if (!used.includes(pre + String.fromCharCode(97 + i))) tgt = pre + String.fromCharCode(97 + i);
      v.disks.push({ target: tgt, size: a.sizeGb * GB, file: '/tank/vms/' + slug(v.name) + '/' + slug(v.name) + '-' + (v.disks.length + 1) + '.qcow2' });
      changed = true;
    }
    return changed;
  }
  const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,62}$/;
  function checkFields(b) {
    if (b.name !== undefined && !NAME.test(String(b.name).trim())) throw err('Choose a name of 1 to 63 characters: letters, digits, spaces and . _ - ( ).');
    if (!(b.vcpus >= 1 && b.vcpus <= 16)) throw err("The number of vCPUs must be between 1 and 16.");
    if (!(b.memoryGb >= 0.25 && b.memoryGb <= 32)) throw err('Memory must be between 0.25 and 32 GB.');
    if (b.delay != null && !(b.delay >= 0 && b.delay <= 3600)) throw err('The start delay must be between 0 and 3600.');
  }

  /* ---- storage: ZFS */
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
    disk('nvme0n1', 'Samsung 980', 512e9, false, 'nvme', 41, 'fast', 'mirror'),
    disk('nvme1n1', 'Samsung 980', 512e9, false, 'nvme', 39, 'fast', 'mirror'),
    // Still free: two new 4 TB disks and an old one with NTFS, to create a pool.
    disk('sde', 'ST4000VN006 IronWolf', 4e12, true, 'sata', 31, null, null),
    disk('sdf', 'ST4000VN006 IronWolf', 4e12, true, 'sata', 32, null, null),
    disk('sdg', 'WDC WD30EFRX', 3e12, true, 'sata', 30, null, null),
    disk('sdi', 'Samsung SSD 870 EVO', 1e12, false, 'sata', 29, null, null),
  ];
  // What lib/zpool.js poolOptions() returns (the system disk sdh is not among Storage's disks).
  const SYS_DISK = { name: 'sdh', size: 240e9, model: 'KINGSTON SA400S37240G', serial: 'DEMOSDH', rotational: false, transport: 'sata', byId: '/dev/disk/by-id/ata-KINGSTON_SA400S37240G_DEMOSDH', available: false, reason: 'System disk (Debian is on it)', warn: null };
  // Details of a disk, as lib/disks.js parseSmart() gives them. sdc is asleep, sdd has a few reallocated sectors.
  const smartState = {};
  function demoDisk(name, wake) {
    const d = disks.find((x) => x.name === name);
    if (!d) throw err('The disk ' + name + ' no longer exists.', 404);
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
    if (!['short', 'long'].includes(type)) throw err('Choose a short or a long test.');
    const st = smartState[name] || (smartState[name] = { tests: [] });
    if (st.running) throw err('The disk refused the test. Maybe one is already running.', 409);
    const total = type === 'short' ? 20000 : 45000; // much faster in the demo than for real
    st.running = { type, until: Date.now() + total, total };
    return { started: true, minutes: type === 'short' ? 2 : 252 };
  }
  function poolOptions() {
    const list = disks.map((d) => ({ name: d.name, size: d.size, model: d.model, serial: d.serial, rotational: d.rotational, transport: d.transport,
      byId: '/dev/disk/by-id/' + (d.transport === 'nvme' ? 'nvme-' : 'ata-') + d.model.replace(/\s+/g, '_') + '_' + d.serial,
      available: !d.pool, reason: d.pool ? 'In pool ' + d.pool : null, warn: d.name === 'sdg' ? 'Has partitions (ntfs). They will be erased.' : null })).concat(copy(SYS_DISK));
    return { disks: list.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name, undefined, { numeric: true })),
      pools: pools.map((p) => p.name), layouts: ['stripe', 'mirror', 'raidz1', 'raidz2', 'raidz3', 'mirrors'], compression: ['lz4', 'zstd', 'off'] };
  }
  function demoCreatePool(b) {
    const name = String(b.name || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name) || /^(mirror|raidz\d?|draid\d?|spare|log|cache|special|dedup|c\d+)/i.test(name)) throw err('Choose a name that starts with a letter, with letters, digits, - or _ (e.g. tank or fast). Names like mirror or raidz are not allowed.');
    if (pools.some((p) => p.name === name)) throw err('A pool named ' + name + ' already exists.', 409);
    const MIN = { stripe: 1, mirror: 2, raidz1: 3, raidz2: 4, raidz3: 5, mirrors: 4 };
    if (!MIN[b.layout]) throw err('Choose a layout: stripe, mirror, RAID-Z1, RAID-Z2, RAID-Z3 or mirror pairs.');
    const opts = poolOptions();
    const chosen = [...new Set(b.disks || [])].map((n) => {
      const d = opts.disks.find((x) => x.name === n);
      if (!d) throw err('The disk ' + n + ' no longer exists. Open the window again.');
      if (!d.available) throw err('You cannot use ' + n + ': ' + d.reason + '.', 409);
      return d;
    });
    if (chosen.length < MIN[b.layout]) throw err('This layout needs at least ' + MIN[b.layout] + ' disks.');
    if (b.layout === 'mirrors' && chosen.length % 2) throw err('Mirror pairs need an even number of disks.');
    if (b.confirm !== name) throw err('Type the pool name to confirm that the disks may be erased.');
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
    return { name, folders, uses: [] }; // in the demo app data, VMs and ISOs already have a place
  }
  /* ---- storage locations (Settings → Storage) and moving app data (simulated, ~10 s) */
  let spJob = null;
  const FOLDER = { appdata: 'appdata', vms: 'vms', isos: 'isos', shares: '' };
  const spPools = () => pools.map((p) => ({ name: p.name, mountpoint: '/' + p.name, free: p.free }));
  const spApps = () => apps.filter((a) => a.compose && a.dataDirs.some((x) => x.startsWith(sp.appdata + '/')));
  function spMigration() {
    if (!spJob) return null;
    const el = Date.now() - spJob.start, n = spJob.apps.length;
    const lines = [...spJob.apps.map((a) => 'Stopping ' + a + '…'), 'Copying from ' + spJob.from + ' to ' + spJob.to + '…'];
    let step = 'stop', percent = 0, state = 'running';
    if (el > 1500) { step = 'copy'; percent = Math.min(100, Math.round(((el - 1500) / 7000) * 100)); }
    if (el > 8500) { step = 'compose'; lines.push(...spJob.apps.map((a) => 'Changed: /opt/stacks/' + a + '/compose.yaml (backup copy: compose.yaml.bak)')); }
    if (el > 9500) { step = 'start'; lines.push(...spJob.apps.map((a) => 'Starting ' + a + '…')); }
    if (el > 10500) {
      step = 'done'; state = 'done'; lines.push('Done. The old folder ' + spJob.from + ' stays: remove it yourself when everything works.');
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
    if (b.path) {
      // Point to an existing folder: in the demo every folder under a pool exists.
      if (!['appdata', 'vms', 'isos', 'shares'].includes(b.kind)) throw err('Unknown kind of folder.');
      const dir = String(b.path).trim().replace(/(.)\/+$/, '$1');
      if (!dir.startsWith('/')) throw err('Choose a full path, e.g. /tank/appdata.');
      if (!spPools().some((x) => dir === x.mountpoint || dir.startsWith(x.mountpoint + '/'))) throw err('The folder ' + dir + ' does not exist.');
      sp[b.kind] = dir; return spGet();
    }
    const p = spPools().find((x) => x.name === b.pool);
    if (!p) throw err('Choose a pool.');
    if (b.kind === 'appdata') {
      const m = spMigration();
      if (m && m.state === 'running') throw err('A move is already running. Wait until it is done.', 409);
      const to = p.mountpoint + '/appdata';
      if (to === sp.appdata) throw err('The app data is already on ' + p.name + '.');
      spJob = { start: Date.now(), from: sp.appdata, to, apps: spApps().map((a) => a.compose) };
      return { started: true, migration: spMigration() };
    }
    if (!['vms', 'isos', 'shares'].includes(b.kind)) throw err('Unknown kind of folder.');
    sp[b.kind] = p.mountpoint + (FOLDER[b.kind] ? '/' + FOLDER[b.kind] : '');
    return spGet();
  }
  const pools = [
    { name: 'tank', health: 'ONLINE', used: 3.3 * TB, free: 2.05 * TB, layout: 'raidz1', diskCount: 4,
      scrub: { kind: 'scrub', running: false, progress: null, errors: 0, last: new Date(Date.now() - 9 * 86400000).toISOString() } },
    { name: 'fast', health: 'ONLINE', used: 190 * GB, free: 271 * GB, layout: 'mirror', diskCount: 2,
      scrub: { kind: 'scrub', running: false, progress: null, errors: 0, last: new Date(Date.now() - 9 * 86400000).toISOString() } },
  ].map((p) => ({ ...p, total: p.used + p.free }));
  const datasets = [
    ['tank/media', 2.1 * TB, 1.0], ['tank/photos', 610 * GB, 1.01], ['tank/documents', 84 * GB, 1.42], ['tank/backups', 420 * GB, 1.18],
    ['tank/isos', 12 * GB, 1.0], ['tank/vms', 96 * GB, 1.31], ['fast/appdata', 162 * GB, 1.65], ['fast/docker', 28 * GB, 1.52],
  ].map(([name, used, compress]) => ({ name, used, free: name.startsWith('tank') ? 2.05 * TB : 271 * GB, mountpoint: '/' + name, compress }));
  // Disk bays: 8 bays (the four HDDs of tank, three free disks, one empty), 2 M.2 slots with the NVMes of fast and 2 slots of 2.5" (one SSD).
  let bays = { count: 8, columns: 8, m2: 2, ssd: 2, slots: Object.fromEntries([['sda', 1], ['sdb', 2], ['sdc', 3], ['sdd', 4], ['sde', 5], ['sdf', 6], ['sdg', 7],
    ['nvme0n1', 'm1'], ['nvme1n1', 'm2'], ['sdi', 's1']].map(([n, id]) => [id, { key: 's:DEMO' + n.toUpperCase(), label: 'DEMO' + n.toUpperCase() }])) };
  function saveBays(b) {
    const count = Number(b.count), columns = Number(b.columns), m2 = Number(b.m2 || 0), ssd = Number(b.ssd || 0);
    if (!Number.isInteger(count) || count < 0 || count > 60) throw err('Choose between 0 and 60 bays.');
    if (!Number.isInteger(columns) || columns < 1 || columns > 12) throw err('Choose between 1 and 12 columns.');
    if (!Number.isInteger(m2) || m2 < 0 || m2 > 8) throw err('Choose between 0 and 8 M.2 slots.');
    if (!Number.isInteger(ssd) || ssd < 0 || ssd > 16) throw err('Choose between 0 and 16 2.5" slots.');
    const slots = {}, seen = new Set();
    for (const [id, v] of Object.entries(b.slots || {})) {
      const m = String(id).match(/^([ms]?)(\d+)$/); const n = m ? Number(m[2]) : 0;
      if (!m || n < 1 || n > ({ '': count, m: m2, s: ssd })[m[1]]) continue;
      if (seen.has(v.key)) throw err('A disk can only be in one bay.');
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

  /* ---- snapshots of VMs */
  const vmSnaps = {
    'Home Assistant OS': [
      { name: 'before-2026.10', description: 'Before the update to Home Assistant 2026.10', state: 'running', created: Date.now() - 6 * 86400000, parent: null, memory: true, current: false },
      { name: 'snapshot-20261021-2210', description: '', state: 'running', created: Date.now() - 2 * 86400000, parent: 'before-2026.10', memory: false, current: true },
    ],
  };
  function snapRoute(method, path, body) {
    const m = path.match(/^\/api\/vms\/([^/]+)\/snapshots(?:\/([^/]+))?(\/revert)?$/);
    if (!m) return undefined;
    const v = findVm(m[1]), list = vmSnaps[v.name] || (vmSnaps[v.name] = []);
    const name = m[2] ? decodeURIComponent(m[2]) : null;
    if (method === 'GET') return { snapshots: copy(list).sort((a, b) => b.created - a.created) };
    if (method === 'POST' && !name) {
      const p = (x) => String(x).padStart(2, '0'), d = new Date();
      const n = String(body.name || '').trim() || `snapshot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(n)) throw err('Choose a name with letters, digits, dot, - or _ (at most 48 characters), e.g. before-update.');
      if (list.some((x) => x.name === n)) throw err('A snapshot named ' + n + ' already exists.', 409);
      const on = v.state === 'RUNNING';
      const cur = list.find((x) => x.current);
      list.forEach((x) => { x.current = false; });
      list.push({ name: n, description: String(body.description || '').trim().slice(0, 200), state: on ? 'running' : 'shutoff', created: Date.now(), parent: cur ? cur.name : null, memory: on && !body.diskOnly, current: true });
      return { name: n, memory: on && !body.diskOnly };
    }
    const s = list.find((x) => x.name === name);
    if (!s) throw err('This snapshot doesn\'t exist (anymore).', 404);
    if (method === 'POST' && m[3]) { list.forEach((x) => { x.current = x === s; }); v.state = s.memory ? 'RUNNING' : 'SHUTOFF'; return { reverted: name }; }
    if (method === 'DELETE') { list.splice(list.indexOf(s), 1); if (s.current && list.length) list[list.length - 1].current = true; return { removed: name }; }
    return undefined;
  }

  /* ---- backups of apps and VMs */
  const sysUnits = () => {
    const by = new Map();
    for (const a of apps) {
      const id = a.compose ? 'compose:' + a.compose : 'container:' + a.name;
      if (!by.has(id)) by.set(id, { id, name: a.compose || a.name, compose: !!a.compose, workingDir: a.compose ? '/opt/stacks/' + a.compose : null, containers: [], paths: [], skipped: [] });
      const u = by.get(id);
      u.containers.push({ id: a.id, name: a.name, state: a.state.toLowerCase(), image: a.image });
      if (a.compose) u.paths = ['/opt/stacks/' + a.compose + '/compose.yaml'];
      u.paths = [...new Set([...u.paths, AD() + '/' + a.name])].sort();
      if (a.name === 'jellyfin') u.skipped = [{ path: '/tank/media', reason: 'outside the app data' }];
      if (a.name === 'dockge') u.skipped = [{ path: '/var/run/docker.sock', reason: 'system' }];
    }
    return [...by.values()].sort((x, y) => x.name.localeCompare(y.name));
  };
  const sysJobs = [{
    id: 'd4e5f6a7', name: 'Apps and Home Assistant', dest: '/tank/backups/system', apps: ['compose:immich', 'compose:smarthome', 'compose:vaultwarden', 'compose:paperless'],
    vms: ['Home Assistant OS'], stopApps: true, vmMode: 'live', keep: 7, schedule: { every: 'daily', time: '02:00', day: 0 }, created: Date.now() - 30 * 86400000,
    lastScheduled: Date.now() - 8 * HOUR, lastRun: null, history: [],
  }];
  sysJobs[0].lastRun = { kind: 'backup', scheduled: true, started: Date.now() - 8 * HOUR, ended: Date.now() - 8 * HOUR + 14 * 60000, state: 'ok', stamp: '', size: 41 * GB, items: 5, errors: 0, error: null };
  sysJobs[0].history = [sysJobs[0].lastRun];
  const sysLive = {}, sysLogs = {};
  const sysRuns = { d4e5f6a7: [0, 1, 2].map((dd) => ({ stamp: new Date(Date.now() - (dd + 0.33) * 86400000).toISOString().slice(0, 10) + '_020000', created: Date.now() - (dd + 0.33) * 86400000, size: (41 - dd) * GB, errors: [],
    apps: ['immich', 'smarthome', 'vaultwarden', 'paperless'].map((n) => ({ id: 'compose:' + n, name: n, size: rnd(0.2, 6) * GB, error: null, file: true })),
    vms: [{ name: 'Home Assistant OS', size: 9.6 * GB, error: null, mode: 'live' }] })) };
  function sysInfo(id) {
    const r = sysLive[id]; if (!r) return null;
    const f = Math.min(1, (Date.now() - r.started) / r.dur), done = Math.floor(f * r.total);
    if (f >= 1 || r.cancelled) {
      const j = sysJobs.find((x) => x.id === id);
      const entry = { kind: 'backup', scheduled: false, started: r.started, ended: Date.now(), state: r.cancelled ? 'cancelled' : 'ok', stamp: '', size: r.cancelled ? 0 : rnd(20, 45) * GB, items: r.total, errors: 0, error: null };
      sysLogs[id] = r.lines.concat(r.names.slice(0, done || r.total).map((n) => ({ time: new Date().toISOString(), level: 'info', text: n + ': done' })), [{ time: new Date().toISOString(), level: r.cancelled ? 'error' : 'info', text: r.cancelled ? 'Stopped.' : 'Done.' }]);
      if (j) { j.history = [entry, ...j.history].slice(0, 20); j.lastRun = entry; if (!r.cancelled) (sysRuns[id] = sysRuns[id] || []).unshift({ stamp: new Date().toISOString().slice(0, 10) + '_nu', created: Date.now(), size: entry.size, errors: [],
        apps: j.apps.map((a) => ({ id: a, name: a.split(':')[1], size: rnd(0.2, 6) * GB, error: null, file: true })), vms: j.vms.map((v) => ({ name: v, size: 9.6 * GB, error: null, mode: j.vmMode })) }); }
      delete sysLive[id];
      return null;
    }
    return { kind: 'backup', started: r.started, current: r.names[done] || null, done, total: r.total, percent: Math.round(((f * r.total) % 1) * 100) };
  }
  const sysPublic = (j) => ({ ...copy(j), next: bkNext(j.schedule, j.lastScheduled || j.created), running: sysInfo(j.id) });
  function sysValidate(b) {
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw err('Give the task a name, e.g. Apps and Home Assistant.');
    const dest = String(b.dest || '').trim().replace(/(.)\/+$/, '$1');
    if (!dest.startsWith('/') || !bkFolders().some((r) => dest === r || dest.startsWith(r + '/'))) throw err('Choose a folder on one of your pools, e.g. /tank/photos.');
    if (pools.some((p) => '/' + p.name === dest)) throw err('Choose a folder of its own to store in, e.g. /tank/backups/google-drive, not the whole pool.');
    const a = [...new Set(Array.isArray(b.apps) ? b.apps : [])], v = [...new Set(Array.isArray(b.vms) ? b.vms : [])];
    if (!a.length && !v.length) throw err('Choose at least one app or VM.');
    const s = b.schedule || {};
    return { name, dest, apps: a, vms: v, stopApps: b.stopApps !== false, vmMode: b.vmMode === 'shutdown' ? 'shutdown' : 'live', keep: Math.min(365, Math.max(1, Math.round(Number(b.keep) || 7))),
      schedule: { every: ['manual', 'hourly', 'daily', 'weekly'].includes(s.every) ? s.every : 'manual', time: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '') ? s.time : '02:00', day: Number(s.day) >= 0 && Number(s.day) <= 6 ? Number(s.day) : 0 } };
  }
  function sysRoute(method, path, body) {
    if (path === '/api/sysbackups' && method === 'GET') {
      return { jobs: sysJobs.map(sysPublic), apps: sysUnits(), vms: vms.map((v) => ({ name: v.name, state: v.state })), folders: bkFolders(), defaultDest: '/tank/backups/system' };
    }
    if (path === '/api/sysbackups' && method === 'POST') {
      const j = { id: Math.random().toString(16).slice(2, 10).padEnd(8, '0'), ...sysValidate(body), created: Date.now(), lastScheduled: Date.now(), lastRun: null, history: [] };
      sysJobs.push(j); return sysPublic(j);
    }
    const m = path.match(/^\/api\/sysbackups\/([0-9a-f]{8})(?:\/(run|stop|log|runs|restore))?$/);
    if (!m) return undefined;
    const j = sysJobs.find((x) => x.id === m[1]); if (!j) throw err('This task doesn\'t exist (anymore).', 404);
    const act = m[2];
    if (!act && method === 'POST') { if (sysInfo(j.id)) throw err('This task is running now. Stop it first, or wait until it is done.', 409); Object.assign(j, sysValidate(body)); return sysPublic(j); }
    if (!act && method === 'DELETE') { if (sysInfo(j.id)) throw err('This task is running now. Stop it first, or wait until it is done.', 409); sysJobs.splice(sysJobs.indexOf(j), 1); return { removed: j.id }; }
    if (act === 'log') { const r = sysInfo(j.id); return { running: r, lines: copy(r ? sysLive[j.id].lines : sysLogs[j.id] || []), last: j.history[0] || null }; }
    if (act === 'runs') return { dest: j.dest, runs: copy(sysRuns[j.id] || []) };
    if (act === 'run') {
      if (sysInfo(j.id)) throw err('This task is already running.', 409);
      const names = [...j.apps.map((a) => a.split(':')[1]), ...j.vms];
      sysLive[j.id] = { started: Date.now(), dur: 9000 + names.length * 2500, total: names.length, names, cancelled: false,
        lines: [{ time: new Date().toISOString(), level: 'info', text: 'To ' + j.dest }] };
      return { started: true };
    }
    if (act === 'stop') { if (!sysInfo(j.id)) throw err('This task isn\'t running.', 409); sysLive[j.id].cancelled = true; return { stopping: true }; }
    if (act === 'restore') {
      if (body.vm) { const v = vms.find((x) => x.name === body.vm); if (v && v.state !== 'SHUTOFF') throw err('Turn ' + body.vm + ' off first. Then you can restore the backup.', 409); if ((vmSnaps[body.vm] || []).length) throw err(body.vm + ' has snapshots. Remove them first: the backup disks don\'t fit in that chain.', 409); return { restored: body.vm, moved: [] }; }
      if (body.app) return { restored: body.app.split(':')[1], moved: [] };
      throw err('Choose an app or VM to restore.');
    }
    return undefined;
  }

  async function get(path) {
    await wait(rnd(120, 300));
    { const r = path.includes('/snapshots') ? snapRoute('GET', path) : path.startsWith('/api/sysbackups') ? sysRoute('GET', path) : undefined; if (r !== undefined) return r; }
    if (path === '/api/config') return { demo: true, needsLogin: false, ollama: true, language: demoLang(), clock: demoClock(), onboarding: !onbDone(), setup: !onbDone(), loginUser: true };
    if (path === '/api/storage-paths') return spGet();
    if (path === '/api/backup' || path === '/api/backup?brief=1') return bkGet(path.endsWith('brief=1'));
    const bkb = path.match(/^\/api\/backup\/remotes\/([^/]+)\/browse\?path=(.*)$/);
    if (bkb) { await wait(rnd(300, 700)); return bkBrowse(decodeURIComponent(bkb[1]), decodeURIComponent(bkb[2])); }
    const bkl = path.match(/^\/api\/backup\/jobs\/([0-9a-f]{8})\/log$/);
    if (bkl) {
      if (!bkJobs.some((j) => j.id === bkl[1])) throw err('This task doesn\'t exist (anymore).', 404);
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
    if (path === '/api/docker-networks/lan') { // like lanInfo() in lib/dockernet.js
      await wait(rnd(300, 700));
      const lan = dnets.find((n) => /^(macvlan|ipvlan)$/.test(n.driver)), used = new Set(Object.values(appNet).map((x) => x.ip));
      let suggestion = null;
      for (let i = 194; i < 223 && !suggestion; i++) if (!used.has('192.168.1.' + i)) suggestion = '192.168.1.' + i;
      return { choice: '@lan', network: lan ? lan.name : null, home: { name: 'br0', kind: 'bridge', address: '192.168.1.10', subnet: '192.168.1.0/24', gateway: '192.168.1.1' }, ipRange: lan ? lan.ipRange : '192.168.1.224/27', suggestion };
    }
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
      return { updated: Date.now() - 86400000, fetched: Date.now(), error: null, source: 'Unraid Community Apps (demo: 16 examples)', count: store.length,
        categories: Object.entries(CATS_NL).filter(([k]) => used.has(k)).map(([id, name]) => ({ id, name })),
        apps: store.map((a) => ({ id: a.id, name: a.name, image: a.image, icon: a.icon, summary: a.summary, categories: a.categories, maintainer: a.maintainer,
          popularity: a.popularity, featured: a.featured, official: a.official, beta: a.beta, installed: storeInstalled(a) })) };
    }
    m = path.match(/^\/api\/store\/apps\/([0-9a-f]{12})$/);
    if (m) { const a = store.find((x) => x.id === m[1]); if (!a) throw err('This app is not (or no longer) in the catalogue.', 404); return storeDetails(a); }
    m = path.match(/^\/api\/store\/jobs\/(\w+)$/);
    if (m) return storeJob(m[1]);
    if (path === '/api/pools/options') return poolOptions();
    const dk = path.match(/^\/api\/disks\/([^/?]+)(\?wake=1)?$/);
    if (dk) { await wait(rnd(250, 600)); return demoDisk(decodeURIComponent(dk[1]), !!dk[2]); }
    if (path === '/api/storage') return { ...storageSummary(), zfsError: null, pools: copy(pools), disks: copy(disks), datasets: copy(datasets), bays: copy(bays) };
    if (path === '/api/ai') return { version: '0.13.4', gpu: gpu(), models: copy(models) };
    throw err('Unknown endpoint', 404);
  }

  async function post(path, body = {}) {
    if (path.includes('/snapshots')) { await wait(rnd(800, 1600)); const r = snapRoute('POST', path, body); if (r !== undefined) return r; }
    if (path.startsWith('/api/sysbackups')) { await wait(rnd(200, 500)); const r = sysRoute('POST', path, body); if (r !== undefined) return r; }
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
      if (g.running) throw err('An update is already running.', 409);
      if (!g.newer.some((r) => r.version === body.version)) throw err('This version is not available (anymore). Check for updates again first.', 404);
      upd.job = { start: Date.now(), version: body.version, from: g.current };
      return { started: true, version: body.version };
    }
    if (path === '/api/update/check') { await wait(rnd(600, 1200)); upd.checked = new Date().toISOString(); return updGet(); }
    if (path === '/api/settings' && (body.updateCheck != null || body.updateChannel != null)) {
      if (body.updateCheck != null) upd.auto = !!body.updateCheck;
      if (body.updateChannel != null) { if (!['stable', 'beta', 'dev'].includes(body.updateChannel)) throw err('Choose stable, beta or development.'); upd.channel = body.updateChannel; }
      return { language: demoLang(), clock: demoClock(), ...demoSecurity, updateCheck: upd.auto, updateChannel: upd.channel };
    }
    if (path === '/api/settings' && body.clock != null) {
      if (!['auto', '24', '12'].includes(String(body.clock))) throw err('Choose a time format: automatic, 24-hour or 12-hour.');
      try { localStorage.setItem('tb-clock', String(body.clock)); } catch (e) { /* private window */ }
      return { language: demoLang(), clock: String(body.clock), ...demoSecurity };
    }
    if (path === '/api/settings' && body.language == null) {
      // In the demo there is no password (like the server without APP_PASSWORD): making things less strict is allowed without one.
      Object.assign(demoSecurity, { terminal: body.terminal == null ? demoSecurity.terminal : !!body.terminal,
        terminalPassword: body.terminalPassword == null ? demoSecurity.terminalPassword : !!body.terminalPassword });
      return { language: demoLang(), ...demoSecurity };
    }
    if (path === '/api/settings') {
      if (!(body.language in (window.TB_LANGS || { en: 1 }))) throw err('Unknown language.');
      try { localStorage.setItem('tb-lang', body.language); } catch (e) { /* private window */ }
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
    if (path === '/api/share-groups') { await wait(rnd(300, 600)); return shareGroupSave(body, null); }
    const sgm = path.match(/^\/api\/share-groups\/([^/]+)$/);
    if (sgm) { await wait(rnd(300, 600)); return shareGroupSave(body, decodeURIComponent(sgm[1])); }
    const sum = path.match(/^\/api\/share-users\/([^/]+)$/);
    if (sum) { await wait(rnd(300, 600)); return shareUserAccess(decodeURIComponent(sum[1]), body); }
    if (path === '/api/system/power') { if (body.action !== 'reboot' && body.action !== 'shutdown') throw err('Choose restart or shut down.'); return { ok: true, action: body.action }; }
    const pwm = path.match(/^\/api\/share-users\/([^/]+)\/password$/);
    if (pwm) { if (String(body.password || '').length < 8) throw err('Choose a password of at least 8 characters.'); return { ok: true }; }
    if (path === '/api/apps/custom/inspect') { await wait(rnd(500, 900)); return demoInspect(body.image); }
    if (path === '/api/apps/custom') { await wait(rnd(300, 600)); return demoInstallCustom(body); }
    if (path === '/api/apps/draft') { await wait(rnd(250, 500)); return demoDraft(body); }
    if (path === '/api/apps/compose') { await wait(rnd(300, 600)); return demoInstallCompose(body); }
    const dt = path.match(/^\/api\/disks\/([^/]+)\/test$/);
    if (dt) return demoDiskTest(decodeURIComponent(dt[1]), body.type);
    if (path === '/api/pools') { await wait(rnd(1500, 2200)); return demoCreatePool(body); }
    const vs = path.match(/^\/api\/vm-networks\/([^/]+)\/start$/);
    if (vs) { const n = vmNets.find((x) => x.name === decodeURIComponent(vs[1])); if (!n) throw err('This VM network no longer exists.', 404); n.active = true; return { ok: true }; }
    if (/\/exec$/.test(path)) { await wait(rnd(60, 180)); return demoExec(findApp(path.split('/')[3]), String(body.cmd || ''), body.cwd || '/'); }
    await wait(rnd(500, 1100));
    let mm = path.match(/^\/api\/apps\/([^/]+)\/settings$/);
    if (mm) {
      const a = findApp(mm[1]);
      const w = String(body.webui || '').trim(), ic = String(body.icon || '').trim();
      if (w && !/^(https?:\/\/|\[IP\])/i.test(w)) throw err('The web interface address must start with http:// or https://, e.g. http://[IP]:[PORT:8080]/');
      if (ic && !/^https?:\/\//i.test(ic)) throw err('The icon must be an address that starts with http:// or https://.');
      appOvr[a.name] = { ...(w ? { webui: w } : {}), ...(ic ? { icon: ic } : {}) };
      a.autoStart = !!body.autoStart;
      return { ok: true };
    }
    mm = path.match(/^\/api\/apps\/([^/]+)\/compose-form$/);
    if (mm) {
      const a = findApp(mm[1]), f = body.form || {};
      if (!String(f.image || '').trim()) throw err('Fill in the image, e.g. lscr.io/linuxserver/jellyfin:latest.');
      for (const p of f.ports || []) if (!p.locked && !/^\d{1,5}$/.test(String(p.container).trim())) throw err('Port in the app "' + p.container + '" is not a valid port.');
      for (const v of f.volumes || []) if (!v.locked && !String(v.container).startsWith('/')) throw err('The folder in the app "' + v.container + '" must start with /.');
      for (const d of f.devices || []) if (!/^\/dev\/\S+$/.test(String(d.host).trim())) throw err('A device starts with /dev/, e.g. /dev/dri.');
      const names = (f.env || []).map((e) => e.name).filter(Boolean);
      const dup = names.find((n, i) => names.indexOf(n) !== i); if (dup) throw err('The variable ' + dup + ' appears twice.');
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
      delete composeText[a.compose]; a.state = 'RUNNING'; a.status = 'Up Less than a second';
      return { ok: true, backup: '/opt/stacks/' + a.compose + '/compose.yaml.bak' };
    }
    mm = path.match(/^\/api\/apps\/([^/]+)\/compose$/);
    if (mm) {
      const a = findApp(mm[1]);
      if (!/^services:/m.test(body.text || '')) throw err('The compose file has no service (services).');
      await wait(800);
      composeText[a.compose] = body.text; a.state = 'RUNNING'; a.status = 'Up Less than a second';
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
      if (!a) throw err('Container not found', 404);
      if (m[2] === 'stop') { a.state = 'EXITED'; a.status = 'Exited (0) Less than a second ago'; }
      else { a.state = 'RUNNING'; a.status = 'Up Less than a second'; }
      if (m[2] === 'update') { await wait(800); a.update = false; a.updateChecked = Date.now(); }
      return { ok: true };
    }
    m = path.match(/^\/api\/store\/apps\/([0-9a-f]{12})\/install$/);
    if (m) { const a = store.find((x) => x.id === m[1]); if (!a) throw err('This app is not (or no longer) in the catalogue.', 404); return storeInstall(a, body); }
    if (path === '/api/vms') {
      const name = String(body.name || '').trim();
      checkFields({ ...body, name });
      if (vms.some((v) => v.name === name)) throw err('A VM named ' + name + ' already exists.', 409);
      const opts = vmOptions();
      if (!(body.kind === 'import' ? opts.images : opts.isos).some((f) => f.name === body.source)) throw err('Choose a file from /tank/isos.');
      const [ntype, nsrc] = String(body.network || opts.network).split(':');
      if (!(ntype === 'network' ? opts.networks : ntype === 'bridge' ? opts.bridges : []).some((x) => x.name === nsrc)) throw err('Choose a network for the VM.');
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
      // With pinned cores the number of vCPUs follows from them (the field is then disabled and not sent).
      if (Array.isArray(body.cpuPins) && body.cpuPins.length) body.vcpus = body.cpuPins.length; else if (body.vcpus == null) body.vcpus = v.vcpus;
      checkFields({ ...body, name: newName });
      if (newName !== v.name && v.state !== 'SHUTOFF') throw err('Turn the VM off first to change its name.', 409);
      if (newName !== v.name && vms.some((x) => x.name === newName)) throw err('A VM named ' + newName + ' already exists.', 409);
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
    throw err('Unknown endpoint', 404);
  }

  async function del(path) {
    await wait(400);
    { const r = path.includes('/snapshots') ? snapRoute('DELETE', path) : path.startsWith('/api/sysbackups') ? sysRoute('DELETE', path) : undefined; if (r !== undefined) return r; }
    let m = path.match(/^\/api\/apps\/([^/?]+)(\?data=1)?$/);
    if (m) {
      const i = apps.findIndex((x) => x.id === decodeURIComponent(m[1]));
      if (i < 0) throw err('This app does not exist (anymore).', 404);
      if (!apps[i].storeId && !apps[i].custom) throw err('Only app store apps or your own HomeBaseOS apps can be removed here. Remove other apps through their own compose file.', 400);
      const [a] = apps.splice(i, 1);
      return { removed: m[2] ? a.dataDirs : [], kept: [] };
    }
    m = path.match(/^\/api\/vms\/([^/?]+)(\?disks=1)?$/);
    if (m) {
      const v = findVm(m[1]);
      if (v.state !== 'SHUTOFF') throw err('Turn the VM off first. Then you can remove it.', 409);
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
    if (m) { const i = shareList.findIndex((x) => x.name === decodeURIComponent(m[1])); if (i < 0) throw err('This shared folder no longer exists.', 404); shareList.splice(i, 1); return { removed: decodeURIComponent(m[1]) }; }
    m = path.match(/^\/api\/share-users\/([^/]+)$/);
    if (m) return shareUserDelete(decodeURIComponent(m[1]));
    m = path.match(/^\/api\/share-groups\/([^/]+)$/);
    if (m) return shareGroupDelete(decodeURIComponent(m[1]));
    m = path.match(/^\/api\/ai\/models\/(.+)$/);
    if (m) { const i = models.findIndex((x) => x.name === decodeURIComponent(m[1])); if (i >= 0) models.splice(i, 1); return { ok: true }; }
    throw err('Unknown endpoint', 404);
  }

  async function stream(path, body, onLine) {
    if (path === '/api/ai/pull') {
      const total = rnd(1.8, 4.6) * GB;
      onLine({ status: 'pulling manifest' });
      await wait(500);
      for (let done = 0; done < total; done += total / 40) {
        onLine({ status: 'downloading', total, completed: Math.min(done, total) });
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
      const reply = 'This is demo mode, so I am not really running on your GPU. On your own server ' + body.model +
        ' would answer this here: "' + q.slice(0, 80) + (q.length > 80 ? '…' : '') + '". With an RTX 3060 Ti an 8B model gets roughly 60 to 70 tokens per second.';
      await wait(350);
      for (const word of reply.split(/(\s+)/)) { onLine({ message: { content: word }, done: false }); await wait(28); }
      onLine({ done: true });
      return;
    }
    throw err('Unknown endpoint', 404);
  }

  window.HomeBaseOSDemo = { get, post, del, stream, user: () => acct.user };
})();
