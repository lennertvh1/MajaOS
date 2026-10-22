'use strict';
/*
 * Indeling van het startscherm: volgorde van de apps en mappen (zoals op een iPad).
 * DATA_DIR/layout.json: { items: [ "<containernaam>" | { folder: "<id>", name, apps: ["<containernaam>", …] } ], widgets: { order: [id], hidden: [id] } }
 * Apps die er niet in staan (nieuw geïnstalleerd), komen achteraan; verdwenen apps worden gewoon overgeslagen.
 */
const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const FILE = path.join(DATA_DIR, 'layout.json');
const APP = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FOLDER_ID = /^f[0-9a-z]{1,16}$/;

const WIDGET = /^[a-z]{2,16}$/;
function getLayout() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { items: Array.isArray(j.items) ? j.items : [], widgets: j.widgets || { order: [], hidden: [] } };
  } catch { return { items: [], widgets: { order: [], hidden: [] } }; }
}
// Volgorde en verborgen widgets op het dashboard (onbekende namen vallen weg).
function validateWidgets(w) {
  const list = (a) => [...new Set((Array.isArray(a) ? a : []).map(String).filter((x) => WIDGET.test(x)))].slice(0, 30);
  return { order: list(w && w.order), hidden: list(w && w.hidden) };
}

// Controleer en ruim op: elke app maar één keer, mappen met één app worden weer een gewone app, lege mappen verdwijnen.
function validateLayout(body) {
  const items = Array.isArray(body && body.items) ? body.items : null;
  if (!items) throw httpError('De indeling klopt niet.', 400);
  if (items.length > 1000) throw httpError('De indeling is te groot.', 400);
  const seen = new Set(), ids = new Set(), out = [];
  const app = (n) => {
    const name = String(n || '');
    if (!APP.test(name)) throw httpError(`"${name}" is geen geldige naam van een app.`, 400);
    if (seen.has(name)) return null; // dubbel: de eerste plaats telt
    seen.add(name); return name;
  };
  for (const it of items) {
    if (typeof it === 'string') { const a = app(it); if (a) out.push(a); continue; }
    if (!it || typeof it !== 'object' || !FOLDER_ID.test(String(it.folder || ''))) throw httpError('Een map in de indeling klopt niet.', 400);
    if (ids.has(it.folder)) throw httpError('Een map staat er twee keer in.', 400);
    ids.add(it.folder);
    const name = String(it.name || '').trim().slice(0, 40) || 'Map';
    const apps = (Array.isArray(it.apps) ? it.apps : []).map(app).filter(Boolean);
    if (apps.length > 1) out.push({ folder: it.folder, name, apps });
    else if (apps.length === 1) out.push(apps[0]);
  }
  return { items: out, widgets: validateWidgets(body.widgets) };
}

function saveLayout(body) {
  const cfg = validateLayout(body);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
  return cfg;
}

module.exports = { getLayout, saveLayout, validateLayout };
