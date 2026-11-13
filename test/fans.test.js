'use strict';
/* Cooling (lib/fans.js): reading hwmon, curves, the safety rules, applying and restoring. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fans-'));
process.env.HWMON_DIR = path.join(root, 'hwmon');
process.env.DATA_DIR = path.join(root, 'data');
process.env.FANS_MODULES_FILE = path.join(root, 'modules.conf');
process.env.FANS_OPTIONS_FILE = path.join(root, 'options.conf');
process.env.FANS_WAIT_MS = '1';
const w = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(v)); };
// k10temp (CPU), nct6798 (board: two fans, two PWM channels), nvme.
w(path.join(root, 'hwmon/hwmon0/name'), 'k10temp'); w(path.join(root, 'hwmon/hwmon0/temp1_input'), '48250'); w(path.join(root, 'hwmon/hwmon0/temp1_label'), 'Tctl');
w(path.join(root, 'hwmon/hwmon1/name'), 'nct6798');
w(path.join(root, 'hwmon/hwmon1/temp1_input'), '35000'); w(path.join(root, 'hwmon/hwmon1/temp1_label'), 'SYSTIN');
w(path.join(root, 'hwmon/hwmon1/temp7_input'), '-62000'); // unused input: left out
w(path.join(root, 'hwmon/hwmon1/fan1_input'), '812'); w(path.join(root, 'hwmon/hwmon1/fan2_input'), '1240');
w(path.join(root, 'hwmon/hwmon1/pwm1'), '102'); w(path.join(root, 'hwmon/hwmon1/pwm1_enable'), '5');
w(path.join(root, 'hwmon/hwmon1/pwm2'), '153'); w(path.join(root, 'hwmon/hwmon1/pwm2_enable'), '5');
w(path.join(root, 'hwmon/hwmon2/name'), 'nvme'); w(path.join(root, 'hwmon/hwmon2/temp1_input'), '39850'); w(path.join(root, 'hwmon/hwmon2/temp1_label'), 'Composite');
const fans = require('../lib/fans');
const pwm1 = path.join(root, 'hwmon/hwmon1/pwm1');

test('reading: temperatures in °C (unused inputs left out), fans with their PWM channel', async () => {
  const st = await fans.status();
  assert.deepEqual(st.temps.filter((x) => x.id !== 'gpu').map((x) => [x.chip, x.label, x.value, x.cpu]), [
    ['k10temp', 'Tctl', 48.3, true], ['nct6798', 'SYSTIN', 35, false], ['nvme', 'Composite', 39.9, false]]);
  assert.deepEqual(st.fans.map((f) => [f.id, f.rpm, f.pwm.percent, f.pwm.mode]), [
    ['nct6798@hwmon1/fan1', 812, 40, 'auto'], ['nct6798@hwmon1/fan2', 1240, 60, 'auto']]);
  assert.equal(st.controllable, true);
});

test('a curve: straight lines between the points, flat outside them', () => {
  const pts = [[30, 20], [50, 40], [70, 100]];
  assert.equal(fans.curvePercent(pts, 20), 20);
  assert.equal(fans.curvePercent(pts, 40), 30);
  assert.equal(fans.curvePercent(pts, 60), 70);
  assert.equal(fans.curvePercent(pts, 90), 100);
  assert.equal(fans.curvePercent(pts, null), 100); // no temperature: full speed
});

test('the safety rules: the minimum, 100% when the CPU is hot or the source is gone', () => {
  const temps = [{ id: 'cpu', value: 50, cpu: true }, { id: 'nvme', value: 40, cpu: false }];
  assert.equal(fans.target({ mode: 'auto' }, temps), null);
  assert.equal(fans.target({ mode: 'fixed', percent: 10, min: 25 }, temps), 25);
  assert.equal(fans.target({ mode: 'curve', source: 'nvme', points: [[30, 20], [50, 60]], min: 0 }, temps), 40);
  assert.equal(fans.target({ mode: 'curve', source: 'gone', points: [[30, 20], [50, 60]], min: 0 }, temps), 100);
  assert.equal(fans.target({ mode: 'fixed', percent: 30, min: 0 }, [{ id: 'cpu', value: fans.HOT, cpu: true }]), 100);
  const fails = (b) => { try { fans.validate(b, temps); } catch (e) { return e.message; } return null; };
  assert.match(fails({ mode: 'turbo' }), /Auto, Fixed or Curve/);
  assert.match(fails({ mode: 'fixed', percent: 120 }), /between 0 and 100/);
  assert.match(fails({ mode: 'curve', source: 'x', points: [[30, 20], [50, 60]] }), /temperature the fan follows/);
  assert.match(fails({ mode: 'curve', source: 'nvme', points: [[30, 20]] }), /between 2 and 8 points/);
});

test('applying: fixed sets manual mode and the speed; auto and restore put the chip\'s own mode back', async () => {
  await fans.save('nct6798@hwmon1/pwm1', { mode: 'fixed', percent: 60, min: 20, name: 'CPU fan' });
  assert.equal(fs.readFileSync(pwm1 + '_enable', 'utf8'), '1');
  assert.equal(fs.readFileSync(pwm1, 'utf8'), String(Math.round(0.6 * 255)));
  const st = await fans.status();
  assert.equal(st.fans[0].name, 'CPU fan');
  assert.equal(st.fans[0].pwm.mode, 'fixed');
  fans.restore(); // what systemd runs when MajaOS stops
  assert.equal(fs.readFileSync(pwm1 + '_enable', 'utf8'), '5');
  await fans.save('nct6798@hwmon1/pwm1', { mode: 'fixed', percent: 60, min: 20 });
  await fans.save('nct6798@hwmon1/pwm1', { mode: 'auto' });
  assert.equal(fs.readFileSync(pwm1 + '_enable', 'utf8'), '5');
});

test('the sensor chip: sensors-detect\'s findings, and whether the BIOS blocks it', () => {
  const out = `# sensors-detect version 3.6.0
Probing for Super-I/O at 0x2e/0x2f
Trying family \`National Semiconductor/ITE'...               No
Trying family \`Nuvoton/Winbond'...                          Yes
Found \`Nuvoton NCT6798D Super IO Sensors'                   Success!
    (address 0x290, driver \`nct6775')
Found \`ITE IT8689E Super IO Sensors'                        Success!
    (address 0xa40, driver \`to-be-written')
AMD Family 17h thermal sensors...                           Success!
    (driver \`k10temp')
`;
  assert.deepEqual(fans.parseSensorsDetect(out), [{ chip: 'Nuvoton NCT6798D', driver: 'nct6775' }, { chip: 'ITE IT8689E', driver: 'to-be-written' }]);
  assert.equal(fans.acpiConflict('ACPI Warning: SystemIO range 0x0000000000000295-0x0000000000000296 conflicts with OpRegion 0x290-0x299 (\\_GPE.HWM) (20230628/utaddress-204)\nnct6775: resource conflict', 'nct6775'), true);
  assert.equal(fans.acpiConflict('usb 1-1: new high-speed USB device', 'nct6775'), false);
});

test('like FanControl: several sources (the highest counts), hysteresis, step speed and a start kick', () => {
  const temps = (cpu, gpu) => [{ id: 'cpu', value: cpu, cpu: true }, { id: 'gpu', value: gpu, cpu: false }];
  const ch = { mode: 'curve', sources: ['cpu', 'gpu'], points: [[30, 20], [70, 100]], min: 0, hyst: 3 };
  assert.equal(fans.target(ch, temps(40, 60)), 80); // the GPU is hotter: it decides
  // Hysteresis: from 60 °C (80%) back to 58 °C stays at 80%; at 56 °C it slows down.
  assert.deepEqual(fans.nextPercent(ch, temps(40, 58), { pct: 80, temp: 60 }), { pct: 80, temp: 60 });
  assert.equal(fans.nextPercent(ch, temps(40, 56), { pct: 80, temp: 60 }).pct, 72);
  // Step speed: at most 2%/s down and 10%/s up, per 3 s.
  const slow = { ...ch, hyst: 0, stepDown: 2, stepUp: 10 };
  assert.equal(fans.nextPercent(slow, temps(30, 30), { pct: 80, temp: 60 }, 3).pct, 74);
  assert.equal(fans.nextPercent(slow, temps(30, 70), { pct: 20, temp: 30 }, 3).pct, 50);
  // Safety skips all of that: a source that is gone means full speed at once.
  assert.equal(fans.nextPercent({ ...slow, sources: ['cpu', 'gone'] }, temps(30, 30), { pct: 20, temp: 30 }).pct, 100);
  // A stopped fan gets its start speed for a moment.
  const kick = { mode: 'fixed', percent: 15, min: 0, calib: { stop: 10, start: 30 } };
  assert.equal(fans.nextPercent(kick, temps(40, 40), { pct: 0, temp: null }).pct, 30);
  assert.equal(fans.nextPercent(kick, temps(40, 40), { pct: 30, temp: null }).pct, 15);
});

test('pairing: the fan that slows down clearly when the channel goes to 0%', () => {
  assert.equal(fans.pairFan({ a: 1200, b: 900 }, { a: 1180, b: 0 }), 'b');
  assert.equal(fans.pairFan({ a: 1200, b: 900 }, { a: 1150, b: 880 }), null); // nothing changed: not paired
  assert.equal(fans.pairFan({ a: 1500, b: 900 }, { a: 600, b: 400 }), 'a'); // a fan that never stops still counts
});

test('driver options: one driver\'s lines replaced, the rest kept', () => {
  const before = '# Written by MajaOS (Settings → Cooling): options of the sensor drivers.\noptions it87 force_id=0x8628\noptions other x=1\n';
  const after = fans.buildOptions(before, { module: 'it87', options: 'ignore_resource_conflict=1' });
  assert.match(after, /^options other x=1$/m);
  assert.match(after, /^options it87 ignore_resource_conflict=1$/m);
  assert.doesNotMatch(after, /force_id/);
  assert.match(fans.buildOptions('', { module: 'nct6687', blacklist: ['nct6683'] }), /^blacklist nct6683$/m);
  assert.ok(fans.COMMUNITY.it87.match.test('ITE IT8689E') && fans.COMMUNITY.nct6687.match.test('Nuvoton NCT6687D'));
  assert.match(fans.COMMUNITY.it87.commit, /^[0-9a-f]{40}$/);
});

test('Detect fans tests every channel and puts the chip\'s own mode back afterwards', async () => {
  await fans.save('nct6798@hwmon1/pwm1', { mode: 'auto' });
  fs.writeFileSync(pwm1 + '_enable', '5');
  const started = fans.detect();
  assert.equal(started.state, 'running');
  assert.throws(() => fans.detect(), /already/);
  for (let i = 0; i < 200 && fans.progress().state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  const done = fans.progress();
  assert.equal(done.state, 'done');
  assert.equal(done.results.length, 2); // the sample fans don't react: nothing paired
  assert.equal(fs.readFileSync(pwm1 + '_enable', 'utf8'), '5');
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'fans.json'), 'utf8')).testing, undefined);
});

test('an older driver (f71882fg) registers the legacy way: everything in hwmonN/device/', async () => {
  const dev = path.join(root, 'hwmon/hwmon7/device');
  w(path.join(dev, 'name'), 'f71889ed');
  w(path.join(dev, 'fan1_input'), '1032'); w(path.join(dev, 'pwm1'), '128'); w(path.join(dev, 'pwm1_enable'), '2');
  w(path.join(dev, 'temp1_input'), '41000');
  const r = fans.read();
  assert.deepEqual(r.fans.filter((f) => f.chip === 'f71889ed').map((f) => [f.id, f.rpm]), [['f71889ed@device/fan1', 1032]]);
  assert.equal(r.pwms.find((p) => p.chip === 'f71889ed').file, path.join(dev, 'pwm1'));
  assert.ok(r.temps.some((x) => x.chip === 'f71889ed' && x.value === 41));
  fs.rmSync(path.join(root, 'hwmon/hwmon7'), { recursive: true, force: true });
});
