'use strict';
/* Tests for Docker networks: checking the form, Docker's output, the compose form and the app store. */
const test = require('node:test');
const assert = require('node:assert/strict');
const dn = require('../lib/dockernet');
const cf = require('../lib/composeform');
const store = require('../lib/appstore');
const { webui } = require('../lib/docker');

const PARENTS = [{ name: 'br0', kind: 'bridge', address: '192.168.1.10', subnet: '192.168.1.0/24', gateway: '192.168.1.1' }];
const EXISTING = [{ name: 'media_default', subnet: '172.18.0.0/16' }];
const opts = { parents: PARENTS, existing: EXISTING };

test('creating a network: bridge and macvlan', () => {
  assert.deepEqual(dn.validateNetwork({ name: 'apps', driver: 'bridge' }, opts), {
    Name: 'apps', Driver: 'bridge', Internal: false, Attachable: true, EnableIPv6: false,
    IPAM: { Driver: 'default', Config: [] }, Options: {}, Labels: { majaos: '1' } });
  const b = dn.validateNetwork({ name: 'db', driver: 'bridge', subnet: '172.30.0.7/24', internal: true }, opts);
  assert.deepEqual(b.IPAM.Config, [{ Subnet: '172.30.0.0/24' }]); // netwerkadres rechtgezet
  assert.equal(b.Internal, true);
  const m = dn.validateNetwork({ name: 'lan', driver: 'macvlan', parent: 'br0', subnet: '192.168.1.0/24', gateway: '192.168.1.1', ipRange: '192.168.1.192/27', internal: true }, opts);
  assert.deepEqual(m.IPAM.Config, [{ Subnet: '192.168.1.0/24', Gateway: '192.168.1.1', IPRange: '192.168.1.192/27' }]);
  assert.deepEqual(m.Options, { parent: 'br0' });
  assert.equal(m.Internal, false); // only for bridges
  assert.deepEqual(dn.validateNetwork({ name: 'lan2', driver: 'ipvlan', parent: 'br0', subnet: '192.168.1.0/24', gateway: '192.168.1.1' }, opts).Options, { parent: 'br0', ipvlan_mode: 'l2' });
});

test('creating a network: wrong input', () => {
  const bad = (f, re) => assert.throws(() => dn.validateNetwork({ name: 'lan', driver: 'macvlan', parent: 'br0', subnet: '192.168.1.0/24', gateway: '192.168.1.1', ...f }, opts), re);
  bad({ name: '-x' }, /Choose a name/);
  bad({ name: 'bridge' }, /already exists/);
  bad({ name: 'media_default' }, /already exists/);
  bad({ driver: 'overlay' }, /network type/);
  bad({ subnet: '' }, /subnet of your home network/);
  bad({ subnet: '192.168.1.0' }, /not a valid subnet/);
  bad({ gateway: '' }, /gateway/);
  bad({ gateway: '10.0.0.1' }, /is not in the subnet/);
  bad({ ipRange: '192.168.2.0/27' }, /IP range .* is not in the subnet/);
  bad({ ipRange: '192.168.0.0/16' }, /IP range .* is not in the subnet/);
  bad({ parent: 'eth9' }, /network card \(or bridge\)/);
  bad({ subnet: '172.18.5.0/24', gateway: '172.18.5.1' }, /overlaps with the network media_default/);
  bad({ driver: 'bridge', subnet: '192.168.1.0/24', gateway: '' }, /needs its own subnet/);
});

