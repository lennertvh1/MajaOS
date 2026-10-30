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
  assert.equal(uri, 'otpauth://totp/MajaOS:freddy?secret=ABCD&issuer=MajaOS&algorithm=SHA1&digits=6&period=30');
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

test('older installs without a user name keep the one typed at the first sign-in', () => {
  fs.rmSync(path.join(process.env.DATA_DIR, 'auth.json'), { force: true });
  auth._reset();
  auth.setPassword('correct horse battery staple');
  assert.equal(auth.userName(), null);
  assert.equal(auth.checkUser(''), false); // a user name is always needed
  assert.equal(auth.checkUser('1x'), false);
  assert.equal(auth.checkUser('Freddy'), true);
  auth.claimUser('Freddy');
  assert.equal(auth.userName(), 'freddy');
  assert.equal(auth.checkUser('someone'), false);
  auth.claimUser('someone'); // only the first one counts
  assert.equal(auth.userName(), 'freddy');
});

test('IPv6 is blocked per /64, and an attack from many addresses blocks everyone', () => {
  auth._reset();
  const t0 = 1e12;
  assert.equal(auth.ipKey('2001:db8:1:2::9'), auth.ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
  assert.notEqual(auth.ipKey('2001:db8:1:2::9'), auth.ipKey('2001:db8:1:3::9'));
  for (let i = 0; i < 10; i++) auth.failed('2001:db8:1:2::' + (i + 1).toString(16), t0 + i);
  assert.equal(auth.lockedFor('2001:db8:1:2::ffff', t0 + 20), 300);
  assert.equal(auth.lockedFor('2001:db8:1:3::1', t0 + 20), 0);
  auth._reset();
  for (let i = 0; i < 100; i++) auth.failed('10.1.' + Math.floor(i / 9) + '.' + (i % 9), t0 + i);
  assert.equal(auth.lockedFor('192.168.1.10', t0 + 200), 300);
  auth._reset();
});

test('a signed out session stays refused, also after a restart', () => {
  auth._reset();
  auth.revoke('abc', Date.now() + 60000);
  auth.revoke('old', Date.now() - 1);
  assert.equal(auth.isRevoked('abc'), true);
  assert.equal(auth.isRevoked('old'), false);
  assert.equal(auth.isRevoked(''), false);
  auth._reset(); // reads auth.json again
  assert.equal(auth.isRevoked('abc'), true);
});

test('other accounts: a role, an own password and two-step verification, apart from the owner', () => {
  auth._reset();
  if (!auth.hasPassword()) auth.createAccount('admin', 'owner-password-1');
  if (!auth.userName()) auth.claimUser('admin');
  const owner = auth.userName();
  const v = auth.addAccount('lisa', { password: 'lisa-password-1', role: 'user', mustChange: true, mfaRequired: true });
  assert.deepEqual([v.role, v.mustChange, v.mfaRequired, v.mfa], ['user', true, true, false]);
  assert.equal(auth.verifyAccount('lisa', 'lisa-password-1'), true);
  assert.equal(auth.verifyAccount('lisa', 'owner-password-1'), false);
  assert.equal(auth.verifyPassword('lisa-password-1'), false); // the owner's password is another one
  assert.throws(() => auth.addAccount(owner, { password: 'x'.repeat(12) }), /already the administrator/);
  assert.throws(() => auth.addAccount('tom', { password: 'short' }), /at least 10/);
  assert.throws(() => auth.addAccount('tom', { password: 'tom-password-1', role: 'root' }), /Administrator or User/);
  // choosing a new password: not the old one, mustChange off, older sessions invalid
  const before = auth.sessionsAfter('lisa');
  assert.throws(() => auth.setAccountPassword('lisa', 'lisa-password-1'), /different from the old one/);
  auth.setAccountPassword('lisa', 'lisa-password-2', {}, before + 1000);
  assert.equal(auth.account('lisa').mustChange, false);
  assert.ok(auth.sessionsAfter('lisa') > before);
  // two-step verification of lisa doesn't touch the owner's
  const { secret } = auth.beginSetup('lisa@freddy', 'lisa');
  const t0 = Date.now();
  auth.finishSetup(auth.totp(secret, t0), t0, 'lisa');
  assert.equal(auth.mfaEnabled('lisa'), true);
  assert.equal(auth.mfaEnabled(), false);
  const id = auth.newPending(t0, { who: 'lisa', step: 'mfa' });
  assert.deepEqual(auth.peekPending(id, t0), { who: 'lisa', step: 'mfa' });
  const r = auth.usePending(id, auth.totp(secret, t0 + 30000), t0 + 30000);
  assert.deepEqual([r.result, r.who], ['ok', 'lisa']);
  // a lower role signs the account out; removing it ends its sessions
  auth.updateAccount('lisa', { role: 'admin' });
  assert.equal(auth.account('lisa').role, 'admin');
  assert.equal(auth.listAccounts().length, 1);
  auth.removeAccount('lisa');
  assert.equal(auth.account('lisa'), null);
  assert.equal(auth.sessionsAfter('lisa'), Infinity);
});
