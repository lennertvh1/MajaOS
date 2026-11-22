'use strict';
// The activity log (Settings → Logs): who did what, and when.
// - MajaOS itself: every change through the API (the web page, the AI and MCP, Files: upload, delete, rename, new
//   folder, download) and every sign-in, also the failed ones. server.js calls `fromRequest` when a response ends.
// - Shared folders: Samba's full_audit module (lib/shares.js) writes to the journal as smbd_audit; `ingest` reads it
//   every 30 s and keeps what changes files (saved, new folder, renamed, deleted), per user.
// Entries are JSON lines in DATA_DIR/activity.log; at 8 MB it becomes activity.log.1 (one older file is kept).
// Also the system logs per service (journalctl), for the System tab.
const fs = require('node:fs');
const path = require('node:path');
const { run, httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'activity.log');
const STATE = path.join(DATA_DIR, 'activity.json');
const MAX_BYTES = 8 * 1024 * 1024;
const KINDS = ['signin', 'files', 'apps', 'vms', 'storage', 'shares', 'users', 'backup', 'network', 'settings', 'system', 'ai', 'other'];

/* ------------------------------------------------------------ writing */

function add(e) {
  const entry = {
    at: e.at || Date.now(), who: e.who || '', via: e.via || 'web', kind: KINDS.includes(e.kind) ? e.kind : 'other',
    action: String(e.action || ''), target: e.target ? String(e.target).slice(0, 400) : '', ok: e.ok !== false,
    ...(e.error ? { error: String(e.error).slice(0, 300) } : {}), ...(e.ip ? { ip: e.ip } : {}),
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { if (fs.statSync(FILE).size > MAX_BYTES) fs.renameSync(FILE, FILE + '.1'); } catch { /* no file yet */ }
    fs.appendFileSync(FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (err) { console.error('Activity log: ' + err.message); }
  return entry;
}

/* ------------------------------------------------------------ the API in plain words */

// [method, path pattern, kind, action, target (a function of the match and the query)]. The first that fits counts.
// Actions are English interface text: the browser translates them (tr).
const id = (m) => decodeURIComponent(m[1]);
const file = (m, q) => decodeURIComponent(m[1]) + '/' + (q.get('path') || '');
const ROUTES = [
  // not worth logging: reading, drafts, checks and the dashboard's own state
  ['POST', /^\/api\/(layout|ai\/chat|ai\/chats(\/.*)?|shortcuts\/fetch-icon|apps\/draft|apps\/custom\/inspect|ups\/scan|fans\/diagnose|mcp\/token|onboarding\/.*|login.*|setup)$/, null],
  ['POST', /^\/api\/terminal\/ticket$/, 'system', 'Opened the terminal'],
  ['POST', /^\/api\/terminal\/run$/, 'system', 'Ran a command on the server'],
  ['POST', /^\/api\/backup\/remotes\/[^/]+\/test$/, null],
  ['POST', /^\/api\/logout$/, 'signin', 'Signed out'],
  // files
  ['PUT', /^\/api\/shares\/([^/]+)\/files$/, 'files', 'Uploaded a file', file],
  ['DELETE', /^\/api\/shares\/([^/]+)\/files$/, 'files', 'Deleted', file],
  ['POST', /^\/api\/shares\/([^/]+)\/files$/, 'files', 'Changed files', file],
  ['GET', /^\/api\/shares\/([^/]+)\/files$/, 'files', 'Downloaded', file],
  ['POST', /^\/api\/files\/eject$/, 'files', 'Ejected a disk'],
  ['POST', /^\/api\/share-links$/, 'files', 'Made a share link'],
  ['DELETE', /^\/api\/share-links\/([0-9a-f]+)$/, 'files', 'Removed a share link', id],
  // apps
  ['POST', /^\/api\/apps\/([^/]+)\/start$/, 'apps', 'Started an app', id],
  ['POST', /^\/api\/apps\/([^/]+)\/stop$/, 'apps', 'Stopped an app', id],
  ['POST', /^\/api\/apps\/([^/]+)\/restart$/, 'apps', 'Restarted an app', id],
  ['POST', /^\/api\/apps\/([^/]+)\/update$/, 'apps', 'Updated an app', id],
  ['POST', /^\/api\/apps\/check-updates$/, 'apps', 'Checked the apps for updates'],
  ['POST', /^\/api\/apps\/([^/]+)\/settings$/, 'apps', 'Changed the settings of an app', id],
  ['POST', /^\/api\/apps\/([^/]+)\/compose(-form)?$/, 'apps', 'Changed the compose file of an app', id],
  ['POST', /^\/api\/apps\/([^/]+)\/exec$/, 'apps', 'Ran a command in an app', id],
  ['DELETE', /^\/api\/apps\/([^/]+)$/, 'apps', 'Removed an app', id],
  ['POST', /^\/api\/store\/apps\/([^/]+)\/install$/, 'apps', 'Installed an app', id],
  ['POST', /^\/api\/apps\/(custom|compose)$/, 'apps', 'Installed an app'],
  ['POST', /^\/api\/shortcuts(\/[^/]+)?$/, 'apps', 'Saved a shortcut'],
  ['DELETE', /^\/api\/shortcuts\/([^/]+)$/, 'apps', 'Removed a shortcut'],
  // VMs
  ['POST', /^\/api\/vms$/, 'vms', 'Created a VM'],
  ['PUT', /^\/api\/vm-media\/upload$/, 'vms', 'Uploaded a file for VMs'],
  ['POST', /^\/api\/vm-media\/download$/, 'vms', 'Downloaded a file for VMs'],
  ['DELETE', /^\/api\/vm-media\/jobs\/([^/]+)$/, 'vms', 'Stopped a download for VMs'],
  ['POST', /^\/api\/vms\/([^/]+)\/start$/, 'vms', 'Started a VM', id],
  ['POST', /^\/api\/vms\/([^/]+)\/stop$/, 'vms', 'Shut down a VM', id],
  ['POST', /^\/api\/vms\/([^/]+)\/reboot$/, 'vms', 'Restarted a VM', id],
  ['POST', /^\/api\/vms\/([^/]+)\/pause$/, 'vms', 'Paused a VM', id],
  ['POST', /^\/api\/vms\/([^/]+)\/resume$/, 'vms', 'Resumed a VM', id],
  ['POST', /^\/api\/vms\/([^/]+)\/force-stop$/, 'vms', 'Forced a VM off', id],
  ['POST', /^\/api\/vms\/([^/]+)\/reset$/, 'vms', 'Reset a VM', id],
  ['POST', /^\/api\/vms\/([^/]+)\/settings$/, 'vms', 'Changed the settings of a VM', id],
  ['DELETE', /^\/api\/vms\/([^/]+)$/, 'vms', 'Deleted a VM', id],
  ['POST', /^\/api\/vms\/([^/]+)\/snapshots$/, 'vms', 'Took a snapshot', id],
  ['POST', /^\/api\/vms\/([^/]+)\/snapshots\/([^/]+)\/revert$/, 'vms', 'Went back to a snapshot', (m) => id(m) + ' · ' + decodeURIComponent(m[2])],
  ['DELETE', /^\/api\/vms\/([^/]+)\/snapshots\/([^/]+)$/, 'vms', 'Removed a snapshot', (m) => id(m) + ' · ' + decodeURIComponent(m[2])],
  ['POST', /^\/api\/vm-networks(\/([^/]+)\/start)?$/, 'network', 'Changed a VM network'],
  ['DELETE', /^\/api\/vm-networks\/([^/]+)$/, 'network', 'Deleted a VM network', id],
  // storage
  ['POST', /^\/api\/pools$/, 'storage', 'Created a pool'],
  ['DELETE', /^\/api\/pools\/([^/]+)$/, 'storage', 'Deleted a pool', id],
  ['POST', /^\/api\/pools\/([^/]+)\/scrub$/, 'storage', 'Started a pool check', id],
  ['POST', /^\/api\/pools\/([^/]+)\/scrub-stop$/, 'storage', 'Stopped a pool check', id],
  ['POST', /^\/api\/pools\/([^/]+)\/export$/, 'storage', 'Disconnected a pool', id],
  ['POST', /^\/api\/pools\/import$/, 'storage', 'Imported a pool'],
  ['POST', /^\/api\/mixed-pools\/([^/]+)\/replace$/, 'storage', 'Replaced a disk', id],
  ['POST', /^\/api\/mixed-pools\/([^/]+)\/(sync|scrub|stop|schedule)$/, 'storage', 'Changed the parity of a pool', id],
  ['DELETE', /^\/api\/mixed-pools\/([^/]+)$/, 'storage', 'Removed a pool', id],
  ['POST', /^\/api\/storage-paths$/, 'storage', 'Changed where folders go'],
  ['POST', /^\/api\/spindown$/, 'storage', 'Changed disk sleep'],
  ['POST', /^\/api\/spindown\/([^/]+)\/sleep$/, 'storage', 'Put a disk to sleep', id],
  ['POST', /^\/api\/storage\/rescan$/, 'storage', 'Looked for new disks'],
  ['POST', /^\/api\/bays$/, 'storage', 'Changed the drive bays'],
  ['POST', /^\/api\/disks\/([^/]+)\/test$/, 'storage', 'Started a disk test', id],
  ['POST', /^\/api\/unraid\/(connect|migrate|close)$/, 'storage', 'Moving from Unraid'],
  // shared folders and users
  ['POST', /^\/api\/shares$/, 'shares', 'Created a shared folder'],
  ['POST', /^\/api\/shares\/([^/]+)\/fix-owner$/, 'shares', 'Made a shared folder writable', id],
  ['POST', /^\/api\/shares\/([^/]+)$/, 'shares', 'Changed a shared folder', id],
  ['DELETE', /^\/api\/shares\/([^/]+)$/, 'shares', 'Stopped sharing a folder', id],
  ['POST', /^\/api\/share-users$/, 'users', 'Created a user'],
  ['POST', /^\/api\/share-users\/([^/]+)\/password$/, 'users', 'Changed the password of a user', id],
  ['POST', /^\/api\/share-users\/([^/]+)\/dashboard$/, 'users', 'Changed the sign-in of a user', id],
  ['POST', /^\/api\/share-users\/([^/]+)$/, 'users', 'Changed the rights of a user', id],
  ['DELETE', /^\/api\/share-users\/([^/]+)$/, 'users', 'Deleted a user', id],
  ['POST', /^\/api\/share-groups(\/([^/]+))?$/, 'users', 'Saved a group'],
  ['DELETE', /^\/api\/share-groups\/([^/]+)$/, 'users', 'Deleted a group', id],
  // backups
  ['POST', /^\/api\/(backup\/jobs|sysbackups)\/([^/]+)\/run$/, 'backup', 'Started a backup'],
  ['POST', /^\/api\/(backup\/jobs|sysbackups)\/([^/]+)\/stop$/, 'backup', 'Stopped a backup'],
  ['POST', /^\/api\/(backup\/jobs|sysbackups)\/([^/]+)\/restore$/, 'backup', 'Restored a backup'],
  ['DELETE', /^\/api\/(backup\/jobs|sysbackups)\/([^/]+)$/, 'backup', 'Deleted a backup task'],
  ['POST', /^\/api\/(backup\/jobs|sysbackups)(\/[^/]+)?$/, 'backup', 'Saved a backup task'],
  ['POST', /^\/api\/backup\/(remotes|auth\/finish)$/, 'backup', 'Added a connection'],
  ['DELETE', /^\/api\/backup\/remotes\/([^/]+)$/, 'backup', 'Removed a connection', id],
  ['POST', /^\/api\/backup\/devices$/, 'backup', 'Added a device'],
  ['POST', /^\/api\/backup\/devices\/([^/]+)\/(pair|password)$/, 'backup', 'Made a new pairing code', id],
  ['DELETE', /^\/api\/backup\/devices\/([^/]+)$/, 'backup', 'Removed a device', id],
  ['POST', /^\/api\/backup\/kopia$/, 'backup', 'Changed the backup app'],
  // network
  ['POST', /^\/api\/network\/hostname$/, 'network', 'Changed the hostname'],
  ['POST', /^\/api\/network(\/(confirm|revert))?$/, 'network', 'Changed the network'],
  ['POST', /^\/api\/docker-networks$/, 'network', 'Created a Docker network'],
  ['DELETE', /^\/api\/docker-networks\/([^/]+)$/, 'network', 'Deleted a Docker network', id],
  ['POST', /^\/api\/remote$/, 'network', 'Changed remote access'],
  // settings, security, system
  ['POST', /^\/api\/password$/, 'signin', 'Changed the password'],
  ['POST', /^\/api\/mfa\/(enable|disable|recovery)$/, 'signin', 'Changed two-step verification'],
  ['POST', /^\/api\/settings$/, 'settings', 'Changed the settings'],
  ['POST', /^\/api\/(datetime|keyboard)$/, 'settings', 'Changed the date, time or keyboard'],
  ['POST', /^\/api\/ups$/, 'settings', 'Changed the UPS'],
  ['POST', /^\/api\/fans\/.*$/, 'settings', 'Changed the cooling'],
  ['POST', /^\/api\/update\/(install|check)$/, 'system', 'Software update of MajaOS'],
  ['POST', /^\/api\/system-updates\/([a-z-]+)$/, 'system', 'Debian updates', id],
  ['POST', /^\/api\/system\/power$/, 'system', 'Restarted or shut down the server'],
  // AI
  ['POST', /^\/api\/ai\/pull$/, 'ai', 'Downloaded an AI model'],
  ['DELETE', /^\/api\/ai\/models\/([^/]+)$/, 'ai', 'Deleted an AI model', id],
  ['POST', /^\/api\/ai\/models\/([^/]+)\/(load|unload)$/, 'ai', 'Loaded or unloaded an AI model', id],
  ['POST', /^\/api\/ai\/use-gpu$/, 'ai', 'Gave the AI the GPU'],
];

// What a request did, in plain words, or null when it isn't worth logging (reading, drafts, …).
// q: URLSearchParams. GET is only logged for downloads.
function describe(method, p, q = new URLSearchParams()) {
  if (method === 'GET' && !(q.get('dl') === '1' || q.get('zip') === '1')) return null;
  for (const [m, re, kind, action, target] of ROUTES) {
    if (m !== method) continue;
    const hit = p.match(re);
    if (!hit) continue;
    if (!kind) return null;
    return { kind, action, target: target ? target(hit, q) : '' };
  }
  return method === 'GET' ? null : { kind: 'other', action: `${method} ${p}`, target: '' };
}

// Called by server.js when a response has ended. `extra` (req.audit) can sharpen the action and target.
function fromRequest({ method, path: p, query, who, via, ip, status, extra, error }) {
  const d = describe(method, p, query);
  if (!d) return null;
  return add({ ...d, ...(extra || {}), who, via, ip, ok: status < 400, error: status >= 400 ? error : '' });
}

/* ------------------------------------------------------------ shared folders: Samba's full_audit */

// A line of full_audit (prefix %U|%I|%S, see lib/shares.js): user|ip|share|op|ok|… → an entry, or null.
// openat: …|ok|r|file or …|ok|w|file (only writes count); renameat: …|ok|old|new; mkdirat/unlinkat: …|ok|path.
function parseAudit(msg) {
  const parts = String(msg || '').split('|');
  if (parts.length < 6) return null;
  const [user, ip, share, op, result, ...rest] = parts;
  if (result !== 'ok') return null;
  const skip = (f) => !f || /(^|\/)(\.DS_Store|\._[^/]*|Thumbs\.db|desktop\.ini|\.TemporaryItems.*)$/i.test(f) || f.includes(':') || f === '.';
  const base = { who: user, via: 'smb', kind: 'files', ip };
  const at = (f) => share + '/' + String(f).replace(/^\.\//, '');
  if (op === 'openat') { if (rest[0] !== 'w' || skip(rest[1])) return null; return { ...base, action: 'Saved a file', target: at(rest[1]) }; }
  if (op === 'mkdirat') return skip(rest[0]) ? null : { ...base, action: 'Made a folder', target: at(rest[0]) };
  if (op === 'unlinkat') return skip(rest[0]) ? null : { ...base, action: 'Deleted', target: at(rest[0]) };
  if (op === 'renameat') return skip(rest[0]) || skip(rest[1]) ? null : { ...base, action: 'Renamed or moved', target: at(rest[0]) + ' → ' + at(rest[1]) };
  return null;
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s), { mode: 0o600 }); } catch { /* read-only */ } }

