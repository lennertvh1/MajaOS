'use strict';
/* HTTPS with an own certificate. MajaOS makes its own CA once (trust it once on each device) and a server
 * certificate signed by it for the host name, <name>.local, localhost and the server's addresses. A new server
 * certificate is made when one of those changes or it expires within 30 days; the CA stays, so devices keep trusting it.
 * Files in DATA_DIR/tls (keys 0600). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const DIR = path.join(DATA_DIR, 'tls');
const file = (n) => path.join(DIR, n);
const DAY = 24 * 3600 * 1000;
const SERVER_DAYS = 397; // Apple and the browsers refuse longer server certificates
const RENEW_DAYS = 30;

// Interfaces whose addresses change with every app or VM network: leaving them out keeps the certificate stable.
const SKIP_IF = /^(docker|br-|veth|virbr|vnet|tap|lo$)/;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

function expandIpv6(ip) {
  const [head, tail = ''] = String(ip).toLowerCase().split('::');
  const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const full = String(ip).includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  return full.map((g) => parseInt(g, 16).toString(16)).join(':');
}

// The names and addresses a browser may use to reach this server.
function wantedNames(host = os.hostname(), ifaces = os.networkInterfaces()) {
  const short = String(host || '').split('.')[0];
  const dns = new Set(['localhost']);
  if (HOST.test(short)) { dns.add(short.toLowerCase()); dns.add(short.toLowerCase() + '.local'); }
  const ips = new Set(['127.0.0.1', '0:0:0:0:0:0:0:1']);
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (SKIP_IF.test(name)) continue;
    for (const a of list || []) {
      if (a.internal) continue;
      if (a.family === 'IPv4' || a.family === 4) ips.add(a.address);
      else if (!/^fe80:/i.test(a.address)) ips.add(expandIpv6(a.address));
    }
  }
  return { dns: [...dns], ips: [...ips] };
}

// "DNS:localhost, IP Address:127.0.0.1" (node:crypto) → the same shape as wantedNames.
function namesOf(cert) {
  const dns = [], ips = [];
  for (const part of String(cert.subjectAltName || '').split(/,\s*/)) {
    const m = part.match(/^(DNS|IP Address):(.+)$/);
    if (!m) continue;
    if (m[1] === 'DNS') dns.push(m[2].toLowerCase());
    else ips.push(m[2].includes(':') ? expandIpv6(m[2]) : m[2]);
  }
  return { dns, ips };
}

// Why a new server certificate is needed, or null when the current one is fine.
function renewReason({ certPem, caPem, names, now = Date.now() }) {
  if (!certPem || !caPem) return 'missing';
  let cert, ca;
  try { cert = new crypto.X509Certificate(certPem); ca = new crypto.X509Certificate(caPem); } catch { return 'unreadable'; }
  if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) return 'other CA';
  if (Date.parse(cert.validTo) - now < RENEW_DAYS * DAY) return 'expires';
  const have = namesOf(cert);
  if (names.dns.some((n) => !have.dns.includes(n)) || names.ips.some((n) => !have.ips.includes(n))) return 'names';
  return null;
}

// openssl config for the CA and the server certificate (also works with LibreSSL on a Mac).
function opensslConfig(names) {
  const san = [...names.dns.map((n) => 'DNS:' + n), ...names.ips.map((n) => 'IP:' + n)].join(', ');
  return [
    '[req]', 'distinguished_name = dn', 'prompt = no', '[dn]', 'CN = MajaOS',
    '[v3_ca]', 'basicConstraints = critical,CA:TRUE,pathlen:0', 'keyUsage = critical,keyCertSign,cRLSign', 'subjectKeyIdentifier = hash',
    '[v3_srv]', 'basicConstraints = critical,CA:FALSE', 'keyUsage = critical,digitalSignature', 'extendedKeyUsage = serverAuth',
    'subjectKeyIdentifier = hash', 'authorityKeyIdentifier = keyid', 'subjectAltName = ' + san, '',
  ].join('\n');
}

const read = (n) => { try { return fs.readFileSync(file(n), 'utf8'); } catch { return ''; } };
const subjectName = (host) => (HOST.test(String(host).split('.')[0]) ? String(host).split('.')[0] : 'server');

async function makeCa(host) {
  await run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', file('ca.key.new')]);
  fs.chmodSync(file('ca.key.new'), 0o600);
  await run('openssl', ['req', '-new', '-x509', '-key', file('ca.key.new'), '-out', file('ca.crt.new'), '-days', '3650', '-sha256',
    '-subj', `/O=MajaOS/CN=MajaOS ${subjectName(host)} CA`, '-config', file('openssl.cnf'), '-extensions', 'v3_ca']);
  fs.renameSync(file('ca.key.new'), file('ca.key'));
  fs.renameSync(file('ca.crt.new'), file('ca.crt'));
}

async function makeServer(host) {
  await run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', file('server.key.new')]);
  fs.chmodSync(file('server.key.new'), 0o600);
  await run('openssl', ['req', '-new', '-key', file('server.key.new'), '-out', file('server.csr'), '-subj', `/O=MajaOS/CN=${subjectName(host)}`, '-config', file('openssl.cnf')]);
  await run('openssl', ['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'),
    '-set_serial', '0x' + crypto.randomBytes(12).toString('hex'), '-days', String(SERVER_DAYS), '-sha256',
    '-extfile', file('openssl.cnf'), '-extensions', 'v3_srv', '-out', file('server.crt.new')]);
  fs.rmSync(file('server.csr'), { force: true });
  fs.renameSync(file('server.key.new'), file('server.key'));
  fs.renameSync(file('server.crt.new'), file('server.crt'));
}

// Makes what is missing or out of date. Returns {key, cert (server + CA), renewed, reason}.
let busy = null;
function ensure({ host = os.hostname(), ifaces } = {}) {
  if (busy) return busy;
  busy = (async () => {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const names = wantedNames(host, ifaces || os.networkInterfaces());
    fs.writeFileSync(file('openssl.cnf'), opensslConfig(names));
    let caPem = read('ca.crt');
    let caOk = false;
    try { const ca = new crypto.X509Certificate(caPem); caOk = !!read('ca.key') && Date.parse(ca.validTo) - Date.now() > RENEW_DAYS * DAY; } catch { /* none yet */ }
    if (!caOk) { await makeCa(host); caPem = read('ca.crt'); }
    const reason = renewReason({ certPem: read('server.crt'), caPem, names });
    if (reason) await makeServer(host);
    return { key: read('server.key'), cert: read('server.crt') + caPem, renewed: !!reason, reason };
  })().finally(() => { busy = null; });
  return busy;
}

// For Settings → Security.
function info() {
  try {
    const ca = new crypto.X509Certificate(read('ca.crt')), cert = new crypto.X509Certificate(read('server.crt'));
    const n = namesOf(cert);
    return {
      kind: 'own', names: [...n.dns, ...n.ips], expires: new Date(cert.validTo).toISOString(),
      caFingerprint: ca.fingerprint256, caExpires: new Date(ca.validTo).toISOString(),
    };
  } catch { return null; }
}
const caPem = () => read('ca.crt');

module.exports = { ensure, info, caPem, wantedNames, namesOf, renewReason, opensslConfig, expandIpv6, DIR };
