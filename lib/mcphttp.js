'use strict';
/*
 * MCP over HTTP, the way a connector uses it: one address, then sign in.
 * Streamable HTTP is a POST of one JSON-RPC message. Sign-in is OAuth with PKCE,
 * so Claude can add the address as a custom connector and open this server's own login.
 */
const crypto = require('node:crypto');
const mcp = require('./mcp');

const codes = new Map();
const refreshes = new Map();
const PAGE = {
  en: {
    title: 'Sign in to MajaOS',
    lead: 'A program wants to manage this server.',
    user: 'User name',
    pw: 'Password',
    code: 'Code from your app',
    go: 'Sign in',
    bad: 'Wrong user name or password',
    badcode: 'That code is not correct.',
    expired: 'Your sign-in expired. Type your password again.',
    locked: 'Too many wrong attempts. Wait 5 minutes and try again.',
    setup: 'Create an account in the browser first.',
    refused: 'This program is not allowed to sign in here.',
  },
  nl: {
    title: 'Aanmelden bij MajaOS',
    lead: 'Een programma wil deze server beheren.',
    user: 'Gebruikersnaam',
    pw: 'Wachtwoord',
    code: 'Code uit je app',
    go: 'Aanmelden',
    bad: 'Verkeerde gebruikersnaam of wachtwoord',
    badcode: 'Die code klopt niet.',
    expired: 'Je aanmelding is verlopen. Typ je wachtwoord opnieuw.',
    locked: 'Te veel foute pogingen. Wacht 5 minuten en probeer opnieuw.',
    setup: 'Maak eerst een account in de browser.',
    refused: 'Dit programma mag hier niet aanmelden.',
  },
};

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkce(verifier, challenge) {
  if (!verifier || !challenge || verifier.length > 128) return false;
  const got = b64url(crypto.createHash('sha256').update(String(verifier)).digest());
  if (got.length !== challenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(challenge));
}

function allowRedirect(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.username || u.password) return false;
  const host = u.hostname;
  if (u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')) return true;
  if (u.protocol !== 'https:') return false;
  return ['claude.ai', 'claude.com', 'cursor.com', 'cursor.sh', 'vscode.dev'].some((h) => host === h || host.endsWith('.' + h));
}

function originOf(req) {
  const host = req.headers.host || 'localhost';
  const proto = req.socket && req.socket.encrypted ? 'https' : 'http';
  return proto + '://' + host;
}

function match(pathname) {
  return pathname === '/mcp'
    || pathname === '/mcp/authorize'
    || pathname === '/mcp/token'
    || pathname === '/.well-known/oauth-protected-resource'
    || pathname === '/.well-known/oauth-protected-resource/mcp'
    || pathname === '/.well-known/oauth-authorization-server';
}

function readRaw(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { const e = new Error('Body too large'); e.status = 413; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function formBody(buf) {
  const out = {};
  new URLSearchParams(buf.toString('utf8')).forEach((v, k) => { out[k] = v; });
  return out;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sendJson(res, status, body, extra) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...(extra || {}) };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : '';
}

function cookieToken(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out.tb_session || '';
}

function prune() {
  const now = Date.now();
  for (const [k, v] of codes) if (v.exp < now) codes.delete(k);
  for (const [k, v] of refreshes) if (v.exp < now) refreshes.delete(k);
}

function page(lang, { query, error, pending }) {
  const L = PAGE[lang] || PAGE.en;
  const hidden = Object.entries(query).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const user = query.user ? `<label>${esc(L.user)}<input name="user" autocomplete="username" required></label>` : '';
  const secret = pending
    ? `<label>${esc(L.code)}<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><input type="hidden" name="pending" value="${esc(pending)}">`
    : `<label>${esc(L.pw)}<input name="password" type="password" autocomplete="current-password" required></label>`;
  return `<!doctype html><html lang="${lang === 'nl' ? 'nl' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(L.title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e8eef2;color:#1c2830;font:16px/1.45 system-ui,sans-serif}form{width:min(420px,calc(100% - 32px));background:#fff;border-radius:16px;padding:24px;box-shadow:0 12px 40px rgba(20,40,50,.12)}h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:#4a5b66}label{display:block;margin:12px 0;font-size:14px}input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border:1px solid #c5d0d6;border-radius:10px;font:inherit}button{margin-top:8px;padding:10px 16px;border:0;border-radius:10px;background:#1c2830;color:#fff;font:inherit;cursor:pointer}.err{color:#9b2c2c;min-height:1.2em}</style></head>
<body><form method="post"><h1>${esc(L.title)}</h1><p>${esc(L.lead)}</p>${hidden}${user}${secret}<p class="err">${esc(error || '')}</p><button type="submit">${esc(L.go)}</button></form></body></html>`;
}

function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'",
  });
  res.end(body);
}