// journalctl -o json lines → entries. A file saved many times in a row by the same user counts once per 10 minutes.
function auditEntries(text, recent = new Map()) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const e = parseAudit(Array.isArray(j.MESSAGE) ? Buffer.from(j.MESSAGE).toString() : j.MESSAGE);
    if (!e) continue;
    e.at = Math.round(Number(j.__REALTIME_TIMESTAMP) / 1000) || Date.now();
    const key = e.who + '\0' + e.action + '\0' + e.target;
    if (recent.has(key) && e.at - recent.get(key) < 10 * 60000) continue;
    recent.set(key, e.at);
    out.push(e);
  }
  return out;
}

const recentSaves = new Map();
async function ingest() {
  const st = loadState();
  const args = ['-t', 'smbd_audit', '-o', 'json', '--no-pager', '-n', '20000'];
  args.push(...(st.cursor ? ['--after-cursor', st.cursor] : ['--since', '-1h']));
  let text;
  try { text = await run('journalctl', args, { timeout: 30000 }); } catch { return 0; }
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return 0;
  try { st.cursor = JSON.parse(lines[lines.length - 1]).__CURSOR || st.cursor; } catch { /* keep */ }
  const list = auditEntries(text, recentSaves);
  for (const e of list) add(e);
  for (const [k, at] of recentSaves) if (Date.now() - at > 15 * 60000) recentSaves.delete(k);
  saveState(st);
  return list.length;
}

