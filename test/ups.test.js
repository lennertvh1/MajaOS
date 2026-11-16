'use strict';
/* UPS through NUT: parsing upsc and nut-scanner, the files in /etc/nut, the checks and shutting down early. */
const test = require('node:test');
const assert = require('node:assert/strict');
const ups = require('../lib/ups');

const UPSC = `battery.charge: 87
battery.charge.low: 10
battery.runtime: 1420
battery.voltage: 13.4
device.mfr: American Power Conversion
device.model: Back-UPS ES 700G
device.serial: 5B1234X56789
driver.name: usbhid-ups
input.voltage: 232.0
ups.load: 18
ups.realpower.nominal: 405
ups.status: OB DISCHRG
`;

const SCANNER = `[nutdev1]
\tdriver = "usbhid-ups"
\tport = "auto"
\tvendorid = "051D"
\tproductid = "0002"
\tproduct = "Back-UPS ES 700G FW:871.O3 .I USB FW:O3"
\tserial = "5B1234X56789"
\tvendor = "American Power Conversion"
\tbus = "001"
`;

test('upsc: values and the status flags', () => {
  const vars = ups.parseUpsc(UPSC);
  assert.equal(vars['device.model'], 'Back-UPS ES 700G');
  const st = ups.readStatus(vars);
  assert.equal(st.onBattery, true);
  assert.equal(st.online, false);
  assert.equal(st.charge, 87);
  assert.equal(st.runtime, 1420);
  assert.equal(st.load, 18);
  assert.equal(st.power, 73); // 405 W × 18 %
  assert.equal(st.model, 'American Power Conversion Back-UPS ES 700G');
  assert.equal(ups.readStatus(ups.parseUpsc('ups.status: OL CHRG LB\n')).lowBattery, true);
  assert.equal(ups.readStatus({}).charge, null);
});

test('upsc: a UPS that reports load 0 but the apparent power of its outlets (Eaton Ellipse ECO)', () => {
  const st = ups.readStatus(ups.parseUpsc('ups.load: 0\nups.realpower: 0\nups.power.nominal: 650\noutlet.power: 25\nups.status: OL\n'));
  assert.equal(st.load, 4); // 25 VA of 650 VA
  assert.equal(st.power, 23); // estimated from 25 VA, not 0 W
  assert.equal(st.powerEstimated, true);
  assert.equal(st.va, 25);
  // Really nothing connected: 0 stays 0.
  const idle = ups.readStatus(ups.parseUpsc('ups.load: 0\nups.realpower: 0\nups.status: OL\n'));
  assert.equal(idle.load, 0);
  assert.equal(idle.power, 0);
  // Real watts win.
  assert.equal(ups.readStatus(ups.parseUpsc('ups.load: 12\nups.realpower: 48\noutlet.power: 60\n')).power, 48);
});

test('upsc -l and nut-scanner', () => {
  assert.deepEqual(ups.parseUpsList('ups\nrack-ups\n\nInit SSL without certificate database\n'), ['ups', 'rack-ups']);
  const [d] = ups.parseScanner(SCANNER);
  assert.equal(d.driver, 'usbhid-ups');
  assert.equal(d.vendorid, '051D');
  assert.equal(d.product, 'Back-UPS ES 700G FW:871.O3 .I USB FW:O3');
  assert.deepEqual(ups.parseScanner(''), []);
});

test('the files for a UPS on this server, shared with the network', () => {
  const f = ups.buildFiles({ mode: 'local', name: 'ups', driver: 'usbhid-ups', port: 'auto', extra: { vendorid: '051D', productid: '0002' },
    desc: 'Rack', share: true, monPassword: 'mon-secret', sharePassword: 'share-secret' });
  assert.match(f['nut.conf'], /^MODE=netserver$/m);
  assert.match(f['ups.conf'], /\[ups\]\n\tdriver = "usbhid-ups"\n\tport = "auto"\n\tdesc = "Rack"\n\tvendorid = "051D"/);
  assert.match(f['upsd.conf'], /LISTEN 0\.0\.0\.0 3493/);
  assert.match(f['upsd.users'], /\[majaos\]\n\tpassword = "mon-secret"\n\tupsmon primary/);
  assert.match(f['upsd.users'], /\[monuser\]\n\tpassword = "share-secret"\n\tupsmon secondary/);
  assert.match(f['upsmon.conf'], /^MONITOR ups@localhost 1 majaos "mon-secret" primary$/m);
  assert.match(f['upsmon.conf'], /SHUTDOWNCMD "\/sbin\/shutdown -h \+0"/);
  const alone = ups.buildFiles({ mode: 'local', name: 'ups', driver: 'usbhid-ups', port: 'auto', share: false, monPassword: 'x', sharePassword: 'y' });
  assert.match(alone['nut.conf'], /^MODE=standalone$/m);
  assert.doesNotMatch(alone['upsd.conf'], /0\.0\.0\.0/);
  assert.doesNotMatch(alone['upsd.users'], /monuser/);
});

