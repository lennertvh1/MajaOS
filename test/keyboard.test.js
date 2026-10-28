'use strict';
/* The keyboard of the server's screen (lib/keyboard.js) and the installer's choice. */
const test = require('node:test');
const assert = require('node:assert/strict');
const kb = require('../lib/keyboard');
const installer = require('../lib/installer');

const DEBIAN = 'XKBMODEL="pc105"\nXKBLAYOUT="be"\nXKBVARIANT=""\nXKBOPTIONS=""\n\nBACKSPACE="guess"\n';

test('reading and writing /etc/default/keyboard keeps the rest', () => {
  assert.equal(kb.parseKeyboard(DEBIAN), 'be');
  const us = kb.buildKeyboard('us:intl', DEBIAN);
  assert.match(us, /^XKBLAYOUT="us"$/m);
  assert.match(us, /^XKBVARIANT="intl"$/m);
  assert.match(us, /^BACKSPACE="guess"$/m);
  assert.equal(kb.parseKeyboard(us), 'us:intl');
  assert.equal(kb.parseKeyboard(kb.buildKeyboard('de', '')), 'de');
  assert.throws(() => kb.buildKeyboard('xx', DEBIAN), /Choose one of the keyboards/);
});

test('the installer: the keyboard follows the language unless one was chosen', () => {
  const disks = [{ name: 'sda', install: false }];
  assert.equal(installer.choose(disks, { name: 'sda', confirm: 'sda', language: 'nl' }).keyboard, 'us');
  assert.equal(installer.choose(disks, { name: 'sda', confirm: 'sda', language: 'fr' }).keyboard, 'fr');
  assert.equal(installer.choose(disks, { name: 'sda', confirm: 'sda', language: 'nl', keyboard: 'be' }).keyboard, 'be');
  assert.throws(() => installer.choose(disks, { name: 'sda', confirm: 'sda', language: 'nl', keyboard: 'be; rm' }));
  // Every interface language has a keyboard that is in the list.
  for (const lang of installer.LANGUAGES) assert.ok(kb.LAYOUTS.some((l) => l.id === kb.defaultFor(lang)), lang);
});