let timer = null;
function startSchedule() {
  if (timer) return;
  timer = setInterval(() => ingest().catch((e) => console.error('Activity log: ' + e.message)), 30000);
  setTimeout(() => ingest().catch(() => {}), 5000);
}

/* ------------------------------------------------------------ reading */

function readLines(f) { try { return fs.readFileSync(f, 'utf8').split('\n'); } catch { return []; } }

// Newest first. Filters: who, kind, via, q (text in action or target), before (ms, for "Show more"). → {entries, more, people}
function list({ who = '', kind = '', via = '', q = '', before = 0, limit = 200 } = {}) {
  const all = [...readLines(FILE + '.1'), ...readLines(FILE)];
  const people = new Set(), out = [];
  const needle = String(q || '').toLowerCase();
  let more = false;
  for (let i = all.length - 1; i >= 0; i--) {
    if (!all[i]) continue;
    let e; try { e = JSON.parse(all[i]); } catch { continue; }
    if (e.who) people.add(e.who);
    if (before && e.at >= before) continue;
    if (who && e.who !== who) continue;
    if (kind && e.kind !== kind) continue;
    if (via && e.via !== via) continue;
    if (needle && !(`${e.action} ${e.target} ${e.who} ${e.ip || ''}`.toLowerCase().includes(needle))) continue;
    if (out.length >= limit) { more = true; continue; }
    out.push(e);
  }
  return { entries: out, more, people: [...people].sort(), kinds: KINDS };
}