test('the files for a UPS on another NUT server, and off', () => {
  const f = ups.buildFiles({ mode: 'remote', host: '192.168.1.20', hostPort: 3493, upsName: 'ups', user: 'monuser', password: 'secret' });
  assert.match(f['nut.conf'], /^MODE=netclient$/m);
  assert.match(f['upsmon.conf'], /^MONITOR ups@192\.168\.1\.20:3493 1 monuser "secret" secondary$/m);
  assert.equal(f['ups.conf'], undefined);
  assert.match(ups.buildFiles({ mode: 'remote', host: 'fd00::5', hostPort: 3493, upsName: 'ups', user: 'u', password: 'p' })['upsmon.conf'], /ups@\[fd00::5\]:3493/);
  assert.deepEqual(Object.keys(ups.buildFiles({ mode: 'off' })), ['nut.conf']);
});

test('checking the settings', () => {
  const cur = { mode: 'off', name: 'ups', events: [] };
  const local = ups.validate({ mode: 'local', driver: 'usbhid-ups', port: 'auto', extra: { vendorid: '051D' }, minutes: 5 }, cur);
  assert.equal(local.minutes, 5);
  assert.ok(local.monPassword && local.sharePassword);
  assert.throws(() => ups.validate({ mode: 'local', driver: 'usb hid' }, cur), /driver/);
  assert.throws(() => ups.validate({ mode: 'local', driver: 'usbhid-ups', port: 'auto"; rm' }, cur), /port/);
  assert.throws(() => ups.validate({ mode: 'local', driver: 'usbhid-ups', extra: { vendorid: 'zz' } }, cur), /USB id/);
  assert.throws(() => ups.validate({ mode: 'local', driver: 'usbhid-ups', minutes: 500 }, cur), /minutes/);
  const remote = ups.validate({ mode: 'remote', host: 'nas.local', upsName: 'ups', user: 'monuser', password: 'secret' }, cur);
  assert.equal(remote.hostPort, 3493);
  // An empty password keeps the saved one.
  assert.equal(ups.validate({ mode: 'remote', host: 'nas.local', upsName: 'ups', user: 'monuser', password: '' }, remote).password, 'secret');
  assert.throws(() => ups.validate({ mode: 'remote', host: 'nas.local', upsName: 'ups', user: 'monuser', password: 'with "quote' }, cur), /password/);
  assert.throws(() => ups.validate({ mode: 'remote', host: 'nas local', upsName: 'ups', user: 'm', password: 'p' }, cur), /address/);
  assert.throws(() => ups.validate({ mode: 'somewhere' }, cur), /where/);
});

test('shutting down early: after minutes on battery or at a percentage, once', () => {
  const cfg = { minutes: 5, percent: 0 };
  const onBattery = { onBattery: true, charge: 80 };
  let d = ups.decide(0, onBattery, cfg);
  assert.equal(d.shutdown, null);
  assert.equal(d.countdown, 5 * 60000);
  d = ups.decide(4 * 60000, onBattery, cfg, d.state);
  assert.equal(d.shutdown, null);
  d = ups.decide(5 * 60000, onBattery, cfg, d.state);
  assert.equal(d.shutdown, 'minutes');
  assert.equal(ups.decide(6 * 60000, onBattery, cfg, d.state).shutdown, null); // only once
  // The power came back: the count starts over.
  d = ups.decide(7 * 60000, { onBattery: false, charge: 70 }, cfg, d.state);
  assert.deepEqual(d.state, { since: null, done: false });
  // A percentage.
  const p = ups.decide(0, { onBattery: true, charge: 30 }, { minutes: 0, percent: 30 });
  assert.equal(p.shutdown, 'percent');
  assert.equal(ups.decide(0, { onBattery: true, charge: 31 }, { minutes: 0, percent: 30 }).shutdown, null);
  // Nothing set: NUT's own low battery decides.
  assert.equal(ups.decide(99 * 60000, { onBattery: true, charge: 5 }, { minutes: 0, percent: 0 }, { since: 1 }).shutdown, null);
});

test('lsusb: a UPS of a known maker, or with UPS in its name; not the other devices', () => {
  const list = ups.parseLsusb(`Bus 002 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub
Bus 001 Device 004: ID 0463:ffff MGE UPS Systems UPS
Bus 001 Device 005: ID 051d:0002 American Power Conversion Uninterruptible Power Supply
Bus 001 Device 006: ID 046d:c52b Logitech, Inc. Unifying Receiver
Bus 001 Device 007: ID 1234:5678 Some Brand Mini UPS
`);
  assert.deepEqual(list.map((d) => [d.vendor, d.driver, d.vendorid, d.productid]), [
    ['Eaton', 'usbhid-ups', '0463', 'FFFF'],
    ['APC', 'usbhid-ups', '051D', '0002'],
    ['', 'usbhid-ups', '1234', '5678'],
  ]);
  assert.equal(list[0].source, 'lsusb');
  // The id it suggests passes the checks.
  assert.equal(ups.validate({ mode: 'local', driver: 'usbhid-ups', port: 'auto', extra: { vendorid: list[0].vendorid, productid: list[0].productid } }, { mode: 'off', events: [] }).extra.vendorid, '0463');
});

test('lsusb with all: every USB device except the root hubs, for choosing a UPS with an unknown id', () => {
  const all = ups.parseLsusb(`Bus 002 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub
Bus 001 Device 006: ID 046d:c52b Logitech, Inc. Unifying Receiver
Bus 001 Device 008: ID 0627:0001 Adomax Technology Co., Ltd QEMU USB Tablet
`, true);
  assert.deepEqual(all.map((d) => d.vendorid + ':' + d.productid), ['046D:C52B', '0627:0001']);
  assert.deepEqual(ups.parseLsusb('Bus 002 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub\n', true), []);
});
