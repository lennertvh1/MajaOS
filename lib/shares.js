'use strict';
/*
 * Gedeelde mappen (Samba), hun gebruikers en groepen.
 * DATA_DIR/shares.json is de bron: { shares: [{ name, path, comment, users: { naam: 'ro' | 'rw' }, groups: { groep: 'ro' | 'rw' }, guest, timemachine }],
 *   users: [naam], groups: [{ name, comment, members: [naam] }] }.
 * Een groep geeft al haar leden de rechten van de groep; wie meerdere wegen heeft, krijgt het hoogste recht (effectiveUsers).
 * Samba krijgt per map gewoon de lijst van gebruikers: geen Linux-groepen nodig.
 * Daaruit maken we /etc/samba/homebaseos.conf (eerst gecontroleerd met testparm), en smb.conf krijgt één include-regel.
 * Bestanden worden geschreven als de app-gebruiker (APP_UID/APP_GID), dezelfde als die van de Docker-apps.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, readText, httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'shares.json');
const SMB_CONF = process.env.SMB_CONF || '/etc/samba/smb.conf';
const INCLUDE = process.env.SMB_INCLUDE || '/etc/samba/homebaseos.conf';
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
function store(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}

// Naam van een gebruiker of groep op uid/gid (uit /etc/passwd of /etc/group).
function idName(file, id) {
  const line = readText(file).split('\n').find((l) => l.split(':')[2] === String(id));
  return line ? line.split(':')[0] : null;
}
const systemUsers = () => new Set(readText('/etc/passwd').split('\n').map((l) => l.split(':')[0]).filter(Boolean));

/* ---- configuratie */

// Wie mag aan een map: rechtstreeks of via een groep. Het hoogste recht telt (rw boven ro).
function effectiveUsers(share, groups = []) {
  const out = { ...(share.users || {}) };
  for (const [g, level] of Object.entries(share.groups || {})) {
    const group = groups.find((x) => x.name === g);
    for (const m of (group && group.members) || []) if (out[m] !== 'rw') out[m] = level;
  }
  return out;
}

// De share-secties voor homebaseos.conf. forceUser/forceGroup: zo schrijft iedereen als de app-gebruiker.
function buildSmbConf(shares, { forceUser = null, forceGroup = null, groups = [] } = {}) {
  const out = ['# Gemaakt door HomeBaseOS. Pas gedeelde mappen aan in Instellingen → Gedeelde mappen; wijzigingen hier worden overschreven.', ''];
  for (const share of [...shares].sort((a, b) => a.name.localeCompare(b.name))) {
    const s = { ...share, users: effectiveUsers(share, groups) };
    const users = Object.keys(s.users).sort();
    // Een lege "valid users" betekent in Samba: iedereen die aanmeldt. Zonder gebruikers en zonder gasten: niet delen.
    if (!users.length && !s.guest) continue;
    const writers = users.filter((u) => s.users[u] === 'rw');
    out.push(`[${s.name}]`, `   path = ${s.path}`);
    if (s.comment) out.push(`   comment = ${s.comment}`);
    out.push('   browseable = yes', '   read only = yes');
    if (s.guest) out.push('   guest ok = yes'); // gasten mogen lezen; wie er bij naam in staat, logt gewoon in
    else out.push(`   valid users = ${users.join(' ')}`, '   guest ok = no');
    if (writers.length) out.push(`   write list = ${writers.join(' ')}`);
    if (forceUser) out.push(`   force user = ${forceUser}`);
    if (forceGroup) out.push(`   force group = ${forceGroup}`);
    out.push('   create mask = 0664', '   directory mask = 0775', '   vfs objects = catia fruit streams_xattr');
    if (s.timemachine) out.push('   fruit:time machine = yes');
    out.push('');
  }
  return out.join('\n');
}

