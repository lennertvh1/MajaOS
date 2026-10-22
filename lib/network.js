'use strict';
/*
 * Netwerk van de server: bekijken en (met ifupdown) aanpassen.
 * Veiligheid zoals bij een router: na het toepassen heb je 2 minuten om te bevestigen.
 * Bevestig je niet (bv. omdat de server onbereikbaar werd), dan komen de oude instellingen terug.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { run, httpError, readText } = require('./system');

const IFACES = process.env.NET_INTERFACES_FILE || '/etc/network/interfaces';
const RESOLV = '/etc/resolv.conf';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/thuisbasis';
const BACKUP_DIR = path.join(DATA_DIR, 'netwerk-vorige');
const CONFIRM_MS = 120000;
const SKIP = /^(lo|docker\d*|veth|br-[0-9a-f]+|virbr|vnet|tap|tun|wg|zt)/;

/* ---- lezen */

// /etc/network/interfaces in blokken: elk blok begint met auto, allow-*, iface, source of mapping.
function parseInterfaces(text) {
  const blocks = []; let cur = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    // Een ingesprongen opmerking hoort bij het blok; een losse opmerking niet.
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

// Het formulier halen uit het bestand: welke kaart, DHCP of vast, en of er een bridge br0 is.
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

// `ip -j -d addr`: kaarten met adressen, MAC, status en of het een bridge is.
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
  const config = mgr === 'ifupdown' ? configFromInterfaces(parseInterfaces(readText(IFACES)), physical) : null;
  return {
    hostname: os.hostname(), manager: mgr, editable: mgr === 'ifupdown', links, physical, config,
    dns: nameservers(readText(RESOLV)), resolvManaged: isSymlink(RESOLV),
    pending: pending ? { until: pending.until } : null,
  };
}
function isSymlink(f) { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } }

/* ---- schrijven */

