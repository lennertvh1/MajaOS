'use strict';
/*
 * Aanmelden met tweestapsverificatie (TOTP, RFC 6238: 6 cijfers, elke 30 seconden, HMAC-SHA1).
 * Werkt met elke authenticator-app (Google Authenticator, Microsoft Authenticator, 1Password, Aegis, …).
 * DATA_DIR/auth.json (alleen leesbaar voor root):
 *   { mfa: { enabled, secret (base32), lastCounter, recovery: [sha256], since }, password: { salt, hash, changed }, sessionsAfter }
 * password: een eigen wachtwoord (scrypt). Zolang dat er niet is, geldt APP_PASSWORD uit de env-file.
 * sessionsAfter: sessies van vóór dit moment zijn ongeldig (na het aanzetten van tweestapsverificatie).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'auth.json');
const STEP = 30, DIGITS = 6, WINDOW = 1; // één stap speling voor een klok die wat afwijkt
const RECOVERY_COUNT = 10;
const ISSUER = 'HomeBaseOS';

/* ---- base32 (RFC 4648, zonder =) */
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
    if (i < 0) throw new Error('Ongeldige base32-tekst');
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
// Geeft de teller van de geldige code terug, of null. Een code die al gebruikt is (teller <= lastCounter), telt niet meer.
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

/* ---- herstelcodes: xxxxx-xxxxx, zonder letters die op elkaar lijken */
const RC = 'abcdefghjkmnpqrstuvwxyz23456789';
function newRecoveryCode() {
  const b = crypto.randomBytes(10);
  const s = [...b].map((x) => RC[x % RC.length]).join('');
  return s.slice(0, 5) + '-' + s.slice(5);
}
const normRecovery = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (code) => crypto.createHash('sha256').update(normRecovery(code)).digest('hex');

/* ---- opslag */
function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { mfa: j.mfa || null, password: j.password || null, sessionsAfter: Number(j.sessionsAfter) || 0 }; }
  catch { return { mfa: null, password: null, sessionsAfter: 0 }; }
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

/* ---- instellen: eerst een geheim (nog niet actief), daarna bevestigen met een code uit de app */
let setupSecret = null; // { secret, expires } — alleen in het geheugen tot het bevestigd is
function otpauthUri(secret, account) {
  const label = encodeURIComponent(ISSUER) + ':' + encodeURIComponent(account || 'admin');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}
function beginSetup(account) {
  if (mfaEnabled()) throw httpError('Tweestapsverificatie staat al aan. Zet ze eerst uit om opnieuw te koppelen.', 409);
  const secret = base32Encode(crypto.randomBytes(20));
  setupSecret = { secret, expires: Date.now() + 15 * 60 * 1000 };
  return { secret, uri: otpauthUri(secret, account) };
}
function finishSetup(code, now = Date.now()) {
  if (!setupSecret || setupSecret.expires < now) throw httpError('Het koppelen duurde te lang. Begin opnieuw.', 410);
  const ctr = verifyTotp(setupSecret.secret, code, { now });
  if (ctr == null) throw httpError('Die code klopt niet. Controleer de klok van je gsm en typ de code die nu in de app staat.', 400);
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  put({ ...get(), mfa: { enabled: true, secret: setupSecret.secret, lastCounter: ctr, recovery: codes.map(hashRecovery), since: new Date(now).toISOString() }, sessionsAfter: now });
  setupSecret = null;
  return { recovery: codes };
}
function disable() { setupSecret = null; put({ ...get(), mfa: null }); return { ok: true }; }
function newRecovery() {
  if (!mfaEnabled()) throw httpError('Tweestapsverificatie staat uit.', 409);
  const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
  const s = get(); put({ ...s, mfa: { ...s.mfa, recovery: codes.map(hashRecovery) } });
  return { recovery: codes };
}

// Controleer een code uit de app of een herstelcode. Een herstelcode werkt maar één keer.
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

/* ---- eigen wachtwoord (scrypt) in plaats van APP_PASSWORD */
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
  if (v.length < 10) throw httpError('Kies een wachtwoord van minstens 10 tekens.', 400);
  if (v.length > 200) throw httpError('Het wachtwoord is te lang (maximaal 200 tekens).', 400);
  if (/^(.)\1+$/.test(v) || /^(0123456789|1234567890|wachtwoord|password)/i.test(v)) throw httpError('Dit wachtwoord is te makkelijk te raden. Kies een ander.', 400);
  return v;
}
// Nieuw wachtwoord: alle andere sessies zijn daarna afgemeld (sessionsAfter).
function setPassword(pw, now = Date.now()) {
  const v = validateNewPassword(pw);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(v, salt, 64, SCRYPT);
  put({ ...get(), password: { salt: salt.toString('hex'), hash: hash.toString('hex'), changed: new Date(now).toISOString() }, sessionsAfter: now });
  return { ok: true };
}

/* ---- tweede stap van het aanmelden: een kort geldig, eenmalig kenmerk na het juiste wachtwoord */
const pending = new Map(); // id → { expires, tries }
function newPending(now = Date.now()) {
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const id = crypto.randomBytes(24).toString('base64url');
  pending.set(id, { expires: now + 5 * 60 * 1000, tries: 0 });
  return id;
}
// Geeft 'ok', 'wrong' of 'expired' terug. Na 5 foute codes vervalt het kenmerk (dan opnieuw het wachtwoord).
function usePending(id, code, now = Date.now()) {
  const p = pending.get(String(id || ''));
  if (!p || p.expires < now) { pending.delete(id); return { result: 'expired' }; }
  const r = checkCode(code, now);
  if (r.ok) { pending.delete(id); return { result: 'ok', ...r }; }
  if (++p.tries >= 5) pending.delete(id);
  return { result: 'wrong' };
}

/* ---- te veel foute pogingen per adres: 10 binnen 10 minuten → 5 minuten geblokkeerd */
const attempts = new Map(); // ip → { fails: [ms], until }
function lockedFor(ip, now = Date.now()) {
  const a = attempts.get(ip);
  return a && a.until > now ? Math.ceil((a.until - now) / 1000) : 0;
}
function failed(ip, now = Date.now()) {
  const a = attempts.get(ip) || { fails: [], until: 0 };
  a.fails = a.fails.filter((x) => now - x < 10 * 60 * 1000);
  a.fails.push(now);
  if (a.fails.length >= 10) { a.until = now + 5 * 60 * 1000; a.fails = []; }
  attempts.set(ip, a);
  if (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
}
function succeeded(ip) { attempts.delete(ip); }

function _reset() { state = null; setupSecret = null; pending.clear(); attempts.clear(); }

module.exports = {
  base32Encode, base32Decode, hotp, totp, verifyTotp, otpauthUri, newRecoveryCode, hashRecovery,
  mfaEnabled, status, sessionsAfter, beginSetup, finishSetup, disable, newRecovery, checkCode,
  newPending, usePending, lockedFor, failed, succeeded, _reset,
  hasPassword, passwordChanged, verifyPassword, validateNewPassword, setPassword,
};
