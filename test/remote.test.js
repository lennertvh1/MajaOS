'use strict';
/* Remote access: the cloudflared unit and the public address. The tunnel itself is not started. */
const test = require('node:test');
const assert = require('node:assert/strict');
const tunnel = require('../lib/tunnel');

const LOG = `2026-10-25T18:00:00Z INF Requesting new quick Tunnel
2026-10-25T18:00:01Z INF |  https://quiet-pond-1234.trycloudflare.com  |
`;

test('a quick-tunnel log contains the public address', () => {
  assert.equal(tunnel.parseQuickUrl(LOG), 'https://quiet-pond-1234.trycloudflare.com');
  assert.equal(tunnel.parseQuickUrl('still starting'), '');
});

test('a public address is only a host', () => {
  assert.equal(tunnel.normalizePublic('home.example.com'), 'https://home.example.com');
  assert.equal(tunnel.normalizePublic('https://home.example.com/'), 'https://home.example.com');
  assert.throws(() => tunnel.normalizePublic(''), /https:\/\/home.example.com/);
  assert.throws(() => tunnel.normalizePublic('https://home.example.com/files'), /https:\/\/home.example.com/);
  assert.throws(() => tunnel.normalizePublic('https://user:pw@home.example.com'), /https:\/\/home.example.com/);
});

test('the tunnel unit never contains the token', () => {
  const token = tunnel.unitText('token', {
    bin: '/usr/bin/cloudflared', port: 80, log: '/var/lib/majaos/tunnel.log', env: '/var/lib/majaos/tunnel.env',
  });
  assert.match(token, /EnvironmentFile=\/var\/lib\/majaos\/tunnel\.env/);
  assert.match(token, /--token \$TOKEN/);
  assert.doesNotMatch(token, /eyJ/);
  const quick = tunnel.unitText('quick', {
    bin: '/usr/bin/cloudflared', port: 80, log: '/var/lib/majaos/tunnel.log', env: '/var/lib/majaos/tunnel.env',
  });
  assert.match(quick, /--url http:\/\/127\.0\.0\.1:80/);
  assert.doesNotMatch(quick, /TOKEN/);
});

test('an own tunnel or reverse proxy only stores the public address', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const before = process.env.DATA_DIR;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'majaos-remote-'));
  try {
    const st = await tunnel.apply({ mode: 'proxy', address: 'majaos.example.com/' });
    assert.equal(st.mode, 'proxy');
    assert.equal(st.url, 'https://majaos.example.com');
    assert.equal(tunnel.publicUrl(), 'https://majaos.example.com');
    await tunnel.retarget(); // a new web port must not start cloudflared for a proxy
    assert.equal(tunnel.publicUrl(), 'https://majaos.example.com');
    await assert.rejects(tunnel.apply({ mode: 'proxy', address: 'https://majaos.example.com/files' }), /https:\/\/home.example.com/);
    assert.equal((await tunnel.apply({ mode: 'off' })).url, '');
  } finally {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    if (before === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = before;
  }
});
