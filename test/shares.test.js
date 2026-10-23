'use strict';
/* Tests for shared folders: the Samba file and the checks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const sh = require('../lib/shares');

test('building the Samba configuration', () => {
  const conf = sh.buildSmbConf([
    { name: 'media', path: '/tank/media', comment: 'Films and series', users: { lisa: 'rw', tom: 'ro' }, guest: false, timemachine: false },
    { name: 'TimeMachine', path: '/tank/timemachine', comment: '', users: { lisa: 'rw' }, guest: false, timemachine: true },
    { name: 'public', path: '/tank/public', comment: '', users: {}, guest: true, timemachine: false },
    { name: 'empty', path: '/tank/empty', comment: '', users: {}, guest: false }, // would let everyone in: skip
  ], { forceUser: 'lennert', forceGroup: 'lennert' });
  assert.match(conf, /\[media\]\n {3}path = \/tank\/media\n {3}comment = Films and series\n {3}browseable = yes\n {3}read only = yes\n {3}valid users = lisa tom\n {3}guest ok = no\n {3}write list = lisa\n {3}force user = lennert\n {3}force group = lennert/);
  assert.match(conf, /\[TimeMachine\][\s\S]*fruit:time machine = yes/);
  assert.match(conf, /\[public\]\n {3}path = \/tank\/public\n {3}browseable = yes\n {3}read only = yes\n {3}guest ok = yes\n/);
  assert.doesNotMatch(conf, /\[public\][^[]*valid users/);
  assert.doesNotMatch(conf, /\[empty\]/);
  // alphabetical (the way a person sorts), so the file doesn't change needlessly
  assert.ok(conf.indexOf('[media]') < conf.indexOf('[public]') && conf.indexOf('[public]') < conf.indexOf('[TimeMachine]'));
});

test('checking a shared folder', () => {
  const ctx = { names: ['media'], users: ['lisa', 'tom'], roots: ['/tank', '/fast'] };
  const ok = sh.validateShare({ name: 'photos', path: '/tank/photos/', comment: 'Photos\nof ours', users: { lisa: 'rw', tom: 'none' }, timemachine: 1 }, ctx);
  assert.deepEqual(ok, { name: 'photos', path: '/tank/photos', comment: 'Photos of ours', users: { lisa: 'rw' }, groups: {}, guest: false, timemachine: true });
  assert.equal(sh.validateShare({ name: 'new', create: { parent: 'tank' }, users: { tom: 'ro' } }, ctx).path, null);
  const bad = (b, re) => assert.throws(() => sh.validateShare({ name: 'x', path: '/tank/x', users: { lisa: 'ro' }, ...b }, ctx), re);
  bad({ name: 'Media' }, /already exists/);
  bad({ name: 'homes' }, /Choose a name/);
  bad({ name: 'a b' }, /Choose a name/);
  bad({ users: { ghost: 'rw' } }, /no longer exists/);
  bad({ users: {} }, /at least one user/);
  bad({ path: '/etc' }, /pools/);
  bad({ path: '/tank/../etc' }, /pools/);
  bad({ path: '/tankx/a' }, /pools/);
  assert.equal(sh.validateShare({ name: 'pub', path: '/fast/pub', users: {}, guest: true }, ctx).guest, true);
});

test('password and user name', () => {
  assert.equal(sh.validatePassword('long enough'), 'long enough');
  assert.throws(() => sh.validatePassword('short'), /at least 8/);
  assert.throws(() => sh.validatePassword('line\nbreak123'), /line breaks/);
  assert.ok(sh.USER.test('lisa') && sh.USER.test('tom_2') && !sh.USER.test('Lisa') && !sh.USER.test('1x') && !sh.USER.test('a b'));
});

test('connected devices (smbstatus -j)', () => {
  const j = { sessions: { 1: { session_id: '1', remote_machine: '192.168.1.20', username: 'lisa' }, 2: { session_id: '2', remote_machine: '192.168.1.21', username: 'tom' },
    3: { session_id: '3', remote_machine: '192.168.1.20', username: 'lisa' } },
    tcons: { a: { service: 'media', machine: '192.168.1.20' }, b: { service: 'media', machine: '192.168.1.21' }, c: { service: 'IPC$' }, d: { service: 'photos' } } };
  assert.deepEqual(sh.parseSmbstatus(j), { total: 2, perShare: { media: 2, photos: 1 } });
  assert.deepEqual(sh.parseSmbstatus({}), { total: 0, perShare: {} });
});

test('groups: rights through a group, the highest right counts', () => {
  const groups = [{ name: 'Family', members: ['lisa', 'tom', 'kim'] }, { name: 'Parents', members: ['lisa'] }];
  const share = { name: 'photos', path: '/tank/photos', users: { tom: 'rw' }, groups: { Family: 'ro', Parents: 'rw' } };
  assert.deepEqual(sh.effectiveUsers(share, groups), { tom: 'rw', lisa: 'rw', kim: 'ro' });
  assert.deepEqual(sh.effectiveUsers({ users: {}, groups: { Gone: 'rw' } }, groups), {}); // a group that is gone doesn't count
  const conf = sh.buildSmbConf([share, { name: 'empty', path: '/tank/empty', users: {}, groups: { Parents: 'ro' } }], { groups });
  assert.match(conf, /\[photos\][\s\S]*valid users = kim lisa tom\n[\s\S]*write list = lisa tom/);
  assert.match(conf, /\[empty\][\s\S]*valid users = lisa\n/);
  assert.doesNotMatch(conf, /\[empty\][^[]*write list/);
});

test('checking a group', () => {
  const ctx = { names: ['Family'], users: ['lisa', 'tom'] };
  assert.deepEqual(sh.validateGroup({ name: 'Parents', comment: 'mum\nand dad', members: ['tom', 'lisa', 'tom'] }, ctx), { name: 'Parents', comment: 'mum and dad', members: ['lisa', 'tom'] });
  assert.throws(() => sh.validateGroup({ name: 'family' }, ctx), /already exists/);
  assert.throws(() => sh.validateGroup({ name: 'a b' }, ctx), /group name/);
  assert.throws(() => sh.validateGroup({ name: 'X', members: ['kim'] }, ctx), /no longer exists/);
  // a folder with only a group is valid
  const share = sh.validateShare({ name: 'docs', path: '/tank/docs', users: {}, groups: { Family: 'ro', Gone: 'none' } }, { users: ['lisa'], groups: ['Family'], roots: ['/tank'] });
  assert.deepEqual(share.groups, { Family: 'ro' });
  assert.throws(() => sh.validateShare({ name: 'd2', path: '/tank/d2', users: {}, groups: { Unknown: 'ro' } }, { groups: ['Family'], roots: ['/tank'] }), /doesn't exist/);
});
