'use strict';
/*
 * Shared folders (Samba), their users and groups.
 * DATA_DIR/shares.json is the source: { shares: [{ name, path, comment, users: { name: 'ro' | 'rw' }, groups: { group: 'ro' | 'rw' }, guest, timemachine }],
 *   users: [name], groups: [{ name, comment, members: [name] }] }.
 * A group gives all its members the group's rights; whoever has several routes gets the highest right (effectiveUsers).
 * Samba simply gets the list of users per folder: no Linux groups needed.
 * From that we build /etc/samba/majaos.conf (checked with testparm first), and smb.conf gets one include line.
 * Files are written as the app user (APP_UID/APP_GID), the same as that of the Docker apps.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, readText, httpError } = require('./system');
const { snapdir } = require('./shadow');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'shares.json');
const SMB_CONF = process.env.SMB_CONF || '/etc/samba/smb.conf';
const INCLUDE = process.env.SMB_INCLUDE || '/etc/samba/majaos.conf';
const APP_UID = Number(process.env.APP_UID || 1000), APP_GID = Number(process.env.APP_GID || 1000);
const SHARE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const RESERVED = /^(global|homes|printers|print\$|ipc\$)$/i;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const GROUP = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { shares: (j.shares || []).map((x) => ({ groups: {}, ...x })), users: j.users || [], groups: j.groups || [] };
  } catch { return { shares: [], users: [], groups: [] }; }
}
function shareByName(name) {
  if (!SHARE.test(String(name || ''))) throw httpError('This shared folder no longer exists.', 404);
  const s = load().shares.find((x) => x.name === name);
  if (!s) throw httpError('This shared folder no longer exists.', 404);
  return s;
}
function store(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}

// Name of a user or group by uid/gid (from /etc/passwd or /etc/group).
function idName(file, id) {
  const line = readText(file).split('\n').find((l) => l.split(':')[2] === String(id));
  return line ? line.split(':')[0] : null;
}
const systemUsers = () => new Set(readText('/etc/passwd').split('\n').map((l) => l.split(':')[0]).filter(Boolean));

/* ---- configuration */

// Who may access a folder: directly or through a group. The highest right counts (rw over ro).
function effectiveUsers(share, groups = []) {
  const out = { ...(share.users || {}) };
  for (const [g, level] of Object.entries(share.groups || {})) {
    const group = groups.find((x) => x.name === g);
    for (const m of (group && group.members) || []) if (out[m] !== 'rw') out[m] = level;
  }
  return out;
}

// The share sections for majaos.conf. forceUser/forceGroup: this way everyone writes as the app user.
function buildSmbConf(shares, { forceUser = null, forceGroup = null, groups = [], mounts = [] } = {}) {
  const out = ['# Created by MajaOS. Change shared folders in Settings → Shared folders; changes here are overwritten.', ''];
  for (const share of [...shares].sort((a, b) => a.name.localeCompare(b.name))) {
    const s = { ...share, users: effectiveUsers(share, groups) };
    const users = Object.keys(s.users).sort();
    // An empty "valid users" means in Samba: anyone who signs in. Without users and without guests: don't share.
    if (!users.length && !s.guest) continue;
    const writers = users.filter((u) => s.users[u] === 'rw');
    out.push(`[${s.name}]`, `   path = ${s.path}`);
    if (s.comment) out.push(`   comment = ${s.comment}`);
    out.push('   browseable = yes', '   read only = yes');
    if (s.guest) out.push('   guest ok = yes'); // guests may read; whoever is listed by name just signs in
    else out.push(`   valid users = ${users.join(' ')}`, '   guest ok = no');
    if (writers.length) out.push(`   write list = ${writers.join(' ')}`);
    if (forceUser) out.push(`   force user = ${forceUser}`);
    if (forceGroup) out.push(`   force group = ${forceGroup}`);
    const snap = snapdir(s.path, mounts);
    out.push('   create mask = 0664', '   directory mask = 0775', '   vfs objects = catia fruit streams_xattr' + (snap ? ' shadow_copy2' : ''));
    // Windows Previous Versions: the snapshots of this dataset, newest first. The name is GMT time.
    if (snap) out.push(`   shadow:snapdir = ${snap}`, '   shadow:sort = desc', '   shadow:format = GMT-%Y.%m.%d-%H.%M.%S', '   shadow:localtime = no');
    if (s.timemachine) out.push('   fruit:time machine = yes');
    out.push('');
  }
  return out.join('\n');
}

