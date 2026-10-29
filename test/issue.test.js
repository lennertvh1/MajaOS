'use strict';
/* The text on the server's own screen (lib/issue.js), as agetty reads it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-'));
process.env.ISSUE_FILE = path.join(dir, 'issue.d', 'majaos.issue');
process.env.DEBIAN_ISSUE_FILE = path.join(dir, 'issue');
process.env.ISSUE_ROUTE_FILE = path.join(dir, 'route');
process.env.ISSUE_INTERFACES_FILE = path.join(dir, 'interfaces');
const issue = require('../lib/issue');

// What agetty shows: \\ becomes \, \4 becomes the address.
const shown = (text) => text.replace(/\\e\[H\\e\[2J/, '').replace(/\\4(\{[^}]*\})?/g, '192.168.1.57').replace(/\\(.)/g, '$1');

test('the logo shows unchanged and the address is filled in by agetty', () => {
  const text = issue.issueText({ setup: true });
  const out = shown(text);
  for (const line of issue.LOGO) assert.ok(out.includes('  ' + line), line);
  assert.match(text, /https:\/\/\\4\n/);
  assert.match(out, /https:\/\/192\.168\.1\.57\n/);
  assert.match(out, /create your account/);
  // Every backslash in the logo is doubled, so agetty never reads one as an escape.
  assert.ok(text.startsWith('\\e[H\\e[2J'), 'the screen is cleared first');
  assert.doesNotMatch(text.replace(/\\\\/g, '').replace(/\\4/g, '').replace(/\\e/g, ''), /\\/);
});

test('ports, http and the .local name', () => {
  assert.match(issue.issueText({ https: true, httpsPort: 8443 }), /https:\/\/\\4:8443/);
  assert.match(issue.issueText({ https: false, port: 8080 }), /http:\/\/\\4:8080/);
  assert.match(issue.issueText({ https: false, port: 80 }), /http:\/\/\\4\n/);
  assert.match(issue.issueText({ hostname: 'freddy', mdns: true }), /https:\/\/freddy\.local/);
  assert.doesNotMatch(issue.issueText({ hostname: 'freddy', mdns: false }), /\.local/);
  assert.match(issue.issueText({ setup: false }), /sign in there/);
});

test('writing: only when it changed, and Debian\'s own line goes away once', async () => {
  fs.writeFileSync(process.env.DEBIAN_ISSUE_FILE, 'Debian GNU/Linux 13 \\n \\l\n\n');
  assert.equal(await issue.write({ setup: true }), true);
  assert.equal(await issue.write({ setup: true }), false);
  assert.equal(fs.readFileSync(process.env.DEBIAN_ISSUE_FILE, 'utf8'), '');
  assert.equal(await issue.write({ setup: false }), true);
  assert.match(fs.readFileSync(process.env.ISSUE_FILE, 'utf8'), /sign in there/);
});

test('the address is that of the card with the default route, never 127.0.0.1 before the network is up', async () => {
  const route = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n'
    + 'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n'
    + 'wlp3s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n'
    + 'enp1s0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n';
  assert.equal(issue.parseRoutes(route), 'enp1s0');
  assert.equal(issue.parseRoutes('Iface\tDestination\n'), null);
  assert.equal(issue.parseInterfaces('auto lo\niface lo inet loopback\n\nallow-hotplug eno1\niface eno1 inet dhcp\n'), 'eno1');
  assert.equal(issue.parseInterfaces('iface eno1 inet dhcp\niface eno2 inet static\n    address 10.0.0.2/24\n    gateway 10.0.0.1\n'), 'eno2');
  assert.equal(issue.parseInterfaces('iface eno1 inet dhcp\niface eno2 inet dhcp\n'), null);
  assert.match(issue.issueText({ iface: 'br0', httpsPort: 8443 }), /https:\/\/\\4\{br0\}:8443\n/);
  assert.match(issue.issueText({ iface: 'x;rm -rf' }), /https:\/\/\\4\n/);
  // write() finds the card itself: from the route, otherwise from /etc/network/interfaces.
  fs.writeFileSync(process.env.ISSUE_INTERFACES_FILE, 'iface eno1 inet dhcp\n');
  await issue.write({ setup: true });
  assert.match(fs.readFileSync(process.env.ISSUE_FILE, 'utf8'), /\\4\{eno1\}/);
  fs.writeFileSync(process.env.ISSUE_ROUTE_FILE, route);
  await issue.write({ setup: true });
  assert.match(fs.readFileSync(process.env.ISSUE_FILE, 'utf8'), /\\4\{enp1s0\}/);
});
