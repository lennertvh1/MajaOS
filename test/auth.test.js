'use strict';
/* Tests voor aanmelden met tweestapsverificatie: TOTP (RFC 6238), herstelcodes, de tweede stap en het blokkeren na foute pogingen. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
const auth = require('../lib/auth');

// Het geheim uit RFC 6238 (bijlage B) is de ASCII-tekst "12345678901234567890".
const RFC_SECRET = auth.base32Encode(Buffer.from('12345678901234567890'));

test('base32 heen en terug', () => {
  assert.equal(auth.base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(auth.base32Decode('MZXW6YTBOI').toString(), 'foobar');
  assert.equal(auth.base32Decode('mzxw 6ytb-oi======').toString(), 'foobar');
  assert.throws(() => auth.base32Decode('MZ1'));
});

test('TOTP volgens de testwaarden van RFC 6238 (SHA-1, 8 cijfers → laatste 6)', () => {
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [sec, code] of vectors) {
    assert.equal(auth.hotp(Buffer.from('12345678901234567890'), Math.floor(sec / 30), 8), code, 'tijd ' + sec);
    assert.equal(auth.totp(RFC_SECRET, sec * 1000), code.slice(2));
  }
});

test('verifyTotp: één stap speling, geen hergebruik', () => {
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

test('otpauth-adres', () => {
  const uri = auth.otpauthUri('ABCD', 'freddy');
  assert.equal(uri, 'otpauth://totp/HomeBaseOS:freddy?secret=ABCD&issuer=HomeBaseOS&algorithm=SHA1&digits=6&period=30');
});

test('herstelcodes: vorm en hash zonder hoofdletters of streepje', () => {
  const c = auth.newRecoveryCode();
  assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.equal(auth.hashRecovery(c), auth.hashRecovery(c.toUpperCase().replace('-', ' ')));
});

test('instellen, aanmelden en uitzetten', () => {
  auth._reset();
  assert.equal(auth.mfaEnabled(), false);
  assert.deepEqual(auth.checkCode('000000'), { ok: true }); // uit: geen code nodig
  const { secret, uri } = auth.beginSetup('freddy');
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.ok(uri.includes('secret=' + secret));
  const t0 = Date.now();
  assert.throws(() => auth.finishSetup('000000', t0), /klopt niet/);
  const { recovery } = auth.finishSetup(auth.totp(secret, t0), t0);
  assert.equal(recovery.length, 10);
  assert.equal(auth.mfaEnabled(), true);
  assert.ok(auth.sessionsAfter() >= t0);
  // Opgeslagen met alleen hashes van de herstelcodes, en niet leesbaar voor anderen.
  const file = path.join(process.env.DATA_DIR, 'auth.json');
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!saved.includes(recovery[0]));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.throws(() => auth.beginSetup('freddy'), /staat al aan/);

  // De code waarmee je net koppelde, werkt niet nog eens; de volgende wel.
  assert.equal(auth.checkCode(auth.totp(secret, t0), t0).ok, false);
  assert.equal(auth.checkCode(auth.totp(secret, t0 + 30000), t0 + 30000).ok, true);
  // Herstelcode: één keer.
  const r = auth.checkCode(recovery[3].toUpperCase());
  assert.deepEqual(r, { ok: true, recovery: true, recoveryLeft: 9 });
  assert.equal(auth.checkCode(recovery[3]).ok, false);
  assert.equal(auth.status().recoveryLeft, 9);
  // Na het herladen van het bestand blijft alles staan.
  auth._reset();
  assert.equal(auth.mfaEnabled(), true);
  assert.equal(auth.status().recoveryLeft, 9);
  // Nieuwe herstelcodes vervangen de oude.
  const fresh = auth.newRecovery().recovery;
  assert.equal(auth.checkCode(recovery[0]).ok, false);
  assert.equal(auth.checkCode(fresh[0]).ok, true);
  auth.disable();
  assert.equal(auth.mfaEnabled(), false);
});

test('koppelen verloopt na 15 minuten', () => {
  auth._reset();
  const { secret } = auth.beginSetup('freddy');
  const later = Date.now() + 16 * 60 * 1000;
  assert.throws(() => auth.finishSetup(auth.totp(secret, later), later), (e) => e.status === 410);
  auth.disable();
});

test('tweede stap: eenmalig, verloopt, en vervalt na 5 foute codes', () => {
  auth._reset();
  const { secret } = auth.beginSetup('freddy');
  const t0 = Date.now();
  auth.finishSetup(auth.totp(secret, t0 - 30000), t0);
  const id = auth.newPending(t0);
  assert.equal(auth.usePending(id, '000000', t0).result, 'wrong');
  assert.equal(auth.usePending(id, auth.totp(secret, t0), t0).result, 'ok');
  assert.equal(auth.usePending(id, auth.totp(secret, t0 + 30000), t0 + 30000).result, 'expired'); // al gebruikt
  const old = auth.newPending(t0);
  assert.equal(auth.usePending(old, auth.totp(secret, t0 + 6 * 60000), t0 + 6 * 60000).result, 'expired');
  const id2 = auth.newPending(t0);
  for (let i = 0; i < 5; i++) assert.equal(auth.usePending(id2, '000000', t0).result, 'wrong');
  assert.equal(auth.usePending(id2, auth.totp(secret, t0 + 30000), t0 + 30000).result, 'expired');
  assert.equal(auth.usePending('', '123456').result, 'expired');
  auth.disable();
});

test('blokkeren na 10 foute pogingen binnen 10 minuten', () => {
  auth._reset();
  const t0 = 1e12;
  for (let i = 0; i < 9; i++) auth.failed('10.0.0.5', t0 + i * 1000);
  assert.equal(auth.lockedFor('10.0.0.5', t0 + 10000), 0);
  auth.failed('10.0.0.5', t0 + 10000);
  assert.equal(auth.lockedFor('10.0.0.5', t0 + 10000), 300);
  assert.equal(auth.lockedFor('10.0.0.6', t0 + 10000), 0); // ander adres
  assert.equal(auth.lockedFor('10.0.0.5', t0 + 10000 + 300001), 0);
  // Oude fouten tellen niet meer mee.
  for (let i = 0; i < 9; i++) auth.failed('10.0.0.7', t0 + i * 1000);
  auth.failed('10.0.0.7', t0 + 11 * 60 * 1000);
  assert.equal(auth.lockedFor('10.0.0.7', t0 + 11 * 60 * 1000), 0);
  auth.succeeded('10.0.0.5');
  assert.equal(auth.lockedFor('10.0.0.5', t0 + 10000), 0);
});

test('eigen wachtwoord (scrypt) en welkomstwizard', () => {
  auth._reset();
  assert.equal(auth.hasPassword(), false);
  assert.throws(() => auth.setPassword('kort'), /minstens 10/);
  assert.throws(() => auth.setPassword('aaaaaaaaaaaa'), /makkelijk/);
  assert.throws(() => auth.setPassword('1234567890abc'), /makkelijk/);
  const t0 = Date.now();
  auth.setPassword('paard batterij nietje', t0);
  assert.equal(auth.hasPassword(), true);
  assert.equal(auth.verifyPassword('paard batterij nietje'), true);
  assert.equal(auth.verifyPassword('paard batterij nietjx'), false);
  assert.equal(auth.verifyPassword(''), false);
  assert.ok(auth.sessionsAfter() >= t0);
  const saved = fs.readFileSync(path.join(process.env.DATA_DIR, 'auth.json'), 'utf8');
  assert.ok(!saved.includes('paard'));
  // Tweestapsverificatie aanzetten laat het wachtwoord staan (en omgekeerd).
  const { secret } = auth.beginSetup('freddy');
  auth.finishSetup(auth.totp(secret));
  auth._reset();
  assert.equal(auth.verifyPassword('paard batterij nietje'), true);
  auth.disable();
  assert.equal(auth.verifyPassword('paard batterij nietje'), true);

  const onb = require('../lib/onboarding');
  assert.equal(onb.getState().done, false);
  assert.equal(onb.finish({ skipped: true }).skipped, true);
  assert.equal(onb.getState().done, true);
  onb.reset();
  assert.equal(onb.getState().done, false);
});

test('account aanmaken bij de eerste keer (gebruikersnaam + wachtwoord)', () => {
  fs.rmSync(path.join(process.env.DATA_DIR, 'auth.json'), { force: true });
  auth._reset();
  assert.equal(auth.userName(), null);
  assert.equal(auth.checkUser('wat dan ook'), true); // zonder gebruikersnaam telt alleen het wachtwoord
  assert.throws(() => auth.createAccount('1x', 'paard batterij nietje'), /gebruikersnaam/);
  assert.throws(() => auth.createAccount('Lennert', 'kort'), /minstens 10/);
  assert.equal(auth.hasPassword(), false);
  assert.deepEqual(auth.createAccount('Lennert', 'paard batterij nietje'), { ok: true, user: 'lennert' });
  assert.equal(auth.hasPassword(), true);
  assert.equal(auth.checkUser('LENNERT '), true);
  assert.equal(auth.checkUser('admin'), false);
  // Een tweede account kan niet, en een nieuw wachtwoord laat de gebruikersnaam staan.
  assert.throws(() => auth.createAccount('admin', 'paard batterij nietje'), /al een account/);
  auth.setPassword('een ander lang wachtwoord');
  auth._reset();
  assert.equal(auth.userName(), 'lennert');
  assert.equal(auth.verifyPassword('een ander lang wachtwoord'), true);
});