/* ------------------------------------------------------------ system logs (journalctl) */

// The services of the System tab: id → journalctl arguments.
const SOURCES = {
  all: [],
  majaos: ['-u', 'majaos.service', '-u', 'majaos-tunnel.service', '-u', 'majaos-kopia.service'],
  docker: ['-u', 'docker.service', '-u', 'containerd.service'],
  samba: ['-u', 'smbd.service', '-u', 'nmbd.service', '-t', 'smbd_audit'],
  vms: ['-u', 'libvirtd.service', '-u', 'virtqemud.service', '-u', 'virtlogd.service'],
  zfs: ['-u', 'zfs-zed.service', '-u', 'zfs-import-cache.service', '-u', 'zfs-mount.service'],
  ups: ['-u', 'nut-server.service', '-u', 'nut-monitor.service', '-u', 'nut-driver@*', '-u', 'nut-driver-enumerator.service'],
  network: ['-u', 'networking.service', '-u', 'NetworkManager.service', '-u', 'systemd-networkd.service', '-u', 'dhcpcd.service'],
  ssh: ['-u', 'ssh.service'],
  updates: ['-u', 'apt-daily.service', '-u', 'apt-daily-upgrade.service', '-u', 'unattended-upgrades.service', '-t', 'majaos-update', '-t', 'majaos-apt'],
  kernel: ['-k'],
};
const PRIORITIES = { all: null, info: '6', warning: '4', error: '3' };

