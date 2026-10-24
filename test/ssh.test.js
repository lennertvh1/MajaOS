'use strict';
/* SSH: reading systemctl, turning the service on and off, and the setting (default off). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ssh-'));
const ssh = require('../lib/ssh');
const settings = require('../lib/settings');

test('systemctl states', () => {
  assert.deepEqual(ssh.parseSsh('enabled\n', 'active\n'), { installed: true, enabled: true, active: true });
  assert.deepEqual(ssh.parseSsh('disabled', 'inactive'), { installed: true, enabled: false, active: false });
  assert.deepEqual(ssh.parseSsh('masked', 'failed'), { installed: true, enabled: false, active: false });
  assert.deepEqual(ssh.parseSsh('not-found', ''), { installed: false, enabled: false, active: false });
  assert.deepEqual(ssh.parseSsh('', ''), { installed: false, enabled: false, active: false });
});

test('apply only calls systemctl when the state changes', async () => {
  let enabled = 'disabled', active = 'inactive';
  const calls = [];
  const runCmd = async (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'is-enabled') return { stdout: enabled + '\n', stderr: '', code: enabled === 'enabled' ? 0 : 1 };
    if (args[0] === 'is-active') return { stdout: active + '\n', stderr: '', code: active === 'active' ? 0 : 3 };
    if (args[0] === 'enable') { enabled = 'enabled'; active = 'active'; return ''; }
    if (args[0] === 'disable') { enabled = 'disabled'; active = 'inactive'; return ''; }
    throw new Error(args.join(' '));
  };
  const off = await ssh.apply(false, runCmd);
  assert.equal(off.enabled, false);
  assert.deepEqual(calls, ['is-enabled ssh', 'is-active ssh']);
  const on = await ssh.apply(true, runCmd);
  assert.equal(on.active, true);
  assert.ok(calls.includes('enable --now ssh'));
  await ssh.apply(true, runCmd);
  assert.equal(calls.filter((c) => c.startsWith('enable')).length, 1);
  const stopped = await ssh.apply(false, runCmd);
  assert.equal(stopped.active, false);
  assert.ok(calls.includes('disable --now ssh'));
});

test('turning SSH on without OpenSSH is refused', async () => {
  const runCmd = async () => ({ stdout: 'not-found\n', stderr: '', code: 1 });
  await assert.rejects(ssh.apply(true, runCmd), /OpenSSH is not installed/);
  assert.equal((await ssh.apply(false, runCmd)).installed, false);
});

test('the setting defaults to off and turning it on asks for the password', () => {
  const check = (pw) => pw === 'geheim';
  assert.equal(settings.getSettings().ssh, false);
  assert.throws(() => settings.saveSettings({ ssh: true }, { checkPassword: check }), /Type your password/);
  assert.equal(settings.saveSettings({ ssh: true, password: 'geheim' }, { checkPassword: check }).ssh, true);
  assert.equal(settings.saveSettings({ ssh: false }, { checkPassword: check }).ssh, false);
});
