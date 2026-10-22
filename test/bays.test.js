'use strict';
/* Tests voor de schijfbays: sleutel per schijf en controle van de indeling. */
const test = require('node:test');
const assert = require('node:assert/strict');
const bays = require('../lib/bays');

test('schijf herkennen aan serienummer, anders aan de naam', () => {
  assert.equal(bays.diskKey({ name: 'sda', serial: 'WD-WX12A3456789 ' }), 's:WD-WX12A3456789');
  assert.equal(bays.diskKey({ name: 'vda', serial: null }), 'n:vda');
});

test('indeling controleren', () => {
  const ok = bays.validateBays({ count: 4, columns: 2, slots: { 1: { key: 's:A', label: 'WDC · A' }, 3: { key: 's:B' }, 6: { key: 's:C' } } });
  assert.deepEqual(ok, { count: 4, columns: 2, m2: 0, ssd: 0, slots: { 1: { key: 's:A', label: 'WDC · A' }, 3: { key: 's:B', label: '' } } }); // bay 6 bestaat niet meer
  assert.throws(() => bays.validateBays({ count: 61, columns: 4 }), /tussen 0 en 60/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 0 }), /tussen 1 en 12/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, slots: { 1: { key: 's:A' }, 2: { key: 's:A' } } }), /maar in één bay/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, slots: { 1: { key: 'sda' } } }), /Onbekende schijf/);
});

test('M.2-sleuven voor NVMe', () => {
  const ok = bays.validateBays({ count: 4, columns: 4, m2: 2, slots: { 1: { key: 's:A' }, m1: { key: 's:N1' }, m2: { key: 's:N2' }, m3: { key: 's:N3' } } });
  assert.deepEqual(Object.keys(ok.slots), ['1', 'm1', 'm2']); // m3 bestaat niet
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, m2: 9 }), /tussen 0 en 8 M\.2/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, m2: 2, slots: { 1: { key: 's:A' }, m1: { key: 's:A' } } }), /maar in één bay/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, m2: 2, slots: { m1: { key: 'x' } } }), /Onbekende schijf in M\.2-sleuf 1/);
});

test('2,5"-sleuven voor SSD\'s', () => {
  const ok = bays.validateBays({ count: 4, columns: 4, m2: 1, ssd: 2, slots: { 2: { key: 's:A' }, s1: { key: 's:S1' }, s2: { key: 's:S2' }, s3: { key: 's:S3' }, m1: { key: 's:N' } } });
  assert.deepEqual(Object.keys(ok.slots).sort(), ['2', 'm1', 's1', 's2']);
  assert.equal(ok.ssd, 2);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, ssd: 17 }), /tussen 0 en 16 2,5"/);
  assert.throws(() => bays.validateBays({ count: 4, columns: 4, ssd: 1, slots: { s1: { key: '?' } } }), /2,5"-sleuf 1/);
});
