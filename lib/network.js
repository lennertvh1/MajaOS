'use strict';
/*
 * The server's network: view it and (with ifupdown) change it.
 * Safety like on a router: after applying you have 2 minutes to confirm.
 * If you don't confirm (e.g. because the server became unreachable), the old settings come back.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { run, httpError, readText } = require('./system');

const IFACES = process.env.NET_INTERFACES_FILE || '/etc/network/interfaces';
const RESOLV = '/etc/resolv.conf';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const BACKUP_DIR = path.join(DATA_DIR, 'network-previous');
const CONFIRM_MS = 120000;
const SKIP = /^(lo|docker\d*|veth|br-[0-9a-f]+|virbr|vnet|tap|tun|wg|zt)/;

/* ---- reading */

// /etc/network/interfaces in blocks: each block starts with auto, allow-*, iface, source or mapping.
function parseInterfaces(text) {
  const blocks = []; let cur = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    // An indented comment belongs to the block; a loose comment doesn't.
    if (!t || t.startsWith('#')) { if (cur && cur.kind === 'iface' && t && /^\s/.test(line)) cur.lines.push(line); continue; }
    const m = t.match(/^(auto|allow-[\w-]+|iface|source|source-directory|mapping)\s+(.*)$/);
    if (m) {
      cur = { kind: m[1] === 'iface' ? 'iface' : m[1], text: t, lines: [line], options: {} };
      if (m[1] === 'iface') { const [name, family, method] = m[2].split(/\s+/); Object.assign(cur, { name, family, method }); }
      else cur.names = m[2].split(/\s+/);
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
      const o = t.match(/^([\w-]+)\s+(.*)$/); if (o && cur.kind === 'iface') cur.options[o[1]] = o[2];
    }
  }
  return blocks;
}

function maskToPrefix(mask) { return String(mask).split('.').reduce((n, o) => n + ((Number(o) >>> 0).toString(2).match(/1/g) || []).length, 0); }

// Get the form from the file: which card, DHCP or static, and whether there is a bridge br0.
function configFromInterfaces(blocks, physical) {
  const ifaces = blocks.filter((b) => b.kind === 'iface' && b.family === 'inet');
  const bridge = ifaces.find((b) => b.options.bridge_ports && b.options.bridge_ports !== 'none');
  let primary, stanza;
  if (bridge) { primary = bridge.options.bridge_ports.split(/\s+/)[0]; stanza = bridge; }
  else { stanza = ifaces.find((b) => b.name !== 'lo' && (b.method === 'dhcp' || b.method === 'static')); primary = stanza && stanza.name; }
  if (!stanza) return { interface: physical[0] || null, mode: 'dhcp', address: '', gateway: '', dns: [], bridge: false, bridgeName: 'br0' };
  const o = stanza.options;
  let address = o.address || '';
  if (address && !address.includes('/') && o.netmask) address += '/' + maskToPrefix(o.netmask);
  return {
    interface: primary, mode: stanza.method === 'static' ? 'static' : 'dhcp', address, gateway: o.gateway || '',
    dns: (o['dns-nameservers'] || '').split(/\s+/).filter(Boolean), bridge: !!bridge, bridgeName: bridge ? bridge.name : 'br0',
  };
}

// Per card what the file says (for the card tiles in Settings > Network): its own stanza, or the bridge it is a port of.
// null: the file doesn't mention the card (it isn't used).
function cardConfigs(blocks, physical) {
  const ifaces = blocks.filter((b) => b.kind === 'iface' && b.family === 'inet');
  const out = {};
  for (const card of physical) {
    const br = ifaces.find((b) => b.options.bridge_ports && b.options.bridge_ports.split(/\s+/).includes(card));
    const st = br || ifaces.find((b) => b.name === card);
    if (!st || (!br && st.method === 'manual')) { out[card] = null; continue; }
    const o = st.options;
    let address = o.address || '';
    if (address && !address.includes('/') && o.netmask) address += '/' + maskToPrefix(o.netmask);
    out[card] = { mode: st.method === 'static' ? 'static' : 'dhcp', address, gateway: o.gateway || '',
      dns: (o['dns-nameservers'] || '').split(/\s+/).filter(Boolean), bridge: !!br, bridgeName: br ? br.name : 'br0' };
  }
  return out;
}

