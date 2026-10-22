'use strict';
/* Virtuele machines via libvirt: virsh voor beheer, virt-install om aan te maken. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, num, httpError, wait, uptime } = require('./system');
const hw = require('./vmhw');
const vmnet = require('./vmnet');

const CONN = 'qemu:///system';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const RUN_DIR = process.env.RUN_DIR || '/run/homebaseos';
const paths = require('./paths');
// Ingesteld bij Instellingen → Opslag, of automatisch op de eerste pool (vroeger VM_DIR en ISO_DIR).
const VM_DIR = () => paths.shown('vms');
const ISO_DIR = () => paths.shown('isos');
const VM_NETWORK = /^(network|bridge)=[\w.-]+$/.test(process.env.VM_NETWORK || '') ? process.env.VM_NETWORK : 'network=default';
const CFG_FILE = path.join(DATA_DIR, 'vms.json');

const virsh = (args, opts) => run('virsh', ['-c', CONN, ...args], opts);
const STATES = ['NOSTATE', 'RUNNING', 'IDLE', 'PAUSED', 'SHUTDOWN', 'SHUTOFF', 'CRASHED', 'PMSUSPENDED'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,62}$/;
const NAME_HELP = 'Kies een naam van 1 tot 63 tekens: letters, cijfers, spaties en . _ - ( ).';

/* ---- eigen instellingen per VM (automatisch starten + uitstel) */
function readCfg() { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; } }
function writeCfg(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(CFG_FILE + '.tmp', CFG_FILE);
}

/* ---- parsers (los te testen) */
function parseDomstats(text) {
  const out = []; let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^Domain: '(.*)'\s*$/);
    if (m) { cur = { name: m[1] }; out.push(cur); continue; }
    const kv = line.trim().match(/^([\w.]+)=(.*)$/);
    if (kv && cur) cur[kv[1]] = kv[2];
  }
  return out;
}

const xmlUnescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const UNIT = { b: 1, bytes: 1, k: 1024, kib: 1024, kb: 1000, m: 1048576, mib: 1048576, mb: 1e6, g: 1073741824, gib: 1073741824, gb: 1e9 };
function memBytes(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '(?=[\\s>])([^>]*)>(\\d+)</' + tag + '>'));
  if (!m) return null;
  const unit = (attr(m[1], 'unit') || 'KiB').toLowerCase();
  return Number(m[2]) * (UNIT[unit] || 1024);
}
function attr(tag, name) { const m = tag.match(new RegExp('\\b' + name + "=(['\"])(.*?)\\1")); return m ? xmlUnescape(m[2]) : null; }
function setAttrs(tag, values) {
  let t = tag;
  for (const [k, v] of Object.entries(values)) t = t.replace(new RegExp('\\b' + k + "=(['\"])[^'\"]*\\1"), k + "='" + v + "'");
  return t;
}

