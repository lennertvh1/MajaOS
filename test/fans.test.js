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
