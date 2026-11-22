'use strict';
/* The shim: lets the server reach apps with their own address (macvlan/ipvlan) — Settings → Docker networks.
 *
 * Linux never delivers traffic between a macvlan/ipvlan child and its parent card, so the server (and every app on
 * the host network or behind Docker's NAT) can't reach an app that has its own address in the home network. The usual
 * way around it: a macvlan (or ipvlan) interface of the server itself on the same card, a "shim", with its own address,
 * and routes to the apps' addresses through it. Those routes are more specific than the home network's own route, so
 * only the apps' addresses go through the shim.
 *
 * Per network in DATA_DIR/shims.json: {networks: {"<docker network>": {address}}}. The links don't survive a restart
 * or a network reload, so `tick` (at start and every 30 s) makes them again and keeps the routes in step with the apps:
 * the network's IP range, plus a /32 for every app with an address outside it. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const FILE = path.join(DATA_DIR, 'shims.json');

function read() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { networks: j.networks && typeof j.networks === 'object' ? j.networks : {} }; }
  catch { return { networks: {} }; }
}
function write(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

/* ---- pure parts (tested) */
const ipNum = (ip) => String(ip).split('.').reduce((a, b) => ((a << 8) >>> 0) + Number(b), 0) >>> 0;
const numIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
function cidr(text) {
  const m = String(text || '').match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;
  const prefix = Number(m[2]), mask = prefix ? (~0 << (32 - prefix)) >>> 0 : 0;
  const base = (ipNum(m[1]) & mask) >>> 0;
  return { base, prefix, last: (base | ~mask) >>> 0, text: numIp(base) + '/' + prefix };
}
const inside = (c, ip) => !!c && ((ipNum(ip) & (c.prefix ? (~0 << (32 - c.prefix)) >>> 0 : 0)) >>> 0) === c.base;

// The link's name: at most 15 characters, the same for the same network.
const ifName = (network) => 'mshim' + crypto.createHash('sha1').update(String(network)).digest('hex').slice(0, 8);
// A stable, locally administered MAC address, so the router's ARP table doesn't fill up with a new one each time.
function macFor(network, seed = '') {
  const h = crypto.createHash('sha1').update('majaos-shim:' + seed + ':' + network).digest();
  return ['02', ...[...h.subarray(0, 5)].map((b) => b.toString(16).padStart(2, '0'))].join(':');
}
// The shim's own address: the top address of the network's IP range (Docker hands out the range from the bottom),
// not the subnet's broadcast address. Without an IP range: the top address of the subnet below the broadcast.
function defaultAddress(n) {
  const sub = cidr(n.subnet), range = cidr(n.ipRange) || sub;
  if (!sub || !range) return null;
  let top = range.last;
  if (top >= sub.last) top = sub.last - 1;
  const taken = new Set([n.gateway, ...(n.containers || []).map((c) => c.ip)].filter(Boolean).map((x) => String(x).split('/')[0]));
  while (top > range.base && taken.has(numIp(top))) top--;
  return top > range.base ? numIp(top) : null;
}
// The routes through the shim: the IP range, and a /32 for each app outside it (an app with a fixed address).
// Without an IP range only the /32s: routing the whole subnet through the shim would cut the server off from the home network.
function wantedRoutes(n, address) {
  const range = cidr(n.ipRange);
  const out = range ? [range.text] : [];
  for (const c of n.containers || []) {
    const ip = String(c.ip || '').split('/')[0];
    if (ip && ip !== address && !inside(range, ip)) out.push(ip + '/32');
  }
  return [...new Set(out)];
}
// What `ip -j route show dev X` lists, as CIDR text (a /32 is shown without its prefix).
const routeDsts = (routes) => (routes || []).filter((r) => r.dst && r.dst !== 'default').map((r) => (r.dst.includes('/') ? r.dst : r.dst + '/32'));

