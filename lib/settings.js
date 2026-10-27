'use strict';
/* General settings of HomeBaseOS (for all devices): the language, the time format, the web port, the terminal and SSH. */
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
// ssh: OpenSSH on the server. Off until Settings → Security turns it on.
// mcp: the connector at /mcp. On until Settings → MCP turns it off.
// updateCheck: look for new versions of HomeBaseOS; updateChannel: stable, beta (also pre-releases) or dev (the dev branch, for test servers).
const EXPERIENCE = ['beginner', 'expert']; // UI detail: guided/simple, or full options
const DEFAULTS = { language: 'en', clock: 'auto', experience: 'beginner', terminal: true, terminalPassword: true, ssh: false, mcp: true, updateCheck: true, updateChannel: 'stable' };

function getSettings() {
  try {
    const cur = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    if (cur.experience === 'standard') cur.experience = 'beginner'; // older installs
    return cur;
  } catch { return { ...DEFAULTS }; }
}

// checkPassword(pw) → true/false. Making things less strict (terminal on, SSH on, or no longer asking the password) requires the password.
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
  if (body.experience != null) {
    if (!EXPERIENCE.includes(String(body.experience))) throw httpError('Choose beginner or expert.', 400);
    cur.experience = String(body.experience);
  }
  if (body.updateCheck != null) cur.updateCheck = !!body.updateCheck;
  if (body.updateChannel != null) {
    if (!['stable', 'beta', 'dev'].includes(String(body.updateChannel))) throw httpError('Choose stable, beta or development.', 400);
    cur.updateChannel = String(body.updateChannel);
  }
  const next = {
    terminal: body.terminal == null ? cur.terminal : !!body.terminal,
    terminalPassword: body.terminalPassword == null ? cur.terminalPassword : !!body.terminalPassword,
    ssh: body.ssh == null ? cur.ssh : !!body.ssh,
    mcp: body.mcp == null ? cur.mcp !== false : !!body.mcp,
  };
  const looser = (next.terminal && !cur.terminal) || (!next.terminalPassword && cur.terminalPassword) || (next.ssh && !cur.ssh) || (next.mcp && cur.mcp === false);
  if (looser && !checkPassword(String(body.password || ''))) throw httpError('Type your password to make security less strict.', 403);
  Object.assign(cur, next);
  if (body.port != null) {
    const n = Number(body.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw httpError('Choose a port from 1 to 65535.', 400);
    cur.port = n;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cur, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  return cur;
}

// The port in Settings wins. Otherwise PORT in the environment (older installs use 8080). Otherwise 80, like a normal website.
// The demo on a workstation stays on 8080: port 80 is not available there without root.
function listenPort() {
  const chosen = Number(getSettings().port);
  if (Number.isInteger(chosen) && chosen >= 1 && chosen <= 65535) return chosen;
  const fromEnv = Number(process.env.PORT);
  if (process.env.PORT && Number.isInteger(fromEnv) && fromEnv >= 1 && fromEnv <= 65535) return fromEnv;
  return process.env.DEMO === '1' ? 8080 : 80;
}

module.exports = { getSettings, saveSettings, listenPort, LANGUAGES, EXPERIENCE };
