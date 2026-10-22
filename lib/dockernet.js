'use strict';
/* Docker-netwerken: eigen bridges (apps vinden elkaar op naam) en macvlan/ipvlan (een eigen adres in je thuisnetwerk, zoals br0 in Unraid). */
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
// "192.168.1.7/24" → { base, prefix, text: "192.168.1.0/24" }. min/max: toegelaten lengte van het netmasker.
function parseCidr(s, min = 8, max = 30) {
  const [ip, p] = String(s || '').trim().split('/');
  if (!net.isIPv4(ip) || !/^\d{1,2}$/.test(p || '') || Number(p) < min || Number(p) > max) return null;
  const prefix = Number(p), base = (ipNum(ip) & maskOf(prefix)) >>> 0;
  return { base, prefix, text: numIp(base) + '/' + prefix };
}
const contains = (c, ip) => ((ipNum(ip) & maskOf(c.prefix)) >>> 0) === c.base;
const overlaps = (a, b) => { const m = maskOf(Math.min(a.prefix, b.prefix)); return ((a.base & m) >>> 0) === ((b.base & m) >>> 0); };

// Uitvoer van GET /networks/<id> vereenvoudigen.
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

// Netwerkkaarten en bridges van de server, met hun subnet en gateway om het formulier vooraf in te vullen.
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

// Controleer het formulier en maak er de body van POST /networks/create van.
function validateNetwork(f, { parents: par = [], existing = [] } = {}) {
  const name = String(f.name || '').trim();
  if (!NAME.test(name)) throw httpError('Kies een naam met letters, cijfers, -, _ of . (maximaal 63 tekens), bv. thuisnet.', 400);
  if (BUILTIN.has(name) || existing.some((n) => n.name === name)) throw httpError(`Er bestaat al een netwerk met de naam ${name}. Kies een andere naam.`, 409);
  const driver = String(f.driver || 'bridge');
  if (!DRIVERS.includes(driver)) throw httpError('Kies een soort netwerk: bridge, macvlan of ipvlan.', 400);
  const own = driver !== 'bridge';

  const subnetText = String(f.subnet || '').trim();
  const subnet = subnetText ? parseCidr(subnetText) : null;
  if (subnetText && !subnet) throw httpError(`"${subnetText}" is geen geldig subnet. Schrijf het als 192.168.1.0/24.`, 400);
  if (own && !subnet) throw httpError('Vul het subnet van je thuisnetwerk in, bv. 192.168.1.0/24.', 400);

  const gateway = String(f.gateway || '').trim();
  if (gateway && !net.isIPv4(gateway)) throw httpError(`"${gateway}" is geen geldig IP-adres voor de gateway.`, 400);
  if (gateway && !subnet) throw httpError('Vul ook het subnet in als je een gateway kiest.', 400);
  if (gateway && !contains(subnet, gateway)) throw httpError(`De gateway ${gateway} ligt niet in het subnet ${subnet.text}.`, 400);
  if (own && !gateway) throw httpError('Vul de gateway in, meestal het adres van je router (bv. 192.168.1.1).', 400);

  const rangeText = String(f.ipRange || '').trim();
  const range = rangeText ? parseCidr(rangeText, 8, 32) : null;
  if (rangeText && !range) throw httpError(`"${rangeText}" is geen geldig IP-bereik. Schrijf het als 192.168.1.192/27.`, 400);
  if (range && !subnet) throw httpError('Vul ook het subnet in als je een IP-bereik kiest.', 400);
  if (range && !(range.prefix >= subnet.prefix && contains(subnet, numIp(range.base)))) throw httpError(`Het IP-bereik ${range.text} ligt niet in het subnet ${subnet.text}.`, 400);

  let parent = null;
  if (own) {
    parent = String(f.parent || '');
    if (!par.some((p) => p.name === parent)) throw httpError('Kies de netwerkkaart (of bridge) die met je thuisnetwerk verbonden is.', 400);
  }
  if (subnet) {
    const clash = existing.find((n) => n.subnet && parseCidr(n.subnet, 0, 32) && overlaps(subnet, parseCidr(n.subnet, 0, 32)));
    if (clash) throw httpError(`Het subnet ${subnet.text} overlapt met het netwerk ${clash.name} (${clash.subnet}). Kies een ander subnet.`, 409);
    // Een bridge in het subnet van je thuisnetwerk maakt de server onbereikbaar voor dat netwerk.
    const lan = !own && par.find((p) => p.subnet && overlaps(subnet, parseCidr(p.subnet, 0, 32)));
    if (lan) throw httpError(`Het subnet ${subnet.text} is het netwerk van ${lan.name}. Een bridge heeft een eigen subnet nodig, bv. 172.30.0.0/24. Kies macvlan of ipvlan voor adressen in je thuisnetwerk.`, 409);
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
    if (/overlaps/i.test(e.message)) throw httpError('Dit subnet overlapt met een ander netwerk. Kies een ander subnet.', 409);
    if (/already using parent interface/i.test(e.message)) throw httpError(`Er is al een ${spec.Driver}-netwerk op ${spec.Options.parent}. Gebruik dat netwerk voor al je apps met een eigen adres.`, 409);
    throw httpError('Docker kon het netwerk niet aanmaken: ' + e.message, e.status || 502);
  }
}

async function deleteNetwork(name) {
  const n = summarize(await docker('GET', '/networks/' + encodeURIComponent(name)));
  if (n.builtin) throw httpError(`Het netwerk ${n.name} hoort bij Docker zelf en kan je niet verwijderen.`, 400);
  if (n.containers.length) throw httpError(`Het netwerk ${n.name} wordt nog gebruikt door ${n.containers.map((c) => c.name).join(', ')}. Haal die apps er eerst uit.`, 409);
  await docker('DELETE', '/networks/' + encodeURIComponent(n.id));
  return { removed: n.name };
}

// Voor de appstore: wat betekent de gekozen netwerknaam? (host/none/bridge, of een bestaand eigen netwerk)
async function resolveNetwork(name) {
  const v = String(name || 'bridge');
  if (v === 'host' || v === 'none' || v === 'bridge') return { mode: v, name: null, ownIp: false, subnet: null };
  if (!NAME.test(v)) throw httpError('Kies een netwerk uit de lijst.', 400);
  let n;
  try { n = summarize(await docker('GET', '/networks/' + encodeURIComponent(v))); }
  catch { throw httpError(`Het netwerk ${v} bestaat niet. Maak het aan bij Instellingen → Docker-netwerken of kies een ander netwerk.`, 400); }
  return { mode: 'custom', name: n.name, ownIp: n.driver === 'macvlan' || n.driver === 'ipvlan', subnet: n.subnet };
}
// Een vast adres moet in het subnet van het netwerk liggen.
function checkIp(ip, subnet) {
  const v = String(ip || '').trim();
  if (!v) return '';
  if (!net.isIPv4(v)) throw httpError(`"${v}" is geen geldig IP-adres.`, 400);
  const c = subnet && parseCidr(subnet, 0, 32);
  if (!c) throw httpError('Een vast IP-adres kan alleen in een netwerk met een eigen subnet.', 400);
  if (!contains(c, v)) throw httpError(`Het adres ${v} ligt niet in het subnet ${c.text} van dit netwerk.`, 400);
  return v;
}

module.exports = { listNetworks, createNetwork, deleteNetwork, resolveNetwork, checkIp, validateNetwork, summarize, parseCidr, overlaps, NAME };