function parseDomainXml(xml) {
  const name = xml.match(/<name>([\s\S]*?)<\/name>/);
  const vcpu = xml.match(/<vcpu\b([^>]*)>(\d+)<\/vcpu>/);
  const desc = xml.match(/<description>([\s\S]*?)<\/description>/);
  const disks = [];
  for (const m of xml.matchAll(/<disk\b([^>]*)>([\s\S]*?)<\/disk>/g)) {
    const src = m[2].match(/<source\b[^>]*>/), tgt = m[2].match(/<target\b[^>]*>/);
    disks.push({
      device: attr(m[1], 'device') || 'disk',
      source: src ? attr(src[0], 'file') || attr(src[0], 'dev') : null,
      target: tgt ? attr(tgt[0], 'dev') : null, bus: tgt ? attr(tgt[0], 'bus') : null,
    });
  }
  const g = xml.match(/<graphics\b[^>]*type=['"]vnc['"][^>]*>/);
  return {
    name: name ? xmlUnescape(name[1]) : null,
    vcpus: vcpu ? Number(attr(vcpu[1], 'current') || vcpu[2]) : null,
    memory: memBytes(xml, 'currentMemory') || memBytes(xml, 'memory'),
    description: desc ? xmlUnescape(desc[1]) : '',
    firmware: /<os\b[^>]*firmware=['"]efi['"]/.test(xml) || /<loader\b/.test(xml) ? 'uefi' : 'bios',
    disks,
    vnc: g ? { port: num(attr(g[0], 'port')), password: attr(g[0], 'passwd') } : null,
  };
}

// Pas vCPU's, geheugen en beschrijving aan in de domein-XML. De rest blijft ongewijzigd.
function editDomainXml(xml, { vcpus, memory, description }) {
  let out = xml;
  if (memory != null) {
    const kib = Math.round(memory / 1024);
    out = out.replace(/<memory(?=[\s>])[^>]*>\d+<\/memory>/, `<memory unit='KiB'>${kib}</memory>`)
      .replace(/<currentMemory(?=[\s>])[^>]*>\d+<\/currentMemory>/, `<currentMemory unit='KiB'>${kib}</currentMemory>`);
  }
  if (vcpus != null) {
    out = out.replace(/<vcpu\b([^>]*)>\d+<\/vcpu>/, (_, a) => `<vcpu${a.replace(/\s*current=(['"])\d+\1/, '')}>${vcpus}</vcpu>`);
    // Een vaste CPU-topologie moet kloppen met het aantal vCPU's.
    out = out.replace(/<topology\b[^>]*\/>/, (t) => setAttrs(t, { sockets: 1, dies: 1, clusters: 1, cores: vcpus, threads: 1 }));
  }
  if (description != null) {
    const d = description.trim();
    if (/<description>[\s\S]*?<\/description>/.test(out)) {
      out = out.replace(/\s*<description>[\s\S]*?<\/description>/, d ? `\n  <description>${xmlEscape(d)}</description>` : '');
    } else if (d) out = out.replace(/<\/name>/, `</name>\n  <description>${xmlEscape(d)}</description>`);
  }
  return out;
}

// CPU in % van de eigen vCPU's (100% = alle vCPU's volop bezig).
function cpuPercent(prev, cpuTimeNs, now, vcpus) {
  if (!prev || cpuTimeNs == null || !vcpus || now <= prev.at) return null;
  return Math.max(0, Math.min(100, ((cpuTimeNs - prev.t) / ((now - prev.at) * 1e6 * vcpus)) * 100));
}
// Gebruikt geheugen: liefst wat de gast zelf meldt (balloon-driver), anders wat QEMU op de host inneemt.
function memUsed(s, assigned) {
  const avail = num(s['balloon.available']), usable = num(s['balloon.usable']), unused = num(s['balloon.unused']), rss = num(s['balloon.rss']);
  const kib = avail != null && usable != null ? avail - usable : avail != null && unused != null ? avail - unused : rss;
  return kib == null ? null : Math.min(assigned || Infinity, kib * 1024);
}

/* ---- libvirt */
const DOMSTATE = { running: 'RUNNING', idle: 'IDLE', blocked: 'IDLE', paused: 'PAUSED', 'in shutdown': 'SHUTDOWN',
  'shut off': 'SHUTOFF', crashed: 'CRASHED', pmsuspended: 'PMSUSPENDED' };
async function domState(name) {
  try { return DOMSTATE[(await virsh(['domstate', name])).trim().toLowerCase()] || 'NOSTATE'; }
  catch (e) {
    if (/failed to get domain|not found/i.test(e.message)) throw httpError('Deze VM bestaat niet (meer).', 404);
    throw e;
  }
}
const exists = (name) => domState(name).then(() => true, (e) => (e.status === 404 ? false : Promise.reject(e)));

async function define(xml) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'define-' + crypto.randomBytes(4).toString('hex') + '.xml');
  fs.writeFileSync(file, xml, { mode: 0o600 });
  try { await virsh(['define', file]); } finally { fs.rmSync(file, { force: true }); }
}

const xmlCache = new Map(); // naam → { at, info }
async function configInfo(name) {
  const c = xmlCache.get(name);
  if (c && Date.now() - c.at < 60000) return c.info;
  const info = parseDomainXml(await virsh(['dumpxml', '--inactive', name]));
  xmlCache.set(name, { at: Date.now(), info });
  return info;
}

const domstats = async () => parseDomstats(await virsh(['domstats', '--state', '--cpu-total', '--balloon', '--vcpu']));
const prevCpu = new Map(); // naam → { t, at, pct }
const pending = new Map(); // naam → { at, timer }  (wacht op automatisch starten)

// `virsh domifaddr`: per kaart het MAC-adres en de IP-adressen.
function parseDomifaddr(text) {
  return String(text).split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 4 && /^ipv[46]$/.test(c[2]))
    .map(([iface, mac, proto, address]) => ({ iface, mac, proto, address: address.split('/')[0] }));
}
// Bruikbare adressen: geen loopback of link-local; IPv4 eerst.
function usableIps(list) {
  const ok = list.filter((a) => !/^(127\.|169\.254\.|::1$|fe80:)/i.test(a.address) && a.iface !== 'lo');
  return [...new Set([...ok.filter((a) => a.proto === 'ipv4'), ...ok.filter((a) => a.proto === 'ipv6')].map((a) => a.address))];
}
// IP-adressen van een draaiende VM. Eerst de gast-agent (weet alles), dan DHCP van libvirt (NAT), dan de ARP-tabel (bridge).
const ipCache = new Map(); // naam → { at, ips }
async function vmIps(name) {
  const c = ipCache.get(name);
  if (c && Date.now() - c.at < 30000) return c.ips;
  let ips = [];
  for (const source of ['agent', 'lease', 'arp']) {
    const out = await virsh(['domifaddr', name, '--source', source], { timeout: 4000 }).catch(() => '');
    ips = usableIps(parseDomifaddr(out));
    if (ips.length) break;
  }
  ipCache.set(name, { at: Date.now(), ips });
  return ips;
}

