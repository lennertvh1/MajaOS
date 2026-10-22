'use strict';
/*
 * Gedeelde mappen (Samba) en hun gebruikers.
 * DATA_DIR/shares.json is de bron: { shares: [{ name, path, comment, users: { naam: 'ro' | 'rw' }, guest, timemachine }], users: [naam] }.
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

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { shares: j.shares || [], users: j.users || [] }; } catch { return { shares: [], users: [] }; }
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

// De share-secties voor homebaseos.conf. forceUser/forceGroup: zo schrijft iedereen als de app-gebruiker.
function buildSmbConf(shares, { forceUser = null, forceGroup = null } = {}) {
  const out = ['# Gemaakt door HomeBaseOS. Pas gedeelde mappen aan in Instellingen → Gedeelde mappen; wijzigingen hier worden overschreven.', ''];
  for (const s of [...shares].sort((a, b) => a.name.localeCompare(b.name))) {
    const users = Object.keys(s.users || {}).sort();
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

// Controleer een gedeelde map. ctx: { names (andere shares), users (bestaande gebruikers), roots (toegelaten mappen) }
function validateShare(body, { names = [], users = [], roots = [] } = {}) {
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
  const guest = !!body.guest;
  if (!guest && !Object.keys(access).length) throw httpError('Geef minstens één gebruiker toegang, of laat gasten lezen.', 400);
  let p = null;
  if (!body.create) {
    p = path.resolve(String(body.path || ''));
    if (/[\r\n]/.test(String(body.path || '')) || !roots.some((r) => p === r || p.startsWith(r + '/'))) {
      throw httpError('Kies een map op een van je pools (bv. /tank/media).', 400);
    }
  }
  return { name, path: p, comment, users: access, guest, timemachine: !!body.timemachine };
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
    name, managed: data.users.includes(name), shares: data.shares.filter((s) => s.users[name]).map((s) => s.name) }));
  const appUser = idName('/etc/passwd', APP_UID);
  return { installed, running: active, hostname: os.hostname(), shares: data.shares, users, roots: r, appUser, connections: status };
}

// Nieuwe configuratie: eerst testparm op een kopie, dan pas de echte bestanden en Samba herladen.
async function apply(data) {
  const conf = buildSmbConf(data.shares, { forceUser: idName('/etc/passwd', APP_UID), forceGroup: idName('/etc/group', APP_GID) });
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
  const share = validateShare(body, { names: others, users: [...new Set([...data.users, ...smbUsers])], roots: r.map((x) => x.mountpoint) });
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
  return { name };
}

async function setPassword(name, password) {
  const data = load();
  if (!data.users.includes(name) && !(await sambaUsers()).includes(name)) throw httpError('Deze gebruiker bestaat niet (meer).', 404);
  const pw = validatePassword(password);
  await run('smbpasswd', ['-s', name], { input: `${pw}\n${pw}\n`, timeout: 15000 });
  return { ok: true };
}

async function deleteUser(name) {
  const data = load();
  if (!data.users.includes(name)) throw httpError('Alleen gebruikers die je in HomeBaseOS maakte, kan je hier verwijderen.', 400);
  const only = data.shares.filter((s) => !s.guest && Object.keys(s.users).length === 1 && s.users[name]).map((s) => s.name);
  if (only.length) throw httpError(`${name} is de enige met toegang tot ${only.join(', ')}. Geef eerst iemand anders toegang, of verwijder die gedeelde map.`, 409);
  const had = data.shares.some((s) => s.users[name]);
  data.shares = data.shares.map((s) => { const u = { ...s.users }; delete u[name]; return { ...s, users: u }; });
  if (had) await apply(data);
  await run('smbpasswd', ['-x', name], { timeout: 15000 }).catch(() => {});
  await run('userdel', [name], { timeout: 15000 }).catch(() => {});
  data.users = data.users.filter((u) => u !== name);
  store(data);
  return { removed: name };
}

module.exports = { parseSmbstatus, listShares, saveShare, deleteShare, createUser, setPassword, deleteUser, buildSmbConf, validateShare, validatePassword, USER };
