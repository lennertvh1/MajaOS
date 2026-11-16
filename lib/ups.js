'use strict';
/*
 * UPS through NUT (Network UPS Tools), Settings → UPS.
 *
 * Two ways:
 *  - local: the UPS hangs on this server (usually USB). MajaOS writes /etc/nut (nut.conf, ups.conf, upsd.conf,
 *    upsd.users, upsmon.conf) and runs the driver, upsd and upsmon as primary. With `share` upsd also listens on the
 *    network, with a second user (secondary) for other devices: Home Assistant, a NAS, another server.
 *  - remote: the UPS hangs on another NUT server (a NAS, Unraid, another MajaOS). Only upsmon runs, as secondary.
 *
 * Shutting down: upsmon itself shuts the server down when the UPS reports a low battery (LB) or a forced shutdown (FSD).
 * On top of that MajaOS can shut down earlier: after `minutes` on battery, or when the charge falls to `percent`.
 * As primary that is `upsmon -c fsd`, so the secondaries shut down too and the UPS switches its output off at the end
 * (the server starts again when the power returns, if the BIOS is set to power on after a power loss);
 * as secondary it is a plain poweroff.
 *
 * DATA_DIR/ups.json (0600): {mode: off|local|remote, name, driver, port, extra {vendorid, productid, serial},
 *   desc, share, monPassword, sharePassword, host, hostPort, upsName, user, password, minutes, percent, events [{at, kind, text}]}
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, httpError } = require('./system');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/majaos';
const NUT_DIR = process.env.NUT_DIR || '/etc/nut';
const FILE = path.join(DATA_DIR, 'ups.json');
const MAX_EVENTS = 50;
const TICK = 5000; // how often upsc is read (cheap: it asks upsd, which has the values)
const POLLFREQ = 5; // seconds between full reads of a usbhid-ups (power, load), see buildFiles

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const DRIVER = /^[a-z0-9_-]{2,32}$/;
const PORT = /^(auto|\/dev\/[A-Za-z0-9/_.:-]{1,64}|[A-Za-z0-9:._\/-]{1,64})$/;
const HEX4 = /^[0-9A-Fa-f]{4}$/;
const HOST = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\d{1,3}(\.\d{1,3}){3}$|^\[?[0-9A-Fa-f:]+\]?$/;
const USER = /^[A-Za-z0-9_.-]{1,32}$/;
// NUT reads values between double quotes: no quote, backslash, newline or #.
const SECRET = /^[^"\\\n\r#\s]{1,64}$/;
const SERIAL = /^[A-Za-z0-9 ._-]{1,64}$/;

const DEFAULTS = { mode: 'off', name: 'ups', driver: 'usbhid-ups', port: 'auto', extra: {}, desc: '', share: false, host: '', hostPort: 3493, upsName: 'ups', user: '', password: '', minutes: 0, percent: 0, events: [] };

function newSecret() {
  return crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 20);
}

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}

function save(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}

/* ------------------------------------------------------------ parsers */

// `upsc <ups>`: "battery.charge: 100" per line.
function parseUpsc(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([a-z0-9_.]+):\s?(.*)$/i);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// `upsc -l host:port`: one UPS name per line.
function parseUpsList(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter((l) => NAME.test(l));
}

// `nut-scanner -U -q`: ups.conf sections, [nutdev1] with driver = "usbhid-ups", port = "auto", vendorid = "051D", …
function parseScanner(text) {
  const devices = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\[.+\]$/.test(line)) { cur = {}; devices.push(cur); continue; }
    const m = line.match(/^([a-z_]+)\s*=\s*"?(.*?)"?$/i);
    if (m && cur) cur[m[1].toLowerCase()] = m[2];
  }
  return devices.filter((d) => d.driver).map((d) => ({
    driver: d.driver, port: d.port || 'auto', vendorid: d.vendorid || '', productid: d.productid || '',
    vendor: d.vendor || '', product: d.product || '', serial: d.serial || '', bus: d.bus || '',
  }));
}

