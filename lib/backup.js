'use strict';
/*
 * Backups.
 *  - Devices → NAS: each device gets its own dataset <pool>/backups/<name> (optionally with a quota) and a
 *    shared folder (lib/shares.js) with one user. A Mac uses it for Time Machine.
 *  - NAS → cloud or another NAS (and back): tasks with rclone. Connections are in DATA_DIR/rclone.conf (0600,
 *    passwords with `rclone obscure`), tasks and devices in DATA_DIR/backup.json, logs in DATA_DIR/backup-logs.
 *    Encrypting = a crypt connection hb-crypt-<id> around the destination; old versions = --backup-dir next to the destination.
 *  - Signing in to Google, Microsoft or Dropbox: `rclone authorize` listens on 127.0.0.1:53682. After signing in the
 *    browser ends up at that address (which doesn't exist on your own PC); you paste it here and we pass it on to rclone.
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

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'backup.json');
const CONF = path.join(DATA_DIR, 'rclone.conf');
const LOG_DIR = path.join(DATA_DIR, 'backup-logs');
const APP_UID = Number(process.env.APP_UID || 1000), APP_GID = Number(process.env.APP_GID || 1000);
const AUTH_PORT = 53682; // fixed in rclone: the return addresses of Google/Microsoft/Dropbox point here
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const CRYPT = 'hb-crypt-';
const EVERY = ['manual', 'hourly', 'daily', 'weekly'];
const DEVICE_KINDS = ['mac', 'windows', 'linux', 'phone'];

// Kinds of connections. Fields with obscure go through `rclone obscure`; secret never goes back to the browser.
const PROVIDERS = {
  drive: { label: 'Google Drive', group: 'cloud', oauth: true },
  onedrive: { label: 'OneDrive', group: 'cloud', oauth: true },
  dropbox: { label: 'Dropbox', group: 'cloud', oauth: true },
  s3: {
    label: 'S3 storage', group: 'cloud', hint: 'Backblaze B2, Wasabi, Cloudflare R2, Amazon S3 or MinIO', extra: { env_auth: 'false' },
    fields: [
      { key: 'provider', label: 'Provider', type: 'select', default: 'Other',
        options: [['Other', 'Other (e.g. Backblaze B2)'], ['AWS', 'Amazon S3'], ['Cloudflare', 'Cloudflare R2'], ['Wasabi', 'Wasabi'], ['Minio', 'MinIO']] },
      { key: 'endpoint', label: 'Endpoint', placeholder: 's3.eu-central-003.backblazeb2.com', help: 'The address of the storage. Leave empty for Amazon S3.' },
      { key: 'region', label: 'Region', placeholder: 'eu-central-003' },
      { key: 'access_key_id', label: 'Access key', required: true },
      { key: 'secret_access_key', label: 'Secret key', type: 'password', required: true, secret: true },
    ],
  },
  sftp: {
    label: 'Other NAS or server (SFTP)', group: 'nas', hint: 'Over SSH: Synology, QNAP, TrueNAS, another MajaOS or a Linux server',
    fields: [
      { key: 'host', label: 'Address', required: true, host: true, placeholder: '192.168.1.20' },
      { key: 'port', label: 'Port', type: 'number', default: '22' },
      { key: 'user', label: 'User', required: true },
      { key: 'pass', label: 'Password', type: 'password', required: true, secret: true, obscure: true },
    ],
  },
  smb: {
    label: 'Other NAS (SMB)', group: 'nas', hint: 'A shared folder on another NAS or a Windows PC',
    fields: [
      { key: 'host', label: 'Address', required: true, host: true, placeholder: '192.168.1.20' },
      { key: 'user', label: 'User', required: true },
      { key: 'pass', label: 'Password', type: 'password', required: true, secret: true, obscure: true },
      { key: 'domain', label: 'Workgroup', placeholder: 'WORKGROUP' },
    ],
  },
  webdav: {
    label: 'WebDAV', group: 'nas', hint: 'Nextcloud, ownCloud or another NAS with WebDAV',
    fields: [
      { key: 'url', label: 'Address (URL)', required: true, url: true, placeholder: 'https://cloud.example.com/remote.php/dav/files/lisa' },
      { key: 'vendor', label: 'Kind of server', type: 'select', default: 'other', options: [['nextcloud', 'Nextcloud'], ['owncloud', 'ownCloud'], ['other', 'Other']] },
      { key: 'user', label: 'User', required: true },
      { key: 'pass', label: 'Password', type: 'password', required: true, secret: true, obscure: true },
    ],
  },
};

/* ---- files */

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