// journalctl -o json → [{at, unit, level, text}]; level from PRIORITY (0–3 error, 4 warning, 5–7 info).
function parseJournal(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const msg = Array.isArray(j.MESSAGE) ? Buffer.from(j.MESSAGE).toString() : String(j.MESSAGE == null ? '' : j.MESSAGE);
    const pr = Number(j.PRIORITY);
    out.push({
      at: Math.round(Number(j.__REALTIME_TIMESTAMP) / 1000) || 0,
      unit: String(j._SYSTEMD_UNIT || j.SYSLOG_IDENTIFIER || (j._TRANSPORT === 'kernel' ? 'kernel' : '')).replace(/\.service$/, ''),
      level: pr <= 3 ? 'error' : pr === 4 ? 'warning' : 'info',
      text: msg.slice(0, 2000),
    });
  }
  return out;
}

async function system({ source = 'majaos', level = 'all', q = '', lines = 300, before = 0 } = {}) {
  if (!Object.prototype.hasOwnProperty.call(SOURCES, source)) throw httpError('Unknown log.', 400);
  if (!Object.prototype.hasOwnProperty.call(PRIORITIES, level)) throw httpError('Unknown level.', 400);
  const n = Math.max(20, Math.min(2000, Number(lines) || 300));
  const args = ['-o', 'json', '--no-pager', '-n', String(n), ...SOURCES[source]];
  if (PRIORITIES[level]) args.push('-p', PRIORITIES[level]);
  if (q) args.push('-g', String(q).replace(/[^\p{L}\p{N} ._:/@-]/gu, '').slice(0, 80), '--case-sensitive=false');
  if (before) args.push('--until', '@' + Math.floor(Number(before) / 1000 - 0.001));
  let text = '';
  try { text = await run('journalctl', args, { timeout: 20000 }); } catch (e) {
    if (/No journal files|No entries/i.test(e.message)) text = '';
    else throw httpError('Reading the system log failed: ' + e.message, 500);
  }
  const entries = parseJournal(text).reverse(); // newest first
  return { source, level, sources: Object.keys(SOURCES), entries, more: entries.length >= n };
}

module.exports = { add, describe, fromRequest, parseAudit, auditEntries, ingest, startSchedule, list, parseJournal, system, SOURCES, KINDS, FILE };
