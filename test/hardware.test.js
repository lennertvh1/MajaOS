'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { usbDrivers } = require('../lib/hardware');

test('USB interfaces expose the kernel drivers bound to their device', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maja-hardware-'));
  try {
    const dir = path.join(base, '1-2');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'busnum'), '1\n');
    fs.writeFileSync(path.join(dir, 'devnum'), '4\n');
    fs.mkdirSync(path.join(base, '1-2:1.0'));
    fs.symlinkSync('/sys/bus/usb/drivers/cp210x', path.join(base, '1-2:1.0', 'driver'));
    const devices = [{ bus: 1, device: 4, name: 'Zigbee dongle' }, { bus: 2, device: 1, name: 'Other' }];
    assert.deepEqual(usbDrivers(devices, base).map((d) => d.drivers), [['cp210x'], []]);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
