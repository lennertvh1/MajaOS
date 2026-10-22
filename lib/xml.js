'use strict';
/*
 * Kleine XML-lezer en -schrijver voor de XML van libvirt (domeinen en netwerken).
 * Alles blijft behouden: volgorde, witruimte, opmerkingen. Wat je niet aanraakt, komt er ongewijzigd terug uit.
 * Knopen: { type: 'el', name, attrs: [[naam, waarde]], children } | { type: 'text', text } | { type: 'comment'|'pi', text }
 */

const decode = (s) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1)));
  return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[k];
});
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/'/g, '&apos;');

function parseXml(src) {
  const root = { type: 'el', name: '#document', attrs: [], children: [] };
  const stack = [root];
  const re = /<!--([\s\S]*?)-->|<\?([\s\S]*?)\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:'[^']*'|"[^"]*"))*)\s*(\/?)>|([^<]+)/g;
  let m, pos = 0;
  while ((m = re.exec(src))) {
    if (m.index !== pos) throw new Error('Ongeldige XML bij positie ' + pos);
    pos = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[1] != null) top.children.push({ type: 'comment', text: m[1] });
    else if (m[2] != null) top.children.push({ type: 'pi', text: m[2] });
    else if (m[3] != null) top.children.push({ type: 'text', text: m[3] });
    else if (m[8] != null) top.children.push({ type: 'text', text: decode(m[8]) });
    else if (m[4]) {
      if (top.name !== m[5]) throw new Error('XML: </' + m[5] + '> verwacht </' + top.name + '>');
      stack.pop();
    } else {
      const attrs = [...m[6].matchAll(/([\w:.-]+)\s*=\s*(?:'([^']*)'|"([^"]*)")/g)].map((a) => [a[1], decode(a[2] != null ? a[2] : a[3])]);
      const el = { type: 'el', name: m[5], attrs, children: [] };
      top.children.push(el);
      if (!m[7]) stack.push(el);
    }
  }
  if (pos !== src.length || stack.length !== 1) throw new Error('Onvolledige XML');
  const top = root.children.find((c) => c.type === 'el');
  if (!top) throw new Error('Lege XML');
  return top;
}

function toXml(n) {
  if (n.type === 'text') return escText(n.text);
  if (n.type === 'comment') return '<!--' + n.text + '-->';
  if (n.type === 'pi') return '<?' + n.text + '?>';
  const a = n.attrs.map(([k, v]) => ' ' + k + "='" + escAttr(v) + "'").join('');
  return n.children.length ? '<' + n.name + a + '>' + n.children.map(toXml).join('') + '</' + n.name + '>' : '<' + n.name + a + '/>';
}

/* ---- hulpjes */
const kids = (el, name) => el.children.filter((c) => c.type === 'el' && (!name || c.name === name));
const child = (el, name) => el.children.find((c) => c.type === 'el' && c.name === name) || null;
// Pad zoals 'devices/interface': alle overeenkomende elementen.
const findAll = (el, p) => p.split('/').reduce((list, name) => list.flatMap((e) => kids(e, name)), [el]);
const find = (el, p) => findAll(el, p)[0] || null;
function attr(el, k) { const a = el && el.attrs.find((x) => x[0] === k); return a ? a[1] : null; }
function setAttr(el, k, v) {
  const a = el.attrs.find((x) => x[0] === k);
  if (v == null) { if (a) el.attrs.splice(el.attrs.indexOf(a), 1); } else if (a) a[1] = String(v); else el.attrs.push([k, String(v)]);
}
const text = (el) => (el ? el.children.filter((c) => c.type === 'text').map((c) => c.text).join('') : null);
function setText(el, v) { el.children = [{ type: 'text', text: String(v) }]; }

// Nieuw element. children: elementen of tekst.
function E(name, attrs = {}, children = []) {
  return { type: 'el', name, attrs: Object.entries(attrs).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    children: (Array.isArray(children) ? children : [children]).map((c) => (typeof c === 'string' ? { type: 'text', text: c } : c)) };
}

// Inspringing van de kinderen van een element (uit de bestaande witruimte), bv. "\n    ".
function indentOf(parent) {
  const i = parent.children.findIndex((c) => c.type === 'el');
  const before = i > 0 && parent.children[i - 1].type === 'text' ? parent.children[i - 1].text : null;
  return before && /^\s*$/.test(before) ? before : null;
}
// Een nieuw element netjes inspringen, met al zijn kinderen.
function pretty(el, indent) {
  const sub = kids(el);
  if (!sub.length || el.children.some((c) => c.type === 'text' && c.text.trim())) return el;
  const inner = indent + '  ';
  el.children = sub.flatMap((c) => [{ type: 'text', text: inner }, pretty(c, inner)]).concat({ type: 'text', text: indent });
  return el;
}
function append(parent, el, after = null) {
  const ind = indentOf(parent) || ('\n' + '  ');
  pretty(el, ind);
  let at;
  if (after && parent.children.includes(after)) at = parent.children.indexOf(after) + 1;
  else {
    const lastEl = [...parent.children].reverse().find((c) => c.type === 'el');
    at = lastEl ? parent.children.indexOf(lastEl) + 1 : 0;
    if (!lastEl) {
      // Leeg element: eerst witruimte voor de sluittag.
      const close = ind.replace(/ {2}$/, '');
      parent.children = [{ type: 'text', text: ind }, el, { type: 'text', text: close }];
      return el;
    }
  }
  parent.children.splice(at, 0, { type: 'text', text: ind }, el);
  return el;
}
function remove(parent, el) {
  const i = parent.children.indexOf(el);
  if (i < 0) return;
  const prev = parent.children[i - 1];
  const n = prev && prev.type === 'text' && /^\s*$/.test(prev.text) ? 2 : 1;
  parent.children.splice(i - n + 1, n);
}

module.exports = { parseXml, toXml, kids, child, find, findAll, attr, setAttr, text, setText, E, append, remove, pretty };