// `ip -j -d addr`: cards with addresses, MAC, state and whether it is a bridge.
function summarizeLinks(list, routes) {
  const gw = (routes || []).find((r) => r.dst === 'default');
  return (list || []).filter((l) => !SKIP.test(l.ifname)).map((l) => ({
    name: l.ifname, mac: l.address || null, up: l.operstate === 'UP', state: l.operstate,
    kind: l.linkinfo && l.linkinfo.info_kind === 'bridge' ? 'bridge' : l.linkinfo && l.linkinfo.info_kind ? l.linkinfo.info_kind : 'ethernet',
    master: l.master || null,
    ipv4: (l.addr_info || []).filter((a) => a.family === 'inet').map((a) => ({ address: a.local + '/' + a.prefixlen, dynamic: !!a.dynamic })),
    ipv6: (l.addr_info || []).filter((a) => a.family === 'inet6' && a.scope === 'global').map((a) => a.local + '/' + a.prefixlen),
    gateway: gw && gw.dev === l.ifname ? gw.gateway : null,
  }));
}

function nameservers(text) { return String(text).split('\n').map((l) => l.match(/^\s*nameserver\s+(\S+)/)).filter(Boolean).map((m) => m[1]); }

async function manager() {
  const active = (u) => run('systemctl', ['is-active', '--quiet', u], { timeout: 4000 }).then(() => true, () => false);
  const [nm, networkd, networking] = await Promise.all([active('NetworkManager'), active('systemd-networkd'), active('networking')]);
  if (nm) return 'NetworkManager';
  if (networkd && !networking) return 'systemd-networkd';
  if (fs.existsSync(IFACES)) return 'ifupdown';
  return null;
}

let pending = null; // { until, timer, files }

async function getNetwork() {
  const [addrs, routes, mgr] = await Promise.all([
    run('ip', ['-j', '-d', 'addr'], { timeout: 5000 }).then(JSON.parse),
    run('ip', ['-j', 'route', 'show', 'default'], { timeout: 5000 }).then(JSON.parse, () => []),
    manager(),
  ]);
  const links = summarizeLinks(addrs, routes);
  const physical = links.filter((l) => l.kind === 'ethernet' && !l.name.startsWith('wl')).map((l) => l.name);
  links.forEach((l) => { const s = readText('/sys/class/net/' + l.name + '/speed').trim(); l.speed = Number(s) > 0 ? Number(s) : null; });
  const blocks = mgr === 'ifupdown' ? parseInterfaces(readText(IFACES)) : null;
  const config = blocks ? configFromInterfaces(blocks, physical) : null;
  const cards = blocks ? cardConfigs(blocks, physical) : {};
  return {
    hostname: os.hostname(), manager: mgr, editable: mgr === 'ifupdown', links, physical, config, cards,
    dns: nameservers(readText(RESOLV)), resolvManaged: isSymlink(RESOLV),
    pending: pending ? { until: pending.until } : null,
  };
}
function isSymlink(f) { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } }

/* ---- writing */

