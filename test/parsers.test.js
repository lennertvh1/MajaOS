'use strict';
/* Tests for the parsers, with sample output of virsh, zpool, zfs, lsblk and Docker. Run with: npm test */
const test = require('node:test');
const assert = require('node:assert/strict');
const vms = require('../lib/vms');
const st = require('../lib/storage');
const dk = require('../lib/docker');
const sys = require('../lib/system');

const DOMSTATS = `Domain: 'Home Assistant OS'
  state.state=1
  state.reason=1
  cpu.time=508432000000
  cpu.user=101000000000
  cpu.system=88000000000
  balloon.current=4194304
  balloon.maximum=4194304
  balloon.rss=3801112
  balloon.available=4020180
  balloon.usable=2876544
  balloon.unused=2651200
  vcpu.current=2
  vcpu.maximum=2

Domain: 'windows11'
  state.state=5
  state.reason=2
  balloon.current=8388608
  balloon.maximum=8388608
`;

test('domstats: domeinen, toestand en velden', () => {
  const d = vms.parseDomstats(DOMSTATS);
  assert.equal(d.length, 2);
  assert.equal(d[0].name, 'Home Assistant OS');
  assert.equal(d[0]['state.state'], '1');
  assert.equal(d[0]['vcpu.current'], '2');
  assert.equal(d[1]['state.state'], '5');
});

test('memory use: first balloon available−usable, then unused, then rss', () => {
  const [ha] = vms.parseDomstats(DOMSTATS);
  assert.equal(vms.memUsed(ha, 4194304 * 1024), (4020180 - 2876544) * 1024);
  assert.equal(vms.memUsed({ 'balloon.available': '100', 'balloon.unused': '40' }, null), 60 * 1024);
  assert.equal(vms.memUsed({ 'balloon.rss': '5000' }, 1024), 1024); // never more than assigned
  assert.equal(vms.memUsed({}, 1024), null);
});

test('CPU percentage relative to the own vCPUs', () => {
  // 2 vCPU's, 1 s wandtijd, 1 s CPU-tijd → 50%
  assert.equal(vms.cpuPercent({ t: 0, at: 1000 }, 1e9, 2000, 2), 50);
  assert.equal(vms.cpuPercent({ t: 0, at: 1000 }, 9e9, 2000, 2), 100); // afgekapt
  assert.equal(vms.cpuPercent(null, 1e9, 2000, 2), null);
});

const XML = `<domain type='kvm'>
  <name>Home Assistant OS</name>
  <uuid>4b1c...</uuid>
  <memory unit='KiB'>4194304</memory>
  <currentMemory unit='KiB'>4194304</currentMemory>
  <memoryBacking><source type='memfd'/></memoryBacking>
  <vcpu placement='static' current='2'>4</vcpu>
  <os firmware='efi'><type arch='x86_64' machine='q35'>hvm</type></os>
  <cpu mode='host-passthrough'><topology sockets='1' dies='1' clusters='1' cores='4' threads='1'/></cpu>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='/tank/vms/haos/haos.qcow2'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <source file='/tank/isos/debian.iso'/>
      <target dev='sda' bus='sata'/>
    </disk>
    <graphics type='vnc' port='5901' autoport='yes' listen='0.0.0.0' passwd='secret&amp;1'>
      <listen type='address' address='0.0.0.0'/>
    </graphics>
  </devices>
</domain>`;

test('reading domain XML', () => {
  const d = vms.parseDomainXml(XML);
  assert.equal(d.name, 'Home Assistant OS');
  assert.equal(d.vcpus, 2); // current-attribuut
  assert.equal(d.memory, 4194304 * 1024);
  assert.equal(d.firmware, 'uefi');
  assert.deepEqual(d.disks.map((x) => [x.device, x.source, x.target]), [
    ['disk', '/tank/vms/haos/haos.qcow2', 'vda'], ['cdrom', '/tank/isos/debian.iso', 'sda']]);
  assert.deepEqual(d.vnc, { port: 5901, password: 'secret&1' });
  assert.equal(d.description, '');
});

