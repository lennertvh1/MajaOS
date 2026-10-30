'use strict';
/*
 * Sign-in with two-step verification (TOTP, RFC 6238: 6 digits, every 30 seconds, HMAC-SHA1).
 * Works with any authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Aegis, …).
 * DATA_DIR/auth.json (readable by root only):
 *   { mfa: { enabled, secret (base32), lastCounter, recovery: [sha256], since }, password: { salt, hash, changed }, user, sessionsAfter }
 * password: a password of your own (scrypt). As long as there is none, APP_PASSWORD from the env file applies (older installs);
 * without both, you create an account (user + password) in the welcome wizard the first time.
 * sessionsAfter: sessions from before this moment are invalid (after turning on two-step verification).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'auth.json');
const STEP = 30, DIGITS = 6, WINDOW = 1; // one step of leeway for a clock that is slightly off
const RECOVERY_COUNT = 10;
const ISSUER = 'MajaOS';

/* ---- base32 (RFC 4648, without =) */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32 text');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/* ---- TOTP */
function hotp(key, counter, digits = DIGITS, algo = 'sha1') {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algo, key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
const counterAt = (ms) => Math.floor(ms / 1000 / STEP);
function totp(secret, ms = Date.now()) { return hotp(base32Decode(secret), counterAt(ms)); }
// Returns the counter of the valid code, or null. A code that was already used (counter <= lastCounter) no longer counts.
function verifyTotp(secret, code, { now = Date.now(), lastCounter = -1 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secret), base = counterAt(now);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const ctr = base + d;
    if (ctr <= lastCounter) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, ctr)), Buffer.from(c))) return ctr;
  }
  return null;
}

/* ---- recovery codes: xxxxx-xxxxx, without letters that look alike */
const RC = 'abcdefghjkmnpqrstuvwxyz23456789';
function newRecoveryCode() {
  const b = crypto.randomBytes(10);
  const s = [...b].map((x) => RC[x % RC.length]).join('');
  return s.slice(0, 5) + '-' + s.slice(5);
}
const normRecovery = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (code) => crypto.createHash('sha256').update(normRecovery(code)).digest('hex');

/* ---- storage */
function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { mfa: j.mfa || null, password: j.password || null, user: j.user || null, sessionsAfter: Number(j.sessionsAfter) || 0, revoked: j.revoked || {}, accounts: j.accounts || {} }; }
  catch { return { mfa: null, password: null, user: null, sessionsAfter: 0, revoked: {}, accounts: {} }; }
}
function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}
let state = null;
const get = () => (state || (state = load()));
const put = (s) => { state = s; save(s); };

// who: null = the owner (the first account, top level of auth.json), otherwise the name of one of the other accounts.
const mfaOf = (who) => (who ? ((get().accounts || {})[who] || {}).mfa || null : get().mfa);
function setMfa(who, m, extra = {}) {
  const s = get();
  if (!who) return put({ ...s, mfa: m, ...extra });
  const acc = (s.accounts || {})[who];
  if (!acc) throw httpError('This account no longer exists.', 404);
  const { sessionsAfter: after, ...rest } = extra;
  put({ ...s, accounts: { ...s.accounts, [who]: { ...acc, mfa: m, ...(after ? { sessionsAfter: after } : {}) } }, ...rest });
}
function mfaEnabled(who = null) { const m = mfaOf(who); return !!(m && m.enabled && m.secret); }
function status(who = null) {
  const m = mfaOf(who);
  return { enabled: mfaEnabled(who), since: (m && m.enabled && m.since) || null, recoveryLeft: m && m.enabled ? (m.recovery || []).length : 0 };
}
// Sessions from before this moment are invalid (a new password, MFA turned on). Per account; the owner's is global.
function sessionsAfter(who = null) {
  if (!who) return get().sessionsAfter;
  const acc = (get().accounts || {})[who];
  return acc ? Number(acc.sessionsAfter) || 0 : Infinity;
}

/* ---- setup: first a secret (not active yet), then confirm with a code from the app */
const setupSecrets = new Map(); // who ('' = owner) → { secret, expires }, only in memory until it is confirmed
function otpauthUri(secret, account) {
  const label = encodeURIComponent(ISSUER) + ':' + encodeURIComponent(account || 'admin');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}