// rclone.conf: [name] with key = value. Order is kept; comments disappear.
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

/* ---- checks */

const inside = (p, root) => p === root || p.startsWith(root.replace(/\/$/, '') + '/');
const isRoot = (p) => p === '' || p === '/';
const oneLine = (v) => !/[\x00-\x1f\x7f]/.test(v);

// Folder on the destination: plain folder names with /. A leading / stays (with SFTP that is an absolute path).
function cleanRemotePath(v) {
  const s = String(v == null ? '' : v).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const out = s.length > 1 ? s.replace(/\/+$/, '') : s;
  if (out.length > 500 || !oneLine(out) || out.split('/').some((x) => x === '..' || x === '.')) {
    throw httpError('That destination folder isn\'t possible. Use plain folder names, separated by /.', 400);
  }
  return out;
}

// Folder on the NAS: must be on one of your pools. Pulling something in goes into a folder of its own, not the whole pool.
function cleanLocalPath(v, datasets, direction) {
  const raw = String(v || '').trim();
  if (!raw.startsWith('/') || !oneLine(raw)) throw httpError('Choose a folder on one of your pools, e.g. /tank/photos.', 400);
  const p = path.resolve(raw);
  if (!datasets.some((d) => inside(p, d.mountpoint))) throw httpError('Choose a folder on one of your pools, e.g. /tank/photos.', 400);
  if (direction === 'pull' && datasets.some((d) => !d.name.includes('/') && d.mountpoint === p)) {
    throw httpError('Choose a folder of its own to store in, e.g. /tank/backups/google-drive, not the whole pool.', 400);
  }
  return p;
}

function validateSchedule(s) {
  const every = EVERY.includes(s && s.every) ? s.every : 'manual';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test((s && s.time) || '') ? s.time : '03:00';
  const day = Number.isInteger(Number(s && s.day)) && Number(s.day) >= 0 && Number(s.day) <= 6 ? Number(s.day) : 0;
  return { every, time, day };
}

// Check a task. ctx: { remotes (names), datasets [{name, mountpoint}], current (the task being edited) }
function validateJob(body, { remotes = [], datasets = [], current = null } = {}) {
  const name = String(body.name || '').replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 60);
  if (!name) throw httpError("Give the task a name, e.g. Photos to Google Drive.", 400);
  const direction = body.direction === 'pull' ? 'pull' : 'push';
  const mode = body.mode === 'sync' ? 'sync' : 'copy';
  const remote = String(body.remote || '');
  if (!remotes.includes(remote)) throw httpError('Choose a connection. Create one first under Connections.', 400);
  const remotePath = cleanRemotePath(body.remotePath);
  const localPath = cleanLocalPath(body.localPath, datasets, direction);
  // You choose encryption when creating: changing it later would make the files on the destination unreadable.
  const encrypt = direction === 'push' && (current ? !!current.encrypt : !!body.encrypt);
  if (mode === 'sync' && direction === 'push' && !encrypt && isRoot(remotePath)) {
    throw httpError('Choose a folder on the destination. Syncing to the top folder would delete everything else that is there.', 400);
  }
  const versions = direction === 'push' && !!body.versions;
  if (versions && !encrypt && isRoot(remotePath)) throw httpError('Choose a folder on the destination to be able to keep old versions.', 400);
  const keepDays = Math.min(3650, Math.max(1, Math.round(Number(body.keepDays) || 30)));
  const excludes = (Array.isArray(body.excludes) ? body.excludes : String(body.excludes || '').split('\n'))
    .map((x) => String(x).trim()).filter(Boolean);
  if (excludes.length > 50 || excludes.some((x) => x.length > 200 || !oneLine(x))) throw httpError('Give at most 50 patterns to exclude, one per line.', 400);
  const bwlimit = String(body.bwlimit || '').trim();
  if (bwlimit && !/^\d+(\.\d+)?[KMG]?$/i.test(bwlimit)) throw httpError('Write the bandwidth as a number with K, M or G, e.g. 10M (10 MB per second).', 400);
  return { name, direction, mode, remote, remotePath, localPath, encrypt, versions, keepDays, schedule: validateSchedule(body.schedule), excludes, bwlimit };
}

