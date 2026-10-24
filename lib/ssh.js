'use strict';
/* SSH on the server (OpenSSH). Off unless Settings → Security turns it on. */
const { run, httpError } = require('./system');

const UNIT = 'ssh';

// systemctl is-enabled / is-active, one word each (LC_ALL=C).
function parseSsh(enabled, active) {
  const en = String(enabled == null ? '' : enabled).trim();
  const ac = String(active == null ? '' : active).trim();
  const installed = en !== '' && en !== 'not-found';
  return {
    installed,
    enabled: installed && (en === 'enabled' || en === 'enabled-runtime'),
    active: installed && ac === 'active',
  };
}

async function status(runCmd = run) {
  let enabled = '', active = '';
  try {
    enabled = (await runCmd('systemctl', ['is-enabled', UNIT], { timeout: 8000, full: true })).stdout;
  } catch (e) {
    if (e.status === 503) return { installed: false, enabled: false, active: false };
    throw e;
  }
  try {
    active = (await runCmd('systemctl', ['is-active', UNIT], { timeout: 8000, full: true })).stdout;
  } catch (e) {
    if (e.status === 503) return { installed: false, enabled: false, active: false };
  }
  return parseSsh(enabled, active);
}

// on: enable and start. off: disable and stop. No change when it already matches.
async function apply(on, runCmd = run) {
  const want = !!on;
  const st = await status(runCmd);
  if (!st.installed) {
    if (!want) return st;
    throw httpError('OpenSSH is not installed on the server.', 409);
  }
  if (st.enabled === want && (!want || st.active)) return st;
  await runCmd('systemctl', [want ? 'enable' : 'disable', '--now', UNIT], { timeout: 30000 });
  return status(runCmd);
}

// Bring the service in line with the saved setting. Missing OpenSSH stays off.
async function enforce(on, runCmd = run) {
  try { return await apply(on, runCmd); }
  catch (e) {
    if (e.status === 409 || e.status === 503) return { installed: false, enabled: false, active: false };
    throw e;
  }
}

module.exports = { parseSsh, status, apply, enforce, UNIT };
