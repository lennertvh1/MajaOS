'use strict';
/* The installation ISO's own screen: which disks may be erased, and the preseed that
 * answers the Debian installer only after someone has confirmed the disk by name.
 * The preseed file in git never names a disk and never contains a password. */
const { httpError } = require('./system');

const DEV = /^[a-z][a-z0-9]{0,31}$/;
// Our language code → Debian installer locale and language. The keyboard stays Belgian (preseed.cfg).
const DEBIAN = {
  en: { locale: 'en_US.UTF-8', language: 'en' },
  nl: { locale: 'nl_BE.UTF-8', language: 'nl' },
  fr: { locale: 'fr_FR.UTF-8', language: 'fr' },
  de: { locale: 'de_DE.UTF-8', language: 'de' },
  es: { locale: 'es_ES.UTF-8', language: 'es' },
  pt: { locale: 'pt_PT.UTF-8', language: 'pt' },
  it: { locale: 'it_IT.UTF-8', language: 'it' },
  pl: { locale: 'pl_PL.UTF-8', language: 'pl' },
  zh: { locale: 'zh_CN.UTF-8', language: 'zh_CN' },
  ja: { locale: 'ja_JP.UTF-8', language: 'ja' },
};
const LANGUAGES = Object.keys(DEBIAN);
const LIVE_MOUNTS = /^\/(cdrom|run\/live)(\/|$)/;

function mountsOf(node, acc) {
  const list = Array.isArray(node.mountpoints) ? node.mountpoints : (node.mountpoint ? [node.mountpoint] : []);
  for (const m of list) if (typeof m === 'string') acc.push(m);
  for (const child of node.children || []) mountsOf(child, acc);
  return acc;
}
function namesOf(node, acc) {
  if (node && node.name) acc.push(node.name);
  for (const child of (node && node.children) || []) namesOf(child, acc);
  return acc;
}
function bytesOf(size) {
  if (typeof size === 'number' && Number.isFinite(size)) return size;
  const m = String(size || '').trim().match(/^([\d.]+)\s*([KMGTP])?B?$/i);
  if (!m) return 0;
  const u = { K: 1, M: 2, G: 3, T: 4, P: 5 }[(m[2] || '').toUpperCase()] || 0;
  return Math.round(parseFloat(m[1]) * (1024 ** u));
}

// lsblk -J -b -o NAME,TYPE,SIZE,MODEL,ROTA,TRAN,MOUNTPOINTS. `boot` is the disk the installer was started from (or one of its partitions).
function parseDisks(lsblk, { boot } = {}) {
  const out = [];
  for (const disk of (lsblk && lsblk.blockdevices) || []) {
    if (!disk || disk.type !== 'disk' || !DEV.test(disk.name || '')) continue;
    const names = namesOf(disk, []);
    const mounts = mountsOf(disk, []);
    const fromHere = (!!boot && names.includes(boot)) || mounts.some((m) => LIVE_MOUNTS.test(m));
    const model = String(disk.model || '').replace(/\s+/g, ' ').trim();
    out.push({
      name: disk.name,
      model,
      size: bytesOf(disk.size),
      rotational: disk.rota === true || disk.rota === 1 || disk.rota === '1',
      tran: String(disk.tran || ''),
      install: fromHere,
    });
  }
  return out;
}

function languageOf(code) {
  const lang = DEBIAN[String(code || 'en')] ? String(code || 'en') : null;
  if (!lang) throw httpError('Unknown language.', 400);
  return lang;
}

// confirm must be the disk's own short name (the screen sends it when you press Erase and install), and it must not be the stick we booted from.
function choose(disks, { name, confirm, language } = {}) {
  const disk = (disks || []).find((d) => d.name === name);
  if (!disk) throw httpError('Choose a disk.', 400);
  if (disk.install) throw httpError('This disk is the installer. Choose another disk.', 400);
  if (!DEV.test(disk.name)) throw httpError('Choose a disk.', 400);
  if (confirm !== disk.name) throw httpError('Type the disk name to confirm.', 400);
  return { disk, language: languageOf(language) };
}

function setLine(text, key, type, value) {
  const line = `d-i ${key} ${type} ${value}`;
  const re = new RegExp('^d-i ' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' .*$', 'm');
  return re.test(text) ? text.replace(re, line) : text.replace(/\s*$/, '\n') + line + '\n';
}

// A preseed that erases exactly one disk. No password: run-install.sh adds a random hash and the new system locks the account.
function buildPreseed(base, { disk, language } = {}) {
  if (!DEV.test(disk || '')) throw httpError('Choose a disk.', 400);
  const lang = languageOf(language);
  const deb = DEBIAN[lang];
  let text = String(base || '');
  text = setLine(text, 'debian-installer/locale', 'string', deb.locale);
  text = setLine(text, 'debian-installer/language', 'string', deb.language);
  text = setLine(text, 'partman-auto/disk', 'string', '/dev/' + disk);
  text = setLine(text, 'partman/confirm', 'boolean', 'true');
  text = setLine(text, 'partman/confirm_nooverwrite', 'boolean', 'true');
  text = setLine(text, 'partman-lvm/confirm', 'boolean', 'true');
  text = setLine(text, 'partman-lvm/confirm_nooverwrite', 'boolean', 'true');
  text = setLine(text, 'partman-md/confirm', 'boolean', 'true');
  text = setLine(text, 'partman-md/confirm_nooverwrite', 'boolean', 'true');
  text = setLine(text, 'debconf/priority', 'string', 'critical');
  text = setLine(text, 'grub-installer/bootdev', 'string', '/dev/' + disk);
  return { text: text.replace(/\s*$/, '\n'), cmdline: 'homebaseos.lang=' + lang, language: lang };
}

module.exports = { parseDisks, choose, buildPreseed, languageOf, LANGUAGES, DEBIAN };
