'use strict';
/* Docker networks: custom bridges (apps find each other by name) and macvlan/ipvlan (an address of their own in your home network, like br0 in Unraid). */
const net = require('node:net');
const { run, httpError } = require('./system');
const { docker } = require('./docker');
const { summarizeLinks } = require('./network');

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const BUILTIN = new Set(['bridge', 'host', 'none']);
const DRIVERS = ['bridge', 'macvlan', 'ipvlan'];

const ipNum = (ip) => ip.split('.').reduce((x, o) => (x << 8) + Number(o), 0) >>> 0;
const numIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
const maskOf = (prefix) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
// "192.168.1.7/24" → { base, prefix, text: "192.168.1.0/24" }. min/max: allowed length of the netmask.
function parseCidr(s, min = 8, max = 30) {
  const [ip, p] = String(s || '').trim().split('/');
  if (!net.isIPv4(ip) || !/^\d{1,2}$/.test(p || '') || Number(p) < min || Number(p) > max) return null;
  const prefix = Number(p), base = (ipNum(ip) & maskOf(prefix)) >>> 0;
  return { base, prefix, text: numIp(base) + '/' + prefix };
}
const contains = (c, ip) => ((ipNum(ip) & maskOf(c.prefix)) >>> 0) === c.base;
const overlaps = (a, b) => { const m = maskOf(Math.min(a.prefix, b.prefix)); return ((a.base & m) >>> 0) === ((b.base & m) >>> 0); };