async function handle(req, res, deps) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const origin = originOf(req);
  const lang = deps.language() === 'nl' ? 'nl' : 'en';
  if (typeof deps.enabled === 'function' && !deps.enabled()) {
    return sendJson(res, 403, { error: 'The MCP server is turned off. Turn it on in Settings → MCP.' });
  }

  if (req.method === 'OPTIONS' && (p === '/mcp' || p === '/mcp/token')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') {
    return sendJson(res, 200, {
      resource: origin + '/mcp',
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['majaos'],
    });
  }
  if (p === '/.well-known/oauth-authorization-server') {
    return sendJson(res, 200, {
      issuer: origin,
      authorization_endpoint: origin + '/mcp/authorize',
      token_endpoint: origin + '/mcp/token',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    });
  }

  if (p === '/mcp/authorize' && req.method === 'GET') {
    const q = Object.fromEntries(url.searchParams);
    if (!allowRedirect(q.redirect_uri) || q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge || !q.client_id) {
      return html(res, 400, page(lang, { query: {}, error: (PAGE[lang] || PAGE.en).refused }));
    }
    q.user = '1';
    return html(res, 200, page(lang, { query: q }));
  }

  if (p === '/mcp/authorize' && req.method === 'POST') {
    const body = formBody(await readRaw(req));
    const L = PAGE[lang];
    const q = {
      response_type: body.response_type, client_id: body.client_id, redirect_uri: body.redirect_uri,
      code_challenge: body.code_challenge, code_challenge_method: body.code_challenge_method,
      state: body.state || '', resource: body.resource || '', scope: body.scope || '',
      user: '1',
    };
    if (!allowRedirect(q.redirect_uri) || q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge || !q.client_id) {
      return html(res, 400, page(lang, { query: {}, error: L.refused }));
    }
    if (deps.needsSetup()) return html(res, 409, page(lang, { query: q, error: L.setup }));
    const ip = deps.clientIp(req);
    if (deps.auth.lockedFor(ip)) return html(res, 429, page(lang, { query: q, error: L.locked }));
    if (body.pending) {
      const r = deps.auth.usePending(body.pending, body.code);
      if (r.result === 'expired') return html(res, 401, page(lang, { query: q, error: L.expired }));
      if (r.result !== 'ok') { deps.auth.failed(ip); await deps.slow(); return html(res, 401, page(lang, { query: q, pending: body.pending, error: L.badcode })); }
    } else {
      if (!deps.checkPassword(body.password) || !deps.auth.checkUser(body.user)) {
        deps.auth.failed(ip); await deps.slow();
        return html(res, 401, page(lang, { query: q, error: L.bad }));
      }
      deps.auth.claimUser(body.user);
      if (deps.auth.mfaEnabled()) return html(res, 200, page(lang, { query: q, pending: deps.auth.newPending() }));
    }
    deps.auth.succeeded(ip);
    prune();
    const code = b64url(crypto.randomBytes(32));
    codes.set(code, {
      clientId: q.client_id, redirect: q.redirect_uri, challenge: q.code_challenge,
      exp: Date.now() + 5 * 60 * 1000, token: deps.makeToken(),
    });
    const back = new URL(q.redirect_uri);
    back.searchParams.set('code', code);
    if (body.state) back.searchParams.set('state', body.state);
    res.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (p === '/mcp/token' && req.method === 'POST') {
    const raw = await readRaw(req);
    const type = String(req.headers['content-type'] || '');
    let body;
    try { body = type.includes('application/json') ? JSON.parse(raw.toString('utf8') || '{}') : formBody(raw); }
    catch { return sendJson(res, 400, { error: 'invalid_request' }); }
    prune();
    if (body.grant_type === 'refresh_token') {
      const rec = refreshes.get(body.refresh_token);
      // A new password (or two-step verification) also ends what was signed in before through this route.
      if (!rec || rec.clientId !== body.client_id || rec.issued < deps.auth.sessionsAfter()) return sendJson(res, 400, { error: 'invalid_grant' });
      return sendJson(res, 200, { access_token: deps.makeToken(), token_type: 'Bearer', expires_in: 30 * 24 * 3600, refresh_token: body.refresh_token });
    }
    const rec = codes.get(body.code);
    if (rec) codes.delete(body.code);
    if (!rec || rec.exp < Date.now() || rec.clientId !== body.client_id || rec.redirect !== body.redirect_uri || !pkce(body.code_verifier, rec.challenge)) {
      return sendJson(res, 400, { error: 'invalid_grant' });
    }
    const refresh = b64url(crypto.randomBytes(32));
    refreshes.set(refresh, { clientId: rec.clientId, issued: Date.now(), exp: Date.now() + 30 * 24 * 3600 * 1000 });
    return sendJson(res, 200, { access_token: rec.token, token_type: 'Bearer', expires_in: 30 * 24 * 3600, refresh_token: refresh });
  }

  if (p !== '/mcp') return sendJson(res, 404, { error: 'Unknown endpoint' });
  if (req.method === 'GET') {
    res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ error: 'POST a JSON-RPC message to this address.' }));
  }
  if (req.method === 'DELETE') return sendJson(res, 200, { ok: true });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST a JSON-RPC message to this address.' });

  const token = bearer(req) || cookieToken(req);
  if (deps.passwordEnabled() && !deps.validToken(token)) {
    return sendJson(res, 401, { error: 'Not signed in' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
  }
  let msg;
  try { msg = JSON.parse((await readRaw(req)).toString('utf8') || ''); }
  catch { return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const client = new mcp.Client({ url: 'http://127.0.0.1:' + deps.port(), token });
  const out = await mcp.dispatch(msg, client);
  if (!out) { res.writeHead(202, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
  return sendJson(res, 200, out);
}

module.exports = { match, handle, pkce, allowRedirect, b64url };
