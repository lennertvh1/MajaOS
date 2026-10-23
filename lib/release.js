'use strict';
/*
 * Software update of HomeBaseOS itself: look for new versions on GitHub (releases) and show the release notes.
 * UPDATE_REPO (default lennertvh1/homebaseos) and UPDATE_TOKEN (needed for a private repo: a GitHub token with read access to Contents).
 * The result is stored in DATA_DIR/release.json; checking happens 1 min after start and then every 12 hours (if turned on).
 * Channel dev (test servers): no releases, but the newest commit of the branch DEV_BRANCH (default dev). Which commit is
 * installed is in build.json next to server.js (written by lib/updater.js; absent for official releases).
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { httpError, readText } = require('./system');
const settings = require('./settings');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'release.json');
const REPO = process.env.UPDATE_REPO || 'lennertvh1/homebaseos';
const TOKEN = process.env.UPDATE_TOKEN || '';
const EVERY = 12 * 3600 * 1000;
const DEV_BRANCH = process.env.DEV_BRANCH || 'dev';
const BUILD_FILE = path.join(__dirname, '..', 'build.json');

function currentVersion() {
  try { return JSON.parse(readText(path.join(__dirname, '..', 'package.json'))).version || '0.0.0'; } catch { return '0.0.0'; }
}

// The installed development build: { branch, commit, date } or null for an official release.
function currentBuild() {
  try { const b = JSON.parse(readText(BUILD_FILE)); return b && /^[0-9a-f]{40}$/.test(b.commit) ? b : null; } catch { return null; }
}

/* ---- compare versions (semver: 1.2.3, 1.2.3-beta.1; a leading v is allowed) */
function parseVersion(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +(m[3] || 0), pre: m[4] ? m[4].split('.') : [] };
}
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  // A version without -beta is newer than the same one with -beta.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p == null) return -1;
    if (q == null) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// Response of GET /repos/:repo/releases → simple shape, newest first. Drafts are dropped; pre-releases only with beta.
function normalizeReleases(list, { beta = false } = {}) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => r && !r.draft && (beta || !r.prerelease) && parseVersion(r.tag_name))
    .map((r) => ({
      version: String(r.tag_name).replace(/^v/, ''), tag: String(r.tag_name), name: String(r.name || r.tag_name).slice(0, 200),
      notes: String(r.body || '').slice(0, 50000), url: /^https:\/\/github\.com\//.test(r.html_url || '') ? r.html_url : null,
      published: r.published_at || r.created_at || null, prerelease: !!r.prerelease,
    }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

function summarize(releases, current) {
  const newer = releases.filter((r) => compareVersions(r.version, current) > 0);
  return {
    current, latest: releases[0] || null, updateAvailable: newer.length > 0,
    newer, installed: releases.find((r) => compareVersions(r.version, current) === 0) || null,
    history: releases.filter((r) => compareVersions(r.version, current) <= 0).slice(0, 5),
  };
}

// Channel dev: the newest commit of the branch → the same shape as summarize(). dev = { sha, version, message, date, url, commits }.
function devSummary(dev, build, current) {
  const base = { current, build, latest: null, updateAvailable: false, newer: [], installed: null, history: [] };
  if (!dev || !dev.sha) return base;
  const short = dev.sha.slice(0, 7);
  const lines = (dev.commits && dev.commits.length ? dev.commits : [{ sha: dev.sha, message: dev.message }])
    .map((c) => `- ${String(c.message || '').split('\n')[0]} (${String(c.sha).slice(0, 7)})`);
  const latest = {
    version: `${dev.version || current}+dev.${short}`, tag: dev.sha, commit: dev.sha, pkgVersion: dev.version || null, dev: true,
    name: String(dev.message || '').split('\n')[0].slice(0, 200), notes: lines.join('\n'), url: dev.url || null, published: dev.date || null, prerelease: true,
  };
  const updateAvailable = !build || build.commit !== dev.sha;
  return { ...base, latest, updateAvailable, newer: updateAvailable ? [latest] : [], installed: updateAvailable ? null : latest };
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub is not responding.')));
    req.on('error', reject);
  });
}

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } }
function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