// Simplify the output of GET /networks/<id>.
function summarize(n) {
  const ipam = ((n.IPAM && n.IPAM.Config) || []).find((c) => c.Subnet && net.isIPv4(c.Subnet.split('/')[0])) || {};
  const opt = n.Options || {}, labels = n.Labels || {};
  return {
    id: n.Id, name: n.Name, driver: n.Driver, builtin: BUILTIN.has(n.Name), internal: !!n.Internal,
    subnet: ipam.Subnet || null, gateway: ipam.Gateway || null, ipRange: ipam.IPRange || null,
    parent: opt.parent || null, created: n.Created || null,
    compose: labels['com.docker.compose.project'] || null, ours: labels['majaos'] === '1' || labels['homebaseos'] === '1', // homebaseos: from before the rename
    containers: Object.values(n.Containers || {}).map((c) => ({ name: c.Name, ip: String(c.IPv4Address || '').split('/')[0] || null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Network cards and bridges of the server, with their subnet and gateway to prefill the form.
async function parents() {
  const [addrs, routes] = await Promise.all([
    run('ip', ['-j', '-d', 'addr'], { timeout: 5000 }).then(JSON.parse, () => []),
    run('ip', ['-j', 'route', 'show', 'default'], { timeout: 5000 }).then(JSON.parse, () => []),
  ]);
  return summarizeLinks(addrs, routes).filter((l) => (l.kind === 'ethernet' || l.kind === 'bridge' || l.kind === 'vlan') && !l.master && !l.name.startsWith('wl'))
    .map((l) => {
      const a = l.ipv4[0] ? l.ipv4[0].address : null, c = a && parseCidr(a, 8, 32);
      return { name: l.name, kind: l.kind, address: a ? a.split('/')[0] : null, subnet: c ? c.text : null, gateway: l.gateway };
    });
}

async function listNetworks() {
  const [list, par] = await Promise.all([docker('GET', '/networks'), parents()]);
  const full = await Promise.all((list || []).filter((n) => n.Scope === 'local').map((n) => docker('GET', '/networks/' + encodeURIComponent(n.Id)).catch(() => n)));
  const networks = full.map(summarize).sort((a, b) => (a.builtin - b.builtin) || a.name.localeCompare(b.name));
  return { networks, parents: par };
}

// Check the form and turn it into the body of POST /networks/create.
function validateNetwork(f, { parents: par = [], existing = [] } = {}) {
  const name = String(f.name || '').trim();
  if (!NAME.test(name)) throw httpError('Choose a name with letters, digits, -, _ or . (at most 63 characters), e.g. homenet.', 400);
  if (BUILTIN.has(name) || existing.some((n) => n.name === name)) throw httpError(`A network named ${name} already exists. Choose another name.`, 409);
  const driver = String(f.driver || 'bridge');
  if (!DRIVERS.includes(driver)) throw httpError('Choose a network type: bridge, macvlan or ipvlan.', 400);
  const own = driver !== 'bridge';

  const subnetText = String(f.subnet || '').trim();
  const subnet = subnetText ? parseCidr(subnetText) : null;
  if (subnetText && !subnet) throw httpError(`"${subnetText}" is not a valid subnet. Write it as 192.168.1.0/24.`, 400);
  if (own && !subnet) throw httpError('Enter the subnet of your home network, e.g. 192.168.1.0/24.', 400);

  const gateway = String(f.gateway || '').trim();
  if (gateway && !net.isIPv4(gateway)) throw httpError(`"${gateway}" is not a valid IP address for the gateway.`, 400);
  if (gateway && !subnet) throw httpError('Also enter the subnet when you choose a gateway.', 400);
  if (gateway && !contains(subnet, gateway)) throw httpError(`The gateway ${gateway} is not in the subnet ${subnet.text}.`, 400);
  if (own && !gateway) throw httpError('Fill in the gateway, usually your router\'s address (e.g. 192.168.1.1).', 400);

  const rangeText = String(f.ipRange || '').trim();
  const range = rangeText ? parseCidr(rangeText, 8, 32) : null;
  if (rangeText && !range) throw httpError(`"${rangeText}" is not a valid IP range. Write it as 192.168.1.192/27.`, 400);
  if (range && !subnet) throw httpError('Also enter the subnet when you choose an IP range.', 400);
  if (range && !(range.prefix >= subnet.prefix && contains(subnet, numIp(range.base)))) throw httpError(`The IP range ${range.text} is not in the subnet ${subnet.text}.`, 400);

  let parent = null;
  if (own) {
    parent = String(f.parent || '');
    if (!par.some((p) => p.name === parent)) throw httpError('Choose the network card (or bridge) connected to your home network.', 400);
  }
  if (subnet) {
    const clash = existing.find((n) => n.subnet && parseCidr(n.subnet, 0, 32) && overlaps(subnet, parseCidr(n.subnet, 0, 32)));
    if (clash) throw httpError(`The subnet ${subnet.text} overlaps with the network ${clash.name} (${clash.subnet}). Choose another subnet.`, 409);
    // A bridge in the subnet of your home network makes the server unreachable for that network.
    const lan = !own && par.find((p) => p.subnet && overlaps(subnet, parseCidr(p.subnet, 0, 32)));
    if (lan) throw httpError(`The subnet ${subnet.text} is the network of ${lan.name}. A bridge needs its own subnet, e.g. 172.30.0.0/24. Choose macvlan or ipvlan for addresses in your home network.`, 409);
  }

  const options = {};
  if (own) options.parent = parent;
  if (driver === 'ipvlan') options.ipvlan_mode = 'l2';
  const ipam = subnet ? [{ Subnet: subnet.text, ...(gateway ? { Gateway: gateway } : {}), ...(range ? { IPRange: range.text } : {}) }] : [];
  return {
    Name: name, Driver: driver, Internal: !own && !!f.internal, Attachable: true, EnableIPv6: false,
    IPAM: { Driver: 'default', Config: ipam }, Options: options, Labels: { majaos: '1' },
  };
}

async function createNetwork(body) {
  const { networks, parents: par } = await listNetworks();
  const spec = validateNetwork(body, { parents: par, existing: networks });
  try { const r = await docker('POST', '/networks/create', spec); return { id: r.Id, name: spec.Name }; }
  catch (e) {
    if (/overlaps/i.test(e.message)) throw httpError('This subnet overlaps with another network. Choose another subnet.', 409);
    if (/already using parent interface/i.test(e.message)) throw httpError(`There already is a ${spec.Driver} network on ${spec.Options.parent}. Use that network for all your apps with their own address.`, 409);
    throw httpError('Docker could not create the network: ' + e.message, e.status || 502);
  }
}

async function deleteNetwork(name) {
  const n = summarize(await docker('GET', '/networks/' + encodeURIComponent(name)));
  if (n.builtin) throw httpError(`The network ${n.name} belongs to Docker itself and cannot be deleted.`, 400);
  if (n.containers.length) throw httpError(`The network ${n.name} is still used by ${n.containers.map((c) => c.name).join(', ')}. Move those apps out first.`, 409);
  await docker('DELETE', '/networks/' + encodeURIComponent(n.id));
  return { removed: n.name };
}

// For the app store: what does the chosen network name mean? (host/none/bridge, or an existing custom network)
async function resolveNetwork(name) {
  const v = String(name || 'bridge');
  if (v === 'host' || v === 'none' || v === 'bridge') return { mode: v, name: null, ownIp: false, subnet: null };
  if (!NAME.test(v)) throw httpError('Choose a network from the list.', 400);
  let n;
  try { n = summarize(await docker('GET', '/networks/' + encodeURIComponent(v))); }
  catch { throw httpError(`The network ${v} does not exist. Create it in Settings → Docker networks or choose another network.`, 400); }
  return { mode: 'custom', name: n.name, ownIp: n.driver === 'macvlan' || n.driver === 'ipvlan', subnet: n.subnet };
}
// A fixed address has to be in the network's subnet.
function checkIp(ip, subnet) {
  const v = String(ip || '').trim();
  if (!v) return '';
  if (!net.isIPv4(v)) throw httpError(`"${v}" is not a valid IP address.`, 400);
  const c = subnet && parseCidr(subnet, 0, 32);
  if (!c) throw httpError('A fixed IP address only works in a network with its own subnet.', 400);
  if (!contains(c, v)) throw httpError(`The address ${v} is not in this network's subnet ${c.text}.`, 400);
  return v;
}

/* ---- the shared MajaOS bridge: apps on the default network (bridge) that get a fixed address go in here */
const MAJA = process.env.MAJA_NETWORK || 'maja';
const MAJA_SUBNETS = ['172.30.0.0/16', '172.29.0.0/16', '10.250.0.0/16'];

// The first candidate subnet that overlaps no Docker network and no network of the server.
function pickMajaSubnet(taken) {
  return MAJA_SUBNETS.map((x) => parseCidr(x, 8, 30)).find((c) => !taken.some((t) => overlaps(c, t))) || null;
}

// The network "maja", created the first time it is needed (label majaos=1, like the other own networks).
async function ensureMajaNetwork() {
  const existing = await docker('GET', '/networks/' + encodeURIComponent(MAJA)).catch(() => null);
  if (existing) return summarize(existing);
  // Servers from before the rename have "homebase", with apps in it: keep using that one.
  const legacy = await docker('GET', '/networks/homebase').catch(() => null);
  if (legacy && (legacy.Labels || {}).homebaseos === '1') return summarize(legacy);
  const { networks, parents: par } = await listNetworks();
  const taken = [...networks.map((n) => n.subnet), ...par.map((x) => x.subnet)].filter(Boolean).map((x) => parseCidr(x, 0, 32)).filter(Boolean);
  const c = pickMajaSubnet(taken);
  if (!c) throw httpError('There is no free subnet for the MajaOS network. Create a bridge yourself in Settings → Docker networks and choose it.', 409);
  await docker('POST', '/networks/create', { Name: MAJA, Driver: 'bridge', CheckDuplicate: true,
    IPAM: { Driver: 'default', Config: [{ Subnet: c.text, Gateway: numIp(c.base + 1) }] }, Labels: { majaos: '1' } });
  return summarize(await docker('GET', '/networks/' + encodeURIComponent(MAJA)));
}

// A fixed address in a network: in its subnet, not the network, broadcast or gateway address, and not used by another app.
// self: the name of the app being edited (its own current address is fine).
function checkFreeIp(ip, n, self = null) {
  const v = checkIp(ip, n.subnet);
  if (!v) return v;
  const c = parseCidr(n.subnet, 0, 32), last = (c.base | ~maskOf(c.prefix)) >>> 0;
  if (ipNum(v) === c.base || ipNum(v) === last) throw httpError(`${v} can't be used as an address in ${c.text}. Choose another address.`, 400);
  if (n.gateway && v === String(n.gateway).split('/')[0]) throw httpError(`${v} is the gateway of ${n.name}. Choose another address.`, 400);
  const used = (n.containers || []).find((x) => String(x.ip || '').split('/')[0] === v && x.name !== self);
  if (used) throw httpError(`${v} is already used by ${used.name}. Choose another address.`, 409);
  return v;
}

// The network an app gets when installing: the chosen one, and with a fixed address on the default network the maja network.
async function networkFor(name, ip, self = null) {
  if (name === LAN_CHOICE) {
    const n = await ensureLanNetwork();
    return { mode: 'custom', name: n.name, ownIp: true, subnet: n.subnet, ip: String(ip || '').trim() ? checkFreeIp(ip, n, self) : '' };
  }
  const network = await resolveNetwork(name);
  if (!String(ip || '').trim()) return network;
  if (network.mode === 'host' || network.mode === 'none') throw httpError('A fixed IP address doesn\'t work with the host network or without a network.', 400);
  const n = network.mode === 'bridge' ? await ensureMajaNetwork() : summarize(await docker('GET', '/networks/' + encodeURIComponent(network.name)));
  return { mode: 'custom', name: n.name, ownIp: network.ownIp, subnet: n.subnet, ip: checkFreeIp(ip, n, self) };
}

// The same for the compose form ({network, ip}): the default network ('') with an address → the maja network.
async function formNetwork(form, self = null) {
  if (form && form.network === LAN_CHOICE) {
    const n = await ensureLanNetwork();
    return { ...form, network: n.name, ip: String(form.ip || '').trim() ? checkFreeIp(form.ip, n, self) : '' };
  }
  if (!form || !String(form.ip || '').trim() || form.network === '*') return form;
  if (form.network === 'host' || form.network === 'none') throw httpError('A fixed IP address doesn\'t work with the host network or without a network.', 400);
  // Several services in one file share the default network (e.g. an app and its database): moving one would cut them apart.
  if ((!form.network || form.network === 'bridge') && (form.otherServices || []).length) {
    throw httpError(`This app shares its compose file with ${form.otherServices.join(', ')}. A fixed address on the default network would cut it off from them; give the services a network with its own subnet in the code instead.`, 400);
  }
  const n = !form.network || form.network === 'bridge' ? await ensureMajaNetwork()
    : await docker('GET', '/networks/' + encodeURIComponent(form.network)).then(summarize, () => null);
  if (!n) return form; // a network from the compose file itself: compose checks the address
  return { ...form, network: n.name, ip: checkFreeIp(form.ip, n, self) };
}

/* ---- "own address in my home network": a macvlan network MajaOS sets up by itself (choice LAN_CHOICE) */
const LAN = process.env.LAN_NETWORK || 'lan';
const LAN_CHOICE = '@lan';

// The home network: the card with the default route, with its subnet and the router as gateway.
const homeLink = (par) => par.find((x) => x.gateway && x.subnet) || null;
// The addresses Docker may hand out by itself: the top /27 of the subnet (e.g. .224–.254), usually outside the router's DHCP.
function lanRange(subnetText) {
  const c = parseCidr(subnetText, 0, 32);
  if (!c || c.prefix > 27) return null;
  const last = (c.base | ~maskOf(c.prefix)) >>> 0;
  return numIp((last & 0xffffffe0) >>> 0) + '/27';
}

// An own-address network on the home network that already exists (made by MajaOS or by hand), and the home network.
async function findLan() {
  const { networks, parents: par } = await listNetworks();
  const home = homeLink(par);
  const lan = networks.find((n) => /^(macvlan|ipvlan)$/.test(n.driver) && home && (n.parent === home.name || n.subnet === home.subnet)) || null;
  return { lan, home, networks };
}

async function ensureLanNetwork() {
  const { lan, home, networks } = await findLan();
  if (lan) return lan;
  if (!home) throw httpError('MajaOS can\'t find the network card of your home network (there is no default route). Create a macvlan network yourself in Settings → Docker networks.', 409);
  const name = networks.some((n) => n.name === LAN) ? `${LAN}-${home.name}` : LAN;
  await createNetwork({ name, driver: 'macvlan', subnet: home.subnet, gateway: home.gateway, ipRange: lanRange(home.subnet), parent: home.name });
  return summarize(await docker('GET', '/networks/' + encodeURIComponent(name)));
}

// A free address for a new app: in the network's IP range (or the top /27), not used by another app, not in the server's
// neighbour table and not answering a ping. The server can't reach macvlan apps itself, so those come from the network's list.
async function suggestLanIp(n) {
  const range = parseCidr(n.ipRange || lanRange(n.subnet) || '', 0, 32);
  if (!range) return null;
  const used = new Set((n.containers || []).map((x) => String(x.ip || '').split('/')[0]));
  if (n.gateway) used.add(String(n.gateway).split('/')[0]);
  const neigh = await run('ip', ['-j', 'neigh'], { timeout: 4000 }).then(JSON.parse, () => []);
  for (const x of neigh || []) if (x.dst && x.state && !x.state.includes('FAILED')) used.add(x.dst);
  const size = 2 ** (32 - range.prefix), sub = parseCidr(n.subnet, 0, 32), bcast = (sub.base | ~maskOf(sub.prefix)) >>> 0;
  let pings = 0;
  for (let i = 1; i < size && pings < 8; i++) {
    const num = range.base + i;
    if (num >= bcast) break;
    const ip = numIp(num);
    if (used.has(ip)) continue;
    pings++;
    const r = await run('ping', ['-c', '1', '-W', '1', ip], { timeout: 3000, full: true }).catch(() => ({ code: 1 }));
    if (r.code !== 0) return ip;
  }
  return null;
}

// For the forms: the home network, the own-address network if there is one, and a suggested address.
async function lanInfo() {
  const { lan, home } = await findLan();
  const target = lan || (home ? { subnet: home.subnet, gateway: home.gateway, ipRange: lanRange(home.subnet), containers: [] } : null);
  return { choice: LAN_CHOICE, network: lan ? lan.name : null, home, ipRange: target && (target.ipRange || lanRange(target.subnet)), suggestion: target ? await suggestLanIp(target) : null };
}

module.exports = { listNetworks, createNetwork, deleteNetwork, resolveNetwork, networkFor, formNetwork, ensureMajaNetwork, pickMajaSubnet, checkFreeIp, MAJA,
  ensureLanNetwork, lanInfo, lanRange, suggestLanIp, LAN_CHOICE,
  checkIp, validateNetwork, summarize, parseCidr, overlaps, NAME };
