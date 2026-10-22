'use strict';
/*
 * Schijfbays: welke schijf in welke bay van de kast zit. Dat kan Linux niet weten, dus de gebruiker sleept ze zelf.
 * Een schijf herkennen we aan zijn serienummer (sda/sdb kan na een herstart wisselen).
 * DATA_DIR/bays.json: { count, columns, m2, ssd, slots: { "<bay>", "m<sleuf>" of "s<sleuf>": { key, label } } }
 * (m2 = aantal M.2-sleuven voor NVMe, ssd = aantal 2,5"-sleuven voor SATA-SSD's)
 */
const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'bays.json');
const DEFAULTS = { count: 0, columns: 12, m2: 0, ssd: 0, slots: {} }; // standaard alle bays op één rij (tot 12)

// Vaste sleutel van een schijf: serienummer, anders (bv. in een VM) de naam.
const diskKey = (d) => (d.serial ? 's:' + String(d.serial).trim() : 'n:' + d.name);

function getBays() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { ...DEFAULTS, slots: {} }; }
}

function validateBays(body) {
  const count = Number(body.count), columns = Number(body.columns);
  if (!Number.isInteger(count) || count < 0 || count > 60) throw httpError('Kies tussen 0 en 60 bays.', 400);
  if (!Number.isInteger(columns) || columns < 1 || columns > 12) throw httpError('Kies tussen 1 en 12 kolommen.', 400);
  const m2 = body.m2 == null ? 0 : Number(body.m2);
  if (!Number.isInteger(m2) || m2 < 0 || m2 > 8) throw httpError('Kies tussen 0 en 8 M.2-sleuven.', 400);
  const ssd = body.ssd == null ? 0 : Number(body.ssd);
  if (!Number.isInteger(ssd) || ssd < 0 || ssd > 16) throw httpError('Kies tussen 0 en 16 2,5"-sleuven.', 400);
  const max = { '': count, m: m2, s: ssd }, what = { '': 'bay', m: 'M.2-sleuf', s: '2,5"-sleuf' };
  const slots = {}, seen = new Set();
  for (const [id, v] of Object.entries(body.slots || {})) {
    const m = String(id).match(/^([ms]?)(\d+)$/);
    const n = m ? Number(m[2]) : 0;
    if (!m || n < 1 || n > max[m[1]]) continue; // bays of sleuven die weg zijn (minder gekozen) vallen weg
    const key = String((v && v.key) || '');
    if (!/^[sn]:\S[^\n]{0,199}$/.test(key)) throw httpError(`Onbekende schijf in ${what[m[1]]} ${n}.`, 400);
    if (seen.has(key)) throw httpError('Een schijf kan maar in één bay zitten.', 400);
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