/* ---- schedule */

// Next time after `from` (ms), in the server's time zone. null = manual only.
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

// The destination of a task, and where old versions go. Encrypted: everything inside the crypt connection.
// Tasks from before version 0.6 keep their Dutch folder names on the destination (names !== 'en'), so they find their files.
function targets(job) {
  const n = job.names === 'en' ? { files: 'files', versions: 'versions', old: 'old versions' } : { files: 'bestanden', versions: 'versies', old: 'oude versies' };
  if (job.encrypt) return { remote: `${cryptName(job.id)}:${n.files}`, versions: `${cryptName(job.id)}:${n.versions}` };
  return {
    remote: `${job.remote}:${job.remotePath}`,
    versions: isRoot(job.remotePath) ? null : `${job.remote}:${job.remotePath} (${n.old})`,
  };
}

// kind: backup (the task itself) or restore (from the destination back to target on the NAS).
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

// One line of rclone with --use-json-log: text (with the file) or an intermediate state (stats).
function parseLogLine(line) {
  let j = null;
  try { j = JSON.parse(line); } catch { /* not JSON, e.g. an error at startup */ }
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
  if (!(await rcloneVersion())) throw httpError('rclone is not installed on the server. Run install.sh again, or on the server: sudo apt install rclone', 503);
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
// The deepest dataset a path is on.
const datasetOf = (p, ds) => ds.filter((d) => inside(p, d.mountpoint)).sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0] || null;

/* ---- connections */

function remoteDetail(o) {
  if (o.type === 'sftp' || o.type === 'smb') return [o.user, o.host].filter(Boolean).join('@') + (o.port && o.port !== '22' ? ':' + o.port : '');
  if (o.type === 'webdav') return o.url || '';
  if (o.type === 's3') return o.endpoint || o.provider || '';
  if (o.type === 'onedrive') return o.drive_type === 'personal' ? 'OneDrive (personal)' : o.drive_type ? 'OneDrive for work or school' : '';
  return '';
}
function listRemotes(jobs = load().jobs) {
  return readConf().filter((s) => !isCrypt(s.name)).map((s) => ({
    name: s.name, type: s.opts.type, label: (PROVIDERS[s.opts.type] || {}).label || s.opts.type, detail: remoteDetail(s.opts),
    usedBy: jobs.filter((j) => j.remote === s.name).map((j) => j.name),
  }));
}
function checkNewName(name) {
  if (!REMOTE.test(name) || isCrypt(name)) throw httpError('Choose a name with letters, digits, - or _ (at most 32 characters), e.g. google.', 400);
  if (readConf().some((s) => s.name.toLowerCase() === name.toLowerCase())) throw httpError(`A connection named ${name} already exists.`, 409);
}

// Without signing in through the browser: address, user and password (SFTP, SMB, WebDAV, S3).
async function remoteOptions(body) {
  const p = PROVIDERS[body.type];
  if (!p || p.oauth) throw httpError('Choose a kind of connection.', 400);
  const opts = { type: body.type, ...(p.extra || {}) };
  for (const f of p.fields) {
    const v = String(body[f.key] == null || body[f.key] === '' ? (f.default || '') : body[f.key]).trim();
    if (!v) { if (f.required) throw httpError(`Fill in ${f.label.toLowerCase()}.`, 400); continue; }
    if (v.length > 500 || !oneLine(v)) throw httpError(`${f.label} can't contain a line break.`, 400);
    if (f.type === 'number' && !(/^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535)) throw httpError('Choose a port between 1 and 65535.', 400);
    if (f.host && !/^[A-Za-z0-9._:[\]-]+$/.test(v)) throw httpError(`"${v}" is not a valid address. Use an IP address or a name, e.g. 192.168.1.20.`, 400);
    if (f.url && !/^https?:\/\/\S+$/i.test(v)) throw httpError('The address must start with http:// or https://.', 400);
    if (f.type === 'select' && !f.options.some(([k]) => k === v)) throw httpError(`Choose a valid value for ${f.label.toLowerCase()}.`, 400);
    opts[f.key] = f.obscure ? await obscure(v) : v;
  }
  return opts;
}

