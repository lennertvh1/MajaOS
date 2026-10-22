'use strict';
/*
 * Hardware van een VM in de domein-XML: netwerkkaarten, schijven, cd-rom, opstartvolgorde,
 * doorgegeven USB- en PCI-apparaten en vaste CPU-kernen (pinning). Plus wat de server zelf aan hardware heeft.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, readText, httpError } = require('./system');
const X = require('./xml');

const MODELS = ['virtio', 'e1000e', 'rtl8139'];
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const hex = (v, w) => (v == null ? null : Number.parseInt(String(v).replace(/^0x/i, ''), 16).toString(16).padStart(w, '0'));

/* ---- lezen */

function usbKey(vendor, product) { return 'usb:' + hex(vendor, 4) + ':' + hex(product, 4); }
function pciAddr(a) { return hex(X.attr(a, 'domain') || '0', 4) + ':' + hex(X.attr(a, 'bus'), 2) + ':' + hex(X.attr(a, 'slot'), 2) + '.' + Number.parseInt(String(X.attr(a, 'function') || '0').replace(/^0x/i, ''), 16); }
function hostdevKey(el) {
  const src = X.child(el, 'source'); if (!src) return null;
  if (X.attr(el, 'type') === 'usb') { const v = X.child(src, 'vendor'), p = X.child(src, 'product'); return v && p ? usbKey(X.attr(v, 'id'), X.attr(p, 'id')) : null; }
  if (X.attr(el, 'type') === 'pci') { const a = X.child(src, 'address'); return a ? 'pci:' + pciAddr(a) : null; }
  return null;
}

function parseHardware(xml) {
  const dom = X.parseXml(xml);
  const dev = X.child(dom, 'devices') || X.E('devices');
  const nics = X.kids(dev, 'interface').map((e) => {
    const type = X.attr(e, 'type'), src = X.child(e, 'source');
    return { mac: (X.attr(X.child(e, 'mac'), 'address') || '').toLowerCase() || null, type,
      source: src ? X.attr(src, type === 'bridge' ? 'bridge' : type === 'network' ? 'network' : 'dev') : null,
      model: X.attr(X.child(e, 'model'), 'type') || null, locked: type !== 'network' && type !== 'bridge' };
  });
  const disk = (e) => {
    const src = X.child(e, 'source'), tgt = X.child(e, 'target'), drv = X.child(e, 'driver');
    return { target: X.attr(tgt, 'dev'), bus: X.attr(tgt, 'bus'), source: src ? X.attr(src, 'file') || X.attr(src, 'dev') : null, format: X.attr(drv, 'type') };
  };
  const disks = X.kids(dev, 'disk').filter((e) => (X.attr(e, 'device') || 'disk') === 'disk').map(disk);
  const cdroms = X.kids(dev, 'disk').filter((e) => X.attr(e, 'device') === 'cdrom').map(disk);
  // Opstarten: per apparaat (<boot order>) of in <os> (<boot dev>).
  const ordered = X.kids(dev).filter((e) => X.child(e, 'boot')).sort((a, b) => Number(X.attr(X.child(a, 'boot'), 'order')) - Number(X.attr(X.child(b, 'boot'), 'order')));
  const osBoot = X.findAll(dom, 'os/boot').map((b) => X.attr(b, 'dev'));
  const first = ordered[0] ? (X.attr(ordered[0], 'device') === 'cdrom' ? 'cdrom' : 'disk') : osBoot[0] === 'cdrom' ? 'cdrom' : 'disk';
  const hostdevs = X.kids(dev, 'hostdev').filter((e) => X.attr(e, 'mode') === 'subsystem').map(hostdevKey).filter(Boolean);
  const pins = X.findAll(dom, 'cputune/vcpupin').map((p) => Number(X.attr(p, 'cpuset'))).filter((n) => Number.isInteger(n));
  // Klembord delen: het qemu-vdagent-kanaal (de VM heeft dan spice-vdagent nodig).
  const clipboard = X.kids(dev, 'channel').some((c) => X.attr(c, 'type') === 'qemu-vdagent');
  return { nics, disks, cdroms, boot: first, hostdevs, cpuPins: pins, clipboard };
}

