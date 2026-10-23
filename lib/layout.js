'use strict';
/*
 * Layout of the home screen: order of the apps and folders (like on an iPad).
 * DATA_DIR/layout.json: { items: [ "<container name>" | { folder: "<id>", name, apps: ["<container name>", …] } ], widgets: { order: [id], hidden: [id] } }
 * Apps that are not in it (newly installed) go at the end; apps that are gone are simply skipped.
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
// Order and hidden widgets on the dashboard (unknown names are dropped).
function validateWidgets(w) {
  const list = (a) => [...new Set((Array.isArray(a) ? a : []).map(String).filter((x) => WIDGET.test(x)))].slice(0, 30);
  return { order: list(w && w.order), hidden: list(w && w.hidden) };
}

// Check and tidy up: each app only once, folders with one app become a plain app again, empty folders disappear.
function validateLayout(body) {
  const items = Array.isArray(body && body.items) ? body.items : null;
  if (!items) throw httpError('The layout is not valid.', 400);
  if (items.length > 1000) throw httpError('The layout is too large.', 400);
  const seen = new Set(), ids = new Set(), out = [];
  const app = (n) => {
    const name = String(n || '');
    if (!APP.test(name)) throw httpError(`"${name}" is not a valid app name.`, 400);
    if (seen.has(name)) return null; // duplicate: the first place counts
    seen.add(name); return name;
  };
  for (const it of items) {
    if (typeof it === 'string') { const a = app(it); if (a) out.push(a); continue; }
    if (!it || typeof it !== 'object' || !FOLDER_ID.test(String(it.folder || ''))) throw httpError('A folder in the layout is not valid.', 400);
    if (ids.has(it.folder)) throw httpError('A folder is listed twice.', 400);
    ids.add(it.folder);
    const name = String(it.name || '').trim().slice(0, 40) || 'Folder';
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
