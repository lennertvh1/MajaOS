'use strict';
/*
 * Appstore: de catalogus van Unraid Community Apps (applicationFeed.json), omgezet naar Docker Compose.
 * De templates zijn voor Unraid gemaakt. Daarom vertalen we Unraid-paden (/mnt/user/...), de Unraid-gebruiker
 * (99:100) en netwerken, en waarschuwen we voor wat we niet kunnen overnemen.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, runStream, httpError, readText } = require('./system');
const docker = require('./docker');
const dockernet = require('./dockernet');
const registry = require('./registry');
const { toYaml } = require('./yaml');
const composeForm = require('./composeform');

const FEED_URL = process.env.STORE_FEED_URL || 'https://raw.githubusercontent.com/Squidly271/AppFeed/master/applicationFeed.json';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/homebaseos';
const CACHE_FILE = path.join(DATA_DIR, 'appstore.json');
const paths = require('./paths');
// Appgegevens en de basis voor Unraid-shares: ingesteld bij Instellingen → Opslag (of automatisch bij een nieuwe pool).
const APPDATA_DIR = () => paths.shown('appdata');
const SHARES_DIR = () => paths.shown('shares');
// Ontbreekt de map voor appgegevens, dan eerst opnieuw zoeken (bv. een map die er pas sinds kort is).
const ensureAppdata = () => (paths.exists('appdata') ? null : paths.detect().catch(() => {}));
const APPDATA_MISSING = () => `Er is nog geen map voor appgegevens (${APPDATA_DIR()}). Maak eerst een pool aan bij Opslag, of kies een map bij Instellingen → Opslag.`;
const STACKS_DIR = path.resolve(process.env.STACKS_DIR || '/opt/stacks');
const APP_UID = String(process.env.APP_UID || '1000');
const APP_GID = String(process.env.APP_GID || '1000');
const MAX_AGE = 24 * 3600 * 1000;

const CATS = {
  AI: 'AI', Backup: 'Back-up', Cloud: 'Cloud', Crypto: 'Crypto', Downloaders: 'Downloaders', GameServers: 'Gameservers',
  HomeAutomation: 'Domotica', MediaApp: 'Media-apps', MediaServer: 'Mediaservers', Network: 'Netwerk',
  Productivity: 'Productiviteit', Security: 'Beveiliging', Tools: 'Hulpmiddelen', Other: 'Overige',
};
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
// Bekende thuisapps: die staan bovenaan als "Aanbevolen" (genormaliseerde templatenaam).
const FEATURED = new Set(('jellyfin plex plexmediaserver immich nextcloud vaultwarden homeassistant homeassistantcontainer paperlessngx ' +
  'sonarr radarr prowlarr lidarr bazarr jellyseerr overseerr adguardhome pihole nginxproxymanager uptimekuma syncthing frigate ' +
  'mealie audiobookshelf homepage ollama openwebui tailscale duplicati qbittorrent photoprism navidrome gitea grafana mosquitto ' +
  'zigbee2mqtt nodered esphome wgeasy portainer kavita calibreweb freshrss stirlingpdf actualbudget dockge mariadb postgresql17').split(' '));
const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/* ---------------------------------------------------------------- catalogus */

