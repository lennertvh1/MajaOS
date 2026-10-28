'use strict';
/*
 * Layout of the home screen: order of the apps and folders (like on an iPad).
 * DATA_DIR/layout.json: { items: [ "<container name>" | { folder: "<id>", name, apps: ["<container name>", …] } | { widget: "<id>", w, h } | { vm: "<name>" } | { page: "storage"|"shares"|"vms"|"store"|"files"|"backup" } | { shortcut: "<id>" } ],
 *   widgets: { order: [id], hidden: [id] } }
 * A widget in items sits between the apps; others stay in the left column. w and h are cells (1–8). A VM, a shortcut and the built-in pages (Storage, Shared folders, VMs, App store, Files, Backups) get a tile like an app.
 * A folder's apps list may also contain `{page}` for those built-in pages, so they can sit in a group.
 * Apps that are not in it (newly installed) go at the end; apps that are gone are simply skipped.
 */
const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'layout.json');
const APP = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FOLDER_ID = /^f[0-9a-z]{1,16}$/;

const WIDGET = /^[a-z]{2,16}$/;
const PAGE = new Set(['storage', 'shares', 'vms', 'store', 'files', 'backup']);
const VM = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,62}$/; // like NAME in lib/vms.js
const SHORTCUT = /^s[0-9a-f]{8}$/; // like ID in lib/shortcuts.js
const WIDGET_DEFAULT = { clock: [2, 2], sys: [2, 2], storage: [2, 2], shares: [2, 2], backup: [2, 2], ai: [2, 2], vms: [2, 2] };
const WIDGET_MAX = 8;

function widgetItem(id, w, h) {
  const def = WIDGET_DEFAULT[id] || [2, 2];
  const col = Number.isInteger(w) && w >= 1 && w <= WIDGET_MAX ? w : def[0];
  const row = Number.isInteger(h) && h >= 1 && h <= WIDGET_MAX ? h : def[1];
  return { widget: id, w: col, h: row };
}
// A new installation starts with the built-in pages in one folder. The user can drag them out, or drag other apps in, like any folder.
const SYSTEM_PAGES = ['storage', 'shares', 'vms', 'store', 'files', 'backup'];
function defaultLayout() {
  return {
    items: [{ folder: 'fsystem', name: 'System', apps: SYSTEM_PAGES.map((page) => ({ page })) }],
    widgets: { order: [], hidden: [] },
  };
}
function getLayout() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { items: Array.isArray(j.items) ? j.items : [], widgets: j.widgets || { order: [], hidden: [] } };
  } catch { return defaultLayout(); }
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
  const seen = new Set(), ids = new Set(), widgets = new Set(), vms = new Set(), pages = new Set(), cuts = new Set(), out = [];
  const app = (n) => {
    const name = String(n || '');
    if (!APP.test(name)) throw httpError(`"${name}" is not a valid app name.`, 400);
    if (seen.has(name)) return null; // duplicate: the first place counts
    seen.add(name); return name;
  };
  for (const it of items) {
    if (typeof it === 'string') { const a = app(it); if (a) out.push(a); continue; }
    if (it && typeof it === 'object' && 'widget' in it) {
      const w = String(it.widget || '');
      if (!WIDGET.test(w)) throw httpError(`"${w}" is not a valid widget.`, 400);
      if (!widgets.has(w)) { widgets.add(w); out.push(widgetItem(w, it.w, it.h)); }
      continue;
    }
    if (it && typeof it === 'object' && 'vm' in it) {
      const v = String(it.vm || '');
      if (!VM.test(v)) throw httpError(`"${v}" is not a valid VM name.`, 400);
      if (!vms.has(v)) { vms.add(v); out.push({ vm: v }); }
      continue;
    }
    if (it && typeof it === 'object' && 'page' in it) {
      const p = String(it.page || '');
      if (!PAGE.has(p)) throw httpError(`"${p}" is not a valid page.`, 400);
      if (!pages.has(p)) { pages.add(p); out.push({ page: p }); }
      continue;
    }
    if (it && typeof it === 'object' && 'shortcut' in it) {
      const c = String(it.shortcut || '');
      if (!SHORTCUT.test(c)) throw httpError(`"${c}" is not a valid shortcut.`, 400);
      if (!cuts.has(c)) { cuts.add(c); out.push({ shortcut: c }); }
      continue;
    }
    if (!it || typeof it !== 'object' || !FOLDER_ID.test(String(it.folder || ''))) throw httpError('A folder in the layout is not valid.', 400);
    if (ids.has(it.folder)) throw httpError('A folder is listed twice.', 400);
    ids.add(it.folder);
    const name = String(it.name || '').trim().slice(0, 40) || 'Folder';
    const member = (n) => {
      if (n && typeof n === 'object' && 'page' in n) {
        const p = String(n.page || '');
        if (!PAGE.has(p)) throw httpError(`"${p}" is not a valid page.`, 400);
        if (pages.has(p)) return null;
        pages.add(p);
        return { page: p };
      }
      return app(n);
    };
    const apps = (Array.isArray(it.apps) ? it.apps : []).map(member).filter(Boolean);
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

module.exports = { getLayout, saveLayout, validateLayout, defaultLayout, WIDGET_DEFAULT, WIDGET_MAX };
