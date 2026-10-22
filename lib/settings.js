'use strict';
/* Algemene instellingen van HomeBaseOS (voor alle toestellen): de taal, de tijdnotatie en de beveiliging van de terminal. */
const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'settings.json');
const LANGUAGES = ['nl', 'en'];
const CLOCKS = ['auto', '24', '12']; // tijdnotatie: volgens de taal, 24 uur of 12 uur (am/pm)
// terminal: een root-shell op de server in de browser; terminalPassword: daarvoor het wachtwoord opnieuw vragen.
// updateCheck: zelf zoeken naar nieuwe versies van HomeBaseOS; updateChannel: stable of beta (ook testversies).
const DEFAULTS = { language: 'nl', clock: 'auto', terminal: true, terminalPassword: true, updateCheck: true, updateChannel: 'stable' };

function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}

// checkPassword(pw) → true/false. Minder streng maken (terminal aan, of geen wachtwoord meer vragen) vraagt het wachtwoord.
function saveSettings(body, { checkPassword = () => true } = {}) {
  const cur = getSettings();
  if (body.language != null) {
    if (!LANGUAGES.includes(body.language)) throw httpError('Onbekende taal.', 400);
    cur.language = body.language;
  }
  if (body.clock != null) {
    if (!CLOCKS.includes(String(body.clock))) throw httpError('Kies een tijdnotatie: automatisch, 24 uur of 12 uur.', 400);
    cur.clock = String(body.clock);
  }
  if (body.updateCheck != null) cur.updateCheck = !!body.updateCheck;
  if (body.updateChannel != null) {
    if (!['stable', 'beta'].includes(String(body.updateChannel))) throw httpError('Kies stabiel of bèta.', 400);
    cur.updateChannel = String(body.updateChannel);
  }
  const next = { terminal: body.terminal == null ? cur.terminal : !!body.terminal, terminalPassword: body.terminalPassword == null ? cur.terminalPassword : !!body.terminalPassword };
  const looser = (next.terminal && !cur.terminal) || (!next.terminalPassword && cur.terminalPassword);
  if (looser && !checkPassword(String(body.password || ''))) throw httpError('Typ je wachtwoord om de beveiliging minder streng te maken.', 403);
  Object.assign(cur, next);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cur, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  return cur;
}

module.exports = { getSettings, saveSettings, LANGUAGES };
