'use strict';
/* Virtual machines via libvirt: virsh for management, virt-install to create them. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, num, httpError, wait, uptime } = require('./system');
const hw = require('./vmhw');
const vmnet = require('./vmnet');

const CONN = 'qemu:///system';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const RUN_DIR = process.env.RUN_DIR || '/run/majaos';
const paths = require('./paths');
// Set in Settings → Storage, or automatically on the first pool (previously VM_DIR and ISO_DIR).
const VM_DIR = () => paths.shown('vms');
const ISO_DIR = () => paths.shown('isos');
const VM_NETWORK = /^(network|bridge)=[\w.-]+$/.test(process.env.VM_NETWORK || '') ? process.env.VM_NETWORK : 'network=default';
const CFG_FILE = path.join(DATA_DIR, 'vms.json');

const virsh = (args, opts) => run('virsh', ['-c', CONN, ...args], opts);
const STATES = ['NOSTATE', 'RUNNING', 'IDLE', 'PAUSED', 'SHUTDOWN', 'SHUTOFF', 'CRASHED', 'PMSUSPENDED'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,62}$/;
const NAME_HELP = 'Choose a name of 1 to 63 characters: letters, digits, spaces and . _ - ( ).';

/* ---- own settings per VM (automatic start + delay) */
function readCfg() { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; } }
function writeCfg(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(CFG_FILE + '.tmp', CFG_FILE);
}

/* ---- parsers (testable on their own) */
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

// Change vCPUs, memory and description in the domain XML. The rest stays unchanged.
function editDomainXml(xml, { vcpus, memory, description }) {
  let out = xml;
  if (memory != null) {
    const kib = Math.round(memory / 1024);
    out = out.replace(/<memory(?=[\s>])[^>]*>\d+<\/memory>/, `<memory unit='KiB'>${kib}</memory>`)
      .replace(/<currentMemory(?=[\s>])[^>]*>\d+<\/currentMemory>/, `<currentMemory unit='KiB'>${kib}</currentMemory>`);
  }
  if (vcpus != null) {
    out = out.replace(/<vcpu\b([^>]*)>\d+<\/vcpu>/, (_, a) => `<vcpu${a.replace(/\s*current=(['"])\d+\1/, '')}>${vcpus}</vcpu>`);
    // A fixed CPU topology must match the number of vCPUs.
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

// CPU in % of the VM's own vCPUs (100% = all vCPUs fully busy).
function cpuPercent(prev, cpuTimeNs, now, vcpus) {
  if (!prev || cpuTimeNs == null || !vcpus || now <= prev.at) return null;
  return Math.max(0, Math.min(100, ((cpuTimeNs - prev.t) / ((now - prev.at) * 1e6 * vcpus)) * 100));
}
// Used memory: preferably what the guest itself reports (balloon driver), otherwise what QEMU takes on the host.
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
    if (/failed to get domain|not found/i.test(e.message)) throw httpError('This VM does not exist (anymore).', 404);
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

const xmlCache = new Map(); // name → { at, info }
async function configInfo(name) {
  const c = xmlCache.get(name);
  if (c && Date.now() - c.at < 60000) return c.info;
  const info = parseDomainXml(await virsh(['dumpxml', '--inactive', name]));
  xmlCache.set(name, { at: Date.now(), info });
  return info;
}

const domstats = async () => parseDomstats(await virsh(['domstats', '--state', '--cpu-total', '--balloon', '--vcpu']));
const prevCpu = new Map(); // name → { t, at, pct }
const pending = new Map(); // name → { at, timer }  (waiting for automatic start)

// `virsh domifaddr`: per card the MAC address and the IP addresses.
function parseDomifaddr(text) {
  return String(text).split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 4 && /^ipv[46]$/.test(c[2]))
    .map(([iface, mac, proto, address]) => ({ iface, mac, proto, address: address.split('/')[0] }));
}
// Usable addresses: no loopback or link-local; IPv4 first.
function usableIps(list) {
  const ok = list.filter((a) => !/^(127\.|169\.254\.|::1$|fe80:)/i.test(a.address) && a.iface !== 'lo');
  return [...new Set([...ok.filter((a) => a.proto === 'ipv4'), ...ok.filter((a) => a.proto === 'ipv6')].map((a) => a.address))];
}
// IP addresses of a running VM. First the guest agent (knows everything), then libvirt's DHCP (NAT), then the ARP table (bridge).
const ipCache = new Map(); // name → { at, ips }
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
  // First reading for a running VM: wait briefly and measure again, so there is a CPU value right away.
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
    if (on && prev && now - prev.at < 400) cpu = prev.pct; // two requests shortly after each other: previous value
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
  if (!vm) throw httpError('This VM does not exist (anymore).', 404);
  // Saved settings (they apply at the next start), with the VNC password.
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

/* ---- input checks */
function int(v, min, max, label) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw httpError(label + ' must be between ' + min + ' and ' + max + '.', 400);
  return n;
}
function memoryFromGb(v) {
  const maxGb = Math.floor(os.totalmem() / 1073741824);
  const gb = Number(v);
  if (!Number.isFinite(gb) || gb < 0.25 || gb > maxGb) throw httpError('Memory must be between 0.25 and ' + maxGb + ' GB.', 400);
  return Math.round(gb * 1024) * 1048576; // rounded to whole MiB
}
function autostartFrom(body) {
  return { autostart: !!body.autostart, delay: body.delay == null || body.delay === '' ? 0 : int(body.delay, 0, 3600, 'The start delay') };
}

