'use strict';
/*
 * Disk bays: which disk sits in which bay of the case. Linux can't know that, so the user drags them in place.
 * We recognise a disk by its serial number (sda/sdb can swap after a reboot).
 * DATA_DIR/bays.json: { count, columns, m2, ssd, slots: { "<bay>", "m<slot>" or "s<slot>": { key, label } }, known: [keys] }
 * (m2 = number of M.2 slots for NVMe, ssd = number of 2.5" slots for SATA SSDs; known = disks MajaOS has seen, so a
 * disk the user took out of a bay is never put back)
 */
const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'bays.json');
const DEFAULTS = { count: 0, columns: 12, m2: 0, ssd: 0, slots: {} }; // by default all bays on one row (up to 12)

// Fixed key of a disk: the serial number, otherwise (e.g. in a VM) the name.
const diskKey = (d) => (d.serial ? 's:' + String(d.serial).trim() : 'n:' + d.name);

function getBays() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { ...DEFAULTS, slots: {} }; }
}

function validateBays(body) {
  const count = Number(body.count), columns = Number(body.columns);
  if (!Number.isInteger(count) || count < 0 || count > 60) throw httpError('Choose between 0 and 60 bays.', 400);
  if (!Number.isInteger(columns) || columns < 1 || columns > 12) throw httpError('Choose between 1 and 12 columns.', 400);
  const m2 = body.m2 == null ? 0 : Number(body.m2);
  if (!Number.isInteger(m2) || m2 < 0 || m2 > 8) throw httpError('Choose between 0 and 8 M.2 slots.', 400);
  const ssd = body.ssd == null ? 0 : Number(body.ssd);
  if (!Number.isInteger(ssd) || ssd < 0 || ssd > 16) throw httpError('Choose between 0 and 16 2.5" slots.', 400);
  const max = { '': count, m: m2, s: ssd }, what = { '': 'bay', m: 'M.2 slot', s: '2.5" slot' };
  const slots = {}, seen = new Set();
  for (const [id, v] of Object.entries(body.slots || {})) {
    const m = String(id).match(/^([ms]?)(\d+)$/);
    const n = m ? Number(m[2]) : 0;
    if (!m || n < 1 || n > max[m[1]]) continue; // bays or slots that are gone (fewer chosen) are dropped
    const key = String((v && v.key) || '');
    if (!/^[sn]:\S[^\n]{0,199}$/.test(key)) throw httpError(`Unknown disk in ${what[m[1]]} ${n}.`, 400);
    if (seen.has(key)) throw httpError('A disk can only be in one bay.', 400);
    seen.add(key);
    slots[m[1] + n] = { key, label: String((v && v.label) || '').slice(0, 200) };
  }
  return { count, columns, m2, ssd, slots };
}

const diskLabel = (d) => [d.model || d.name, d.serial].filter(Boolean).join(' · ');
const slotIds = (cfg) => [
  ...Array.from({ length: cfg.count || 0 }, (_, i) => String(i + 1)),
  ...Array.from({ length: cfg.m2 || 0 }, (_, i) => 'm' + (i + 1)),
  ...Array.from({ length: cfg.ssd || 0 }, (_, i) => 's' + (i + 1)),
];
// Where a disk fits: NVMe in an M.2 slot, a SATA SSD in a 2.5" slot or else a bay, a hard disk in a bay.
const kindsOf = (d) => (d.transport === 'nvme' ? ['m'] : d.rotational ? [''] : ['s', '']);
const kindOf = (id) => String(id).match(/^([ms]?)/)[1];
const KNOWN_MAX = 500;

// New disks in the drawing. A disk that takes the place of one that is gone (exactly one such bay and one new disk
// that fits there) gets its bay; other new disks the first free bay of their kind. Disks seen before stay where the
// user left them. The first time (no "known" yet) only remembers what is there.
// disks: { name, serial, model, rotational, transport } as lsblk gives them.
function placeNew(cfg, disks) {
  const list = (disks || []).filter((d) => d && d.name && d.transport !== 'usb');
  const present = new Set(list.map(diskKey));
  const slots = { ...(cfg.slots || {}) };
  const knownBefore = Array.isArray(cfg.known) ? cfg.known : null;
  const known = [...new Set([...(knownBefore || []), ...present])].slice(-KNOWN_MAX);
  const placed = [];
  if (knownBefore) {
    const inBay = new Set(Object.values(slots).map((v) => v && v.key));
    const fresh = list.filter((d) => !inBay.has(diskKey(d)) && !knownBefore.includes(diskKey(d)));
    const ids = slotIds(cfg);
    for (const d of fresh) {
      const kinds = kindsOf(d);
      const fits = (id) => kinds.includes(kindOf(id));
      const stale = ids.filter((id) => fits(id) && slots[id] && !present.has(slots[id].key));
      const rivals = fresh.filter((x) => kindsOf(x).some((k) => stale.some((id) => kindOf(id) === k)));
      let id = stale.length === 1 && rivals.length === 1 ? stale[0] : null;
      if (!id) id = kinds.map((k) => ids.find((x) => kindOf(x) === k && !slots[x])).find(Boolean) || null;
      if (!id) continue;
      slots[id] = { key: diskKey(d), label: diskLabel(d) };
      placed.push({ name: d.name, bay: id });
    }
  }
  const changed = placed.length > 0 || !knownBefore || known.length !== knownBefore.length;
  return { cfg: { ...cfg, slots, known }, placed, changed };
}

function write(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

// Called with the disks lsblk sees each time Storage is read; writes only when something changed.
function autoPlace(disks) {
  const r = placeNew(getBays(), disks);
  if (r.changed) { try { write(r.cfg); } catch { /* read-only (tests, demo): show it anyway */ } }
  return r.cfg;
}

// zpool replace put a new disk in the place of the one in this bay.
function replaced(id, disk) {
  const cfg = getBays();
  if (!id || !disk || !slotIds(cfg).includes(String(id))) return;
  const key = diskKey(disk);
  const slots = Object.fromEntries(Object.entries(cfg.slots || {}).filter(([, v]) => v && v.key !== key));
  slots[id] = { key, label: diskLabel(disk) };
  write({ ...cfg, slots, known: [...new Set([...(cfg.known || []), key])].slice(-KNOWN_MAX) });
}

function saveBays(body) {
  const cfg = { ...validateBays(body), known: getBays().known };
  write(cfg);
  return cfg;
}

module.exports = { getBays, saveBays, validateBays, diskKey, placeNew, autoPlace, replaced };
