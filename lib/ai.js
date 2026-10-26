'use strict';
/* Which AI answers the chat: nothing, a local server, or Claude.
 * The Claude API key stays in DATA_DIR/ai.json (0600) and is never sent back to the browser. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { httpError } = require('./system');

const PROVIDERS = {
  off: { kind: 'off' },
  ollama: { kind: 'ollama', url: 'http://127.0.0.1:11434' },
  lmstudio: { kind: 'openai', url: 'http://127.0.0.1:1234/v1' },
  llamacpp: { kind: 'openai', url: 'http://127.0.0.1:8080/v1' },
  localai: { kind: 'openai', url: 'http://127.0.0.1:8080/v1' },
  claude: { kind: 'claude', url: 'https://api.anthropic.com' },
};
const CLAUDE_MODELS = ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'];
const MODEL_NAME = /^[\w.\-/: ]{1,200}$/;

function dataDir() { return process.env.DATA_DIR || '/var/lib/homebaseos'; }
function file() { return path.join(dataDir(), 'ai.json'); }

function readFile() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return null; }
}

// An older install only had OLLAMA_URL. That still means Ollama, until Settings saves a choice.
function effective() {
  const saved = readFile();
  const enabled = !saved || saved.enabled !== false;
  if (saved && PROVIDERS[saved.provider]) {
    const spec = PROVIDERS[saved.provider];
    return {
      enabled,
      provider: saved.provider,
      url: saved.url || spec.url || '',
      model: String(saved.model || ''),
      key: String(saved.key || ''),
    };
  }
  const env = String(process.env.OLLAMA_URL || '').replace(/\/+$/, '');
  if (env) return { enabled, provider: 'ollama', url: env, model: '', key: '' };
  return { enabled, provider: 'off', url: '', model: '', key: '' };
}

function cleanUrl(input, fallback) {
  const raw = String(input || '').trim() || fallback || '';
  let u;
  try { u = new URL(raw); } catch { throw httpError('Type an address like http://127.0.0.1:11434.', 400); }
  if (u.username || u.password || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.search || u.hash) {
    throw httpError('Type an address like http://127.0.0.1:11434.', 400);
  }
  const path = u.pathname.replace(/\/+$/, '');
  return u.origin + (path === '/' ? '' : path);
}

function publicConfig(c = effective()) {
  const spec = PROVIDERS[c.provider] || PROVIDERS.off;
  return {
    enabled: c.enabled !== false,
    provider: c.provider,
    url: c.provider === 'claude' || c.provider === 'off' ? '' : (c.url || spec.url || ''),
    model: c.model || '',
    hasKey: !!c.key,
    choices: Object.entries(PROVIDERS).filter(([id]) => id !== 'off').map(([id, p]) => ({ id, url: p.url || '' })),
    claudeModels: CLAUDE_MODELS,
  };
}

function request(urlStr, { method = 'GET', headers = {}, body, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers, timeout }, (res) => resolve(res));
    req.on('timeout', () => req.destroy(Object.assign(new Error('Time-out connecting to ' + url.host), { code: 'Time-out' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function readJson(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (res.statusCode >= 400) {
    const msg = data && (data.error && (data.error.message || data.error) || data.message);
    const err = new Error(typeof msg === 'string' ? msg : (text.slice(0, 200) || ('HTTP ' + res.statusCode)));
    err.status = res.statusCode >= 500 ? 502 : res.statusCode;
    throw err;
  }
  return data;
}

function downMessage(provider, err) {
  const name = { ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', localai: 'LocalAI', claude: 'Claude' }[provider] || 'The AI';
  if (err && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|Time-out/i.test(String(err.code || '') + ' ' + err.message)) {
    return name + ' is not reachable. Check the address, and that it is running.';
  }
  return err && err.message ? err.message : name + ' is not reachable.';
}

async function listModels(c) {
  if (c.provider === 'ollama') {
    const tags = await readJson(await request(c.url.replace(/\/+$/, '') + '/api/tags', { timeout: 4000 }));
    return (tags.models || []).map((m) => ({
      name: m.name, size: m.size, modified: m.modified_at,
      family: m.details && m.details.family, params: m.details && m.details.parameter_size,
      quant: m.details && m.details.quantization_level,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  if (PROVIDERS[c.provider].kind === 'openai') {
    const data = await readJson(await request(c.url.replace(/\/+$/, '') + '/models', { timeout: 4000 }));
    const list = data.data || data.models || [];
    return list.map((m) => ({ name: m.id || m.name })).filter((m) => m.name).sort((a, b) => a.name.localeCompare(b.name));
  }
  if (c.provider === 'claude') {
    return CLAUDE_MODELS.map((name) => ({ name }));
  }
  return [];
}

async function status() {
  const c = effective();
  const base = { ...publicConfig(c), reachable: false, error: null, models: [], version: null, gpu: null };
  if (!c.enabled || c.provider === 'off') return base;
  try {
    if (c.provider === 'claude' && !c.key) {
      base.error = 'Paste the API key from Claude.';
      return base;
    }
    if (c.provider === 'claude') {
      try {
        await readJson(await request('https://api.anthropic.com/v1/models?limit=1', {
          headers: { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' }, timeout: 4000,
        }));
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    base.models = await listModels(c);
    if (c.provider === 'ollama') {
      const root = c.url.replace(/\/+$/, '');
      const [version, ps] = await Promise.all([
        readJson(await request(root + '/api/version', { timeout: 4000 })).catch(() => null),
        readJson(await request(root + '/api/ps', { timeout: 4000 })).catch(() => ({ models: [] })),
      ]);
      const running = new Map((ps.models || []).map((m) => [m.name, m]));
      for (const m of base.models) {
        const live = running.get(m.name);
        if (!live) continue;
        m.loaded = true; m.vram = live.size_vram; m.ramTotal = live.size;
      }
      base.version = version && version.version;
      try { base.gpu = await require('./system').gpuStats(); } catch { /* no GPU info */ }
    }
    base.reachable = true;
    return base;
  } catch (err) {
    base.error = downMessage(c.provider, err);
    if (c.provider === 'claude') base.models = CLAUDE_MODELS.map((name) => ({ name }));
    return base;
  }
}

