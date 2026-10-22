'use strict';
/* Tests voor gedeelde mappen: het Samba-bestand en de controles. */
const test = require('node:test');
const assert = require('node:assert/strict');
const sh = require('../lib/shares');

test('Samba-configuratie maken', () => {
  const conf = sh.buildSmbConf([
    { name: 'media', path: '/tank/media', comment: 'Films en series', users: { lies: 'rw', tom: 'ro' }, guest: false, timemachine: false },
    { name: 'TimeMachine', path: '/tank/timemachine', comment: '', users: { lies: 'rw' }, guest: false, timemachine: true },
    { name: 'publiek', path: '/tank/publiek', comment: '', users: {}, guest: true, timemachine: false },
    { name: 'leeg', path: '/tank/leeg', comment: '', users: {}, guest: false }, // zou iedereen toelaten: overslaan
  ], { forceUser: 'lennert', forceGroup: 'lennert' });
  assert.match(conf, /\[media\]\n {3}path = \/tank\/media\n {3}comment = Films en series\n {3}browseable = yes\n {3}read only = yes\n {3}valid users = lies tom\n {3}guest ok = no\n {3}write list = lies\n {3}force user = lennert\n {3}force group = lennert/);
  assert.match(conf, /\[TimeMachine\][\s\S]*fruit:time machine = yes/);
  assert.match(conf, /\[publiek\]\n {3}path = \/tank\/publiek\n {3}browseable = yes\n {3}read only = yes\n {3}guest ok = yes\n/);
  assert.doesNotMatch(conf, /\[publiek\][^[]*valid users/);
  assert.doesNotMatch(conf, /\[leeg\]/);
  // alfabetisch (zoals een mens sorteert), zodat het bestand niet nodeloos verandert
  assert.ok(conf.indexOf('[media]') < conf.indexOf('[publiek]') && conf.indexOf('[publiek]') < conf.indexOf('[TimeMachine]'));
});

test('gedeelde map controleren', () => {
  const ctx = { names: ['media'], users: ['lies', 'tom'], roots: ['/tank', '/snel'] };
  const ok = sh.validateShare({ name: 'fotos', path: '/tank/fotos/', comment: 'Foto\'s\nvan ons', users: { lies: 'rw', tom: 'none' }, timemachine: 1 }, ctx);
  assert.deepEqual(ok, { name: 'fotos', path: '/tank/fotos', comment: "Foto's van ons", users: { lies: 'rw' }, guest: false, timemachine: true });
  assert.equal(sh.validateShare({ name: 'nieuw', create: { parent: 'tank' }, users: { tom: 'ro' } }, ctx).path, null);
  const bad = (b, re) => assert.throws(() => sh.validateShare({ name: 'x', path: '/tank/x', users: { lies: 'ro' }, ...b }, ctx), re);
  bad({ name: 'Media' }, /bestaat al/);
  bad({ name: 'homes' }, /Kies een naam/);
  bad({ name: 'a b' }, /Kies een naam/);
  bad({ users: { ghost: 'rw' } }, /bestaat niet/);
  bad({ users: {} }, /minstens één gebruiker/);
  bad({ path: '/etc' }, /pools/);
  bad({ path: '/tank/../etc' }, /pools/);
  bad({ path: '/tankx/a' }, /pools/);
  assert.equal(sh.validateShare({ name: 'pub', path: '/snel/pub', users: {}, guest: true }, ctx).guest, true);
});

test('wachtwoord en gebruikersnaam', () => {
  assert.equal(sh.validatePassword('lang genoeg'), 'lang genoeg');
  assert.throws(() => sh.validatePassword('kort'), /minstens 8/);
  assert.throws(() => sh.validatePassword('regel\neinde12'), /regeleinde/);
  assert.ok(sh.USER.test('lies') && sh.USER.test('tom_2') && !sh.USER.test('Lies') && !sh.USER.test('1x') && !sh.USER.test('a b'));
});

test('verbonden apparaten (smbstatus -j)', () => {
  const j = { sessions: { 1: { session_id: '1', remote_machine: '192.168.1.20', username: 'lies' }, 2: { session_id: '2', remote_machine: '192.168.1.21', username: 'tom' },
    3: { session_id: '3', remote_machine: '192.168.1.20', username: 'lies' } },
    tcons: { a: { service: 'media', machine: '192.168.1.20' }, b: { service: 'media', machine: '192.168.1.21' }, c: { service: 'IPC$' }, d: { service: 'fotos' } } };
  assert.deepEqual(sh.parseSmbstatus(j), { total: 2, perShare: { media: 2, fotos: 1 } });
  assert.deepEqual(sh.parseSmbstatus({}), { total: 0, perShare: {} });
});