// New connection, or (signing in again) replace an existing one. If it doesn't work, everything stays as it was.
async function addRemote(name, opts) {
  const before = readConf(), old = before.find((s) => s.name === name);
  writeConf(old ? before.map((s) => (s.name === name ? { name, opts } : s)) : before.concat({ name, opts }));
  try { await testRemote(name); }
  catch (e) {
    writeConf(old ? readConf().map((s) => (s.name === name ? old : s)) : readConf().filter((s) => s.name !== name));
    throw httpError('Connecting failed: ' + e.message, 400);
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
  if (!sec) throw httpError('This connection doesn\'t exist (anymore).', 404);
  await run('rclone', ['lsjson', name + ':', '--dirs-only', '--max-depth', '1', '--config', CONF], { timeout: 45000 });
  // Not every kind knows its free space (e.g. SMB); then just without.
  const about = await run('rclone', ['about', name + ':', '--json', '--config', CONF], { timeout: 20000 })
    .then((o) => { const j = JSON.parse(o); return { total: j.total ?? null, used: j.used ?? null, free: j.free ?? null }; }, () => null);
  return { ok: true, about };
}

async function browse(name, p) {
  if (!readConf().some((s) => s.name === name && !isCrypt(s.name))) throw httpError('This connection doesn\'t exist (anymore).', 404);
  const clean = cleanRemotePath(p);
  const out = await run('rclone', ['lsjson', `${name}:${clean}`, '--dirs-only', '--config', CONF], { timeout: 45000 });
  const dirs = (JSON.parse(out || '[]') || []).map((x) => x.Name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return { path: clean, dirs };
}

function deleteRemote(name) {
  const sections = readConf();
  if (!sections.some((s) => s.name === name && !isCrypt(s.name))) throw httpError('This connection doesn\'t exist (anymore).', 404);
  const used = load().jobs.filter((j) => j.remote === name).map((j) => j.name);
  if (used.length) throw httpError(`The connection ${name} is still used by ${used.join(', ')}. Remove or change those tasks first.`, 409);
  writeConf(sections.filter((s) => s.name !== name));
  return { removed: name };
}

/* ---- signing in to Google, Microsoft or Dropbox */

let auth = null; // { id, type, child, out, timer }

function localGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 30000 }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
    req.on('timeout', () => req.destroy(new Error('rclone did not respond.')));
    req.on('error', reject);
  });
}
function stopAuth() {
  if (!auth) return;
  clearTimeout(auth.timer);
  try { auth.child && auth.child.kill('SIGTERM'); } catch { /* already stopped */ }
  auth = null;
}
const parseAuthLink = (out) => { const m = String(out).match(/http:\/\/127\.0\.0\.1:53682\/auth\?state=[\w-]+/); return m ? m[0] : null; };