// Beschrijvingen bevatten BBCode zoals [br] en [b]. [IP] en [PORT:80] laten we staan.
function cleanText(s) {
  return String(s || '').replace(/\r/g, '')
    .replace(/\[br\s*\/?\]|\[\/br\]/gi, '\n')
    .replace(/\[\/?(b|i|u|s|span|center|color|size|font|url|h\d)(?:[=\s][^\]]*)?\]/gi, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normConfig(list) {
  return [].concat(list || []).map((c, i) => {
    const a = c['@attributes'] || {};
    const type = a.Type === 'Textarea' ? 'Variable' : a.Type;
    const def = a.Default == null ? '' : String(a.Default);
    const options = /\|/.test(def) && type === 'Variable' ? def.split('|') : null;
    const raw = c.value != null && String(c.value) !== '' ? String(c.value) : options ? options[0] : def;
    return {
      key: 'c' + i, type, name: String(a.Name || a.Target || '').trim(), target: String(a.Target || '').trim(), value: raw,
      mode: String(a.Mode || '').trim(), description: cleanText(a.Description).slice(0, 600),
      required: a.Required === 'true', mask: a.Mask === 'true', advanced: !/^always/.test(a.Display || 'always'), options,
    };
  }).filter((c) => ['Variable', 'Path', 'Port', 'Device', 'Label'].includes(c.type));
}

function topCategories(list) {
  const out = new Set();
  [].concat(list || []).forEach((c) => { const t = String(c).split(/[-:]/)[0]; out.add(CATS[t] ? t : 'Other'); });
  return out.size ? [...out] : ['Other'];
}

const imageBase = (img) => String(img).replace(/@.*$/, '').replace(/:[^/:]+$/, '').replace(/^(docker\.io\/|registry\.hub\.docker\.com\/)/, '').replace(/^library\//, '').toLowerCase();

function normalizeFeed(feed) {
  const apps = (feed.applist || []).filter((x) => !x.Plugin && !x.Deprecated && !x.Blacklist && x.Repository && x.Name && x.TemplatePath)
    .filter((x) => !([].concat(x.CategoryList || []).every((c) => /^Drivers/.test(c)) && x.CategoryList && x.CategoryList.length))
    .map((x) => {
      const overview = cleanText(x.Overview || x.Description);
      return {
        id: crypto.createHash('sha1').update(x.TemplatePath).digest('hex').slice(0, 12),
        name: String(x.Name).trim(), image: String(x.Repository).trim(), icon: /^https?:\/\//.test(x.Icon || '') ? x.Icon : null,
        overview, summary: overview.replace(/\s+/g, ' ').slice(0, 220),
        categories: topCategories(x.CategoryList), maintainer: String(x.Repo || x.Maintainer || x.Author || '').replace(/'s Repository$/i, '').trim(),
        downloads: Number(x.downloads) || 0, official: !!x.Official, beta: x.Beta === 'true' || x.Beta === true,
        project: x.Project || null, support: x.Support || null, requires: cleanText(x.Requires) || null,
        webui: x.WebUI || null, network: x.Network || 'bridge', privileged: x.Privileged === 'true',
        extraParams: String(x.ExtraParams || '').trim(), postArgs: String(x.PostArgs || '').trim(),
        templateUrl: x.TemplateURL || null, config: normConfig(x.Config),
      };
    });
  // Populariteit: downloads zijn pulls per image. Tel per image maar één template mee (liefst het officiële).
  const best = new Map();
  apps.forEach((a) => {
    const k = imageBase(a.image), cur = best.get(k);
    if (!cur || (a.official && !cur.official) || (a.official === cur.official && a.name.toLowerCase() === k.split('/').pop() && cur.name.toLowerCase() !== k.split('/').pop())) best.set(k, a);
  });
  apps.forEach((a) => {
    const leader = best.get(imageBase(a.image)) === a;
    const n = normName(a.name), img = normName(imageBase(a.image).split('/').pop());
    // Alleen meetellen als de naam bij het image past: "EasyPXE-Nginx" erft anders alle pulls van nginx.
    a.popularity = leader && (n.startsWith(img) || img.startsWith(n)) ? a.downloads : 0;
    a.featured = leader && FEATURED.has(n);
  });
  return { updated: feed.last_updated_timestamp ? feed.last_updated_timestamp * 1000 : Date.now(), apps };
}

let cache = null; // { updated, fetched, apps, byId, error }
function indexCache(c) { c.byId = new Map(c.apps.map((a) => [a.id, a])); return c; }

async function loadCatalog(force) {
  if (!cache) { try { cache = indexCache(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); } catch { /* nog geen cache */ } }
  if (cache && !force && Date.now() - cache.fetched < MAX_AGE) return cache;
  try {
    const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const c = { ...normalizeFeed(await res.json()), fetched: Date.now() };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE + '.tmp', JSON.stringify(c));
    fs.renameSync(CACHE_FILE + '.tmp', CACHE_FILE);
    cache = indexCache(c);
    return cache;
  } catch (e) {
    if (cache) { cache.error = e.message; return cache; } // oude catalogus is beter dan niets
    throw httpError('De appcatalogus kon niet geladen worden (' + e.message + '). Heeft de server internet?', 502);
  }
}

async function installedInfo() {
  try {
    const apps = await docker.listApps();
    return { names: new Set(apps.map((a) => a.name.toLowerCase())), images: new Set(apps.map((a) => imageBase(a.image))),
      storeIds: new Set(apps.map((a) => a.storeId).filter(Boolean)), ports: apps.flatMap((a) => a.ports.map((p) => ({ port: p.public, type: p.type, app: a.name }))) };
  } catch { return { names: new Set(), images: new Set(), storeIds: new Set(), ports: [] }; }
}

async function catalog(force) {
  const [c, inst] = await Promise.all([loadCatalog(force), installedInfo()]);
  const used = new Set(c.apps.flatMap((a) => a.categories));
  return {
    updated: c.updated, fetched: c.fetched, error: c.error || null, source: 'Unraid Community Apps', count: c.apps.length,
    categories: Object.entries(CATS).filter(([k]) => used.has(k)).map(([id, name]) => ({ id, name })),
    apps: c.apps.map((a) => ({
      id: a.id, name: a.name, image: a.image, icon: a.icon, summary: a.summary, categories: a.categories, maintainer: a.maintainer,
      popularity: a.popularity, featured: a.featured, official: a.official, beta: a.beta,
      installed: inst.storeIds.has(a.id) || inst.images.has(imageBase(a.image)),
    })),
  };
}

/* ---------------------------------------------------------------- pictogrammen voor je eigen apps */

// Apps zonder label homebaseos.icon: eerst het pictogram uit de catalogus (zelfde image),
// anders de open verzameling dashboard-icons op naam. Die laatste controleren we één keer en onthouden we.
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/';
const ICON_FILE = path.join(DATA_DIR, 'icons.json');
let iconIdx = null, iconIdxOf = null, checked = null;
const probing = new Set();

function catalogIcons() {
  if (!cache) { try { cache = indexCache(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); } catch { return new Map(); } }
  if (iconIdxOf !== cache) {
    iconIdx = new Map();
    // Het populairste template per image eerst, zodat dat pictogram wint.
    cache.apps.filter((a) => a.icon).sort((a, b) => b.popularity - a.popularity)
      .forEach((a) => { const k = imageBase(a.image); if (!iconIdx.has(k)) iconIdx.set(k, a.icon); });
    iconIdxOf = cache;
  }
  return iconIdx;
}

async function probeIcon(key) {
  if (probing.has(key)) return;
  probing.add(key);
  try {
    const res = await fetch(ICON_CDN + key + '.png', { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    checked[key] = res.ok ? ICON_CDN + key + '.png' : null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ICON_FILE, JSON.stringify(checked));
  } catch { /* geen internet: later opnieuw proberen */ } finally { probing.delete(key); }
}

function iconFor(image, name) {
  const fromCatalog = catalogIcons().get(imageBase(image));
  if (fromCatalog) return fromCatalog;
  if (!checked) { try { checked = JSON.parse(fs.readFileSync(ICON_FILE, 'utf8')); } catch { checked = {}; } }
  const keys = [...new Set([name, imageBase(image).split('/').pop()].map((s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean))];
  const hit = keys.find((k) => checked[k]);
  if (hit) return checked[hit];
  keys.filter((k) => !(k in checked)).forEach((k) => probeIcon(k)); // op de achtergrond; de volgende keer is het er
  return null;
}

/* ---------------------------------------------------------------- vertalen naar deze server */

const PATH_MAP = () => [['/mnt/user/appdata', APPDATA_DIR()], ['/mnt/cache/appdata', APPDATA_DIR()], ['/mnt/user', SHARES_DIR()], ['/mnt/cache', SHARES_DIR()]];
function mapHostPath(p) {
  const v = String(p || '').trim();
  for (const [from, to] of PATH_MAP()) if (v === from || v.startsWith(from + '/')) return to + v.slice(from.length);
  if (/^\/mnt\/(disk\d+|user0)(\/|$)/.test(v)) return v.replace(/^\/mnt\/(disk\d+|user0)/, SHARES_DIR());
  return v;
}
const UNRAID_ONLY = /^\/(usr\/local\/emhttp|boot|var\/local\/emhttp|usr\/local\/sbin)(\/|$)/;

const { hostTimezone } = require('./datetime');

function slugify(name) { return String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 63) || 'app'; }

// Vul de velden in voor deze server: paden, gebruiker, tijdzone.
// Een leeg appdata-pad (zoals /config bij linuxserver) vult Community Apps op Unraid zelf in; wij ook.
// Zulke velden krijgen auto: true, zodat het formulier ze meeneemt als je de naam wijzigt.
function prepareFields(config, slug = 'app', tz = hostTimezone()) {
  return config.map((c) => {
    let value = c.value, auto = false;
    if (c.type === 'Path') value = mapHostPath(value);
    if (c.type === 'Path' && !value && (/^\/config$/i.test(c.target) || /\b(app ?data|config)\b/i.test(c.name))) {
      value = path.join(APPDATA_DIR(), slug); auto = true;
    }
    if (c.type === 'Variable') {
      if (c.target === 'PUID' && value === '99') value = APP_UID;
      if (c.target === 'PGID' && value === '100') value = APP_GID;
      if (c.target === 'TZ') value = tz;
    }
    if (c.type === 'Device' && /^\/dev\/?$/.test(value)) value = '';
    return { ...c, value, auto };
  });
}

// Shell-achtig splitsen met aanhalingstekens, zonder ooit een shell te gebruiken.
function shellSplit(s) {
  const out = []; let cur = '', quote = null, any = false;
  for (const ch of String(s || '')) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

function parseExtraParams(str) {
  const t = shellSplit(str);
  const o = { capAdd: [], capDrop: [], devices: [], env: {}, hosts: [], sysctls: [], securityOpt: [], tmpfs: [], labels: {}, ulimits: [], unknown: [] };
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
    const flag = eq > 0 ? tok.slice(0, eq) : tok;
    const inline = eq > 0 ? tok.slice(eq + 1) : undefined;
    const take = () => (inline !== undefined ? inline : t[++i] || '');
    const kv = (s) => { const j = s.indexOf('='); return j > 0 ? [s.slice(0, j), s.slice(j + 1)] : [s, '']; };
    switch (flag) {
      case '--restart': o.restart = take(); break;
      case '--shm-size': o.shm = take(); break;
      case '--runtime': if (take() === 'nvidia') o.gpu = true; break;
      case '--gpus': take(); o.gpu = true; break;
      case '--cap-add': o.capAdd.push(take()); break;
      case '--cap-drop': o.capDrop.push(take()); break;
      case '--init': o.init = true; break;
      case '--privileged': o.privileged = true; break;
      case '-u': case '--user': o.user = take(); break;
      case '--device': o.devices.push(take()); break;
      case '-e': case '--env': { const [k, v] = kv(take()); if (k) o.env[k] = v; break; }
      case '-l': case '--label': { const [k, v] = kv(take()); if (k) o.labels[k] = v; break; }
      case '--add-host': o.hosts.push(take()); break;
      case '--sysctl': o.sysctls.push(take()); break;
      case '--security-opt': o.securityOpt.push(take()); break;
      case '--tmpfs': o.tmpfs.push(take()); break;
      case '--ulimit': o.ulimits.push(take()); break;
      case '-h': case '--hostname': o.hostname = take(); break;
      case '-m': case '--memory': o.memLimit = take(); break;
      case '--cpus': o.cpus = take(); break;
      case '--pid': o.pid = take(); break;
      case '--ipc': o.ipc = take(); break;
      case '--network': case '--net': o.network = take(); break;
      case '--entrypoint': o.entrypoint = take(); break;
      case '--stop-timeout': o.stopTimeout = take(); break;
      case '--log-opt': case '--log-driver': case '--name': take(); break; // Docker-standaard of al geregeld
      default: o.unknown.push(tok);
    }
  }
  return o;
}

const isPort = (v) => /^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 65535;
const appdataRoot = (p) => { const r = path.resolve(p), a = APPDATA_DIR(); return r.startsWith(a + path.sep) ? path.join(a, r.slice(a.length + 1).split(path.sep)[0]) : null; };

// Bouw het compose-bestand. Geeft ook de waarschuwingen en de mappen met appgegevens terug.
// Het netwerk uit het template: host, none, bridge of de naam van een eigen netwerk (bv. br0 in Unraid).
function templateNetwork(app) {
  const n = String(parseExtraParams(app.extraParams).network || app.network || 'bridge');
  return /^(undefined|bridge|)$/i.test(n) ? 'bridge' : /^(host|none)$/i.test(n) ? n.toLowerCase() : n;
}

// network: wat de gebruiker koos (zie dockernet.resolveNetwork). Zonder keuze: wat het template zegt, of het standaardnetwerk.
function buildCompose(app, slug, fields, { tz = hostTimezone(), network = null, extraPorts = [] } = {}) {
  const warnings = [];
  const extra = parseExtraParams(app.extraParams);
  const tpl = templateNetwork(app);
  const chosen = network || { mode: tpl === 'host' || tpl === 'none' ? tpl : 'bridge', name: null, ownIp: false };
  const host = chosen.mode === 'host', none = chosen.mode === 'none', ownIp = chosen.mode === 'custom' && chosen.ownIp;
  if (!network && !['bridge', 'host', 'none'].includes(tpl)) warnings.push(`Het template gebruikt het netwerk "${tpl}". Kies hieronder een netwerk, of maak het aan bij Instellingen → Docker-netwerken.`);
  const svc = { image: app.image, container_name: slug, restart: extra.restart || 'unless-stopped' };
  if (host) svc.network_mode = 'host';
  if (none) svc.network_mode = 'none';
  if (chosen.mode === 'custom') svc.networks = { [chosen.name]: chosen.ip ? { ipv4_address: chosen.ip } : null };
  if (app.privileged || extra.privileged) svc.privileged = true;

  const ports = [], volumes = [], devices = [], environment = {}, labels = {}, data = new Set();
  for (const f of fields) {
    const v = String(f.value == null ? '' : f.value).trim();
    if (f.type === 'Port') {
      if (!v || host || none || ownIp || !f.target) continue; // met een eigen adres is de app rechtstreeks bereikbaar
      const proto = /udp/i.test(f.mode) && !/tcp/i.test(f.mode) ? 'udp' : 'tcp';
      ports.push(`${v}:${f.target.replace(/\/(tcp|udp)$/i, '')}/${proto}`);
      if (/tcp/i.test(f.mode) && /udp/i.test(f.mode)) ports.push(`${v}:${f.target}/udp`);
    } else if (f.type === 'Path') {
      if (!v || !f.target) continue;
      if (UNRAID_ONLY.test(v)) { warnings.push(`De Unraid-map ${v} bestaat hier niet en is weggelaten.`); continue; }
      const ro = /^ro\b|^r$/.test(f.mode);
      if (/slave|shared/.test(f.mode)) warnings.push(`De koppeling ${v} gebruikt "${f.mode}". HomeBaseOS koppelt hem gewoon${ro ? ' als alleen-lezen' : ''}.`);
      volumes.push(`${v}:${f.target}${ro ? ':ro' : ''}`);
      const root = appdataRoot(v); if (root) data.add(root);
    } else if (f.type === 'Device') {
      if (!v || /^\/dev\/?$/.test(v)) continue;
      devices.push(`${v}:${f.target || v}`);
    } else if (f.type === 'Variable') {
      if (!f.target || (v === '' && !f.required)) continue;
      environment[f.target] = v;
    } else if (f.type === 'Label') {
      if (f.target) labels[f.target] = v;
    }
  }
  // Poorten die je zelf toevoegde (niet in het template).
  if (!host && !none && !ownIp) extraPorts.forEach((p) => ports.push(`${p.host}:${p.container}/${p.protocol}`));
  if (!('TZ' in environment)) environment.TZ = tz;
  Object.assign(environment, extra.env);
  if (extra.user) svc.user = extra.user.replace(/^99:100$/, `${APP_UID}:${APP_GID}`);
  if (ports.length) svc.ports = ports;
  if (volumes.length) svc.volumes = volumes;
  devices.push(...extra.devices.map((d) => (d.includes(':') ? d : `${d}:${d}`)));
  if (devices.length) svc.devices = devices;
  svc.environment = environment;
  if (extra.shm) svc.shm_size = extra.shm;
  if (extra.init) svc.init = true;
  if (extra.capAdd.length) svc.cap_add = extra.capAdd;
  if (extra.capDrop.length) svc.cap_drop = extra.capDrop;
  if (extra.hosts.length) svc.extra_hosts = extra.hosts;
  if (extra.sysctls.length) svc.sysctls = extra.sysctls;
  if (extra.securityOpt.length) svc.security_opt = extra.securityOpt;
  if (extra.tmpfs.length) svc.tmpfs = extra.tmpfs;
  if (extra.hostname && !host) svc.hostname = extra.hostname;
  if (extra.memLimit) svc.mem_limit = extra.memLimit;
  if (extra.cpus) svc.cpus = Number(extra.cpus) || extra.cpus;
  if (extra.pid) svc.pid = extra.pid;
  if (extra.ipc) svc.ipc = extra.ipc;
  if (extra.entrypoint) svc.entrypoint = extra.entrypoint;
  if (extra.stopTimeout) svc.stop_grace_period = extra.stopTimeout + 's';
  if (extra.ulimits.length) warnings.push('De ulimit-instellingen (' + extra.ulimits.join(', ') + ') zijn niet overgenomen.');
  if (extra.gpu) {
    svc.deploy = { resources: { reservations: { devices: [{ driver: 'nvidia', count: 'all', capabilities: ['gpu'] }] } } };
    warnings.push('Deze app gebruikt de NVIDIA-GPU. Daarvoor moet install.sh met --nvidia uitgevoerd zijn.');
  }
  if (extra.unknown.length) warnings.push('Deze extra Docker-opties neemt HomeBaseOS niet over: ' + extra.unknown.join(' '));
  const cmd = shellSplit(app.postArgs);
  if (cmd.length) svc.command = cmd;
  Object.assign(labels, extra.labels, {
    'homebaseos.store': app.id,
    'homebaseos.data': [...data].join(','),
  });
  if (app.icon) labels['homebaseos.icon'] = app.icon;
  if (app.webui) labels['homebaseos.webui'] = app.webui;
  svc.labels = labels;

  if (svc.privileged) warnings.push('Deze app draait privileged: hij krijgt bijna volledige toegang tot je server.');
  if (volumes.some((v) => v.startsWith('/var/run/docker.sock:'))) warnings.push('Deze app krijgt toegang tot Docker en kan dus al je containers beheren.');
  if (host) warnings.push('Deze app gebruikt het netwerk van de server (host) en luistert dan op zijn eigen poorten. Wil je zelf poorten kiezen, pas dan een poort aan of kies het standaardnetwerk (bridge). Sommige apps (zoals Home Assistant en Plex) werken het best met host, omdat ze toestellen in je netwerk zoeken.');
  if (ownIp) warnings.push('Deze app krijgt een eigen adres in je thuisnetwerk. De poorten zijn dan die van de app zelf; de server zelf kan de app via dit adres niet bereiken.');

  const header = `# Gemaakt door HomeBaseOS uit het Community Apps-template "${app.name}"` +
    (app.maintainer ? ` van ${app.maintainer}` : '') + (app.templateUrl ? `\n# Bron: ${app.templateUrl}` : '') + '\n';
  const project = { name: slug, services: { [slug]: svc } };
  if (chosen.mode === 'custom') project.networks = { [chosen.name]: { external: true } };
  const text = header + toYaml(project) + '\n';
  return { text, warnings, data: [...data] };
}

/* ---------------------------------------------------------------- details, installeren, verwijderen */

async function getApp(id) {
  const c = await loadCatalog();
  const app = c.byId.get(id);
  if (!app) throw httpError('Deze app staat niet (meer) in de catalogus. Vernieuw de appstore.', 404);
  return app;
}

// Mappen om uit te kiezen voor de gegevens van een app: de koppelpunten van je datasets.
const folderList = () => paths.datasets().then((l) => l.map((d) => d.mountpoint).sort(), () => []);

async function details(id) {
  await ensureAppdata();
  const [app, inst] = await Promise.all([getApp(id), installedInfo()]);
  let name = slugify(app.name);
  for (let n = 2; inst.names.has(name) || fs.existsSync(path.join(STACKS_DIR, name)); n++) name = slugify(app.name) + '-' + n;
  const fields = prepareFields(app.config, name);
  // Eigen Docker-netwerken om uit te kiezen. Bestaat het netwerk uit het template (bv. br0), dan staat dat al gekozen.
  const networks = await dockernet.listNetworks().then((r) => r.networks.filter((n) => !n.builtin)
    .map((n) => ({ name: n.name, driver: n.driver, subnet: n.subnet, gateway: n.gateway, ipRange: n.ipRange })), () => []);
  const tpl = templateNetwork(app);
  const networkDefault = ['bridge', 'host', 'none'].includes(tpl) || networks.some((n) => n.name === tpl) ? tpl : 'bridge';
  const def = networks.find((n) => n.name === networkDefault);
  const { warnings } = buildCompose(app, name, fields, def ? { network: { mode: 'custom', name: def.name, ownIp: /^(macvlan|ipvlan)$/.test(def.driver) } } : {});
  const { config, ...rest } = app;
  return {
    ...rest, fields, warnings, networks, networkDefault, templateNetwork: tpl, suggestedName: name, appdataDir: APPDATA_DIR(), sharesDir: SHARES_DIR(), stacksDir: STACKS_DIR,
    installed: inst.storeIds.has(app.id) || inst.images.has(imageBase(app.image)),
    appdataMissing: !paths.exists('appdata'), folders: await folderList(),
  };
}

const jobs = new Map(); // id → { lines, done, ok, error, name, webui, started }
// Uitvoer van `docker compose --progress plain`: elke laag, container of netwerk krijgt één regel die ter plaatse
// bijgewerkt wordt, zoals `docker pull` het in een terminal toont. Uit de lagen volgt de voortgang van het downloaden.
const LAYER_LINE = /^([0-9a-f]{12})\s+(Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)\b\s*(.*)$/;
const OBJECT_LINE = /^((?:Container|Network|Volume)\s+\S+)\s+\S/;
const SERVICE_LINE = /^(\S+)\s+(?:Pulling|Pulled|Skipped|Interrupted|Error)\b/;
const UNIT = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9 };
function layerState(status, rest) {
  const m = rest.match(/([\d.]+)\s*([kKMG]?B)\s*\/\s*([\d.]+)\s*([kKMG]?B)/);
  const cur = m ? Number(m[1]) * UNIT[m[2]] : 0, total = m ? Number(m[3]) * UNIT[m[4]] : 0;
  const part = total ? Math.min(1, cur / total) : 0;
  if (status === 'Downloading') return { done: 0.75 * part, cur, total };
  if (status === 'Verifying Checksum' || status === 'Download complete') return { done: 0.75 };
  if (status === 'Extracting') return { done: 0.75 + 0.25 * part, total };
  if (status === 'Pull complete' || status === 'Already exists') return { done: 1 };
  return { done: 0 };
}
function jobLog(job, raw) {
  const line = String(raw).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  if (!line) return;
  let key = null, m;
  if ((m = line.match(LAYER_LINE))) {
    key = m[1];
    const prev = job.layers[key] || {}, st = layerState(m[2], m[3]);
    job.layers[key] = { ...st, total: st.total || prev.total || 0, cur: st.cur != null ? st.cur : (st.done >= 0.75 ? prev.total || 0 : 0) };
  } else if ((m = line.match(OBJECT_LINE)) || (m = line.match(SERVICE_LINE))) key = m[1];
  if (key && job.keys.has(key)) { job.lines[job.keys.get(key)] = line; return; }
  job.lines.push(line);
  if (key) job.keys.set(key, job.lines.length - 1);
  if (job.lines.length > 400) {
    const n = job.lines.length - 400; job.lines.splice(0, n);
    for (const [k, i] of job.keys) if (i < n) job.keys.delete(k); else job.keys.set(k, i - n);
  }
}
// Voortgang in procent: downloaden 3–85 %, starten 85–99 %.
function jobProgress(job) {
  const layers = Object.values(job.layers);
  const done = layers.filter((l) => l.done >= 1).length;
  const size = layers.reduce((a, l) => a + (l.total || 0), 0), downloaded = layers.reduce((a, l) => a + Math.min(l.cur || 0, l.total || 0), 0);
  let percent = job.done ? 100 : job.phase === 'start' ? 90 : 3;
  if (job.phase === 'pull' && layers.length) percent = 3 + Math.round(82 * layers.reduce((a, l) => a + l.done, 0) / layers.length);
  return { phase: job.done ? 'done' : job.phase, percent, layers: layers.length, layersDone: done, downloaded, size };
}

// De controles en het compose-bestand van een appstore-app, zoals installeren het zou schrijven (ook voor het concept).
async function storeCompose(id, body) {
  await ensureAppdata();
  const app = await getApp(id);
  const name = String(body.name || '').trim();
  if (!NAME.test(name)) throw httpError('Kies een naam met kleine letters, cijfers, - of _ (maximaal 63 tekens).', 400);
  if (!paths.exists('appdata')) throw httpError(APPDATA_MISSING(), 503);
  const inst = await installedInfo();
  const dir = path.join(STACKS_DIR, name);
  if (inst.names.has(name) || fs.existsSync(dir)) throw httpError('Er bestaat al een app met de naam ' + name + '. Kies een andere naam.', 409);

  const values = body.values || {};
  const fields = prepareFields(app.config, name).map((f) => (f.key in values ? { ...f, value: String(values[f.key] == null ? '' : values[f.key]) } : f));
  const tplNet = templateNetwork(app);
  const network = await dockernet.resolveNetwork(body.network || (tplNet === 'host' || tplNet === 'none' ? tplNet : 'bridge'));
  if (body.ip) {
    if (network.mode !== 'custom') throw httpError('Een vast IP-adres kan alleen in een eigen Docker-netwerk.', 400);
    network.ip = dockernet.checkIp(body.ip, network.subnet);
  }
  const host = network.mode === 'host' || network.mode === 'none' || network.ownIp; // geen poorten op de server
  const seen = new Set();
  for (const f of fields) {
    const v = f.value.trim();
    if (/[\n\r\0]/.test(f.value) && f.type !== 'Variable') throw httpError(`${f.name} mag geen regeleinde bevatten.`, 400);
    if (f.required && !v && f.type !== 'Device') throw httpError(`Vul ${f.name} in.`, 400);
    if (f.type === 'Path' && v && !path.isAbsolute(v)) throw httpError(`${f.name} moet een volledig pad zijn, bv. ${APPDATA_DIR()}/${name}.`, 400);
    if (f.type === 'Port' && v && !host) {
      if (!isPort(v)) throw httpError(`${f.name}: kies een poort tussen 1 en 65535.`, 400);
      const proto = /udp/i.test(f.mode) && !/tcp/i.test(f.mode) ? 'UDP' : 'TCP';
      const k = v + '/' + proto;
      if (seen.has(k)) throw httpError(`Poort ${v} staat twee keer in het formulier.`, 400);
      seen.add(k);
      const clash = inst.ports.find((p) => String(p.port) === v && p.type === proto);
      if (clash) throw httpError(`Poort ${v} is al in gebruik door ${clash.app}. Kies een andere poort.`, 409);
    }
  }
  // Extra poorten uit het formulier (+ Poort).
  const extraPorts = (Array.isArray(body.extraPorts) ? body.extraPorts : []).slice(0, 20).map((p) => {
    const h = String(p.host || '').trim(), c = String(p.container || '').trim(), protocol = p.protocol === 'udp' ? 'udp' : 'tcp';
    if (!isPort(h) || !isPort(c)) throw httpError('Vul bij elke extra poort twee poorten in tussen 1 en 65535.', 400);
    return { host: h, container: c, protocol };
  }).filter(Boolean);
  if (extraPorts.length && host) throw httpError('Met het host-netwerk luistert de app op zijn eigen poorten. Kies het standaardnetwerk (bridge) om poorten toe te voegen.', 400);
  for (const p of extraPorts) {
    const k = p.host + '/' + p.protocol.toUpperCase();
    if (seen.has(k)) throw httpError(`Poort ${p.host} staat twee keer in het formulier.`, 400);
    seen.add(k);
    const clash = inst.ports.find((x) => String(x.port) === p.host && x.type === p.protocol.toUpperCase());
    if (clash) throw httpError(`Poort ${p.host} is al in gebruik door ${clash.app}. Kies een andere poort.`, 409);
  }
  return { app, name, dir, compose: buildCompose(app, name, fields, { network, extraPorts }) };
}

async function install(id, body) {
  const { app, name, dir, compose } = await storeCompose(id, body);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'compose.yaml');
  fs.writeFileSync(file, compose.text);
  // Mappen met appgegevens vooraf aanmaken met de juiste eigenaar (anders maakt Docker ze aan als root).
  for (const d of compose.data) {
    if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); try { fs.chownSync(d, Number(APP_UID), Number(APP_GID)); } catch { /* geen root */ } }
  }

  return { job: startJob(name, file, dir, app.image, app.webui), name, file, warnings: compose.warnings };
}

