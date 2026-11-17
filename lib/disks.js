'use strict';
/* Details of one disk: everything smartctl knows (hours, temperature, wear, errors, self-tests). */
const { run, num, httpError } = require('./system');
const { parseLsblk } = require('./storage');

// Important ATA attributes: when these go up, the disk is deteriorating.
const ATA_WATCH = { 5: 'reallocated', 197: 'pending', 198: 'uncorrectable', 187: 'reportedUncorrect', 199: 'crcErrors', 188: 'commandTimeout' };
const TEST_STATUS = { 0: 'ok', 1: 'aborted', 2: 'interrupted', 3: 'fatal', 4: 'failed', 5: 'failed', 6: 'failed', 7: 'failed', 8: 'failed', 15: 'running' };

// Output of `smartctl -a -j`.
function parseSmart(j) {
  const msgs = ((j.smartctl && j.smartctl.messages) || []).map((m) => m.string || '');
  if (msgs.some((m) => /STANDBY|SLEEP/i.test(m)) && !j.model_name) return { sleeping: true };
  const ataTable = (j.ata_smart_attributes && j.ata_smart_attributes.table) || [];
  const attr = (id) => { const a = ataTable.find((x) => x.id === id); return a && a.raw ? num(a.raw.value) : null; };
  const nv = j.nvme_smart_health_information_log || null;
  const watch = {};
  for (const [id, key] of Object.entries(ATA_WATCH)) { const v = attr(Number(id)); if (v != null) watch[key] = v; }
  if (nv) Object.assign(watch, { mediaErrors: num(nv.media_errors), criticalWarning: num(nv.critical_warning) });
  const tests = ((j.ata_smart_self_test_log && j.ata_smart_self_test_log.standard && j.ata_smart_self_test_log.standard.table) || [])
    .concat(((j.nvme_self_test_log && j.nvme_self_test_log.table) || []).map((t) => ({
      type: { string: t.self_test_code && t.self_test_code.string }, status: { value: t.self_test_result && t.self_test_result.value, passed: t.self_test_result && t.self_test_result.value === 0,
        string: t.self_test_result && t.self_test_result.string }, lifetime_hours: t.power_on_hours })))
    .slice(0, 5).map((t) => ({
      type: (t.type && t.type.string) || '', passed: !!(t.status && t.status.passed),
      result: TEST_STATUS[t.status && t.status.value != null ? t.status.value & 15 : -1] || 'unknown', text: (t.status && t.status.string) || '',
      hours: num(t.lifetime_hours),
    }));
  const st = j.ata_smart_data && j.ata_smart_data.self_test && j.ata_smart_data.self_test.status;
  const nvLog = j.nvme_self_test_log || null;
  const nvRunning = nvLog && nvLog.current_self_test_operation && nvLog.current_self_test_operation.value;
  const nvDone = nvLog ? num(nvLog.current_self_test_completion_percent) : null;
  return {
    sleeping: false,
    model: j.model_name || null, family: j.model_family || null, serial: j.serial_number || null, firmware: j.firmware_version || null,
    size: j.user_capacity ? num(j.user_capacity.bytes) : nv && j.nvme_total_capacity ? num(j.nvme_total_capacity) : null,
    rpm: num(j.rotation_rate), formFactor: j.form_factor ? j.form_factor.name : null,
    link: j.interface_speed && j.interface_speed.current ? j.interface_speed.current.string : null,
    smartOk: j.smart_status ? j.smart_status.passed !== false : null,
    temp: j.temperature ? num(j.temperature.current) : null,
    powerOnHours: j.power_on_time ? num(j.power_on_time.hours) : nv ? num(nv.power_on_hours) : null,
    powerCycles: num(j.power_cycle_count) != null ? num(j.power_cycle_count) : nv ? num(nv.power_cycles) : null,
    watch,
    nvme: nv ? { percentUsed: num(nv.percentage_used), spare: num(nv.available_spare), spareThreshold: num(nv.available_spare_threshold),
      written: nv.data_units_written != null ? num(nv.data_units_written) * 512000 : null, unsafeShutdowns: num(nv.unsafe_shutdowns) } : null,
    errorLog: j.ata_smart_error_log && j.ata_smart_error_log.summary ? num(j.ata_smart_error_log.summary.count) : null,
    // Whether the reading says anything about a running test at all (a drive busy with a test may answer without it).
    testKnown: !!(st && st.value != null) || !!nvLog,
    testRunning: st && st.value >> 4 === 15 ? { remaining: num(st.remaining_percent) } : nvRunning ? { remaining: nvDone != null ? 100 - nvDone : null } : null,
    testMinutes: j.ata_smart_data && j.ata_smart_data.self_test && j.ata_smart_data.self_test.polling_minutes
      ? { short: num(j.ata_smart_data.self_test.polling_minutes.short), long: num(j.ata_smart_data.self_test.polling_minutes.extended) } : null,
    tests,
    attributes: ataTable.map((a) => ({ id: a.id, name: a.name, value: a.value, worst: a.worst, thresh: a.thresh, raw: a.raw ? a.raw.string : '',
      failing: !!(a.when_failed && a.when_failed !== '') })),
  };
}

// Only disks that lsblk knows, so nobody can hand arbitrary paths to smartctl.
async function knownDisk(name) {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(String(name))) throw httpError('Unknown disk.', 400);
  const raw = await run('lsblk', ['-J', '-b', '-d', '-o', 'NAME,SIZE,ROTA,TRAN,MODEL,SERIAL,TYPE']).then(parseLsblk, () => []);
  if (!raw.some((d) => d.name === name)) throw httpError(`The disk ${name} no longer exists.`, 404);
  return raw.find((d) => d.name === name);
}