function beginSetup(account, who = null) {
  if (mfaEnabled(who)) throw httpError('Two-step verification is already on. Turn it off first to link again.', 409);
  const secret = base32Encode(crypto.randomBytes(20));
  setupSecrets.set(who || '', { secret, expires: Date.now() + 15 * 60 * 1000 });
  return { secret, uri: otpauthUri(secret, account) };
}
function finishSetup(code, now = Date.now(), who = null) {
  const sec = setupSecrets.get(who || '');
  if (!sec || sec.expires < now) throw httpError('Linking took too long. Start again.', 410);
  const ctr = verifyTotp(sec.secret, code, { now });
  if (ctr == null) throw httpError('That code is not correct. Check the clock on your phone and type the code the app shows now.', 400);
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  setMfa(who, { enabled: true, secret: sec.secret, lastCounter: ctr, recovery: codes.map(hashRecovery), since: new Date(now).toISOString() }, { sessionsAfter: now });
  setupSecrets.delete(who || '');
  return { recovery: codes };
}
function disable(who = null) { setupSecrets.delete(who || ''); setMfa(who, null); return { ok: true }; }
function newRecovery(who = null) {
  if (!mfaEnabled(who)) throw httpError('Two-step verification is off.', 409);
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  setMfa(who, { ...mfaOf(who), recovery: codes.map(hashRecovery) });
  return { recovery: codes };
}

