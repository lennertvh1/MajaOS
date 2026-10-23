'use strict';
/*
 * Welcome wizard after installation: shows after the first sign-in until it is finished or skipped.
 * DATA_DIR/onboarding.json: { done, finished, skipped }.
 */
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'onboarding.json');

function getState() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { done: !!j.done, finished: j.finished || null, skipped: !!j.skipped }; }
  catch { return { done: false, finished: null, skipped: false }; }
}
function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  return state;
}
function finish({ skipped = false } = {}) { return save({ done: true, finished: new Date().toISOString(), skipped: !!skipped }); }
function reset() { return save({ done: false, finished: null, skipped: false }); }

module.exports = { getState, finish, reset };