// wake: also read the disk when it is asleep (it then spins up).
async function diskInfo(name, wake = false) {
  const d = await knownDisk(name);
  const args = [...(wake ? [] : ['-n', 'standby']), '-a', '-j', '/dev/' + name];
  let j;
  try { j = JSON.parse(await run('smartctl', args, { timeout: wake ? 30000 : 10000, anyExit: true })); }
  catch (e) { throw httpError('smartctl could not read the disk: ' + e.message, e.status || 502); }
  const info = { name, transport: d.transport, rotational: d.rotational, ...parseSmart(j) };
  // A test someone started outside MajaOS (or before a restart): follow it on the dashboard too.
  const known = tests.get(name);
  if (info.testRunning && (!known || known.done)) track(name, { model: d.model || null, remaining: info.testRunning.remaining });
  else if (known && !known.done) apply(known, info);
  return info;
}

async function selfTest(name, type) {
  if (!['short', 'long'].includes(type)) throw httpError('Choose a short or a long test.', 400);
  const d = await knownDisk(name);
  const out = await run('smartctl', ['-t', type, '/dev/' + name], { timeout: 30000, anyExit: true });
  if (/Can't start|not supported|failed/i.test(out) && !/has begun|Testing has begun/i.test(out)) throw httpError('The disk refused the test. Maybe one is already running.', 409);
  const m = out.match(/Please wait (\d+) minutes/);
  const minutes = m ? Number(m[1]) : null;
  track(name, { type, minutes, model: d.model || null });
  return { started: true, minutes };
}

/* Self-tests that run, for the dashboard (/api/overview smartTests). Only in memory: a test started with smartctl itself
   shows up once someone opened that disk. Every 30 s the running ones are read again; a finished one stays 30 minutes. */
const tests = new Map();
let timer = null;
const KEEP_DONE = 30 * 60 * 1000, GIVE_UP = 24 * 3600 * 1000;
function track(name, { type = null, minutes = null, model = null, remaining = 100 } = {}) {
  tests.set(name, { name, model, type, minutes, started: Date.now(), percent: Math.max(0, 100 - (remaining == null ? 100 : remaining)), done: false, result: null, at: null });
  if (!timer) { timer = setInterval(() => poll().catch(() => {}), 30000); timer.unref(); }
}
// What a reading says about a tracked test. A reading without the test status (smartctl failed, a busy drive that
// didn't answer the SMART data) says nothing; "not running" only counts after two readings in a row, so one odd
// answer doesn't end a test that still runs (it then vanished from the dashboard until the disk was opened again).
function apply(t, info, now = Date.now()) {
  const giveUp = () => { if (now - t.started > GIVE_UP) Object.assign(t, { done: true, result: 'unknown', at: now }); return t; };
  if (!info || info.sleeping || info.testKnown === false) return giveUp();
  if (info.testRunning) { t.idle = 0; if (info.testRunning.remaining != null) t.percent = Math.max(0, Math.min(99, 100 - info.testRunning.remaining)); return t; }
  t.idle = (t.idle || 0) + 1;
  if (t.idle < 2) return t;
  delete t.idle;
  const last = info.tests && info.tests[0];
  return Object.assign(t, { done: true, percent: 100, result: last ? last.result : 'unknown', text: last ? last.text : '', at: now });
}
async function poll() {
  const now = Date.now();
  for (const [name, t] of tests) {
    if (t.done) { if (now - t.at > KEEP_DONE) tests.delete(name); continue; }
    let info = null;
    try { info = parseSmart(JSON.parse(await run('smartctl', ['-n', 'standby', '-j', '-c', '-l', 'selftest', '/dev/' + name], { timeout: 10000, anyExit: true }))); }
    catch { /* try again next time */ }
    apply(t, info, now);
  }
  if (!tests.size && timer) { clearInterval(timer); timer = null; }
}
function activeTests() { return [...tests.values()].map(({ idle, ...t }) => ({ ...t })); }

// Tests that run without MajaOS knowing: after a restart of MajaOS (an update) the list in memory is empty, and a
// test can be started with smartctl itself. Shortly after the start and then every 10 minutes every disk is asked
// (without waking a sleeping one; a disk that runs a test is awake).
async function discover() {
  const list = await run('lsblk', ['-J', '-b', '-d', '-o', 'NAME,SIZE,ROTA,TRAN,MODEL,SERIAL,TYPE']).then(parseLsblk, () => []);
  for (const d of list) {
    if (!/^[a-z][a-z0-9]{1,15}$/.test(d.name) || d.transport === 'usb') continue;
    const known = tests.get(d.name);
    if (known && !known.done) continue;
    let info = null;
    try { info = parseSmart(JSON.parse(await run('smartctl', ['-n', 'standby', '-j', '-c', '-l', 'selftest', '/dev/' + d.name], { timeout: 10000, anyExit: true }))); }
    catch { continue; }
    if (info.testRunning) track(d.name, { model: d.model || null, remaining: info.testRunning.remaining });
  }
}
function watchTests() {
  const go = () => discover().catch(() => {});
  setTimeout(go, 15000).unref();
  setInterval(go, 10 * 60 * 1000).unref();
}

module.exports = { diskInfo, selfTest, parseSmart, activeTests, watchTests, applyTest: apply };
