'use strict';
/* Tests for date and time: timedatectl output, the timesyncd file and the checks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
const dtm = require('../lib/datetime');
const settings = require('../lib/settings');

test('timedatectl show', () => {
  const out = `Timezone=Europe/Brussels
LocalRTC=no
CanNTP=yes
NTP=yes
NTPSynchronized=yes
TimeUSec=Thu 2026-10-22 19:30:12 CEST
RTCTimeUSec=Thu 2026-10-22 17:30:12 UTC
`;
  const s = dtm.parseKeyValues(out);
  assert.equal(s.Timezone, 'Europe/Brussels');
  assert.equal(s.NTP, 'yes');
  assert.equal(s.TimeUSec, 'Thu 2026-10-22 19:30:12 CEST');
  const sync = dtm.parseKeyValues('LinkNTPServers=\nSystemNTPServers=\nFallbackNTPServers=0.debian.pool.ntp.org 1.debian.pool.ntp.org\nServerName=0.debian.pool.ntp.org\nServerAddress=193.190.198.10\n');
  assert.equal(sync.ServerName, '0.debian.pool.ntp.org');
  assert.equal(sync.SystemNTPServers, '');
});

test('timesyncd.conf: only NTP= in [Time]', () => {
  assert.deepEqual(dtm.parseTimesyncConf('# opmerking\n[Time]\nNTP=be.pool.ntp.org 192.168.1.1\nFallbackNTP=x\n'), ['be.pool.ntp.org', '192.168.1.1']);
  assert.deepEqual(dtm.parseTimesyncConf('[Other]\nNTP=a\n'), []);
  assert.deepEqual(dtm.parseTimesyncConf(''), []);
});

test('checking time servers', () => {
  assert.deepEqual(dtm.validateServers('be.pool.ntp.org, 192.168.1.1  be.pool.ntp.org'), ['be.pool.ntp.org', '192.168.1.1']);
  assert.deepEqual(dtm.validateServers(''), []);
  assert.throws(() => dtm.validateServers('ntp_server.be'), /not a valid time server/);
  assert.throws(() => dtm.validateServers('a;rm -rf /'), /not a valid time server/);
  assert.throws(() => dtm.validateServers('-o.example'), /not a valid time server/);
  assert.throws(() => dtm.validateServers('a b c d e f g'), /at most 6/);
});

test('date and time for set-time', () => {
  assert.equal(dtm.parseLocalTime('2026-10-22T18:30'), '2026-10-22 18:30:00');
  assert.equal(dtm.parseLocalTime('2026-10-22T18:30:15'), '2026-10-22 18:30:15');
  for (const bad of ['', '2026-02-30T10:00', '2026-10-22T24:00', '1999-01-01T00:00', '22/10/2026 18:30', '2026-10-22T18:30; reboot']) {
    assert.throws(() => dtm.parseLocalTime(bad), /valid date/, bad);
  }
});

test('time format in the settings', () => {
  assert.equal(settings.getSettings().clock, 'auto');
  assert.equal(settings.saveSettings({ clock: '12' }).clock, '12');
  assert.equal(settings.getSettings().clock, '12');
  assert.throws(() => settings.saveSettings({ clock: '13' }), /time format/);
});
