'use strict';
/*
 * Back-ups.
 *  - Toestellen → NAS: elk toestel krijgt een eigen dataset <pool>/backups/<naam> (optioneel met een quotum) en een
 *    gedeelde map (lib/shares.js) met één gebruiker. Een Mac gebruikt ze voor Time Machine.
 *  - NAS → cloud of een andere NAS (en terug): taken met rclone. Verbindingen staan in DATA_DIR/rclone.conf (0600,
 *    wachtwoorden met `rclone obscure`), taken en toestellen in DATA_DIR/backup.json, logboeken in DATA_DIR/backup-logs.
 *    Versleutelen = een crypt-verbinding hb-crypt-<id> rond het doel; oude versies = --backup-dir naast het doel.
 *  - Aanmelden bij Google, Microsoft of Dropbox: `rclone authorize` luistert op 127.0.0.1:53682. Na het aanmelden komt
 *    de browser uit op dat adres (dat op je eigen pc niet bestaat); je plakt het hier en wij geven het door aan rclone.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { run, runStream, httpError, wait } = require('./system');
const shares = require('./shares');
const kopia = require('./kopia');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'backup.json');
const CONF = path.join(DATA_DIR, 'rclone.conf');
const LOG_DIR = path.join(DATA_DIR, 'backup-logs');
const APP_UID = Number(process.env.APP_UID || 1000), APP_GID = Number(process.env.APP_GID || 1000);
const AUTH_PORT = 53682; // vast in rclone: de terugkeeradressen van Google/Microsoft/Dropbox wijzen hiernaar
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const CRYPT = 'hb-crypt-';
const EVERY = ['manual', 'hourly', 'daily', 'weekly'];
const DEVICE_KINDS = ['mac', 'windows', 'linux', 'phone'];

// Soorten verbindingen. Velden met obscure gaan door `rclone obscure`; secret komt nooit terug naar de browser.
const PROVIDERS = {
  drive: { label: 'Google Drive', group: 'cloud', oauth: true },
  onedrive: { label: 'OneDrive', group: 'cloud', oauth: true },
  dropbox: { label: 'Dropbox', group: 'cloud', oauth: true },
  s3: {
    label: 'S3-opslag', group: 'cloud', hint: 'Backblaze B2, Wasabi, Cloudflare R2, Amazon S3 of MinIO', extra: { env_auth: 'false' },
    fields: [
      { key: 'provider', label: 'Aanbieder', type: 'select', default: 'Other',
        options: [['Other', 'Andere (bv. Backblaze B2)'], ['AWS', 'Amazon S3'], ['Cloudflare', 'Cloudflare R2'], ['Wasabi', 'Wasabi'], ['Minio', 'MinIO']] },
      { key: 'endpoint', label: 'Endpoint', placeholder: 's3.eu-central-003.backblazeb2.com', help: 'Het adres van de opslag. Leeg laten bij Amazon S3.' },
      { key: 'region', label: 'Regio', placeholder: 'eu-central-003' },
      { key: 'access_key_id', label: 'Access key', required: true },
      { key: 'secret_access_key', label: 'Secret key', type: 'password', required: true, secret: true },
    ],
  },
  sftp: {
    label: 'Andere NAS of server (SFTP)', group: 'nas', hint: 'Via SSH: Synology, QNAP, TrueNAS, een andere HomeBaseOS of een Linux-server',
    fields: [
      { key: 'host', label: 'Adres', required: true, host: true, placeholder: '192.168.1.20' },
      { key: 'port', label: 'Poort', type: 'number', default: '22' },
      { key: 'user', label: 'Gebruiker', required: true },
      { key: 'pass', label: 'Wachtwoord', type: 'password', required: true, secret: true, obscure: true },
    ],
  },
  smb: {
    label: 'Andere NAS (SMB)', group: 'nas', hint: 'Een gedeelde map op een andere NAS of een Windows-pc',
    fields: [
      { key: 'host', label: 'Adres', required: true, host: true, placeholder: '192.168.1.20' },
      { key: 'user', label: 'Gebruiker', required: true },
      { key: 'pass', label: 'Wachtwoord', type: 'password', required: true, secret: true, obscure: true },
      { key: 'domain', label: 'Werkgroep', placeholder: 'WORKGROUP' },
    ],
  },
  webdav: {
    label: 'WebDAV', group: 'nas', hint: 'Nextcloud, ownCloud of een andere NAS met WebDAV',
    fields: [
      { key: 'url', label: 'Adres (URL)', required: true, url: true, placeholder: 'https://cloud.voorbeeld.be/remote.php/dav/files/lies' },
      { key: 'vendor', label: 'Soort server', type: 'select', default: 'other', options: [['nextcloud', 'Nextcloud'], ['owncloud', 'ownCloud'], ['other', 'Andere']] },
      { key: 'user', label: 'Gebruiker', required: true },
      { key: 'pass', label: 'Wachtwoord', type: 'password', required: true, secret: true, obscure: true },
    ],
  },
};

/* ---- bestanden */

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { jobs: Array.isArray(j.jobs) ? j.jobs : [], devices: Array.isArray(j.devices) ? j.devices : [] };
  } catch { return { jobs: [], devices: [] }; }
}
function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}

// rclone.conf: [naam] met sleutel = waarde. Volgorde blijft behouden; opmerkingen verdwijnen.
function parseConf(text) {
  const out = []; let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { cur = { name: m[1], opts: {} }; out.push(cur); continue; }
    const i = line.indexOf('=');
    if (cur && i > 0) cur.opts[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
function buildConf(sections) {
  return sections.map((s) => `[${s.name}]\n` + Object.entries(s.opts).map(([k, v]) => `${k} = ${v}`).join('\n') + '\n').join('\n');
}
function readConf() { try { return parseConf(fs.readFileSync(CONF, 'utf8')); } catch { return []; } }
function writeConf(sections) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONF + '.tmp', buildConf(sections), { mode: 0o600 });
  fs.renameSync(CONF + '.tmp', CONF);
}
const isCrypt = (name) => name.startsWith(CRYPT);
const cryptName = (id) => CRYPT + id;