// Check a shared folder. ctx: { names (other shares), users (existing users), groups (names), roots (allowed folders) }
function validateShare(body, { names = [], users = [], groups = [], roots = [] } = {}) {
  const name = String(body.name || '').trim();
  if (!SHARE.test(name) || RESERVED.test(name)) throw httpError('Choose a name with letters, digits, -, _ or . (at most 32 characters), e.g. media.', 400);
  if (names.some((n) => n.toLowerCase() === name.toLowerCase())) throw httpError(`A shared folder named ${name} already exists.`, 409);
  const comment = String(body.comment || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  const access = {};
  for (const [u, v] of Object.entries(body.users || {})) {
    if (v !== 'ro' && v !== 'rw') continue; // no access
    if (!users.includes(u)) throw httpError(`The user ${u} no longer exists.`, 400);
    access[u] = v;
  }
  const groupAccess = {};
  for (const [g, v] of Object.entries(body.groups || {})) {
    if (v !== 'ro' && v !== 'rw') continue;
    if (!groups.includes(g)) throw httpError(`The group ${g} doesn't exist (anymore).`, 400);
    groupAccess[g] = v;
  }
  const guest = !!body.guest;
  if (!guest && !Object.keys(access).length && !Object.keys(groupAccess).length) throw httpError('Give at least one user or group access, or let guests read.', 400);
  let p = null;
  if (!body.create) {
    p = path.resolve(String(body.path || ''));
    if (/[\r\n]/.test(String(body.path || '')) || !roots.some((r) => p === r || p.startsWith(r + '/'))) {
      throw httpError('Choose a folder on one of your pools (e.g. /tank/media).', 400);
    }
  }
  return { name, path: p, comment, users: access, groups: groupAccess, guest, timemachine: !!body.timemachine };
}

// Check a group. ctx: { names (other groups), users (existing users) }
function validateGroup(body, { names = [], users = [] } = {}) {
  const name = String(body.name || '').trim();
  if (!GROUP.test(name)) throw httpError('Choose a group name with letters, digits, -, _ or . (at most 32 characters), e.g. Family.', 400);
  if (names.some((n) => n.toLowerCase() === name.toLowerCase())) throw httpError(`A group named ${name} already exists.`, 409);
  const comment = String(body.comment || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  const members = [...new Set((Array.isArray(body.members) ? body.members : []).map(String))];
  const bad = members.find((m) => !users.includes(m));
  if (bad) throw httpError(`The user ${bad} no longer exists.`, 400);
  return { name, comment, members: members.sort() };
}

function validatePassword(pw) {
  const p = String(pw || '');
  if (p.length < 8) throw httpError('Choose a password of at least 8 characters.', 400);
  if (p.length > 128 || /[\r\n\0]/.test(p)) throw httpError('This password is not allowed: at most 128 characters and no line breaks.', 400);
  return p;
}

/* ---- server */

// Folders where a shared folder may go: the mount points of your ZFS datasets and the pools with mixed disks.
async function roots() {
  const out = await run('zfs', ['list', '-H', '-o', 'name,mountpoint', '-t', 'filesystem'], { timeout: 8000 }).catch(() => '');
  const zfs = out.split('\n').map((l) => l.split('\t')).filter(([n, m]) => n && m && m.startsWith('/')).map(([name, mountpoint]) => ({ name, mountpoint }));
  const mixed = require('./mixed').status().filter((p) => p.health !== 'UNAVAIL').map((p) => ({ name: p.name, mountpoint: p.mountpoint, mixed: true }));
  return [...zfs, ...mixed];
}
async function sambaUsers() {
  const out = await run('pdbedit', ['-L'], { timeout: 8000 }).catch(() => '');
  return out.split('\n').map((l) => l.split(':')[0]).filter((u) => USER.test(u));
}

// `smbstatus -j` (Samba 4.16+): how many devices are connected, and per shared folder.
function parseSmbstatus(j) {
  const sessions = Object.values((j && j.sessions) || {}), tcons = Object.values((j && j.tcons) || {});
  const perShare = {};
  tcons.forEach((t) => { if (t.service && t.service !== 'IPC$') perShare[t.service] = (perShare[t.service] || 0) + 1; });
  return { total: new Set(sessions.map((x) => x.remote_machine || x.hostname || x.session_id)).size, perShare };
}

async function listShares() {
  const data = load();
  const [installed, active, r, smbUsers, status] = await Promise.all([
    run('which', ['smbd'], { timeout: 3000 }).then(() => true, () => false),
    run('systemctl', ['is-active', 'smbd'], { timeout: 3000 }).then((o) => o.trim() === 'active', () => false),
    roots(), sambaUsers(),
    run('smbstatus', ['-j'], { timeout: 5000 }).then((o) => parseSmbstatus(JSON.parse(o)), () => ({ total: 0, perShare: {} })),
  ]);
  const users = [...new Set([...data.users, ...smbUsers])].sort().map((name) => ({
    name, managed: data.users.includes(name), shares: data.shares.filter((s) => effectiveUsers(s, data.groups)[name]).map((s) => s.name),
    groups: data.groups.filter((g) => g.members.includes(name)).map((g) => g.name) }));
  const appUser = idName('/etc/passwd', APP_UID);
  return { installed, running: active, hostname: os.hostname(), shares: data.shares, users, groups: data.groups, roots: r, appUser, connections: status };
}

// New configuration: testparm on a copy first, only then the real files and reloading Samba.
async function apply(data) {
  const mounts = await roots().catch(() => []);
  const conf = buildSmbConf(data.shares, { forceUser: idName('/etc/passwd', APP_UID), forceGroup: idName('/etc/group', APP_GID), groups: data.groups, mounts });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpInc = path.join(DATA_DIR, 'smb-majaos.test.conf'), tmpMain = path.join(DATA_DIR, 'smb.test.conf');
  const main = readText(SMB_CONF);
  const includeLine = `include = ${INCLUDE}`;
  fs.writeFileSync(tmpInc, conf);
  fs.writeFileSync(tmpMain, (main.includes(includeLine) ? main.replace(includeLine, `include = ${tmpInc}`) : main + `\n${'include = ' + tmpInc}\n`));
  try { await run('testparm', ['-s', tmpMain], { timeout: 15000 }); }
  catch (e) { throw httpError('Samba rejected the settings: ' + e.message, 400); }
  finally { fs.rmSync(tmpInc, { force: true }); fs.rmSync(tmpMain, { force: true }); }
  fs.writeFileSync(INCLUDE + '.tmp', conf);
  fs.renameSync(INCLUDE + '.tmp', INCLUDE);
  if (!main.includes(includeLine)) fs.appendFileSync(SMB_CONF, `\n# Shared folders of MajaOS\n${includeLine}\n`);
  await run('smbcontrol', ['smbd', 'reload-config'], { timeout: 10000 })
    .catch(() => run('systemctl', ['reload-or-restart', 'smbd'], { timeout: 30000 }))
    .catch((e) => { throw httpError('Saved, but reloading Samba failed: ' + e.message, 502); });
}

async function saveShare(body, original = null) {
  const data = load();
  const [r, smbUsers] = await Promise.all([roots(), sambaUsers()]);
  const others = data.shares.filter((s) => s.name !== original).map((s) => s.name);
  const share = validateShare(body, { names: others, users: [...new Set([...data.users, ...smbUsers])], groups: data.groups.map((g) => g.name), roots: r.map((x) => x.mountpoint) });
  if (original && !data.shares.some((s) => s.name === original)) throw httpError('This shared folder no longer exists.', 404);
  if (body.create) {
    // New dataset on the chosen pool, owned by the app user.
    const parent = r.find((x) => x.name === String(body.create.parent || ''));
    if (!parent) throw httpError('Choose the pool for the new folder.', 400);
    if (parent.mixed) {
      // A pool with mixed disks has no datasets: a plain folder (mergerfs puts it on a disk with room).
      share.path = path.join(parent.mountpoint, share.name.toLowerCase());
      if (fs.existsSync(share.path)) throw httpError(`The folder ${share.path} already exists. Choose "Existing folder" to share it.`, 409);
      fs.mkdirSync(share.path);
    } else {
      const ds = parent.name + '/' + share.name.toLowerCase();
      if (r.some((x) => x.name === ds)) throw httpError(`The dataset ${ds} already exists. Choose "Existing folder" to share it.`, 409);
      await run('zfs', ['create', ds], { timeout: 30000 });
      share.path = (await run('zfs', ['get', '-H', '-o', 'value', 'mountpoint', ds])).trim();
    }
    try { fs.chownSync(share.path, APP_UID, APP_GID); fs.chmodSync(share.path, 0o775); } catch { /* not root */ }
  } else if (!fs.existsSync(share.path)) throw httpError(`The folder ${share.path} does not exist.`, 400);
  data.shares = data.shares.filter((s) => s.name !== original && s.name !== share.name).concat(share);
  await apply(data);
  store(data);
  return share;
}

async function deleteShare(name) {
  const data = load();
  if (!data.shares.some((s) => s.name === name)) throw httpError('This shared folder no longer exists.', 404);
  data.shares = data.shares.filter((s) => s.name !== name);
  await apply(data);
  store(data);
  return { removed: name };
}

async function createUser(body) {
  const name = String(body.name || '').trim();
  if (!USER.test(name)) throw httpError('Choose a user name with lowercase letters, digits, - or _ (at most 32 characters), e.g. lisa.', 400);
  const pw = validatePassword(body.password);
  const data = load();
  if (data.users.includes(name) || systemUsers().has(name)) throw httpError(`The user ${name} already exists on the server. Choose another name.`, 409);
  // No home folder and no shell: this user can only reach the shared folders, not sign in to the server.
  await run('useradd', ['--no-create-home', '--shell', '/usr/sbin/nologin', '--comment', 'Shared folders (MajaOS)', name], { timeout: 15000 });
  try { await run('smbpasswd', ['-a', '-s', name], { input: `${pw}\n${pw}\n`, timeout: 15000 }); }
  catch (e) { await run('userdel', [name]).catch(() => {}); throw e; }
  data.users.push(name); store(data);
  if (Array.isArray(body.groups) && body.groups.length) await saveUserAccess(name, { groups: body.groups });
  return { name };
}

async function setPassword(name, password) {
  const data = load();
  if (!data.users.includes(name) && !(await sambaUsers()).includes(name)) throw httpError('This user no longer exists.', 404);
  const pw = validatePassword(password);
  await run('smbpasswd', ['-s', name], { input: `${pw}\n${pw}\n`, timeout: 15000 });
  return { ok: true };
}

// Folders nobody can reach anymore once this user is gone (directly or through a group).
function onlyAccess(data, name) {
  const groups = data.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== name) }));
  return data.shares.filter((s) => {
    if (s.guest || !effectiveUsers(s, data.groups)[name]) return false;
    const u = { ...s.users }; delete u[name];
    return !Object.keys(effectiveUsers({ ...s, users: u }, groups)).length;
  }).map((s) => s.name);
}