async function listVms() {
  let stats = await domstats();
  // Eerste meting voor een draaiende VM: even wachten en opnieuw meten, zodat er meteen een CPU-waarde is.
  const fresh = (p) => p && Date.now() - p.at < 60000;
  if (stats.some((s) => s['state.state'] === '1' && !fresh(prevCpu.get(s.name)))) {
    stats.forEach((s) => { if (s['cpu.time']) prevCpu.set(s.name, { t: Number(s['cpu.time']), at: Date.now(), pct: null }); });
    await wait(500);
    stats = await domstats();
  }
  const [autoNames, infos] = await Promise.all([
    virsh(['list', '--all', '--autostart', '--name']).then((t) => new Set(t.split('\n').map((x) => x.trim()).filter(Boolean)), () => new Set()),
    Promise.all(stats.map((s) => configInfo(s.name).catch(() => ({})))),
  ]);
  const cfg = readCfg(); const now = Date.now();
  const ips = await Promise.all(stats.map((s) => (s['state.state'] === '1' || s['state.state'] === '3' ? vmIps(s.name) : [])));
  return stats.map((s, i) => {
    const state = STATES[Number(s['state.state'])] || 'NOSTATE';
    const info = infos[i];
    const vcpus = num(s['vcpu.current']) || info.vcpus || null;
    const on = state === 'RUNNING' || state === 'IDLE' || state === 'PAUSED';
    const memory = num(s['balloon.current']) ? num(s['balloon.current']) * 1024 : info.memory || null;
    const t = num(s['cpu.time']), prev = prevCpu.get(s.name);
    let cpu = null;
    if (on && prev && now - prev.at < 400) cpu = prev.pct; // twee vragen kort na elkaar: vorige waarde
    else if (on) { cpu = cpuPercent(prev, t, now, vcpus); if (t != null) prevCpu.set(s.name, { t, at: now, pct: cpu }); }
    const c = cfg[s.name] || {};
    const p = pending.get(s.name);
    return {
      id: s.name, name: s.name, state, vcpus, memory,
      memUsed: on ? memUsed(s, memory) : null, cpu: cpu == null ? null : Math.round(cpu * 10) / 10,
      autostart: c.autostart != null ? !!c.autostart : autoNames.has(s.name), delay: c.delay || 0,
      startsAt: p ? p.at : null, description: info.description || '', ips: ips[i],
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function diskInfo(d) {
  try {
    const j = JSON.parse(await run('qemu-img', ['info', '--output=json', '-U', d.source], { timeout: 8000 }));
    return { ...d, size: num(j['virtual-size']), used: num(j['actual-size']), format: j.format };
  } catch { return { ...d, size: null, used: null, format: null }; }
}

async function vmDetails(name) {
  const vm = (await listVms()).find((v) => v.name === name);
  if (!vm) throw httpError('Deze VM bestaat niet (meer).', 404);
  // Opgeslagen instellingen (die gelden bij de volgende start), met het VNC-wachtwoord.
  const xmlFull = await virsh(['dumpxml', '--inactive', '--security-info', name]);
  const info = parseDomainXml(xmlFull);
  let vnc = info.vnc;
  if (vnc) {
    vnc = { ...vnc, port: null };
    if (vm.state !== 'SHUTOFF') {
      const live = parseDomainXml(await virsh(['dumpxml', name]).catch(() => ''));
      if (live.vnc && live.vnc.port > 0) vnc.port = live.vnc.port;
    }
  }
  const h = hw.parseHardware(xmlFull);
  return {
    ...vm, vcpus: info.vcpus, memory: info.memory, description: info.description, firmware: info.firmware, vnc,
    disks: await Promise.all(h.disks.filter((d) => d.source).map(diskInfo)),
    cdroms: h.cdroms.filter((d) => d.source).map((d) => d.source),
    cdromDrive: h.cdroms.length > 0, nics: h.nics, boot: h.boot, hostdevs: h.hostdevs, cpuPins: h.cpuPins, clipboard: h.clipboard,
  };
}

const ACTIONS = { start: 'start', stop: 'shutdown', reboot: 'reboot', pause: 'suspend', resume: 'resume', 'force-stop': 'destroy', reset: 'reset' };
async function vmAction(name, action) {
  await domState(name);
  if (action === 'start' || action === 'force-stop') cancelPending(name);
  await virsh([ACTIONS[action], name], { timeout: 60000 });
}

/* ---- invoer controleren */
function int(v, min, max, label) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw httpError(label + ' moet tussen ' + min + ' en ' + max + ' liggen.', 400);
  return n;
}
function memoryFromGb(v) {
  const maxGb = Math.floor(os.totalmem() / 1073741824);
  const gb = Number(v);
  if (!Number.isFinite(gb) || gb < 0.25 || gb > maxGb) throw httpError('Geheugen moet tussen 0,25 en ' + maxGb + ' GB liggen.', 400);
  return Math.round(gb * 1024) * 1048576; // afgerond op hele MiB
}
function autostartFrom(body) {
  return { autostart: !!body.autostart, delay: body.delay == null || body.delay === '' ? 0 : int(body.delay, 0, 3600, 'Startuitstel') };
}

async function saveSettings(name, body) {
  const state = await domState(name);
  const xml = await virsh(['dumpxml', '--inactive', '--security-info', name]); // met wachtwoorden, anders gaan die verloren
  const cur = parseDomainXml(xml);
  let vcpus = body.vcpus != null ? int(body.vcpus, 1, os.cpus().length, "Het aantal vCPU's") : cur.vcpus;
  const memory = body.memoryGb != null ? memoryFromGb(body.memoryGb) : cur.memory;
  const description = body.description != null ? String(body.description).slice(0, 2000).trim() : cur.description;
  const auto = autostartFrom(body);
  const newName = body.name != null ? String(body.name).trim() : name;
  if (newName !== name) {
    if (!NAME.test(newName)) throw httpError(NAME_HELP, 400);
    if (state !== 'SHUTOFF') throw httpError('Zet de VM eerst uit om de naam te wijzigen.', 409);
    if (await exists(newName)) throw httpError('Er bestaat al een VM met de naam ' + newName + '.', 409);
  }

  // Hardware: netwerk, schijven, cd-rom, opstarten, apparaten en vaste kernen.
  const curHw = hw.parseHardware(xml);
  const hasHw = ['nics', 'boot', 'cdrom', 'hostdevs', 'cpuPins', 'addDisks', 'removeDisks', 'resizeDisks', 'clipboard'].some((k) => body[k] !== undefined);
  const opts = hasHw ? await vmOptions() : null;
  const change = hasHw ? hw.validateHardware(body, opts, curHw) : {};
  if (change.cpuPins && change.cpuPins.length) vcpus = change.cpuPins.length;
  else if (!change.cpuPins && curHw.cpuPins.length && vcpus !== curHw.cpuPins.length) throw httpError('Deze VM heeft vaste kernen. Kies de kernen opnieuw om het aantal vCPU\'s te wijzigen.', 400);
  const disks = hasHw ? await diskChanges(name, body, curHw, state) : { add: [], remove: [], resize: [] };
  if (disks.remove.length) change.removeDisks = disks.remove;
  if (disks.add.length) change.addDisks = disks.add;

  const hwChanged = vcpus !== cur.vcpus || memory !== cur.memory;
  const devChanged = Object.keys(change).some((k) => k !== 'cdrom') || (change.cdrom !== undefined && !(state !== 'SHUTOFF' && curHw.cdroms.length));
  try {
    if (hwChanged || description !== cur.description || Object.keys(change).length) {
      await define(hw.applyHardware(editDomainXml(xml, { vcpus, memory, description }), change));
    }
  } catch (e) {
    disks.add.forEach((d) => fs.rmSync(d.file, { force: true })); // nieuwe schijven weer opruimen
    throw e;
  }
  // Een ISO wisselen kan meteen, ook als de VM draait (bv. tijdens een installatie).
  if (change.cdrom !== undefined && state !== 'SHUTOFF' && curHw.cdroms.length) {
    const tgt = curHw.cdroms[0].target;
    await virsh(change.cdrom ? ['change-media', name, tgt, change.cdrom, '--live', '--insert', '--force'] : ['change-media', name, tgt, '--live', '--eject', '--force']).catch(() => {});
  }
  for (const r of disks.resize) {
    if (state === 'SHUTOFF') await run('qemu-img', ['resize', r.source, r.sizeGb + 'G'], { timeout: 120000 });
    else await virsh(['blockresize', name, r.target, r.sizeGb + 'G']);
  }
  if (newName !== name) await virsh(['domrename', name, newName]);

  const cfg = readCfg(); delete cfg[name]; cfg[newName] = auto; writeCfg(cfg);
  // HomeBaseOS start de VM zelf (met uitstel), dus libvirt mag dat niet ook nog doen.
  await virsh(['autostart', '--disable', newName]).catch(() => {});
  xmlCache.delete(name); xmlCache.delete(newName);
  if (newName !== name) { prevCpu.delete(name); cancelPending(name); }
  return { name: newName, restartNeeded: (hwChanged || devChanged) && state !== 'SHUTOFF' };
}

// Schijven toevoegen, loskoppelen (het bestand blijft staan) of groter maken.
async function diskChanges(name, body, curHw, state) {
  const out = { add: [], remove: [], resize: [] };
  const targets = new Set(curHw.disks.map((d) => d.target));
  for (const t of body.removeDisks || []) {
    if (!targets.has(t)) throw httpError('Deze schijf hoort niet (meer) bij de VM.', 400);
    out.remove.push(t);
  }
  for (const r of body.resizeDisks || []) {
    const d = curHw.disks.find((x) => x.target === r.target);
    if (!d || !d.source || out.remove.includes(r.target)) throw httpError('Deze schijf hoort niet (meer) bij de VM.', 400);
    const sizeGb = int(r.sizeGb, 1, 16384, 'De schijfgrootte (GB)');
    const info = await diskInfo(d);
    if (info.size != null && sizeGb * 1073741824 < info.size) throw httpError(`Een schijf kan alleen groter worden. ${d.target} is nu ${Math.ceil(info.size / 1073741824)} GB.`, 400);
    if (info.size == null || sizeGb * 1073741824 > info.size) out.resize.push({ target: d.target, source: d.source, sizeGb });
  }
  if ((body.addDisks || []).length) {
    if (body.addDisks.length > 4) throw httpError('Voeg maximaal 4 schijven tegelijk toe.', 400);
    if (!fs.existsSync(VM_DIR())) throw httpError('De map voor VM-schijven (' + VM_DIR() + ') bestaat niet. Maak eerst een pool aan bij Opslag, of kies een map bij Instellingen → Opslag.', 503);
    const dir = path.join(VM_DIR(), slugify(name));
    fs.mkdirSync(dir, { recursive: true });
    let n = 2;
    try {
      for (const a of body.addDisks) {
        const sizeGb = int(a.sizeGb, 1, 16384, 'De schijfgrootte (GB)');
        const bus = a.bus === 'sata' ? 'sata' : 'virtio';
        let file; do { file = path.join(dir, slugify(name) + '-' + n++ + '.qcow2'); } while (fs.existsSync(file));
        await run('qemu-img', ['create', '-f', 'qcow2', file, sizeGb + 'G'], { timeout: 60000 });
        out.add.push({ file, bus, format: 'qcow2' });
      }
    } catch (e) { out.add.forEach((d) => fs.rmSync(d.file, { force: true })); throw e; }
  }
  return out;
}

// Poort van het VNC-scherm van een draaiende VM, voor de console in de browser.
async function vncPort(name) {
  const state = await domState(name);
  if (state === 'SHUTOFF') throw httpError('De VM staat uit. Start hem om het scherm te zien.', 409);
  const info = parseDomainXml(await virsh(['dumpxml', name]));
  if (!info.vnc) throw httpError('Deze VM heeft geen VNC-scherm.', 404);
  if (!(info.vnc.port > 0)) throw httpError('Het scherm van deze VM is nog niet klaar. Probeer het zo opnieuw.', 409);
  return info.vnc.port;
}

/* ---- media en aanmaken */
function listDir(dir, re) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && re.test(d.name))
      .map((d) => ({ name: d.name, size: fs.statSync(path.join(dir, d.name)).size })).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return null; }
}
// Alles wat je in de VM-formulieren kan kiezen: bestanden, netwerken en de hardware van de server.
async function vmOptions() {
  const isos = listDir(ISO_DIR(), /\.iso$/i);
  const [nets, usb, pci] = await Promise.all([
    vmnet.listVmNetworks().catch(() => ({ networks: [], bridges: [] })), hw.usbDevices(), hw.pciDevices()]);
  return {
    isos: isos || [], images: listDir(ISO_DIR(), /\.(qcow2|img|raw|vmdk|vhdx|vdi)$/i) || [],
    isoDir: ISO_DIR(), isoDirMissing: isos === null, vmDir: VM_DIR(), vmDirMissing: !fs.existsSync(VM_DIR()),
    network: VM_NETWORK.replace('=', ':'), maxVcpus: os.cpus().length, maxMemory: os.totalmem(),
    networks: nets.networks.map((n) => ({ name: n.name, mode: n.mode, subnet: n.subnet, active: n.active })),
    bridges: nets.bridges.map((b) => ({ name: b.name, address: b.address })),
    usb, pci: pci.pci, iommu: pci.iommu, cpus: hw.cpuTopology(),
  };
}

