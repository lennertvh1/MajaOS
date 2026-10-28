'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const terminal = require('../lib/terminal');
const { dispatch, encodeFrame, createReader, safeApiPath } = require('../lib/mcp');

function fake(handler) {
  return { call: async (method, path, opts) => handler(method, path, opts) };
}

test('a frame split in two still parses', () => {
  const got = [];
  const reader = createReader((msg) => got.push(msg));
  const buf = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' });
  reader.push(buf.subarray(0, 12));
  reader.push(buf.subarray(12));
  assert.equal(got.length, 1);
  assert.equal(got[0].method, 'ping');
});

test('initialize and tools/list answer, a notification does not', async () => {
  const init = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, null);
  assert.equal(init.result.serverInfo.name, 'majaos');
  assert.equal(init.result.protocolVersion, '2024-11-05');
  const list = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, null);
  const names = list.result.tools.map((t) => t.name);
  for (const name of ['apps_list', 'vm_create', 'files_write', 'shell_run', 'api', 'power']) assert.ok(names.includes(name), name);
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, null), null);
});

test('a tool calls the same API as the interface', async () => {
  const calls = [];
  const client = fake(async (method, path, opts) => { calls.push({ method, path, opts }); return { items: [] }; });
  const res = await dispatch({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'files_list', arguments: { place: 'media', path: 'films' } },
  }, client);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/api/shares/media/files?path=films');
  assert.match(res.result.content[0].text, /items/);
  assert.equal(res.result.isError, undefined);
});

test('deleting and shutting down wait for confirm', async () => {
  let called = 0;
  const client = fake(async () => { called += 1; return { ok: true }; });
  const no = await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'power', arguments: { action: 'reboot' } } }, client);
  assert.equal(no.result.isError, true);
  assert.equal(called, 0);
  const yes = await dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'power', arguments: { action: 'reboot', confirm: true } } }, client);
  assert.equal(yes.result.isError, undefined);
  assert.equal(called, 1);
});

test('the api tool stays on /api', () => {
  assert.equal(safeApiPath('/api/storage').path, '/api/storage');
  assert.throws(() => safeApiPath('/etc/passwd'), /\/api\//);
  assert.throws(() => safeApiPath('/api/../etc/passwd'), /\/api\//);
  assert.throws(() => safeApiPath('http://other/api/apps'), /\/api\//);
});

test('shell_run sends the command to the terminal route', async () => {
  const calls = [];
  const client = fake(async (method, path, opts) => { calls.push({ method, path, opts }); return { output: 'ok\n', code: 0 }; });
  await dispatch({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'shell_run', arguments: { command: 'hostname', password: 'secret', timeout: 5000 } },
  }, client);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/terminal/run');
  assert.deepEqual(calls[0].opts.body, { command: 'hostname', password: 'secret', timeout: 5000 });
});

test('the connector address signs in with PKCE and then answers MCP', async () => {
  const crypto = require('node:crypto');
  const { Readable } = require('node:stream');
  const mcphttp = require('../lib/mcphttp');
  const verifier = 'verifier-value';
  const challenge = mcphttp.b64url(crypto.createHash('sha256').update(verifier).digest());
  assert.equal(mcphttp.pkce(verifier, challenge), true);
  assert.equal(mcphttp.pkce('other', challenge), false);
  assert.equal(mcphttp.allowRedirect('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(mcphttp.allowRedirect('http://127.0.0.1:3333/cb'), true);
  assert.equal(mcphttp.allowRedirect('https://evil.example/steal'), false);

  const deps = {
    port: () => 9, validToken: (tok) => tok === 'session-token', makeToken: () => 'session-token',
    checkPassword: (pw) => pw === 'secret', passwordEnabled: () => true, needsSetup: () => false,
    language: () => 'en', clientIp: () => '1.2.3.4', slow: async () => {},
    auth: {
      userName: () => 'admin', checkUser: (name) => name === 'admin', claimUser() {}, sessionsAfter: () => 0, lockedFor: () => false,
      failed() {}, succeeded() {}, mfaEnabled: () => false, newPending: () => 'pend', usePending: () => ({ result: 'ok' }),
    },
  };
  const call = (method, url, headers, body) => {
    const req = new Readable({ read() {} });
    req.method = method; req.url = url; req.headers = { host: 'nas.example:8080', ...headers }; req.socket = {};
    const res = { status: 0, headers: {}, body: '', writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b ? String(b) : ''; } };
    setImmediate(() => { if (body) req.push(body); req.push(null); });
    return mcphttp.handle(req, res, deps).then(() => res);
  };

  const meta = await call('GET', '/.well-known/oauth-protected-resource');
  assert.equal(JSON.parse(meta.body).authorization_servers[0], 'http://nas.example:8080');

  const refused = await call('POST', '/mcp', {}, '{}');
  assert.equal(refused.status, 401);
  assert.match(refused.headers['WWW-Authenticate'], /oauth-protected-resource/);

  const form = new URLSearchParams({
    response_type: 'code', client_id: 'https://claude.ai/oauth/client',
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge,
    code_challenge_method: 'S256', state: 'abc', user: 'admin', password: 'secret',
  });
  const signed = await call('POST', '/mcp/authorize', { 'content-type': 'application/x-www-form-urlencoded' }, form.toString());
  assert.equal(signed.status, 302);
  const back = new URL(signed.headers.Location);
  assert.equal(back.searchParams.get('state'), 'abc');
  const token = await call('POST', '/mcp/token', {}, new URLSearchParams({
    grant_type: 'authorization_code', code: back.searchParams.get('code'),
    client_id: 'https://claude.ai/oauth/client', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_verifier: verifier,
  }).toString());
  assert.equal(JSON.parse(token.body).access_token, 'session-token');

  const init = await call('POST', '/mcp', { authorization: 'Bearer session-token' }, JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
  }));
  assert.equal(JSON.parse(init.body).result.serverInfo.name, 'majaos');
  const nope = await call('GET', '/mcp');
  assert.equal(nope.status, 405);
  deps.enabled = () => false;
  const stopped = await call('POST', '/mcp', {}, '{}');
  assert.equal(stopped.status, 403);
  assert.match(stopped.body, /turned off/);
});

test('an empty command is refused, a real one returns its output', async () => {
  await assert.rejects(async () => terminal.runCommand('   '), /Type a command/);
  const r = await terminal.runCommand('echo hello-mcp', { timeout: 5000 });
  assert.equal(r.code, 0);
  assert.match(r.output, /hello-mcp/);
  assert.equal(r.timedOut, false);
});