function save(body) {
  const cur = readFile() || {};
  const provider = String(body.provider || cur.provider || 'off');
  if (!PROVIDERS[provider]) throw httpError('Choose an AI.', 400);
  const enabled = body.enabled === undefined ? cur.enabled !== false : !!body.enabled;
  const next = { enabled, provider, url: '', model: String(body.model != null ? body.model : (cur.model || '')).trim().slice(0, 200), key: String(cur.key || '') };
  if (!MODEL_NAME.test(next.model) && next.model) throw httpError('That model name is not valid.', 400);
  if (provider === 'ollama' || PROVIDERS[provider].kind === 'openai') next.url = cleanUrl(body.url, PROVIDERS[provider].url);
  if (provider === 'claude' && enabled) {
    const key = String(body.key || '').trim();
    if (key) {
      if (!/^sk-ant-[A-Za-z0-9_-]{10,400}$/.test(key)) throw httpError('Paste the API key from Claude. It starts with sk-ant-.', 400);
      next.key = key;
    }
    if (!next.key) throw httpError('Paste the API key from Claude.', 400);
    if (!next.model) next.model = CLAUDE_MODELS[0];
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  const dest = file();
  fs.writeFileSync(dest + '.tmp', JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(dest + '.tmp', dest);
  try { fs.chmodSync(dest, 0o600); } catch { /* the mode on write is enough */ }
  return publicConfig(effective());
}

function messagesOf(body) {
  return (Array.isArray(body.messages) ? body.messages : []).slice(-40).map((x) => ({
    role: x.role === 'assistant' ? 'assistant' : 'user',
    content: String(x.content || '').slice(0, 20000),
  })).filter((x) => x.content);
}

function textFromOpenAI(line) {
  if (!line.startsWith('data:')) return '';
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return '';
  try {
    const j = JSON.parse(data);
    return (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
  } catch { return ''; }
}

function textFromClaude(line) {
  if (!line.startsWith('data:')) return '';
  const data = line.slice(5).trim();
  if (!data) return '';
  try {
    const j = JSON.parse(data);
    if (j.type === 'error') return { error: (j.error && j.error.message) || 'Claude refused the question.' };
    if (j.type === 'content_block_delta' && j.delta && j.delta.text) return j.delta.text;
  } catch { /* keep reading */ }
  return '';
}

function writeNdjson(res, upstream, mapLine) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  let buf = '';
  const take = (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '').trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const out = mapLine(line);
      if (out && out.error) res.write(JSON.stringify({ error: out.error }) + '\n');
      else if (out) res.write(JSON.stringify({ message: { content: out } }) + '\n');
    }
  };
  upstream.on('data', take);
  upstream.on('end', () => { if (buf.trim()) take(buf + '\n'); res.end(); });
  upstream.on('error', () => res.end());
  res.on('close', () => upstream.destroy());
}

async function chat(res, body) {
  const c = effective();
  if (!c.enabled) throw httpError('AI is turned off. Turn it on in Settings.', 409);
  if (c.provider === 'off') throw httpError('No AI is connected yet. Choose one in Settings.', 409);
  const messages = messagesOf(body);
  if (!messages.length) throw httpError('Type a question first.', 400);
  const model = String(body.model || c.model || '').trim();
  if (c.provider !== 'ollama' && !model) throw httpError('Choose a model.', 400);
  if (model && !MODEL_NAME.test(model)) throw httpError('That model name is not valid.', 400);

  if (c.provider === 'ollama') {
    if (!model) throw httpError('Choose a model.', 400);
    const up = await request(c.url.replace(/\/+$/, '') + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 0,
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (up.statusCode >= 400) {
      try { await readJson(up); } catch (err) { err.status = 502; throw err; }
      throw httpError('Ollama refused the question.', 502);
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    up.pipe(res);
    res.on('close', () => up.destroy());
    return;
  }

  if (PROVIDERS[c.provider].kind === 'openai') {
    const up = await request(c.url.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 0,
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (up.statusCode >= 400) await readJson(up);
    return writeNdjson(res, up, textFromOpenAI);
  }

  const up = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST', timeout: 0,
    headers: { 'Content-Type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model || CLAUDE_MODELS[0], max_tokens: 4096, messages, stream: true }),
  });
  if (up.statusCode >= 400) await readJson(up);
  return writeNdjson(res, up, textFromClaude);
}

function ollamaBase() {
  const c = effective();
  if (c.provider !== 'ollama' || !c.url) throw httpError('That only works with Ollama.', 409);
  return c.url.replace(/\/+$/, '');
}

module.exports = {
  PROVIDERS, CLAUDE_MODELS, effective, cleanUrl, publicConfig, status, save, chat, ollamaBase,
  textFromOpenAI, textFromClaude,
};
