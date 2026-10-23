'use strict';
/* Tests for signing in with two-step verification: TOTP (RFC 6238), recovery codes, the second step and blocking after wrong attempts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
const auth = require('../lib/auth');

// The secret from RFC 6238 (appendix B) is the ASCII text "12345678901234567890".
const RFC_SECRET = auth.base32Encode(Buffer.from('12345678901234567890'));

test('base32 there and back', () => {
  assert.equal(auth.base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(auth.base32Decode('MZXW6YTBOI').toString(), 'foobar');
  assert.equal(auth.base32Decode('mzxw 6ytb-oi======').toString(), 'foobar');
  assert.throws(() => auth.base32Decode('MZ1'));
});

test('TOTP according to the test values of RFC 6238 (SHA-1, 8 digits → last 6)', () => {
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [sec, code] of vectors) {
    assert.equal(auth.hotp(Buffer.from('12345678901234567890'), Math.floor(sec / 30), 8), code, 'time ' + sec);
    assert.equal(auth.totp(RFC_SECRET, sec * 1000), code.slice(2));
  }
});

test('verifyTotp: one step of leeway, no reuse', () => {
  const now = 1111111111 * 1000, ctr = Math.floor(now / 30000);
  assert.equal(auth.verifyTotp(RFC_SECRET, '050471', { now }), ctr);
  assert.equal(auth.verifyTotp(RFC_SECRET, '050 471', { now }), ctr);
  assert.equal(auth.verifyTotp(RFC_SECRET, auth.totp(RFC_SECRET, now - 30000), { now }), ctr - 1);
  assert.equal(auth.verifyTotp(RFC_SECRET, auth.totp(RFC_SECRET, now + 30000), { now }), ctr + 1);
  assert.equal(auth.verifyTotp(RFC_SECRET, auth.totp(RFC_SECRET, now - 90000), { now }), null);
  assert.equal(auth.verifyTotp(RFC_SECRET, '050471', { now, lastCounter: ctr }), null);
  assert.equal(auth.verifyTotp(RFC_SECRET, '12345', { now }), null);
  assert.equal(auth.verifyTotp(RFC_SECRET, 'abcdef', { now }), null);
});

test('otpauth address', () => {
  const uri = auth.otpauthUri('ABCD', 'freddy');
  assert.equal(uri, 'otpauth://totp/HomeBaseOS:freddy?secret=ABCD&issuer=HomeBaseOS&algorithm=SHA1&digits=6&period=30');
});

test('recovery codes: shape and hash without capitals or dash', () => {
  const c = auth.newRecoveryCode();
  assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.equal(auth.hashRecovery(c), auth.hashRecovery(c.toUpperCase().replace('-', ' ')));
});

test('setting up, signing in and turning off', () => {
  auth._reset();
  assert.equal(auth.mfaEnabled(), false);
  assert.deepEqual(auth.checkCode('000000'), { ok: true }); // off: no code needed
  const { secret, uri } = auth.beginSetup('freddy');
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.ok(uri.includes('secret=' + secret));
  const t0 = Date.now();
  assert.throws(() => auth.finishSetup('000000', t0), /not correct/);
  const { recovery } = auth.finishSetup(auth.totp(secret, t0), t0);
  assert.equal(recovery.length, 10);
  assert.equal(auth.mfaEnabled(), true);
  assert.ok(auth.sessionsAfter() >= t0);
  // Stored with only hashes of the recovery codes, and not readable by others.
  const file = path.join(process.env.DATA_DIR, 'auth.json');
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!saved.includes(recovery[0]));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.throws(() => auth.beginSetup('freddy'), /already on/);

  // The code you just linked with doesn't work again; the next one does.
  assert.equal(auth.checkCode(auth.totp(secret, t0), t0).ok, false);
  assert.equal(auth.checkCode(auth.totp(secret, t0 + 30000), t0 + 30000).ok, true);
  // Recovery code: once.
  const r = auth.checkCode(recovery[3].toUpperCase());
  assert.deepEqual(r, { ok: true, recovery: true, recoveryLeft: 9 });
  assert.equal(auth.checkCode(recovery[3]).ok, false);
  assert.equal(auth.status().recoveryLeft, 9);
  // After reloading the file everything stays.
  auth._reset();
  assert.equal(auth.mfaEnabled(), true);
  assert.equal(auth.status().recoveryLeft, 9);
  // New recovery codes replace the old ones.
  const fresh = auth.newRecovery().recovery;
  assert.equal(auth.checkCode(recovery[0]).ok, false);
  assert.equal(auth.checkCode(fresh[0]).ok, true);
  auth.disable();
  assert.equal(auth.mfaEnabled(), false);
});

test('linking expires after 15 minutes', () => {
  auth._reset();
  const { secret } = auth.beginSetup('freddy');
  const later = Date.now() + 16 * 60 * 1000;
  assert.throws(() => auth.finishSetup(auth.totp(secret, later), later), (e) => e.status === 410);
  auth.disable();
});

test('second step: one-time, expires, and lapses after 5 wrong codes', () => {
  auth._reset();
  const { secret } = auth.beginSetup('freddy');
  const t0 = Date.now();
  auth.finishSetup(auth.totp(secret, t0 - 30000), t0);
  const id = auth.newPending(t0);
  assert.equal(auth.usePending(id, '000000', t0).result, 'wrong');
  assert.equal(auth.usePending(id, auth.totp(secret, t0), t0).result, 'ok');
  assert.equal(auth.usePending(id, auth.totp(secret, t0 + 30000), t0 + 30000).result, 'expired'); // already used
  const old = auth.newPending(t0);
  assert.equal(auth.usePending(old, auth.totp(secret, t0 + 6 * 60000), t0 + 6 * 60000).result, 'expired');
  const id2 = auth.newPending(t0);
  for (let i = 0; i < 5; i++) assert.equal(auth.usePending(id2, '000000', t0).result, 'wrong');
  assert.equal(auth.usePending(id2, auth.totp(secret, t0 + 30000), t0 + 30000).result, 'expired');
  assert.equal(auth.usePending('', '123456').result, 'expired');
  auth.disable();
});

test('blocking after 10 wrong attempts within 10 minutes', () => {
  auth._reset();
  const t0 = 1e12;
  for (let i = 0; i < 9; i++) auth.failed('10.0.0.5', t0 + i * 1000);
  assert.equal(auth.lockedFor('10.0.0.5', t0 + 10000), 0);
  auth.failed('10.0.0.5', t0 + 10000);
  assert.equal(auth.lockedFor('10.0.0.5', t0 + 10000), 300);
  assert.equal(auth.lockedFor('10.0.0.6', t0 + 10000), 0); // another address
  assert.equal(auth.lockedFor('10.0.0.5', t0 + 10000 + 300001), 0);
  // Old failures no longer count.
  for (let i = 0; i < 9; i++) auth.failed('10.0.0.7', t0 + i * 1000);
  auth.failed('10.0.0.7', t0 + 11 * 60 * 1000);
  assert.equal(auth.lockedFor('10.0.0.7', t0 + 11 * 60 * 1000), 0);
  auth.succeeded('10.0.0.5');
  assert.equal(auth.lockedFor('10.0.0.5', t0 + 10000), 0);
});

test('own password (scrypt) and welcome wizard', () => {
  auth._reset();
  assert.equal(auth.hasPassword(), false);
  assert.throws(() => auth.setPassword('short'), /at least 10/);
  assert.throws(() => auth.setPassword('aaaaaaaaaaaa'), /easy to guess/);
  assert.throws(() => auth.setPassword('1234567890abc'), /easy to guess/);
  const t0 = Date.now();
  auth.setPassword('correct horse battery staple', t0);
  assert.equal(auth.hasPassword(), true);
  assert.equal(auth.verifyPassword('correct horse battery staple'), true);
  assert.equal(auth.verifyPassword('correct horse battery stapel'), false);
  assert.equal(auth.verifyPassword(''), false);
  assert.ok(auth.sessionsAfter() >= t0);
  const saved = fs.readFileSync(path.join(process.env.DATA_DIR, 'auth.json'), 'utf8');
  assert.ok(!saved.includes('paard'));
  // Turning on two-step verification leaves the password alone (and vice versa).
  const { secret } = auth.beginSetup('freddy');
  auth.finishSetup(auth.totp(secret));
  auth._reset();
  assert.equal(auth.verifyPassword('correct horse battery staple'), true);
  auth.disable();
  assert.equal(auth.verifyPassword('correct horse battery staple'), true);

  const onb = require('../lib/onboarding');
  assert.equal(onb.getState().done, false);
  assert.equal(onb.finish({ skipped: true }).skipped, true);
  assert.equal(onb.getState().done, true);
  onb.reset();
  assert.equal(onb.getState().done, false);
});

test('creating an account the first time (user name + password)', () => {
  fs.rmSync(path.join(process.env.DATA_DIR, 'auth.json'), { force: true });
  auth._reset();
  assert.equal(auth.userName(), null);
  assert.equal(auth.checkUser('whatever'), true); // without a user name only the password counts
  assert.throws(() => auth.createAccount('1x', 'correct horse battery staple'), /user name/);
  assert.throws(() => auth.createAccount('Lennert', 'short'), /at least 10/);
  assert.equal(auth.hasPassword(), false);
  assert.deepEqual(auth.createAccount('Lennert', 'correct horse battery staple'), { ok: true, user: 'lennert' });
  assert.equal(auth.hasPassword(), true);
  assert.equal(auth.checkUser('LENNERT '), true);
  assert.equal(auth.checkUser('admin'), false);
  // A second account isn't possible, and a new password leaves the user name alone.
  assert.throws(() => auth.createAccount('admin', 'correct horse battery staple'), /already an account/);
  auth.setPassword('another long password here');
  auth._reset();
  assert.equal(auth.userName(), 'lennert');
  assert.equal(auth.verifyPassword('another long password here'), true);
});
