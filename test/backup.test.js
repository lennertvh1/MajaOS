'use strict';
/* Tests for backups: rclone.conf, checks, schedules, arguments for rclone and rclone's output. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-backup-'));
const b = require('../lib/backup');
const CONF = path.join(process.env.DATA_DIR, 'rclone.conf');

const DS = b.parseDatasets([
  'tank\t/tank\tyes\t1000\t9000\t0',
  'tank/photos\t/tank/photos\tyes\t500\t9000\t0',
  'tank/backups/macbook\t/tank/backups/macbook\tyes\t200\t300\t500',
  'fast\t/fast\tyes\t10\t90\t-',
  'tank/old\tnone\t-\t0\t0\t0', // no mount point: doesn't count
].join('\n'));

test('reading zfs list', () => {
  assert.equal(DS.length, 4);
  assert.deepEqual(DS[2], { name: 'tank/backups/macbook', mountpoint: '/tank/backups/macbook', mounted: true, used: 200, avail: 300, quota: 500 });
  assert.equal(DS[3].quota, 0);
});

test('reading and writing rclone.conf', () => {
  const text = '# opmerking\n[google]\ntype = drive\nscope = drive\ntoken = {"access_token":"a=b","expiry":"2026"}\n\n[nas]\ntype = sftp\nhost = 192.168.1.20\n';
  const s = b.parseConf(text);
  assert.deepEqual(s.map((x) => x.name), ['google', 'nas']);
  assert.equal(s[0].opts.token, '{"access_token":"a=b","expiry":"2026"}'); // = in the value stays
  assert.deepEqual(b.parseConf(b.buildConf(s)), s);
});

test('checking folders', () => {
  assert.equal(b.cleanRemotePath(' Backups//Freddy/ '), 'Backups/Freddy');
  assert.equal(b.cleanRemotePath('/volume1/backup/'), '/volume1/backup'); // absolute with SFTP
  assert.equal(b.cleanRemotePath(''), '');
  assert.throws(() => b.cleanRemotePath('a/../b'), /plain folder names/);
  assert.throws(() => b.cleanRemotePath('a\nb'), /plain folder names/);
  assert.equal(b.cleanLocalPath('/tank/photos/', DS, 'push'), '/tank/photos');
  assert.equal(b.cleanLocalPath('/tank', DS, 'push'), '/tank');
  assert.throws(() => b.cleanLocalPath('/tank', DS, 'pull'), /not the whole pool/);
  assert.throws(() => b.cleanLocalPath('/tankje/x', DS, 'push'), /on one of your pools/);
  assert.throws(() => b.cleanLocalPath('/etc', DS, 'push'), /on one of your pools/);
  assert.throws(() => b.cleanLocalPath('tank/photos', DS, 'push'), /on one of your pools/);
});

test('checking a task', () => {
  const ctx = { remotes: ['google', 'nas'], datasets: DS };
  const base = { name: "Photos", remote: 'google', remotePath: 'Freddy/photos', localPath: '/tank/photos', schedule: { every: 'daily', time: '02:30' } };
  const j = b.validateJob({ ...base, mode: 'sync', versions: true, keepDays: '14', excludes: '*.tmp\n\n.DS_Store\n', bwlimit: '10M' }, ctx);
  assert.deepEqual(j, {
    name: "Photos", direction: 'push', mode: 'sync', remote: 'google', remotePath: 'Freddy/photos', localPath: '/tank/photos', encrypt: false,
    versions: true, keepDays: 14, schedule: { every: 'daily', time: '02:30', day: 0 }, excludes: ['*.tmp', '.DS_Store'], bwlimit: '10M',
  });
  const bad = (x, re) => assert.throws(() => b.validateJob({ ...base, ...x }, ctx), re);
  bad({ name: ' ' }, /name/);
  bad({ remote: 'dropbox' }, /Choose a connection/);
  bad({ mode: 'sync', remotePath: '' }, /top folder would delete everything/);
  bad({ versions: true, remotePath: '/' }, /old versions/);
  bad({ bwlimit: '10 MB' }, /bandwidth/);
  bad({ excludes: Array(51).fill('x') }, /at most 50/);
  // encrypted: syncing to the top folder is allowed (everything is in a folder of its own inside the encryption)
  assert.equal(b.validateJob({ ...base, mode: 'sync', remotePath: '', encrypt: true }, ctx).encrypt, true);
  // pulling: never encrypted or with versions, and never into the whole pool
  const pull = b.validateJob({ ...base, direction: 'pull', localPath: '/tank/photos/drive', encrypt: true, versions: true }, ctx);
  assert.equal(pull.encrypt, false); assert.equal(pull.versions, false);
  bad({ direction: 'pull', localPath: '/tank' }, /not the whole pool/);
  // you only choose encryption when creating
  assert.equal(b.validateJob({ ...base, encrypt: false }, { ...ctx, current: { encrypt: true } }).encrypt, true);
  // an unknown schedule becomes "manual"
  assert.deepEqual(b.validateJob({ ...base, schedule: { every: 'soms', time: '25:00', day: 9 } }, ctx).schedule, { every: 'manual', time: '03:00', day: 0 });
});

test('schedule: next time', () => {
  const at = (s) => new Date(s).getTime();
  const from = at('2026-10-21T10:15:00'); // Wednesday
  assert.equal(b.nextRun({ every: 'manual' }, from), null);
  assert.equal(b.nextRun({ every: 'daily', time: '03:00' }, from), at('2026-10-22T03:00:00'));
  assert.equal(b.nextRun({ every: 'daily', time: '23:30' }, from), at('2026-10-21T23:30:00'));
  assert.equal(b.nextRun({ every: 'hourly', time: '00:20' }, from), at('2026-10-21T10:20:00'));
  assert.equal(b.nextRun({ every: 'hourly', time: '00:10' }, from), at('2026-10-21T11:10:00'));
  assert.equal(b.nextRun({ every: 'weekly', time: '04:00', day: 0 }, from), at('2026-10-25T04:00:00')); // Sunday
  assert.equal(b.nextRun({ every: 'weekly', time: '12:00', day: 3 }, from), at('2026-10-21T12:00:00')); // still today
  assert.equal(b.nextRun({ every: 'weekly', time: '09:00', day: 3 }, from), at('2026-10-28T09:00:00')); // already past today
});

test('arguments for rclone', () => {
  const job = { id: 'abcd1234', direction: 'push', mode: 'sync', remote: 'google', remotePath: 'Freddy/photos', localPath: '/tank/photos',
    excludes: ['*.tmp'], bwlimit: '5M', versions: true, encrypt: false };
  const args = b.buildArgs(job, { stamp: '2026-10-21_101500' });
  assert.deepEqual(args.slice(0, 3), ['sync', '/tank/photos', 'google:Freddy/photos']);
  assert.deepEqual(args.slice(3, 5), ['--config', CONF]);
  assert.ok(args.includes('--use-json-log'));
  assert.deepEqual(args.slice(args.indexOf('--exclude'), args.indexOf('--exclude') + 2), ['--exclude', '*.tmp']);
  // Tasks from before 0.6 (no names: 'en') keep the Dutch folder names they were created with.
  assert.deepEqual(args.slice(args.indexOf('--backup-dir'), args.indexOf('--backup-dir') + 2), ['--backup-dir', 'google:Freddy/photos (oude versies)/2026-10-21_101500']);
  assert.ok(!args.includes('--dry-run'));
  assert.ok(b.buildArgs(job, { dryRun: true }).includes('--dry-run'));
  // encrypted: everything inside hb-crypt-<id>
  const enc = b.buildArgs({ ...job, encrypt: true }, { stamp: 'x' });
  assert.deepEqual(enc.slice(0, 3), ['sync', '/tank/photos', 'hb-crypt-abcd1234:bestanden']);
  assert.equal(enc[enc.indexOf('--backup-dir') + 1], 'hb-crypt-abcd1234:versies/x');
  // Tasks created since 0.6 (names: 'en') use English folder names; older tasks keep the Dutch ones above.
  const en = b.buildArgs({ ...job, names: 'en' }, { stamp: 'x' });
  assert.equal(en[en.indexOf('--backup-dir') + 1], 'google:Freddy/photos (old versions)/x');
  const encEn = b.buildArgs({ ...job, names: 'en', encrypt: true }, { stamp: 'x' });
  assert.deepEqual([encEn[2], encEn[encEn.indexOf('--backup-dir') + 1]], ['hb-crypt-abcd1234:files', 'hb-crypt-abcd1234:versions/x']);
  // pulling and restoring reverse the direction; restoring always copies, without excludes or versions
  assert.deepEqual(b.buildArgs({ ...job, direction: 'pull', mode: 'copy', versions: false }).slice(0, 3), ['copy', 'google:Freddy/photos', '/tank/photos']);
  const rs = b.buildArgs(job, { kind: 'restore', target: '/tank/photos-restored' });
  assert.deepEqual(rs.slice(0, 3), ['copy', 'google:Freddy/photos', '/tank/photos-restored']);
  assert.ok(!rs.includes('--backup-dir') && !rs.includes('--exclude'));
});

test('reading the output of rclone', () => {
  const st = b.parseLogLine(JSON.stringify({ level: 'info', msg: '\nTransferred: …', stats: { bytes: 512, totalBytes: 2048, transfers: 3, totalTransfers: 10, speed: 100.5, eta: 15, errors: 0, checks: 4 }, time: '2026-10-21T10:15:02+02:00' }));
  assert.ok(st.stats);
  assert.deepEqual(b.summarize(st.stats), { bytes: 512, totalBytes: 2048, files: 3, totalFiles: 10, checks: 4, deletes: 0, errors: 0, speed: 100.5, eta: 15, percent: 25 });
  assert.equal(b.summarize({ totalBytes: 0 }).percent, null);
  assert.deepEqual(b.parseLogLine(JSON.stringify({ level: 'info', msg: 'Copied (new)', object: '2024/IMG_0001.jpg', time: 't' })), { level: 'info', time: 't', text: '2024/IMG_0001.jpg: Copied (new)' });
  assert.equal(b.parseLogLine(JSON.stringify({ level: 'error', msg: 'Failed to copy: permission denied' })).level, 'error');
  assert.deepEqual(b.parseLogLine('2026/10/21 10:15:00 Failed to create file system: didn\'t find section in config file'), { level: 'error', text: '2026/10/21 10:15:00 Failed to create file system: didn\'t find section in config file' });
});

test('signing in: link and token from rclone authorize', () => {
  const out = '2026/10/21 10:15:00 NOTICE: Make sure your Redirect URL is set to "http://127.0.0.1:53682/" in your custom config.\n' +
    '2026/10/21 10:15:00 NOTICE: Please go to the following link: http://127.0.0.1:53682/auth?state=Ab-9_x\n2026/10/21 10:15:00 NOTICE: Log in and authorize rclone for access\n';
  assert.equal(b.parseAuthLink(out), 'http://127.0.0.1:53682/auth?state=Ab-9_x');
  assert.equal(b.parseAuthLink('nothing'), null);
  const token = { access_token: 'ya29.x', token_type: 'Bearer', refresh_token: '1//r', expiry: '2026-10-21T11:15:00Z' };
  // older versions: the token itself
  const plain = b.parseAuthToken(`Paste the following into your remote machine --->\n${JSON.stringify(token)}\n<---End paste\n`);
  assert.deepEqual(JSON.parse(plain.token), token);
  // newer versions: base64 of {"token": "…"} with possibly more settings
  const blob = Buffer.from(JSON.stringify({ token: JSON.stringify(token), drive_id: 'abc', drive_type: 'personal' })).toString('base64');
  const enc = b.parseAuthToken(`Paste the following into your remote machine --->\n${blob}\n<---End paste`);
  assert.deepEqual(JSON.parse(enc.token), token);
  assert.deepEqual(enc.extra, { drive_id: 'abc', drive_type: 'personal' });
  // pasted by hand, without the arrows
  assert.ok(b.parseAuthToken(JSON.stringify(token)));
  assert.equal(b.parseAuthToken('{"foo":1}'), null);
  assert.equal(b.parseAuthToken('Waiting for code...'), null);
});

test('checking a device', () => {
  const ctx = { devices: [{ name: 'iMac' }], shareNames: ['media'], pools: ['tank', 'fast'], users: ['lisa', 'tom'] };
  assert.deepEqual(b.validateDevice({ name: 'MacBook-Lisa', kind: 'mac', pool: 'tank', quotaGb: 1000, user: 'lisa' }, ctx),
    { name: 'MacBook-Lisa', kind: 'mac', method: 'share', pool: 'tank', quotaGb: 1000, user: 'lisa', dataset: 'tank/backups/macbook-lisa' });
  assert.equal(b.validateDevice({ name: 'pc', kind: 'windows', pool: 'fast', quotaGb: '', newUser: { name: 'kim' } }, ctx).user, 'kim');
  const bad = (x, re) => assert.throws(() => b.validateDevice({ name: 'phone', kind: 'phone', pool: 'tank', user: 'tom', ...x }, ctx), re);
  bad({ name: 'imac' }, /device named imac already exists/);
  bad({ name: 'Media' }, /shared folder/);
  bad({ name: 'my phone' }, /Choose a name/);
  bad({ kind: 'tv' }, /what kind of device/);
  bad({ pool: 'tank/backups' }, /pool/);
  bad({ quotaGb: 1.5 }, /maximum size/);
  bad({ user: 'root' }, /who may make the backups/);
});
