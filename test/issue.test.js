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
const issue = require('../lib/issue');

// What agetty shows: \\ becomes \, \4 becomes the address.
const shown = (text) => text.replace(/\\e\[H\\e\[2J/, '').replace(/\\(.)/g, (m, c) => (c === '4' ? '192.168.1.57' : c));

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