async function saveSettings(name, body) {
  const state = await domState(name);
  const xml = await virsh(['dumpxml', '--inactive', '--security-info', name]); // with passwords, otherwise they get lost
  const cur = parseDomainXml(xml);
  let vcpus = body.vcpus != null ? int(body.vcpus, 1, os.cpus().length, "The number of vCPUs") : cur.vcpus;
  const memory = body.memoryGb != null ? memoryFromGb(body.memoryGb) : cur.memory;
  const description = body.description != null ? String(body.description).slice(0, 2000).trim() : cur.description;
  const auto = autostartFrom(body);
  const newName = body.name != null ? String(body.name).trim() : name;
  if (newName !== name) {
    if (!NAME.test(newName)) throw httpError(NAME_HELP, 400);
    if (state !== 'SHUTOFF') throw httpError('Turn the VM off first to change its name.', 409);
    if (await exists(newName)) throw httpError('A VM named ' + newName + ' already exists.', 409);
  }

  // Hardware: network, disks, cd-rom, boot, devices and pinned cores.
  const curHw = hw.parseHardware(xml);
  const hasHw = ['nics', 'boot', 'cdrom', 'hostdevs', 'cpuPins', 'addDisks', 'removeDisks', 'resizeDisks', 'clipboard'].some((k) => body[k] !== undefined);
  const opts = hasHw ? await vmOptions() : null;
  const change = hasHw ? hw.validateHardware(body, opts, curHw) : {};
  if (change.cpuPins && change.cpuPins.length) vcpus = change.cpuPins.length;
  else if (!change.cpuPins && curHw.cpuPins.length && vcpus !== curHw.cpuPins.length) throw httpError('This VM has pinned cores. Choose the cores again to change the number of vCPUs.', 400);
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
    disks.add.forEach((d) => fs.rmSync(d.file, { force: true })); // clean up the new disks again
    throw e;
  }
  // Swapping an ISO works right away, also while the VM runs (e.g. during an installation).
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
  // MajaOS starts the VM itself (with a delay), so libvirt mustn't do that as well.
  await virsh(['autostart', '--disable', newName]).catch(() => {});
  xmlCache.delete(name); xmlCache.delete(newName);
  if (newName !== name) { prevCpu.delete(name); cancelPending(name); }
  return { name: newName, restartNeeded: (hwChanged || devChanged) && state !== 'SHUTOFF' };
}