/* ---- schrijven: alleen wat in `change` staat, de rest van de XML blijft ongewijzigd */

const randomMac = () => '52:54:00:' + [0, 0, 0].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':');
function nextTarget(used, bus) {
  const pre = bus === 'virtio' ? 'vd' : 'sd';
  for (let i = 0; i < 26; i++) { const t = pre + String.fromCharCode(97 + i); if (!used.has(t)) { used.add(t); return t; } }
  throw httpError('Er kunnen geen schijven meer bij.', 400);
}

function applyHardware(xml, change) {
  const dom = X.parseXml(xml);
  let dev = X.child(dom, 'devices');
  if (!dev) dev = X.append(dom, X.E('devices'));
  const allDisks = () => X.kids(dev, 'disk');
  const targets = () => new Set(allDisks().map((e) => X.attr(X.child(e, 'target'), 'dev')).filter(Boolean));

  if (change.nics) {
    const cur = X.kids(dev, 'interface');
    const byMac = new Map(cur.map((e) => [(X.attr(X.child(e, 'mac'), 'address') || '').toLowerCase(), e]));
    const keep = new Set();
    let anchor = cur[cur.length - 1] || allDisks().slice(-1)[0] || null;
    for (const n of change.nics) {
      let el = n.id ? byMac.get(n.id) : null;
      if (n.locked) { if (el) { keep.add(el); anchor = el; } continue; }
      const src = X.E('source', n.type === 'bridge' ? { bridge: n.source } : { network: n.source });
      if (!el) {
        el = X.E('interface', { type: n.type }, [X.E('mac', { address: n.mac || randomMac() }), src, X.E('model', { type: n.model })]);
        X.append(dev, el, anchor);
      } else {
        X.setAttr(el, 'type', n.type);
        const mac = X.child(el, 'mac'); if (mac && n.mac) X.setAttr(mac, 'address', n.mac);
        const old = X.child(el, 'source');
        if (old) { old.attrs = src.attrs; } else X.append(el, src, mac);
        const model = X.child(el, 'model'); if (model) X.setAttr(model, 'type', n.model); else X.append(el, X.E('model', { type: n.model }));
      }
      keep.add(el); anchor = el;
    }
    cur.filter((e) => !keep.has(e)).forEach((e) => X.remove(dev, e));
  }

  if (change.removeDisks && change.removeDisks.length) {
    allDisks().filter((e) => (X.attr(e, 'device') || 'disk') === 'disk' && change.removeDisks.includes(X.attr(X.child(e, 'target'), 'dev'))).forEach((e) => X.remove(dev, e));
  }
  if (change.addDisks && change.addDisks.length) {
    const used = targets();
    for (const d of change.addDisks) {
      const last = allDisks().filter((e) => (X.attr(e, 'device') || 'disk') === 'disk').slice(-1)[0] || allDisks().slice(-1)[0] || null;
      const el = X.E('disk', { type: 'file', device: 'disk' }, [X.E('driver', { name: 'qemu', type: d.format || 'qcow2', discard: 'unmap' }),
        X.E('source', { file: d.file }), X.E('target', { dev: d.target || nextTarget(used, d.bus), bus: d.bus })]);
      X.append(dev, el, last);
    }
  }

  if (change.cdrom !== undefined) {
    let cd = allDisks().find((e) => X.attr(e, 'device') === 'cdrom');
    if (cd) {
      const src = X.child(cd, 'source');
      if (change.cdrom && src) X.setAttr(src, 'file', change.cdrom);
      else if (change.cdrom) X.append(cd, X.E('source', { file: change.cdrom }), X.child(cd, 'driver'));
      else if (src) X.remove(cd, src);
    } else if (change.cdrom) {
      cd = X.E('disk', { type: 'file', device: 'cdrom' }, [X.E('driver', { name: 'qemu', type: 'raw' }), X.E('source', { file: change.cdrom }),
        X.E('target', { dev: nextTarget(targets(), 'sata'), bus: 'sata' }), X.E('readonly')]);
      X.append(dev, cd, allDisks().slice(-1)[0] || null);
    }
  }

  if (change.boot) {
    // libvirt staat <boot dev> en <boot order> niet samen toe: alles per apparaat.
    const osEl = X.child(dom, 'os');
    if (osEl) X.kids(osEl, 'boot').forEach((b) => X.remove(osEl, b));
    X.kids(dev).forEach((e) => X.kids(e, 'boot').forEach((b) => X.remove(e, b)));
    const disk = allDisks().find((e) => (X.attr(e, 'device') || 'disk') === 'disk');
    const cd = allDisks().find((e) => X.attr(e, 'device') === 'cdrom' && X.child(e, 'source'));
    (change.boot === 'cdrom' ? [cd, disk] : [disk, cd]).filter(Boolean).forEach((e, i) => X.append(e, X.E('boot', { order: i + 1 })));
  }

  if (change.hostdevs) {
    const want = new Set(change.hostdevs);
    const cur = X.kids(dev, 'hostdev').filter((e) => X.attr(e, 'mode') === 'subsystem' && /^(usb|pci)$/.test(X.attr(e, 'type')));
    const have = new Set();
    cur.forEach((e) => { const k = hostdevKey(e); if (want.has(k)) have.add(k); else X.remove(dev, e); });
    for (const k of change.hostdevs) {
      if (have.has(k)) continue;
      const last = X.kids(dev, 'hostdev').slice(-1)[0] || X.kids(dev, 'interface').slice(-1)[0] || null;
      if (k.startsWith('usb:')) {
        const [, v, p] = k.split(':');
        X.append(dev, X.E('hostdev', { mode: 'subsystem', type: 'usb', managed: 'yes' },
          [X.E('source', {}, [X.E('vendor', { id: '0x' + v }), X.E('product', { id: '0x' + p })])]), last);
      } else {
        const m = k.match(/^pci:([0-9a-f]{4}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$/);
        X.append(dev, X.E('hostdev', { mode: 'subsystem', type: 'pci', managed: 'yes' },
          [X.E('source', {}, [X.E('address', { domain: '0x' + m[1], bus: '0x' + m[2], slot: '0x' + m[3], function: '0x' + m[4] })])]), last);
      }
    }
  }

  if (change.clipboard !== undefined) {
    const cur = X.kids(dev, 'channel').filter((c) => X.attr(c, 'type') === 'qemu-vdagent');
    if (!change.clipboard) cur.forEach((c) => X.remove(dev, c));
    else if (!cur.length) {
      X.append(dev, X.E('channel', { type: 'qemu-vdagent' }, [X.E('source', {}, [X.E('clipboard', { copypaste: 'yes' }), X.E('mouse', { mode: 'client' })]),
        X.E('target', { type: 'virtio', name: 'com.redhat.spice.0' })]), X.kids(dev, 'channel').slice(-1)[0] || null);
    }
  }

  if (change.cpuPins) {
    let tune = X.child(dom, 'cputune');
    if (tune) X.kids(tune, 'vcpupin').forEach((p) => X.remove(tune, p));
    const pins = change.cpuPins.map((cpu, i) => X.E('vcpupin', { vcpu: i, cpuset: cpu }));
    if (tune && X.kids(tune).length) { let prev = null; pins.forEach((p) => { prev = X.append(tune, p, prev); }); }
    else {
      // Geen (andere) instellingen in <cputune>: het hele element opnieuw maken, netjes ingesprongen.
      if (tune) X.remove(dom, tune);
      if (pins.length) X.append(dom, X.E('cputune', {}, pins), X.child(dom, 'vcpu'));
    }
  }
  return X.toXml(dom);
}

/* ---- invoer controleren tegen wat de server heeft. cur = parseHardware van de huidige VM. */
function validateHardware(body, opts, cur) {
  const change = {};
  if (Array.isArray(body.nics)) {
    if (body.nics.length > 8) throw httpError('Een VM kan maximaal 8 netwerkkaarten hebben.', 400);
    const macs = new Set();
    const known = new Set(cur.nics.map((n) => n.mac));
    change.nics = body.nics.map((n) => {
      const id = n.id ? String(n.id).toLowerCase() : null;
      if (id && !known.has(id)) throw httpError('Deze netwerkkaart bestaat niet (meer). Open het venster opnieuw.', 409);
      if (n.locked) { if (!id) throw httpError('Onbekende netwerkkaart.', 400); macs.add(id); return { id, locked: true }; }
      const type = n.type === 'bridge' ? 'bridge' : 'network';
      const source = String(n.source || '');
      if (type === 'network' && !opts.networks.some((x) => x.name === source)) throw httpError(`Het VM-netwerk "${source}" bestaat niet. Kies een ander netwerk.`, 400);
      if (type === 'bridge' && !opts.bridges.some((x) => x.name === source)) throw httpError(`De bridge "${source}" bestaat niet op de server. Maak ze aan bij Instellingen → Netwerk.`, 400);
      const model = MODELS.includes(n.model) ? n.model : 'virtio';
      const mac = String(n.mac || '').trim().toLowerCase();
      if (mac && (!MAC.test(mac) || parseInt(mac.slice(0, 2), 16) & 1)) throw httpError(`"${mac}" is geen geldig MAC-adres, bv. 52:54:00:12:34:56.`, 400);
      if (mac && macs.has(mac)) throw httpError(`Het MAC-adres ${mac} staat er twee keer in.`, 400);
      if (mac) macs.add(mac);
      return { id, type, source, model, mac: mac || null };
    });
  }
  if (body.boot !== undefined) {
    if (!['disk', 'cdrom'].includes(body.boot)) throw httpError('Kies of de VM eerst van de schijf of van de cd-rom opstart.', 400);
    if (body.boot !== cur.boot) change.boot = body.boot;
  }
  if (body.cdrom !== undefined && body.cdrom !== '=') {
    const cdrom = String(body.cdrom || '');
    if (cdrom && !opts.isos.some((f) => f.name === cdrom)) throw httpError(`Kies een ISO uit ${opts.isoDir}.`, 400);
    const file = cdrom ? path.join(opts.isoDir, cdrom) : null;
    const now = cur.cdroms[0] ? cur.cdroms[0].source : null;
    if (file !== now) change.cdrom = file;
  }
  if (Array.isArray(body.hostdevs)) {
    const keys = [...new Set(body.hostdevs.map(String))];
    for (const k of keys) {
      if (cur.hostdevs.includes(k)) continue; // al gekoppeld (ook als het nu niet aangesloten is)
      if (k.startsWith('usb:')) { if (!opts.usb.some((u) => u.key === k)) throw httpError('Dit USB-apparaat is niet (meer) aangesloten. Steek het in en open het venster opnieuw.', 400); }
      else if (k.startsWith('pci:')) {
        if (!opts.iommu) throw httpError('PCI-apparaten doorgeven kan pas als IOMMU aan staat. Zet AMD-Vi (IOMMU) aan in het BIOS en start de server opnieuw.', 400);
        if (!opts.pci.some((p) => p.key === k)) throw httpError('Dit PCI-apparaat bestaat niet op de server.', 400);
      } else throw httpError('Onbekend apparaat.', 400);
    }
    const same = keys.length === cur.hostdevs.length && keys.every((k) => cur.hostdevs.includes(k));
    if (!same) change.hostdevs = keys;
  }
  if (body.clipboard !== undefined && !!body.clipboard !== cur.clipboard) change.clipboard = !!body.clipboard;
  if (Array.isArray(body.cpuPins)) {
    const pins = body.cpuPins.map(Number);
    const max = opts.cpus.length;
    if (pins.some((n) => !Number.isInteger(n) || n < 0 || n >= max)) throw httpError(`Kies kernen die op de server bestaan (0 tot ${max - 1}).`, 400);
    if (new Set(pins).size !== pins.length) throw httpError('Elke kern mag maar één keer gekozen worden.', 400);
    const sorted = [...pins].sort((a, b) => a - b);
    if (sorted.join() !== cur.cpuPins.join()) change.cpuPins = sorted;
  }
  return change;
}

/* ---- wat de server heeft */

// `lsusb`: "Bus 001 Device 004: ID 10c4:ea60 Silicon Labs CP210x UART Bridge". Hubs laten we weg.
function parseLsusb(text) {
  return String(text).split('\n').map((l) => l.match(/^Bus (\d+) Device (\d+): ID ([0-9a-f]{4}):([0-9a-f]{4})\s*(.*)$/i)).filter(Boolean)
    .map((m) => ({ key: usbKey(m[3], m[4]), bus: Number(m[1]), device: Number(m[2]), vendor: m[3].toLowerCase(), product: m[4].toLowerCase(), name: m[5].trim() || m[3] + ':' + m[4] }))
    .filter((d) => d.vendor !== '1d6b' && !/\bhub\b/i.test(d.name));
}

// PCI-klassen die je zinvol kan doorgeven: opslag, netwerk, beeld, geluid, USB-controllers.
const PCI_CLASS = { '01': 'Opslag', '02': 'Netwerk', '03': 'Beeld', '04': 'Geluid', '0c03': 'USB' };
const pciKind = (cls) => PCI_CLASS[cls.slice(0, 4)] || PCI_CLASS[cls.slice(0, 2)] || null;
// entries: [{ address, class: '030000', group, driver }], namen uit `lspci -Dmm`.
function summarizePci(entries, lspciText) {
  const names = {};
  for (const l of String(lspciText).split('\n')) {
    const a = l.match(/^(\S+)\s/); if (!a) continue;
    const f = [...l.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    // "NVIDIA Corporation" + "GA104 [GeForce RTX 3060 Ti]" → "NVIDIA GeForce RTX 3060 Ti"
    const vendor = (f[1] || '').replace(/\s*\[[^\]]*\]/g, '').replace(/,?\s+(Inc\.?|Corporation|Co\.,? Ltd\.?)$/i, '').trim();
    const br = (f[2] || '').match(/\[([^\]]+)\]/);
    names[a[1]] = [vendor, br ? br[1] : (f[2] || '').trim()].filter(Boolean).join(' ');
  }
  const byGroup = {};
  entries.forEach((e) => { (byGroup[e.group] = byGroup[e.group] || []).push(e.address); });
  return entries.filter((e) => pciKind(e.class)).map((e) => ({
    key: 'pci:' + e.address, address: e.address, kind: pciKind(e.class), name: names[e.address] || e.address,
    group: e.group, groupDevices: e.group == null ? [] : byGroup[e.group].filter((x) => x !== e.address).map((x) => ({ address: x, name: names[x] || x })),
    driver: e.driver || null,
  })).sort((a, b) => a.address.localeCompare(b.address));
}