/* ---- controles */

const inside = (p, root) => p === root || p.startsWith(root.replace(/\/$/, '') + '/');
const isRoot = (p) => p === '' || p === '/';
const oneLine = (v) => !/[\x00-\x1f\x7f]/.test(v);

// Map op het doel: gewone mapnamen met /. Een / vooraan blijft (bij SFTP is dat een absoluut pad).
function cleanRemotePath(v) {
  const s = String(v == null ? '' : v).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const out = s.length > 1 ? s.replace(/\/+$/, '') : s;
  if (out.length > 500 || !oneLine(out) || out.split('/').some((x) => x === '..' || x === '.')) {
    throw httpError('Die map op het doel kan niet. Gebruik gewone mapnamen, gescheiden door /.', 400);
  }
  return out;
}

// Map op de NAS: moet op een van je pools liggen. Iets binnenhalen gaat in een eigen map, niet in de hele pool.
function cleanLocalPath(v, datasets, direction) {
  const raw = String(v || '').trim();
  if (!raw.startsWith('/') || !oneLine(raw)) throw httpError('Kies een map op een van je pools, bv. /tank/fotos.', 400);
  const p = path.resolve(raw);
  if (!datasets.some((d) => inside(p, d.mountpoint))) throw httpError('Kies een map op een van je pools, bv. /tank/fotos.', 400);
  if (direction === 'pull' && datasets.some((d) => !d.name.includes('/') && d.mountpoint === p)) {
    throw httpError('Kies een eigen map om in te bewaren, bv. /tank/backups/google-drive, niet de hele pool.', 400);
  }
  return p;
}

function validateSchedule(s) {
  const every = EVERY.includes(s && s.every) ? s.every : 'manual';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test((s && s.time) || '') ? s.time : '03:00';
  const day = Number.isInteger(Number(s && s.day)) && Number(s.day) >= 0 && Number(s.day) <= 6 ? Number(s.day) : 0;
  return { every, time, day };
}

// Controleer een taak. ctx: { remotes (namen), datasets [{name, mountpoint}], current (de taak voor het bewerken) }
function validateJob(body, { remotes = [], datasets = [], current = null } = {}) {
  const name = String(body.name || '').replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 60);
  if (!name) throw httpError("Geef de taak een naam, bv. Foto's naar Google Drive.", 400);
  const direction = body.direction === 'pull' ? 'pull' : 'push';
  const mode = body.mode === 'sync' ? 'sync' : 'copy';
  const remote = String(body.remote || '');
  if (!remotes.includes(remote)) throw httpError('Kies een verbinding. Maak er eerst een aan bij Verbindingen.', 400);
  const remotePath = cleanRemotePath(body.remotePath);
  const localPath = cleanLocalPath(body.localPath, datasets, direction);
  // Versleutelen kies je bij het aanmaken: daarna veranderen zou de bestanden op het doel onleesbaar maken.
  const encrypt = direction === 'push' && (current ? !!current.encrypt : !!body.encrypt);
  if (mode === 'sync' && direction === 'push' && !encrypt && isRoot(remotePath)) {
    throw httpError('Kies een map op het doel. Synchroniseren naar de hoofdmap zou alles wissen wat daar nog staat.', 400);
  }
  const versions = direction === 'push' && !!body.versions;
  if (versions && !encrypt && isRoot(remotePath)) throw httpError('Kies een map op het doel om oude versies te kunnen bewaren.', 400);
  const keepDays = Math.min(3650, Math.max(1, Math.round(Number(body.keepDays) || 30)));
  const excludes = (Array.isArray(body.excludes) ? body.excludes : String(body.excludes || '').split('\n'))
    .map((x) => String(x).trim()).filter(Boolean);
  if (excludes.length > 50 || excludes.some((x) => x.length > 200 || !oneLine(x))) throw httpError('Geef maximaal 50 patronen om uit te sluiten, één per regel.', 400);
  const bwlimit = String(body.bwlimit || '').trim();
  if (bwlimit && !/^\d+(\.\d+)?[KMG]?$/i.test(bwlimit)) throw httpError('Schrijf de bandbreedte als een getal met K, M of G, bv. 10M (10 MB per seconde).', 400);
  return { name, direction, mode, remote, remotePath, localPath, encrypt, versions, keepDays, schedule: validateSchedule(body.schedule), excludes, bwlimit };
}

/* ---- planning */