// Check a code from the app or a recovery code. A recovery code works only once.
function checkCode(code, now = Date.now(), who = null) {
  const m = mfaOf(who);
  if (!mfaEnabled(who)) return { ok: true };
  const ctr = verifyTotp(m.secret, code, { now, lastCounter: Number.isInteger(m.lastCounter) ? m.lastCounter : -1 });
  if (ctr != null) { setMfa(who, { ...m, lastCounter: ctr }); return { ok: true }; }
  const norm = normRecovery(code);
  if (norm.length === 10) {
    const h = hashRecovery(norm), list = m.recovery || [];
    const i = list.findIndex((x) => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
    if (i >= 0) {
      const rest = list.filter((_, j) => j !== i);
      setMfa(who, { ...m, recovery: rest });
      return { ok: true, recovery: true, recoveryLeft: rest.length };
    }
  }
  return { ok: false };
}

/* ---- own password (scrypt) instead of APP_PASSWORD */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hasPassword() { const pw = get().password; return !!(pw && pw.salt && pw.hash); }
function passwordChanged() { const pw = get().password; return (pw && pw.changed) || null; }
function verifyHash(p, pw) {
  if (!p || !p.salt || !p.hash) return false;
  const want = Buffer.from(p.hash, 'hex');
  const got = crypto.scryptSync(String(pw || ''), Buffer.from(p.salt, 'hex'), want.length, SCRYPT);
  return crypto.timingSafeEqual(got, want);
}
function verifyPassword(pw) { return verifyHash(get().password, pw); }
function hashPassword(pw, now = Date.now()) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 64, SCRYPT).toString('hex'), changed: new Date(now).toISOString() };
}
function validateNewPassword(pw) {
  const v = String(pw || '');
  if (v.length < 10) throw httpError('Choose a password of at least 10 characters.', 400);
  if (v.length > 200) throw httpError('The password is too long (at most 200 characters).', 400);
  if (/^(.)\1+$/.test(v) || /^(0123456789|1234567890|wachtwoord|password)/i.test(v)) throw httpError('This password is too easy to guess. Choose another one.', 400);
  return v;
}
// Name of the account (when signing in and in the authenticator app).
const USER = /^[a-z][a-z0-9._-]{1,31}$/;
function userName() { return get().user || null; }
function validateUser(name) {
  const v = String(name || '').trim().toLowerCase();
  if (!USER.test(v)) throw httpError('Choose a user name of 2 to 32 characters: lowercase letters, digits, dot, - or _, starting with a letter.', 400);
  return v;
}
// The user name matches (case doesn't matter). Older installs have none yet: then any valid name passes,
// and claimUser keeps it after the right password, so from then on it is asked like any other.
function checkUser(name) {
  const v = String(name || '').trim().toLowerCase();
  const u = userName(); if (!u) return USER.test(v);
  const a = Buffer.from(v), b = Buffer.from(u);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function claimUser(name) {
  if (userName()) return;
  put({ ...get(), user: validateUser(name) });
}
// First account: only while there is no password yet.
function createAccount(user, pw, now = Date.now()) {
  if (hasPassword()) throw httpError('There is already an account. Sign in.', 409);
  const u = validateUser(user);
  setPassword(pw, now);
  put({ ...get(), user: u });
  return { ok: true, user: u };
}
// New password: all other sessions are signed out afterwards (sessionsAfter).
function setPassword(pw, now = Date.now()) {
  const v = validateNewPassword(pw);
  put({ ...get(), password: hashPassword(v, now), sessionsAfter: now });
  return { ok: true };
}

/* ---- other accounts: the users of Settings → Users that may also sign in here. role admin = everything (like the
 * owner), role user = Files on the shared folders they may use, and their own password and two-step verification.
 * mustChange: choose a new password at the next sign-in. mfaRequired: set up two-step verification at sign-in. */
const ROLES = ['admin', 'user'];
const accountsOf = () => get().accounts || {};
function account(name) { const a = accountsOf()[String(name || '')]; return a ? { name: String(name), ...a } : null; }
function accountView(name) {
  const a = account(name); if (!a) return null;
  return { name, role: a.role, mustChange: !!a.mustChange, mfaRequired: !!a.mfaRequired, mfa: mfaEnabled(name), created: a.created || null, passwordChanged: (a.password && a.password.changed) || null };
}
function listAccounts() { return Object.keys(accountsOf()).sort().map(accountView); }
function accountOptions(body, prev = {}) {
  const role = body.role == null ? prev.role || 'user' : String(body.role);
  if (!ROLES.includes(role)) throw httpError('Choose the role Administrator or User.', 400);
  return { role, mustChange: body.mustChange == null ? !!prev.mustChange : !!body.mustChange, mfaRequired: body.mfaRequired == null ? !!prev.mfaRequired : !!body.mfaRequired };
}
function addAccount(name, body, now = Date.now()) {
  const u = validateUser(name);
  if (u === userName()) throw httpError('This name is already the administrator\'s.', 409);
  if (account(u)) throw httpError(`${u} can already sign in.`, 409);
  const pw = validateNewPassword(body.password);
  put({ ...get(), accounts: { ...accountsOf(), [u]: { ...accountOptions(body), password: hashPassword(pw, now), mfa: null, created: new Date(now).toISOString(), sessionsAfter: now } } });
  return accountView(u);
}
function updateAccount(name, body, now = Date.now()) {
  const a = account(name); if (!a) throw httpError('This account no longer exists.', 404);
  const opts = accountOptions(body, a);
  // A lower role signs out the account's sessions: what it could do before must stop now.
  const after = opts.role !== a.role ? now : a.sessionsAfter;
  const { name: _n, ...rest } = a;
  put({ ...get(), accounts: { ...accountsOf(), [name]: { ...rest, ...opts, sessionsAfter: after } } });
  return accountView(name);
}
function removeAccount(name) {
  if (!account(name)) return { removed: false };
  const { [name]: _gone, ...rest } = accountsOf();
  setupSecrets.delete(name);
  put({ ...get(), accounts: rest });
  return { removed: true };
}
function verifyAccount(name, pw) { const a = account(name); return !!a && verifyHash(a.password, pw); }
// A new password for an account (by the account itself, or by an administrator with mustChange): other sessions end.
function setAccountPassword(name, pw, { mustChange = false } = {}, now = Date.now()) {
  const a = account(name); if (!a) throw httpError('This account no longer exists.', 404);
  const v = validateNewPassword(pw);
  if (verifyHash(a.password, v)) throw httpError('Choose a password that is different from the old one.', 400);
  const { name: _n, ...rest } = a;
  put({ ...get(), accounts: { ...accountsOf(), [name]: { ...rest, password: hashPassword(v, now), mustChange: !!mustChange, sessionsAfter: now } } });
  return { ok: true };
}

/* ---- second step of signing in: a short-lived, one-time token after the right password */
const pending = new Map(); // id → { expires, tries, who (null = owner), step: mfa|password|setup }
function newPending(now = Date.now(), { who = null, step = 'mfa' } = {}) {
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const id = crypto.randomBytes(24).toString('base64url');
  pending.set(id, { expires: now + (step === 'mfa' ? 5 : 15) * 60 * 1000, tries: 0, who, step }); // choosing a password or linking an app takes longer
  return id;
}
// The step of a pending sign-in (without using it): {who, step} or null when expired.
function peekPending(id, now = Date.now()) {
  const p = pending.get(String(id || ''));
  if (!p || p.expires < now) { pending.delete(id); return null; }
  return { who: p.who, step: p.step };
}
function dropPending(id) { pending.delete(String(id || '')); }
// Returns 'ok', 'wrong' or 'expired' (with who). After 5 wrong codes the token expires (then the password again).
function usePending(id, code, now = Date.now()) {
  const p = pending.get(String(id || ''));
  if (!p || p.expires < now || p.step !== 'mfa') { pending.delete(id); return { result: 'expired' }; }
  const r = checkCode(code, now, p.who);
  if (r.ok) { pending.delete(id); return { result: 'ok', who: p.who, ...r }; }
  if (++p.tries >= 5) pending.delete(id);
  return { result: 'wrong' };
}

/* ---- too many wrong attempts per address: 10 within 10 minutes → blocked for 5 minutes */
// IPv6 counts per /64: one home connection gets a whole /64 and can change its address at will.
function ipKey(ip) {
  const v = String(ip || '');
  if (!v.includes(':')) return v;
  const [head, tail = ''] = v.split('::');
  const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}
const attempts = new Map(); // ip or /64 → { fails: [ms], until }
// All addresses together: 100 wrong attempts within 10 minutes (an attack from many addresses) → nobody for 5 minutes.
const everyone = { fails: [], until: 0 };
function lockedFor(ip, now = Date.now()) {
  const a = attempts.get(ipKey(ip));
  const until = Math.max(a ? a.until : 0, everyone.until);
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}
function count(a, max, now) {
  a.fails = a.fails.filter((x) => now - x < 10 * 60 * 1000);
  a.fails.push(now);
  if (a.fails.length >= max) { a.until = now + 5 * 60 * 1000; a.fails = []; }
}
function failed(ip, now = Date.now()) {
  const key = ipKey(ip);
  const a = attempts.get(key) || { fails: [], until: 0 };
  count(a, 10, now);
  count(everyone, 100, now);
  attempts.set(key, a);
  if (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
}
function succeeded(ip) { attempts.delete(ipKey(ip)); }

/* ---- signed out sessions: a cookie stays refused after Sign out, until it would have expired anyway */
function revoke(id, until) {
  if (!id) return;
  const now = Date.now();
  const list = Object.fromEntries(Object.entries(get().revoked || {}).filter(([, t]) => t > now));
  list[id] = until;
  put({ ...get(), revoked: list });
}
function isRevoked(id) { const t = id && (get().revoked || {})[id]; return !!(t && t > Date.now()); }

function _reset() { state = null; setupSecrets.clear(); pending.clear(); attempts.clear(); everyone.fails = []; everyone.until = 0; }

module.exports = {
  base32Encode, base32Decode, hotp, totp, verifyTotp, otpauthUri, newRecoveryCode, hashRecovery,
  mfaEnabled, status, sessionsAfter, beginSetup, finishSetup, disable, newRecovery, checkCode,
  newPending, usePending, peekPending, dropPending, lockedFor, failed, succeeded, ipKey, revoke, isRevoked, _reset,
  hasPassword, passwordChanged, verifyPassword, validateNewPassword, setPassword, userName, validateUser, checkUser, claimUser, createAccount,
  ROLES, account, accountView, listAccounts, addAccount, updateAccount, removeAccount, verifyAccount, setAccountPassword,
};
