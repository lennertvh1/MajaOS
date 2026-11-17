'use strict';
/* Tests for the details of a disk from `smartctl -a -j`. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSmart } = require('../lib/disks');

// Shortened, as smartctl 7.4 gives it for a WD Red.
const HDD = {
  smartctl: { exit_status: 0 }, model_family: 'Western Digital Red', model_name: 'WDC WD20EFZX-68AWUN0', serial_number: 'WD-WX12A3456789',
  firmware_version: '81.00B81', user_capacity: { bytes: 2000398934016 }, rotation_rate: 5400, form_factor: { name: '3.5 inches' },
  interface_speed: { current: { string: '6.0 Gb/s' } }, smart_status: { passed: true }, temperature: { current: 34 },
  power_on_time: { hours: 36812 }, power_cycle_count: 87,
  ata_smart_data: { self_test: { status: { value: 249, string: 'in progress, 90% remaining', remaining_percent: 90 }, polling_minutes: { short: 2, extended: 252 } } },
  ata_smart_attributes: { table: [
    { id: 5, name: 'Reallocated_Sector_Ct', value: 200, worst: 200, thresh: 140, when_failed: '', raw: { value: 0, string: '0' } },
    { id: 9, name: 'Power_On_Hours', value: 50, worst: 50, thresh: 0, when_failed: '', raw: { value: 36812, string: '36812' } },
    { id: 197, name: 'Current_Pending_Sector', value: 200, worst: 200, thresh: 0, when_failed: '', raw: { value: 2, string: '2' } },
    { id: 199, name: 'UDMA_CRC_Error_Count', value: 200, worst: 200, thresh: 0, when_failed: '', raw: { value: 0, string: '0' } },
  ] },
  ata_smart_error_log: { summary: { count: 0 } },
  ata_smart_self_test_log: { standard: { table: [
    { type: { string: 'Short offline' }, status: { value: 0, string: 'Completed without error', passed: true }, lifetime_hours: 36700 },
    { type: { string: 'Extended offline' }, status: { value: 7, string: 'Completed: read failure', passed: false }, lifetime_hours: 35000 },
  ] } },
};

test('HDD: hours, temperature, warnings and self-tests', () => {
  const d = parseSmart(HDD);
  assert.equal(d.sleeping, false);
  assert.deepEqual([d.model, d.serial, d.firmware, d.rpm, d.link, d.smartOk, d.temp, d.powerOnHours, d.powerCycles],
    ['WDC WD20EFZX-68AWUN0', 'WD-WX12A3456789', '81.00B81', 5400, '6.0 Gb/s', true, 34, 36812, 87]);
  assert.deepEqual(d.watch, { reallocated: 0, pending: 2, crcErrors: 0 });
  assert.deepEqual(d.testRunning, { remaining: 90 });
  assert.deepEqual(d.testMinutes, { short: 2, long: 252 });
  assert.deepEqual(d.tests.map((t) => [t.type, t.passed, t.result, t.hours]), [['Short offline', true, 'ok', 36700], ['Extended offline', false, 'failed', 35000]]);
  assert.equal(d.attributes.length, 4);
  assert.equal(d.nvme, null);
});

test('NVMe: wear, spare and data written', () => {
  const d = parseSmart({
    model_name: 'Samsung SSD 980 500GB', serial_number: 'S64DNX0R123456', nvme_total_capacity: 500107862016, smart_status: { passed: true }, temperature: { current: 41 },
    nvme_smart_health_information_log: { critical_warning: 0, percentage_used: 3, available_spare: 100, available_spare_threshold: 10, data_units_written: 20000000,
      power_on_hours: 9120, power_cycles: 64, unsafe_shutdowns: 12, media_errors: 0 },
  });
  assert.deepEqual([d.size, d.powerOnHours, d.powerCycles, d.temp], [500107862016, 9120, 64, 41]);
  assert.deepEqual(d.nvme, { percentUsed: 3, spare: 100, spareThreshold: 10, written: 20000000 * 512000, unsafeShutdowns: 12 });
  assert.deepEqual(d.watch, { mediaErrors: 0, criticalWarning: 0 });
});

test('a sleeping disk is not woken up', () => {
  assert.deepEqual(parseSmart({ smartctl: { exit_status: 2, messages: [{ string: 'Device is in STANDBY mode, exit(2)', severity: 'information' }] } }), { sleeping: true });
});

test('a tracked self-test follows the readings and ends with the newest log entry', () => {
  const { applyTest } = require('../lib/disks');
  const tr = { name: 'sda', started: 1000, percent: 0, done: false, result: null, at: null };
  applyTest(tr, { sleeping: false, testRunning: { remaining: 70 }, tests: [] }, 2000);
  assert.equal(tr.percent, 30);
  assert.equal(tr.done, false);
  applyTest(tr, { sleeping: true }, 3000);
  assert.equal(tr.done, false);
  // A reading without the status says nothing.
  applyTest(tr, { sleeping: false, testKnown: false, testRunning: null, tests: [{ result: 'ok' }] }, 3500);
  assert.equal(tr.done, false);
  // Not running once is not enough; twice in a row ends it with the newest log entry.
  const idle = { sleeping: false, testKnown: true, testRunning: null, tests: [{ result: 'failed', text: 'Completed: read failure' }] };
  applyTest(tr, idle, 4000);
  assert.equal(tr.done, false);
  applyTest(tr, { sleeping: false, testKnown: true, testRunning: { remaining: 50 }, tests: [] }, 4500);
  applyTest(tr, idle, 5000);
  assert.equal(tr.done, false);
  applyTest(tr, idle, 6000);
  assert.deepEqual([tr.done, tr.percent, tr.result, tr.at], [true, 100, 'failed', 6000]);
});

test('a reading without SMART data says nothing about the test', () => {
  assert.equal(parseSmart({ model_name: 'X', smartctl: { exit_status: 4 } }).testKnown, false);
  assert.equal(parseSmart({ ata_smart_data: { self_test: { status: { value: 249, remaining_percent: 90 } } } }).testKnown, true);
});

test('an NVMe self-test reports how far it is', () => {
  const d = parseSmart({ model_name: 'X', nvme_smart_health_information_log: {}, nvme_self_test_log: { current_self_test_operation: { value: 1 }, current_self_test_completion_percent: 40, table: [] } });
  assert.deepEqual(d.testRunning, { remaining: 60 });
});