// Volgende keer na `from` (ms), in de tijdzone van de server. null = alleen met de hand.
function nextRun(schedule, from) {
  const s = validateSchedule(schedule);
  if (s.every === 'manual') return null;
  const [h, m] = s.time.split(':').map(Number);
  const d = new Date(from);
  if (s.every === 'hourly') {
    d.setMinutes(m, 0, 0);
    if (d.getTime() <= from) d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  d.setHours(h, m, 0, 0);
  if (s.every === 'weekly') d.setDate(d.getDate() + ((s.day - d.getDay() + 7) % 7));
  if (d.getTime() <= from) d.setDate(d.getDate() + (s.every === 'weekly' ? 7 : 1));
  return d.getTime();
}

/* ---- rclone */

// Het doel van een taak, en waar oude versies komen. Versleuteld: alles binnen de crypt-verbinding.
function targets(job) {
  if (job.encrypt) return { remote: `${cryptName(job.id)}:bestanden`, versions: `${cryptName(job.id)}:versies` };
  return {
    remote: `${job.remote}:${job.remotePath}`,
    versions: isRoot(job.remotePath) ? null : `${job.remote}:${job.remotePath} (oude versies)`,
  };
}

// kind: backup (de taak zelf) of restore (van het doel terug naar target op de NAS).
function buildArgs(job, { kind = 'backup', dryRun = false, stamp = '', target = null } = {}) {
  const t = targets(job);
  let args;
  if (kind === 'restore') args = ['copy', t.remote, target];
  else if (job.direction === 'pull') args = [job.mode, t.remote, job.localPath];
  else args = [job.mode, job.localPath, t.remote];
  args.push('--config', CONF, '--use-json-log', '-v', '--stats', '2s', '--links');
  if (kind === 'backup') for (const x of job.excludes || []) args.push('--exclude', x);
  if (job.bwlimit) args.push('--bwlimit', job.bwlimit);
  if (kind === 'backup' && job.direction === 'push' && job.versions && t.versions) args.push('--backup-dir', `${t.versions}/${stamp}`);
  if (dryRun) args.push('--dry-run');
  return args;
}

// Eén regel van rclone met --use-json-log: tekst (met het bestand erbij) of tussenstand (stats).
function parseLogLine(line) {
  let j = null;
  try { j = JSON.parse(line); } catch { /* geen JSON, bv. een fout bij het opstarten */ }
  if (!j || typeof j !== 'object') return { level: /\b(error|fatal|failed)\b/i.test(line) ? 'error' : 'info', text: String(line).trim() };
  const level = String(j.level || 'info').toLowerCase();
  if (j.stats) return { level, time: j.time, stats: j.stats };
  return { level, time: j.time, text: (j.object ? j.object + ': ' : '') + String(j.msg || '').trim() };
}
function summarize(st) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    bytes: n(st.bytes), totalBytes: n(st.totalBytes), files: n(st.transfers), totalFiles: n(st.totalTransfers),
    checks: n(st.checks), deletes: n(st.deletes), errors: n(st.errors), speed: n(st.speed),
    eta: st.eta == null ? null : n(st.eta),
    percent: n(st.totalBytes) ? Math.min(100, Math.round((n(st.bytes) / n(st.totalBytes)) * 1000) / 10) : null,
  };
}
const isError = (level) => ['error', 'critical', 'fatal', 'emergency', 'alert'].includes(level);

let versionCache = null;
async function rcloneVersion() {
  if (versionCache) return versionCache;
  const out = await run('rclone', ['version'], { timeout: 8000 }).catch(() => '');
  const m = out.match(/^rclone\s+v?([\d.]+\S*)/m);
  versionCache = m ? m[1] : null;
  return versionCache;
}
async function needRclone() {
  if (!(await rcloneVersion())) throw httpError('rclone is niet geïnstalleerd op de server. Voer install.sh opnieuw uit, of op de server: sudo apt install rclone', 503);
}
const obscure = async (v) => (await run('rclone', ['obscure', '-'], { input: v + '\n', timeout: 10000 })).trim();

/* ---- ZFS */

function parseDatasets(out) {
  return String(out || '').split('\n').map((l) => l.split('\t')).filter((c) => c[0] && c[1] && c[1].startsWith('/'))
    .map(([name, mountpoint, mounted, used, avail, quota]) => ({
      name, mountpoint, mounted: mounted !== 'no', used: Number(used) || 0, avail: Number(avail) || 0, quota: Number(quota) || 0,
    }));
}
async function datasets() {
  const out = await run('zfs', ['list', '-H', '-p', '-o', 'name,mountpoint,mounted,used,avail,quota', '-t', 'filesystem'], { timeout: 8000 }).catch(() => '');
  return parseDatasets(out);
}
// De diepste dataset waar een pad op ligt.
const datasetOf = (p, ds) => ds.filter((d) => inside(p, d.mountpoint)).sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0] || null;

/* ---- verbindingen */

function remoteDetail(o) {
  if (o.type === 'sftp' || o.type === 'smb') return [o.user, o.host].filter(Boolean).join('@') + (o.port && o.port !== '22' ? ':' + o.port : '');
  if (o.type === 'webdav') return o.url || '';
  if (o.type === 's3') return o.endpoint || o.provider || '';
  if (o.type === 'onedrive') return o.drive_type === 'personal' ? 'OneDrive (persoonlijk)' : o.drive_type ? 'OneDrive voor werk of school' : '';
  return '';
}
function listRemotes(jobs = load().jobs) {
  return readConf().filter((s) => !isCrypt(s.name)).map((s) => ({
    name: s.name, type: s.opts.type, label: (PROVIDERS[s.opts.type] || {}).label || s.opts.type, detail: remoteDetail(s.opts),
    usedBy: jobs.filter((j) => j.remote === s.name).map((j) => j.name),
  }));
}
function checkNewName(name) {
  if (!REMOTE.test(name) || isCrypt(name)) throw httpError('Kies een naam met letters, cijfers, - of _ (maximaal 32 tekens), bv. google.', 400);
  if (readConf().some((s) => s.name.toLowerCase() === name.toLowerCase())) throw httpError(`Er bestaat al een verbinding met de naam ${name}.`, 409);
}

// Zonder aanmelden in de browser: adres, gebruiker en wachtwoord (SFTP, SMB, WebDAV, S3).
async function remoteOptions(body) {
  const p = PROVIDERS[body.type];
  if (!p || p.oauth) throw httpError('Kies een soort verbinding.', 400);
  const opts = { type: body.type, ...(p.extra || {}) };
  for (const f of p.fields) {
    const v = String(body[f.key] == null || body[f.key] === '' ? (f.default || '') : body[f.key]).trim();
    if (!v) { if (f.required) throw httpError(`Vul ${f.label.toLowerCase()} in.`, 400); continue; }
    if (v.length > 500 || !oneLine(v)) throw httpError(`${f.label} kan geen regeleinde bevatten.`, 400);
    if (f.type === 'number' && !(/^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535)) throw httpError('Kies een poort tussen 1 en 65535.', 400);
    if (f.host && !/^[A-Za-z0-9._:[\]-]+$/.test(v)) throw httpError(`"${v}" is geen geldig adres. Gebruik een IP-adres of een naam, bv. 192.168.1.20.`, 400);
    if (f.url && !/^https?:\/\/\S+$/i.test(v)) throw httpError('Het adres moet beginnen met http:// of https://.', 400);
    if (f.type === 'select' && !f.options.some(([k]) => k === v)) throw httpError(`Kies een geldige waarde voor ${f.label.toLowerCase()}.`, 400);
    opts[f.key] = f.obscure ? await obscure(v) : v;
  }
  return opts;
}

