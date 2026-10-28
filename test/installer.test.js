'use strict';
/* The installer's disk list and the preseed it writes only after a disk name is confirmed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const installer = require('../lib/installer');
const { parseDisks, choose, buildPreseed, LANGUAGES } = installer;

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
  assert.match(built.text, /^d-i grub-installer\/bootdev string \/dev\/nvme0n1$/m);
  assert.equal(built.cmdline, 'majaos.lang=de');
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

test('network step: physical cards, the one with the default route first', () => {
  const addrs = [
    { ifname: 'lo', flags: ['LOOPBACK', 'UP', 'LOWER_UP'], address: '00:00:00:00:00:00', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8 }] },
    { ifname: 'enp6s0', flags: ['NO-CARRIER', 'BROADCAST', 'UP'], address: 'a8:a1:59:3c:72:11', addr_info: [] },
    { ifname: 'enp5s0', flags: ['BROADCAST', 'UP', 'LOWER_UP'], address: 'a8:a1:59:3c:72:10',
      addr_info: [{ family: 'inet', local: '192.168.1.57', prefixlen: 24, dynamic: true }, { family: 'inet6', local: 'fe80::1', prefixlen: 64 }] },
  ];
  const routes = [{ dst: 'default', gateway: '192.168.1.1', dev: 'enp5s0' }, { dst: '192.168.1.0/24', dev: 'enp5s0' }];
  const cards = installer.parseCards(addrs, routes, ['enp5s0', 'enp6s0'], { enp5s0: 2500, enp6s0: -1 });
  assert.deepEqual(cards.map((c) => c.name), ['enp5s0', 'enp6s0']);
  assert.deepEqual(cards[0], { name: 'enp5s0', mac: 'a8:a1:59:3c:72:10', connected: true, address: '192.168.1.57/24', dynamic: true, gateway: '192.168.1.1', speed: 2500 });
  assert.equal(cards[1].connected, false);
  assert.equal(cards[1].speed, null);
});

test('the installed system gets the chosen network in the ifupdown file MajaOS manages', () => {
  const network = require('../lib/network');
  const cfg = network.validate({ interface: 'enp5s0', mode: 'static', address: '192.168.1.10/24', gateway: '192.168.1.1', dns: '1.1.1.1 9.9.9.9' }, ['enp5s0']);
  const text = network.buildInterfaces(cfg, '');
  assert.match(text, /auto enp5s0\niface enp5s0 inet static\n {4}address 192\.168\.1\.10\/24\n {4}gateway 192\.168\.1\.1\n {4}dns-nameservers 1\.1\.1\.1 9\.9\.9\.9/);
  assert.deepEqual(network.configFromInterfaces(network.parseInterfaces(text), ['enp5s0']).address, '192.168.1.10/24');
  assert.throws(() => network.validate({ interface: 'wlan0', mode: 'dhcp' }, ['enp5s0']));
});