// Controleer een gedeelde map. ctx: { names (andere shares), users (bestaande gebruikers), groups (namen), roots (toegelaten mappen) }
function validateShare(body, { names = [], users = [], groups = [], roots = [] } = {}) {
  const name = String(body.name || '').trim();
  if (!SHARE.test(name) || RESERVED.test(name)) throw httpError('Kies een naam met letters, cijfers, -, _ of . (maximaal 32 tekens), bv. media.', 400);
  if (names.some((n) => n.toLowerCase() === name.toLowerCase())) throw httpError(`Er bestaat al een gedeelde map met de naam ${name}.`, 409);
  const comment = String(body.comment || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  const access = {};
  for (const [u, v] of Object.entries(body.users || {})) {
    if (v !== 'ro' && v !== 'rw') continue; // geen toegang
    if (!users.includes(u)) throw httpError(`De gebruiker ${u} bestaat niet (meer).`, 400);
    access[u] = v;
  }
  const groupAccess = {};
  for (const [g, v] of Object.entries(body.groups || {})) {
    if (v !== 'ro' && v !== 'rw') continue;
    if (!groups.includes(g)) throw httpError(`De groep ${g} bestaat niet (meer).`, 400);
    groupAccess[g] = v;
  }
  const guest = !!body.guest;
  if (!guest && !Object.keys(access).length && !Object.keys(groupAccess).length) throw httpError('Geef minstens één gebruiker of groep toegang, of laat gasten lezen.', 400);
  let p = null;
  if (!body.create) {
    p = path.resolve(String(body.path || ''));
    if (/[\r\n]/.test(String(body.path || '')) || !roots.some((r) => p === r || p.startsWith(r + '/'))) {
      throw httpError('Kies een map op een van je pools (bv. /tank/media).', 400);
    }
  }
  return { name, path: p, comment, users: access, groups: groupAccess, guest, timemachine: !!body.timemachine };
}

// Controleer een groep. ctx: { names (andere groepen), users (bestaande gebruikers) }
function validateGroup(body, { names = [], users = [] } = {}) {
  const name = String(body.name || '').trim();
  if (!GROUP.test(name)) throw httpError('Kies een groepsnaam met letters, cijfers, -, _ of . (maximaal 32 tekens), bv. Gezin.', 400);
  if (names.some((n) => n.toLowerCase() === name.toLowerCase())) throw httpError(`Er bestaat al een groep met de naam ${name}.`, 409);
  const comment = String(body.comment || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  const members = [...new Set((Array.isArray(body.members) ? body.members : []).map(String))];
  const bad = members.find((m) => !users.includes(m));
  if (bad) throw httpError(`De gebruiker ${bad} bestaat niet (meer).`, 400);
  return { name, comment, members: members.sort() };
}

function validatePassword(pw) {
  const p = String(pw || '');
  if (p.length < 8) throw httpError('Kies een wachtwoord van minstens 8 tekens.', 400);
  if (p.length > 128 || /[\r\n\0]/.test(p)) throw httpError('Dit wachtwoord kan niet: maximaal 128 tekens en geen regeleinde.', 400);
  return p;
}

/* ---- server */

// Mappen waar een gedeelde map mag komen: de koppelpunten van je ZFS-datasets.
async function roots() {
  const out = await run('zfs', ['list', '-H', '-o', 'name,mountpoint', '-t', 'filesystem'], { timeout: 8000 }).catch(() => '');
  return out.split('\n').map((l) => l.split('\t')).filter(([n, m]) => n && m && m.startsWith('/')).map(([name, mountpoint]) => ({ name, mountpoint }));
}
async function sambaUsers() {
  const out = await run('pdbedit', ['-L'], { timeout: 8000 }).catch(() => '');
  return out.split('\n').map((l) => l.split(':')[0]).filter((u) => USER.test(u));
}

// `smbstatus -j` (Samba 4.16+): hoeveel apparaten verbonden zijn, en per gedeelde map.
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

// Nieuwe configuratie: eerst testparm op een kopie, dan pas de echte bestanden en Samba herladen.
async function apply(data) {
  const conf = buildSmbConf(data.shares, { forceUser: idName('/etc/passwd', APP_UID), forceGroup: idName('/etc/group', APP_GID), groups: data.groups });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpInc = path.join(DATA_DIR, 'smb-homebaseos.test.conf'), tmpMain = path.join(DATA_DIR, 'smb.test.conf');
  const main = readText(SMB_CONF);
  const includeLine = `include = ${INCLUDE}`;
  fs.writeFileSync(tmpInc, conf);
  fs.writeFileSync(tmpMain, (main.includes(includeLine) ? main.replace(includeLine, `include = ${tmpInc}`) : main + `\n${'include = ' + tmpInc}\n`));
  try { await run('testparm', ['-s', tmpMain], { timeout: 15000 }); }
  catch (e) { throw httpError('Samba keurde de instellingen af: ' + e.message, 400); }
  finally { fs.rmSync(tmpInc, { force: true }); fs.rmSync(tmpMain, { force: true }); }
  fs.writeFileSync(INCLUDE + '.tmp', conf);
  fs.renameSync(INCLUDE + '.tmp', INCLUDE);
  if (!main.includes(includeLine)) fs.appendFileSync(SMB_CONF, `\n# Gedeelde mappen van HomeBaseOS\n${includeLine}\n`);
  await run('smbcontrol', ['smbd', 'reload-config'], { timeout: 10000 })
    .catch(() => run('systemctl', ['reload-or-restart', 'smbd'], { timeout: 30000 }))
    .catch((e) => { throw httpError('Opgeslagen, maar Samba herladen lukte niet: ' + e.message, 502); });
}

async function saveShare(body, original = null) {
  const data = load();
  const [r, smbUsers] = await Promise.all([roots(), sambaUsers()]);
  const others = data.shares.filter((s) => s.name !== original).map((s) => s.name);
  const share = validateShare(body, { names: others, users: [...new Set([...data.users, ...smbUsers])], groups: data.groups.map((g) => g.name), roots: r.map((x) => x.mountpoint) });
  if (original && !data.shares.some((s) => s.name === original)) throw httpError('Deze gedeelde map bestaat niet (meer).', 404);
  if (body.create) {
    // Nieuwe dataset op de gekozen pool, met de app-gebruiker als eigenaar.
    const parent = r.find((x) => x.name === String(body.create.parent || ''));
    if (!parent) throw httpError('Kies de pool waarop de nieuwe map komt.', 400);
    const ds = parent.name + '/' + share.name.toLowerCase();
    if (r.some((x) => x.name === ds)) throw httpError(`De dataset ${ds} bestaat al. Kies "Bestaande map" om ze te delen.`, 409);
    await run('zfs', ['create', ds], { timeout: 30000 });
    share.path = (await run('zfs', ['get', '-H', '-o', 'value', 'mountpoint', ds])).trim();
    try { fs.chownSync(share.path, APP_UID, APP_GID); fs.chmodSync(share.path, 0o775); } catch { /* geen root */ }
  } else if (!fs.existsSync(share.path)) throw httpError(`De map ${share.path} bestaat niet.`, 400);
  data.shares = data.shares.filter((s) => s.name !== original && s.name !== share.name).concat(share);
  await apply(data);
  store(data);
  return share;
}

async function deleteShare(name) {
  const data = load();
  if (!data.shares.some((s) => s.name === name)) throw httpError('Deze gedeelde map bestaat niet (meer).', 404);
  data.shares = data.shares.filter((s) => s.name !== name);
  await apply(data);
  store(data);
  return { removed: name };
}

async function createUser(body) {
  const name = String(body.name || '').trim();
  if (!USER.test(name)) throw httpError('Kies een gebruikersnaam met kleine letters, cijfers, - of _ (maximaal 32 tekens), bv. lies.', 400);
  const pw = validatePassword(body.password);
  const data = load();
  if (data.users.includes(name) || systemUsers().has(name)) throw httpError(`De gebruiker ${name} bestaat al op de server. Kies een andere naam.`, 409);
  // Geen thuismap en geen shell: deze gebruiker kan alleen aan de gedeelde mappen, niet aanmelden op de server.
  await run('useradd', ['--no-create-home', '--shell', '/usr/sbin/nologin', '--comment', 'Gedeelde mappen (HomeBaseOS)', name], { timeout: 15000 });
  try { await run('smbpasswd', ['-a', '-s', name], { input: `${pw}\n${pw}\n`, timeout: 15000 }); }
  catch (e) { await run('userdel', [name]).catch(() => {}); throw e; }
  data.users.push(name); store(data);
  if (Array.isArray(body.groups) && body.groups.length) await saveUserAccess(name, { groups: body.groups });
  return { name };
}

async function setPassword(name, password) {
  const data = load();
  if (!data.users.includes(name) && !(await sambaUsers()).includes(name)) throw httpError('Deze gebruiker bestaat niet (meer).', 404);
  const pw = validatePassword(password);
  await run('smbpasswd', ['-s', name], { input: `${pw}\n${pw}\n`, timeout: 15000 });
  return { ok: true };
}

// Mappen waar niemand meer aan kan als deze gebruiker weg is (rechtstreeks of via een groep).
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
  if (!data.users.includes(name)) throw httpError('Alleen gebruikers die je in HomeBaseOS maakte, kan je hier verwijderen.', 400);
  const only = onlyAccess(data, name);
  if (only.length) throw httpError(`${name} is de enige met toegang tot ${only.join(', ')}. Geef eerst iemand anders toegang, of verwijder die gedeelde map.`, 409);
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

// Rechten van één gebruiker: lid van welke groepen, en rechtstreeks per map ('' = geen rechtstreeks recht).
async function saveUserAccess(name, body) {
  const data = load();
  if (!data.users.includes(name) && !(await sambaUsers()).includes(name)) throw httpError('Deze gebruiker bestaat niet (meer).', 404);
  if (Array.isArray(body.groups)) {
    const bad = body.groups.find((g) => !data.groups.some((x) => x.name === g));
    if (bad) throw httpError(`De groep ${bad} bestaat niet (meer).`, 400);
    data.groups = data.groups.map((g) => {
      const members = g.members.filter((m) => m !== name);
      return { ...g, members: body.groups.includes(g.name) ? [...members, name].sort() : members };
    });
  }
  for (const [share, level] of Object.entries(body.access || {})) {
    const s = data.shares.find((x) => x.name === share);
    if (!s) throw httpError(`De gedeelde map ${share} bestaat niet (meer).`, 400);
    const u = { ...s.users };
    if (level === 'ro' || level === 'rw') u[name] = level; else delete u[name];
    s.users = u;
  }
  const empty = data.shares.filter((s) => !s.guest && !Object.keys(effectiveUsers(s, data.groups)).length).map((s) => s.name);
  if (empty.length) throw httpError(`Dan kan niemand nog aan ${empty.join(', ')}. Geef eerst iemand anders toegang, of verwijder die gedeelde map.`, 409);
  await apply(data);
  store(data);
  return { name, groups: data.groups.filter((g) => g.members.includes(name)).map((g) => g.name) };
}

// Groep maken of bewerken: naam, beschrijving, leden en rechten per map ({ map: 'ro' | 'rw' }).
async function saveGroup(body, original = null) {
  const data = load();
  if (original && !data.groups.some((g) => g.name === original)) throw httpError('Deze groep bestaat niet (meer).', 404);
  const smbUsers = await sambaUsers();
  const group = validateGroup(body, { names: data.groups.filter((g) => g.name !== original).map((g) => g.name), users: [...new Set([...data.users, ...smbUsers])] });
  data.groups = data.groups.filter((g) => g.name !== original).concat(group).sort((a, b) => a.name.localeCompare(b.name));
  for (const s of data.shares) {
    const g = { ...(s.groups || {}) };
    const level = original && g[original];
    delete g[original];
    const wanted = body.shares ? body.shares[s.name] : level; // zonder lijst: rechten van de oude naam behouden
    if (wanted === 'ro' || wanted === 'rw') g[group.name] = wanted;
    s.groups = g;
  }
  const empty = data.shares.filter((s) => !s.guest && !Object.keys(effectiveUsers(s, data.groups)).length).map((s) => s.name);
  if (empty.length) throw httpError(`Dan kan niemand nog aan ${empty.join(', ')}. Geef eerst iemand anders toegang, of verwijder die gedeelde map.`, 409);
  await apply(data);
  store(data);
  return group;
}

async function deleteGroup(name) {
  const data = load();
  if (!data.groups.some((g) => g.name === name)) throw httpError('Deze groep bestaat niet (meer).', 404);
  data.groups = data.groups.filter((g) => g.name !== name);
  data.shares = data.shares.map((s) => { const g = { ...(s.groups || {}) }; delete g[name]; return { ...s, groups: g }; });
  const empty = data.shares.filter((s) => !s.guest && !Object.keys(effectiveUsers(s, data.groups)).length).map((s) => s.name);
  if (empty.length) throw httpError(`Alleen deze groep heeft toegang tot ${empty.join(', ')}. Geef eerst iemand anders toegang, of verwijder die gedeelde map.`, 409);
  await apply(data);
  store(data);
  return { removed: name };
}

module.exports = { parseSmbstatus, listShares, saveShare, deleteShare, createUser, setPassword, deleteUser, saveUserAccess, saveGroup, deleteGroup, buildSmbConf, effectiveUsers, validateShare, validateGroup, validatePassword, USER };