// Nieuwe verbinding, of (opnieuw aanmelden) een bestaande vervangen. Werkt ze niet, dan blijft alles zoals het was.
async function addRemote(name, opts) {
  const before = readConf(), old = before.find((s) => s.name === name);
  writeConf(old ? before.map((s) => (s.name === name ? { name, opts } : s)) : before.concat({ name, opts }));
  try { await testRemote(name); }
  catch (e) {
    writeConf(old ? readConf().map((s) => (s.name === name ? old : s)) : readConf().filter((s) => s.name !== name));
    throw httpError('Verbinden lukte niet: ' + e.message, 400);
  }
  return { name };
}

async function createRemote(body) {
  await needRclone();
  const name = String(body.name || '').trim();
  checkNewName(name);
  return addRemote(name, await remoteOptions(body));
}

async function testRemote(name) {
  const sec = readConf().find((s) => s.name === name && !isCrypt(s.name));
  if (!sec) throw httpError('Deze verbinding bestaat niet (meer).', 404);
  await run('rclone', ['lsjson', name + ':', '--dirs-only', '--max-depth', '1', '--config', CONF], { timeout: 45000 });
  // Vrije ruimte kent niet elke soort (bv. SMB); dan gewoon zonder.
  const about = await run('rclone', ['about', name + ':', '--json', '--config', CONF], { timeout: 20000 })
    .then((o) => { const j = JSON.parse(o); return { total: j.total ?? null, used: j.used ?? null, free: j.free ?? null }; }, () => null);
  return { ok: true, about };
}

async function browse(name, p) {
  if (!readConf().some((s) => s.name === name && !isCrypt(s.name))) throw httpError('Deze verbinding bestaat niet (meer).', 404);
  const clean = cleanRemotePath(p);
  const out = await run('rclone', ['lsjson', `${name}:${clean}`, '--dirs-only', '--config', CONF], { timeout: 45000 });
  const dirs = (JSON.parse(out || '[]') || []).map((x) => x.Name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return { path: clean, dirs };
}

function deleteRemote(name) {
  const sections = readConf();
  if (!sections.some((s) => s.name === name && !isCrypt(s.name))) throw httpError('Deze verbinding bestaat niet (meer).', 404);
  const used = load().jobs.filter((j) => j.remote === name).map((j) => j.name);
  if (used.length) throw httpError(`De verbinding ${name} wordt nog gebruikt door ${used.join(', ')}. Verwijder of wijzig die taken eerst.`, 409);
  writeConf(sections.filter((s) => s.name !== name));
  return { removed: name };
}

/* ---- aanmelden bij Google, Microsoft of Dropbox */

let auth = null; // { id, type, child, out, timer }

function localGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 30000 }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
    req.on('timeout', () => req.destroy(new Error('rclone antwoordde niet.')));
    req.on('error', reject);
  });
}
function stopAuth() {
  if (!auth) return;
  clearTimeout(auth.timer);
  try { auth.child && auth.child.kill('SIGTERM'); } catch { /* al gestopt */ }
  auth = null;
}
const parseAuthLink = (out) => { const m = String(out).match(/http:\/\/127\.0\.0\.1:53682\/auth\?state=[\w-]+/); return m ? m[0] : null; };

