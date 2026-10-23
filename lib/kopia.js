'use strict';
/*
 * Back-up-app voor pc's en Macs: een Kopia-server op de NAS. Op elk toestel draait KopiaUI, dat verbindt met
 * https://<server>:51515 (eigen certificaat, gecontroleerd op vingerafdruk) en elk uur een back-up maakt (algemeen beleid).
 * Elk toestel is een Kopia-gebruiker <naam>@<naam>; standaard ziet een gebruiker alleen zijn eigen back-ups.
 * Archief: dataset <pool>/backups/kopia (versleuteld door Kopia). Server: systemd-eenheid homebaseos-kopia,
 * zonder webinterface; gebruikers wijzigen = SIGHUP (systemctl reload), zodat lopende back-ups doorgaan.
 * DATA_DIR/kopia: repository.config, server.cert/.key, server.env (KOPIA_PASSWORD, 0600), state.json {enabled, pool, dataset, path}.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, readText, httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const DIR = path.join(DATA_DIR, 'kopia');
const CONFIG = path.join(DIR, 'repository.config');
const CERT = path.join(DIR, 'server.cert'), KEY = path.join(DIR, 'server.key');
const ENV_FILE = path.join(DIR, 'server.env'), STATE = path.join(DIR, 'state.json'), CACHE = path.join(DIR, 'cache');
const SERVICE = 'homebaseos-kopia';
const UNIT = process.env.KOPIA_UNIT || `/etc/systemd/system/${SERVICE}.service`;
const PORT = Number(process.env.KOPIA_PORT || 51515);
// Waar de app HomeBase Back-up (fork van KopiaUI) te downloaden is.
const APP_URL = process.env.BACKUP_APP_URL || 'https://github.com/lennertvh1/kopia/releases/latest';

function state() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } }
function saveState(st) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.renameSync(STATE + '.tmp', STATE);
}
const repoPassword = () => { const m = readText(ENV_FILE).match(/^KOPIA_PASSWORD=(.*)$/m); return m ? m[1] : ''; };
// Het wachtwoord van het archief gaat via de omgeving, niet op de opdrachtregel.
const kopia = (args, opts = {}) => run('kopia', [...args, '--config-file', CONFIG],
  { timeout: 60000, ...opts, env: { KOPIA_PASSWORD: repoPassword(), KOPIA_CHECK_FOR_UPDATES: 'false' } });

// Leesbaar wachtwoord zonder tekens die je verwart (l/1, o/0): xxxxx-xxxxx-xxxxx-xxxxx.
function newPassword() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(20);
  return Array.from(b, (x) => abc[x % abc.length]).join('').match(/.{5}/g).join('-');
}
// Kopia-gebruiker van een toestel: de naam van het toestel, als gebruiker en als computernaam.
const userId = (name) => { const n = String(name).toLowerCase(); return `${n}@${n}`; };

let versionCache = null;
async function version() {
  if (versionCache) return versionCache;
  const out = await run('kopia', ['--version'], { timeout: 8000 }).catch(() => '');
  const m = out.match(/^v?(\d+\.\d+\.\d+\S*)/m);
  versionCache = m ? m[1] : null;
  return versionCache;
}

function fingerprint() {
  try { return new crypto.X509Certificate(fs.readFileSync(CERT)).fingerprint256.replace(/:/g, '').toLowerCase(); } catch { return null; }
}
// IPv4-adressen van de server in je thuisnetwerk (zonder Docker, VM's en VPN).
function addresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (/^(lo|docker|br-|veth|virbr|vnet|tap|tun|wg|zt|tailscale)/.test(name)) continue;
    for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  }
  return out;
}

// `kopia snapshot list --all --json`: per gebruiker@computer de laatste back-up, het aantal en de grootte (laatste per map).
function parseSnapshots(list) {
  const out = {};
  for (const s of Array.isArray(list) ? list : []) {
    const src = s.source || {};
    if (!src.userName || !src.host) continue;
    const id = `${src.userName}@${src.host}`;
    const o = out[id] || (out[id] = { last: 0, count: 0, paths: {} });
    const end = Date.parse(s.endTime || s.startTime) || 0;
    const size = Number((s.stats && s.stats.totalSize) ?? (s.rootEntry && s.rootEntry.summ && s.rootEntry.summ.size) ?? 0) || 0;
    o.count++;
    if (!o.paths[src.path] || end > o.paths[src.path].end) o.paths[src.path] = { end, size };
    if (end > o.last) o.last = end;
  }
  return Object.fromEntries(Object.entries(out).map(([id, o]) => [id, {
    last: o.last || null, count: o.count, size: Object.values(o.paths).reduce((a, p) => a + p.size, 0), paths: Object.keys(o.paths).sort(),
  }]));
}
let snapCache = { at: 0, list: [] };
async function snapshotList(fresh) {
  if (!fresh && Date.now() - snapCache.at < 30000) return snapCache.list;
  const out = await kopia(['snapshot', 'list', '--all', '--json'], { timeout: 60000 });
  snapCache = { at: Date.now(), list: JSON.parse(out || '[]') || [] };
  return snapCache.list;
}
async function snapshots() {
  const st = state();
  if (!st || !st.enabled) return {};
  return parseSnapshots(await snapshotList().catch(() => []));
}

async function status(datasets = []) {
  const [v, st] = [await version(), state()];
  const running = st && st.enabled ? await run('systemctl', ['is-active', SERVICE], { timeout: 5000 }).then((o) => o.trim() === 'active', () => false) : false;
  const ds = st ? datasets.find((d) => d.name === st.dataset) : null;
  return {
    installed: !!v, version: v, enabled: !!(st && st.enabled), running, port: PORT, hostname: os.hostname(), addresses: addresses(),
    fingerprint: st ? fingerprint() : null, pool: st ? st.pool : null, path: st ? st.path : null, used: ds ? ds.used : null, appUrl: APP_URL,
  };
}

function unitFile(bin, mountpoint) {
  return `# Gemaakt door HomeBaseOS (Back-ups → Toestellen). Wijzigingen hier worden overschreven.
[Unit]
Description=Kopia-server voor back-ups van pc's (HomeBaseOS)
After=network-online.target zfs-mount.service
Wants=network-online.target
RequiresMountsFor=${mountpoint}

[Service]
EnvironmentFile=${ENV_FILE}
ExecStart=${bin} server start --config-file=${CONFIG} --address=0.0.0.0:${PORT} --tls-cert-file=${CERT} --tls-key-file=${KEY} --random-password --random-server-control-password --no-ui
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
}

// Aanzetten. De eerste keer: dataset, archief, beleid, certificaat en de systemd-eenheid. Geeft dan ook het wachtwoord van het archief.
async function enable(poolName, datasets) {
  if (!(await version())) throw httpError('Kopia is niet geïnstalleerd op de server. Voer install.sh opnieuw uit.', 503);
  const st = state();
  if (st) {
    await run('systemctl', ['enable', '--now', SERVICE], { timeout: 30000 });
    saveState({ ...st, enabled: true });
    return { enabled: true };
  }
  const pool = datasets.find((d) => d.name === String(poolName || '') && !d.name.includes('/'));
  if (!pool) throw httpError('Kies de pool waarop de back-ups komen.', 400);
  const dataset = `${pool.name}/backups/kopia`;
  const existing = datasets.find((d) => d.name === dataset);
  if (existing && fs.existsSync(existing.mountpoint) && fs.readdirSync(existing.mountpoint).length) {
    throw httpError(`In ${existing.mountpoint} staat al iets. Kopia heeft een lege map nodig. Kies een andere pool, of maak de map zelf leeg.`, 409);
  }
  const bin = (await run('which', ['kopia'], { timeout: 5000 })).trim();
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const password = newPassword();
  fs.writeFileSync(ENV_FILE, `KOPIA_PASSWORD=${password}\nKOPIA_CHECK_FOR_UPDATES=false\n`, { mode: 0o600 });
  if (!existing) await run('zfs', ['create', '-p', dataset], { timeout: 30000 });
  try {
    const mp = (await run('zfs', ['get', '-H', '-o', 'value', 'mountpoint', dataset])).trim();
    fs.chmodSync(mp, 0o700);
    await kopia(['repository', 'create', 'filesystem', '--path', mp, '--cache-directory', CACHE], { timeout: 120000 });
    // Elk uur een back-up, en zo lang bewaren: 10 laatste, 24 per uur, 14 per dag, 8 per week, 12 per maand, 3 per jaar.
    await kopia(['policy', 'set', '--global', '--snapshot-interval', '1h', '--keep-latest', '10', '--keep-hourly', '24', '--keep-daily', '14',
      '--keep-weekly', '8', '--keep-monthly', '12', '--keep-annual', '3', '--compression', 'zstd']);
    if (!fs.existsSync(CERT)) {
      // named_curve: anders zetten sommige versies van openssl de curve er los in, en dat weigert Kopia (Go).
      await run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-days', '3650',
        '-subj', '/CN=' + os.hostname(), '-keyout', KEY, '-out', CERT], { timeout: 30000 });
      fs.chmodSync(KEY, 0o600);
    }
    fs.writeFileSync(UNIT, unitFile(bin, mp));
    await run('systemctl', ['daemon-reload'], { timeout: 30000 });
    await run('systemctl', ['enable', '--now', SERVICE], { timeout: 30000 });
    saveState({ enabled: true, pool: pool.name, dataset, path: mp, created: Date.now() });
  } catch (e) {
    // Niets half laten staan: een volgende poging begint opnieuw.
    for (const f of [CONFIG, ENV_FILE, CONFIG + '.kopia-password']) fs.rmSync(f, { force: true });
    if (!existing) await run('zfs', ['destroy', '-r', dataset], { timeout: 60000 }).catch(() => {});
    throw e;
  }
  return { enabled: true, repoPassword: password };
}

async function disable() {
  const st = state();
  if (!st) throw httpError('De back-up-app staat nog niet aan.', 409);
  await run('systemctl', ['disable', '--now', SERVICE], { timeout: 30000 });
  saveState({ ...st, enabled: false });
  return { enabled: false };
}

function needEnabled() {
  const st = state();
  if (!st || !st.enabled) throw httpError('Zet eerst de back-up-app (Kopia) aan.', 409);
}
// Gewijzigde gebruikers laadt de server opnieuw bij SIGHUP; lopende back-ups gaan gewoon door.
const reload = () => run('systemctl', ['reload', SERVICE], { timeout: 15000 }).catch(() => run('systemctl', ['restart', SERVICE], { timeout: 30000 })).catch(() => {});

async function addUser(name) {
  needEnabled();
  const pw = newPassword();
  await kopia(['server', 'user', 'add', userId(name), '--user-password', pw]);
  await reload();
  return pw;
}
async function setPassword(name) {
  needEnabled();
  const pw = newPassword();
  await kopia(['server', 'user', 'set', userId(name), '--user-password', pw]);
  await reload();
  return pw;
}
// Gebruiker weg, en met withData ook zijn back-ups (de ruimte komt vrij bij het volgende onderhoud van Kopia).
async function removeUser(name, withData) {
  needEnabled();
  await kopia(['server', 'user', 'delete', userId(name)]).catch((e) => { if (!/not found|does not exist/i.test(e.message)) throw e; });
  if (withData) {
    const [u, h] = userId(name).split('@');
    const ids = (await snapshotList(true)).filter((s) => s.source && s.source.userName === u && s.source.host === h).map((s) => s.id).filter(Boolean);
    for (let i = 0; i < ids.length; i += 50) await kopia(['snapshot', 'delete', ...ids.slice(i, i + 50), '--delete'], { timeout: 5 * 60000 });
    snapCache.at = 0;
  }
  await reload();
}

/* ---- koppelen met de app HomeBase Back-up */