// Add disks, detach them (the file stays) or make them larger.
async function diskChanges(name, body, curHw, state) {
  const out = { add: [], remove: [], resize: [] };
  const targets = new Set(curHw.disks.map((d) => d.target));
  for (const t of body.removeDisks || []) {
    if (!targets.has(t)) throw httpError('This disk no longer belongs to the VM.', 400);
    out.remove.push(t);
  }
  for (const r of body.resizeDisks || []) {
    const d = curHw.disks.find((x) => x.target === r.target);
    if (!d || !d.source || out.remove.includes(r.target)) throw httpError('This disk no longer belongs to the VM.', 400);
    const sizeGb = int(r.sizeGb, 1, 16384, 'The disk size (GB)');
    const info = await diskInfo(d);
    if (info.size != null && sizeGb * 1073741824 < info.size) throw httpError(`A disk can only grow. ${d.target} is now ${Math.ceil(info.size / 1073741824)} GB.`, 400);
    if (info.size == null || sizeGb * 1073741824 > info.size) out.resize.push({ target: d.target, source: d.source, sizeGb });
  }
  if ((body.addDisks || []).length) {
    if (body.addDisks.length > 4) throw httpError('Add at most 4 disks at a time.', 400);
    if (!fs.existsSync(VM_DIR())) throw httpError('The folder for VM disks (' + VM_DIR() + ') does not exist. Create a pool in Storage first, or choose a folder in Settings → Storage.', 503);
    const dir = path.join(VM_DIR(), slugify(name));
    fs.mkdirSync(dir, { recursive: true });
    let n = 2;
    try {
      for (const a of body.addDisks) {
        const sizeGb = int(a.sizeGb, 1, 16384, 'The disk size (GB)');
        const bus = a.bus === 'sata' ? 'sata' : 'virtio';
        let file; do { file = path.join(dir, slugify(name) + '-' + n++ + '.qcow2'); } while (fs.existsSync(file));
        await run('qemu-img', ['create', '-f', 'qcow2', file, sizeGb + 'G'], { timeout: 60000 });
        out.add.push({ file, bus, format: 'qcow2' });
      }
    } catch (e) { out.add.forEach((d) => fs.rmSync(d.file, { force: true })); throw e; }
  }
  return out;
}

// Port of a running VM's VNC screen, for the console in the browser.
async function vncPort(name) {
  const state = await domState(name);
  if (state === 'SHUTOFF') throw httpError('The VM is off. Start it to see its screen.', 409);
  const info = parseDomainXml(await virsh(['dumpxml', name]));
  if (!info.vnc) throw httpError('This VM has no VNC screen.', 404);
  if (!(info.vnc.port > 0)) throw httpError('This VM\'s screen is not ready yet. Try again in a moment.', 409);
  return info.vnc.port;
}

/* ---- media and creating */
function listDir(dir, re) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && re.test(d.name))
      .map((d) => ({ name: d.name, size: fs.statSync(path.join(dir, d.name)).size })).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return null; }
}
// Everything you can choose in the VM forms: files, networks and the server's hardware.
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

// Operating systems for a new VM: the osinfo name virt-install uses for its defaults, and the family that decides the
// hardware the installer understands. An osinfo name Debian's osinfo-db doesn't know falls back to the family's (createVm).
// Keep the ids the same as VM_OS in public/app.js.
const OS = {
  linux: { family: 'linux', osinfo: 'linux2022' },
  debian: { family: 'linux', osinfo: 'debian13' },
  ubuntu: { family: 'linux', osinfo: 'ubuntu24.04' },
  fedora: { family: 'linux', osinfo: 'fedora-unknown' },
  haos: { family: 'linux', osinfo: 'linux2022', media: 'disk' }, // Home Assistant OS comes as a disk image
  truenas: { family: 'linux', osinfo: 'debian12' }, // TrueNAS SCALE is Debian underneath
  freebsd: { family: 'bsd', osinfo: 'freebsd14.0' },
  opnsense: { family: 'bsd', osinfo: 'freebsd14.0' }, // OPNsense and pfSense are FreeBSD
  windows11: { family: 'windows', osinfo: 'win11', tpm: true },
  windows10: { family: 'windows', osinfo: 'win10' },
  winserver: { family: 'windows', osinfo: 'win2k22', tpm: true },
  other: { family: 'other', osinfo: 'detect=on,require=off' },
};
// The Windows installer doesn't know virtio; for an unknown system SATA and an Intel card work almost everywhere.
const FAMILY = {
  linux: { osinfo: 'linux2022', bus: 'virtio', nic: 'virtio' },
  bsd: { osinfo: 'detect=on,require=off', bus: 'virtio', nic: 'virtio' },
  windows: { osinfo: 'win10', bus: 'sata', nic: 'e1000e' },
  other: { osinfo: 'detect=on,require=off', bus: 'sata', nic: 'e1000e' },
};
// Requests from before the list of systems: kind linux | windows | import.
const OLD_KINDS = { linux: { os: 'linux', media: 'iso' }, windows: { os: 'windows11', media: 'iso' }, import: { os: 'linux', media: 'disk' } };