test('changing domain XML: vCPU, memory, topology and description', () => {
  const out = vms.editDomainXml(XML, { vcpus: 6, memory: 8 * 1073741824, description: 'House & garden <test>' });
  const d = vms.parseDomainXml(out);
  assert.equal(d.vcpus, 6);
  assert.equal(d.memory, 8 * 1073741824);
  assert.equal(d.description, 'House & garden <test>');
  assert.match(out, /<vcpu placement='static'>6<\/vcpu>/);
  assert.match(out, /<topology sockets='1' dies='1' clusters='1' cores='6' threads='1'\/>/);
  assert.match(out, /<memoryBacking>/); // not touched
  assert.match(out, /passwd='secret&amp;1'/); // password stays
  // Emptying the description removes the element.
  assert.doesNotMatch(vms.editDomainXml(out, { description: '' }), /<description>/);
});

test('slug for folders and files', () => {
  assert.equal(vms.slugify('Ubuntu Server (test)'), 'ubuntu-server-test');
  assert.equal(vms.slugify('...'), 'vm');
});

const ZPOOL_STATUS = `  pool: fast
 state: ONLINE
  scan: scrub repaired 0B in 00:02:11 with 0 errors on Sun Oct 12 00:26:12 2025
config:

	NAME                STATE     READ WRITE CKSUM
	fast                ONLINE       0     0     0
	  mirror-0          ONLINE       0     0     0
	    /dev/nvme0n1p1  ONLINE       0     0     0
	    /dev/nvme1n1p1  ONLINE       0     0     0

errors: No known data errors

  pool: tank
 state: DEGRADED
status: One or more devices could not be used because the label is missing or
	invalid.
  scan: scrub in progress since Tue Oct 21 21:00:01 2025
	1.20T / 3.10T scanned at 410M/s, 1.10T / 3.10T issued at 380M/s
	0B repaired, 35.48% done, 01:30:00 to go
config:

	NAME           STATE     READ WRITE CKSUM
	tank           DEGRADED     0     0     0
	  raidz1-0     DEGRADED     0     0     0
	    /dev/sda1  ONLINE       0     0     0
	    /dev/sdb1  ONLINE       0     0     2
	    /dev/sdc1  FAULTED      3     1     0
	    /dev/sdd1  ONLINE       0     0     0
	cache
	  /dev/sde1    ONLINE       0     0     0

errors: No known data errors
`;

test('zpool status: pools, disks, roles and errors', () => {
  const pools = st.parseZpoolStatus(ZPOOL_STATUS);
  assert.deepEqual(pools.map((p) => [p.name, p.state]), [['fast', 'ONLINE'], ['tank', 'DEGRADED']]);
  assert.deepEqual(pools[0].devices.map((d) => [d.disk, d.vdev, d.role]), [['nvme0n1', 'mirror', 'data'], ['nvme1n1', 'mirror', 'data']]);
  const tank = pools[1].devices;
  assert.equal(tank.length, 5);
  assert.deepEqual(tank.find((d) => d.disk === 'sdc'), { path: '/dev/sdc1', disk: 'sdc', role: 'data', vdev: 'raidz1', state: 'FAULTED', errors: 4 });
  assert.deepEqual(tank.find((d) => d.disk === 'sde'), { path: '/dev/sde1', disk: 'sde', role: 'cache', vdev: null, state: 'ONLINE', errors: 0 });
});

test('scrubstatus: lopend en afgelopen', () => {
  const [fast, tank] = st.parseZpoolStatus(ZPOOL_STATUS);
  const done = st.parseScan(fast.scan);
  assert.equal(done.running, false); assert.equal(done.errors, 0);
  assert.equal(new Date(done.last).getFullYear(), 2025);
  const run = st.parseScan(tank.scan);
  assert.equal(run.running, true); assert.equal(run.progress, 35.48); assert.equal(run.kind, 'scrub');
  assert.equal(st.parseScan('none requested').kind, null);
});

