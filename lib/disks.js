'use strict';
/* Details van één schijf: alles wat smartctl weet (uren, temperatuur, slijtage, fouten, zelftesten). */
const { run, num, httpError } = require('./system');
const { parseLsblk } = require('./storage');

// Belangrijke ATA-attributen: als die oplopen, is de schijf aan het verslechteren.
const ATA_WATCH = { 5: 'reallocated', 197: 'pending', 198: 'uncorrectable', 187: 'reportedUncorrect', 199: 'crcErrors', 188: 'commandTimeout' };
const TEST_STATUS = { 0: 'ok', 1: 'aborted', 2: 'interrupted', 3: 'fatal', 4: 'failed', 5: 'failed', 6: 'failed', 7: 'failed', 8: 'failed', 15: 'running' };

// Uitvoer van `smartctl -a -j`.
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
  const nvRunning = j.nvme_self_test_log && j.nvme_self_test_log.current_self_test_operation && j.nvme_self_test_log.current_self_test_operation.value;
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
    testRunning: st && st.value >> 4 === 15 ? { remaining: num(st.remaining_percent) } : nvRunning ? { remaining: null } : null,
    testMinutes: j.ata_smart_data && j.ata_smart_data.self_test && j.ata_smart_data.self_test.polling_minutes
      ? { short: num(j.ata_smart_data.self_test.polling_minutes.short), long: num(j.ata_smart_data.self_test.polling_minutes.extended) } : null,
    tests,
    attributes: ataTable.map((a) => ({ id: a.id, name: a.name, value: a.value, worst: a.worst, thresh: a.thresh, raw: a.raw ? a.raw.string : '',
      failing: !!(a.when_failed && a.when_failed !== '') })),
  };
}

// Alleen schijven die lsblk kent, zodat niemand willekeurige paden aan smartctl kan geven.
async function knownDisk(name) {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(String(name))) throw httpError('Onbekende schijf.', 400);
  const raw = await run('lsblk', ['-J', '-b', '-d', '-o', 'NAME,SIZE,ROTA,TRAN,MODEL,SERIAL,TYPE']).then(parseLsblk, () => []);
  if (!raw.some((d) => d.name === name)) throw httpError(`De schijf ${name} bestaat niet (meer).`, 404);
  return raw.find((d) => d.name === name);
}

// wake: ook uitlezen als de schijf slaapt (dan draait ze op).
async function diskInfo(name, wake = false) {
  const d = await knownDisk(name);
  const args = [...(wake ? [] : ['-n', 'standby']), '-a', '-j', '/dev/' + name];
  let j;
  try { j = JSON.parse(await run('smartctl', args, { timeout: wake ? 30000 : 10000, anyExit: true })); }
  catch (e) { throw httpError('smartctl kon de schijf niet lezen: ' + e.message, e.status || 502); }
  return { name, transport: d.transport, rotational: d.rotational, ...parseSmart(j) };
}

async function selfTest(name, type) {
  if (!['short', 'long'].includes(type)) throw httpError('Kies een korte of een lange test.', 400);
  await knownDisk(name);
  const out = await run('smartctl', ['-t', type, '/dev/' + name], { timeout: 30000, anyExit: true });
  if (/Can't start|not supported|failed/i.test(out) && !/has begun|Testing has begun/i.test(out)) throw httpError('De schijf weigerde de test. Misschien loopt er al een.', 409);
  const m = out.match(/Please wait (\d+) minutes/);
  return { started: true, minutes: m ? Number(m[1]) : null };
}

module.exports = { diskInfo, selfTest, parseSmart };