const KINDS = {
  linux: { osinfo: 'linux2022', bus: 'virtio', nic: 'virtio' },
  windows: { osinfo: 'win11', bus: 'sata', nic: 'e1000e', tpm: true }, // de Windows-installer kent virtio niet
  import: { osinfo: 'linux2022', bus: 'virtio', nic: 'virtio' },
};
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vm';

async function createVm(body) {
  const name = String(body.name || '').trim();
  if (!NAME.test(name)) throw httpError(NAME_HELP, 400);
  const kind = KINDS[body.kind];
  if (!kind) throw httpError('Kies Linux, Windows 11 of een bestaande schijf.', 400);
  const vcpus = int(body.vcpus, 1, os.cpus().length, "Het aantal vCPU's");
  const memory = memoryFromGb(body.memoryGb);
  const diskGb = body.kind === 'import' ? null : int(body.diskGb, 4, 16384, 'De schijfgrootte (GB)');
  const auto = autostartFrom(body);
  const opts = await vmOptions();
  // Netwerk: "network:default" (libvirt-netwerk) of "bridge:br0" (bridge van de server).
  const [ntype, nsrc] = String(body.network || opts.network).split(':');
  if (!(ntype === 'network' ? opts.networks : ntype === 'bridge' ? opts.bridges : []).some((x) => x.name === nsrc)) {
    throw httpError('Kies een netwerk voor de VM.', 400);
  }
  const source = String(body.source || '');
  const choices = body.kind === 'import' ? opts.images : opts.isos;
  if (!choices.some((f) => f.name === source)) {
    throw httpError(body.kind === 'import' ? 'Kies een schijfbestand uit ' + ISO_DIR() + '.' : 'Kies een installatie-ISO uit ' + ISO_DIR() + '.', 400);
  }
  if (opts.vmDirMissing) throw httpError('De map voor VM-schijven (' + VM_DIR() + ') bestaat niet. Maak eerst een pool aan bij Opslag, of kies een map bij Instellingen → Opslag.', 503);
  if (await exists(name)) throw httpError('Er bestaat al een VM met de naam ' + name + '.', 409);

  const dir = path.join(VM_DIR(), slugify(name));
  const disk = path.join(dir, slugify(name) + '.qcow2');
  if (fs.existsSync(disk)) throw httpError('Er staat al een schijfbestand op ' + disk + '. Kies een andere naam of ruim dat bestand op.', 409);
  fs.mkdirSync(dir, { recursive: true });

  const password = crypto.randomBytes(6).toString('base64url').slice(0, 8); // VNC kent maximaal 8 tekens
  const src = path.join(ISO_DIR(), source);
  const args = ['--connect', CONN, '--name', name, '--memory', String(memory / 1048576), '--vcpus', String(vcpus),
    '--cpu', 'host-passthrough', '--osinfo', kind.osinfo, '--boot', 'uefi', '--network', ntype + '=' + nsrc + ',model=' + kind.nic,
    '--graphics', 'vnc,listen=0.0.0.0,password=' + password, '--noautoconsole'];
  if (kind.tpm) args.push('--tpm', 'emulator');
  try {
    if (body.kind === 'import') {
      // Kopie maken, zodat het originele bestand onaangeroerd blijft.
      await run('qemu-img', ['convert', '-O', 'qcow2', src, disk], { timeout: 60 * 60000 });
      args.push('--import', '--disk', `path=${disk},format=qcow2,bus=${kind.bus}`);
    } else {
      args.push('--cdrom', src, '--disk', `path=${disk},size=${diskGb},format=qcow2,bus=${kind.bus}`);
    }
    await run('virt-install', args, { timeout: 180000 });
  } catch (e) {
    if (!(await exists(name).catch(() => true))) { fs.rmSync(disk, { force: true }); try { fs.rmdirSync(dir); } catch { /* niet leeg */ } }
    throw httpError('Aanmaken mislukt: ' + e.message, e.status || 502);
  }

  const description = String(body.description || '').slice(0, 2000).trim();
  if (description) await virsh(['desc', name, '--config', '--live', '--new-desc', description]).catch(() => {});
  // Laat de balloon-driver elke 5 s melden hoeveel geheugen de gast echt gebruikt.
  await virsh(['dommemstat', name, '--period', '5', '--config', '--live']).catch(() => {});
  await virsh(['autostart', '--disable', name]).catch(() => {});
  const cfg = readCfg(); cfg[name] = auto; writeCfg(cfg);
  return { name, disk };
}

