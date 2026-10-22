'use strict';
/*
 * Datum, tijd en tijdzone van de server (systemd: timedatectl en systemd-timesyncd).
 * Eigen tijdservers staan in /etc/systemd/timesyncd.conf.d/homebaseos.conf; zonder dat bestand gebruikt Debian zijn standaardservers.
 */
const fs = require('node:fs');
const path = require('node:path');
const { run, httpError, readText } = require('./system');

const TIMESYNC_DIR = process.env.TIMESYNC_DIR || '/etc/systemd/timesyncd.conf.d';
const TIMESYNC_FILE = path.join(TIMESYNC_DIR, 'homebaseos.conf');
const HOST = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

// De tijdzone van de server, uit de koppeling /etc/localtime (Node zelf onthoudt de tijdzone van bij de start).
function hostTimezone() {
  try {
    const m = fs.readlinkSync('/etc/localtime').match(/zoneinfo\/(.+)$/);
    if (m) return m[1];
  } catch { /* geen koppeling */ }
  return readText('/etc/timezone').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Brussels';
}

// `timedatectl show` en `show-timesync` geven regels "Sleutel=waarde".
function parseKeyValues(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const yes = (v) => v === 'yes' || v === 'true';

// Tijdservers uit ons eigen bestand ([Time] NTP=a b c).
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
  if (arr.length > 6) throw httpError('Geef maximaal 6 tijdservers op.', 400);
  for (const h of arr) if (!HOST.test(h) && !IPV4.test(h)) throw httpError(`"${h}" is geen geldige tijdserver. Gebruik een naam zoals be.pool.ntp.org of een IP-adres.`, 400);
  return [...new Set(arr)];
}

// "2026-10-22T18:30" of "2026-10-22T18:30:15" → "2026-10-22 18:30:15" voor timedatectl set-time.
function parseLocalTime(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw httpError('Vul een geldige datum en tijd in.', 400);
  const [, y, mo, d, h, mi, s = '00'] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (+y < 2020 || +y > 2100 || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) throw httpError('Vul een geldige datum en tijd in.', 400);
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
    ntp: show ? yes(s.NTP) : null,               // null = timedatectl niet beschikbaar
    ntpAvailable: show ? s.CanNTP !== 'no' : false,
    synced: show ? yes(s.NTPSynchronized) : null,
    localRtc: yes(s.LocalRTC),
    server: ts.ServerName || null,               // de tijdserver die nu gebruikt wordt
    servers: own,                                 // eigen tijdservers ([] = standaard van Debian)
    defaultServers: (ts.FallbackNTPServers || '').split(/\s+/).filter(Boolean),
    editable: !!show,
    timezones: zones,
  };
}

async function setDateTime(body) {
  const cur = await getDateTime();
  if (!cur.editable) throw httpError('timedatectl is niet beschikbaar op deze server.', 501);
  if (body.timezone != null && body.timezone !== cur.timezone) {
    if (!cur.timezones.includes(body.timezone)) throw httpError('Kies een tijdzone uit de lijst.', 400);
    await run('timedatectl', ['set-timezone', body.timezone]);
  }
  if (body.servers != null) {
    const list = validateServers(body.servers);
    if (list.join(' ') !== cur.servers.join(' ')) {
      if (list.length) {
        fs.mkdirSync(TIMESYNC_DIR, { recursive: true });
        fs.writeFileSync(TIMESYNC_FILE, '# Gemaakt door HomeBaseOS (Instellingen > Algemeen)\n[Time]\nNTP=' + list.join(' ') + '\n');
      } else fs.rmSync(TIMESYNC_FILE, { force: true });
      await run('systemctl', ['restart', 'systemd-timesyncd']).catch(() => {}); // staat de synchronisatie uit, dan maakt het niet uit
    }
  }
  const ntp = body.ntp == null ? cur.ntp : !!body.ntp;
  if (ntp !== cur.ntp) {
    if (ntp && !cur.ntpAvailable) throw httpError('Automatische tijd werkt niet: systemd-timesyncd is niet geïnstalleerd. Voer install.sh opnieuw uit.', 409);
    await run('timedatectl', ['set-ntp', ntp ? 'true' : 'false']);
  }
  if (body.time != null && body.time !== '') {
    if (ntp) throw httpError('Zet de automatische tijd eerst uit om de tijd zelf in te stellen.', 409);
    await run('timedatectl', ['set-time', parseLocalTime(body.time)]);
  }
  return getDateTime();
}

module.exports = { hostTimezone, parseKeyValues, parseTimesyncConf, validateServers, parseLocalTime, getDateTime, setDateTime, timezones };