// UPS makers on USB (vendor id) and the driver that fits most of their models. For when nut-scanner finds nothing
// (it can't always load libusb), lsusb still shows the UPS.
const USB_VENDORS = {
  '0463': ['Eaton', 'usbhid-ups'], '051d': ['APC', 'usbhid-ups'], '0764': ['CyberPower', 'usbhid-ups'],
  '09ae': ['Tripp Lite', 'usbhid-ups'], '10af': ['Liebert', 'usbhid-ups'], '06da': ['Phoenixtec', 'usbhid-ups'],
  '2e66': ['Salicru', 'usbhid-ups'], '0d9f': ['Powercom', 'usbhid-ups'], '050d': ['Belkin', 'usbhid-ups'],
  '0665': ['Cypress (generic UPS)', 'nutdrv_qx'], '0001': ['Fry\'s Electronics (generic UPS)', 'nutdrv_qx'],
  '0925': ['Richcomm', 'richcomm_usb'], '0592': ['Powerware', 'bcmxcp_usb'],
};

// `lsusb`: "Bus 001 Device 004: ID 0463:ffff MGE UPS Systems UPS". The UPSes among them: a known maker, or "UPS" in the name.
function parseLsusb(text, all = false) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^Bus (\d+) Device (\d+): ID ([0-9a-f]{4}):([0-9a-f]{4})\s*(.*)$/i);
    if (!m) continue;
    const vendorid = m[3].toLowerCase(), productid = m[4].toLowerCase(), name = m[5].trim();
    const known = USB_VENDORS[vendorid];
    if (vendorid === '1d6b') continue; // the root hubs of the USB controllers
    if (!all && !known && !/\bUPS\b/i.test(name)) continue;
    out.push({ driver: known ? known[1] : 'usbhid-ups', port: 'auto', vendorid: vendorid.toUpperCase(), productid: productid.toUpperCase(),
      vendor: known ? known[0] : '', product: name, serial: '', bus: m[1], source: 'lsusb' });
  }
  return out;
}

// The status flags of ups.status (OL, OB, LB, CHRG, DISCHRG, RB, OVER, BYPASS, FSD, CAL, OFF, TRIM, BOOST).
function readStatus(vars) {
  const flags = String(vars['ups.status'] || '').split(/\s+/).filter(Boolean);
  const num = (k) => (vars[k] != null && vars[k] !== '' && !Number.isNaN(Number(vars[k])) ? Number(vars[k]) : null);
  // Some UPSes (e.g. Eaton Ellipse ECO) keep ups.load and ups.realpower at 0 but do report the apparent power
  // of the outlets (VA): then the load comes from that and the nominal VA.
  const va = num('ups.power') || num('outlet.power') || null;
  let load = num('ups.load');
  if (!load && va && num('ups.power.nominal')) load = Math.max(1, Math.round(va / num('ups.power.nominal') * 100));
  const real = num('ups.realpower');
  // Only VA known: watts estimated with the power factor of a PC power supply with active PFC (≈ 0.9), marked as an estimate.
  const estimated = !real && !num('ups.realpower.nominal') && !!va;
  const power = real ? real
    : num('ups.realpower.nominal') != null && load != null && (load || real == null) ? Math.round(num('ups.realpower.nominal') * load / 100)
    : estimated ? Math.round(va * 0.9)
    : real === 0 ? 0 : null;
  return {
    flags,
    online: flags.includes('OL'),
    onBattery: flags.includes('OB'),
    lowBattery: flags.includes('LB'),
    charging: flags.includes('CHRG'),
    replaceBattery: flags.includes('RB'),
    overload: flags.includes('OVER'),
    forcedShutdown: flags.includes('FSD'),
    charge: num('battery.charge'),
    runtime: num('battery.runtime'), // seconds
    load, // percent
    inputVoltage: num('input.voltage'),
    outputVoltage: num('output.voltage'),
    batteryVoltage: num('battery.voltage'),
    power,
    powerEstimated: estimated, // power comes from the VA, not measured in watts
    va, // apparent power (VA)
    powerNominal: num('ups.realpower.nominal'),
    model: [vars['device.mfr'] || vars['ups.mfr'], vars['device.model'] || vars['ups.model']].filter(Boolean).join(' ').trim(),
    serial: vars['device.serial'] || vars['ups.serial'] || '',
    driver: vars['driver.name'] || '',
  };
}