// What virt-install gets for this request: the system's defaults, with what the user changed under Advanced.
function vmHardware(body) {
  const old = !body.os && OLD_KINDS[body.kind];
  const id = old ? old.os : String(body.os || '');
  const sys = Object.prototype.hasOwnProperty.call(OS, id) ? OS[id] : null;
  if (!sys) throw httpError('Choose an operating system.', 400);
  const fam = FAMILY[sys.family];
  const media = old ? old.media : String(body.media || sys.media || 'iso');
  if (media !== 'iso' && media !== 'disk') throw httpError('Choose an installation ISO or an existing disk.', 400);
  const firmware = String(body.firmware || 'uefi');
  if (firmware !== 'uefi' && firmware !== 'bios') throw httpError('Choose UEFI or BIOS.', 400);
  const bus = String(body.bus || fam.bus);
  if (bus !== 'virtio' && bus !== 'sata') throw httpError('Choose VirtIO or SATA for the disk.', 400);
  const nic = String(body.nic || fam.nic);
  if (!['virtio', 'e1000e', 'rtl8139'].includes(nic)) throw httpError('Choose a network card: VirtIO, e1000e or RTL8139.', 400);
  const tpm = body.tpm == null ? !!sys.tpm : !!body.tpm;
  return { os: id, media, osinfo: sys.osinfo, fallback: fam.osinfo, firmware, bus, nic, tpm };
}
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vm';

async function createVm(body) {
  const name = String(body.name || '').trim();
  if (!NAME.test(name)) throw httpError(NAME_HELP, 400);
  const hw = vmHardware(body);
  const fromDisk = hw.media === 'disk';
  const vcpus = int(body.vcpus, 1, os.cpus().length, "The number of vCPUs");
  const memory = memoryFromGb(body.memoryGb);
  const diskGb = fromDisk ? null : int(body.diskGb, 4, 16384, 'The disk size (GB)');
  const auto = autostartFrom(body);
  const opts = await vmOptions();
  // Network: "network:default" (libvirt network) or "bridge:br0" (a bridge of the server).
  const [ntype, nsrc] = String(body.network || opts.network).split(':');
  if (!(ntype === 'network' ? opts.networks : ntype === 'bridge' ? opts.bridges : []).some((x) => x.name === nsrc)) {
    throw httpError('Choose a network for the VM.', 400);
  }
  const source = String(body.source || '');
  const choices = fromDisk ? opts.images : opts.isos;
  if (!choices.some((f) => f.name === source)) {
    throw httpError(fromDisk ? 'Choose a disk file from ' + ISO_DIR() + '.' : 'Choose an installation ISO from ' + ISO_DIR() + '.', 400);
  }
  if (opts.vmDirMissing) throw httpError('The folder for VM disks (' + VM_DIR() + ') does not exist. Create a pool in Storage first, or choose a folder in Settings → Storage.', 503);
  if (await exists(name)) throw httpError('A VM named ' + name + ' already exists.', 409);

  const dir = path.join(VM_DIR(), slugify(name));
  const disk = path.join(dir, slugify(name) + '.qcow2');
  if (fs.existsSync(disk)) throw httpError('There is already a disk file at ' + disk + '. Choose another name or clean up that file.', 409);
  fs.mkdirSync(dir, { recursive: true });

  const password = crypto.randomBytes(6).toString('base64url').slice(0, 8); // VNC knows at most 8 characters
  const src = path.join(ISO_DIR(), source);
  const args = (osinfo) => ['--connect', CONN, '--name', name, '--memory', String(memory / 1048576), '--vcpus', String(vcpus),
    '--cpu', 'host-passthrough', '--osinfo', osinfo, ...(hw.firmware === 'uefi' ? ['--boot', 'uefi'] : []),
    '--network', ntype + '=' + nsrc + ',model=' + hw.nic,
    '--graphics', 'vnc,listen=0.0.0.0,password=' + password, '--noautoconsole',
    ...(hw.tpm ? ['--tpm', 'emulator'] : []),
    ...(fromDisk ? ['--import', '--disk', `path=${disk},format=qcow2,bus=${hw.bus}`]
      : ['--cdrom', src, '--disk', `path=${disk},size=${diskGb},format=qcow2,bus=${hw.bus}`])];
  try {
    // Make a copy, so the original file stays untouched.
    if (fromDisk) await run('qemu-img', ['convert', '-O', 'qcow2', src, disk], { timeout: 60 * 60000 });
    try { await run('virt-install', args(hw.osinfo), { timeout: 180000 }); }
    catch (e) {
      // An osinfo-db without this system (older or newer than its name): the same VM with the family's defaults.
      if (hw.osinfo === hw.fallback || !/unknown os|osinfo|os-variant/i.test(e.message || '') || await exists(name).catch(() => true)) throw e;
      await run('virt-install', args(hw.fallback), { timeout: 180000 });
    }
  } catch (e) {
    if (!(await exists(name).catch(() => true))) { fs.rmSync(disk, { force: true }); try { fs.rmdirSync(dir); } catch { /* not empty */ } }
    throw httpError('Creating failed: ' + e.message, e.status || 502);
  }

  const description = String(body.description || '').slice(0, 2000).trim();
  if (description) await virsh(['desc', name, '--config', '--live', '--new-desc', description]).catch(() => {});
  // Let the balloon driver report every 5 s how much memory the guest really uses.
  await virsh(['dommemstat', name, '--period', '5', '--config', '--live']).catch(() => {});
  await virsh(['autostart', '--disable', name]).catch(() => {});
  const cfg = readCfg(); cfg[name] = auto; writeCfg(cfg);
  return { name, disk };
}

