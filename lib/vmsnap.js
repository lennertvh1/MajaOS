'use strict';
/*
 * Snapshots of VMs with libvirt. Always external: each disk gets a new overlay file next to it, the old
 * file no longer changes. Internal is not possible for VMs with UEFI (the nvram virt-install creates is raw).
 * If the VM is running, the snapshot also keeps the memory (reverting = continue where it was), unless `diskOnly`;
 * without memory it is like a power cut at that moment. Reverting and deleting external snapshots
 * needs libvirt 9.9 or newer (Debian 13 has 11.x).
 */
const path = require('node:path');
const { run, httpError } = require('./system');
const hw = require('./vmhw');

const CONN = 'qemu:///system';
const virsh = (args, opts) => run('virsh', ['-c', CONN, ...args], opts);
const SNAP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const unescape = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// `virsh snapshot-dumpxml` → { name, description, state, created, parent, memory, disks }
function parseSnapshotXml(xml) {
  const tag = (t) => { const m = String(xml).match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? unescape(m[1].trim()) : null; };
  const parent = String(xml).match(/<parent>\s*<name>([\s\S]*?)<\/name>/);
  const mem = String(xml).match(/<memory\b[^>]*snapshot=['"](\w+)['"]/);
  const disks = [...String(xml).matchAll(/<disk\b([^>]*?)(?:\/>|>([\s\S]*?)<\/disk>)/g)].map((m) => {
    const a = (n) => { const x = m[1].match(new RegExp(`\\b${n}=['"]([^'"]*)['"]`)); return x ? unescape(x[1]) : null; };
    const src = m[2] && m[2].match(/<source\b[^>]*\bfile=['"]([^'"]*)['"]/);
    return { name: a('name'), snapshot: a('snapshot'), file: src ? unescape(src[1]) : null };
  });
  const created = Number(tag('creationTime'));
  return {
    name: tag('name'), description: tag('description') || '', state: tag('state'),
    created: created ? created * 1000 : null, parent: parent ? unescape(parent[1].trim()) : null,
    memory: !!mem && mem[1] !== 'no', disks: disks.filter((d) => d.snapshot && d.snapshot !== 'no'),
  };
}

async function state(vm) {
  try { return (await virsh(['domstate', vm])).trim().toLowerCase(); }
  catch (e) { if (/failed to get domain|not found/i.test(e.message)) throw httpError('This VM does not exist (anymore).', 404); throw e; }
}

async function listSnapshots(vm) {
  await state(vm);
  const names = (await virsh(['snapshot-list', vm, '--name', '--topological'], { timeout: 15000 })).split('\n').map((x) => x.trim()).filter(Boolean);
  const current = await virsh(['snapshot-current', vm, '--name'], { timeout: 10000 }).then((o) => o.trim(), () => null);
  const list = await Promise.all(names.map(async (n) => ({ ...parseSnapshotXml(await virsh(['snapshot-dumpxml', vm, n], { timeout: 15000 })), current: n === current })));
  return { snapshots: list.sort((a, b) => (b.created || 0) - (a.created || 0)) };
}

// Default name: snapshot-20261023-1430 (in the server's time zone).
function defaultName(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `snapshot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Arguments for `virsh snapshot-create-as`: each disk external, cd-roms not, memory only when the VM is running.
function createArgs(vm, { name, description = '', running, diskOnly, disks, cdroms, memFile }) {
  const args = ['snapshot-create-as', vm, '--name', name, '--atomic'];
  if (description) args.push('--description', description);
  for (const d of disks) args.push('--diskspec', `${d.target},snapshot=external`);
  for (const c of cdroms) args.push('--diskspec', `${c.target},snapshot=no`);
  if (running && !diskOnly) args.push('--memspec', `file=${memFile},snapshot=external`);
  else args.push('--disk-only');
  return args;
}

async function createSnapshot(vm, body = {}) {
  const st = await state(vm);
  const name = String(body.name || '').trim() || defaultName();
  if (!SNAP.test(name)) throw httpError('Choose a name with letters, digits, dot, - or _ (at most 48 characters), e.g. before-update.', 400);
  const description = String(body.description || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const h = hw.parseHardware(await virsh(['dumpxml', '--inactive', vm]));
  const disks = h.disks.filter((d) => d.source && d.target);
  if (!disks.length) throw httpError('This VM has no disk to snapshot.', 400);
  if (h.hostdevs.length && st === 'running' && !body.diskOnly) {
    throw httpError('This VM uses a passed-through device (PCI or USB): then memory can\'t be saved. Choose "disks only".', 409);
  }
  const existing = await virsh(['snapshot-list', vm, '--name'], { timeout: 15000 }).then((o) => o.split('\n').map((x) => x.trim()), () => []);
  if (existing.includes(name)) throw httpError(`A snapshot named ${name} already exists.`, 409);
  const memFile = path.join(path.dirname(disks[0].source), `${path.basename(disks[0].source).replace(/\.[^.]+$/, '')}.${name}.mem`);
  const args = createArgs(vm, { name, description, running: st === 'running', diskOnly: !!body.diskOnly, disks, cdroms: h.cdroms.filter((c) => c.target), memFile });
  await virsh(args, { timeout: 10 * 60000 });
  return { name, memory: st === 'running' && !body.diskOnly };
}

async function revertSnapshot(vm, name) {
  await state(vm);
  if (!SNAP.test(String(name))) throw httpError('This snapshot doesn\'t exist (anymore).', 404);
  await virsh(['snapshot-revert', vm, name], { timeout: 10 * 60000 });
  return { reverted: name };
}

// Deleting merges the overlay into the disk below it; that can take a while with large changes.
async function deleteSnapshot(vm, name) {
  await state(vm);
  if (!SNAP.test(String(name))) throw httpError('This snapshot doesn\'t exist (anymore).', 404);
  await virsh(['snapshot-delete', vm, name], { timeout: 60 * 60000 });
  return { removed: name };
}

module.exports = { parseSnapshotXml, createArgs, defaultName, listSnapshots, createSnapshot, revertSnapshot, deleteSnapshot, SNAP };