test('summarising the output of GET /networks/<id>', () => {
  const n = dn.summarize({
    Name: 'lan', Id: 'abc', Driver: 'macvlan', Internal: false, Options: { parent: 'br0' }, Labels: { majaos: '1' },
    IPAM: { Config: [{ Subnet: 'fd00::/64' }, { Subnet: '192.168.1.0/24', Gateway: '192.168.1.1', IPRange: '192.168.1.192/27' }] },
    Containers: { x: { Name: 'pihole', IPv4Address: '192.168.1.200/24' }, y: { Name: 'adguard', IPv4Address: '' } },
  });
  assert.deepEqual([n.subnet, n.gateway, n.ipRange, n.parent, n.ours, n.builtin], ['192.168.1.0/24', '192.168.1.1', '192.168.1.192/27', 'br0', true, false]);
  assert.deepEqual(n.containers, [{ name: 'adguard', ip: null }, { name: 'pihole', ip: '192.168.1.200' }]);
  assert.equal(dn.summarize({ Name: 'host', Driver: 'host' }).builtin, true);
  assert.equal(dn.checkIp('192.168.1.200', '192.168.1.0/24'), '192.168.1.200');
  assert.throws(() => dn.checkIp('10.0.0.2', '192.168.1.0/24'), /is not in this network's subnet/);
  assert.throws(() => dn.checkIp('10.0.0.2', null), /its own subnet/);
});

const PROJECT = {
  name: 'dns',
  services: { pihole: { image: 'pihole/pihole', networks: { default: null } }, other: { image: 'x', networks: ['default'] } },
  networks: { default: { name: 'dns_default' } },
};

test('compose form: choosing a custom network with a fixed address, and back', () => {
  const f = cf.serviceForm(PROJECT, 'pihole');
  assert.equal(f.network, ''); assert.deepEqual(f.projectNetworks, []);
  const out = cf.applyServiceForm(PROJECT, { ...f, network: 'lan', ip: '192.168.1.200' });
  assert.deepEqual(out.services.pihole.networks, { lan: { ipv4_address: '192.168.1.200' } });
  assert.deepEqual(out.networks, { default: { name: 'dns_default' }, lan: { external: true } });
  const f2 = cf.serviceForm(out, 'pihole');
  assert.deepEqual([f2.network, f2.ip], ['lan', '192.168.1.200']);
  assert.deepEqual(f2.projectNetworks, [{ key: 'lan', name: 'lan', external: true }]);
  // Without a change everything stays.
  assert.deepEqual(cf.applyServiceForm(out, f2), out);
  // Back to default: the external network is no longer used and disappears.
  const back = cf.applyServiceForm(out, { ...f2, network: '', ip: '' });
  assert.equal('networks' in back.services.pihole, false);
  assert.deepEqual(back.networks, { default: { name: 'dns_default' } });
  assert.throws(() => cf.applyServiceForm(PROJECT, { ...f, network: 'lan', ip: '192.168.1' }), /not a valid IP address/);
  // Several networks: can't be changed with the form, they stay as they are.
  const multi = { ...PROJECT, services: { ...PROJECT.services, pihole: { image: 'p', networks: { a: null, b: { aliases: ['dns'] } } } } };
  const fm = cf.serviceForm(multi, 'pihole');
  assert.equal(fm.network, '*');
  assert.deepEqual(cf.applyServiceForm(multi, fm).services.pihole.networks, { a: null, b: { aliases: ['dns'] } });
});

test('app store: template with br0 and a chosen custom network', () => {
  const app = { id: 'x', name: 'Pi-hole', image: 'pihole/pihole', network: 'br0', extraParams: '', postArgs: '' };
  assert.equal(store.templateNetwork(app), 'br0');
  const fields = [{ type: 'Port', value: '8080', target: '80', mode: 'tcp' }];
  const plain = store.buildCompose(app, 'pihole', fields, { tz: 'Europe/Brussels' });
  assert.match(plain.warnings.join(), /network "br0"/);
  assert.match(plain.text, /ports:\n {6}- "8080:80\/tcp"/);
  const own = store.buildCompose(app, 'pihole', fields, { tz: 'Europe/Brussels', network: { mode: 'custom', name: 'lan', ownIp: true, ip: '192.168.1.200' } });
  assert.doesNotMatch(own.text, /ports:/); // own address: no ports on the server
  assert.match(own.text, /networks:\n {6}lan:\n {8}ipv4_address: "192\.168\.1\.200"/);
  assert.match(own.text, /\nnetworks:\n {2}lan:\n {4}external: true/);
  assert.doesNotMatch(own.warnings.join(), /network "br0"/);
});

test('WebUI with an own address in the home network', () => {
  const ports = [{ public: 8080, private: 80, type: 'TCP' }];
  assert.equal(webui({ 'majaos.webui': 'http://[IP]:[PORT:80]/admin' }, ports), 'http://[IP]:8080/admin');
  assert.equal(webui({ 'majaos.webui': 'http://[IP]:[PORT:80]/admin' }, [], null, '192.168.1.200'), 'http://192.168.1.200:80/admin');
  assert.equal(webui({}, [], null, '192.168.1.200'), null);
});

test('WebUI op bridge en host', () => {
  // Template for host (port 8123) put on bridge with one published port: that port.
  assert.equal(webui({ 'majaos.webui': 'http://[IP]:[PORT:8123]' }, [{ public: 8124, private: 80, type: 'TCP' }]), 'http://[IP]:8124');
  // Several ports and none that fits: the template's port.
  assert.equal(webui({ 'majaos.webui': 'http://[IP]:[PORT:8123]' }, [{ public: 1, private: 2, type: 'TCP' }, { public: 3, private: 4, type: 'TCP' }]), 'http://[IP]:8123');
  // TCP goes before UDP with the same port.
  assert.equal(webui({ 'majaos.webui': 'http://[IP]:[PORT:53]/' }, [{ public: 5353, private: 53, type: 'UDP' }, { public: 5300, private: 53, type: 'TCP' }]), 'http://[IP]:5300/');
  assert.equal(webui({ 'majaos.webui': 'http://[IP]:[PORT:8123]' }, [], null, null, true), 'http://[IP]:8123');
});

test('app store: extra ports, and not with host or an own address', () => {
  const app = { id: 'x', name: 'Plex', image: 'plexinc/pms-docker', network: 'host', extraParams: '', postArgs: '' };
  const extraPorts = [{ host: '32400', container: '32400', protocol: 'tcp' }];
  const bridge = store.buildCompose(app, 'plex', [], { tz: 'Europe/Brussels', network: { mode: 'bridge', name: null, ownIp: false }, extraPorts });
  assert.match(bridge.text, /ports:\n {6}- "32400:32400\/tcp"/);
  assert.doesNotMatch(bridge.text, /network_mode/);
  const host = store.buildCompose(app, 'plex', [], { tz: 'Europe/Brussels', extraPorts });
  assert.match(host.text, /network_mode: "host"/);
  assert.doesNotMatch(host.text, /ports:/);
  assert.equal(host.warnings.join(), ''); // host is the normal choice now: no warning
});

test('the shared maja network: a free subnet and a free address', () => {
  const c = (x) => dn.parseCidr(x, 0, 32);
  assert.equal(dn.pickMajaSubnet([c('172.17.0.0/16'), c('192.168.1.0/24')]).text, '172.30.0.0/16');
  assert.equal(dn.pickMajaSubnet([c('172.30.5.0/24')]).text, '172.29.0.0/16');
  const n = { name: 'maja', subnet: '172.30.0.0/16', gateway: '172.30.0.1', containers: [{ name: 'jellyfin', ip: '172.30.0.10/16' }] };
  assert.equal(dn.checkFreeIp('172.30.0.11', n), '172.30.0.11');
  assert.equal(dn.checkFreeIp('172.30.0.10', n, 'jellyfin'), '172.30.0.10'); // its own address when editing
  assert.throws(() => dn.checkFreeIp('172.30.0.10', n, 'plex'), /already used by jellyfin/);
  assert.throws(() => dn.checkFreeIp('172.30.0.1', n), /gateway/);
  assert.throws(() => dn.checkFreeIp('172.30.255.255', n), /can't be used/);
  assert.throws(() => dn.checkFreeIp('10.0.0.5', n), /not in this network's subnet/);
});

test('own address in the home network: the IP range Docker may hand out', () => {
  assert.equal(dn.lanRange('10.10.10.0/24'), '10.10.10.224/27');
  assert.equal(dn.lanRange('192.168.0.0/16'), '192.168.255.224/27');
  assert.equal(dn.lanRange('10.0.0.0/28'), null); // too small
});

test('addresses for apps in the home network: a range you choose, else the IP range', () => {
  const lan = { name: 'lan', subnet: '10.10.10.0/24', gateway: '10.10.10.1', ipRange: '10.10.10.224/27', containers: [{ name: 'pihole', ip: '10.10.10.53' }] };
  // Without a range of your own: the IP range, without the broadcast address.
  assert.deepEqual(dn.appRange(lan, null), { from: '10.10.10.224', to: '10.10.10.254', custom: false });
  assert.deepEqual(dn.defaultRange('10.10.10.0/24', null), { from: '10.10.10.224', to: '10.10.10.254' });
  // Your own range, any part of the subnet; one that no longer fits the subnet is ignored.
  assert.deepEqual(dn.appRange(lan, { from: '10.10.10.231', to: '10.10.10.250' }), { from: '10.10.10.231', to: '10.10.10.250', custom: true });
  assert.equal(dn.appRange(lan, { from: '192.168.1.2', to: '192.168.1.9' }).custom, false);
  // Checking the form.
  assert.deepEqual(dn.validateRange({ from: ' 10.10.10.231 ', to: '10.10.10.250' }, '10.10.10.0/24'), { from: '10.10.10.231', to: '10.10.10.250' });
  assert.equal(dn.validateRange({ from: '', to: '' }, '10.10.10.0/24'), null); // back to the default
  assert.throws(() => dn.validateRange({ from: '10.10.10.250', to: '10.10.10.231' }, '10.10.10.0/24'), /must come before/);
  assert.throws(() => dn.validateRange({ from: '10.10.11.2', to: '10.10.10.231' }, '10.10.10.0/24'), /not in your home network/);
  assert.throws(() => dn.validateRange({ from: '10.10.10.200', to: '10.10.10.255' }, '10.10.10.0/24'), /can't be used/);
  assert.throws(() => dn.validateRange({ from: 'x', to: '10.10.10.231' }, '10.10.10.0/24'), /not a valid IP address/);
  assert.ok(dn.inRange('10.10.10.231', { from: '10.10.10.231', to: '10.10.10.250' }));
  assert.ok(!dn.inRange('10.10.10.251', { from: '10.10.10.231', to: '10.10.10.250' }));
});

test('a fixed address in the home network: also outside the range, never the server\'s own', () => {
  const lan = { name: 'lan', subnet: '10.10.10.0/24', gateway: '10.10.10.1', ipRange: '10.10.10.224/27', containers: [{ name: 'pihole', ip: '10.10.10.53' }] };
  const home = { name: 'br0', address: '10.10.10.152', subnet: '10.10.10.0/24', gateway: '10.10.10.1' };
  assert.equal(dn.checkLanIp('10.10.10.230', lan, home), '10.10.10.230');
  assert.equal(dn.checkLanIp('10.10.10.180', lan, home), '10.10.10.180'); // outside the range: allowed (the browser warns)
  assert.throws(() => dn.checkLanIp('10.10.10.152', lan, home), /server's own address/);
  assert.equal(dn.checkLanIp('10.10.10.53', lan, home, 'pihole'), '10.10.10.53'); // its own address when editing
  assert.throws(() => dn.checkLanIp('10.10.10.53', lan, home), /already used by pihole/);
});
