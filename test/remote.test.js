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