/* ---- the links */
const status = new Map(); // network → {up, error, at}
let machineSeed = null;
const seed = () => (machineSeed ??= (() => { try { return fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch { return ''; } })());

async function linkOf(dev) {
  return run('ip', ['-j', '-d', 'link', 'show', 'dev', dev], { timeout: 5000 }).then((j) => (JSON.parse(j) || [])[0] || null, () => null);
}

async function ensure(n, address) {
  if (!/^(macvlan|ipvlan)$/.test(n.driver)) throw httpError('Only a macvlan or ipvlan network needs this.', 400);
  if (!n.parent) throw httpError(`The network ${n.name} has no network card (parent). The server can't reach it this way.`, 409);
  const dev = ifName(n.name);
  let link = await linkOf(dev);
  const parentOk = link && link.link === n.parent && (!link.linkinfo || link.linkinfo.info_kind === n.driver);
  if (link && !parentOk) { await run('ip', ['link', 'del', dev], { timeout: 5000 }).catch(() => {}); link = null; }
  if (!link) {
    if (!(await linkOf(n.parent))) throw httpError(`The network card ${n.parent} of ${n.name} doesn't exist (anymore).`, 409);
    const args = n.driver === 'ipvlan'
      ? ['link', 'add', dev, 'link', n.parent, 'type', 'ipvlan', 'mode', 'l2']
      : ['link', 'add', dev, 'link', n.parent, 'address', macFor(n.name, seed()), 'type', 'macvlan', 'mode', 'bridge'];
    await run('ip', args, { timeout: 5000 });
  }
  const addrs = await run('ip', ['-j', 'addr', 'show', 'dev', dev], { timeout: 5000 }).then(JSON.parse, () => []);
  const have = ((addrs[0] || {}).addr_info || []).filter((a) => a.family === 'inet').map((a) => a.local);
  if (have.length !== 1 || have[0] !== address) {
    await run('ip', ['addr', 'flush', 'dev', dev], { timeout: 5000 }).catch(() => {});
    await run('ip', ['addr', 'add', address + '/32', 'dev', dev], { timeout: 5000 });
  }
  await run('ip', ['link', 'set', dev, 'up'], { timeout: 5000 });
  const want = wantedRoutes(n, address);
  const now = routeDsts(await run('ip', ['-j', 'route', 'show', 'dev', dev], { timeout: 5000 }).then(JSON.parse, () => []));
  for (const r of want) if (!now.includes(r)) await run('ip', ['route', 'replace', r, 'dev', dev], { timeout: 5000 });
  for (const r of now) if (!want.includes(r)) await run('ip', ['route', 'del', r, 'dev', dev], { timeout: 5000 }).catch(() => {});
  return { dev, address, routes: want };
}
async function drop(network) {
  const dev = ifName(network);
  if (await linkOf(dev)) await run('ip', ['link', 'del', dev], { timeout: 5000 }).catch(() => {});
  status.delete(network);
}

const networksNow = async () => (await require('./dockernet').listNetworks()).networks;

async function tick() {
  const cfg = read();
  const names = Object.keys(cfg.networks);
  if (!names.length) return;
  let list;
  try { list = await networksNow(); } catch { return; } // Docker not running: try again later
  let changed = false;
  for (const name of names) {
    const n = list.find((x) => x.name === name);
    if (!n) { await drop(name); delete cfg.networks[name]; changed = true; continue; } // the network was removed
    try { await ensure(n, cfg.networks[name].address); status.set(name, { up: true, error: null, at: Date.now() }); }
    catch (e) { status.set(name, { up: false, error: e.message, at: Date.now() }); }
  }
  if (changed) write(cfg);
}
let running = null;
const tickOnce = () => (running ||= tick().finally(() => { running = null; }));

function start() {
  tickOnce().catch(() => {});
  setInterval(() => tickOnce().catch(() => {}), 30000).unref();
}

// What the Docker networks list shows per own-address network.
function info(n) {
  if (!/^(macvlan|ipvlan)$/.test(n.driver)) return null;
  const c = read().networks[n.name], s = status.get(n.name);
  return { enabled: !!c, address: c ? c.address : defaultAddress(n), dev: ifName(n.name), up: !!(c && s && s.up), error: c && s ? s.error : null };
}
// The shims' own addresses, so no app gets one of them.
const addresses = () => Object.values(read().networks).map((x) => x.address).filter(Boolean);

async function setEnabled(name, enabled, address) {
  const cfg = read();
  if (!enabled) { await drop(name); delete cfg.networks[name]; write(cfg); return; }
  const n = (await networksNow()).find((x) => x.name === name);
  if (!n) throw httpError(`The network ${name} doesn't exist.`, 404);
  const ip = String(address || '').trim() || (cfg.networks[name] && cfg.networks[name].address) || defaultAddress(n);
  const sub = cidr(n.subnet);
  if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !inside(sub, ip)) throw httpError(`Choose an address in ${n.subnet} for the server in this network.`, 400);
  if (n.gateway && ip === String(n.gateway).split('/')[0]) throw httpError(`${ip} is the gateway of ${name}. Choose another address.`, 400);
  const used = (n.containers || []).find((c) => String(c.ip || '').split('/')[0] === ip);
  if (used) throw httpError(`${ip} is already used by ${used.name}. Choose another address.`, 409);
  try { await ensure(n, ip); } catch (e) { await drop(name); throw e; }
  cfg.networks[name] = { address: ip };
  write(cfg);
  status.set(name, { up: true, error: null, at: Date.now() });
}

module.exports = { start, tick: tickOnce, info, addresses, setEnabled, drop, ensure, ifName, macFor, defaultAddress, wantedRoutes, routeDsts, cidr };