async function deleteVm(name, removeDisks) {
  if ((await domState(name)) !== 'SHUTOFF') throw httpError('Zet de VM eerst uit. Daarna kan je hem verwijderen.', 409);
  const info = parseDomainXml(await virsh(['dumpxml', '--inactive', name]));
  await virsh(['undefine', '--nvram', '--snapshots-metadata', name]);
  cancelPending(name); xmlCache.delete(name); prevCpu.delete(name);
  const cfg = readCfg(); delete cfg[name]; writeCfg(cfg);

  const removed = [], kept = [];
  if (removeDisks) {
    for (const d of info.disks.filter((x) => x.device === 'disk' && x.source)) {
      const p = path.resolve(d.source);
      // Alleen bestanden binnen VM_DIR wissen; al de rest blijft staan.
      if (!p.startsWith(VM_DIR() + path.sep)) { kept.push(p); continue; }
      try {
        fs.rmSync(p, { force: true }); removed.push(p);
        if (path.dirname(p) !== VM_DIR()) { try { fs.rmdirSync(path.dirname(p)); } catch { /* map niet leeg */ } }
      } catch { kept.push(p); }
    }
  }
  return { removed, kept };
}

/* ---- automatisch starten met uitstel na het opstarten van de server */
function cancelPending(name) { const p = pending.get(name); if (p) { clearTimeout(p.timer); pending.delete(name); } }

