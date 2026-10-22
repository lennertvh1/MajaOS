'use strict';
/*
 * Compose-bestand als formulier, zoals het containerformulier van Unraid.
 * docker compose leest het bestand zelf (config --format json), zodat elke YAML-vorm werkt.
 * We bewerken alleen de dienst van deze app; alles wat het formulier niet kent, blijft ongewijzigd.
 */
const net = require('node:net');
const { run, httpError } = require('./system');

async function loadProject(c) {
  const out = await run('docker', ['compose', '-p', c.project, '--project-directory', c.workingDir, '-f', c.file,
    'config', '--no-interpolate', '--no-normalize', '--no-path-resolution', '--format', 'json'], { timeout: 30000 });
  return JSON.parse(out);
}

const str = (v) => (v == null ? '' : String(v));
const RESTARTS = ['unless-stopped', 'always', 'on-failure', 'no'];

/* ---- lezen: compose-dienst → formulier */

function parsePort(p) {
  if (p && typeof p === 'object') {
    const known = new Set(['mode', 'target', 'published', 'protocol', 'host_ip']);
    // mode: host (rechtstreeks op de kaart van de server) kan het formulier ook bewaren; alleen onbekende sleutels zijn geavanceerd.
    const locked = Object.keys(p).some((k) => !known.has(k)) || (p.mode && !['ingress', 'host'].includes(p.mode));
    return { host: str(p.published), container: str(p.target), protocol: p.protocol || 'tcp', ip: str(p.host_ip), mode: p.mode === 'host' ? 'host' : '', locked, raw: p };
  }
  const s = String(p); const [spec, proto = 'tcp'] = s.split('/');
  const parts = spec.split(':');
  if (parts.length === 1) return { host: '', container: parts[0], protocol: proto, ip: '' };
  if (parts.length === 2) return { host: parts[0], container: parts[1], protocol: proto, ip: '' };
  if (parts.length === 3) return { host: parts[1], container: parts[2], protocol: proto, ip: parts[0] };
  return { host: '', container: s, protocol: proto, ip: '', locked: true, raw: p };
}

function parseVolume(v) {
  if (v && typeof v === 'object') {
    const simpleBind = v.type === 'bind' && !(v.bind && (v.bind.propagation || v.bind.selinux)) &&
      Object.keys(v).every((k) => ['type', 'source', 'target', 'read_only', 'bind'].includes(k));
    const simpleVol = v.type === 'volume' && Object.keys(v).every((k) => ['type', 'source', 'target', 'read_only', 'volume'].includes(k)) &&
      !(v.volume && Object.keys(v.volume).length);
    return { host: str(v.source), container: str(v.target), mode: v.read_only ? 'ro' : 'rw', kind: v.type, locked: !(simpleBind || simpleVol), raw: v };
  }
  const parts = String(v).split(':');
  const mode = parts.length > 2 ? parts[2] : 'rw';
  return { host: parts.length > 1 ? parts[0] : '', container: parts.length > 1 ? parts[1] : parts[0], mode: mode === 'ro' ? 'ro' : 'rw',
    kind: parts.length > 1 && parts[0].startsWith('/') ? 'bind' : 'volume', locked: !['ro', 'rw'].includes(mode) || parts.length < 2, raw: v };
}

function parseDevice(d) {
  if (d && typeof d === 'object') return { host: str(d.source), container: str(d.target || d.source), perm: d.permissions && d.permissions !== 'rwm' ? d.permissions : '' };
  const [host, container, perm] = String(d).split(':');
  return { host, container: container || host, perm: perm || '' };
}

function pairs(obj) {
  if (Array.isArray(obj)) return obj.map((s) => { const i = String(s).indexOf('='); return i < 0 ? { name: String(s), value: '', unset: true } : { name: s.slice(0, i), value: s.slice(i + 1) }; });
  return Object.entries(obj || {}).map(([name, value]) => (value == null ? { name, value: '', unset: true } : { name, value: String(value) }));
}

