'use strict';
/* Algemene instellingen van Thuisbasis (voor alle toestellen): nu de taal. */
const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/thuisbasis';
const FILE = path.join(DATA_DIR, 'settings.json');
const LANGUAGES = ['nl', 'en'];
const DEFAULTS = { language: 'nl' };

function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}

function saveSettings(body) {
  const cur = getSettings();
  if (body.language != null) {
    if (!LANGUAGES.includes(body.language)) throw httpError('Onbekende taal.', 400);
    cur.language = body.language;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cur, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  return cur;
}

module.exports = { getSettings, saveSettings, LANGUAGES };
