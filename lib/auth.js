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

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'auth.json');
const STEP = 30, DIGITS = 6, WINDOW = 1; // one step of leeway for a clock that is slightly off
const RECOVERY_COUNT = 10;
const ISSUER = 'HomeBaseOS';

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
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { mfa: j.mfa || null, password: j.password || null, user: j.user || null, sessionsAfter: Number(j.sessionsAfter) || 0, revoked: j.revoked || {} }; }
  catch { return { mfa: null, password: null, user: null, sessionsAfter: 0, revoked: {} }; }
}
function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}
let state = null;
const get = () => (state || (state = load()));
const put = (s) => { state = s; save(s); };

function mfaEnabled() { const m = get().mfa; return !!(m && m.enabled && m.secret); }
function status() {
  const m = get().mfa;
  return { enabled: mfaEnabled(), since: (m && m.enabled && m.since) || null, recoveryLeft: m && m.enabled ? (m.recovery || []).length : 0 };
}
function sessionsAfter() { return get().sessionsAfter; }

/* ---- setup: first a secret (not active yet), then confirm with a code from the app */
let setupSecret = null; // { secret, expires } — only in memory until it is confirmed
function otpauthUri(secret, account) {
  const label = encodeURIComponent(ISSUER) + ':' + encodeURIComponent(account || 'admin');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}
function beginSetup(account) {
  if (mfaEnabled()) throw httpError('Two-step verification is already on. Turn it off first to link again.', 409);
  const secret = base32Encode(crypto.randomBytes(20));
  setupSecret = { secret, expires: Date.now() + 15 * 60 * 1000 };
  return { secret, uri: otpauthUri(secret, account) };
}
function finishSetup(code, now = Date.now()) {
  if (!setupSecret || setupSecret.expires < now) throw httpError('Linking took too long. Start again.', 410);
  const ctr = verifyTotp(setupSecret.secret, code, { now });
  if (ctr == null) throw httpError('That code is not correct. Check the clock on your phone and type the code the app shows now.', 400);
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  put({ ...get(), mfa: { enabled: true, secret: setupSecret.secret, lastCounter: ctr, recovery: codes.map(hashRecovery), since: new Date(now).toISOString() }, sessionsAfter: now });
  setupSecret = null;
  return { recovery: codes };
}
function disable() { setupSecret = null; put({ ...get(), mfa: null }); return { ok: true }; }
function newRecovery() {
  if (!mfaEnabled()) throw httpError('Two-step verification is off.', 409);
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  const s = get(); put({ ...s, mfa: { ...s.mfa, recovery: codes.map(hashRecovery) } });
  return { recovery: codes };
}

// Check a code from the app or a recovery code. A recovery code works only once.
function checkCode(code, now = Date.now()) {
  const s = get(), m = s.mfa;
  if (!mfaEnabled()) return { ok: true };
  const ctr = verifyTotp(m.secret, code, { now, lastCounter: Number.isInteger(m.lastCounter) ? m.lastCounter : -1 });
  if (ctr != null) { put({ ...s, mfa: { ...m, lastCounter: ctr } }); return { ok: true }; }
  const norm = normRecovery(code);
  if (norm.length === 10) {
    const h = hashRecovery(norm), list = m.recovery || [];
    const i = list.findIndex((x) => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
    if (i >= 0) {
      const rest = list.filter((_, j) => j !== i);
      put({ ...s, mfa: { ...m, recovery: rest } });
      return { ok: true, recovery: true, recoveryLeft: rest.length };
    }
  }
  return { ok: false };
}

/* ---- own password (scrypt) instead of APP_PASSWORD */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hasPassword() { const pw = get().password; return !!(pw && pw.salt && pw.hash); }
function passwordChanged() { const pw = get().password; return (pw && pw.changed) || null; }
function verifyPassword(pw) {
  const p = get().password; if (!p) return false;
  const want = Buffer.from(p.hash, 'hex');
  const got = crypto.scryptSync(String(pw || ''), Buffer.from(p.salt, 'hex'), want.length, SCRYPT);
  return crypto.timingSafeEqual(got, want);
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
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(v, salt, 64, SCRYPT);
  put({ ...get(), password: { salt: salt.toString('hex'), hash: hash.toString('hex'), changed: new Date(now).toISOString() }, sessionsAfter: now });
  return { ok: true };
}

/* ---- second step of signing in: a short-lived, one-time token after the right password */
const pending = new Map(); // id → { expires, tries }
function newPending(now = Date.now()) {
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const id = crypto.randomBytes(24).toString('base64url');
  pending.set(id, { expires: now + 5 * 60 * 1000, tries: 0 });
  return id;
}
// Returns 'ok', 'wrong' or 'expired'. After 5 wrong codes the token expires (then the password again).
function usePending(id, code, now = Date.now()) {
  const p = pending.get(String(id || ''));
  if (!p || p.expires < now) { pending.delete(id); return { result: 'expired' }; }
  const r = checkCode(code, now);
  if (r.ok) { pending.delete(id); return { result: 'ok', ...r }; }
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

function _reset() { state = null; setupSecret = null; pending.clear(); attempts.clear(); everyone.fails = []; everyone.until = 0; }

module.exports = {
  base32Encode, base32Decode, hotp, totp, verifyTotp, otpauthUri, newRecoveryCode, hashRecovery,
  mfaEnabled, status, sessionsAfter, beginSetup, finishSetup, disable, newRecovery, checkCode,
  newPending, usePending, lockedFor, failed, succeeded, ipKey, revoke, isRevoked, _reset,
  hasPassword, passwordChanged, verifyPassword, validateNewPassword, setPassword, userName, validateUser, checkUser, claimUser, createAccount,
};
