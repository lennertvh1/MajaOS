'use strict';
/* Over deze server: hardware, besturingssysteem en de versies van de onderdelen. Alles mag ontbreken. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sys = require('./system');
const { hostTimezone } = require('./datetime');

const read = (f) => sys.readText(f).trim() || null;
const soft = (p) => p.then((v) => v, () => null);

function dmi() {
  const d = (k) => { const v = read('/sys/class/dmi/id/' + k); return v && !/^(To be filled|Default string|System Product Name|O\.E\.M\.)/i.test(v) ? v : null; };
  return { vendor: d('sys_vendor'), product: d('product_name'), boardVendor: d('board_vendor'), board: d('board_name'), bios: d('bios_version'), biosDate: d('bios_date') };
}

// ECC: de kernel meldt een geheugencontroller in /sys/devices/system/edac met het type per DIMM.
function ecc() {
  const base = '/sys/devices/system/edac/mc';
  try {
    const mcs = fs.readdirSync(base).filter((n) => /^mc\d+$/.test(n));
    if (!mcs.length) return null;
    const modes = new Set();
    for (const mc of mcs) {
      for (const d of fs.readdirSync(path.join(base, mc)).filter((n) => /^(dimm|rank)\d+$/.test(n))) {
        const m = read(path.join(base, mc, d, 'dimm_edac_mode')); if (m) modes.add(m);
      }
    }
    const errors = mcs.reduce((n, mc) => n + (Number(read(path.join(base, mc, 'ce_count'))) || 0), 0);
    return { active: [...modes].some((m) => !/none/i.test(m)), mode: [...modes].join(', ') || null, corrected: errors };
  } catch { return null; }
}

// Uitvoer van `virsh version`: bibliotheek en hypervisor.
function parseVirshVersion(text) {
  const lib = String(text).match(/Using library: libvirt ([\d.]+)/), hv = String(text).match(/Running hypervisor: (\w+) ([\d.]+)/);
  return { libvirt: lib ? lib[1] : null, hypervisor: hv ? hv[1] + ' ' + hv[2] : null };
}
// `lspci -mm`: regels met VGA- of 3D-controllers.
function parseLspciGpus(text) {
  return String(text).split('\n').filter((l) => /"(VGA compatible controller|3D controller|Display controller)"/.test(l)).map((l) => {
    const f = [...l.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    return [f[1], f[2]].filter(Boolean).join(' ').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  });
}

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|veth|br-|virbr|vnet)/.test(name)) continue;
    for (const a of list || []) if (!a.internal && (a.family === 'IPv4' || a.family === 4)) out.push({ interface: name, address: a.address });
  }
  return out;
}

async function about() {
  const pkg = JSON.parse(sys.readText(path.join(__dirname, '..', 'package.json')) || '{}');
  const [docker, compose, zfs, virsh, gpus, lspci] = await Promise.all([
    soft(sys.run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 })),
    soft(sys.run('docker', ['compose', 'version', '--short'], { timeout: 5000 })),
    soft(sys.run('zfs', ['version'], { timeout: 5000 })),
    soft(sys.run('virsh', ['-c', 'qemu:///system', 'version'], { timeout: 5000 })),
    sys.gpuStats(),
    soft(sys.run('lspci', ['-mm'], { timeout: 5000 })),
  ]);
  const v = virsh ? parseVirshVersion(virsh) : {};
  const mem = sys.memory();
  return {
    hostname: os.hostname(), os: sys.osName(), kernel: os.release(), arch: os.machine ? os.machine() : os.arch(),
    uptime: sys.uptime(), timezone: hostTimezone(),
    cpu: sys.cpuInfo(), memory: mem ? mem.total : os.totalmem(), ecc: ecc(), board: dmi(),
    gpus: gpus ? gpus.map((g) => g.name) : lspci ? parseLspciGpus(lspci) : [],
    addresses: addresses(),
    versions: {
      homebaseos: pkg.version || null, node: process.version.replace(/^v/, ''),
      docker: docker ? docker.trim() : null, compose: compose ? compose.trim().replace(/^v/, '') : null,
      zfs: zfs ? (zfs.match(/zfs-([\d.]+)/) || [])[1] || null : read('/sys/module/zfs/version'),
      libvirt: v.libvirt || null, hypervisor: v.hypervisor || null,
    },
  };
}

module.exports = { about, parseVirshVersion, parseLspciGpus };