const netMap = (svc) => (Array.isArray(svc.networks) ? Object.fromEntries(svc.networks.map((n) => [n, null])) : svc.networks && typeof svc.networks === 'object' ? svc.networks : {});
// network: '' (standaard), host, none, de naam van één eigen netwerk, of * (meerdere: blijven zoals ze zijn).
function netOf(svc) {
  if (svc.network_mode === 'host' || svc.network_mode === 'none') return { network: svc.network_mode, ip: '' };
  const nets = Object.keys(netMap(svc)).filter((n) => n !== 'default');
  if (nets.length > 1 || (nets.length === 1 && Object.keys(netMap(svc)).length > 1)) return { network: '*', ip: '' };
  if (!nets.length) return { network: '', ip: '' };
  const cfg = netMap(svc)[nets[0]];
  return { network: nets[0], ip: str(cfg && typeof cfg === 'object' ? cfg.ipv4_address : '') };
}

function serviceForm(project, service) {
  const svc = project.services && project.services[service];
  if (!svc) throw httpError('De dienst ' + service + ' staat niet in het compose-bestand.', 400);
  const nets = Object.keys(netMap(svc)).filter((n) => n !== 'default');
  return {
    service, image: str(svc.image), restart: str(svc.restart), privileged: !!svc.privileged,
    ...netOf(svc),
    networkOther: svc.network_mode && !['host', 'none'].includes(svc.network_mode) ? svc.network_mode : null,
    networks: nets,
    // Netwerken die bovenaan het bestand staan: sleutel in het bestand → naam in Docker.
    projectNetworks: Object.entries(project.networks || {}).filter(([k]) => k !== 'default')
      .map(([key, v]) => ({ key, name: (v && v.name) || (v && v.external ? key : project.name + '_' + key), external: !!(v && v.external) })),
    ports: (svc.ports || []).map(parsePort), volumes: (svc.volumes || []).map(parseVolume),
    env: pairs(svc.environment), devices: (svc.devices || []).map(parseDevice), labels: pairs(svc.labels),
    build: !!svc.build, otherServices: Object.keys(project.services).filter((s) => s !== service),
  };
}

/* ---- schrijven: formulier → compose-dienst */

