'use strict';
/* Networks for VMs: libvirt networks (NAT or isolated) and the bridges of the server (like br0). */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, httpError } = require('./system');
const X = require('./xml');
const { summarizeLinks } = require('./network');
const { parseCidr, overlaps } = require('./dockernet');
const { parseHardware } = require('./vmhw');

const CONN = 'qemu:///system';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const virsh = (args, opts) => run('virsh', ['-c', CONN, ...args], opts);
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,31}$/;
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map((c) => parseCidr(c, 8, 16));
const ipOf = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

// `virsh net-dumpxml`
function parseNetXml(xml) {
  const n = X.parseXml(xml);
  const fwd = X.child(n, 'forward'), ip = X.child(n, 'ip'), br = X.child(n, 'bridge'), range = ip && X.find(ip, 'dhcp/range');
  const address = X.attr(ip, 'address');
  const prefix = X.attr(ip, 'prefix') != null ? Number(X.attr(ip, 'prefix'))
    : X.attr(ip, 'netmask') ? X.attr(ip, 'netmask').split('.').reduce((s, o) => s + ((Number(o) >>> 0).toString(2).match(/1/g) || []).length, 0) : null;
  const c = address && prefix != null ? parseCidr(address + '/' + prefix, 0, 32) : null;
  return {
    name: X.text(X.child(n, 'name')), mode: fwd ? X.attr(fwd, 'mode') || 'nat' : 'isolated',
    bridge: X.attr(br, 'name'), hostBridge: fwd && X.attr(fwd, 'mode') === 'bridge' ? X.attr(br, 'name') : null,
    address: address || null, subnet: c ? c.text : null,
    dhcp: range ? { start: X.attr(range, 'start'), end: X.attr(range, 'end') } : null,
  };
}

// New network: the server gets the first address, DHCP hands out the second half.
function buildNetXml({ name, mode, subnet, dhcp }) {
  const c = parseCidr(subnet, 16, 28);
  const size = 2 ** (32 - c.prefix);
  const net = X.E('network', {}, [X.E('name', {}, name), ...(mode === 'nat' ? [X.E('forward', { mode: 'nat' })] : []),
    X.E('bridge', { stp: 'on', delay: '0' }),
    X.E('ip', { address: ipOf(c.base + 1), prefix: c.prefix }, dhcp ? [X.E('dhcp', {}, [X.E('range', { start: ipOf(c.base + size / 2), end: ipOf(c.base + size - 2) })])] : [])]);
  return X.toXml(X.pretty(net, '\n'));
}

function validateNet(body, { existing, hostSubnets }) {
  const name = String(body.name || '').trim();
  if (!NAME.test(name)) throw httpError('Choose a name with letters, digits, -, _ or . (at most 32 characters), e.g. lab.', 400);
  if (existing.some((n) => n.name === name)) throw httpError(`A VM network named ${name} already exists. Choose another name.`, 409);
  const mode = body.mode === 'isolated' ? 'isolated' : 'nat';
  const text = String(body.subnet || '').trim();
  const c = parseCidr(text, 16, 28);
  if (!c) throw httpError(`"${text}" is not a valid subnet. Choose something like 192.168.150.0/24 (netmask between /16 and /28).`, 400);
  if (!PRIVATE.some((p) => overlaps(p, c) && c.prefix >= p.prefix)) throw httpError('Choose a private subnet: 10.x.x.x, 172.16–31.x.x or 192.168.x.x.', 400);
  const clash = existing.find((n) => n.subnet && overlaps(c, parseCidr(n.subnet, 0, 32))) || hostSubnets.find((s) => overlaps(c, parseCidr(s.subnet, 0, 32)));
  if (clash) throw httpError(`The subnet ${c.text} overlaps with ${clash.name} (${clash.subnet}). Choose another subnet.`, 409);
  return { name, mode, subnet: c.text, dhcp: body.dhcp !== false };
}

/* ---- libvirt */