const HOSTNAME = /^(?=.{1,63}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
function validate(f, physical) {
  const out = { interface: String(f.interface || ''), mode: f.mode === 'static' ? 'static' : 'dhcp', bridge: !!f.bridge, bridgeName: 'br0' };
  if (!physical.includes(out.interface)) throw httpError('Kies een netwerkkaart van de server.', 400);
  if (out.mode === 'static') {
    const [ip, prefix] = String(f.address || '').trim().split('/');
    if (!net.isIPv4(ip) || !(Number(prefix) >= 8 && Number(prefix) <= 32)) throw httpError('Vul het IP-adres in met de netmasker-lengte, bv. 192.168.1.10/24.', 400);
    out.address = ip + '/' + Number(prefix);
    out.gateway = String(f.gateway || '').trim();
    if (!net.isIPv4(out.gateway)) throw httpError('Vul de gateway in, meestal het adres van je router (bv. 192.168.1.1).', 400);
    if (!sameSubnet(ip, out.gateway, Number(prefix))) throw httpError('De gateway ligt niet in hetzelfde netwerk als het IP-adres.', 400);
  }
  out.dns = (Array.isArray(f.dns) ? f.dns : String(f.dns || '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  for (const d of out.dns) if (!net.isIP(d)) throw httpError(`"${d}" is geen geldig DNS-adres.`, 400);
  if (out.mode === 'static' && !out.dns.length) throw httpError('Vul minstens één DNS-server in, bv. je router of 1.1.1.1.', 400);
  return out;
}
function sameSubnet(a, b, prefix) {
  const n = (ip) => ip.split('.').reduce((x, o) => (x << 8) + Number(o), 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (n(a) & mask) === (n(b) & mask);
}

// Nieuw bestand: lo, de gekozen kaart (eventueel in een bridge) en alle andere blokken ongewijzigd.
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
    '# Beheerd door Thuisbasis (Instellingen > Netwerk). De vorige versie staat in ' + BACKUP_DIR + '.',
    'source /etc/network/interfaces.d/*', '', 'auto lo', 'iface lo inet loopback', '',
  ];
  if (cfg.bridge) {
    lines.push(`iface ${cfg.interface} inet manual`, '', `auto ${cfg.bridgeName}`, `iface ${cfg.bridgeName} inet ${cfg.mode}`,
      `    bridge_ports ${cfg.interface}`, '    bridge_stp off', '    bridge_fd 0', ...ipLines);
  } else {
    lines.push(`auto ${cfg.interface}`, `iface ${cfg.interface} inet ${cfg.mode}`, ...ipLines);
  }
  // Lege regel na elk iface-blok; auto/allow-regels blijven tegen hun iface aan staan.
  if (keep.length) lines.push('', '# Overige instellingen, ongewijzigd overgenomen', ...keep.flatMap((b) => (b.kind === 'iface' ? [...b.lines, ''] : b.lines)));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
}

async function reload(ifaces) {
  // Alles wat we beheren even neerhalen, adressen weghalen en opnieuw opbrengen.
  for (const i of ifaces) await run('ifdown', ['--force', i], { timeout: 30000 }).catch(() => {});
  for (const i of ifaces) await run('ip', ['addr', 'flush', 'dev', i], { timeout: 5000 }).catch(() => {});
  await run('ifup', ['-a'], { timeout: 60000 });
}

function backup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(IFACES, path.join(BACKUP_DIR, 'interfaces'));
  if (fs.existsSync(RESOLV) && !isSymlink(RESOLV)) fs.copyFileSync(RESOLV, path.join(BACKUP_DIR, 'resolv.conf'));
}

async function applyNetwork(body) {
  if (pending) throw httpError('Er wachten al nieuwe netwerkinstellingen op bevestiging.', 409);
  const state = await getNetwork();
  if (!state.editable) throw httpError('Dit netwerk wordt beheerd door ' + (state.manager || 'een ander programma') + '. Thuisbasis kan het alleen aanpassen met ifupdown.', 400);
  const cfg = validate(body, state.physical);
  const oldText = readText(IFACES);
  const newText = buildInterfaces(cfg, oldText);
  backup();
  fs.writeFileSync(IFACES, newText);
  if (cfg.mode === 'static' && !state.resolvManaged) fs.writeFileSync(RESOLV, '# Beheerd door Thuisbasis\n' + cfg.dns.map((d) => 'nameserver ' + d).join('\n') + '\n');
  const ifaces = [...new Set([cfg.interface, cfg.bridgeName, state.config && state.config.interface, state.config && state.config.bridge && state.config.bridgeName].filter(Boolean))];
  pending = { until: Date.now() + CONFIRM_MS, ifaces, timer: setTimeout(() => rollback('niet bevestigd binnen 2 minuten'), CONFIRM_MS) };
  // Eerst antwoorden, dan pas het netwerk herladen (anders komt het antwoord misschien niet meer aan).
  setTimeout(() => reload(ifaces).catch((e) => console.error('Netwerk herladen mislukt:', e.message)), 1000);
  return { pending: { until: pending.until }, address: cfg.mode === 'static' ? cfg.address.split('/')[0] : null };
}

async function rollback(reason) {
  if (!pending) return;
  const { ifaces, timer } = pending; clearTimeout(timer); pending = null;
  console.log('Netwerk: oude instellingen terugzetten (' + reason + ').');
  fs.copyFileSync(path.join(BACKUP_DIR, 'interfaces'), IFACES);
  const r = path.join(BACKUP_DIR, 'resolv.conf');
  if (fs.existsSync(r) && !isSymlink(RESOLV)) fs.copyFileSync(r, RESOLV);
  await reload(ifaces).catch((e) => console.error('Netwerk terugzetten mislukt:', e.message));
}

function confirmNetwork() {
  if (!pending) throw httpError('Er wachten geen netwerkinstellingen op bevestiging.', 409);
  clearTimeout(pending.timer); pending = null;
  return { ok: true };
}
async function revertNetwork() {
  if (!pending) throw httpError('Er wachten geen netwerkinstellingen op bevestiging.', 409);
  await rollback('teruggezet op vraag');
  return { ok: true };
}

// Hostnaam: geen risico voor de verbinding, dus meteen.
async function setHostname(name) {
  const h = String(name || '').trim().toLowerCase();
  if (!HOSTNAME.test(h)) throw httpError('Een hostnaam bestaat uit letters, cijfers en -, en is maximaal 63 tekens lang.', 400);
  await run('hostnamectl', ['set-hostname', h], { timeout: 10000 });
  const hosts = readText('/etc/hosts');
  if (hosts) {
    const next = /^127\.0\.1\.1\s/m.test(hosts) ? hosts.replace(/^127\.0\.1\.1\s.*$/m, '127.0.1.1\t' + h) : hosts.replace(/\n*$/, '\n127.0.1.1\t' + h + '\n');
    fs.writeFileSync('/etc/hosts', next);
  }
  return { hostname: h };
}

module.exports = { getNetwork, applyNetwork, confirmNetwork, revertNetwork, setHostname, parseInterfaces, configFromInterfaces, buildInterfaces, summarizeLinks, validate, nameservers, maskToPrefix };
