'use strict';
/* Tests voor software-update: versies vergelijken en de releases van GitHub omzetten. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
const rel = require('../lib/release');

test('versies vergelijken', () => {
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

// Zoals GET /repos/:repo/releases antwoordt (ingekort).
const GH = [
  { tag_name: 'v0.4.0-beta.1', name: 'v0.4.0-beta.1', body: 'test', html_url: 'https://github.com/a/b/releases/tag/v0.4.0-beta.1', published_at: '2026-10-21T09:00:00Z', draft: false, prerelease: true },
  { tag_name: 'v0.3.0', name: 'Datum en tijd', body: '## Nieuw\r\n- iets', html_url: 'https://github.com/a/b/releases/tag/v0.3.0', published_at: '2026-10-20T18:00:00Z', draft: false, prerelease: false },
  { tag_name: 'v0.5.0', name: 'concept', body: '', html_url: 'https://github.com/a/b/releases/tag/v0.5.0', draft: true, prerelease: false },
  { tag_name: 'nightly', name: 'nightly', body: '', html_url: 'https://github.com/a/b', draft: false, prerelease: false },
  { tag_name: 'v0.2.0', name: 'v0.2.0', body: null, html_url: 'javascript:alert(1)', published_at: '2026-10-01T12:00:00Z', draft: false, prerelease: false },
  { tag_name: 'v0.1.0', name: 'v0.1.0', body: 'eerste', html_url: 'https://github.com/a/b/releases/tag/v0.1.0', published_at: '2026-09-01T12:00:00Z', draft: false, prerelease: false },
];

test('releases omzetten: geen concepten, bèta alleen op vraag, nieuwste eerst', () => {
  const stable = rel.normalizeReleases(GH);
  assert.deepEqual(stable.map((r) => r.version), ['0.3.0', '0.2.0', '0.1.0']);
  assert.equal(stable[0].name, 'Datum en tijd');
  assert.equal(stable[1].notes, '');
  assert.equal(stable[1].url, null); // alleen links naar github.com
  assert.deepEqual(rel.normalizeReleases(GH, { beta: true }).map((r) => r.version), ['0.4.0-beta.1', '0.3.0', '0.2.0', '0.1.0']);
  assert.deepEqual(rel.normalizeReleases(null), []);
});

test('samenvatting tegenover de geïnstalleerde versie', () => {
  const s = rel.summarize(rel.normalizeReleases(GH), '0.2.0');
  assert.equal(s.updateAvailable, true);
  assert.equal(s.latest.version, '0.3.0');
  assert.deepEqual(s.newer.map((r) => r.version), ['0.3.0']);
  assert.equal(s.installed.version, '0.2.0');
  assert.deepEqual(s.history.map((r) => r.version), ['0.2.0', '0.1.0']);
  const up = rel.summarize(rel.normalizeReleases(GH), '0.3.0');
  assert.equal(up.updateAvailable, false);
  // Een ontwikkelversie die nieuwer is dan de laatste release: geen update.
  assert.equal(rel.summarize(rel.normalizeReleases(GH), '0.3.1').updateAvailable, false);
});

test('status zonder gezocht te hebben', () => {
  const s = rel.status();
  assert.equal(s.checked, null);
  assert.equal(s.updateAvailable, false);
  assert.equal(s.current, rel.currentVersion());
  assert.equal(s.auto, true);
  assert.equal(s.channel, 'stable');
});

test('nu bijwerken: controles en voortgang', async () => {
  const upd = require('../lib/updater');
  const can = upd.canUpdate();
  if (process.platform !== 'linux') assert.equal(can.ok, false); // op de Mac nooit
  assert.equal(upd.progress().state, 'idle');
  // Een update die al lang niets meldt, telt als vastgelopen.
  const dir = path.join(process.env.DATA_DIR, 'update');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'running', step: 'install', updated: new Date(Date.now() - 20 * 60000).toISOString() }));
  assert.equal(upd.isRunning(), false);
  assert.equal(upd.progress().state, 'failed');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'running', step: 'install', updated: new Date().toISOString() }));
  assert.equal(upd.isRunning(), true);
  if (can.ok) await assert.rejects(upd.start('0.3.0'), /loopt al/);
  else await assert.rejects(upd.start('0.3.0'), (e) => e.status === 409);
});
