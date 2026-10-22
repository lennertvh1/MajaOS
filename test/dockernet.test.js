'use strict';
/* Tests voor Docker-netwerken: controle van het formulier, uitvoer van Docker, compose-formulier en appstore. */
const test = require('node:test');
const assert = require('node:assert/strict');
const dn = require('../lib/dockernet');
const cf = require('../lib/composeform');
const store = require('../lib/appstore');
const { webui } = require('../lib/docker');

const PARENTS = [{ name: 'br0', kind: 'bridge', address: '192.168.1.10', subnet: '192.168.1.0/24', gateway: '192.168.1.1' }];
const EXISTING = [{ name: 'media_default', subnet: '172.18.0.0/16' }];
const opts = { parents: PARENTS, existing: EXISTING };

test('netwerk aanmaken: bridge en macvlan', () => {
  assert.deepEqual(dn.validateNetwork({ name: 'apps', driver: 'bridge' }, opts), {
    Name: 'apps', Driver: 'bridge', Internal: false, Attachable: true, EnableIPv6: false,
    IPAM: { Driver: 'default', Config: [] }, Options: {}, Labels: { thuisbasis: '1' } });
  const b = dn.validateNetwork({ name: 'db', driver: 'bridge', subnet: '172.30.0.7/24', internal: true }, opts);
  assert.deepEqual(b.IPAM.Config, [{ Subnet: '172.30.0.0/24' }]); // netwerkadres rechtgezet
  assert.equal(b.Internal, true);
  const m = dn.validateNetwork({ name: 'lan', driver: 'macvlan', parent: 'br0', subnet: '192.168.1.0/24', gateway: '192.168.1.1', ipRange: '192.168.1.192/27', internal: true }, opts);
  assert.deepEqual(m.IPAM.Config, [{ Subnet: '192.168.1.0/24', Gateway: '192.168.1.1', IPRange: '192.168.1.192/27' }]);
  assert.deepEqual(m.Options, { parent: 'br0' });
  assert.equal(m.Internal, false); // alleen voor bridges
  assert.deepEqual(dn.validateNetwork({ name: 'lan2', driver: 'ipvlan', parent: 'br0', subnet: '192.168.1.0/24', gateway: '192.168.1.1' }, opts).Options, { parent: 'br0', ipvlan_mode: 'l2' });
});

test('netwerk aanmaken: foute invoer', () => {
  const bad = (f, re) => assert.throws(() => dn.validateNetwork({ name: 'lan', driver: 'macvlan', parent: 'br0', subnet: '192.168.1.0/24', gateway: '192.168.1.1', ...f }, opts), re);
  bad({ name: '-x' }, /Kies een naam/);
  bad({ name: 'bridge' }, /bestaat al/);
  bad({ name: 'media_default' }, /bestaat al/);
  bad({ driver: 'overlay' }, /soort netwerk/);
  bad({ subnet: '' }, /subnet van je thuisnetwerk/);
  bad({ subnet: '192.168.1.0' }, /geen geldig subnet/);
  bad({ gateway: '' }, /gateway/);
  bad({ gateway: '10.0.0.1' }, /ligt niet in het subnet/);
  bad({ ipRange: '192.168.2.0/27' }, /IP-bereik .* ligt niet/);
  bad({ ipRange: '192.168.0.0/16' }, /IP-bereik .* ligt niet/);
  bad({ parent: 'eth9' }, /netwerkkaart/);
  bad({ subnet: '172.18.5.0/24', gateway: '172.18.5.1' }, /overlapt met het netwerk media_default/);
  bad({ driver: 'bridge', subnet: '192.168.1.0/24', gateway: '' }, /eigen subnet nodig/);
});

test('uitvoer van GET /networks/<id> samenvatten', () => {
  const n = dn.summarize({
    Name: 'lan', Id: 'abc', Driver: 'macvlan', Internal: false, Options: { parent: 'br0' }, Labels: { thuisbasis: '1' },
    IPAM: { Config: [{ Subnet: 'fd00::/64' }, { Subnet: '192.168.1.0/24', Gateway: '192.168.1.1', IPRange: '192.168.1.192/27' }] },
    Containers: { x: { Name: 'pihole', IPv4Address: '192.168.1.200/24' }, y: { Name: 'adguard', IPv4Address: '' } },
  });
  assert.deepEqual([n.subnet, n.gateway, n.ipRange, n.parent, n.ours, n.builtin], ['192.168.1.0/24', '192.168.1.1', '192.168.1.192/27', 'br0', true, false]);
  assert.deepEqual(n.containers, [{ name: 'adguard', ip: null }, { name: 'pihole', ip: '192.168.1.200' }]);
  assert.equal(dn.summarize({ Name: 'host', Driver: 'host' }).builtin, true);
  assert.equal(dn.checkIp('192.168.1.200', '192.168.1.0/24'), '192.168.1.200');
  assert.throws(() => dn.checkIp('10.0.0.2', '192.168.1.0/24'), /ligt niet in het subnet/);
  assert.throws(() => dn.checkIp('10.0.0.2', null), /eigen subnet/);
});