// A disk and everything it builds on (backing files), according to qemu-img. If that fails: only the disk itself.
async function backingChain(file) {
  try {
    const list = JSON.parse(await run('qemu-img', ['info', '--backing-chain', '--output=json', '-U', file], { timeout: 15000 }));
    return (Array.isArray(list) ? list : [list]).map((x) => x.filename).filter(Boolean);
  } catch { return [file]; }
}

async function deleteVm(name, removeDisks) {
  if ((await domState(name)) !== 'SHUTOFF') throw httpError('Turn the VM off first. Then you can remove it.', 409);
  const info = parseDomainXml(await virsh(['dumpxml', '--inactive', name]));
  await virsh(['undefine', '--nvram', '--snapshots-metadata', name]);
  cancelPending(name); xmlCache.delete(name); prevCpu.delete(name);
  const cfg = readCfg(); delete cfg[name]; writeCfg(cfg);

  const removed = [], kept = [];
  if (removeDisks) {
    // With snapshots the disk is a chain of files (overlay on overlay): all of them, plus the snapshots' memory.
    const files = [];
    for (const d of info.disks.filter((x) => x.device === 'disk' && x.source)) {
      files.push(...(await backingChain(d.source)));
      const base = path.basename(d.source).replace(/\.[^.]+$/, '');
      try { fs.readdirSync(path.dirname(d.source)).filter((f) => f.startsWith(base + '.') && f.endsWith('.mem')).forEach((f) => files.push(path.join(path.dirname(d.source), f))); } catch { /* folder gone */ }
    }
    for (const f of [...new Set(files.map((x) => path.resolve(x)))]) {
      // Only erase files inside VM_DIR; everything else stays.
      if (!f.startsWith(VM_DIR() + path.sep)) { kept.push(f); continue; }
      try {
        fs.rmSync(f, { force: true }); removed.push(f);
        if (path.dirname(f) !== VM_DIR()) { try { fs.rmdirSync(path.dirname(f)); } catch { /* folder not empty */ } }
      } catch { kept.push(f); }
    }
  }
  return { removed, kept };
}

/* ---- automatic start with a delay after the server boots */
function cancelPending(name) { const p = pending.get(name); if (p) { clearTimeout(p.timer); pending.delete(name); } }

function bootAutostart(log = console.log) {
  // The marker is in /run, so it only disappears when the server reboots.
  const marker = path.join(RUN_DIR, 'autostart-gedaan');
  if (fs.existsSync(marker)) return;
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); fs.writeFileSync(marker, new Date().toISOString()); } catch { /* carry on anyway */ }
  const up = uptime() || 0;
  if (up > 15 * 60) return; // not just booted, e.g. after an installation or update
  for (const [name, c] of Object.entries(readCfg())) {
    if (!c.autostart) continue;
    const ms = Math.max(0, (c.delay || 0) - up) * 1000; // the delay counts from the server's boot
    const timer = setTimeout(async () => {
      pending.delete(name);
      try {
        if ((await domState(name)) === 'SHUTOFF') { await virsh(['start', name], { timeout: 60000 }); log('VM started automatically: ' + name); }
      } catch (e) { log('Automatic start of VM ' + name + ' failed: ' + e.message); }
    }, ms);
    pending.set(name, { at: Date.now() + ms, timer });
  }
  if (pending.size) log('Automatic start scheduled for ' + pending.size + ' VM(s).');
}

module.exports = { vmHardware, VM_OS_IDS: Object.keys(OS),
  backingChain, listVms, vmDetails, vmAction, saveSettings, createVm, deleteVm, vmOptions, bootAutostart, vncPort,
  parseDomstats, parseDomainXml, editDomainXml, cpuPercent, memUsed, slugify, parseDomifaddr, usableIps,
};
