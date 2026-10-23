'use strict';
/*
 * Disk bays: which disk sits in which bay of the case. Linux can't know that, so the user drags them in place.
 * We recognise a disk by its serial number (sda/sdb can swap after a reboot).
 * DATA_DIR/bays.json: { count, columns, m2, ssd, slots: { "<bay>", "m<slot>" or "s<slot>": { key, label } } }
 * (m2 = number of M.2 slots for NVMe, ssd = number of 2.5" slots for SATA SSDs)
 */
const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
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

function saveBays(body) {
  const cfg = validateBays(body);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  return cfg;
}

module.exports = { getBays, saveBays, validateBays, diskKey };
