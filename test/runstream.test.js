const test = require('node:test');
const assert = require('node:assert/strict');
const { runStream } = require('../lib/system');

test('runStream: a command that keeps giving output is not stopped by the idle limit', async () => {
  const lines = [];
  await runStream('sh', ['-c', 'for i in 1 2 3 4 5 6; do echo $i; sleep 0.1; done'], (l) => lines.push(l), { idle: 400 });
  assert.deepEqual(lines, ['1', '2', '3', '4', '5', '6']);
});

test('runStream: no output for the idle time stops it with a clear message', async () => {
  await assert.rejects(runStream('sh', ['-c', 'echo start; exec sleep 5'], () => {}, { idle: 300 }), /^Error: Stopped: nothing happened for/);
});

test('runStream: the overall limit stops it with its own message', async () => {
  await assert.rejects(runStream('sh', ['-c', 'while true; do echo x; sleep 0.05; done'], () => {}, { timeout: 300, idle: 1000 }), /^Error: Stopped: it took longer than/);
});
