'use strict';
/* General settings of HomeBaseOS (for all devices): the language, the time format and the security of the terminal. */
const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'settings.json');
// The languages in public/lang/languages.js (English is built in).
const LANGUAGES = (() => {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', 'public', 'lang', 'languages.js'), 'utf8');
    return [...new Set(['en', ...[...text.matchAll(/^\s+([a-z]{2}(?:-[A-Z]{2})?):\s*\{/gm)].map((m) => m[1])])];
  } catch { return ['en']; }
})();
const CLOCKS = ['auto', '24', '12']; // time format: following the language, 24-hour or 12-hour (am/pm)
// terminal: a root shell on the server in the browser; terminalPassword: ask for the password again for it.
// updateCheck: look for new versions of HomeBaseOS; updateChannel: stable, beta (also pre-releases) or dev (the dev branch, for test servers).
const DEFAULTS = { language: 'en', clock: 'auto', terminal: true, terminalPassword: true, updateCheck: true, updateChannel: 'stable' };

function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}

// checkPassword(pw) → true/false. Making things less strict (terminal on, or no longer asking the password) requires the password.
function saveSettings(body, { checkPassword = () => true } = {}) {
  const cur = getSettings();
  if (body.language != null) {
    if (!LANGUAGES.includes(body.language)) throw httpError('Unknown language.', 400);
    cur.language = body.language;
  }
  if (body.clock != null) {
    if (!CLOCKS.includes(String(body.clock))) throw httpError('Choose a time format: automatic, 24-hour or 12-hour.', 400);
    cur.clock = String(body.clock);
  }
  if (body.updateCheck != null) cur.updateCheck = !!body.updateCheck;
  if (body.updateChannel != null) {
    if (!['stable', 'beta', 'dev'].includes(String(body.updateChannel))) throw httpError('Choose stable, beta or development.', 400);
    cur.updateChannel = String(body.updateChannel);
  }
  const next = { terminal: body.terminal == null ? cur.terminal : !!body.terminal, terminalPassword: body.terminalPassword == null ? cur.terminalPassword : !!body.terminalPassword };
  const looser = (next.terminal && !cur.terminal) || (!next.terminalPassword && cur.terminalPassword);
  if (looser && !checkPassword(String(body.password || ''))) throw httpError('Type your password to make security less strict.', 403);
  Object.assign(cur, next);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cur, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  return cur;
}

module.exports = { getSettings, saveSettings, LANGUAGES };
