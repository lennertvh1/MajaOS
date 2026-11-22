'use strict';
/* Tests for disk sleep: reading /proc/diskstats and hdparm -C, and when a disk is due. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'majaos-spin-'));
const sd = require('../lib/spindown');

const STATS = `   8       0 sda 51234 120 4096000 3000 8800 900 702000 12000 0 9000 15000 0 0 0 0 120 40
   8       1 sda1 51000 120 4090000 2990 8800 900 702000 12000 0 8990 14990 0 0 0 0 0 0
   8      16 sdb 10 0 80 1 0 0 0 0 0 1 1 0 0 0 0 0 0
 259       0 nvme0n1 900 0 7200 10 400 0 3200 5 0 15 15 0 0 0 0 0 0`;

test('diskstats: reads and writes completed per device', () => {
  const c = sd.parseDiskstats(STATS);
  assert.equal(c.sda, 51234 + 8800);
  assert.equal(c.sdb, 10);
  assert.equal(c.nvme0n1, 1300);
  assert.equal(c.sda1, 51000 + 8800);
});

test('hdparm -C: the power mode', () => {
  assert.equal(sd.parsePowerMode('\n/dev/sda:\n drive state is:  standby\n'), 'standby');
  assert.equal(sd.parsePowerMode('\n/dev/sda:\n drive state is:  active/idle\n'), 'active');
  assert.equal(sd.parsePowerMode('\n/dev/sda:\n drive state is:  idle_a\n'), 'active');
  assert.equal(sd.parsePowerMode('\n/dev/sdb:\n drive state is:  unknown\n'), 'unknown');
  assert.equal(sd.parsePowerMode(''), 'unknown');
});

test('the time for a disk: its own, else the default; 0 = never', () => {
  const cfg = { minutes: 30, disks: { 's:A': 0, 's:B': 60 } };
  assert.equal(sd.minutesFor(cfg, 's:A'), 0);
  assert.equal(sd.minutesFor(cfg, 's:B'), 60);
  assert.equal(sd.minutesFor(cfg, 's:C'), 30);
});

test('a disk goes to sleep only after its time without reads or writes, once', () => {
  sd._seen.clear();
  const disks = [{ name: 'sda', serial: 'A' }, { name: 'sdb', serial: 'B' }];
  const cfg = { minutes: 10, disks: { 's:B': 0 } };
  const t0 = 1_000_000, min = 60000;
  assert.deepEqual(sd.observe({ sda: 100, sdb: 5 }, disks, cfg, t0), []); // first look: only remembered
  assert.deepEqual(sd.observe({ sda: 120, sdb: 5 }, disks, cfg, t0 + 5 * min), []); // used at 5 min
  assert.deepEqual(sd.observe({ sda: 120, sdb: 5 }, disks, cfg, t0 + 14 * min), []); // 9 min idle
  const due = sd.observe({ sda: 120, sdb: 5 }, disks, cfg, t0 + 15 * min); // 10 min idle; sdb is set to never
  assert.deepEqual(due.map((d) => d.name), ['sda']);
  sd._seen.get('sda').asleep = true;
  assert.deepEqual(sd.observe({ sda: 120, sdb: 5 }, disks, cfg, t0 + 30 * min), []); // already asleep
  assert.equal(sd.asleep('sda'), true);
  sd.observe({ sda: 121, sdb: 5 }, disks, cfg, t0 + 31 * min); // a read woke it
  assert.equal(sd.asleep('sda'), false);
  // Another disk under the same name (sda swapped): starts over.
  sd.observe({ sda: 121, sdb: 5 }, [{ name: 'sda', serial: 'Z' }], cfg, t0 + 60 * min);
  assert.equal(sd._seen.get('sda').key, 's:Z');
  assert.equal(sd._seen.has('sdb'), false);
});

test('saving: only times from the list, a disk back to the default with null', async () => {
  await assert.rejects(sd.save({ minutes: 7 }), /Choose one of the times/);
  await assert.rejects(sd.save({ disks: { '../x': 10 } }), /Unknown disk/);
  const file = path.join(process.env.DATA_DIR, 'spindown.json');
  await sd.save({ minutes: 20, disks: { 's:A': 60 } }).catch(() => {}); // status() may fail without lsblk; the file is written first
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { minutes: 20, disks: { 's:A': 60 } });
  await sd.save({ disks: { 's:A': null } }).catch(() => {});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { minutes: 20, disks: {} });
});