// What `rclone authorize` shows at the end: a token (JSON), or in newer versions base64 of {"token": "…", …}.
function parseAuthToken(text) {
  const s = String(text || '');
  const block = s.match(/--->\s*([\s\S]*?)\s*<---/);
  const raw = (block ? block[1] : s).trim();
  if (!raw) return null;
  const asToken = (str) => { try { const j = JSON.parse(str); return j && j.access_token ? JSON.stringify(j) : null; } catch { return null; } };
  if (raw.startsWith('{')) {
    const tok = asToken(raw);
    if (tok) return { token: tok, extra: {} };
    try { const j = JSON.parse(raw); if (j && typeof j.token === 'string' && asToken(j.token)) { const { token, ...extra } = j; return { token: asToken(token), extra }; } } catch { /* continue */ }
    return null;
  }
  try {
    const j = JSON.parse(Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8'));
    if (j && typeof j.token === 'string' && asToken(j.token)) { const { token, ...extra } = j; return { token: asToken(token), extra }; }
  } catch { /* not base64 */ }
  return null;
}

async function startAuth(type) {
  await needRclone();
  if (!PROVIDERS[type] || !PROVIDERS[type].oauth) throw httpError('Choose Google Drive, OneDrive or Dropbox.', 400);
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
    throw httpError('rclone gave no sign-in link.' + (last ? ' ' + last : ''), 502);
  }
  // The local link redirects to the sign-in page; we give that to the browser.
  const res = await localGet(local);
  if (!res.headers.location) { stopAuth(); throw httpError('rclone gave no sign-in link.', 502); }
  return { session: a.id, url: res.headers.location };
}