function bootAutostart(log = console.log) {
  // Het merkteken staat in /run en verdwijnt dus pas bij een herstart van de server.
  const marker = path.join(RUN_DIR, 'autostart-gedaan');
  if (fs.existsSync(marker)) return;
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); fs.writeFileSync(marker, new Date().toISOString()); } catch { /* toch verder */ }
  const up = uptime() || 0;
  if (up > 15 * 60) return; // niet net opgestart, bv. na een installatie of update
  for (const [name, c] of Object.entries(readCfg())) {
    if (!c.autostart) continue;
    const ms = Math.max(0, (c.delay || 0) - up) * 1000; // uitstel telt vanaf het opstarten van de server
    const timer = setTimeout(async () => {
      pending.delete(name);
      try {
        if ((await domState(name)) === 'SHUTOFF') { await virsh(['start', name], { timeout: 60000 }); log('VM automatisch gestart: ' + name); }
      } catch (e) { log('VM ' + name + ' automatisch starten mislukt: ' + e.message); }
    }, ms);
    pending.set(name, { at: Date.now() + ms, timer });
  }
  if (pending.size) log('Automatisch starten gepland voor ' + pending.size + ' VM(s).');
}

module.exports = {
  listVms, vmDetails, vmAction, saveSettings, createVm, deleteVm, vmOptions, bootAutostart, vncPort,
  parseDomstats, parseDomainXml, editDomainXml, cpuPercent, memUsed, slugify, parseDomifaddr, usableIps,
};