test('zfs list en zpool list', () => {
  const ds = st.parseZfsList('tank\t1000\t5000\t/tank\t1.00\ntank/media\t800\t5000\t/tank/media\t1.02\ntank/vol\t10\t5000\t-\t1.50\nno datasets available\n');
  assert.equal(ds.length, 3);
  assert.deepEqual(ds[1], { name: 'tank/media', used: 800, free: 5000, mountpoint: '/tank/media', compress: 1.02 });
  assert.equal(ds[2].mountpoint, null);
  assert.deepEqual(st.parseZpoolList('tank\tONLINE\nfast\tDEGRADED\n'), [{ name: 'tank', health: 'ONLINE' }, { name: 'fast', health: 'DEGRADED' }]);
  assert.equal(st.worst(['ONLINE', 'DEGRADED', 'ONLINE']), 'DEGRADED');
});

test('lsblk: only real disks, rota as a boolean or text', () => {
  const disks = st.parseLsblk(JSON.stringify({ blockdevices: [
    { name: 'sda', size: 2000398934016, rota: true, tran: 'sata', model: 'WDC WD20EFZX  ', serial: 'X1', type: 'disk' },
    { name: 'nvme0n1', size: 512110190592, rota: '0', tran: 'nvme', model: 'Samsung 980', serial: 'S2', type: 'disk' },
    { name: 'zram0', size: 1, rota: false, type: 'disk' }, { name: 'sr0', size: 1, rota: true, type: 'rom' },
  ] }));
  assert.deepEqual(disks.map((d) => [d.name, d.rotational, d.model]), [['sda', true, 'WDC WD20EFZX'], ['nvme0n1', false, 'Samsung 980']]);
  assert.equal(st.partToDisk('/dev/nvme1n1p3'), 'nvme1n1');
  assert.equal(st.partToDisk('/dev/sdab2'), 'sdab');
});