// Een koppelcode geeft de app alles om te verbinden (poort, vingerafdruk, naam, wachtwoord). Eenmalig, 15 minuten,
// alleen in het geheugen. Een nieuwe code maakt een nieuw wachtwoord: een eerder gekoppeld toestel moet dan opnieuw koppelen.
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const pairings = new Map(); // code → { name, password, until }
const pairFails = new Map(); // ip → { n, since, until }
const formatCode = (c) => c.slice(0, 4) + '-' + c.slice(4);

async function newPairing(name) {
  needEnabled();
  const password = await setPassword(name);
  for (const [c, x] of pairings) if (x.until < Date.now() || x.name === name) pairings.delete(c);
  let code;
  do code = Array.from(crypto.randomBytes(8), (x) => CODE_ABC[x % CODE_ABC.length]).join(''); while (pairings.has(code));
  const until = Date.now() + 15 * 60000;
  pairings.set(code, { name, password, until });
  return { code: formatCode(code), expires: until, password }; // het wachtwoord voor KopiaUI of de opdrachtregel
}

// Code inwisselen. 10 foute codes in 10 minuten vanaf hetzelfde adres: 5 minuten geblokkeerd (status 429).
function usePairing(rawCode, ip) {
  const now = Date.now(), f = pairFails.get(ip);
  if (f && f.until > now) return { status: 429 };
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const p = pairings.get(code);
  if (!p || p.until < now) {
    if (p) pairings.delete(code);
    const g = f && now - f.since < 10 * 60000 ? f : { n: 0, since: now, until: 0 };
    g.n++;
    if (g.n >= 10) { g.until = now + 5 * 60000; g.n = 0; g.since = now; }
    pairFails.set(ip, g);
    return { status: 404 };
  }
  pairings.delete(code);
  pairFails.delete(ip);
  const [username, hostname] = userId(p.name).split('@');
  return { status: 200, data: { port: PORT, fingerprint: fingerprint(), username, hostname, password: p.password, nas: os.hostname() } };
}

module.exports = { PORT, userId, newPassword, parseSnapshots, addresses, unitFile, status, snapshots, enable, disable, addUser, setPassword, removeUser, newPairing, usePairing };
