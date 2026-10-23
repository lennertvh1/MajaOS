'use strict';
/*
 * Date, time and time zone of the server (systemd: timedatectl and systemd-timesyncd).
 * Custom time servers are in /etc/systemd/timesyncd.conf.d/homebaseos.conf; without that file Debian uses its default servers.
 */
const fs = require('node:fs');
const path = require('node:path');
const { run, httpError, readText } = require('./system');

const TIMESYNC_DIR = process.env.TIMESYNC_DIR || '/etc/systemd/timesyncd.conf.d';
const TIMESYNC_FILE = path.join(TIMESYNC_DIR, 'homebaseos.conf');
const HOST = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

// The time zone of the server, from the link /etc/localtime (Node itself remembers the time zone from when it started).
function hostTimezone() {
  try {
    const m = fs.readlinkSync('/etc/localtime').match(/zoneinfo\/(.+)$/);
    if (m) return m[1];
  } catch { /* no link */ }
  return readText('/etc/timezone').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Brussels';
}

// `timedatectl show` and `show-timesync` print lines "Key=value".
function parseKeyValues(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const yes = (v) => v === 'yes' || v === 'true';

// Time servers from our own file ([Time] NTP=a b c).
function parseTimesyncConf(text) {
  let section = '';
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = line.match(/^\[(.+)\]$/);
    if (s) { section = s[1]; continue; }
    const m = line.match(/^NTP\s*=\s*(.*)$/);
    if (section === 'Time' && m) return m[1].split(/\s+/).filter(Boolean);
  }
  return [];
}

function validateServers(list) {
  const arr = (Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean);
  if (arr.length > 6) throw httpError('Enter at most 6 time servers.', 400);
  for (const h of arr) if (!HOST.test(h) && !IPV4.test(h)) throw httpError(`"${h}" is not a valid time server. Use a name like be.pool.ntp.org or an IP address.`, 400);
  return [...new Set(arr)];
}

// "2026-10-22T18:30" or "2026-10-22T18:30:15" → "2026-10-22 18:30:15" for timedatectl set-time.
function parseLocalTime(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw httpError('Enter a valid date and time.', 400);
  const [, y, mo, d, h, mi, s = '00'] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (+y < 2020 || +y > 2100 || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) throw httpError('Enter a valid date and time.', 400);
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

let zoneCache = null;
async function timezones() {
  if (zoneCache) return zoneCache;
  let list = [];
  try { list = (await run('timedatectl', ['list-timezones'], { timeout: 10000 })).split('\n').map((x) => x.trim()).filter(Boolean); }
  catch { try { list = Intl.supportedValuesOf('timeZone'); } catch { list = []; } }
  if (!list.includes('UTC')) list.push('UTC');
  zoneCache = list.sort();
  return zoneCache;
}

async function getDateTime() {
  const [show, sync, zones] = await Promise.all([
    run('timedatectl', ['show'], { timeout: 10000 }).catch(() => ''),
    run('timedatectl', ['show-timesync'], { timeout: 10000 }).catch(() => ''),
    timezones(),
  ]);
  const s = parseKeyValues(show), ts = parseKeyValues(sync);
  const own = parseTimesyncConf(readText(TIMESYNC_FILE));
  return {
    now: Date.now(),
    timezone: s.Timezone || hostTimezone(),
    ntp: show ? yes(s.NTP) : null,               // null = timedatectl not available
    ntpAvailable: show ? s.CanNTP !== 'no' : false,
    synced: show ? yes(s.NTPSynchronized) : null,
    localRtc: yes(s.LocalRTC),
    server: ts.ServerName || null,               // the time server in use right now
    servers: own,                                 // custom time servers ([] = Debian's default)
    defaultServers: (ts.FallbackNTPServers || '').split(/\s+/).filter(Boolean),
    editable: !!show,
    timezones: zones,
  };
}

async function setDateTime(body) {
  const cur = await getDateTime();
  if (!cur.editable) throw httpError('timedatectl is not available on this server.', 501);
  if (body.timezone != null && body.timezone !== cur.timezone) {
    if (!cur.timezones.includes(body.timezone)) throw httpError('Choose a time zone from the list.', 400);
    await run('timedatectl', ['set-timezone', body.timezone]);
  }
  if (body.servers != null) {
    const list = validateServers(body.servers);
    if (list.join(' ') !== cur.servers.join(' ')) {
      if (list.length) {
        fs.mkdirSync(TIMESYNC_DIR, { recursive: true });
        fs.writeFileSync(TIMESYNC_FILE, '# Created by HomeBaseOS (Settings > General)\n[Time]\nNTP=' + list.join(' ') + '\n');
      } else fs.rmSync(TIMESYNC_FILE, { force: true });
      await run('systemctl', ['restart', 'systemd-timesyncd']).catch(() => {}); // if synchronisation is off, it doesn't matter
    }
  }
  const ntp = body.ntp == null ? cur.ntp : !!body.ntp;
  if (ntp !== cur.ntp) {
    if (ntp && !cur.ntpAvailable) throw httpError('Automatic time doesn\'t work: systemd-timesyncd is not installed. Run install.sh again.', 409);
    await run('timedatectl', ['set-ntp', ntp ? 'true' : 'false']);
  }
  if (body.time != null && body.time !== '') {
    if (ntp) throw httpError('Turn off automatic time first to set the time yourself.', 409);
    await run('timedatectl', ['set-time', parseLocalTime(body.time)]);
  }
  return getDateTime();
}

module.exports = { hostTimezone, parseKeyValues, parseTimesyncConf, validateServers, parseLocalTime, getDateTime, setDateTime, timezones };