// Installatietaak: image ophalen en starten met docker compose. Mislukt het, dan ruimen we de compose-map op.
function startJob(name, file, dir, image, webui) {
  const job = { id: crypto.randomBytes(6).toString('hex'), lines: [], keys: new Map(), layers: {}, phase: 'pull', done: false, ok: false, error: null, name, webui, started: Date.now() };
  jobs.set(job.id, job);
  for (const [k, j] of jobs) if (Date.now() - j.started > 3600000) jobs.delete(k);
  const base = ['compose', '--ansi', 'never', '--progress', 'plain', '-p', name, '-f', file];
  (async () => {
    try {
      jobLog(job, 'Compose-bestand geschreven: ' + file);
      jobLog(job, 'Image downloaden: ' + image);
      await runStream('docker', [...base, 'pull'], (l) => jobLog(job, l));
      job.phase = 'start';
      jobLog(job, 'App starten…');
      await runStream('docker', [...base, 'up', '-d'], (l) => jobLog(job, l), { timeout: 5 * 60000 });
      job.ok = true;
    } catch (e) {
      job.error = e.message;
      jobLog(job, 'Mislukt: ' + e.message);
      // Opruimen, zodat je het opnieuw kan proberen met dezelfde naam. De (lege) appgegevens blijven staan.
      await run('docker', ['compose', '-p', name, '-f', file, 'down'], { timeout: 120000 }).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    } finally { job.done = true; }
  })();
  return job.id;
}