const linkName = (p) => { try { return path.basename(fs.readlinkSync(p)); } catch { return null; } };
async function pciDevices() {
  const base = '/sys/bus/pci/devices';
  let list = [];
  try { list = fs.readdirSync(base); } catch { return { iommu: false, pci: [] }; }
  const entries = list.map((a) => ({ address: a, class: readText(path.join(base, a, 'class')).trim().replace(/^0x/, ''),
    group: linkName(path.join(base, a, 'iommu_group')), driver: linkName(path.join(base, a, 'driver')) }));
  const lspci = await run('lspci', ['-Dmm'], { timeout: 5000 }).catch(() => '');
  let iommu = false; try { iommu = fs.readdirSync('/sys/kernel/iommu_groups').length > 0; } catch { /* geen IOMMU */ }
  return { iommu, pci: summarizePci(entries, lspci) };
}
async function usbDevices() { return parseLsusb(await run('lsusb', [], { timeout: 5000 }).catch(() => '')); }

// Threads van de CPU met hun kern, zodat je de twee threads van een kern samen kan kiezen.
function cpuTopology() {
  return os.cpus().map((_, id) => {
    const t = (f) => readText(`/sys/devices/system/cpu/cpu${id}/topology/${f}`).trim();
    const core = Number(t('core_id')), sib = t('thread_siblings_list');
    return { id, core: Number.isFinite(core) && t('core_id') !== '' ? core : id, siblings: sib ? expandList(sib) : [id] };
  });
}
// "0,8" of "0-1" → [0, 8] / [0, 1]
function expandList(s) {
  return String(s).split(',').flatMap((p) => { const [a, b] = p.split('-').map(Number); return b >= a ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; }).filter(Number.isFinite);
}

module.exports = { parseHardware, applyHardware, validateHardware, parseLsusb, summarizePci, pciDevices, usbDevices, cpuTopology, expandList, randomMac, MODELS };