const HOSTNAME = /^(?=.{1,63}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
function validate(f, physical) {
  const out = { interface: String(f.interface || ''), mode: f.mode === 'static' ? 'static' : 'dhcp', bridge: !!f.bridge, bridgeName: 'br0' };
  if (!physical.includes(out.interface)) throw httpError('Choose one of the server\'s network cards.', 400);
  if (out.mode === 'static') {
    const [ip, prefix] = String(f.address || '').trim().split('/');
    if (!net.isIPv4(ip) || !(Number(prefix) >= 8 && Number(prefix) <= 32)) throw httpError('Fill in the IP address with the netmask length, e.g. 192.168.1.10/24.', 400);
    out.address = ip + '/' + Number(prefix);
    out.gateway = String(f.gateway || '').trim();
    if (!net.isIPv4(out.gateway)) throw httpError('Fill in the gateway, usually your router\'s address (e.g. 192.168.1.1).', 400);
    if (!sameSubnet(ip, out.gateway, Number(prefix))) throw httpError('The gateway is not in the same network as the IP address.', 400);
  }
  out.dns = (Array.isArray(f.dns) ? f.dns : String(f.dns || '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  for (const d of out.dns) if (!net.isIP(d)) throw httpError(`"${d}" is not a valid DNS address.`, 400);
  if (out.mode === 'static' && !out.dns.length) throw httpError('Fill in at least one DNS server, e.g. your router or 1.1.1.1.', 400);
  return out;
}
function sameSubnet(a, b, prefix) {
  const n = (ip) => ip.split('.').reduce((x, o) => (x << 8) + Number(o), 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (n(a) & mask) === (n(b) & mask);
}

// A bridge over one card. It keeps the card's MAC address: otherwise udev gives the bridge a MAC of its own, the router
// hands out another address over DHCP (or ignores a reservation by MAC) and the browser loses the server. bridge_hw sets
// it when bridge-utils makes the bridge, hwaddress again before DHCP starts (in case udev changed it in between).
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const macLines = (mac) => (mac && MAC_RE.test(mac) ? [`    bridge_hw ${mac.toLowerCase()}`, `    hwaddress ether ${mac.toLowerCase()}`] : []);
function bridgeLines(card, bridge, mode, mac, ipLines = []) {
  return [`iface ${card} inet manual`, '', `auto ${bridge}`, `iface ${bridge} inet ${mode}`, `    bridge_ports ${card}`,
    ...macLines(mac), '    bridge_stp off', '    bridge_fd 0', ...ipLines];
}
// A bridge written before it kept the MAC (one card, no bridge_hw/hwaddress): the lines added after bridge_ports.
// macOf(card) → the card's MAC. Returns {text, bridges: [names]} (bridges empty = nothing to change).
function addBridgeMacs(text, macOf) {
  const blocks = parseInterfaces(text);
  const fix = blocks.filter((b) => b.kind === 'iface' && b.options.bridge_ports && !b.options.bridge_hw && !b.options.hwaddress
    && b.options.bridge_ports.trim().split(/\s+/).length === 1 && b.options.bridge_ports !== 'none');
  const out = [];
  let lines = String(text).split('\n');
  for (const b of fix) {
    const mac = macOf(b.options.bridge_ports.trim());
    if (!mac || !MAC_RE.test(mac)) continue;
    const head = lines.findIndex((l) => l.trim() === b.text);
    const at = lines.findIndex((l, i) => i > head && /^\s*bridge_ports\s/.test(l));
    if (head < 0 || at < 0) continue;
    lines.splice(at + 1, 0, ...macLines(mac));
    out.push(b.name);
  }
  return { text: lines.join('\n'), bridges: out };
}

// New file: lo, the chosen card (possibly in a bridge) and all other blocks unchanged.
function buildInterfaces(cfg, oldText) {
  const blocks = parseInterfaces(oldText);
  const managed = new Set(['lo', cfg.interface, cfg.bridgeName]);
  const keep = blocks.filter((b) => {
    if (b.kind === 'iface') return !managed.has(b.name) || (b.family === 'inet6' && b.name === cfg.interface && !cfg.bridge);
    if (b.kind === 'auto' || b.kind.startsWith('allow-')) return !b.names.every((n) => managed.has(n));
    return b.kind !== 'source' || !/interfaces\.d/.test(b.text);
  });
  const ipLines = cfg.mode === 'static'
    ? [`    address ${cfg.address}`, `    gateway ${cfg.gateway}`, ...(cfg.dns.length ? [`    dns-nameservers ${cfg.dns.join(' ')}`] : [])] : [];
  const lines = [
    '# Managed by MajaOS (Settings > Network). The previous version is in ' + BACKUP_DIR + '.',
    'source /etc/network/interfaces.d/*', '', 'auto lo', 'iface lo inet loopback', '',
  ];
  if (cfg.bridge) {
    lines.push(...bridgeLines(cfg.interface, cfg.bridgeName, cfg.mode, cfg.mac, ipLines));
  } else {
    lines.push(`auto ${cfg.interface}`, `iface ${cfg.interface} inet ${cfg.mode}`, ...ipLines);
  }
  // Empty line after each iface block; auto/allow lines stay right against their iface.
  if (keep.length) lines.push('', '# Other settings, taken over unchanged', ...keep.flatMap((b) => (b.kind === 'iface' ? [...b.lines, ''] : b.lines)));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
}

// The interfaces the file brings up by itself: auto and allow-hotplug (the installer writes DHCP cards as allow-hotplug,
// which `ifup -a` skips).
function upNames(text) {
  return [...new Set(parseInterfaces(text).filter((b) => b.kind === 'auto' || b.kind.startsWith('allow-')).flatMap((b) => b.names))].filter((n) => n !== 'lo');
}
async function reload(ifaces) {
  // Briefly take down everything we manage, remove addresses and bring it up again.
  for (const i of ifaces) await run('ifdown', ['--force', i], { timeout: 30000 }).catch(() => {});
  for (const i of ifaces) await run('ip', ['addr', 'flush', 'dev', i], { timeout: 5000 }).catch(() => {});
  let failed = null;
  await run('ifup', ['-a'], { timeout: 60000 }).catch((e) => { failed = e; });
  for (const i of upNames(readText(IFACES)).filter((n) => ifaces.includes(n))) {
    await run('ifup', [i], { timeout: 60000 }).catch((e) => { if (!/already configured/i.test(e.message || '')) failed = failed || e; });
  }
  if (failed) throw failed;
}
// After applying: is there an address on the card (or bridge) and a way out? Then the browser can come back.
async function reachable(dev, wantGateway, seconds = 45) {
  for (let i = 0; i < seconds / 3; i++) {
    const [addrs, routes] = await Promise.all([
      run('ip', ['-j', 'addr', 'show', 'dev', dev], { timeout: 5000 }).then(JSON.parse, () => []),
      run('ip', ['-j', 'route', 'show', 'default'], { timeout: 5000 }).then(JSON.parse, () => []),
    ]);
    const v4 = (addrs[0] && addrs[0].addr_info || []).some((a) => a.family === 'inet' && !/^169\.254\./.test(a.local));
    if (v4 && (!wantGateway || routes.some((r) => r.dev === dev))) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

function backup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(IFACES, path.join(BACKUP_DIR, 'interfaces'));
  if (fs.existsSync(RESOLV) && !isSymlink(RESOLV)) fs.copyFileSync(RESOLV, path.join(BACKUP_DIR, 'resolv.conf'));
}

async function applyNetwork(body) {
  if (pending) throw httpError('New network settings are already waiting for confirmation.', 409);
  const state = await getNetwork();
  if (!state.editable) throw httpError('This network is managed by ' + (state.manager || 'another program') + '. MajaOS can only change it with ifupdown.', 400);
  const cfg = validate(body, state.physical);
  const link = state.links.find((l) => l.name === cfg.interface);
  cfg.mac = link && link.mac;
  const oldText = readText(IFACES);
  const newText = buildInterfaces(cfg, oldText);
  backup();
  fs.writeFileSync(IFACES, newText);
  if (cfg.mode === 'static' && !state.resolvManaged) fs.writeFileSync(RESOLV, '# Managed by MajaOS\n' + cfg.dns.map((d) => 'nameserver ' + d).join('\n') + '\n');
  const ifaces = [...new Set([cfg.interface, cfg.bridgeName, state.config && state.config.interface, state.config && state.config.bridge && state.config.bridgeName].filter(Boolean))];
  const r = begin(ifaces, cfg.bridge ? cfg.bridgeName : cfg.interface, state.links.some((l) => l.gateway));
  return { ...r, address: cfg.mode === 'static' ? cfg.address.split('/')[0] : null };
}

// The new file is written: wait for confirmation, reload the network, and check it. Answer first, only then reload the
// network (otherwise the answer might not arrive anymore). If the new settings give no address (or no way out where
// there was one), the old ones come back right away instead of after 2 minutes.
function begin(ifaces, dev, hadGateway) {
  pending = { until: Date.now() + CONFIRM_MS, ifaces, timer: setTimeout(() => rollback('not confirmed within 2 minutes'), CONFIRM_MS) };
  setTimeout(async () => {
    try {
      await reload(ifaces);
      if (!(await reachable(dev, hadGateway))) await rollback(dev + ' got no working address');
    } catch (e) {
      console.error('Reloading the network failed:', e.message);
      await rollback('the new settings did not come up: ' + e.message);
    }
  }, 1000);
  return { pending: { until: pending.until } };
}

/* ---- reset: the network as a new installation sets it up. The card to the home network (where the default route is
   now, else the first with a cable) in bridge br0 with DHCP and its own MAC; every other card with DHCP. Fixed
   addresses and other settings in the file go (the old file stays in the backup). */
function resetPlan(physical, links) {
  const gw = links.find((l) => l.gateway);
  const viaBridge = gw && gw.kind === 'bridge' ? links.find((l) => l.master === gw.name && physical.includes(l.name)) : null;
  const home = (viaBridge && viaBridge.name) || (gw && physical.includes(gw.name) && gw.name)
    || (links.find((l) => physical.includes(l.name) && l.up) || {}).name || physical[0];
  const list = [home, ...physical.filter((p) => p !== home)].map((name) => ({ interface: name, mode: 'dhcp', address: '', gateway: '', dns: [] }));
  const macs = Object.fromEntries(links.filter((l) => l.mac).map((l) => [l.name, l.mac]));
  const text = require('./installer').buildInstallInterfaces(list, macs)
    .replace(/^# Written by the MajaOS installer\..*$/m, '# Reset by MajaOS (Settings > Network). The previous version is in ' + BACKUP_DIR + '.');
  return { home, text };
}
// Every interface the old and the new file manage: they all go down and come up again.
function resetIfaces(oldText, physical) {
  const bridges = parseInterfaces(oldText).filter((b) => b.kind === 'iface' && b.options.bridge_ports).map((b) => b.name);
  return [...new Set([...upNames(oldText), ...bridges, ...physical, 'br0'])];
}
async function resetNetwork() {
  if (pending) throw httpError('New network settings are already waiting for confirmation.', 409);
  const state = await getNetwork();
  if (!state.editable) throw httpError('This network is managed by ' + (state.manager || 'another program') + '. MajaOS can only change it with ifupdown.', 400);
  if (!state.physical.length) throw httpError('No network cards found.', 409);
  const { text } = resetPlan(state.physical, state.links);
  const ifaces = resetIfaces(readText(IFACES), state.physical);
  backup();
  fs.writeFileSync(IFACES, text);
  return { ...begin(ifaces, 'br0', state.links.some((l) => l.gateway)), address: null };
}

async function rollback(reason) {
  if (!pending) return;
  const { ifaces, timer } = pending; clearTimeout(timer); pending = null;
  console.log('Network: restoring the old settings (' + reason + ').');
  fs.copyFileSync(path.join(BACKUP_DIR, 'interfaces'), IFACES);
  const r = path.join(BACKUP_DIR, 'resolv.conf');
  if (fs.existsSync(r) && !isSymlink(RESOLV)) fs.copyFileSync(r, RESOLV);
  await reload(ifaces).catch((e) => console.error('Restoring the network failed:', e.message));
}

function confirmNetwork() {
  if (!pending) throw httpError('No network settings are waiting for confirmation.', 409);
  clearTimeout(pending.timer); pending = null;
  return { ok: true };
}
async function revertNetwork() {
  if (!pending) throw httpError('No network settings are waiting for confirmation.', 409);
  await rollback('restored on request');
  return { ok: true };
}

// Hostname: no risk for the connection, so right away.
async function setHostname(name) {
  const h = String(name || '').trim().toLowerCase();
  if (!HOSTNAME.test(h)) throw httpError('A hostname consists of letters, digits and -, and is at most 63 characters long.', 400);
  await run('hostnamectl', ['set-hostname', h], { timeout: 10000 });
  const hosts = readText('/etc/hosts');
  if (hosts) {
    const next = /^127\.0\.1\.1\s/m.test(hosts) ? hosts.replace(/^127\.0\.1\.1\s.*$/m, '127.0.1.1\t' + h) : hosts.replace(/\n*$/, '\n127.0.1.1\t' + h + '\n');
    fs.writeFileSync('/etc/hosts', next);
  }
  return { hostname: h };
}

/* ---- cards that should be up but aren't
   ifupdown only acts when a card appears (allow-hotplug) or at boot (auto), never when a cable is plugged in. A card
   that was taken down (an earlier rollback, ifdown, a cable that was out at boot) stays without an address, also with a
   cable. Every 20 s: each card or bridge the file brings up that ifupdown doesn't have up gets `ifup` once it has a cable. */
const SYS_NET = process.env.SYS_NET_DIR || '/sys/class/net';
// `ifquery --state`: "enp5s0=enp5s0" per interface ifupdown brought up.
function parseIfState(text) { return new Set(String(text).split('\n').map((l) => l.trim().split('=')[0]).filter(Boolean)); }
// What to bring up: names from upNames whose card (or, for a bridge, one of its ports) has a cable.
// carrier(name) → true | false | null (null: the link is down, so the kernel can't tell yet).
function cardsToBringUp(text, up, carrier) {
  const blocks = parseInterfaces(text);
  const out = [], wake = [];
  for (const name of upNames(text)) {
    if (up.has(name)) continue;
    const st = blocks.find((b) => b.kind === 'iface' && b.name === name && b.family === 'inet');
    if (!st || st.method === 'manual') continue;
    const ports = st.options.bridge_ports && st.options.bridge_ports !== 'none' ? st.options.bridge_ports.split(/\s+/) : [name];
    const states = ports.map((p) => [p, carrier(p)]);
    if (states.some(([, c]) => c === true)) out.push(name);
    else wake.push(...states.filter(([, c]) => c === null).map(([p]) => p));
  }
  return { up: out, wake };
}
// Once at start: a bridge from before it kept the card's MAC gets it, and comes up again when its MAC is still wrong
// (then the router gives the reserved address again).
async function fixBridgeMacs(log) {
  if (pending || !fs.existsSync(IFACES) || (await manager().catch(() => null)) !== 'ifupdown') return;
  const macOf = (dev) => readText(path.join(SYS_NET, dev, 'address')).trim();
  const { text, bridges } = addBridgeMacs(readText(IFACES), macOf);
  if (!bridges.length) return;
  backup();
  fs.writeFileSync(IFACES, text);
  for (const br of bridges) {
    const port = parseInterfaces(text).find((b) => b.kind === 'iface' && b.name === br).options.bridge_ports.trim();
    const want = macOf(port).toLowerCase(), now = macOf(br).toLowerCase();
    log(`Network: ${br} keeps the MAC address of ${port} (${want}) from now on.`);
    if (!now || now === want) continue;
    log(`Network: ${br} had MAC address ${now}; bringing it up again with ${want}.`);
    await run('ifdown', ['--force', br], { timeout: 30000 }).catch(() => {});
    await run('ifup', [br], { timeout: 60000 }).catch((e) => console.error('Network: ifup ' + br + ' failed: ' + e.message));
  }
}
const lastTry = new Map();
let watching = null;
function watchCards(log = console.log) {
  if (watching) return;
  const carrier = (dev) => {
    if (!fs.existsSync(path.join(SYS_NET, dev))) return false;
    try { return fs.readFileSync(path.join(SYS_NET, dev, 'carrier'), 'utf8').trim() === '1'; } catch { return null; }
  };
  const tick = async () => {
    if (pending || !fs.existsSync(IFACES)) return;
    if ((await manager().catch(() => null)) !== 'ifupdown') return;
    const state = await run('ifquery', ['--state'], { timeout: 5000 }).catch(() => null);
    if (state == null) return;
    const plan = cardsToBringUp(readText(IFACES), parseIfState(state), carrier);
    // A card that is down can't report its cable: switch the link on (no address yet), next time we know.
    for (const dev of plan.wake) await run('ip', ['link', 'set', 'dev', dev, 'up'], { timeout: 5000 }).catch(() => {});
    for (const name of plan.up) {
      if (Date.now() - (lastTry.get(name) || 0) < 2 * 60000) continue;
      lastTry.set(name, Date.now());
      log('Network: bringing up ' + name + ' (it has a cable but was not up).');
      await run('ifup', [name], { timeout: 60000 }).catch((e) => console.error('Network: ifup ' + name + ' failed: ' + e.message));
    }
  };
  watching = setInterval(() => tick().catch(() => {}), 20000);
  watching.unref();
  setTimeout(() => fixBridgeMacs(log).catch((e) => console.error('Network: ' + e.message)).then(tick).catch(() => {}), 5000);
}

// On the server's own screen when the page can't be reached: node /opt/majaos/lib/network.js --reset
// (right away, without the 2 minutes to confirm).
if (require.main === module && process.argv.includes('--reset')) {
  (async () => {
    const state = await getNetwork();
    if (!state.editable) throw new Error('This network is managed by ' + (state.manager || 'another program') + ', not ifupdown.');
    const { home, text } = resetPlan(state.physical, state.links);
    const ifaces = resetIfaces(readText(IFACES), state.physical);
    backup();
    fs.writeFileSync(IFACES, text);
    console.log('Network reset: ' + home + ' in br0 with DHCP, the other cards with DHCP. The old file is in ' + BACKUP_DIR + '.');
    await reload(ifaces).catch((e) => console.error('Bringing the network up again: ' + e.message));
    console.log((await run('ip', ['-br', 'addr'], { timeout: 5000 }).catch(() => '')).trim());
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { cardConfigs, resetPlan, resetNetwork, addBridgeMacs, watchCards, cardsToBringUp, parseIfState, bridgeLines, upNames, getNetwork, applyNetwork, confirmNetwork, revertNetwork, setHostname, parseInterfaces, configFromInterfaces, buildInterfaces, summarizeLinks, validate, nameservers, maskToPrefix };
