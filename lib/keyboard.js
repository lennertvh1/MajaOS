'use strict';
/*
 * The keyboard of the server's own screen (the console over HDMI): /etc/default/keyboard (console-setup), applied with
 * keyboard-setup.service. The ISO installer uses the same list: the choice on its first screen holds in the installer
 * itself (cage, XKB_DEFAULT_LAYOUT) and becomes the installed system's keyboard.
 */
const fs = require('node:fs');
const { run, httpError } = require('./system');

const FILE = process.env.KEYBOARD_FILE || '/etc/default/keyboard';

// id = XKB layout, or layout:variant.
const LAYOUTS = [
  { id: 'us', name: 'English (US, QWERTY)' },
  { id: 'us:intl', name: 'US international (QWERTY)' },
  { id: 'gb', name: 'English (UK, QWERTY)' },
  { id: 'be', name: 'Belgian (AZERTY)' },
  { id: 'fr', name: 'French (AZERTY)' },
  { id: 'de', name: 'German (QWERTZ)' },
  { id: 'ch', name: 'Swiss (QWERTZ)' },
  { id: 'nl', name: 'Dutch (QWERTY)' },
  { id: 'es', name: 'Spanish (QWERTY)' },
  { id: 'pt', name: 'Portuguese (QWERTY)' },
  { id: 'it', name: 'Italian (QWERTY)' },
  { id: 'pl', name: 'Polish (QWERTY)' },
  { id: 'jp', name: 'Japanese' },
];
const IDS = new Set(LAYOUTS.map((l) => l.id));
// The usual keyboard for each interface language. Dutch: QWERTY, as in the Netherlands; Belgian AZERTY is one click away.
const DEFAULT_FOR = { en: 'us', nl: 'us', fr: 'fr', de: 'de', es: 'es', pt: 'pt', it: 'it', pl: 'pl', zh: 'us', ja: 'jp' };

const defaultFor = (lang) => DEFAULT_FOR[lang] || 'us';
function split(id) { const [layout, variant = ''] = String(id).split(':'); return { layout, variant }; }

function checkLayout(id) {
  if (!IDS.has(String(id || ''))) throw httpError('Choose one of the keyboards in the list.', 400);
  return String(id);
}

// XKBLAYOUT="be" and XKBVARIANT="" → "be"; a layout that isn't in our list stays as it is (shown as its own name).
function parseKeyboard(text) {
  const get = (k) => { const m = String(text || '').match(new RegExp('^' + k + '="?([^"\\n]*)"?', 'm')); return m ? m[1].trim() : ''; };
  const layout = get('XKBLAYOUT').split(',')[0], variant = get('XKBVARIANT').split(',')[0];
  if (!layout) return null;
  return variant ? `${layout}:${variant}` : layout;
}

// Only XKBLAYOUT and XKBVARIANT change; the model and options stay.
function buildKeyboard(id, oldText) {
  const { layout, variant } = split(checkLayout(id));
  let text = String(oldText || '');
  if (!/^XKBMODEL=/m.test(text)) text += 'XKBMODEL="pc105"\n';
  for (const [k, v] of [['XKBLAYOUT', layout], ['XKBVARIANT', variant]]) {
    const line = `${k}="${v}"`;
    text = new RegExp('^' + k + '=.*$', 'm').test(text) ? text.replace(new RegExp('^' + k + '=.*$', 'm'), line) : text.replace(/\n*$/, '\n') + line + '\n';
  }
  if (!/^XKBOPTIONS=/m.test(text)) text += 'XKBOPTIONS=""\n';
  return text.replace(/^\n+/, '');
}

function getKeyboard() {
  let text = null;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { /* console-setup not installed */ }
  return { layout: text == null ? null : parseKeyboard(text), layouts: LAYOUTS, editable: text != null };
}

async function setKeyboard(id) {
  let old;
  try { old = fs.readFileSync(FILE, 'utf8'); } catch { throw httpError('The keyboard of the server\'s screen can\'t be set here (console-setup is missing).', 409); }
  fs.writeFileSync(FILE, buildKeyboard(id, old));
  // keyboard-setup loads it into the console right away; a login prompt that is already open keeps working.
  await run('systemctl', ['restart', 'keyboard-setup.service'], { timeout: 20000 }).catch(() => {});
  return getKeyboard();
}

module.exports = { LAYOUTS, DEFAULT_FOR, defaultFor, split, checkLayout, parseKeyboard, buildKeyboard, getKeyboard, setKeyboard };
