'use strict';
/* The installation ISO's own screen: which disks may be erased, and the preseed that
 * answers the Debian installer only after someone has confirmed the disk by name.
 * The preseed file in git never names a disk and never contains a password. */
const net = require('node:net');
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
  return { text: text.replace(/\s*$/, '\n'), cmdline: 'majaos.lang=' + lang, language: lang };
}

// The network step: the computer's cards from `ip -j addr` and `ip -j route`. `physical` = names with a real device,
// `speeds` = {name: Mb/s}. The card with the default route comes first.
function parseCards(addrs, routes, physical, speeds = {}) {
  const def = (routes || []).find((r) => r && r.dst === 'default');
  const cards = (addrs || []).filter((l) => l && physical.includes(l.ifname)).map((l) => {
    // 169.254.x.x (APIPA) is what a card gives itself when DHCP doesn't answer: that is no address.
    const v4 = (l.addr_info || []).find((a) => a.family === 'inet' && !/^169\.254\./.test(a.local));
    const speed = Number(speeds[l.ifname]);
    return {
      name: l.ifname, mac: l.address || '', connected: (l.flags || []).includes('LOWER_UP'),
      address: v4 ? v4.local + '/' + v4.prefixlen : '', dynamic: !!(v4 && v4.dynamic),
      gateway: def && def.dev === l.ifname ? def.gateway || '' : '', speed: speed > 0 ? speed : null,
    };
  });
  const rank = (c) => (c.gateway ? 0 : c.connected ? 1 : 2);
  return cards.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// The network step: settings per card {interface, mode: dhcp|static|off, address, gateway, dns}. A card without internet
// (e.g. a direct link) may have a fixed address without a gateway; only one card may have a gateway.
function cardError(message, card) { const e = httpError(message, 400); e.card = card; return e; }
function toInt(ip) { return ip.split('.').reduce((x, o) => (x << 8) + Number(o), 0) >>> 0; }
function sameSubnet(a, b, prefix) { const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; return (toInt(a) & mask) === (toInt(b) & mask); }
function validateCards(list, physical) {
  if (!Array.isArray(list) || !list.length) throw httpError('Choose one of the server\'s network cards.', 400);
  const out = [], seen = new Set();
  for (const raw of list) {
    const name = String((raw && raw.interface) || '');
    if (!physical.includes(name) || seen.has(name)) throw httpError('Choose one of the server\'s network cards.', 400);
    seen.add(name);
    const card = { interface: name, mode: ['static', 'off'].includes(raw.mode) ? raw.mode : 'dhcp', address: '', gateway: '', dns: [] };
    if (card.mode === 'static') {
      const [ip, prefix] = String(raw.address || '').trim().split('/');
      if (!net.isIPv4(ip) || !(Number(prefix) >= 8 && Number(prefix) <= 32)) throw cardError('Fill in the IP address with the netmask length, e.g. 192.168.1.10/24.', name);
      card.address = ip + '/' + Number(prefix);
      card.gateway = String(raw.gateway || '').trim();
      if (card.gateway && !net.isIPv4(card.gateway)) throw cardError('Fill in the gateway, usually your router\'s address (e.g. 192.168.1.1).', name);
      if (card.gateway && !sameSubnet(ip, card.gateway, Number(prefix))) throw cardError('The gateway is not in the same network as the IP address.', name);
      card.dns = (Array.isArray(raw.dns) ? raw.dns : String(raw.dns || '').split(/[\s,]+/)).map((d) => String(d).trim()).filter(Boolean);
      if (card.dns.some((d) => !net.isIP(d))) throw cardError('Fill in valid DNS addresses, separated by spaces.', name);
      if (card.gateway && !card.dns.length) throw cardError('Fill in at least one DNS server, e.g. your router or 1.1.1.1.', name);
    }
    out.push(card);
  }
  const gateways = out.filter((c) => c.gateway);
  if (gateways.length > 1) throw cardError('Only one network card can have a gateway. Leave it empty on the others.', gateways[1].interface);
  if (!out.some((c) => c.mode === 'dhcp' || c.gateway)) throw cardError('One network card needs DHCP or a gateway, otherwise there is no internet.', out[0].interface);
  return out;
}
// /etc/network/interfaces for the installed system (ifupdown, like Settings > Network). DHCP cards come up when they
// appear (allow-hotplug: a card without a cable doesn't hold up the start); a card that is off is left out.
function buildInstallInterfaces(list) {
  const lines = ['# Written by the MajaOS installer. Change it in Settings > Network.', 'source /etc/network/interfaces.d/*', '', 'auto lo', 'iface lo inet loopback'];
  for (const c of list) {
    if (c.mode === 'dhcp') lines.push('', `allow-hotplug ${c.interface}`, `iface ${c.interface} inet dhcp`);
    if (c.mode === 'static') {
      lines.push('', `auto ${c.interface}`, `iface ${c.interface} inet static`, `    address ${c.address}`);
      if (c.gateway) lines.push(`    gateway ${c.gateway}`);
      if (c.dns.length) lines.push(`    dns-nameservers ${c.dns.join(' ')}`);
    }
  }
  return lines.join('\n') + '\n';
}
// resolv.conf when the internet card has a fixed address; with DHCP, dhcpcd writes it.
function installResolv(list) {
  const gw = list.find((c) => c.gateway);
  if (!gw) return null;
  const dns = [...new Set(list.filter((c) => c.mode === 'static').flatMap((c) => c.dns))];
  return dns.map((d) => 'nameserver ' + d).join('\n') + '\n';
}

module.exports = { parseDisks, choose, buildPreseed, languageOf, parseCards, validateCards, buildInstallInterfaces, installResolv, LANGUAGES, DEBIAN };
