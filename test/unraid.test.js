'use strict';
/* Moving from Unraid (lib/unraid.js): the stick's files, the templates, libvirt's XML, the disks and Unraid's paths. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'unraid-'));
const u = require('../lib/unraid');

test('the stick: cfg files, shares with their access, users, installed containers', () => {
  assert.deepEqual(u.parseCfg('NAME="Tower"\r\nCOMMENT="Media server"\nbad line\nSYS_MODEL=""'), { NAME: 'Tower', COMMENT: 'Media server', SYS_MODEL: '' });
  const pub = u.shareFromCfg('media', u.parseCfg('shareComment="Films"\nshareExport="e"\nshareSecurity="public"\nshareUseCache="yes"'));
  assert.deepEqual([pub.guest, pub.exported, pub.comment, pub.cache, pub.users], [true, true, 'Films', 'yes', {}]);
  const priv = u.shareFromCfg('docs', u.parseCfg('shareExport="e"\nshareSecurity="private"\nshareReadList="kim,tom"\nshareWriteList="lisa,tom"'));
  assert.deepEqual([priv.guest, priv.users], [false, { kim: 'ro', tom: 'rw', lisa: 'rw' }]);
  assert.equal(u.shareFromCfg('system', u.parseCfg('shareExport="-"')).exported, false);
  assert.deepEqual(u.parsePasswd('root:x:0:0:Console and webGui login account:/root:/bin/bash\nnobody:x:99:100:Unprivileged User:/:/bin/false\nlisa:x:1000:100::/:/bin/false\ntom:x:1001:100::/:/bin/false\n'), ['lisa', 'tom']);
  assert.deepEqual(u.parseUserprefs('0="plex"\n1="jellyfin"\n'), ['plex', 'jellyfin']);
});

test('a template: its fields in the app store\'s shape', () => {
  const t = u.parseTemplate(`<?xml version="1.0"?>
<Container version="2">
  <Name>Jellyfin</Name>
  <Repository>jellyfin/jellyfin</Repository>
  <Network>br0</Network>
  <MyIP>192.168.1.50</MyIP>
  <Privileged>false</Privileged>
  <WebUI>http://[IP]:[PORT:8096]/</WebUI>
  <Icon>https://example.org/jellyfin.png</Icon>
  <ExtraParams>--runtime=nvidia</ExtraParams>
  <PostArgs/>
  <Config Name="WebUI" Target="8096" Default="8096" Mode="tcp" Description="" Type="Port" Display="always" Required="false" Mask="false">8096</Config>
  <Config Name="Config" Target="/config" Default="" Mode="rw" Description="" Type="Path" Display="always" Required="true" Mask="false">/mnt/user/appdata/jellyfin</Config>
  <Config Name="Media" Target="/media" Default="" Mode="ro" Description="Films &amp; series" Type="Path" Display="always" Required="false" Mask="false">/mnt/user/media</Config>
</Container>`);
  assert.equal(t.name, 'Jellyfin');
  assert.equal(t.image, 'jellyfin/jellyfin');
  assert.equal(t.network, 'br0');
  assert.equal(t.myIp, '192.168.1.50');
  assert.equal(t.extraParams, '--runtime=nvidia');
  assert.equal(t.config.length, 3);
  assert.equal(t.config[2]['@attributes'].Description, 'Films & series');
  assert.equal(t.config[1].value, '/mnt/user/appdata/jellyfin');
  const norm = require('../lib/appstore').normConfig(t.config);
  assert.deepEqual(norm.map((c) => [c.type, c.target, c.value]), [['Port', '8096', '8096'], ['Path', '/config', '/mnt/user/appdata/jellyfin'], ['Path', '/media', '/mnt/user/media']]);
});

test('a VM from libvirt.img: memory, vCPUs, firmware, disks, system', () => {
  const v = u.parseDomain(`<domain type='kvm'>
  <name>Home Assistant</name>
  <metadata><vmtemplate xmlns="unraid" name="Linux" icon="linux.png" os="linux"/></metadata>
  <memory unit='KiB'>4194304</memory>
  <vcpu placement='static'>2</vcpu>
  <os><type arch='x86_64' machine='pc-q35-7.1'>hvm</type><loader readonly='yes' type='pflash'>/usr/share/qemu/ovmf-x64/OVMF_CODE-pure-efi.fd</loader></os>
  <devices>
    <disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='/mnt/user/domains/Home Assistant/haos_ova-12.qcow2'/><target dev='hdc' bus='virtio'/></disk>
    <disk type='file' device='cdrom'><source file='/mnt/user/isos/x.iso'/><target dev='hda' bus='sata'/></disk>
    <interface type='bridge'><source bridge='br0'/><model type='virtio-net'/></interface>
    <hostdev mode='subsystem' type='usb'><source><vendor id='0x10c4'/></source></hostdev>
  </devices>
</domain>`);
  assert.equal(v.name, 'Home Assistant');
  assert.equal(v.memory, 4 * 1073741824);
  assert.equal(v.vcpus, 2);
  assert.equal(v.firmware, 'uefi');
  assert.equal(v.os, 'haos');
  assert.equal(v.passthrough, 1);
  assert.deepEqual(v.disks, [{ path: '/mnt/user/domains/Home Assistant/haos_ova-12.qcow2', bus: 'virtio' }]);
  const w = u.parseDomain(`<domain><name>Win</name><metadata><vmtemplate os="windows11"/></metadata><memory unit='GiB'>8</memory><vcpu>4</vcpu><os><type>hvm</type></os><devices/></domain>`);
  assert.deepEqual([w.os, w.firmware, w.memory], ['windows11', 'bios', 8 * 1073741824]);
});

test('the disks: stick, data, parity, cache pool, encrypted, the system disk left out', () => {
  const part = (name, fstype, extra = {}) => ({ name, type: 'part', fstype, uuid: fstype ? 'u-' + name : null, label: null, mountpoints: [null], ...extra });
  const disk = (name, size, rota, children, extra = {}) => ({ name, type: 'disk', size, rota, tran: 'sata', model: 'M', serial: 'S' + name, children, ...extra });
  const out = u.classify({ blockdevices: [
    disk('sda', 32e9, false, [part('sda1', 'vfat', { label: 'UNRAID' })], { tran: 'usb' }),
    disk('sdb', 2e12, true, [part('sdb1', 'xfs')]),
    disk('sdc', 2e12, true, [part('sdc1', 'xfs')]),
    disk('sdd', 2e12, true, [part('sdd1', null)]),
    disk('sde', 512e9, false, [part('sde1', 'btrfs', { uuid: 'cache-1' })]),
    disk('sdf', 512e9, false, [part('sdf1', 'btrfs', { uuid: 'cache-1' })]),
    disk('sdg', 2e12, true, [part('sdg1', 'crypto_LUKS')]),
    disk('nvme0n1', 256e9, false, [part('nvme0n1p1', 'vfat', { mountpoints: ['/boot/efi'] }), part('nvme0n1p2', 'ext4', { mountpoints: ['/'] })], { tran: 'nvme' }),
    disk('sdh', 1e12, true, [part('sdh1', null)]), // no file system, smaller than the data disks: not a parity disk
    disk('sdi', 64e9, false, [part('sdi1', 'exfat')], { tran: 'usb' }),
  ] });
  assert.deepEqual(out.map((d) => [d.name, d.role]), [
    ['sda', 'flash'], ['sdb', 'data'], ['sdc', 'data'], ['sdd', 'parity'], ['sde', 'cache'], ['sdf', 'cache'], ['sdg', 'encrypted'], ['sdh', 'other'],
  ]);
  assert.equal(out.find((d) => d.name === 'sdb').part, 'sdb1');
  assert.equal(out.find((d) => d.name === 'sdb').fs, 'xfs');
});

test('Unraid\'s paths: user shares are all disks together, cache first', () => {
  const roots = [{ kind: 'cache', dir: '/r/cache' }, { kind: 'data', dir: '/r/sdb' }, { kind: 'data', dir: '/r/sdc' }];
  const have = new Set(['/r/cache/appdata/plex', '/r/sdb/appdata/plex', '/r/sdc/media/films', '/r/sdb/media', '/r/sdc/media']);
  const ex = (p) => have.has(p);
  assert.deepEqual(u.resolveUnraid('/mnt/user/appdata/plex', roots, ex), { share: 'appdata', rest: '/plex', hits: ['/r/cache/appdata/plex', '/r/sdb/appdata/plex'] });
  assert.deepEqual(u.resolveUnraid('/mnt/cache/appdata/plex/', roots, ex).hits, ['/r/cache/appdata/plex']);
  assert.deepEqual(u.resolveUnraid('/mnt/disk2/media/films', roots, ex).hits, ['/r/sdc/media/films']);
  assert.deepEqual(u.resolveUnraid('/mnt/user/media', roots, ex), { share: 'media', rest: '', hits: ['/r/sdb/media', '/r/sdc/media'] });
  assert.equal(u.resolveUnraid('/var/run/docker.sock', roots, ex), null);
  assert.equal(u.resolveUnraid('/mnt/remotes/nas/x', roots, ex), null);
});

test('taking over disks as a pool: the checks', () => {
  const mixed = require('../lib/mixed');
  const d = (name, size, extra = {}) => ({ name, size, part: name + '1', uuid: 'u-' + name, fs: 'xfs', serial: 'S' + name, ...extra });
  const fails = (body) => { try { mixed.planAdopt(body, { names: ['tank'] }); } catch (e) { return e.message; } return null; };
  const parity = { name: 'sdd', size: 2e12, available: true };
  assert.equal(fails({ name: 'media', data: [d('sdb', 2e12), d('sdc', 1e12)], parity: [parity] }), null);
  assert.match(fails({ name: 'media', data: [d('sdb', 4e12)], parity: [parity] }), /smaller than the largest data disk/);
  assert.match(fails({ name: 'media', data: [d('sdb', 2e12, { fs: 'crypto_LUKS' })], parity: [] }), /no file system MajaOS can take over/);
  assert.match(fails({ name: 'tank', data: [d('sdb', 2e12)], parity: [] }), /already exists/);
  assert.match(fails({ name: 'media', data: [], parity: [] }), /at least one data disk/);
  const p = mixed.planAdopt({ name: 'media', data: [d('sdb', 2e12), d('sdc', 1e12)], parity: [parity] }, { names: [] });
  assert.deepEqual(p.data.map((x) => [x.mount, x.fs, x.uuid]), [['/mnt/media/disk1', 'xfs', 'u-sdb'], ['/mnt/media/disk2', 'xfs', 'u-sdc']]);
  assert.match(mixed.fstabBlock({ name: 'media', mountpoint: '/media', disks: [{ ...p.data[0], role: 'data' }] }), /UUID=u-sdb \/mnt\/media\/disk1 xfs defaults,noatime,nofail/);
});