/* ------------------------------------------------------------ configuration files */

const q = (v) => '"' + String(v) + '"';

// The files in /etc/nut for a configuration. Pure: the tests check them.
function buildFiles(cfg) {
  const head = '# Written by MajaOS (Settings → UPS). Changes here are overwritten.\n';
  if (cfg.mode === 'local') {
    const extra = Object.entries(cfg.extra || {}).filter(([, v]) => v).map(([k, v]) => `\t${k} = ${q(v)}\n`).join('');
    const listen = 'LISTEN 127.0.0.1 3493\nLISTEN ::1 3493\n' + (cfg.share ? 'LISTEN 0.0.0.0 3493\nLISTEN :: 3493\n' : '');
    const users = `[majaos]\n\tpassword = ${q(cfg.monPassword)}\n\tupsmon primary\n`
      + (cfg.share ? `\n[monuser]\n\tpassword = ${q(cfg.sharePassword)}\n\tupsmon secondary\n` : '');
    return {
      'nut.conf': head + `MODE=${cfg.share ? 'netserver' : 'standalone'}\n`,
      'ups.conf': head + `maxretry = 3\n\n[${cfg.name}]\n\tdriver = ${q(cfg.driver)}\n\tport = ${q(cfg.port)}\n`
        + (cfg.desc ? `\tdesc = ${q(cfg.desc)}\n` : '') + extra
        // usbhid-ups reads everything but the status only every 30 s by default: the power then lags far behind.
        + (cfg.driver === 'usbhid-ups' && !(cfg.extra && cfg.extra.pollfreq) ? `\tpollfreq = ${POLLFREQ}\n` : ''),
      'upsd.conf': head + listen,
      'upsd.users': head + users,
      'upsmon.conf': head + monitor(`${cfg.name}@localhost`, 'majaos', cfg.monPassword, 'primary'),
    };
  }
  if (cfg.mode === 'remote') {
    const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
    return {
      'nut.conf': head + 'MODE=netclient\n',
      'upsmon.conf': head + monitor(`${cfg.upsName}@${host}:${cfg.hostPort}`, cfg.user, cfg.password, 'secondary'),
    };
  }
  return { 'nut.conf': head + 'MODE=none\n' };
}

function monitor(target, user, password, role) {
  return `MONITOR ${target} 1 ${user} ${q(password)} ${role}\n`
    + 'MINSUPPLIES 1\n'
    + 'SHUTDOWNCMD "/sbin/shutdown -h +0"\n'
    + 'POLLFREQ 5\nPOLLFREQALERT 5\nHOSTSYNC 15\nDEADTIME 15\n'
    + 'POWERDOWNFLAG /etc/killpower\n'
    + 'FINALDELAY 5\n';
}

/* ------------------------------------------------------------ checks */