// OneDrive also needs the id and the kind of the drive: we ask Microsoft for those ourselves.
function oneDriveInfo(token) {
  return new Promise((resolve, reject) => {
    const access = JSON.parse(token).access_token;
    const req = https.get('https://graph.microsoft.com/v1.0/me/drive', { headers: { Authorization: 'Bearer ' + access }, timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { const j = JSON.parse(body); if (res.statusCode === 200 && j.id) return resolve({ drive_id: j.id, drive_type: j.driveType || 'personal' }); } catch { /* below */ }
        reject(httpError('Your OneDrive could not be retrieved (' + res.statusCode + ').', 502));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Time-out at Microsoft.')));
    req.on('error', reject);
  });
}

// body: { name, type, session + url (the address after signing in) or token (from `rclone authorize` on another PC), reconnect }
// reconnect: sign in an existing connection again (e.g. after a new password at Google); the tasks keep using it.
async function finishAuth(body) {
  await needRclone();
  const name = String(body.name || '').trim();
  const type = String(body.type || '');
  if (!PROVIDERS[type] || !PROVIDERS[type].oauth) throw httpError('Choose Google Drive, OneDrive or Dropbox.', 400);
  if (!body.reconnect) checkNewName(name);
  else if (!readConf().some((s) => s.name === name && s.opts.type === type)) throw httpError('This connection doesn\'t exist (anymore).', 404);
  let got;
  if (body.token) {
    got = parseAuthToken(body.token);
    if (!got) throw httpError('That is not a valid token. Paste everything between ---> and <---End paste.', 400);
  } else {
    const a = auth;
    if (!a || a.id !== body.session || a.type !== type) throw httpError('Signing in expired. Start again.', 410);
    let u;
    try { u = new URL(String(body.url || '').trim()); } catch { u = null; }
    if (u && u.searchParams.get('error')) throw httpError('You didn\'t give permission. Try again and click Allow.', 400);
    if (!u || !u.searchParams.get('code') || !u.searchParams.get('state')) {
      throw httpError('Paste the full address from the address bar. It starts with http://127.0.0.1:53682/.', 400);
    }
    await localGet(`http://127.0.0.1:${AUTH_PORT}/?` + u.searchParams.toString());
    for (let i = 0; i < 300 && !(got = parseAuthToken(a.out)) && !a.done; i++) await wait(100);
    got = got || parseAuthToken(a.out);
    stopAuth();
    if (!got) throw httpError('Signing in failed. Start again.', 502);
  }
  const opts = { type, ...(type === 'drive' ? { scope: 'drive' } : {}), ...got.extra, token: got.token };
  if (type === 'onedrive' && !opts.drive_id) Object.assign(opts, await oneDriveInfo(got.token));
  for (const [k, v] of Object.entries(opts)) if (!/^[a-z_]+$/.test(k) || !oneLine(String(v))) delete opts[k];
  return addRemote(name, opts);
}

/* ---- tasks */

const live = new Map(); // id → running task (only in memory)
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
  if (id && !current) throw httpError('This task doesn\'t exist (anymore).', 404);
  if (id && live.has(id)) throw httpError('This task is running now. Stop it first, or wait until it is done.', 409);
  const sections = readConf();
  const job = validateJob(body, { remotes: sections.filter((s) => !isCrypt(s.name)).map((s) => s.name), datasets: await datasets(), current });
  const out = current ? { ...current, ...job } : { id: newId(), ...job, names: 'en', created: Date.now(), lastRun: null, history: [] };
  // A new schedule counts from now: a time that has already passed today only comes the next time.
  if (!current || JSON.stringify(current.schedule) !== JSON.stringify(job.schedule)) out.lastScheduled = Date.now();
  if (job.encrypt) {
    const cname = cryptName(out.id);
    let sec = sections.find((s) => s.name === cname);
    if (!sec) {
      if (current) throw httpError('The key of this encrypted task is missing from rclone.conf.', 409);
      const pw = String(body.password || '');
      if (pw.length < 10 || pw.length > 200 || !oneLine(pw)) throw httpError('Choose an encryption password of at least 10 characters.', 400);
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
  if (!data.jobs.some((j) => j.id === id)) throw httpError('This task doesn\'t exist (anymore).', 404);
  if (live.has(id)) throw httpError('This task is running now. Stop it first, or wait until it is done.', 409);
  data.jobs = data.jobs.filter((j) => j.id !== id);
  save(data);
  const sections = readConf();
  if (sections.some((s) => s.name === cryptName(id))) writeConf(sections.filter((s) => s.name !== cryptName(id)));
  fs.rmSync(path.join(LOG_DIR, id + '.json'), { force: true });
  return { removed: id };
}

// Before starting: does everything still exist, is the pool mounted, and doesn't a sync accidentally erase everything?
async function preflight(job, kind, dryRun, target) {
  await needRclone();
  if (!readConf().some((s) => s.name === job.remote)) throw httpError(`The connection ${job.remote} no longer exists. Choose another connection under Edit.`, 409);
  const local = kind === 'restore' ? target : job.localPath;
  const ds = datasetOf(local, await datasets());
  if (!ds) throw httpError(`${local} is not on one of your pools.`, 409);
  if (!ds.mounted) throw httpError(`The dataset ${ds.name} is not mounted. Check under Storage whether your pool is all right.`, 409);
  if (kind === 'backup' && job.direction === 'push') {
    let entries;
    try { entries = fs.readdirSync(local); } catch { throw httpError(`The folder ${local} doesn't exist (anymore).`, 409); }
    if (!entries.length && job.mode === 'sync' && !dryRun) throw httpError(`The folder ${local} is empty. Syncing would delete everything on the destination, so the task doesn't start.`, 409);
  } else if (!fs.existsSync(local)) {
    fs.mkdirSync(local, { recursive: true });
    try { fs.chownSync(local, APP_UID, APP_GID); } catch { /* not root */ }
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

// After a successful task: clean up old versions; make what came in owned by the app user (like with the shared folders).
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
  if (!job) throw httpError('This task doesn\'t exist (anymore).', 404);
  if (live.has(id)) throw httpError('This task is already running.', 409);
  const r = { kind, dryRun, scheduled, started: Date.now(), stats: null, lines: [], lastError: null, child: null, cancelled: false };
  live.set(id, r); // right away, so a second click doesn't start it too
  try { await preflight(job, kind, dryRun, target); } catch (e) { live.delete(id); throw e; }
  const say = (level, text) => { r.lines.push({ time: new Date().toISOString(), level, text }); if (r.lines.length > 400) r.lines.splice(0, r.lines.length - 400); };
  say('info', kind === 'restore' ? `Restoring to ${target}` : (dryRun ? 'Dry run (nothing changes): ' : '') + `${job.direction === 'pull' ? targets(job).remote + ' → ' + job.localPath : job.localPath + ' → ' + job.remote + ':' + job.remotePath}`);
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
      say(entry.state === 'ok' ? 'info' : 'error', entry.state === 'ok' ? 'Done.' : entry.state === 'cancelled' ? 'Stopped.' : 'Failed: ' + (entry.error || ''));
      record(id, entry, r.lines);
    })
    .catch((e) => console.error('Backup ' + id + ': ' + e.message))
    .finally(() => live.delete(id));
  return { started: true, kind, dryRun };
}

function stopRun(id) {
  const r = live.get(id);
  if (!r) throw httpError('This task isn\'t running.', 409);
  r.cancelled = true;
  if (r.child) r.child.kill('SIGTERM');
  return { stopping: true };
}

async function restore(id, body) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('This task doesn\'t exist (anymore).', 404);
  if (job.direction !== 'push') throw httpError('Restoring only works for a task that goes to the cloud or another NAS.', 400);
  const target = cleanLocalPath(body.target, await datasets(), 'pull');
  return startRun(id, { kind: 'restore', target });
}

function jobLog(id) {
  const job = load().jobs.find((j) => j.id === id);
  if (!job) throw httpError('This task doesn\'t exist (anymore).', 404);
  const r = live.get(id);
  let lines = r ? r.lines : [];
  if (!r) { try { lines = JSON.parse(fs.readFileSync(path.join(LOG_DIR, id + '.json'), 'utf8')); } catch { lines = []; } }
  return { running: liveInfo(r), lines, last: (job.history || [])[0] || null };
}

// Every 30 s: is a scheduled task due? Missed times (server off) are caught up once.
function tick() {
  const data = load(), now = Date.now();
  let changed = false;
  for (const job of data.jobs) {
    const next = nextRun(job.schedule, job.lastScheduled || job.created);
    if (!next || next > now) continue;
    job.lastScheduled = now; changed = true;
    if (live.has(job.id)) continue; // still running from the previous time: skip this time
    startRun(job.id, { scheduled: true }).catch((e) => {
      record(job.id, { kind: 'backup', dryRun: false, scheduled: true, started: now, ended: Date.now(), state: 'failed', bytes: 0, files: 0, checks: 0, deletes: 0, errors: 1, error: e.message },
        [{ time: new Date().toISOString(), level: 'error', text: 'Not started: ' + e.message }]);
    });
  }
  if (changed) save(data);
}
function startSchedule() { setInterval(tick, 30000); }

/* ---- devices → NAS */

// When something last changed in the folder (two levels deep, at most 3000 items).
function latestChange(dir) {
  let max = 0, seen = 0;
  const walk = (p, depth) => {
    let list;
    try { list = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (++seen > 3000) return;
      const f = path.join(p, e.name);
      try { const st = fs.lstatSync(f); if (st.mtimeMs > max) max = st.mtimeMs; } catch { /* gone */ }
      if (e.isDirectory() && depth < 2) walk(f, depth + 1);
    }
  };
  walk(dir, 0);
  return max ? Math.round(max) : null;
}

// method: share (a shared folder: Time Machine, File History, apps on a phone) or kopia (the backup app, lib/kopia.js).
function validateDevice(body, { devices = [], shareNames = [], pools = [], users = [] } = {}) {
  const name = String(body.name || '').trim();
  if (!DEVICE.test(name)) throw httpError('Choose a name with letters, digits, - or _ (at most 32 characters), e.g. MacBook-Lisa.', 400);
  if (devices.some((d) => d.name.toLowerCase() === name.toLowerCase())) throw httpError(`A device named ${name} already exists.`, 409);
  if (!DEVICE_KINDS.includes(body.kind)) throw httpError('Choose what kind of device it is.', 400);
  if (body.method === 'kopia') {
    if (body.kind === 'phone') throw httpError('The backup app doesn\'t exist for phones. Choose a shared folder.', 400);
    return { name, kind: body.kind, method: 'kopia', user: kopia.userId(name) };
  }
  if (shareNames.some((n) => n.toLowerCase() === name.toLowerCase())) throw httpError(`A shared folder named ${name} already exists.`, 409);
  const pool = String(body.pool || '');
  if (!pools.includes(pool)) throw httpError('Choose the pool for the backups.', 400);
  const quotaGb = body.quotaGb === '' || body.quotaGb == null ? 0 : Number(body.quotaGb);
  if (!Number.isInteger(quotaGb) || quotaGb < 0 || quotaGb > 1e6) throw httpError('Fill in the maximum size as a number in GB, or leave it empty.', 400);
  const user = body.newUser ? String(body.newUser.name || '').trim() : String(body.user || '');
  if (!body.newUser && !users.includes(user)) throw httpError('Choose who may make the backups.', 400);
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

// A device with the backup app: a Kopia user. The password is returned only once.
async function createKopiaDevice(body) {
  const dev = validateDevice(body, { devices: load().devices });
  await kopia.addUser(dev.name);
  const device = { name: dev.name, kind: dev.kind, method: 'kopia', user: dev.user, created: Date.now() };
  const data = load();
  data.devices.push(device);
  save(data);
  // A pairing code right away (and the matching password, for KopiaUI or the command line).
  const pair = await kopia.newPairing(dev.name);
  return { ...device, ...pair };
}

async function createDevice(body) {
  if (body.method === 'kopia') return createKopiaDevice(body);
  const [sh, ds] = await Promise.all([shares.listShares(), datasets()]);
  if (!sh.installed) throw httpError('Samba is not installed yet. Run install.sh again, or on the server: sudo apt install samba', 503);
  const dev = validateDevice(body, {
    devices: load().devices, shareNames: sh.shares.map((s) => s.name), pools: ds.filter((d) => !d.name.includes('/')).map((d) => d.name),
    users: sh.users.map((u) => u.name),
  });
  if (ds.some((d) => d.name === dev.dataset)) throw httpError(`The dataset ${dev.dataset} already exists. Choose another name.`, 409);
  if (body.newUser) await shares.createUser(body.newUser);
  await run('zfs', ['create', '-p', ...(dev.quotaGb ? ['-o', `quota=${dev.quotaGb}G`] : []), dev.dataset], { timeout: 30000 });
  try {
    const mp = (await run('zfs', ['get', '-H', '-o', 'value', 'mountpoint', dev.dataset])).trim();
    try { fs.chownSync(mp, APP_UID, APP_GID); fs.chmodSync(mp, 0o775); } catch { /* not root */ }
    await shares.saveShare({ name: dev.name, path: mp, comment: `Backups of ${dev.name}`, users: { [dev.user]: 'rw' }, guest: false, timemachine: dev.kind === 'mac' });
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
  if (!d) throw httpError('This device doesn\'t exist (anymore).', 404);
  if (d.method === 'kopia') await kopia.removeUser(d.name, withData);
  else {
    await shares.deleteShare(name).catch((e) => { if (e.status !== 404) throw e; });
    if (withData) {
      if (!/^[^/]+\/backups\/[^/]+$/.test(d.dataset)) throw httpError('I won\'t erase this dataset automatically: ' + d.dataset, 400);
      await run('zfs', ['destroy', '-r', d.dataset], { timeout: 5 * 60000 });
    }
  }
  const fresh = load();
  fresh.devices = fresh.devices.filter((x) => x.name !== name);
  save(fresh);
  return { removed: name, dataset: withData && d.method !== 'kopia' ? d.dataset : null };
}

// Pairing code for the MajaOS Backup app (also creates a new password).
async function devicePairing(name) {
  const d = load().devices.find((x) => x.name === name);
  if (!d) throw httpError('This device doesn\'t exist (anymore).', 404);
  if (d.method !== 'kopia') throw httpError('Pairing only works for a device with the backup app.', 400);
  return { name, ...(await kopia.newPairing(d.name)) };
}

// New password for a device with the backup app (the old one stops working right away).
async function devicePassword(name) {
  const d = load().devices.find((x) => x.name === name);
  if (!d) throw httpError('This device doesn\'t exist (anymore).', 404);
  if (d.method !== 'kopia') throw httpError('You change the password of a shared folder under Shared folders → Users.', 400);
  return { name, password: await kopia.setPassword(d.name) };
}

// Turn the backup app on or off. On: the pool for the repository. Off: users and repository stay.
async function setKopia(body) {
  return body.enabled ? kopia.enable(body.pool, await datasets()) : kopia.disable();
}

/* ---- overview */

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
