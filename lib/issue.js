'use strict';
/*
 * The server's own screen (the console): above the login prompt the MajaOS logo, the address to open and what to do
 * there, in /etc/issue.d/majaos.issue. agetty fills in \4 (the IPv4 address) itself, so the address stays right when
 * DHCP hands out another one. MajaOS writes it at every start and after the account, host name or HTTPS changes;
 * the ISO installer writes the first one (node lib/issue.js) so it is there at the very first boot.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./system');

const FILE = process.env.ISSUE_FILE || '/etc/issue.d/majaos.issue';
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

// {https, httpsPort, port, setup, hostname, mdns}: mdns = avahi runs, so <host>.local works in the browser.
function issueText({ https = true, httpsPort = 443, port = 80, setup = false, hostname = '', mdns = false } = {}) {
  const scheme = https ? 'https' : 'http';
  const p = Number(https ? httpsPort : port);
  const suffix = p === (https ? 443 : 80) ? '' : ':' + p;
  // \e[H\e[2J (agetty: \e = escape) clears the screen first: when the address changes, agetty --reload draws the
  // text again, and without this the old one (e.g. 127.0.1.1 before the network was up) would stay above it.
  const lines = ['\\e[H\\e[2J', ...LOGO.map((l) => '  ' + literal(l)), '',
    `  Open MajaOS in your browser:  ${scheme}://\\4${suffix}`];
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
async function write(opts) {
  const text = issueText(opts);
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

module.exports = { issueText, write, literal, hasMdns, LOGO };

// The name in /etc/hostname: in the installer's chroot os.hostname() is the installer's own name.
function hostnameFile() { try { return fs.readFileSync('/etc/hostname', 'utf8').trim() || os.hostname(); } catch { return os.hostname(); } }

// The ISO installer: the first text, before MajaOS ever ran (a new server: no account yet, https on 443).
if (require.main === module) write({ setup: true, hostname: hostnameFile(), mdns: hasMdns() }).catch((e) => { console.error(e.message); process.exit(1); });