function intIn(v, lo, hi, msg) {
  const n = Number(v == null || v === '' ? 0 : v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw httpError(msg, 400);
  return n;
}

// Merge a request into the saved configuration and check it. Passwords that come back empty keep the saved one.
function validate(body, cur = load()) {
  const mode = body.mode;
  if (!['off', 'local', 'remote'].includes(mode)) throw httpError('Choose where the UPS is connected.', 400);
  const next = { ...cur, mode };
  next.minutes = intIn(body.minutes, 0, 240, 'Type a number of minutes between 0 and 240.');
  next.percent = intIn(body.percent, 0, 90, 'Type a battery percentage between 0 and 90.');
  if (mode === 'local') {
    next.name = String(body.name || cur.name || 'ups').trim();
    if (!NAME.test(next.name)) throw httpError('A UPS name has letters, digits, - and _ only (up to 32).', 400);
    next.driver = String(body.driver || '').trim();
    if (!DRIVER.test(next.driver)) throw httpError('Choose the driver of the UPS, for example usbhid-ups.', 400);
    next.port = String(body.port || 'auto').trim();
    if (!PORT.test(next.port)) throw httpError('The port of the UPS is not valid. Use auto for USB.', 400);
    const ex = body.extra || {};
    next.extra = {};
    for (const k of ['vendorid', 'productid']) if (ex[k]) { if (!HEX4.test(ex[k])) throw httpError('The USB id of the UPS is not valid.', 400); next.extra[k] = ex[k]; }
    if (ex.serial) { if (!SERIAL.test(ex.serial)) throw httpError('The serial number of the UPS is not valid.', 400); next.extra.serial = ex.serial; }
    next.desc = String(body.desc || '').trim().slice(0, 64).replace(/["\\#\n\r]/g, '');
    next.share = !!body.share;
    next.monPassword = cur.monPassword || newSecret();
    next.sharePassword = cur.sharePassword || newSecret();
  }
  if (mode === 'remote') {
    next.host = String(body.host || '').trim();
    if (!HOST.test(next.host)) throw httpError('Type the address of the NUT server, for example 192.168.1.20.', 400);
    next.hostPort = intIn(body.hostPort || 3493, 1, 65535, 'Type a port between 1 and 65535.');
    next.upsName = String(body.upsName || '').trim();
    if (!NAME.test(next.upsName)) throw httpError('Type the name of the UPS on that server, for example ups.', 400);
    next.user = String(body.user || '').trim();
    if (!USER.test(next.user)) throw httpError('Type the NUT user name of that server, for example monuser.', 400);
    const pw = body.password ? String(body.password) : cur.password;
    if (!pw || !SECRET.test(pw)) throw httpError('Type the NUT password of that server (no spaces or quotes).', 400);
    next.password = pw;
  }
  return next;
}

/* ------------------------------------------------------------ shutting down early */

// What to do now. state = {since (ms on battery), done}. Returns {state, shutdown: reason | null, countdown}.
function decide(now, status, cfg, state = {}) {
  const st = { since: state.since ?? null, done: !!state.done };
  if (!status || !status.onBattery) return { state: { since: null, done: false }, shutdown: null, countdown: null };
  if (st.since == null) st.since = now;
  let countdown = null;
  if (cfg.minutes > 0) {
    const at = st.since + cfg.minutes * 60000;
    countdown = at;
    if (!st.done && now >= at) { st.done = true; return { state: st, shutdown: 'minutes', countdown: at }; }
  }
  if (cfg.percent > 0 && status.charge != null && status.charge <= cfg.percent && !st.done) {
    st.done = true;
    return { state: st, shutdown: 'percent', countdown };
  }
  return { state: st, shutdown: null, countdown };
}

/* ------------------------------------------------------------ the server */

function target(cfg) {
  if (cfg.mode === 'local') return `${cfg.name}@localhost`;
  if (cfg.mode === 'remote') return `${cfg.upsName}@${cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host}:${cfg.hostPort}`;
  return null;
}

async function installed() {
  try { await run('upsc', ['-V'], { timeout: 5000, anyExit: true }); return true; } catch (e) { return e.status !== 503; }
}

async function writeFiles(cfg) {
  const files = buildFiles(cfg);
  fs.mkdirSync(NUT_DIR, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(NUT_DIR, name);
    if (fs.existsSync(file) && !fs.existsSync(file + '.before-majaos')) fs.copyFileSync(file, file + '.before-majaos');
    // Passwords: only root and the nut group may read them.
    const secret = name === 'upsd.users' || name === 'upsmon.conf';
    fs.writeFileSync(file + '.tmp', text, { mode: secret ? 0o640 : 0o644 });
    fs.renameSync(file + '.tmp', file);
    if (secret) await run('chown', ['root:nut', file], { timeout: 5000 }).catch(() => {});
  }
}

const sys = (args) => run('systemctl', args, { timeout: 60000 });

async function applyServices(cfg) {
  if (cfg.mode === 'local') {
    // A UPS plugged in before NUT was installed: the udev rules of NUT (access for the nut user) only apply on a new event.
    await run('udevadm', ['trigger', '--subsystem-match=usb', '--action=change'], { timeout: 15000 }).catch(() => {});
    await run('udevadm', ['settle', '--timeout=5'], { timeout: 10000 }).catch(() => {});
    // nut-driver-enumerator makes a nut-driver@<name> unit for each section in ups.conf.
    await sys(['enable', 'nut-driver-enumerator.service', 'nut-server.service', 'nut-monitor.service']).catch(() => {});
    await sys(['restart', 'nut-driver-enumerator.service']).catch(() => {});
    await sys(['restart', 'nut-driver.target']).catch(() => {});
    await sys(['restart', 'nut-server.service']);
    await sys(['restart', 'nut-monitor.service']);
  } else if (cfg.mode === 'remote') {
    await sys(['disable', '--now', 'nut-server.service', 'nut-driver.target']).catch(() => {});
    await sys(['enable', 'nut-monitor.service']).catch(() => {});
    await sys(['restart', 'nut-monitor.service']);
  } else {
    await sys(['disable', '--now', 'nut-monitor.service', 'nut-server.service', 'nut-driver.target', 'nut-driver-enumerator.service']).catch(() => {});
  }
}

let live = { vars: null, status: null, error: '', at: 0, state: {}, countdown: null };

async function readNow(cfg = load()) {
  const t = target(cfg);
  if (!t) { live = { ...live, vars: null, status: null, error: '', at: Date.now() }; return live; }
  try {
    const vars = parseUpsc(await run('upsc', [t], { timeout: 8000 }));
    live = { ...live, vars, status: readStatus(vars), error: '', at: Date.now() };
  } catch (e) {
    live = { ...live, vars: null, status: null, error: e.message, at: Date.now() };
  }
  return live;
}

function addEvent(cfg, kind, text) {
  cfg.events = [{ at: Date.now(), kind, text }, ...(cfg.events || [])].slice(0, MAX_EVENTS);
  save(cfg);
}

// upsd stopped on this server ("Connection refused"), e.g. after NUT rebuilt its driver units for a changed ups.conf:
// start the NUT services again, at most every 5 minutes. A UPS that is simply unplugged gives another error.
let healedAt = 0;
async function heal(cfg, error) {
  if (cfg.mode !== 'local' || !/Connection refused/i.test(error || '') || Date.now() - healedAt < 5 * 60000) return;
  healedAt = Date.now();
  addEvent(cfg, 'config', 'The UPS service had stopped. MajaOS started it again.');
  await sys(['restart', 'nut-driver.target']).catch(() => {});
  await sys(['restart', 'nut-server.service']).catch(() => {});
  await sys(['restart', 'nut-monitor.service']).catch(() => {});
}

let last = null; // the previous status, to log changes
async function tick() {
  const cfg = load();
  if (cfg.mode === 'off') { last = null; live.state = {}; live.countdown = null; return; }
  const prev = last;
  const { status, error } = await readNow(cfg);
  if (!status) {
    if (prev && prev.ok) addEvent(cfg, 'lost', error ? 'The UPS does not answer: ' + error : 'The UPS does not answer.');
    last = { ok: false };
    await heal(cfg, error);
    return;
  }
  if (!prev || !prev.ok) { if (prev && !prev.ok) addEvent(cfg, 'back', 'The UPS answers again.'); }
  else {
    if (status.onBattery && !prev.onBattery) addEvent(cfg, 'battery', status.charge != null ? `On battery (${status.charge}%).` : 'On battery.');
    if (!status.onBattery && prev.onBattery) addEvent(cfg, 'power', 'The power is back.');
    if (status.lowBattery && !prev.lowBattery) addEvent(cfg, 'low', 'The battery is almost empty. NUT shuts the server down.');
    if (status.replaceBattery && !prev.replaceBattery) addEvent(cfg, 'replace', 'The UPS asks to replace its battery.');
  }
  last = { ok: true, onBattery: status.onBattery, lowBattery: status.lowBattery, replaceBattery: status.replaceBattery };
  const d = decide(Date.now(), status, cfg, live.state);
  live.state = d.state; live.countdown = d.countdown;
  if (d.shutdown) {
    addEvent(cfg, 'shutdown', d.shutdown === 'minutes'
      ? `${cfg.minutes} minutes on battery: the server shuts down.`
      : `The battery is at ${status.charge}%: the server shuts down.`);
    // As primary: forced shutdown, so the secondaries shut down too and the UPS switches off at the end.
    if (cfg.mode === 'local') await run('upsmon', ['-c', 'fsd'], { timeout: 15000 }).catch(() => run('systemctl', ['poweroff'], { timeout: 15000 }));
    else await run('systemctl', ['poweroff'], { timeout: 15000 });
  }
}

let timer = null;
function startSchedule() {
  if (timer) return;
  timer = setInterval(() => tick().catch((e) => console.error('UPS: ' + e.message)), TICK);
  tick().catch(() => {});
  upgradeUpsConf().catch((e) => console.error('UPS: ' + e.message));
}
// A ups.conf MajaOS wrote before pollfreq existed: write it again and restart the driver once, so the power is live.
async function upgradeUpsConf() {
  const cfg = load();
  if (cfg.mode !== 'local' || cfg.driver !== 'usbhid-ups') return;
  const file = path.join(NUT_DIR, 'ups.conf');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  if (!text.startsWith('# Written by MajaOS') || /^\s*pollfreq\s*=/m.test(text)) return;
  fs.writeFileSync(file + '.tmp', buildFiles(cfg)['ups.conf'], { mode: 0o644 });
  fs.renameSync(file + '.tmp', file);
  // Like applyServices: NUT rebuilds its driver units for a changed ups.conf, upsd and upsmon start again after it.
  await sys(['restart', 'nut-driver-enumerator.service']).catch(() => {});
  await sys(['restart', 'nut-driver.target']).catch(() => {});
  await sys(['restart', 'nut-server.service']).catch(() => {});
  await sys(['restart', 'nut-monitor.service']).catch(() => {});
  console.log('UPS: the driver now reads the power every ' + POLLFREQ + ' s.');
}

// For the header (/api/overview): the last reading of the 10-second tick, without calling upsc again.
function brief() {
  const cfg = load();
  if (cfg.mode === 'off' || !live.status) return null;
  const s = live.status;
  const last = (cfg.events || [])[0] || null;
  return {
    charge: s.charge, runtime: s.runtime, online: s.online, onBattery: s.onBattery, lowBattery: s.lowBattery, countdown: live.countdown,
    // For the tooltip in the header.
    charging: s.charging, replaceBattery: s.replaceBattery, load: s.load, power: s.power, powerEstimated: s.powerEstimated, va: s.va, inputVoltage: s.inputVoltage, model: s.model,
    mfr: (live.vars && (live.vars['device.mfr'] || live.vars['ups.mfr'])) || '', name: (live.vars && (live.vars['device.model'] || live.vars['ups.model'])) || '',
    mode: cfg.mode, host: cfg.mode === 'remote' ? cfg.host : '', last: last ? { at: last.at, text: last.text } : null,
  };
}

async function status() {
  const cfg = load();
  const isInstalled = await installed();
  if (cfg.mode !== 'off' && (!live.at || Date.now() - live.at > TICK)) await readNow(cfg);
  return {
    installed: isInstalled,
    mode: cfg.mode,
    config: {
      name: cfg.name, driver: cfg.driver, port: cfg.port, extra: cfg.extra || {}, desc: cfg.desc, share: !!cfg.share,
      host: cfg.host, hostPort: cfg.hostPort, upsName: cfg.upsName, user: cfg.user, hasPassword: !!cfg.password,
      minutes: cfg.minutes, percent: cfg.percent,
    },
    // For other devices on the network (Home Assistant, a NAS): only when sharing is on.
    share: cfg.mode === 'local' && cfg.share ? { port: 3493, upsName: cfg.name, user: 'monuser', password: cfg.sharePassword } : null,
    status: cfg.mode === 'off' ? null : live.status,
    vars: cfg.mode === 'off' ? null : live.vars,
    error: cfg.mode === 'off' ? '' : live.error,
    countdown: live.countdown,
    events: cfg.events || [],
  };
}

async function apply(body) {
  if (!(await installed())) throw httpError('NUT is not installed on the server. Update MajaOS, or run the installer again.', 503);
  const next = validate(body || {});
  const before = load();
  await writeFiles(next);
  try { await applyServices(next); }
  catch (e) {
    throw httpError('NUT did not start: ' + e.message + ' Check that the UPS is connected and the driver is right.', 502);
  } finally {
    save({ ...next, events: before.events || [] });
    last = null; live = { vars: null, status: null, error: '', at: 0, state: {}, countdown: null };
  }
  if (before.mode !== next.mode) addEvent(load(), 'config', next.mode === 'off' ? 'UPS monitoring is off.' : next.mode === 'local' ? 'UPS on this server.' : 'UPS on another NUT server.');
  await new Promise((r) => setTimeout(r, next.mode === 'local' ? 3000 : 1000));
  await readNow(load());
  return status();
}

// UPSes on USB (nut-scanner), or the UPS names on another NUT server.
async function scan(body = {}) {
  if (body.host) {
    const host = String(body.host).trim();
    if (!HOST.test(host)) throw httpError('Type the address of the NUT server, for example 192.168.1.20.', 400);
    const port = intIn(body.hostPort || 3493, 1, 65535, 'Type a port between 1 and 65535.');
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const names = parseUpsList(await run('upsc', ['-l', `${h}:${port}`], { timeout: 10000 }));
    return { names };
  }
  // nut-scanner first (it knows the driver and the serial number), then lsusb for what it missed.
  let devices = [], note = '';
  try {
    const r = await run('nut-scanner', ['-U', '-q'], { timeout: 30000, full: true });
    devices = parseScanner(r.stdout);
    // Only what is about USB: the SNMP, XML and IPMI libraries are for UPSes on the network, not needed here.
    if (!devices.length) note = String(r.stderr || '').split('\n').map((l) => l.trim())
      .filter((l) => l && !/^Cannot load (SNMP|XML|IPMI|Avahi|NUT)\b/i.test(l)).slice(0, 4).join(' ');
  } catch (e) { note = e.message; }
  let lsusb = '';
  try { lsusb = await run('lsusb', [], { timeout: 10000 }); } catch { /* usbutils missing */ }
  const seen = new Set(devices.map((d) => (d.vendorid + ':' + d.productid).toLowerCase()));
  for (const u of parseLsusb(lsusb)) if (!seen.has((u.vendorid + ':' + u.productid).toLowerCase())) devices.push(u);
  // Nothing found: every USB device the server sees, so a UPS with an unknown id can still be chosen,
  // and an empty list says the UPS isn't on this server's USB at all (in a VM: pass it through first).
  const others = devices.length ? [] : parseLsusb(lsusb, true);
  return { devices, others, note };
}

module.exports = { parseUpsc, parseUpsList, parseScanner, parseLsusb, readStatus, buildFiles, validate, decide, status, brief, apply, scan, startSchedule };