/* ---------------------------------------------------------------- eigen app: zelf een image kiezen */

const IMAGE = /^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9][a-z0-9._\/-]*(?::[\w][\w.-]{0,127})?$/;
// Wat je plakt (link naar Docker Hub, GitHub of Quay, `docker pull …`, of gewoon een naam) → "naam:tag".
function normalizeImage(input) {
  let s = String(input || '').trim();
  const pull = s.match(/^docker\s+pull\s+(\S+)$/i);
  if (pull) s = pull[1];
  if (/\s/.test(s)) return null; // geen commando's of zinnen
  if (/^https?:\/\//i.test(s)) {
    let u; try { u = new URL(s); } catch { return null; }
    const parts = u.pathname.split('/').filter(Boolean), host = u.hostname.toLowerCase();
    const tagQ = u.searchParams.get('name') || u.searchParams.get('tag');
    if (/(^|\.)hub\.docker\.com$/.test(host) || host === 'docker.com' || host === 'www.docker.com') {
      if (parts[0] === '_' && parts[1]) s = parts[1];
      else if (parts[0] === 'r' && parts[1] && parts[2]) s = parts[1] + '/' + parts[2];
      else if (parts[0] === 'layers' && parts[1] && parts[2]) s = (parts[1] === '_' ? '' : parts[1] + '/') + parts[2] + (parts[3] ? ':' + parts[3] : '');
      else return null;
    } else if (host === 'github.com') {
      // github.com/<eigenaar>/<repo>/pkgs/container/<naam> of github.com/orgs|users/<eigenaar>/packages/container/package/<naam>
      const i = parts.indexOf('container');
      const owner = parts[0] === 'orgs' || parts[0] === 'users' ? parts[1] : parts[0];
      const name = i >= 0 ? parts[parts[i + 1] === 'package' ? i + 2 : i + 1] : null;
      if (!owner || !name) return null;
      s = 'ghcr.io/' + owner + '/' + decodeURIComponent(name);
    } else if (host === 'quay.io' && parts[0] === 'repository') s = 'quay.io/' + parts.slice(1, 3).join('/');
    else if (parts.length) s = host + '/' + parts.join('/');
    else return null; // alleen een website, geen image
    if (tagQ && !/:[^/]+$/.test(s)) s += ':' + tagQ;
  }
  const colon = s.lastIndexOf(':'), slash = s.lastIndexOf('/');
  let repo = s, tag = 'latest';
  if (colon > slash) { repo = s.slice(0, colon); tag = s.slice(colon + 1); }
  const out = repo.toLowerCase() + ':' + tag;
  return IMAGE.test(out) && registry.parseRef(out) ? out : null;
}

const ENVNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const URLISH = /^(https?:\/\/|\[IP\])/i;
const WEB_PORTS = [80, 443, 8080, 8443, 3000, 5000, 8000, 8096, 8123, 9000, 8081, 8888];
const serverArch = () => ({ x64: 'amd64', arm64: 'arm64', arm: 'arm' })[process.arch] || process.arch;

// Haal op wat het image zelf meldt en maak er een voorstel van: poorten, mappen in APPDATA_DIR, PUID/PGID/TZ, WebUI-adres.
async function inspectImage(input) {
  await ensureAppdata();
  const image = normalizeImage(input);
  if (!image) throw httpError('Plak de naam van een image (bv. nginx:latest of lscr.io/linuxserver/jellyfin) of een link naar Docker Hub.', 400);
  let cfg;
  try { cfg = (await registry.imageConfig(image, { arch: serverArch() })).config; }
  catch (e) { throw httpError(`Het image ${image} kon niet gelezen worden: ${e.message}.`, 404); }
  const [inst, cat, nets] = await Promise.all([installedInfo(), loadCatalog().catch(() => null),
    dockernet.listNetworks().then((r) => r.networks.filter((n) => !n.builtin).map((n) => ({ name: n.name, driver: n.driver, subnet: n.subnet })), () => [])]);
  const base = slugify(imageBase(image).split('/').pop());
  let name = base;
  for (let n = 2; inst.names.has(name) || fs.existsSync(path.join(STACKS_DIR, name)); n++) name = base + '-' + n;
  const used = new Set(inst.ports.map((p) => p.port + '/' + p.type));
  const ports = Object.keys(cfg.ExposedPorts || {}).map((k) => {
    const [port, proto = 'tcp'] = k.split('/');
    let host = Number(port);
    while (used.has(host + '/' + proto.toUpperCase()) && host < 65535) host++;
    used.add(host + '/' + proto.toUpperCase());
    return { host: String(host), container: port, protocol: proto === 'udp' ? 'udp' : 'tcp' };
  }).filter((p) => isPort(p.container));
  const volumes = Object.keys(cfg.Volumes || {}).filter((v) => v.startsWith('/')).map((v) => ({
    host: path.join(APPDATA_DIR(), name, v === '/config' ? '' : v.split('/').filter(Boolean).join('-')), container: v, mode: 'rw', auto: true }));
  const envNames = (cfg.Env || []).map((e) => e.split('=')[0]);
  const env = [];
  if (envNames.includes('PUID') || /linuxserver/.test(image)) env.push({ name: 'PUID', value: APP_UID }, { name: 'PGID', value: APP_GID });
  env.push({ name: 'TZ', value: hostTimezone() });
  const web = ports.filter((p) => p.protocol === 'tcp').sort((a, b) => (WEB_PORTS.includes(Number(b.container)) - WEB_PORTS.includes(Number(a.container))))[0];
  const match = cat && cat.apps.find((a) => imageBase(a.image) === imageBase(image));
  const warnings = [];
  if (!ports.length) warnings.push('Het image meldt geen poorten. Heeft de app een webinterface, voeg dan zelf een poort toe.');
  return {
    image, name, ports, volumes, env, webui: web ? `http://[IP]:[PORT:${web.container}]/` : '', icon: iconFor(image, name) || '',
    storeMatch: match ? { id: match.id, name: match.name } : null, warnings,
    networks: nets, networkDefault: 'bridge', appdataDir: APPDATA_DIR(), stacksDir: STACKS_DIR, appdataMissing: !paths.exists('appdata'), folders: await folderList(),
  };
}