// Wat `rclone authorize` op het einde toont: een token (JSON), of in nieuwere versies base64 van {"token": "…", …}.
function parseAuthToken(text) {
  const s = String(text || '');
  const block = s.match(/--->\s*([\s\S]*?)\s*<---/);
  const raw = (block ? block[1] : s).trim();
  if (!raw) return null;
  const asToken = (str) => { try { const j = JSON.parse(str); return j && j.access_token ? JSON.stringify(j) : null; } catch { return null; } };
  if (raw.startsWith('{')) {
    const tok = asToken(raw);
    if (tok) return { token: tok, extra: {} };
    try { const j = JSON.parse(raw); if (j && typeof j.token === 'string' && asToken(j.token)) { const { token, ...extra } = j; return { token: asToken(token), extra }; } } catch { /* verder */ }
    return null;
  }
  try {
    const j = JSON.parse(Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8'));
    if (j && typeof j.token === 'string' && asToken(j.token)) { const { token, ...extra } = j; return { token: asToken(token), extra }; }
  } catch { /* geen base64 */ }
  return null;
}

async function startAuth(type) {
  await needRclone();
  if (!PROVIDERS[type] || !PROVIDERS[type].oauth) throw httpError('Kies Google Drive, OneDrive of Dropbox.', 400);
  stopAuth();
  const a = { id: crypto.randomBytes(6).toString('hex'), type, child: null, out: '', done: false };
  auth = a;
  a.timer = setTimeout(() => { if (auth === a) stopAuth(); }, 15 * 60000);
  runStream('rclone', ['authorize', type, '--auth-no-open-browser', '--config', CONF], (line) => { a.out += line + '\n'; },
    { timeout: 0, onSpawn: (c) => { a.child = c; } }).catch((e) => { a.out += e.message + '\n'; }).finally(() => { a.done = true; });
  let local = null;
  for (let i = 0; i < 100 && !local && !a.done; i++) { await wait(100); local = parseAuthLink(a.out); }
  if (!local) {
    const last = a.out.trim().split('\n').pop() || '';
    stopAuth();
    throw httpError('rclone gaf geen aanmeldlink.' + (last ? ' ' + last : ''), 502);
  }
  // De lokale link stuurt door naar de aanmeldpagina; die geven we aan de browser.
  const res = await localGet(local);
  if (!res.headers.location) { stopAuth(); throw httpError('rclone gaf geen aanmeldlink.', 502); }
  return { session: a.id, url: res.headers.location };
}

// OneDrive heeft ook het id en de soort van de schijf nodig: die vragen we zelf op bij Microsoft.
function oneDriveInfo(token) {
  return new Promise((resolve, reject) => {
    const access = JSON.parse(token).access_token;
    const req = https.get('https://graph.microsoft.com/v1.0/me/drive', { headers: { Authorization: 'Bearer ' + access }, timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { const j = JSON.parse(body); if (res.statusCode === 200 && j.id) return resolve({ drive_id: j.id, drive_type: j.driveType || 'personal' }); } catch { /* hieronder */ }
        reject(httpError('Je OneDrive kon niet opgevraagd worden (' + res.statusCode + ').', 502));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Time-out bij Microsoft.')));
    req.on('error', reject);
  });
}

// body: { name, type, session + url (het adres na het aanmelden) of token (uit `rclone authorize` op een andere pc), reconnect }
// reconnect: een bestaande verbinding opnieuw aanmelden (bv. na een nieuw wachtwoord bij Google); de taken blijven ze gebruiken.
async function finishAuth(body) {
  await needRclone();
  const name = String(body.name || '').trim();
  const type = String(body.type || '');
  if (!PROVIDERS[type] || !PROVIDERS[type].oauth) throw httpError('Kies Google Drive, OneDrive of Dropbox.', 400);
  if (!body.reconnect) checkNewName(name);
  else if (!readConf().some((s) => s.name === name && s.opts.type === type)) throw httpError('Deze verbinding bestaat niet (meer).', 404);
  let got;
  if (body.token) {
    got = parseAuthToken(body.token);
    if (!got) throw httpError('Dat is geen geldige token. Plak alles tussen ---> en <---End paste.', 400);
  } else {
    const a = auth;
    if (!a || a.id !== body.session || a.type !== type) throw httpError('Het aanmelden is verlopen. Begin opnieuw.', 410);
    let u;
    try { u = new URL(String(body.url || '').trim()); } catch { u = null; }
    if (u && u.searchParams.get('error')) throw httpError('Je gaf geen toestemming. Probeer opnieuw en klik op Toestaan.', 400);
    if (!u || !u.searchParams.get('code') || !u.searchParams.get('state')) {
      throw httpError('Plak het volledige adres uit de adresbalk. Het begint met http://127.0.0.1:53682/.', 400);
    }
    await localGet(`http://127.0.0.1:${AUTH_PORT}/?` + u.searchParams.toString());
    for (let i = 0; i < 300 && !(got = parseAuthToken(a.out)) && !a.done; i++) await wait(100);
    got = got || parseAuthToken(a.out);
    stopAuth();
    if (!got) throw httpError('Aanmelden lukte niet. Begin opnieuw.', 502);
  }
  const opts = { type, ...(type === 'drive' ? { scope: 'drive' } : {}), ...got.extra, token: got.token };
  if (type === 'onedrive' && !opts.drive_id) Object.assign(opts, await oneDriveInfo(got.token));
  for (const [k, v] of Object.entries(opts)) if (!/^[a-z_]+$/.test(k) || !oneLine(String(v))) delete opts[k];
  return addRemote(name, opts);
}

/* ---- taken */

const live = new Map(); // id → lopende taak (alleen in het geheugen)
const newId = () => crypto.randomBytes(4).toString('hex');
const stampOf = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((x) => String(x).padStart(2, '0')).join('-') + '_' +
  [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join('');

function liveInfo(r) {
  return r ? { kind: r.kind, dryRun: r.dryRun, started: r.started, ...(r.stats || {}) } : null;
}
function publicJob(j) {
  return { ...j, history: (j.history || []).slice(0, 10), next: nextRun(j.schedule, j.lastScheduled || j.created), running: liveInfo(live.get(j.id)) };
}

async function saveJob(body, id = null) {
  await needRclone();
  const data = load();
  const current = id ? data.jobs.find((j) => j.id === id) : null;
  if (id && !current) throw httpError('Deze taak bestaat niet (meer).', 404);
  if (id && live.has(id)) throw httpError('Deze taak loopt nu. Stop ze eerst, of wacht tot ze klaar is.', 409);
  const sections = readConf();
  const job = validateJob(body, { remotes: sections.filter((s) => !isCrypt(s.name)).map((s) => s.name), datasets: await datasets(), current });
  const out = current ? { ...current, ...job } : { id: newId(), ...job, created: Date.now(), lastRun: null, history: [] };
  // Een nieuwe planning telt vanaf nu: een tijdstip dat vandaag al voorbij is, komt pas de volgende keer.
  if (!current || JSON.stringify(current.schedule) !== JSON.stringify(job.schedule)) out.lastScheduled = Date.now();
  if (job.encrypt) {
    const cname = cryptName(out.id);
    let sec = sections.find((s) => s.name === cname);
    if (!sec) {
      if (current) throw httpError('De sleutel van deze versleutelde taak ontbreekt in rclone.conf.', 409);
      const pw = String(body.password || '');
      if (pw.length < 10 || pw.length > 200 || !oneLine(pw)) throw httpError('Kies een wachtwoord voor de versleuteling van minstens 10 tekens.', 400);
      sec = { name: cname, opts: { type: 'crypt', remote: '', password: await obscure(pw), filename_encryption: 'standard', directory_name_encryption: 'true' } };
      sections.push(sec);
    }
    sec.opts.remote = `${job.remote}:${job.remotePath}`;
    writeConf(sections);
  }
  const fresh = load();
  fresh.jobs = current ? fresh.jobs.map((j) => (j.id === id ? out : j)) : fresh.jobs.concat(out);
  save(fresh);
  return publicJob(out);
}

function deleteJob(id) {
  const data = load();
  if (!data.jobs.some((j) => j.id === id)) throw httpError('Deze taak bestaat niet (meer).', 404);
  if (live.has(id)) throw httpError('Deze taak loopt nu. Stop ze eerst, of wacht tot ze klaar is.', 409);
  data.jobs = data.jobs.filter((j) => j.id !== id);
  save(data);
  const sections = readConf();
  if (sections.some((s) => s.name === cryptName(id))) writeConf(sections.filter((s) => s.name !== cryptName(id)));
  fs.rmSync(path.join(LOG_DIR, id + '.json'), { force: true });
  return { removed: id };
}

// Vóór het starten: bestaat alles nog, is de pool gekoppeld, en wist een synchronisatie niet per ongeluk alles?
async function preflight(job, kind, dryRun, target) {
  await needRclone();
  if (!readConf().some((s) => s.name === job.remote)) throw httpError(`De verbinding ${job.remote} bestaat niet meer. Kies een andere verbinding bij Bewerken.`, 409);
  const local = kind === 'restore' ? target : job.localPath;
  const ds = datasetOf(local, await datasets());
  if (!ds) throw httpError(`${local} ligt niet op een van je pools.`, 409);
  if (!ds.mounted) throw httpError(`De dataset ${ds.name} is niet gekoppeld. Kijk bij Opslag of je pool in orde is.`, 409);
  if (kind === 'backup' && job.direction === 'push') {
    let entries;
    try { entries = fs.readdirSync(local); } catch { throw httpError(`De map ${local} bestaat niet (meer).`, 409); }
    if (!entries.length && job.mode === 'sync' && !dryRun) throw httpError(`De map ${local} is leeg. Synchroniseren zou alles op het doel wissen; daarom start de taak niet.`, 409);
  } else if (!fs.existsSync(local)) {
    fs.mkdirSync(local, { recursive: true });
    try { fs.chownSync(local, APP_UID, APP_GID); } catch { /* geen root */ }
  }
}

function record(id, entry, lines) {
  const data = load(), job = data.jobs.find((j) => j.id === id);
  if (!job) return;
  job.history = [entry, ...(job.history || [])].slice(0, 20);
  if (entry.kind === 'backup' && !entry.dryRun) job.lastRun = entry;
  save(data);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOG_DIR, id + '.json'), JSON.stringify(lines.slice(-400)));
}

// Na een geslaagde taak: oude versies opruimen; wat binnenkwam van de app-gebruiker maken (zoals bij de gedeelde mappen).
async function afterSuccess(job, r, target) {
  const t = targets(job);
  if (r.kind === 'backup' && job.direction === 'push' && job.versions && t.versions) {
    await run('rclone', ['delete', t.versions, '--min-age', job.keepDays + 'd', '--config', CONF], { timeout: 30 * 60000 }).catch(() => {});
    await run('rclone', ['rmdirs', t.versions, '--leave-root', '--config', CONF], { timeout: 10 * 60000 }).catch(() => {});
  }
  const local = r.kind === 'restore' ? target : job.direction === 'pull' ? job.localPath : null;
  if (local) await run('chown', ['-R', `${APP_UID}:${APP_GID}`, local], { timeout: 60 * 60000 }).catch(() => {});
}

async function startRun(id, { kind = 'backup', dryRun = false, target = null, scheduled = false } = {}) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('Deze taak bestaat niet (meer).', 404);
  if (live.has(id)) throw httpError('Deze taak loopt al.', 409);
  const r = { kind, dryRun, scheduled, started: Date.now(), stats: null, lines: [], lastError: null, child: null, cancelled: false };
  live.set(id, r); // meteen, zodat een tweede klik niet ook start
  try { await preflight(job, kind, dryRun, target); } catch (e) { live.delete(id); throw e; }
  const say = (level, text) => { r.lines.push({ time: new Date().toISOString(), level, text }); if (r.lines.length > 400) r.lines.splice(0, r.lines.length - 400); };
  say('info', kind === 'restore' ? `Terugzetten naar ${target}` : (dryRun ? 'Proef (er verandert niets): ' : '') + `${job.direction === 'pull' ? targets(job).remote + ' → ' + job.localPath : job.localPath + ' → ' + job.remote + ':' + job.remotePath}`);
  const args = buildArgs(job, { kind, dryRun, target, stamp: stampOf(new Date()) });
  runStream('rclone', args, (raw) => {
    const l = parseLogLine(raw);
    if (l.stats) { r.stats = summarize(l.stats); return; }
    if (!l.text) return;
    if (isError(l.level)) r.lastError = l.text;
    r.lines.push({ time: l.time || new Date().toISOString(), level: l.level, text: l.text });
    if (r.lines.length > 400) r.lines.splice(0, r.lines.length - 400);
  }, { timeout: 0, onSpawn: (c) => { r.child = c; } })
    .then(() => true, (e) => { if (!r.lastError) r.lastError = e.message; return false; })
    .then(async (ok) => {
      if (ok && !dryRun) await afterSuccess(job, r, target);
      const s = r.stats || summarize({});
      const entry = {
        kind, dryRun, scheduled, started: r.started, ended: Date.now(), state: r.cancelled ? 'cancelled' : ok ? 'ok' : 'failed',
        bytes: s.bytes, files: s.files, checks: s.checks, deletes: s.deletes, errors: s.errors,
        error: r.cancelled ? null : ok ? null : r.lastError,
      };
      say(entry.state === 'ok' ? 'info' : 'error', entry.state === 'ok' ? 'Klaar.' : entry.state === 'cancelled' ? 'Gestopt.' : 'Mislukt: ' + (entry.error || ''));
      record(id, entry, r.lines);
    })
    .catch((e) => console.error('Back-up ' + id + ': ' + e.message))
    .finally(() => live.delete(id));
  return { started: true, kind, dryRun };
}

function stopRun(id) {
  const r = live.get(id);
  if (!r) throw httpError('Deze taak loopt niet.', 409);
  r.cancelled = true;
  if (r.child) r.child.kill('SIGTERM');
  return { stopping: true };
}

async function restore(id, body) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('Deze taak bestaat niet (meer).', 404);
  if (job.direction !== 'push') throw httpError('Terugzetten kan alleen bij een taak die naar de cloud of een andere NAS gaat.', 400);
  const target = cleanLocalPath(body.target, await datasets(), 'pull');
  return startRun(id, { kind: 'restore', target });
}

