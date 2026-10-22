'use strict';
/* Tests voor de terminal: tickets, berichten, de WebSocket met een shell erachter, en de beveiligingsinstellingen. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
const term = require('../lib/terminal');
const settings = require('../lib/settings');
const wsock = require('../lib/websocket');

test('tickets zijn eenmalig', () => {
  const t = term.newTicket();
  assert.equal(term.useTicket(t), true);
  assert.equal(term.useTicket(t), false);
  assert.equal(term.useTicket('verzonnen'), false);
  assert.equal(term.useTicket(undefined), false);
});

test('berichten van de browser', () => {
  assert.deepEqual(term.parseMessage('{"t":"d","d":"ls\\r"}'), { t: 'd', d: 'ls\r' });
  assert.deepEqual(term.parseMessage('{"t":"r","cols":120.4,"rows":40}'), { t: 'r', cols: 120, rows: 40 });
  assert.equal(term.parseMessage('{"t":"r","cols":5,"rows":40}'), null);
  assert.equal(term.parseMessage('{"t":"x"}'), null);
  assert.equal(term.parseMessage('geen json'), null);
});

test('beveiliging: minder streng maken vraagt het wachtwoord', () => {
  const check = (pw) => pw === 'geheim';
  const def = settings.getSettings();
  assert.deepEqual({ terminal: def.terminal, terminalPassword: def.terminalPassword }, { terminal: true, terminalPassword: true });
  assert.equal(settings.saveSettings({ terminal: false }, { checkPassword: check }).terminal, false); // strenger: mag zonder
  assert.throws(() => settings.saveSettings({ terminal: true }, { checkPassword: check }), /Typ je wachtwoord/);
  assert.equal(settings.saveSettings({ terminal: true, password: 'geheim' }, { checkPassword: check }).terminal, true);
  assert.throws(() => settings.saveSettings({ terminalPassword: false }, { checkPassword: check }), /Typ je wachtwoord/);
  assert.equal(settings.saveSettings({ terminalPassword: false, password: 'geheim' }, { checkPassword: check }).terminalPassword, false);
  assert.equal(settings.saveSettings({ terminalPassword: true }, { checkPassword: check }).terminalPassword, true);
});

test('WebSocket met een shell erachter: toetsen erin, uitvoer eruit', async () => {
  const net = require('node:net'), http = require('node:http');
  const web = http.createServer();
  web.on('upgrade', (req, socket, head) => { const c = wsock.acceptWebSocket(req, socket, head); term.attach(c, { command: ['sh', '-c', 'cat'], log: () => {} }); });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const out = await new Promise((resolve, reject) => {
    const c = net.connect(web.address().port, '127.0.0.1', () => {
      c.write('GET /api/terminal HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      const mask = [7, 7, 7, 7], data = Buffer.from(JSON.stringify({ t: 'd', d: 'hallo\n' }));
      c.write(Buffer.concat([Buffer.from([0x81, 0x80 | data.length, ...mask]), data.map((b, i) => b ^ mask[i & 3])]));
    });
    let buf = Buffer.alloc(0);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0 && buf.subarray(end + 4).includes('hallo')) { resolve({ head: buf.subarray(0, end).toString(), body: buf.subarray(end + 4) }); c.destroy(); }
    });
    c.on('error', reject);
    setTimeout(() => reject(new Error('geen antwoord')), 4000);
  });
  web.close();
  assert.match(out.head, /^HTTP\/1\.1 101/);
  assert.equal(out.body[0], 0x82); // binair frame met de uitvoer van de shell
  assert.match(out.body.toString(), /hallo/);
});
