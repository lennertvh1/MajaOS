'use strict';
/* Read-only device inventory for Settings > Hardware. Kernel drivers come from sysfs. */
const fs = require('node:fs');
const path = require('node:path');
const vmhw = require('./vmhw');
const { readText } = require('./system');

function linkName(file) { try { return path.basename(fs.readlinkSync(file)); } catch { return null; } }

function usbDrivers(devices, base = '/sys/bus/usb/devices') {
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return devices.map((d) => ({ ...d, drivers: [] })); }
  const matches = dirs.filter((name) => /^\d+-[\d.]+$/.test(name)).map((name) => {
    const dir = path.join(base, name);
    return { name, bus: Number(readText(path.join(dir, 'busnum'))), device: Number(readText(path.join(dir, 'devnum'))) };
  });
  return devices.map((d) => {
    const found = matches.find((m) => m.bus === d.bus && m.device === d.device);
    const drivers = new Set();
    if (found) {
      for (const name of dirs.filter((n) => n.startsWith(found.name + ':'))) {
        const driver = linkName(path.join(base, name, 'driver'));
        if (driver) drivers.add(driver);
      }
    }
    return { ...d, drivers: [...drivers].sort() };
  });
}

async function inventory() {
  const [pci, usb] = await Promise.all([vmhw.pciDevices({ all: true }), vmhw.usbDevices({ includeHubs: true })]);
  return { pci: pci.pci, usb: usbDrivers(usb), iommu: pci.iommu };
}

module.exports = { inventory, usbDrivers };