test('Docker-logs: gemultiplexte stroom uitpakken', () => {
  const frame = (stream, text) => { const b = Buffer.from(text); const h = Buffer.alloc(8); h[0] = stream; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  const buf = Buffer.concat([frame(1, '2025-10-21T20:00:00.123Z Started\n'), frame(2, '2025-10-21T20:00:01.000Z Warning\n')]);
  assert.deepEqual(dk.parseLogLines(dk.demuxLogs(buf)), [
    { timestamp: '2025-10-21T20:00:00.123Z', message: 'Started' }, { timestamp: '2025-10-21T20:00:01.000Z', message: 'Warning' }]);
  assert.equal(dk.demuxLogs(Buffer.from('plain text\n')), 'plain text\n'); // container with a TTY
});

test('Docker ports and web address', () => {
  const ports = dk.publicPorts([{ PrivatePort: 80, PublicPort: 8096, Type: 'tcp' }, { PrivatePort: 80, PublicPort: 8096, Type: 'tcp' }, { PrivatePort: 53 }]);
  assert.deepEqual(ports, [{ public: 8096, private: 80, type: 'TCP' }]);
  assert.equal(dk.webui({}, ports), 'http://[IP]:8096/');
  assert.equal(dk.webui({ 'majaos.webui': 'http://[IP]:[PORT:80]/web' }, ports), 'http://[IP]:8096/web');
});

test('/proc: CPU line, meminfo and ZFS cache', () => {
  assert.deepEqual(sys.parseCpuLine('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3'), { idle: 850, total: 1000 });
  const mi = sys.parseMeminfo('MemTotal:       32768000 kB\nMemAvailable:   16384000 kB\n');
  assert.equal(mi.MemTotal, 32768000 * 1024);
  assert.equal(sys.arcSize('name type data\nhits 4 123\nsize 4 8589934592\nc 4 1'), 8589934592);
});

test('console: the sh script returns output, new folder and exit code (real sh)', async () => {
  const sys2 = require('../lib/system');
  const ex = (cwd, cmd) => sys2.run('sh', ['-c', dk.EXEC_SCRIPT, 'sh', cwd, cmd], { full: true }).then((r) => dk.parseExec(r, cwd));
  let r = await ex('/', 'cd /usr && echo "hallo wereld"');
  assert.equal(r.output, 'hallo wereld');
  assert.equal(r.cwd, '/usr');
  assert.equal(r.exitCode, 0);
  r = await ex('/usr', 'ls /does-not-exist');
  assert.match(r.output, /does-not-exist/); // stderr comes along in the output
  assert.notEqual(r.exitCode, 0);
  assert.equal(r.cwd, '/usr');
  r = await ex('/folder/that/does/not/exist', 'pwd; printf "a\\nb"');
  assert.equal(r.output, '/\na\nb'); // unknown folder: back to /
  assert.throws(() => dk.parseExec({ stdout: '', stderr: 'OCI runtime exec failed: exec: "sh": executable file not found in $PATH', code: 127 }, '/'), /has no shell/);
});

test('run() gives up on a command that ignores its time-out (stuck on a disk)', async () => {
  const { run } = require('../lib/system');
  const t0 = Date.now();
  await assert.rejects(run('bash', ['-c', 'trap "" TERM; sleep 20'], { timeout: 300 }), (e) => e.status === 504 && /did not respond in time/.test(e.message));
  assert.ok(Date.now() - t0 < 10000);
});

test('graphics cards from lspci -vmmk: with and without a driver, the BMC video left out', () => {
  const { parseGpuDevices } = require('../lib/system');
  const out = parseGpuDevices([
    'Slot:\t01:00.0\nClass:\tVGA compatible controller\nVendor:\tNVIDIA Corporation\nDevice:\tGA104 [GeForce RTX 3060 Ti Lite Hash Rate]\nSVendor:\tGigabyte Technology Co., Ltd\nRev:\ta1\nDriver:\tnouveau\nModule:\tnouveau',
    'Slot:\t01:00.1\nClass:\tAudio device\nVendor:\tNVIDIA Corporation\nDevice:\tGA104 High Definition Audio Controller\nDriver:\tsnd_hda_intel',
    'Slot:\t03:00.0\nClass:\tVGA compatible controller\nVendor:\tASPEED Technology, Inc.\nDevice:\tASPEED Graphics Family\nDriver:\tast',
    'Slot:\t0a:00.0\nClass:\tVGA compatible controller\nVendor:\tAdvanced Micro Devices, Inc. [AMD/ATI]\nDevice:\tNavi 23 [Radeon RX 6600]\nDriver:\tamdgpu',
    'Slot:\t0b:00.0\nClass:\t3D controller\nVendor:\tNVIDIA Corporation\nDevice:\tTU104GL [Tesla T4]',
  ].join('\n\n'));
  assert.deepEqual(out.map((g) => [g.name, g.vendor, g.ready]), [['GeForce RTX 3060 Ti Lite Hash Rate', 'nvidia', false], ['Radeon RX 6600', 'amd', true], ['Tesla T4', 'nvidia', false]]);
});

test('nvidia-smi: memory in bytes, [N/A] values stay empty', () => {
  const { parseNvidiaSmi } = require('../lib/system');
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3060 Ti, 7, 812, 8192, 44, 21.37\n'),
    [{ name: 'NVIDIA GeForce RTX 3060 Ti', util: 7, memUsed: 812 * 1048576, memTotal: 8192 * 1048576, temp: 44, power: 21.37 }]);
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3060 Ti, 0, 5, 8192, 38, [N/A]').map((g) => g.power), [null]);
  assert.equal(parseNvidiaSmi(''), null);
});
