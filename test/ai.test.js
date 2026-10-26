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
