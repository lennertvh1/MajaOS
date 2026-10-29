'use strict';
/*
 * The server's own screen (the console): above the login prompt the MajaOS logo, the address to open and what to do
 * there, in /etc/issue.d/majaos.issue. agetty fills in \4{card} (the IPv4 address of the card with the default route)
 * itself, so the address stays right when DHCP hands out another one. Without a card agetty takes the first card that
 * is up, and before the network is up the address of the host name (127.0.0.1); with a card it shows nothing until
 * that card has an address. MajaOS writes it at every start and after the account, host name or HTTPS changes;
 * the ISO installer writes the first one (node lib/issue.js) so it is there at the very first boot.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./system');

const FILE = process.env.ISSUE_FILE || '/etc/issue.d/majaos.issue';
const ROUTE_FILE = process.env.ISSUE_ROUTE_FILE || '/proc/net/route';
const INTERFACES_FILE = process.env.ISSUE_INTERFACES_FILE || '/etc/network/interfaces';
const IFACE = /^[A-Za-z0-9_.-]{1,15}$/;
const DEBIAN_ISSUE = process.env.DEBIAN_ISSUE_FILE || '/etc/issue';

// "MajaOS" in figlet's standard font.
const LOGO = [
  ' __  __       _        ___  ____',
  '|  \\/  | __ _(_) __ _ / _ \\/ ___|',
  '| |\\/| |/ _` | |/ _` | | | \\___ \\',
  '| |  | | (_| | | (_| | |_| |___) |',
  '|_|  |_|\\__,_|/ |\\__,_|\\___/|____/',
  '            |__/',
];

// agetty reads a backslash as the start of an escape (\4, \n, …): a backslash that must show is written twice.
const literal = (s) => String(s).replace(/\\/g, '\\\\');

// The card of the default route in /proc/net/route (destination and mask 00000000; the lowest metric wins).
function parseRoutes(text) {
  const rows = String(text || '').split('\n').slice(1).map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 8 && c[1] === '00000000' && c[7] === '00000000' && IFACE.test(c[0]))
    .sort((a, b) => Number(a[6]) - Number(b[6]));
  return rows.length ? rows[0][0] : null;
}

// Without a route yet (the network isn't up, or the installer): the card in /etc/network/interfaces with a gateway,
// otherwise the only card with DHCP. Several DHCP cards: unknown (null).
function parseInterfaces(text) {
  let cur = null;
  const cards = [];
  for (const line of String(text || '').split('\n').map((l) => l.trim())) {
    const m = line.match(/^iface\s+(\S+)\s+inet\s+(\S+)/);
    if (m) { cur = m[1] === 'lo' || !IFACE.test(m[1]) ? null : { name: m[1], dhcp: m[2] === 'dhcp', gateway: false }; if (cur) cards.push(cur); continue; }
    if (/^(iface|auto|allow-|source|mapping)\b/.test(line)) cur = null;
    else if (cur && /^gateway\s+\S+/.test(line)) cur.gateway = true;
  }
  const gw = cards.find((c) => c.gateway);
  if (gw) return gw.name;
  const dhcp = cards.filter((c) => c.dhcp);
  return dhcp.length === 1 ? dhcp[0].name : null;
}

const readOr = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
function homeIface() {
  const env = process.env.MAJAOS_IFACE;
  if (env && IFACE.test(env)) return env;
  return parseRoutes(readOr(ROUTE_FILE)) || parseInterfaces(readOr(INTERFACES_FILE));
}

// {https, httpsPort, port, setup, hostname, mdns, iface}: mdns = avahi runs, so <host>.local works in the browser.
function issueText({ https = true, httpsPort = 443, port = 80, setup = false, hostname = '', mdns = false, iface = null } = {}) {
  const scheme = https ? 'https' : 'http';
  const p = Number(https ? httpsPort : port);
  const suffix = p === (https ? 443 : 80) ? '' : ':' + p;
  // \e[H\e[2J (agetty: \e = escape) clears the screen first: when the address changes, agetty --reload draws the
  // text again, and without this the old one (e.g. 127.0.1.1 before the network was up) would stay above it.
  const lines = ['\\e[H\\e[2J', ...LOGO.map((l) => '  ' + literal(l)), '',
    `  Open MajaOS in your browser:  ${scheme}://\\4${iface && IFACE.test(iface) ? '{' + iface + '}' : ''}${suffix}`];
  if (mdns && /^[a-z0-9-]+$/i.test(hostname)) lines.push(`                           or:  ${scheme}://${hostname}.local${suffix}`);
  lines.push(setup ? '  and create your account there: the welcome wizard helps you along.' : '  and sign in there.');
  if (https) lines.push('  The browser warns about the certificate the first time: that is expected.');
  return lines.join('\n') + '\n\n';
}

// Debian's own line ("Debian GNU/Linux 13 \n \l") above the logo only adds noise: empty it once.
function quietDebianIssue() {
  try {
    if (/^Debian GNU\/Linux/.test(fs.readFileSync(DEBIAN_ISSUE, 'utf8'))) fs.writeFileSync(DEBIAN_ISSUE, '');
  } catch { /* not there: nothing to do */ }
}

// Writes the text when it changed and lets the waiting login prompts show it (agetty --reload).
async function write(opts = {}) {
  const text = issueText({ ...opts, iface: opts.iface === undefined ? homeIface() : opts.iface });
  let old = '';
  try { old = fs.readFileSync(FILE, 'utf8'); } catch { /* first time */ }
  quietDebianIssue();
  if (old === text) return false;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, text);
  await run('agetty', ['--reload']).catch(() => {});
  return true;
}

const hasMdns = () => fs.existsSync('/usr/sbin/avahi-daemon');

module.exports = { issueText, write, literal, hasMdns, parseRoutes, parseInterfaces, homeIface, LOGO };

// The name in /etc/hostname: in the installer's chroot os.hostname() is the installer's own name.
function hostnameFile() { try { return fs.readFileSync('/etc/hostname', 'utf8').trim() || os.hostname(); } catch { return os.hostname(); } }

// The ISO installer: the first text, before MajaOS ever ran (a new server: no account yet, https on 443).
if (require.main === module) write({ setup: true, hostname: hostnameFile(), mdns: hasMdns() }).catch((e) => { console.error(e.message); process.exit(1); });