const PROJECT = {
  name: 'dns',
  services: { pihole: { image: 'pihole/pihole', networks: { default: null } }, other: { image: 'x', networks: ['default'] } },
  networks: { default: { name: 'dns_default' } },
};

test('compose-formulier: een eigen netwerk kiezen met een vast adres, en terug', () => {
  const f = cf.serviceForm(PROJECT, 'pihole');
  assert.equal(f.network, ''); assert.deepEqual(f.projectNetworks, []);
  const out = cf.applyServiceForm(PROJECT, { ...f, network: 'lan', ip: '192.168.1.200' });
  assert.deepEqual(out.services.pihole.networks, { lan: { ipv4_address: '192.168.1.200' } });
  assert.deepEqual(out.networks, { default: { name: 'dns_default' }, lan: { external: true } });
  const f2 = cf.serviceForm(out, 'pihole');
  assert.deepEqual([f2.network, f2.ip], ['lan', '192.168.1.200']);
  assert.deepEqual(f2.projectNetworks, [{ key: 'lan', name: 'lan', external: true }]);
  // Zonder wijziging blijft alles staan.
  assert.deepEqual(cf.applyServiceForm(out, f2), out);
  // Terug naar standaard: het externe netwerk wordt niet meer gebruikt en verdwijnt.
  const back = cf.applyServiceForm(out, { ...f2, network: '', ip: '' });
  assert.equal('networks' in back.services.pihole, false);
  assert.deepEqual(back.networks, { default: { name: 'dns_default' } });
  assert.throws(() => cf.applyServiceForm(PROJECT, { ...f, network: 'lan', ip: '192.168.1' }), /geen geldig IP-adres/);
  // Meerdere netwerken: niet aan te passen met het formulier, blijven zoals ze zijn.
  const multi = { ...PROJECT, services: { ...PROJECT.services, pihole: { image: 'p', networks: { a: null, b: { aliases: ['dns'] } } } } };
  const fm = cf.serviceForm(multi, 'pihole');
  assert.equal(fm.network, '*');
  assert.deepEqual(cf.applyServiceForm(multi, fm).services.pihole.networks, { a: null, b: { aliases: ['dns'] } });
});

test('appstore: template met br0 en een gekozen eigen netwerk', () => {
  const app = { id: 'x', name: 'Pi-hole', image: 'pihole/pihole', network: 'br0', extraParams: '', postArgs: '' };
  assert.equal(store.templateNetwork(app), 'br0');
  const fields = [{ type: 'Port', value: '8080', target: '80', mode: 'tcp' }];
  const plain = store.buildCompose(app, 'pihole', fields, { tz: 'Europe/Brussels' });
  assert.match(plain.warnings.join(), /netwerk "br0"/);
  assert.match(plain.text, /ports:\n {6}- "8080:80\/tcp"/);
  const own = store.buildCompose(app, 'pihole', fields, { tz: 'Europe/Brussels', network: { mode: 'custom', name: 'lan', ownIp: true, ip: '192.168.1.200' } });
  assert.doesNotMatch(own.text, /ports:/); // eigen adres: geen poorten op de server
  assert.match(own.text, /networks:\n {6}lan:\n {8}ipv4_address: "192\.168\.1\.200"/);
  assert.match(own.text, /\nnetworks:\n {2}lan:\n {4}external: true/);
  assert.doesNotMatch(own.warnings.join(), /netwerk "br0"/);
});

test('WebUI met een eigen adres in het thuisnetwerk', () => {
  const ports = [{ public: 8080, private: 80, type: 'TCP' }];
  assert.equal(webui({ 'thuisbasis.webui': 'http://[IP]:[PORT:80]/admin' }, ports), 'http://[IP]:8080/admin');
  assert.equal(webui({ 'thuisbasis.webui': 'http://[IP]:[PORT:80]/admin' }, [], null, '192.168.1.200'), 'http://192.168.1.200:80/admin');
  assert.equal(webui({}, [], null, '192.168.1.200'), null);
});

test('appstore: extra poorten, en niet bij host of een eigen adres', () => {
  const app = { id: 'x', name: 'Plex', image: 'plexinc/pms-docker', network: 'host', extraParams: '', postArgs: '' };
  const extraPorts = [{ host: '32400', container: '32400', protocol: 'tcp' }];
  const bridge = store.buildCompose(app, 'plex', [], { tz: 'Europe/Brussels', network: { mode: 'bridge', name: null, ownIp: false }, extraPorts });
  assert.match(bridge.text, /ports:\n {6}- "32400:32400\/tcp"/);
  assert.doesNotMatch(bridge.text, /network_mode/);
  const host = store.buildCompose(app, 'plex', [], { tz: 'Europe/Brussels', extraPorts });
  assert.match(host.text, /network_mode: "host"/);
  assert.doesNotMatch(host.text, /ports:/);
  assert.match(host.warnings.join(), /pas dan een poort aan of kies het standaardnetwerk/);
});