function jobLog(id) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('Deze taak bestaat niet (meer).', 404);
  const r = live.get(id);
  let lines = r ? r.lines : [];
  if (!r) { try { lines = JSON.parse(fs.readFileSync(path.join(LOG_DIR, id + '.json'), 'utf8')); } catch { lines = []; } }
  return { running: liveInfo(r), lines, last: (job.history || [])[0] || null };
}

// Elke 30 s: is er een geplande taak aan de beurt? Gemiste keren (server uit) halen we één keer in.
function tick() {
  const data = load(), now = Date.now();
  let changed = false;
  for (const job of data.jobs) {
    const next = nextRun(job.schedule, job.lastScheduled || job.created);
    if (!next || next > now) continue;
    job.lastScheduled = now; changed = true;
    if (live.has(job.id)) continue; // loopt nog van de vorige keer: deze keer overslaan
    startRun(job.id, { scheduled: true }).catch((e) => {
      record(job.id, { kind: 'backup', dryRun: false, scheduled: true, started: now, ended: Date.now(), state: 'failed', bytes: 0, files: 0, checks: 0, deletes: 0, errors: 1, error: e.message },
        [{ time: new Date().toISOString(), level: 'error', text: 'Niet gestart: ' + e.message }]);
    });
  }
  if (changed) save(data);
}
function startSchedule() { setInterval(tick, 30000); }