// Controleer het formulier en maak het compose-bestand van een eigen app.
function buildCustomCompose(body, { network, takenPorts = [] }) {
  const name = String(body.name || '').trim(), image = normalizeImage(body.image);
  if (!image) throw httpError('Plak de naam van een image (bv. nginx:latest of lscr.io/linuxserver/jellyfin) of een link naar Docker Hub.', 400);
  const noPorts = network.mode === 'host' || network.mode === 'none' || network.ownIp;
  const restart = ['unless-stopped', 'always', 'on-failure', 'no'].includes(body.restart) ? body.restart : 'unless-stopped';
  const seen = new Set();
  const ports = noPorts ? [] : (body.ports || []).filter((p) => String(p.host || '').trim() || String(p.container || '').trim()).map((p) => {
    const h = String(p.host || '').trim(), c = String(p.container || '').trim(), proto = p.protocol === 'udp' ? 'udp' : 'tcp';
    if (!isPort(c)) throw httpError(`Poort in de app "${c}" is geen geldige poort.`, 400);
    if (!isPort(h)) throw httpError(`Poort op de server "${h}" is geen geldige poort.`, 400);
    const k = h + '/' + proto.toUpperCase();
    if (seen.has(k)) throw httpError(`Poort ${h} staat twee keer in het formulier.`, 400);
    seen.add(k);
    const clash = takenPorts.find((x) => String(x.port) === h && x.type === proto.toUpperCase());
    if (clash) throw httpError(`Poort ${h} is al in gebruik door ${clash.app}. Kies een andere poort.`, 409);
    return `${h}:${c}/${proto}`;
  });
  const data = new Set();
  const volumes = (body.volumes || []).filter((v) => String(v.host || '').trim() || String(v.container || '').trim()).map((v) => {
    const h = String(v.host || '').trim(), c = String(v.container || '').trim();
    if (!c.startsWith('/')) throw httpError(`De map in de app "${c}" moet met / beginnen.`, 400);
    if (!path.isAbsolute(h)) throw httpError(`Vul de map op de server in voor ${c} (een volledig pad, bv. ${APPDATA_DIR()}/${name}).`, 400);
    if (/[\n:]/.test(h + c)) throw httpError(`Een map mag geen : of regeleinde bevatten (${h}).`, 400);
    const root = appdataRoot(h); if (root) data.add(root);
    return `${h}:${c}${v.mode === 'ro' ? ':ro' : ''}`;
  });
  const environment = {};
  for (const e of body.env || []) {
    const k = String(e.name || '').trim(); if (!k) continue;
    if (!ENVNAME.test(k)) throw httpError(`"${k}" is geen geldige naam voor een variabele.`, 400);
    if (k in environment) throw httpError(`De variabele ${k} staat er twee keer in.`, 400);
    environment[k] = String(e.value == null ? '' : e.value);
  }
  const devices = (body.devices || []).filter((d) => String(d.host || '').trim()).map((d) => {
    const h = String(d.host).trim(), c = String(d.container || '').trim() || h;
    if (!/^\/dev\/\S+$/.test(h) || !/^\/dev\/\S+$/.test(c)) throw httpError(`Een apparaat begint met /dev/, bv. /dev/dri (niet "${h}").`, 400);
    return h + ':' + c;
  });
  const extraLabels = {};
  for (const l of body.labels || []) {
    const k = String(l.name || '').trim(); if (!k) continue;
    if (k.startsWith('homebaseos.')) continue; // die zet HomeBaseOS zelf
    extraLabels[k] = String(l.value == null ? '' : l.value);
  }
  const webui = String(body.webui || '').trim(), icon = String(body.icon || '').trim();
  if (webui && !URLISH.test(webui)) throw httpError('Het adres van de webinterface moet beginnen met http:// of https://, bv. http://[IP]:[PORT:8080]/', 400);
  if (icon && !/^https?:\/\//i.test(icon)) throw httpError('Het pictogram moet een adres zijn dat begint met http:// of https://.', 400);
  const svc = { image, container_name: name, restart };
  if (network.mode === 'host' || network.mode === 'none') svc.network_mode = network.mode;
  if (network.mode === 'custom') svc.networks = { [network.name]: network.ip ? { ipv4_address: network.ip } : null };
  if (ports.length) svc.ports = ports;
  if (volumes.length) svc.volumes = volumes;
  if (Object.keys(environment).length) svc.environment = environment;
  if (devices.length) svc.devices = devices;
  if (body.privileged) svc.privileged = true;
  svc.labels = { ...extraLabels, 'homebaseos.custom': '1', 'homebaseos.data': [...data].join(','), ...(icon ? { 'homebaseos.icon': icon } : {}), ...(webui ? { 'homebaseos.webui': webui } : {}) };
  const project = { name, services: { [name]: svc } };
  if (network.mode === 'custom') project.networks = { [network.name]: { external: true } };
  return { text: '# Eigen app, gemaakt met HomeBaseOS.\n' + toYaml(project) + '\n', data: [...data], image, webui };
}

async function installCustom(body) {
  await ensureAppdata();
  const name = String(body.name || '').trim();
  if (!NAME.test(name)) throw httpError('Kies een naam met kleine letters, cijfers, - of _ (maximaal 63 tekens).', 400);
  if (!paths.exists('appdata')) throw httpError(APPDATA_MISSING(), 503);
  const inst = await installedInfo();
  const dir = path.join(STACKS_DIR, name);
  if (inst.names.has(name) || fs.existsSync(dir)) throw httpError('Er bestaat al een app met de naam ' + name + '. Kies een andere naam.', 409);
  const network = await dockernet.resolveNetwork(body.network || 'bridge');
  if (body.ip) {
    if (network.mode !== 'custom') throw httpError('Een vast IP-adres kan alleen in een eigen Docker-netwerk.', 400);
    network.ip = dockernet.checkIp(body.ip, network.subnet);
  }
  const c = buildCustomCompose(body, { network, takenPorts: inst.ports });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'compose.yaml');
  fs.writeFileSync(file, c.text);
  for (const d of c.data) {
    if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); try { fs.chownSync(d, Number(APP_UID), Number(APP_GID)); } catch { /* geen root */ } }
  }
  return { job: startJob(name, file, dir, c.image, c.webui), name, file };
}

