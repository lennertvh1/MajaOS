'use strict';
/* Tests for software update: comparing versions and converting GitHub's releases. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
const rel = require('../lib/release');

test('comparing versions', () => {
  const c = rel.compareVersions;
  assert.equal(c('0.3.0', '0.2.0'), 1);
  assert.equal(c('v0.2.0', '0.2.0'), 0);
  assert.equal(c('0.10.0', '0.9.9'), 1);
  assert.equal(c('1.0', '1.0.0'), 0);
  assert.equal(c('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(c('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(c('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(c('1.0.0-beta', '1.0.0-beta.1'), -1);
  assert.equal(rel.parseVersion('nightly'), null);
});

// As GET /repos/:repo/releases answers (shortened).
const GH = [
  { tag_name: 'v0.4.0-beta.1', name: 'v0.4.0-beta.1', body: 'test', html_url: 'https://github.com/a/b/releases/tag/v0.4.0-beta.1', published_at: '2026-10-21T09:00:00Z', draft: false, prerelease: true },
  { tag_name: 'v0.3.0', name: 'Date and time', body: '## New\r\n- something', html_url: 'https://github.com/a/b/releases/tag/v0.3.0', published_at: '2026-10-20T18:00:00Z', draft: false, prerelease: false },
  { tag_name: 'v0.5.0', name: 'draft', body: '', html_url: 'https://github.com/a/b/releases/tag/v0.5.0', draft: true, prerelease: false },
  { tag_name: 'nightly', name: 'nightly', body: '', html_url: 'https://github.com/a/b', draft: false, prerelease: false },
  { tag_name: 'v0.2.0', name: 'v0.2.0', body: null, html_url: 'javascript:alert(1)', published_at: '2026-10-01T12:00:00Z', draft: false, prerelease: false },
  { tag_name: 'v0.1.0', name: 'v0.1.0', body: 'first', html_url: 'https://github.com/a/b/releases/tag/v0.1.0', published_at: '2026-09-01T12:00:00Z', draft: false, prerelease: false },
];

test('converting releases: no drafts, beta only on request, newest first', () => {
  const stable = rel.normalizeReleases(GH);
  assert.deepEqual(stable.map((r) => r.version), ['0.3.0', '0.2.0', '0.1.0']);
  assert.equal(stable[0].name, 'Date and time');
  assert.equal(stable[1].notes, '');
  assert.equal(stable[1].url, null); // only links to github.com
  assert.deepEqual(rel.normalizeReleases(GH, { beta: true }).map((r) => r.version), ['0.4.0-beta.1', '0.3.0', '0.2.0', '0.1.0']);
  assert.deepEqual(rel.normalizeReleases(null), []);
});

test('summary against the installed version', () => {
  const s = rel.summarize(rel.normalizeReleases(GH), '0.2.0');
  assert.equal(s.updateAvailable, true);
  assert.equal(s.latest.version, '0.3.0');
  assert.deepEqual(s.newer.map((r) => r.version), ['0.3.0']);
  assert.equal(s.installed.version, '0.2.0');
  assert.deepEqual(s.history.map((r) => r.version), ['0.2.0', '0.1.0']);
  const up = rel.summarize(rel.normalizeReleases(GH), '0.3.0');
  assert.equal(up.updateAvailable, false);
  // A development version that is newer than the latest release: no update.
  assert.equal(rel.summarize(rel.normalizeReleases(GH), '0.3.1').updateAvailable, false);
});

test('status without having checked', () => {
  const s = rel.status();
  assert.equal(s.checked, null);
  assert.equal(s.updateAvailable, false);
  assert.equal(s.current, rel.currentVersion());
  assert.equal(s.auto, true);
  assert.equal(s.channel, 'stable');
});

test('update now: checks and progress', async () => {
  const upd = require('../lib/updater');
  const can = upd.canUpdate();
  if (process.platform !== 'linux') assert.equal(can.ok, false); // never on the Mac
  assert.equal(upd.progress().state, 'idle');
  // An update that has reported nothing for a long time counts as stuck.
  const dir = path.join(process.env.DATA_DIR, 'update');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'running', step: 'install', updated: new Date(Date.now() - 20 * 60000).toISOString() }));
  assert.equal(upd.isRunning(), false);
  assert.equal(upd.progress().state, 'failed');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'running', step: 'install', updated: new Date().toISOString() }));
  assert.equal(upd.isRunning(), true);
  if (can.ok) await assert.rejects(upd.start('0.3.0'), /already running/);
  else await assert.rejects(upd.start('0.3.0'), (e) => e.status === 409);
});

test('channel dev: the newest commit of the dev branch', () => {
  const sha = 'c0ffee15deadbeef0123456789abcdef01234567';
  const dev = { sha, version: '0.6.0', message: 'Apps: progress bar\n\nDetails', date: '2026-10-23T10:00:00Z', url: 'https://github.com/a/b/commit/' + sha,
    commits: [{ sha, message: 'Apps: progress bar' }, { sha: 'b'.repeat(40), message: 'English' }] };
  const s = rel.devSummary(dev, null, '0.5.0');
  assert.equal(s.updateAvailable, true);
  assert.equal(s.latest.version, '0.6.0+dev.c0ffee1');
  assert.equal(s.latest.name, 'Apps: progress bar');
  assert.equal(s.latest.notes, '- Apps: progress bar (c0ffee1)\n- English (bbbbbbb)');
  assert.ok(s.latest.dev && s.latest.prerelease);
  // The same commit installed: up to date.
  const same = rel.devSummary(dev, { branch: 'dev', commit: sha }, '0.6.0');
  assert.equal(same.updateAvailable, false); assert.deepEqual(same.newer, []); assert.equal(same.installed.commit, sha);
  // Nothing fetched yet.
  assert.equal(rel.devSummary(null, null, '0.5.0').updateAvailable, false);
});