/* ---- toestellen → NAS */

// Wanneer er voor het laatst iets veranderde in de map (twee niveaus diep, hooguit 3000 items).
function latestChange(dir) {
  let max = 0, seen = 0;
  const walk = (p, depth) => {
    let list;
    try { list = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (++seen > 3000) return;
      const f = path.join(p, e.name);
      try { const st = fs.lstatSync(f); if (st.mtimeMs > max) max = st.mtimeMs; } catch { /* weg */ }
      if (e.isDirectory() && depth < 2) walk(f, depth + 1);
    }
  };
  walk(dir, 0);
  return max ? Math.round(max) : null;
}

// method: share (een gedeelde map: Time Machine, Bestandsgeschiedenis, apps op een gsm) of kopia (de back-up-app, lib/kopia.js).
function validateDevice(body, { devices = [], shareNames = [], pools = [], users = [] } = {}) {
  const name = String(body.name || '').trim();
  if (!DEVICE.test(name)) throw httpError('Kies een naam met letters, cijfers, - of _ (maximaal 32 tekens), bv. MacBook-Lies.', 400);
  if (devices.some((d) => d.name.toLowerCase() === name.toLowerCase())) throw httpError(`Er bestaat al een toestel met de naam ${name}.`, 409);
  if (!DEVICE_KINDS.includes(body.kind)) throw httpError('Kies wat voor toestel het is.', 400);
  if (body.method === 'kopia') {
    if (body.kind === 'phone') throw httpError('De back-up-app bestaat niet voor gsm\'s. Kies een gedeelde map.', 400);
    return { name, kind: body.kind, method: 'kopia', user: kopia.userId(name) };
  }
  if (shareNames.some((n) => n.toLowerCase() === name.toLowerCase())) throw httpError(`Er bestaat al een gedeelde map met de naam ${name}.`, 409);
  const pool = String(body.pool || '');
  if (!pools.includes(pool)) throw httpError('Kies de pool waarop de back-ups komen.', 400);
  const quotaGb = body.quotaGb === '' || body.quotaGb == null ? 0 : Number(body.quotaGb);
  if (!Number.isInteger(quotaGb) || quotaGb < 0 || quotaGb > 1e6) throw httpError('Vul de maximale grootte in als een getal in GB, of laat het leeg.', 400);
  const user = body.newUser ? String(body.newUser.name || '').trim() : String(body.user || '');
  if (!body.newUser && !users.includes(user)) throw httpError('Kies wie de back-ups mag maken.', 400);
  return { name, kind: body.kind, method: 'share', pool, quotaGb, user, dataset: `${pool}/backups/${name.toLowerCase()}` };
}

async function listDevices(ds, perShare = {}) {
  const devices = load().devices;
  const snaps = devices.some((d) => d.method === 'kopia') ? await kopia.snapshots() : {};
  return devices.map((d) => {
    if (d.method === 'kopia') {
      const k = snaps[d.user] || {};
      return { ...d, used: k.size || 0, lastChange: k.last || null, snapshots: k.count || 0, folders: k.paths || [] };
    }
    const z = ds.find((x) => x.name === d.dataset);
    return { ...d, method: 'share', used: z ? z.used : null, quota: z ? z.quota : 0, avail: z ? z.avail : null, missing: !z,
      lastChange: z && z.mounted ? latestChange(d.path) : null, connected: perShare[d.name] || 0 };
  });
}

// Een toestel met de back-up-app: een Kopia-gebruiker. Het wachtwoord komt maar één keer terug.
async function createKopiaDevice(body) {
  const dev = validateDevice(body, { devices: load().devices });
  await kopia.addUser(dev.name);
  const device = { name: dev.name, kind: dev.kind, method: 'kopia', user: dev.user, created: Date.now() };
  const data = load();
  data.devices.push(device);
  save(data);
  // Meteen een koppelcode (en het wachtwoord dat erbij hoort, voor KopiaUI of de opdrachtregel).
  const pair = await kopia.newPairing(dev.name);
  return { ...device, ...pair };
}