const PORT = /^\d{1,5}(-\d{1,5})?$/;
const NET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const ENVNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
function applyServiceForm(project, f) {
  const svc = project.services && project.services[f.service];
  if (!svc) throw httpError('De dienst ' + f.service + ' staat niet (meer) in het compose-bestand.', 400);
  const out = { ...svc };
  const image = str(f.image).trim();
  if (!image && !svc.build) throw httpError('Vul het image in, bv. lscr.io/linuxserver/jellyfin:latest.', 400);
  if (image) out.image = image; else delete out.image;
  if (f.restart && !RESTARTS.includes(f.restart)) throw httpError('Onbekend herstartbeleid.', 400);
  if (f.restart) out.restart = f.restart; else delete out.restart;
  if (f.privileged) out.privileged = true; else delete out.privileged;
  let topNetworks = project.networks;
  const before = netOf(svc), network = str(f.network), ip = str(f.ip).trim();
  const netChanged = !(f.networkOther || (network === before.network && ip === before.ip) || network === '*');
  if (!netChanged) { /* ongewijzigd */ }
  else if (network === 'host' || network === 'none') { out.network_mode = network; delete out.networks; }
  else {
    if (['host', 'none'].includes(svc.network_mode)) delete out.network_mode;
    if (!network) delete out.networks;
    else {
      if (!NET_NAME.test(network)) throw httpError(`"${network}" is geen geldige naam voor een netwerk.`, 400);
      if (ip && !net.isIPv4(ip)) throw httpError(`"${ip}" is geen geldig IP-adres.`, 400);
      const prev = netMap(svc)[network];
      const conf = prev && typeof prev === 'object' ? { ...prev } : {};
      if (ip) conf.ipv4_address = ip; else delete conf.ipv4_address;
      out.networks = { [network]: Object.keys(conf).length ? conf : null };
      // Een netwerk dat niet in het bestand staat, is een bestaand Docker-netwerk (external).
      if (!topNetworks || !(network in topNetworks)) topNetworks = { ...topNetworks, [network]: { external: true } };
    }
  }

  const ports = (f.ports || []).map((p) => {
    if (p.locked) return p.raw;
    const host = str(p.host).trim(), container = str(p.container).trim(), proto = p.protocol === 'udp' ? 'udp' : 'tcp';
    if (!PORT.test(container)) throw httpError(`Poort in de app "${container}" is geen geldige poort.`, 400);
    if (host && !PORT.test(host)) throw httpError(`Poort op de server "${host}" is geen geldige poort.`, 400);
    if (p.mode === 'host') {
      // Lange schrijfwijze behouden, anders gaat mode: host verloren.
      const out = { mode: 'host', target: /^\d+$/.test(container) ? Number(container) : container, protocol: proto };
      if (host) out.published = host;
      if (p.ip) out.host_ip = p.ip;
      return out;
    }
    return (p.ip ? p.ip + ':' : '') + (host ? host + ':' : '') + container + '/' + proto;
  });
  const volumes = (f.volumes || []).map((v) => {
    if (v.locked) return v.raw;
    const host = str(v.host).trim(), container = str(v.container).trim();
    if (!container.startsWith('/')) throw httpError(`De map in de app "${container}" moet met / beginnen.`, 400);
    if (!host) throw httpError(`Vul de map op de server in voor ${container}.`, 400);
    if (/[\n:]/.test(host + container)) throw httpError(`Een map mag geen : of regeleinde bevatten (${host}).`, 400);
    return host + ':' + container + (v.mode === 'ro' ? ':ro' : '');
  });
  const devices = (f.devices || []).map((d) => {
    const host = str(d.host).trim(), container = str(d.container).trim() || host;
    if (!/^\/dev\/\S+$/.test(host)) throw httpError(`Een apparaat begint met /dev/, bv. /dev/dri (niet "${host}").`, 400);
    return host + ':' + container + (d.perm ? ':' + d.perm : '');
  });
  const map = (list, label) => {
    const o = {};
    for (const e of list || []) {
      const name = str(e.name).trim();
      if (!name) continue;
      if (label === 'variabele' && !ENVNAME.test(name)) throw httpError(`"${name}" is geen geldige naam voor een variabele.`, 400);
      if (name in o) throw httpError(`De ${label} ${name} staat er twee keer in.`, 400);
      o[name] = e.unset && e.value === '' ? null : str(e.value);
    }
    return o;
  };
  const env = map(f.env, 'variabele'), labels = map(f.labels, 'label');
  const set = (k, v, empty) => { if (empty) delete out[k]; else out[k] = v; };
  set('ports', ports, !ports.length);
  set('volumes', volumes, !volumes.length);
  set('devices', devices, !devices.length);
  set('environment', env, !Object.keys(env).length);
  set('labels', labels, !Object.keys(labels).length);
  const services = { ...project.services, [f.service]: out };
  const result = { ...project, services };
  if (netChanged && topNetworks) {
    // Externe netwerken die geen enkele dienst nog gebruikt, halen we weg.
    const used = new Set(Object.values(services).flatMap((x) => Object.keys(netMap(x))));
    const kept = Object.fromEntries(Object.entries(topNetworks).filter(([k, v]) => used.has(k) || !(v && v.external && Object.keys(v).length === 1)));
    if (Object.keys(kept).length) result.networks = kept; else delete result.networks;
  }
  return result;
}

module.exports = { loadProject, serviceForm, applyServiceForm, parsePort, parseVolume, parseDevice };
