'use strict';
/* Which AI answers the chat: nothing, a local server, or Claude.
 * The Claude API key stays in DATA_DIR/ai.json (0600) and is never sent back to the browser. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { httpError } = require('./system');
const mcp = require('./mcp');

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

function dataDir() { return process.env.DATA_DIR || '/var/lib/majaos'; }
function file() { return path.join(dataDir(), 'ai.json'); }

function readFile() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return null; }
}

// An older install only had OLLAMA_URL. That still means Ollama, until Settings saves a choice.
function effective() {
  const saved = readFile();
  const enabled = !saved || saved.enabled !== false;
  const tools = !saved || saved.tools !== false;
  if (saved && PROVIDERS[saved.provider]) {
    const spec = PROVIDERS[saved.provider];
    return {
      enabled, tools,
      provider: saved.provider,
      url: saved.url || spec.url || '',
      model: String(saved.model || ''),
      key: String(saved.key || ''),
    };
  }
  const env = String(process.env.OLLAMA_URL || '').replace(/\/+$/, '');
  if (env) return { enabled, tools, provider: 'ollama', url: env, model: '', key: '' };
  return { enabled, tools, provider: 'off', url: '', model: '', key: '' };
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
    tools: c.tools !== false,
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
  const tools = body.tools === undefined ? cur.tools !== false : !!body.tools;
  const next = { enabled, tools, provider, url: '', model: String(body.model != null ? body.model : (cur.model || '')).trim().slice(0, 200), key: String(cur.key || '') };
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

const CHAT_SYSTEM = mcp.INSTRUCTIONS + ' You are the assistant in the MajaOS chat. '
  + 'Use the tools for anything about this server, then answer in a short plain sentence. '
  + 'Set confirm to true only when the user clearly asked for that action.';
const CHAT_PLAIN = 'You are the assistant in the MajaOS chat. Answer in a short plain sentence. You cannot change the server.';

function openaiTools() {
  return mcp.TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

function claudeTools() {
  return mcp.TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

function argsOf(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim()) {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

function toOllama(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', content: m.content };
    if (m.role === 'assistant' && m.calls && m.calls.length) {
      return { role: 'assistant', content: m.content || '', tool_calls: m.calls.map((c) => ({ function: { name: c.name, arguments: c.arguments || {} } })) };
    }
    return { role: m.role, content: m.content || '' };
  });
}

function toOpenAI(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.calls && m.calls.length) {
      return {
        role: 'assistant', content: m.content || null,
        tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } })),
      };
    }
    return { role: m.role, content: m.content || '' };
  });
}

function toClaude(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const prev = rest[rest.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content)) prev.content.push(block);
      else rest.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && m.calls && m.calls.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments || {} });
      rest.push({ role: 'assistant', content });
      continue;
    }
    rest.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
  }
  return { system, messages: rest };
}

function parseOllama(data) {
  const msg = (data && data.message) || {};
  const calls = (msg.tool_calls || []).map((c, i) => ({
    id: 'call_' + i, name: c.function && c.function.name, arguments: argsOf(c.function && c.function.arguments),
  })).filter((c) => c.name);
  return { text: msg.content || '', calls };
}

function parseOpenAI(data) {
  const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
  const calls = (msg.tool_calls || []).map((c) => ({
    id: c.id, name: c.function && c.function.name, arguments: argsOf(c.function && c.function.arguments),
  })).filter((c) => c.name);
  return { text: msg.content || '', calls };
}

function parseClaude(data) {
  const blocks = (data && data.content) || [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    calls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: b.input || {} })),
  };
}

// The model may look things up several times. ask() sees the growing transcript and returns { text, calls }.
async function foldTools(messages, { ask, run, write, rounds = 6 }) {
  for (let i = 0; i < rounds; i++) {
    const turn = await ask(messages);
    if (turn.text) write({ message: { content: turn.text } });
    const calls = turn.calls || [];
    if (!calls.length) return;
    messages.push({ role: 'assistant', content: turn.text || '', calls });
    for (const call of calls) {
      write({ tool: { name: call.name } });
      let text;
      try { text = await run(call.name, call.arguments || {}); }
      catch (e) { text = e.message || String(e); }
      messages.push({ role: 'tool', name: call.name, toolCallId: call.id, content: String(text).slice(0, 16000) });
    }
  }
  write({ message: { content: 'I stopped after too many steps. Ask again for what is still left.' } });
}

async function askModelOnce(c, model, messages, withTools) {
  if (c.provider === 'ollama') {
    const payload = { model, messages: toOllama(messages), stream: false };
    if (withTools) payload.tools = openaiTools();
    const data = await readJson(await request(c.url.replace(/\/+$/, '') + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 0, body: JSON.stringify(payload),
    }));
    return parseOllama(data);
  }
  if (PROVIDERS[c.provider].kind === 'openai') {
    const payload = { model, messages: toOpenAI(messages), stream: false };
    if (withTools) payload.tools = openaiTools();
    const data = await readJson(await request(c.url.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 0, body: JSON.stringify(payload),
    }));
    return parseOpenAI(data);
  }
  const shaped = toClaude(messages);
  const payload = { model: model || CLAUDE_MODELS[0], max_tokens: 4096, system: shaped.system, messages: shaped.messages };
  if (withTools) payload.tools = claudeTools();
  const data = await readJson(await request('https://api.anthropic.com/v1/messages', {
    method: 'POST', timeout: 0,
    headers: { 'Content-Type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload),
  }));
  return parseClaude(data);
}

async function askModel(c, model, messages, allowTools) {
  const usedTools = messages.some((m) => m.role === 'tool' || (m.calls && m.calls.length));
  try { return await askModelOnce(c, model, messages, allowTools !== false); }
  catch (e) {
    if (usedTools || !/tool/i.test(e.message || '')) throw e;
    return askModelOnce(c, model, messages, false);
  }
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

async function chat(res, body, ctx = {}) {
  const c = effective();
  if (!c.enabled) throw httpError('AI is turned off. Turn it on in Settings.', 409);
  if (c.provider === 'off') throw httpError('No AI is connected yet. Choose one in Settings.', 409);
  const spoken = messagesOf(body);
  if (!spoken.length) throw httpError('Type a question first.', 400);
  const model = String(body.model || c.model || '').trim();
  if (!model) throw httpError('Choose a model.', 400);
  if (!MODEL_NAME.test(model)) throw httpError('That model name is not valid.', 400);

  const useTools = c.tools !== false;
  const messages = [{ role: 'system', content: useTools ? CHAT_SYSTEM : CHAT_PLAIN }, ...spoken];
  const client = new mcp.Client({ url: 'http://127.0.0.1:' + (ctx.port || 80), token: ctx.token || '' });
  let started = false;
  const write = (obj) => {
    if (!started) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      started = true;
    }
    res.write(JSON.stringify(obj) + '\n');
  };
  try {
    await foldTools(messages, {
      ask: (transcript) => askModel(c, model, transcript, useTools),
      run: (name, args) => mcp.runTool(name, args, client),
      write,
    });
  } catch (e) {
    if (!started) throw httpError(downMessage(c.provider, e), e.status && e.status < 500 ? e.status : 502);
    write({ error: downMessage(c.provider, e) });
  }
  if (started) res.end();
}

function ollamaBase() {
  const c = effective();
  if (c.provider !== 'ollama' || !c.url) throw httpError('That only works with Ollama.', 409);
  return c.url.replace(/\/+$/, '');
}

module.exports = {
  PROVIDERS, CLAUDE_MODELS, effective, cleanUrl, publicConfig, status, save, chat, ollamaBase,
  textFromOpenAI, textFromClaude, foldTools, toOllama, toOpenAI, toClaude, parseOllama, parseOpenAI, parseClaude,
};
