'use strict';
/* The activity log (Settings → Logs): requests in plain words, Samba's full_audit lines, journalctl, and the log file. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-'));
process.env.DATA_DIR = dir;
const activity = require('../lib/activity');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('requests in plain words, and what is not worth logging', () => {
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(activity.describe('PUT', '/api/shares/media/files', q('path=Films/a.mkv')), { kind: 'files', action: 'Uploaded a file', target: 'media/Films/a.mkv' });
  assert.deepEqual(activity.describe('DELETE', '/api/shares/media/files', q('path=old.txt&recursive=1')), { kind: 'files', action: 'Deleted', target: 'media/old.txt' });
  assert.equal(activity.describe('GET', '/api/shares/media/files', q('path=a.mkv&dl=1')).action, 'Downloaded');
  assert.equal(activity.describe('GET', '/api/shares/media/files', q('path=')), null); // browsing a folder
  assert.equal(activity.describe('GET', '/api/apps'), null);
  assert.deepEqual(activity.describe('POST', '/api/apps/abc123/stop'), { kind: 'apps', action: 'Stopped an app', target: 'abc123' });
  assert.equal(activity.describe('POST', '/api/vms/Home%20Assistant/start').target, 'Home Assistant');
  assert.equal(activity.describe('POST', '/api/vms/ha/snapshots/before-update/revert').target, 'ha · before-update');
  assert.equal(activity.describe('POST', '/api/backup/jobs/j1/run').action, 'Started a backup');
  assert.equal(activity.describe('POST', '/api/sysbackups/s1/run').action, 'Started a backup');
  assert.equal(activity.describe('POST', '/api/terminal/run').action, 'Ran a command on the server');
  assert.equal(activity.describe('POST', '/api/layout'), null);
  assert.equal(activity.describe('POST', '/api/ai/chat'), null);
  assert.equal(activity.describe('POST', '/api/login'), null); // sign-ins are logged by server.js itself
  // Unknown: still logged, as it is.
  assert.deepEqual(activity.describe('POST', '/api/something-new'), { kind: 'other', action: 'POST /api/something-new', target: '' });
});

test('Samba full_audit lines: only what changes files', () => {
  assert.deepEqual(activity.parseAudit('emma|192.168.1.42|documents|openat|ok|w|taxes/2025.pdf'),
    { who: 'emma', via: 'smb', kind: 'files', ip: '192.168.1.42', action: 'Saved a file', target: 'documents/taxes/2025.pdf' });
  assert.equal(activity.parseAudit('emma|192.168.1.42|documents|openat|ok|r|taxes/2025.pdf'), null); // reading
  assert.equal(activity.parseAudit('emma|192.168.1.42|documents|openat|fail (No such file)|w|x'), null);
  assert.equal(activity.parseAudit('emma|1.2.3.4|documents|unlinkat|ok|old.txt').action, 'Deleted');
  assert.equal(activity.parseAudit('emma|1.2.3.4|documents|mkdirat|ok|New folder').action, 'Made a folder');
  assert.equal(activity.parseAudit('emma|1.2.3.4|documents|renameat|ok|a.txt|sub/b.txt').target, 'documents/a.txt → documents/sub/b.txt');
  // macOS and Windows clutter, and streams
  assert.equal(activity.parseAudit('emma|1.2.3.4|documents|openat|ok|w|.DS_Store'), null);
  assert.equal(activity.parseAudit('emma|1.2.3.4|documents|openat|ok|w|sub/._photo.jpg'), null);
  assert.equal(activity.parseAudit('emma|1.2.3.4|documents|openat|ok|w|a.txt:AFP_AfpInfo'), null);
  assert.equal(activity.parseAudit('nonsense'), null);
});

test('journalctl lines of smbd_audit: a file saved again and again counts once per 10 minutes', () => {
  const at = 1794865000000;
  const line = (ms, msg) => JSON.stringify({ __REALTIME_TIMESTAMP: String(ms * 1000), MESSAGE: msg, __CURSOR: 'c' + ms });
  const text = [
    line(at, 'emma|1.2.3.4|docs|openat|ok|w|a.docx'),
    line(at + 1000, 'emma|1.2.3.4|docs|openat|ok|w|a.docx'),
    line(at + 2000, 'emma|1.2.3.4|docs|openat|ok|r|a.docx'),
    line(at + 11 * 60000, 'emma|1.2.3.4|docs|openat|ok|w|a.docx'),
    line(at + 3000, 'noah|1.2.3.5|docs|openat|ok|w|a.docx'),
    'not json',
  ].join('\n');
  const list = activity.auditEntries(text, new Map());
  assert.deepEqual(list.map((e) => [e.who, e.at - at]), [['emma', 0], ['emma', 11 * 60000], ['noah', 3000]]);
});

test('journalctl -o json: time, service and level', () => {
  const out = activity.parseJournal([
    JSON.stringify({ __REALTIME_TIMESTAMP: '1794865000000000', _SYSTEMD_UNIT: 'nut-server.service', PRIORITY: '6', MESSAGE: 'Connected to UPS [ups]' }),
    JSON.stringify({ __REALTIME_TIMESTAMP: '1794865001000000', _TRANSPORT: 'kernel', PRIORITY: '3', MESSAGE: 'ata3.00: failed command' }),
    JSON.stringify({ __REALTIME_TIMESTAMP: '1794865002000000', SYSLOG_IDENTIFIER: 'smbd_audit', PRIORITY: '4', MESSAGE: [104, 105] }),
  ].join('\n'));
  assert.deepEqual(out, [
    { at: 1794865000000, unit: 'nut-server', level: 'info', text: 'Connected to UPS [ups]' },
    { at: 1794865001000, unit: 'kernel', level: 'error', text: 'ata3.00: failed command' },
    { at: 1794865002000, unit: 'smbd_audit', level: 'warning', text: 'hi' },
  ]);
});

test('the log file: newest first, filters, people and Show more', () => {
  const t0 = 1794865000000;
  activity.add({ at: t0, who: 'emma', via: 'smb', kind: 'files', action: 'Saved a file', target: 'docs/a.txt' });
  activity.add({ at: t0 + 1000, who: 'lennert', kind: 'apps', action: 'Stopped an app', target: 'jellyfin' });
  activity.add({ at: t0 + 2000, who: 'noah', kind: 'signin', action: 'Sign-in failed', ok: false, error: 'Wrong password', ip: '10.0.0.5' });
  activity.fromRequest({ method: 'POST', path: '/api/layout', who: 'lennert', status: 200 }); // not logged
  activity.fromRequest({ method: 'DELETE', path: '/api/apps/abc', who: 'lennert', via: 'mcp', status: 409, error: 'Busy', extra: { target: 'immich' } });
  const all = activity.list();
  assert.deepEqual(all.entries.map((e) => e.who), ['lennert', 'noah', 'lennert', 'emma']);
  assert.deepEqual(all.people, ['emma', 'lennert', 'noah']);
  const removed = all.entries[0];
  assert.equal(removed.action, 'Removed an app'); assert.equal(removed.target, 'immich'); assert.equal(removed.ok, false); assert.equal(removed.error, 'Busy'); assert.equal(removed.via, 'mcp');
  assert.deepEqual(activity.list({ who: 'emma' }).entries.map((e) => e.target), ['docs/a.txt']);
  assert.deepEqual(activity.list({ kind: 'signin' }).entries.map((e) => e.ip), ['10.0.0.5']);
  assert.equal(activity.list({ q: 'JELLY' }).entries.length, 1);
  const page = activity.list({ limit: 2 });
  assert.equal(page.entries.length, 2); assert.equal(page.more, true);
  assert.deepEqual(activity.list({ before: page.entries[1].at, limit: 2 }).entries.map((e) => e.who), ['lennert', 'emma']);
});
