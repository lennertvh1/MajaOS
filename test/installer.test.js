'use strict';
/* The installer's disk list and the preseed it writes only after a disk name is confirmed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseDisks, choose, buildPreseed, LANGUAGES } = require('../lib/installer');

const lsblk = {
  blockdevices: [
    { name: 'sda', type: 'disk', size: 512 * 1024 ** 3, model: 'Samsung SSD 870', rota: false, tran: 'sata', children: [
      { name: 'sda1', mountpoints: [null] },
    ] },
    { name: 'sdb', type: 'disk', size: '2T', model: 'WDC WD20EFRX', rota: '1', tran: 'sata' },
    { name: 'sdc', type: 'disk', size: 32 * 1024 ** 3, model: 'Ultra Fit', rota: 0, tran: 'usb', children: [
      { name: 'sdc1', mountpoints: ['/run/live/medium'] },
    ] },
    { name: 'nvme0n1', type: 'disk', size: 1000 * 1024 ** 3, model: 'CT1000P3', rota: false, tran: 'nvme' },
    { name: '../etc', type: 'disk', size: 1, model: 'bad' },
  ],
};

test('parseDisks keeps real disks and marks the stick the installer booted from', () => {
  const disks = parseDisks(lsblk, { boot: 'sdc1' });
  assert.deepEqual(disks.map((d) => d.name), ['sda', 'sdb', 'sdc', 'nvme0n1']);
  assert.equal(disks[0].rotational, false);
  assert.equal(disks[0].size, 512 * 1024 ** 3);
  assert.equal(disks[1].rotational, true);
  assert.equal(disks[1].size, 2 * 1024 ** 4);
  assert.equal(disks.find((d) => d.name === 'sdc').install, true);
  assert.equal(disks.find((d) => d.name === 'sda').install, false);
});

test('a disk is only accepted when its own name is typed, and never the installer stick', () => {
  const disks = parseDisks(lsblk, { boot: 'sdc' });
  assert.equal(choose(disks, { name: 'sda', confirm: 'sda', language: 'fr' }).language, 'fr');
  assert.throws(() => choose(disks, { name: 'sda', confirm: 'sdb', language: 'en' }), /Type the disk name/);
  assert.throws(() => choose(disks, { name: 'sdc', confirm: 'sdc', language: 'en' }), /installer/);
  assert.throws(() => choose(disks, { name: 'nope', confirm: 'nope', language: 'en' }), /Choose a disk/);
  assert.throws(() => choose(disks, { name: 'sda', confirm: 'sda', language: 'xx' }), /Unknown language/);
});

test('the generated preseed names one disk and the chosen locale, and still has no password', () => {
  const base = fs.readFileSync(path.join(__dirname, '..', 'iso', 'preseed.cfg'), 'utf8');
  const built = buildPreseed(base, { disk: 'nvme0n1', language: 'de' });
  assert.match(built.text, /^d-i partman-auto\/disk string \/dev\/nvme0n1$/m);
  assert.match(built.text, /^d-i partman\/confirm boolean true$/m);
  assert.match(built.text, /^d-i partman\/confirm_nooverwrite boolean true$/m);
  assert.match(built.text, /^d-i debian-installer\/locale string de_DE\.UTF-8$/m);
  assert.match(built.text, /^d-i debian-installer\/language string de$/m);
  assert.equal(built.cmdline, 'homebaseos.lang=de');
  assert.doesNotMatch(built.text, /passwd\/user-password /);
  assert.match(base, /en_US\.UTF-8/); // the file in git is unchanged
  assert.doesNotMatch(base, /partman-auto\/disk/);
  assert.throws(() => buildPreseed(base, { disk: '../sda', language: 'en' }), /Choose a disk/);
});

test('the language menu and the dictionaries offer the same languages', () => {
  const listed = [...fs.readFileSync(path.join(__dirname, '..', 'public', 'lang', 'languages.js'), 'utf8').matchAll(/^\s+([a-z]{2}):\s*\{/gm)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), [...LANGUAGES].sort());
  for (const code of LANGUAGES) {
    if (code === 'en') continue;
    const text = fs.readFileSync(path.join(__dirname, '..', 'public', 'lang', code + '.js'), 'utf8');
    assert.match(text, new RegExp('TB_LANG\\.' + code));
    assert.match(text, /Choose your language/);
  }
});
