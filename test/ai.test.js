'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ai-'));
process.env.DATA_DIR = dir;
delete process.env.OLLAMA_URL;
const ai = require('../lib/ai');

test('without a saved choice and without OLLAMA_URL, no AI is connected', () => {
  assert.equal(ai.effective().provider, 'off');
  const pub = ai.publicConfig();
  assert.equal(pub.hasKey, false);
  assert.equal(pub.reachable, undefined);
});

test('an address is only http or https, without a password in it', () => {
  assert.equal(ai.cleanUrl('http://127.0.0.1:11434/', 'http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(ai.cleanUrl('', 'http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
  assert.throws(() => ai.cleanUrl('file:///etc/passwd', ''), /http:\/\/127\.0\.0\.1:11434/);
  assert.throws(() => ai.cleanUrl('http://user:pw@127.0.0.1:11434', ''), /http:\/\/127\.0\.0\.1:11434/);
});

test('a stream line from LM Studio or Claude becomes chat text', () => {
  assert.equal(ai.textFromOpenAI('data: {"choices":[{"delta":{"content":"Hi"}}]}'), 'Hi');
  assert.equal(ai.textFromOpenAI('data: [DONE]'), '');
  assert.equal(ai.textFromClaude('data: {"type":"content_block_delta","delta":{"text":"Ho"}}'), 'Ho');
  assert.deepEqual(ai.textFromClaude('data: {"type":"error","error":{"message":"nope"}}'), { error: 'nope' });
});

test('the Claude key is saved on disk and is not returned', () => {
  const out = ai.save({ provider: 'claude', key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', model: 'claude-haiku-4-5' });
  assert.equal(out.provider, 'claude');
  assert.equal(out.hasKey, true);
  assert.equal(out.enabled, true);
  assert.equal(out.model, 'claude-haiku-4-5');
  const offSwitch = ai.save({ enabled: false });
  assert.equal(offSwitch.enabled, false);
  assert.equal(offSwitch.provider, 'claude');
  assert.equal(ai.save({ enabled: true }).enabled, true);
  assert.equal(ai.publicConfig().tools, true);
  assert.equal(ai.save({ tools: false }).tools, false);
  assert.equal(ai.effective().tools, false);
  assert.equal(ai.save({}).tools, false);
  assert.equal(ai.save({ tools: true }).tools, true);
  assert.equal(JSON.stringify(out).includes('sk-ant-'), false);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ai.json'), 'utf8'));
  assert.equal(raw.key, 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  assert.equal(fs.statSync(path.join(dir, 'ai.json')).mode & 0o777, 0o600);
  assert.throws(() => ai.save({ provider: 'claude', key: 'secret' }), /sk-ant-/);
  const off = ai.save({ provider: 'off' });
  assert.equal(off.provider, 'off');
  assert.equal(ai.effective().provider, 'off');
  fs.rmSync(path.join(dir, 'ai.json'));
  process.env.OLLAMA_URL = 'http://127.0.0.1:11434/';
  assert.equal(ai.effective().provider, 'ollama');
  assert.equal(ai.effective().url, 'http://127.0.0.1:11434');
  delete process.env.OLLAMA_URL;
});

test('the chat runs a tool and then answers', async () => {
  const seen = [];
  const messages = [{ role: 'system', content: 'manage the server' }, { role: 'user', content: 'Which apps are running?' }];
  let step = 0;
  await ai.foldTools(messages, {
    ask: async () => {
      step += 1;
      if (step === 1) return { text: '', calls: [{ id: 'c1', name: 'apps_list', arguments: {} }] };
      return { text: 'Jellyfin is running.', calls: [] };
    },
    run: async (name) => { seen.push(name); return '{"apps":["jellyfin"]}'; },
    write: (obj) => seen.push(obj),
  });
  assert.deepEqual(seen, [{ tool: { name: 'apps_list' } }, 'apps_list', { message: { content: 'Jellyfin is running.' } }]);
  const claude = ai.toClaude(messages);
  assert.equal(claude.system, 'manage the server');
  assert.equal(claude.messages[1].content[0].type, 'tool_use');
  assert.equal(claude.messages[2].content[0].type, 'tool_result');
  const openai = ai.toOpenAI(messages);
  assert.equal(openai[3].role, 'tool');
  assert.equal(openai[3].tool_call_id, 'c1');
  const ollama = ai.parseOllama({ message: { content: '', tool_calls: [{ function: { name: 'storage', arguments: { wake: false } } }] } });
  assert.equal(ollama.calls[0].name, 'storage');
  assert.equal(ollama.calls[0].arguments.wake, false);
});

test('shutting down from the chat still needs confirm', async () => {
  const mcp = require('../lib/mcp');
  await assert.rejects(() => mcp.runTool('power', { action: 'reboot' }, { call() { throw new Error('should not run'); } }), /confirm/);
});