async function deleteUser(name) {
  const data = load();
  if (!data.users.includes(name)) throw httpError('You can only delete users created in MajaOS here.', 400);
  const only = onlyAccess(data, name);
  if (only.length) throw httpError(`${name} is the only one with access to ${only.join(', ')}. Give someone else access first, or delete that shared folder.`, 409);
  const had = data.shares.some((s) => effectiveUsers(s, data.groups)[name]);
  data.shares = data.shares.map((s) => { const u = { ...s.users }; delete u[name]; return { ...s, users: u }; });
  data.groups = data.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== name) }));
  if (had) await apply(data);
  await run('smbpasswd', ['-x', name], { timeout: 15000 }).catch(() => {});
  await run('userdel', [name], { timeout: 15000 }).catch(() => {});
  data.users = data.users.filter((u) => u !== name);
  store(data);
  return { removed: name };
}

// Rights of one user: member of which groups, and directly per folder ('' = no direct right).
async function saveUserAccess(name, body) {
  const data = load();
  if (!data.users.includes(name) && !(await sambaUsers()).includes(name)) throw httpError('This user no longer exists.', 404);
  if (Array.isArray(body.groups)) {
    const bad = body.groups.find((g) => !data.groups.some((x) => x.name === g));
    if (bad) throw httpError(`The group ${bad} doesn't exist (anymore).`, 400);
    data.groups = data.groups.map((g) => {
      const members = g.members.filter((m) => m !== name);
      return { ...g, members: body.groups.includes(g.name) ? [...members, name].sort() : members };
    });
  }
  for (const [share, level] of Object.entries(body.access || {})) {
    const s = data.shares.find((x) => x.name === share);
    if (!s) throw httpError(`The shared folder ${share} doesn't exist (anymore).`, 400);
    const u = { ...s.users };
    if (level === 'ro' || level === 'rw') u[name] = level; else delete u[name];
    s.users = u;
  }
  const empty = data.shares.filter((s) => !s.guest && !Object.keys(effectiveUsers(s, data.groups)).length).map((s) => s.name);
  if (empty.length) throw httpError(`Then nobody can access ${empty.join(', ')} anymore. First give someone else access, or remove that shared folder.`, 409);
  await apply(data);
  store(data);
  return { name, groups: data.groups.filter((g) => g.members.includes(name)).map((g) => g.name) };
}