// Geavanceerd installeren: een concept-compose-bestand dat heen en weer gaat tussen het containerformulier en de code.
//  { store: id, name, values, network, ip, extraPorts } → het bestand van de appstore (met GPU, cap_add … uit het template)
//  { custom: {…}, name }                               → het bestand van een eigen app
//  { text, name }                                      → de code lezen (naar het formulier)
//  { text, name, form }                                → het formulier op de code toepassen (naar de code)
// Antwoord: { text, form (of formError), dockerNetworks }. Alles wat het formulier niet kent, blijft in de code staan.
async function draft(body) {
  const name = String(body.name || '').trim();
  if (!NAME.test(name)) throw httpError('Kies een naam met kleine letters, cijfers, - of _ (maximaal 63 tekens).', 400);
  let text;
  if (body.store) text = (await storeCompose(String(body.store), body)).compose.text;
  else if (body.custom) text = buildCustomCompose({ ...body.custom, name }, { network: await dockernet.resolveNetwork(body.custom.network || 'bridge') }).text;
  else text = String(body.text || '');
  if (!text.trim()) throw httpError('Het compose-bestand is leeg.', 400);
  if (text.length > 200000) throw httpError('Het compose-bestand is te groot.', 400);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homebaseos-concept-'));
  const file = path.join(tmp, 'compose.yaml');
  fs.writeFileSync(file, text);
  try {
    let project;
    try { project = await composeForm.loadProject({ project: name, workingDir: tmp, file }); }
    catch (e) { throw httpError('Het compose-bestand klopt niet: ' + e.message, 400); }
    const services = Object.keys(project.services || {});
    const service = services.includes(name) ? name : services[0];
    if (!service) throw httpError('Het compose-bestand heeft geen dienst (services).', 400);
    if (body.form && !body.store && !body.custom) {
      project = composeForm.applyServiceForm(project, { ...body.form, service });
      text = toYaml(project) + '\n';
    }
    let form = null, formError = null;
    try { form = composeForm.serviceForm(project, service); } catch (e) { formError = e.message; }
    const nets = await docker.docker('GET', '/networks').catch(() => []);
    const dockerNetworks = (nets || []).filter((n) => !['bridge', 'host', 'none'].includes(n.Name) && n.Scope === 'local')
      .map((n) => ({ name: n.Name, driver: n.Driver, subnet: ((n.IPAM && n.IPAM.Config) || []).map((x) => x.Subnet).find(Boolean) || null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { text, form, formError, dockerNetworks };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Installeren vanuit de code: het compose-bestand zoals je het schreef. Eerst controleert `docker compose config` het.
// Gekoppelde mappen in de appgegevens die nog niet bestaan, maken we aan voor de app-gebruiker (anders maakt Docker ze als root).
async function installCompose(body) {
  await ensureAppdata();
  const name = String(body.name || '').trim();
  if (!NAME.test(name)) throw httpError('Kies een naam met kleine letters, cijfers, - of _ (maximaal 63 tekens).', 400);
  const text = String(body.text || '');
  if (!text.trim()) throw httpError('Het compose-bestand is leeg.', 400);
  if (text.length > 200000) throw httpError('Het compose-bestand is te groot.', 400);
  const inst = await installedInfo();
  const dir = path.join(STACKS_DIR, name);
  if (inst.names.has(name) || fs.existsSync(dir)) throw httpError('Er bestaat al een app met de naam ' + name + '. Kies een andere naam.', 409);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'compose.yaml');
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n');
  let cfg;
  try { cfg = JSON.parse(await run('docker', ['compose', '-p', name, '-f', file, 'config', '--format', 'json'], { timeout: 30000 })); }
  catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw httpError('Het compose-bestand klopt niet: ' + e.message, 400); }
  const services = Object.values(cfg.services || {});
  if (!services.length) { fs.rmSync(dir, { recursive: true, force: true }); throw httpError('Het compose-bestand heeft geen dienst (services).', 400); }
  const appdata = paths.dir('appdata');
  for (const svc of services) {
    for (const v of svc.volumes || []) {
      const src = v.type === 'bind' && v.source ? path.resolve(v.source) : null;
      if (!src || !appdata || !src.startsWith(appdata + path.sep) || fs.existsSync(src)) continue;
      fs.mkdirSync(src, { recursive: true }); try { fs.chownSync(src, Number(APP_UID), Number(APP_GID)); } catch { /* geen root */ }
    }
  }
  const image = services.map((x) => x.image).filter(Boolean).join(', ') || name;
  return { job: startJob(name, file, dir, image, null), name, file };
}

function jobStatus(id) {
  const j = jobs.get(id);
  if (!j) throw httpError('Deze installatie is niet (meer) bekend.', 404);
  return { done: j.done, ok: j.ok, error: j.error, name: j.name, webui: j.webui, lines: j.lines, ...jobProgress(j) };
}

// Verwijder een app uit de appstore: containers weg, compose-map weg, en desgewenst de appgegevens.
async function uninstall(containerId, removeData) {
  const apps = await docker.listApps();
  const a = apps.find((x) => x.id === containerId);
  if (!a) throw httpError('Deze app bestaat niet (meer).', 404);
  if ((!a.storeId && !a.custom) || !a.compose) throw httpError('Alleen apps uit de appstore of eigen apps van HomeBaseOS kan je hier verwijderen. Verwijder andere apps via hun eigen compose-bestand.', 400);
  const dir = path.join(STACKS_DIR, a.compose);
  const file = path.join(dir, 'compose.yaml');
  if (fs.existsSync(file)) await run('docker', ['compose', '-p', a.compose, '-f', file, 'down'], { timeout: 5 * 60000 });
  else await run('docker', ['rm', '-f', a.id], { timeout: 60000 });
  if (dir.startsWith(STACKS_DIR + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
  const removed = [], kept = [];
  if (removeData) {
    for (const d of a.dataDirs) {
      const r = path.resolve(d);
      // Alleen mappen binnen APPDATA_DIR, nooit APPDATA_DIR zelf.
      if (paths.dir('appdata') && r.startsWith(paths.dir('appdata') + path.sep)) { fs.rmSync(r, { recursive: true, force: true }); removed.push(r); } else kept.push(r);
    }
  }
  return { removed, kept };
}

module.exports = {
  catalog, details, install, jobStatus, jobLog, jobProgress, uninstall, iconFor, inspectImage, installCustom, draft, installCompose, normalizeImage, buildCustomCompose,
  normalizeFeed, cleanText, prepareFields, templateNetwork, mapHostPath, shellSplit, parseExtraParams, buildCompose, toYaml, slugify, imageBase,
};
