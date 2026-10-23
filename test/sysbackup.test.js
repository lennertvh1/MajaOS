'use strict';
/* Tests voor snapshots van VM's en back-ups van apps en VM's. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sys-'));
const snap = require('../lib/vmsnap');
const sb = require('../lib/sysbackup');

test('snapshot-dumpxml lezen', () => {
  const xml = `<domainsnapshot>
  <name>voor-update</name>
  <description>Voor HA 2026.10 &amp; add-ons</description>
  <state>running</state>
  <parent>
    <name>eerste</name>
  </parent>
  <creationTime>1792745000</creationTime>
  <memory snapshot='external' file='/tank/vms/haos/haos.voor-update.mem'/>
  <disks>
    <disk name='vda' snapshot='external' type='file'>
      <driver type='qcow2'/>
      <source file='/tank/vms/haos/haos.voor-update'/>
    </disk>
    <disk name='sda' snapshot='no'/>
  </disks>
  <domain type='kvm'><name>haos</name></domain>
</domainsnapshot>`;
  assert.deepEqual(snap.parseSnapshotXml(xml), {
    name: 'voor-update', description: 'Voor HA 2026.10 & add-ons', state: 'running', created: 1792745000000, parent: 'eerste', memory: true,
    disks: [{ name: 'vda', snapshot: 'external', file: '/tank/vms/haos/haos.voor-update' }],
  });
  const off = snap.parseSnapshotXml('<domainsnapshot><name>a</name><state>shutoff</state><creationTime>1</creationTime><memory snapshot=\'no\'/></domainsnapshot>');
  assert.equal(off.memory, false); assert.equal(off.parent, null);
});

test('argumenten voor een snapshot', () => {
  const disks = [{ target: 'vda', source: '/tank/vms/haos/haos.qcow2' }], cdroms = [{ target: 'sda' }];
  const live = snap.createArgs('haos', { name: 'x', description: 'test', running: true, diskOnly: false, disks, cdroms, memFile: '/tank/vms/haos/haos.x.mem' });
  assert.deepEqual(live, ['snapshot-create-as', 'haos', '--name', 'x', '--atomic', '--description', 'test', '--diskspec', 'vda,snapshot=external',
    '--diskspec', 'sda,snapshot=no', '--memspec', 'file=/tank/vms/haos/haos.x.mem,snapshot=external']);
  assert.ok(snap.createArgs('haos', { name: 'x', running: true, diskOnly: true, disks, cdroms: [] }).includes('--disk-only'));
  assert.ok(snap.createArgs('haos', { name: 'x', running: false, diskOnly: false, disks, cdroms: [] }).includes('--disk-only'));
  assert.equal(snap.defaultName(new Date(2026, 9, 23, 9, 5)), 'snapshot-20261023-0905');
  assert.ok(snap.SNAP.test('voor-update_1.0') && !snap.SNAP.test('met spatie') && !snap.SNAP.test('../x'));
});

test('apps per compose-project, en welke mappen meegaan', () => {
  const containers = [
    { Id: 'a1', Names: ['/immich_server'], State: 'running', Image: 'immich-server', Labels: { 'com.docker.compose.project': 'immich', 'com.docker.compose.project.working_dir': '/opt/stacks/immich', 'com.docker.compose.project.config_files': '/opt/stacks/immich/compose.yaml' },
      Mounts: [{ Type: 'bind', Source: '/snel/appdata/immich/upload' }, { Type: 'bind', Source: '/etc/localtime' }, { Type: 'bind', Source: '/tank/fotos' }] },
    { Id: 'a2', Names: ['/immich_postgres'], State: 'running', Image: 'postgres', Labels: { 'com.docker.compose.project': 'immich', 'com.docker.compose.project.working_dir': '/opt/stacks/immich', 'com.docker.compose.project.config_files': 'compose.yaml' },
      Mounts: [{ Type: 'volume', Name: 'pgdata', Source: '/var/lib/docker/volumes/immich_pgdata/_data' }, { Type: 'bind', Source: '/snel/appdata/immich' }] },
    { Id: 'b1', Names: ['/pihole'], State: 'exited', Image: 'pihole/pihole', Labels: {}, Mounts: [{ Type: 'bind', Source: '/snel/appdata/pihole' }, { Type: 'bind', Source: '/var/run/docker.sock' }] },
  ];
  const units = sb.parseUnits(containers, { appdata: '/snel/appdata' });
  assert.deepEqual(units.map((u) => u.id), ['compose:immich', 'container:pihole']);
  const im = units[0];
  assert.deepEqual(im.containers.map((c) => c.name), ['immich_server', 'immich_postgres']);
  // /snel/appdata/immich/upload zit al in /snel/appdata/immich: niet dubbel
  assert.deepEqual(im.paths, ['/opt/stacks/immich/.env', '/opt/stacks/immich/compose.yaml', '/snel/appdata/immich', '/var/lib/docker/volumes/immich_pgdata/_data']);
  assert.deepEqual(im.skipped, [{ path: '/etc/localtime', reason: 'systeem' }, { path: '/tank/fotos', reason: 'buiten de appgegevens' }]);
  assert.deepEqual(units[1].paths, ['/snel/appdata/pihole']);
  assert.deepEqual(units[1].skipped, [{ path: '/var/run/docker.sock', reason: 'systeem' }]);
});

test('taak controleren', () => {
  const datasets = [{ name: 'tank', mountpoint: '/tank', mounted: true }, { name: 'tank/backups', mountpoint: '/tank/backups', mounted: true }];
  const j = sb.validateSysJob({ name: ' Alles ', dest: '/tank/backups/systeem/', apps: ['compose:immich', 'compose:immich', 'container:pihole'], vms: ['Home Assistant OS'], keep: '14', stopApps: false, schedule: { every: 'daily', time: '02:00' } }, { datasets });
  assert.deepEqual(j, { name: 'Alles', dest: '/tank/backups/systeem', apps: ['compose:immich', 'container:pihole'], vms: ['Home Assistant OS'], keep: 14, stopApps: false, vmMode: 'live', schedule: { every: 'daily', time: '02:00', day: 0 } });
  const bad = (b, re) => assert.throws(() => sb.validateSysJob({ name: 'x', dest: '/tank/backups/s', apps: ['compose:a'], ...b }, { datasets }), re);
  bad({ apps: [], vms: [] }, /minstens één/);
  bad({ apps: ['compose:../x'] }, /bestaat niet/);
  bad({ vms: ['a/b'] }, /bestaat niet/);
  bad({ dest: '/tank' }, /niet de hele pool/);
  bad({ dest: '/etc' }, /pools/);
  bad({ name: '' }, /naam/);
});

test('virsh: back-up-XML en voortgang', () => {
  const x = sb.backupXml([{ target: 'vda' }], [{ target: 'sda' }], "/tank/backups/s/2026-10-23_020000/vms/haos's");
  assert.match(x, /<domainbackup mode='push'>/);
  assert.match(x, /<disk name='vda' backup='yes' type='file'><target file='\/tank\/backups\/s\/2026-10-23_020000\/vms\/haos&apos;s\/vda.qcow2'\/><driver type='qcow2'\/><\/disk>/);
  assert.match(x, /<disk name='sda' backup='no'\/>/);
  const info = sb.parseJobInfo('Job type:         Unbounded\nOperation:        Backup\nTime elapsed:     2051         ms\nData processed:   1073741824 bytes\nData remaining:   3221225472 bytes\nData total:       4294967296 bytes\n');
  assert.deepEqual(info, { type: 'Unbounded', processed: 1073741824, total: 4294967296 });
  assert.equal(sb.parseJobInfo('Job type:         None\n').type, 'None');
});

test('oude back-ups opruimen', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-prune-'));
  for (const d of ['2026-10-20_020000', '2026-10-21_020000', '2026-10-22_020000', '2026-10-23_020000']) {
    fs.mkdirSync(path.join(dest, d)); fs.writeFileSync(path.join(dest, d, 'manifest.json'), '{}');
  }
  fs.mkdirSync(path.join(dest, 'eigen-map')); // niet van ons: blijft
  fs.mkdirSync(path.join(dest, '2026-10-19_020000')); // zonder manifest (onvolledig): blijft
  assert.deepEqual(sb.prune(dest, 2), ['2026-10-20_020000', '2026-10-21_020000']);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['2026-10-19_020000', '2026-10-22_020000', '2026-10-23_020000', 'eigen-map']);
});