async function domainNics() {
  const names = (await virsh(['list', '--all', '--name']).catch(() => '')).split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  await Promise.all(names.map(async (vm) => {
    try { parseHardware(await virsh(['dumpxml', '--inactive', vm])).nics.forEach((n) => out.push({ vm, ...n })); } catch { /* VM just gone */ }
  }));
  return out;
}
async function hostLinks() {
  const [addrs, routes] = await Promise.all([run('ip', ['-j', '-d', 'addr'], { timeout: 5000 }).then(JSON.parse, () => []),
    run('ip', ['-j', 'route', 'show', 'default'], { timeout: 5000 }).then(JSON.parse, () => [])]);
  // All subnets on the server (also docker0 and virbr), to avoid overlap.
  const hostSubnets = addrs.flatMap((l) => (l.addr_info || []).filter((a) => a.family === 'inet' && a.scope !== 'host')
    .map((a) => ({ name: l.ifname, subnet: parseCidr(a.local + '/' + a.prefixlen, 0, 32).text })));
  const bridges = summarizeLinks(addrs, routes).filter((l) => l.kind === 'bridge').map((l) => ({ name: l.name, address: l.ipv4[0] ? l.ipv4[0].address : null, up: l.up }));
  return { hostSubnets, bridges };
}

const yes = (text, key) => new RegExp('^' + key + ':\\s+yes', 'mi').test(text);
async function listVmNetworks() {
  const names = (await virsh(['net-list', '--all', '--name'])).split('\n').map((s) => s.trim()).filter(Boolean);
  const [nets, nics, host] = await Promise.all([
    Promise.all(names.map(async (name) => {
      const [xml, info] = await Promise.all([virsh(['net-dumpxml', name]), virsh(['net-info', name]).catch(() => '')]);
      return { ...parseNetXml(xml), active: yes(info, 'Active'), autostart: yes(info, 'Autostart') };
    })),
    domainNics(), hostLinks(),
  ]);
  const usedBy = (type, name) => [...new Set(nics.filter((n) => n.type === type && n.source === name).map((n) => n.vm))].sort();
  return {
    networks: nets.map((n) => ({ ...n, builtin: n.name === 'default', vms: usedBy('network', n.name) })).sort((a, b) => (b.builtin - a.builtin) || a.name.localeCompare(b.name)),
    bridges: host.bridges.map((b) => ({ ...b, vms: usedBy('bridge', b.name) })),
  };
}

async function createVmNetwork(body) {
  const [{ networks }, host] = await Promise.all([listVmNetworks(), hostLinks()]);
  const cfg = validateNet(body, { existing: networks, hostSubnets: host.hostSubnets });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'net-' + crypto.randomBytes(4).toString('hex') + '.xml');
  fs.writeFileSync(file, buildNetXml(cfg));
  try { await virsh(['net-define', file]); } finally { fs.rmSync(file, { force: true }); }
  await virsh(['net-autostart', cfg.name]);
  await virsh(['net-start', cfg.name]);
  return { name: cfg.name };
}

async function deleteVmNetwork(name) {
  const { networks } = await listVmNetworks();
  const n = networks.find((x) => x.name === name);
  if (!n) throw httpError('This VM network no longer exists.', 404);
  if (n.vms.length) throw httpError(`The VM network ${name} is still used by ${n.vms.join(', ')}. Choose another network for those VMs first.`, 409);
  if (n.active) await virsh(['net-destroy', name]);
  await virsh(['net-undefine', name]);
  return { removed: name };
}

async function startVmNetwork(name) {
  const { networks } = await listVmNetworks();
  if (!networks.some((x) => x.name === name)) throw httpError('This VM network no longer exists.', 404);
  await virsh(['net-start', name]).catch((e) => { if (!/already active/i.test(e.message)) throw e; });
  await virsh(['net-autostart', name]).catch(() => {});
  return { ok: true };
}

module.exports = { listVmNetworks, createVmNetwork, deleteVmNetwork, startVmNetwork, parseNetXml, buildNetXml, validateNet, hostLinks };
