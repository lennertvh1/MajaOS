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
    compose: labels['com.docker.compose.project'] || null, ours: labels['homebaseos'] === '1',
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
    IPAM: { Driver: 'default', Config: ipam }, Options: options, Labels: { homebaseos: '1' },
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

module.exports = { listNetworks, createNetwork, deleteNetwork, resolveNetwork, checkIp, validateNetwork, summarize, parseCidr, overlaps, NAME };