async function createDevice(body) {
  if (body.method === 'kopia') return createKopiaDevice(body);
  const [sh, ds] = await Promise.all([shares.listShares(), datasets()]);
  if (!sh.installed) throw httpError('Samba is nog niet geïnstalleerd. Voer install.sh opnieuw uit, of op de server: sudo apt install samba', 503);
  const dev = validateDevice(body, {
    devices: load().devices, shareNames: sh.shares.map((s) => s.name), pools: ds.filter((d) => !d.name.includes('/')).map((d) => d.name),
    users: sh.users.map((u) => u.name),
  });
  if (ds.some((d) => d.name === dev.dataset)) throw httpError(`De dataset ${dev.dataset} bestaat al. Kies een andere naam.`, 409);
  if (body.newUser) await shares.createUser(body.newUser);
  await run('zfs', ['create', '-p', ...(dev.quotaGb ? ['-o', `quota=${dev.quotaGb}G`] : []), dev.dataset], { timeout: 30000 });
  try {
    const mp = (await run('zfs', ['get', '-H', '-o', 'value', 'mountpoint', dev.dataset])).trim();
    try { fs.chownSync(mp, APP_UID, APP_GID); fs.chmodSync(mp, 0o775); } catch { /* geen root */ }
    await shares.saveShare({ name: dev.name, path: mp, comment: `Back-ups van ${dev.name}`, users: { [dev.user]: 'rw' }, guest: false, timemachine: dev.kind === 'mac' });
    const data = load();
    const device = { name: dev.name, kind: dev.kind, method: 'share', dataset: dev.dataset, path: mp, user: dev.user, created: Date.now() };
    data.devices.push(device);
    save(data);
    return device;
  } catch (e) {
    await run('zfs', ['destroy', dev.dataset], { timeout: 30000 }).catch(() => {});
    throw e;
  }
}

async function deleteDevice(name, withData) {
  const data = load(), d = data.devices.find((x) => x.name === name);
  if (!d) throw httpError('Dit toestel bestaat niet (meer).', 404);
  if (d.method === 'kopia') await kopia.removeUser(d.name, withData);
  else {
    await shares.deleteShare(name).catch((e) => { if (e.status !== 404) throw e; });
    if (withData) {
      if (!/^[^/]+\/backups\/[^/]+$/.test(d.dataset)) throw httpError('Deze dataset wis ik niet automatisch: ' + d.dataset, 400);
      await run('zfs', ['destroy', '-r', d.dataset], { timeout: 5 * 60000 });
    }
  }
  const fresh = load();
  fresh.devices = fresh.devices.filter((x) => x.name !== name);
  save(fresh);
  return { removed: name, dataset: withData && d.method !== 'kopia' ? d.dataset : null };
}

// Koppelcode voor de app HomeBase Back-up (maakt ook een nieuw wachtwoord).
async function devicePairing(name) {
  const d = load().devices.find((x) => x.name === name);
  if (!d) throw httpError('Dit toestel bestaat niet (meer).', 404);
  if (d.method !== 'kopia') throw httpError('Koppelen kan alleen bij een toestel met de back-up-app.', 400);
  return { name, ...(await kopia.newPairing(d.name)) };
}

// Nieuw wachtwoord voor een toestel met de back-up-app (het oude werkt meteen niet meer).
async function devicePassword(name) {
  const d = load().devices.find((x) => x.name === name);
  if (!d) throw httpError('Dit toestel bestaat niet (meer).', 404);
  if (d.method !== 'kopia') throw httpError('Het wachtwoord van een gedeelde map wijzig je bij Gedeelde mappen → Gebruikers.', 400);
  return { name, password: await kopia.setPassword(d.name) };
}

// Back-up-app aan- of uitzetten. Aanzetten: de pool waarop het archief komt. Uitzetten: gebruikers en archief blijven.
async function setKopia(body) {
  return body.enabled ? kopia.enable(body.pool, await datasets()) : kopia.disable();
}

/* ---- overzicht */

async function overview({ brief = false } = {}) {
  const data = load();
  const jobs = data.jobs.map(publicJob);
  if (brief) return { installed: !!(await rcloneVersion()), jobs, devices: data.devices.length };
  const [version, ds, sh] = await Promise.all([rcloneVersion(), datasets(), shares.listShares().catch(() => null)]);
  const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, {
    label: p.label, group: p.group, oauth: !!p.oauth, hint: p.hint || '',
    fields: (p.fields || []).map(({ key, label, type, required, placeholder, help, options, default: def }) => ({ key, label, type: type || 'text', required: !!required, placeholder, help, options, default: def })),
  }]));
  return {
    installed: !!version, version, providers, remotes: listRemotes(data.jobs), jobs,
    devices: await listDevices(ds, sh ? sh.connections.perShare : {}), kopia: await kopia.status(ds),
    samba: !!(sh && sh.installed), hostname: sh ? sh.hostname : os.hostname(),
    users: sh ? sh.users.map((u) => u.name) : [],
    pools: ds.filter((d) => !d.name.includes('/')).map((d) => ({ name: d.name, mountpoint: d.mountpoint, free: d.avail })),
    folders: ds.filter((d) => d.mounted).map((d) => d.mountpoint),
  };
}

module.exports = {
  PROVIDERS, parseConf, buildConf, cleanRemotePath, cleanLocalPath, validateJob, validateSchedule, validateDevice, nextRun, targets, buildArgs, datasets, datasetOf, stampOf,
  parseLogLine, summarize, parseAuthLink, parseAuthToken, parseDatasets,
  overview, createRemote, testRemote, browse, deleteRemote, startAuth, finishAuth,
  saveJob, deleteJob, startRun, stopRun, restore, jobLog, startSchedule, createDevice, deleteDevice, devicePassword, devicePairing, setKopia,
};