// Create or edit a group: name, description, members and rights per folder ({ folder: 'ro' | 'rw' }).
async function saveGroup(body, original = null) {
  const data = load();
  if (original && !data.groups.some((g) => g.name === original)) throw httpError('This group doesn\'t exist (anymore).', 404);
  const smbUsers = await sambaUsers();
  const group = validateGroup(body, { names: data.groups.filter((g) => g.name !== original).map((g) => g.name), users: [...new Set([...data.users, ...smbUsers])] });
  data.groups = data.groups.filter((g) => g.name !== original).concat(group).sort((a, b) => a.name.localeCompare(b.name));
  for (const s of data.shares) {
    const g = { ...(s.groups || {}) };
    const level = original && g[original];
    delete g[original];
    const wanted = body.shares ? body.shares[s.name] : level; // without a list: keep the rights of the old name
    if (wanted === 'ro' || wanted === 'rw') g[group.name] = wanted;
    s.groups = g;
  }
  const empty = data.shares.filter((s) => !s.guest && !Object.keys(effectiveUsers(s, data.groups)).length).map((s) => s.name);
  if (empty.length) throw httpError(`Then nobody can access ${empty.join(', ')} anymore. First give someone else access, or remove that shared folder.`, 409);
  await apply(data);
  store(data);
  return group;
}

async function deleteGroup(name) {
  const data = load();
  if (!data.groups.some((g) => g.name === name)) throw httpError('This group doesn\'t exist (anymore).', 404);
  data.groups = data.groups.filter((g) => g.name !== name);
  data.shares = data.shares.map((s) => { const g = { ...(s.groups || {}) }; delete g[name]; return { ...s, groups: g }; });
  const empty = data.shares.filter((s) => !s.guest && !Object.keys(effectiveUsers(s, data.groups)).length).map((s) => s.name);
  if (empty.length) throw httpError(`Only this group has access to ${empty.join(', ')}. First give someone else access, or remove that shared folder.`, 409);
  await apply(data);
  store(data);
  return { removed: name };
}

const shareRecords = () => load().shares;
module.exports = { parseSmbstatus, listShares, saveShare, deleteShare, createUser, setPassword, deleteUser, saveUserAccess, saveGroup, deleteGroup, buildSmbConf, effectiveUsers, validateShare, validateGroup, validatePassword, USER, shareByName, shareRecords, SHARE };