// What the interface shows. After an update (a different current version) the stored comparison is wrong: recalculate.
function status() {
  const s = load(), current = currentVersion(), cfg = settings.getSettings();
  const base = { repo: REPO, token: !!TOKEN, auto: cfg.updateCheck, channel: cfg.updateChannel, branch: DEV_BRANCH };
  if (cfg.updateChannel === 'dev') return { ...base, checked: s && s.devChecked, error: s && s.devError, ...devSummary(s && s.dev, currentBuild(), current) };
  if (!s) return { ...base, checked: null, error: null, ...summarize([], current), build: currentBuild() };
  return { ...base, checked: s.checked, error: s.error, ...summarize(normalizeReleases(s.raw, { beta: cfg.updateChannel === 'beta' }), current), build: currentBuild() };
}

function githubError(status, what) {
  if (status === 404) {
    return TOKEN ? `The repository ${REPO} was not found, or the token has no access to it.`
      : `The ${what} of ${REPO} can't be read. Is the repository private? Then set UPDATE_TOKEN in /etc/homebaseos/homebaseos.env.`;
  }
  if (status === 401) return 'The token in UPDATE_TOKEN doesn\'t work (anymore). Create a new token on GitHub.';
  if (status === 403 || status === 429) return 'GitHub is refusing temporarily (too many requests). Try again later.';
  return `GitHub gave an unexpected answer (${status}).`;
}

// Channel dev: the newest commit of DEV_BRANCH, its package.json version, and the commits since the installed build.
async function checkDev(headers) {
  const r = await getJson(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(DEV_BRANCH)}`, headers);
  if (r.status === 404 && TOKEN) throw new Error(`The branch ${DEV_BRANCH} doesn't exist in ${REPO}.`);
  if (r.status !== 200 || !r.data || !r.data.sha) throw new Error(githubError(r.status, 'branches'));
  const sha = r.data.sha, c = r.data.commit || {};
  const pkg = await getJson(`https://api.github.com/repos/${REPO}/contents/package.json?ref=${sha}`, { ...headers, Accept: 'application/vnd.github.raw+json' });
  const dev = { sha, version: pkg.status === 200 && pkg.data && pkg.data.version ? String(pkg.data.version) : null,
    message: String(c.message || '').slice(0, 2000), date: (c.committer && c.committer.date) || null, url: r.data.html_url || null, commits: [] };
  const build = currentBuild();
  if (build && build.commit !== sha) {
    const cmp = await getJson(`https://api.github.com/repos/${REPO}/compare/${build.commit}...${sha}`, headers).catch(() => null);
    if (cmp && cmp.status === 200 && Array.isArray(cmp.data.commits)) {
      dev.commits = cmp.data.commits.slice(-50).reverse().map((x) => ({ sha: x.sha, message: String((x.commit && x.commit.message) || '').slice(0, 300) }));
    }
  }
  return dev;
}

let running = null;
async function check() {
  if (running) return running;
  running = (async () => {
    const prev = load();
    const headers = { 'User-Agent': 'HomeBaseOS/' + currentVersion(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    if (settings.getSettings().updateChannel === 'dev') {
      let dev = prev && prev.dev, devError = null;
      try { dev = await checkDev(headers); } catch (e) { devError = /^(The|GitHub)/.test(e.message) ? e.message : `GitHub is not reachable: ${e.message}`; }
      save({ ...(prev || { raw: [] }), devChecked: new Date().toISOString(), devError, dev });
      return status();
    }
    let error = null, raw = prev ? prev.raw : [];
    try {
      const r = await getJson(`https://api.github.com/repos/${REPO}/releases?per_page=30`, headers);
      if (r.status === 200 && Array.isArray(r.data)) {
        // Only keep what we show (the full list is large).
        raw = r.data.map((x) => ({ tag_name: x.tag_name, name: x.name, body: x.body, html_url: x.html_url, published_at: x.published_at, created_at: x.created_at, draft: x.draft, prerelease: x.prerelease }));
      } else error = githubError(r.status, 'releases');
    } catch (e) { error = `GitHub is not reachable: ${e.message}`; }
    save({ ...(prev || {}), checked: new Date().toISOString(), error, raw });
    return status();
  })();
  try { return await running; } finally { running = null; }
}

function startSchedule(log = () => {}) {
  const tick = () => {
    const s = load();
    if (!settings.getSettings().updateCheck) return;
    if (s && s.checked && Date.now() - Date.parse(s.checked) < EVERY - 60000) return;
    check().then((r) => { if (r.updateAvailable) log(`HomeBaseOS ${r.latest.version} is available (now ${r.current}).`); }, () => {});
  };
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 3600 * 1000).unref(); // check every hour whether the 12 hours have passed
}

module.exports = { currentVersion, currentBuild, devSummary, DEV_BRANCH, parseVersion, compareVersions, normalizeReleases, summarize, status, check, startSchedule };
