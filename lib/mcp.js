'use strict';
/*
 * Model Context Protocol (stdio, Content-Length frames) over the MajaOS API.
 * No dependencies: JSON-RPC 2.0, initialize, tools/list and tools/call.
 */
const http = require('node:http');
const https = require('node:https');
const { version } = require('../package.json');

// Written for small local models too: short numbered rules, one idea per line.
const INSTRUCTIONS = [
  'You manage a MajaOS home server through its own API. Use the specific tools for apps, VMs, files, shared folders, storage, backups, network, settings and AI. The api tool reaches any other /api path the web interface uses.',
  'Rules:',
  '1. Look before you act. First call the tool that lists things (shares_list, apps_list, vms_list, vm_options, storage, pool_options, network) and use the real names from its answer. Never make up a name, pool, folder, user, disk, ISO or address.',
  '2. Never guess missing information. When the user did not say something you need (which pool or folder, which users and whether they may change files, a password, which disks, how much memory), ask one short question and stop. Offer the choices you found in step 1.',
  '3. Before you create, change, delete or restart anything: tell the user in one or two plain sentences what you are going to do, and ask "Shall I do that?". Wait for their answer.',
  '4. Only after a clear yes from the user, call the tool with confirm set to true. A yes to an earlier question does not count for a new action.',
  '5. If a tool answers "Missing information" or "Not done yet", do what it says: ask the user and wait. Do not call the tool again in the same answer.',
  '6. Never invent a password. Ask the user for it.',
  '7. After a change, say in one sentence what happened. If a tool gives an error, explain it plainly and say what the user can do.',
  '8. Answer in the language the user writes in. Keep answers short.',
  'shell_run is a root command on the server, with the same switch and password as the terminal in Settings → Security. Use it only when no other tool can do the job.',
].join('\n');

const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const num = (description) => ({ type: 'number', description });
const obj = (description) => ({ type: 'object', description });
const arr = (description) => ({ type: 'array', description });

function tool(name, description, properties, required, fn) {
  const inputSchema = { type: 'object', properties };
  if (required && required.length) inputSchema.required = required;
  return { name, description, inputSchema, fn };
}

function mustConfirm(args, what) {
  if (args.confirm !== true) throw new Error('Not done yet. Ask the user whether you may ' + what + ', and wait for the answer. Only after a clear yes, call this tool again with confirm: true.');
}

// A change that creates or changes something: without confirm the tool only returns the plan, so the model has to ask first.
function planFirst(args, plan) {
  if (args.confirm === true) return;
  throw new Error('Not done yet. Tell the user this plan in plain words and ask "Shall I do that?": ' + plan
    + ' Wait for their answer. Only after a clear yes, call this tool again with the same values and confirm: true.');
}
// Information only the user can give.
function askFor(questions) {
  if (!questions.length) return;
  throw new Error('Missing information. Ask the user, and do not guess: ' + questions.join(' ')
    + ' Wait for the answer before you call this tool again.');
}
const names = (list) => (list || []).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
const either = (list, none) => (list.length ? list.join(', ') : none);
const rights = (o) => Object.entries(o || {}).map(([k, v]) => k + (v === 'rw' ? ' (read and write)' : ' (read only)')).join(', ');
const confirmProp = () => bool('Only true after the user said yes to exactly this plan');

// Shared folders: where it goes and who may use it are the user's choice.
async function shareSave(c, a) {
  const info = await c.call('GET', '/api/shares');
  const shares = names(info.shares), users = names(info.users), groups = names(info.groups), pools = names(info.roots);
  const name = String(a.name || '').trim();
  const exists = shares.includes(name);
  const q = [];
  if (!name) q.push('What should the shared folder be called?');
  if (!exists) {
    if (!a.path && !(a.create && a.create.parent)) {
      q.push('Where should the folder go? A new folder on a pool (create.parent, one of: ' + either(pools, 'no pools yet') + ') or an existing folder on the server (path)?');
    } else if (a.create && a.create.parent && pools.length && !pools.includes(a.create.parent)) {
      q.push('There is no pool called "' + a.create.parent + '". Which pool: ' + pools.join(', ') + '?');
    }
    const access = Object.keys(a.users || {}).length || Object.keys(a.groups || {}).length || a.guest === true;
    if (!access) {
      q.push('Who may use the folder, and may they change files (rw) or only read them (ro)? Users: ' + either(users, 'none yet')
        + '. Groups: ' + either(groups, 'none') + '. Or everyone in the home network without a password (guest).');
    }
  }
  for (const [kind, given, known] of [['user', a.users, users], ['group', a.groups, groups]]) {
    const unknown = Object.keys(given || {}).filter((n) => !known.includes(n));
    if (unknown.length) q.push('The ' + kind + ' ' + unknown.join(', ') + ' does not exist. Choose from: ' + either(known, 'none yet')
      + (kind === 'user' ? ', or ask whether to create it with share_user_create (that needs a password from the user).' : '.'));
    const bad = Object.entries(given || {}).filter(([, v]) => v !== 'ro' && v !== 'rw').map(([n]) => n);
    if (bad.length) q.push('For ' + bad.join(', ') + ': read and write (rw) or read only (ro)?');
  }
  askFor(q);
  const where = a.path ? 'the existing folder ' + a.path : a.create && a.create.parent ? 'a new folder on pool ' + a.create.parent : 'where it is now';
  const who = [rights(a.users), rights(a.groups), a.guest ? 'guests without a password' : ''].filter(Boolean).join('; ');
  planFirst(a, (exists ? 'Change the shared folder "' + name + '"' : 'Create the shared folder "' + name + '" in ' + where)
    + (who ? ', access for: ' + who : '') + (a.timemachine ? ', as a Time Machine backup folder' : '') + '.');
  return c.call('POST', '/api/shares', { body: pick(a, ['name', 'path', 'create', 'comment', 'users', 'groups', 'guest', 'timemachine']) });
}

// Changing an app through its compose form (like the app's settings window): only what is given changes.
// ports, volumes and devices replace the whole list (entries the form can't edit stay); env changes single variables
// (null removes one). Returns {form, changes} with the changes in plain words for the plan.
function mergeAppForm(form, a) {
  const f = { ...form }, changes = [];
  const set = (key, label, value, show = value) => {
    if (value === undefined || value === f[key]) return;
    f[key] = value; changes.push(label + ' → ' + (show === '' ? 'default' : show));
  };
  set('image', 'image', a.image);
  set('restart', 'restart policy', a.restart);
  if (a.privileged !== undefined) set('privileged', 'privileged', !!a.privileged, a.privileged ? 'on' : 'off');
  if (a.gpu !== undefined) set('gpu', 'GPU', !!a.gpu, a.gpu ? 'on' : 'off');
  if (a.network !== undefined) { set('network', 'network', String(a.network)); if (a.ip === undefined && String(a.network) !== form.network) f.ip = ''; }
  if (a.ip !== undefined) set('ip', 'fixed address', String(a.ip), a.ip || 'automatic');
  const locked = (list) => (list || []).filter((x) => x.locked);
  if (Array.isArray(a.ports)) {
    f.ports = [...a.ports.map((p) => ({ host: String(p.host == null ? '' : p.host), container: String(p.container == null ? '' : p.container), protocol: p.protocol === 'udp' ? 'udp' : 'tcp', ip: '', mode: '' })), ...locked(form.ports)];
    changes.push('ports → ' + (a.ports.map((p) => (p.host ? p.host + ':' : '') + p.container + '/' + (p.protocol || 'tcp')).join(', ') || 'none'));
  }
  if (Array.isArray(a.volumes)) {
    f.volumes = [...a.volumes.map((v) => ({ host: String(v.host || ''), container: String(v.container || ''), mode: v.mode === 'ro' ? 'ro' : 'rw', kind: String(v.host || '').startsWith('/') ? 'bind' : 'volume' })), ...locked(form.volumes)];
    changes.push('folders → ' + (a.volumes.map((v) => v.host + ' → ' + v.container + (v.mode === 'ro' ? ' (read only)' : '')).join(', ') || 'none'));
  }
  if (Array.isArray(a.devices)) {
    f.devices = a.devices.map((d) => (typeof d === 'string' ? { host: d, container: d, perm: '' } : { host: String(d.host || ''), container: String(d.container || d.host || ''), perm: '' }));
    changes.push('devices → ' + (f.devices.map((d) => d.host).join(', ') || 'none'));
  }
  if (a.env && typeof a.env === 'object') {
    const env = (form.env || []).map((e) => ({ ...e }));
    for (const [name, value] of Object.entries(a.env)) {
      const i = env.findIndex((e) => e.name === name);
      if (value === null) { if (i >= 0) { env.splice(i, 1); changes.push('remove variable ' + name); } continue; }
      if (i >= 0) env[i] = { name, value: String(value) }; else env.push({ name, value: String(value) });
      changes.push(name + ' = ' + String(value));
    }
    f.env = env;
  }
  return { form: f, changes };
}
async function changeApp(c, a) {
  const id = encodeURIComponent(a.id);
  const s = await c.call('GET', '/api/apps/' + id + '/settings');
  const comp = s.compose;
  if (!comp) throw new Error('This app was not started with Docker Compose, so its settings can\'t be changed here. Only its name, web address, icon and automatic start can (app_settings_set).');
  if (!comp.editable) throw new Error('The compose file of this app is not on the server (' + (comp.files || []).join(', ') + '), so it can\'t be changed here.');
  if (!comp.form) throw new Error('This compose file can\'t be read as a form' + (comp.formError ? ' (' + comp.formError + ')' : '') + '. Use app_compose_edit with the whole file instead: get the current text from app_settings_get (compose.text).');
  const { form, changes } = mergeAppForm(comp.form, a);
  if (!changes.length) throw new Error('Nothing to change: send only the fields that should be different (see app_settings_get, compose.form).');
  planFirst(a, 'Change the app "' + (s.name || a.id) + '": ' + changes.join('; ') + '. The app is made again with these settings and is briefly unreachable.');
  return c.call('POST', '/api/apps/' + id + '/compose-form', { body: { form } });
}

function pick(args, keys) {
  const out = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

function qpath(path, query) {
  const u = new URL(path, 'http://local');
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') u.searchParams.set(key, String(value));
  }
  return u.pathname + u.search;
}

// Only the server's own JSON API. The query string may sit in the path.
function safeApiPath(path, query) {
  if (typeof path !== 'string' || /[\r\n\\]/.test(path) || path.includes('..')) throw new Error('path must be an /api/ path.');
  let u;
  try { u = new URL(path, 'http://local'); } catch { throw new Error('path must be an /api/ path.'); }
  if (u.origin !== 'http://local' || !u.pathname.startsWith('/api/')) throw new Error('path must be an /api/ path.');
  const q = { ...query };
  for (const [key, value] of u.searchParams) q[key] = value;
  return { path: u.pathname, query: q };
}

const TOOLS = [
  tool('overview', 'Hostname, uptime, CPU, memory, storage and GPU.', {}, [], (c) => c.call('GET', '/api/overview')),
  tool('apps_list', 'Docker apps: state, ports, web address, whether an update is available.', {}, [], (c) => c.call('GET', '/api/apps')),
  tool('app_logs', 'Last log lines of an app.', { id: str('Container id or name'), tail: num('How many lines (default 200)') }, ['id'],
    (c, a) => c.call('GET', qpath('/api/apps/' + encodeURIComponent(a.id) + '/logs', { tail: a.tail || 200 }))),
  tool('app_action', 'Start, stop, restart or update an app. Stop, restart and update need confirm after the user said yes.', {
    id: str('Container id or name'),
    action: { type: 'string', enum: ['start', 'stop', 'restart', 'update'], description: 'What to do' }, confirm: confirmProp(),
  }, ['id', 'action'], (c, a) => {
    if (!['start', 'stop', 'restart', 'update'].includes(a.action)) throw new Error('Unknown action.');
    if (a.action !== 'start') mustConfirm(a, a.action + ' the app ' + a.id);
    return c.call('POST', '/api/apps/' + encodeURIComponent(a.id) + '/' + a.action);
  }),
  tool('app_remove', 'Remove an app. The files stay unless data is true.', {
    id: str('Container id or name'), data: bool('Also delete its data folder'), confirm: bool('Must be true'),
  }, ['id', 'confirm'], (c, a) => { mustConfirm(a, 'remove this app'); return c.call('DELETE', qpath('/api/apps/' + encodeURIComponent(a.id), { data: a.data ? '1' : '' })); }),
  tool('app_settings_get', 'Settings and compose form of one app.', { id: str('Container id or name') }, ['id'],
    (c, a) => c.call('GET', '/api/apps/' + encodeURIComponent(a.id) + '/settings')),
  tool('app_settings_set', 'Name on the dashboard, web address, icon and automatic start of an app. These don\'t restart it. For image, ports, folders, variables or network use app_change.', {
    id: str('Container id or name'), label: str('Name shown on the dashboard (empty = from the container name)'), webui: str('Web address, with [IP] and [PORT:n]'), icon: str('Icon URL'), autoStart: bool('Start with Docker'),
  }, ['id'], (c, a) => c.call('POST', '/api/apps/' + encodeURIComponent(a.id) + '/settings', { body: pick(a, ['label', 'webui', 'icon', 'autoStart']) })),
  tool('app_change', 'Change an installed app: image or tag, ports, folders, environment variables, devices, network, fixed address, GPU, restart policy. '
    + 'Call app_settings_get first and look at compose.form. Send only what should change. ports, volumes and devices replace the whole list, so send the full new list. '
    + 'env changes single variables ({"TZ": "Europe/Brussels"}; null removes one). Without confirm it only returns the plan.', {
    id: str('Container id or name'), image: str('Image with tag'), restart: str('no, always, on-failure or unless-stopped'),
    privileged: bool('Privileged container'), gpu: bool('Give the app the NVIDIA GPU'),
    network: str('"" (default), host, none, a Docker network name'), ip: str('Fixed address in that network, "" = automatic'),
    ports: arr('The full new list [{host, container, protocol: tcp|udp}]'), volumes: arr('The full new list [{host, container, mode: rw|ro}]'),
    env: obj('Variables to set; null removes one'), devices: arr('The full new list of device paths, e.g. ["/dev/dri"]'), confirm: confirmProp(),
  }, ['id'], changeApp),
  tool('app_compose_edit', 'Replace the whole compose file of an installed app (for what app_change can\'t do). Get the current text from app_settings_get (compose.text) and change only what is needed. It is checked first; the old file stays as .bak. Without confirm it only returns the plan.', {
    id: str('Container id or name'), text: str('The full new compose.yaml'), confirm: confirmProp(),
  }, ['id', 'text'], (c, a) => {
    planFirst(a, 'Replace the compose file of the app "' + a.id + '" with the new text and start it again with it.');
    return c.call('POST', '/api/apps/' + encodeURIComponent(a.id) + '/compose', { body: { text: a.text } });
  }),
  tool('app_exec', 'Run one command inside an app container.', {
    id: str('Container id or name'), cmd: str('The command'), cwd: str('Folder inside the container'),
  }, ['id', 'cmd'], (c, a) => c.call('POST', '/api/apps/' + encodeURIComponent(a.id) + '/exec', { body: pick(a, ['cmd', 'cwd']) })),
  tool('app_inspect', 'Read an image (ports, folders, suggested name) before installing your own app.', { image: str('Image name or link') }, ['image'],
    (c, a) => c.call('POST', '/api/apps/custom/inspect', { body: { image: a.image } })),
  tool('app_install', 'Install your own app from an image. Call app_inspect first and reuse its suggestions. Ask the user about folders with their own files (films, photos) if the image needs them. Without confirm it only returns the plan.', {
    name: str('Lowercase name'), image: str('Image'), restart: str('no, always, on-failure or unless-stopped'),
    privileged: bool('Privileged container'), network: str('bridge, host, none, a network name, or @lan'), ip: str('Fixed address'),
    ports: arr('[{host, container, protocol}]'), volumes: arr('[{host, container}]'), env: obj('Environment variables'),
    devices: arr('Device paths'), webui: str('Web address'), icon: str('Icon URL'), confirm: confirmProp(),
  }, ['name', 'image'], (c, a) => {
    planFirst(a, 'Install the app "' + a.name + '" from ' + a.image + ((a.volumes || []).length ? ' with the folders ' + a.volumes.map((v) => v.host + ' → ' + v.container).join(', ') : '') + '.');
    return c.call('POST', '/api/apps/custom', { body: pick(a, ['name', 'image', 'restart', 'privileged', 'network', 'ip', 'ports', 'volumes', 'env', 'devices', 'webui', 'icon']) });
  }),
  tool('app_compose', 'Install exactly this compose file. Without confirm it only returns the plan.', { name: str('Lowercase name'), text: str('compose.yaml contents'), confirm: confirmProp() }, ['name', 'text'],
    (c, a) => { planFirst(a, 'Install the app "' + a.name + '" with this compose file.'); return c.call('POST', '/api/apps/compose', { body: { name: a.name, text: a.text } }); }),
  tool('store_list', 'App store catalogue.', { refresh: bool('Fetch the catalogue again') }, [],
    (c, a) => c.call('GET', qpath('/api/store', { refresh: a.refresh ? '1' : '' }))),
  tool('store_app', 'One catalogue app, with its fields. Fields with required true and an empty value, and folders for the user\'s own files (films, series, photos, downloads), must come from the user: ask.', { id: str('Catalogue id') }, ['id'],
    (c, a) => c.call('GET', '/api/store/apps/' + encodeURIComponent(a.id))),
  tool('store_install', 'Install an app from the catalogue. Call store_list to find the id and store_app for its fields first; ask the user for required empty fields and media folders. Without confirm it only returns the plan.', {
    id: str('Catalogue id'), name: str('Lowercase name'), values: obj('Field key to value'), network: str('Network'), ip: str('Fixed address'), extraPorts: arr('Extra ports'), confirm: confirmProp(),
  }, ['id', 'name'], async (c, a) => {
    if (a.confirm !== true) {
      const d = await c.call('GET', '/api/store/apps/' + encodeURIComponent(a.id));
      const given = a.values || {};
      const empty = (d.fields || []).filter((f) => f.required && !String(given[f.key] != null ? given[f.key] : f.value || '').trim() && f.type !== 'Device');
      askFor(empty.map((f) => 'What should "' + f.name + '" be' + (f.description ? ' (' + f.description.slice(0, 120) + ')' : '') + '? Send it as values.' + f.key + '.'));
      const folders = (d.fields || []).filter((f) => f.type === 'Path' && !f.auto).map((f) => f.name + ': ' + (given[f.key] || f.value || '?'));
      planFirst(a, 'Install ' + (d.name || a.id) + ' as "' + a.name + '"' + (folders.length ? ', with the folders ' + folders.join('; ') : '') + '.');
    }
    return c.call('POST', '/api/store/apps/' + encodeURIComponent(a.id) + '/install', { body: pick(a, ['name', 'values', 'network', 'ip', 'extraPorts']) });
  }),
  tool('job_status', 'Progress of an install or update.', { id: str('Job id') }, ['id'],
    (c, a) => c.call('GET', '/api/store/jobs/' + encodeURIComponent(a.id))),
  tool('vms_list', 'Virtual machines.', {}, [], (c) => c.call('GET', '/api/vms')),
  tool('vm_get', 'One VM: disks, network cards, boot, USB and PCI.', { id: str('VM name') }, ['id'],
    (c, a) => c.call('GET', '/api/vms/' + encodeURIComponent(a.id))),
  tool('vm_options', 'What you can choose when creating a VM: ISOs, networks, USB, PCI, CPU.', {}, [], (c) => c.call('GET', '/api/vm-options')),
  tool('vm_create', 'Create a VM. kind is linux, windows or import (an existing disk image). Call vm_options first for the ISOs and images. '
    + 'Ask the user which ISO or image, and how many vCPUs, how much memory and how large a disk, if they did not say. Without confirm it only returns the plan.', {
    name: str('VM name'), kind: { type: 'string', enum: ['linux', 'windows', 'import'] }, source: str('ISO or disk image name from vm_options'),
    vcpus: num('vCPUs'), memoryGb: num('Memory in GB'), diskGb: num('Disk in GB'),
    network: str('network:<name> or bridge:<name>'), description: str('Description'), autostart: bool('Start with the server'), delay: num('Start delay in seconds'),
    confirm: confirmProp(),
  }, ['name', 'kind'], async (c, a) => {
    const opts = await c.call('GET', '/api/vm-options');
    const files = a.kind === 'import' ? (opts.images || []) : (opts.isos || []);
    const q = [];
    if (!a.source) q.push((a.kind === 'import' ? 'Which disk image? ' : 'Which installation ISO? ') + 'Choose from: ' + either(files, 'none found; put one in ' + (a.kind === 'import' ? opts.vmDir : opts.isoDir) + ' first') + '.');
    else if (files.length && !files.includes(a.source)) q.push('There is no file called "' + a.source + '". Choose from: ' + files.join(', ') + '.');
    const sizes = [a.vcpus ? '' : 'vCPUs (for example 2)', a.memoryGb ? '' : 'memory (for example 4 GB)', a.diskGb || a.kind === 'import' ? '' : 'disk size (for example 32 GB)'].filter(Boolean);
    if (sizes.length) q.push('How many ' + sizes.join(', ') + '? The server has ' + (opts.maxVcpus || '?') + ' vCPUs and ' + (opts.maxMemory ? Math.floor(opts.maxMemory / 1073741824) + ' GB memory' : 'some memory') + '.');
    askFor(q);
    planFirst(a, 'Create the VM "' + a.name + '" (' + a.kind + ') from ' + a.source + ' with ' + a.vcpus + ' vCPUs, ' + a.memoryGb + ' GB memory'
      + (a.diskGb ? ' and a ' + a.diskGb + ' GB disk' : '') + (a.autostart ? ', starting with the server' : '') + '.');
    return c.call('POST', '/api/vms', { body: pick(a, ['name', 'kind', 'source', 'vcpus', 'memoryGb', 'diskGb', 'network', 'description', 'autostart', 'delay']) });
  }),
  tool('vm_action', 'Start, stop, reboot, pause, resume, force-stop or reset a VM. Everything except start and resume needs confirm after the user said yes.', {
    id: str('VM name'), action: { type: 'string', enum: ['start', 'stop', 'reboot', 'pause', 'resume', 'force-stop', 'reset'] }, confirm: confirmProp(),
  }, ['id', 'action'], (c, a) => {
    if (!['start', 'stop', 'reboot', 'pause', 'resume', 'force-stop', 'reset'].includes(a.action)) throw new Error('Unknown action.');
    if (!['start', 'resume'].includes(a.action)) mustConfirm(a, a.action + ' the VM ' + a.id);
    return c.call('POST', '/api/vms/' + encodeURIComponent(a.id) + '/' + a.action);
  }),
  tool('vm_settings', 'Change a VM. Only send the fields you want to change. Without confirm it only returns the plan.', {
    id: str('VM name'), name: str('New name'), vcpus: num('vCPUs'), memoryGb: num('Memory in GB'), description: str('Description'),
    autostart: bool('Start with the server'), delay: num('Start delay'), clipboard: bool('Clipboard channel'),
    nics: arr('Network cards'), boot: str('disk or cdrom'), hostdevs: arr('usb:vvvv:pppp or pci:0000:0a:00.0'), cpuPins: arr('Pinned cores'),
    addDisks: arr('[{sizeGb, bus}]'), resizeDisks: arr('[{target, sizeGb}]'), removeDisks: arr('Disk targets'), cdrom: str('ISO name, empty to eject'),
    confirm: confirmProp(),
  }, ['id'], (c, a) => {
    const keys = ['name', 'vcpus', 'memoryGb', 'description', 'autostart', 'delay', 'clipboard', 'nics', 'boot', 'hostdevs', 'cpuPins', 'addDisks', 'resizeDisks', 'removeDisks', 'cdrom'];
    planFirst(a, 'Change the VM "' + a.id + '": ' + keys.filter((k) => a[k] !== undefined).map((k) => k + ' = ' + JSON.stringify(a[k])).join(', ') + '.');
    return c.call('POST', '/api/vms/' + encodeURIComponent(a.id) + '/settings', { body: pick(a, keys) });
  }),
  tool('vm_delete', 'Delete a VM that is off. Disks stay unless disks is true.', {
    id: str('VM name'), disks: bool('Also delete its disks'), confirm: bool('Must be true'),
  }, ['id', 'confirm'], (c, a) => { mustConfirm(a, 'delete this VM'); return c.call('DELETE', qpath('/api/vms/' + encodeURIComponent(a.id), { disks: a.disks ? '1' : '' })); }),
  tool('vm_snapshots', 'List snapshots of a VM.', { id: str('VM name') }, ['id'],
    (c, a) => c.call('GET', '/api/vms/' + encodeURIComponent(a.id) + '/snapshots')),
  tool('vm_snapshot_create', 'Take a snapshot. Memory is included when the VM is running, unless diskOnly is true.', {
    id: str('VM name'), name: str('Snapshot name'), description: str('Description'), diskOnly: bool('Do not save memory'),
  }, ['id', 'name'], (c, a) => c.call('POST', '/api/vms/' + encodeURIComponent(a.id) + '/snapshots', { body: pick(a, ['name', 'description', 'diskOnly']) })),
  tool('vm_snapshot_revert', 'Revert a VM to a snapshot.', { id: str('VM name'), name: str('Snapshot name'), confirm: bool('Must be true') }, ['id', 'name', 'confirm'],
    (c, a) => { mustConfirm(a, 'revert this snapshot'); return c.call('POST', '/api/vms/' + encodeURIComponent(a.id) + '/snapshots/' + encodeURIComponent(a.name) + '/revert'); }),
  tool('vm_snapshot_delete', 'Delete a snapshot and merge it.', { id: str('VM name'), name: str('Snapshot name'), confirm: bool('Must be true') }, ['id', 'name', 'confirm'],
    (c, a) => { mustConfirm(a, 'delete this snapshot'); return c.call('DELETE', '/api/vms/' + encodeURIComponent(a.id) + '/snapshots/' + encodeURIComponent(a.name)); }),
  tool('files_places', 'Folders and disks in Files: shared folders, datasets, system folders, USB and SD.', {}, [],
    async (c) => ({ places: (await c.call('GET', '/api/shares')).places })),
  tool('files_list', 'List a folder. place is the id from files_places.', { place: str('Place id'), path: str('Folder inside it, empty for the top') }, ['place'],
    (c, a) => c.call('GET', qpath('/api/shares/' + encodeURIComponent(a.place) + '/files', { path: a.path || '' }))),
  tool('files_read', 'Read a text file.', { place: str('Place id'), path: str('File path') }, ['place', 'path'],
    (c, a) => c.call('GET', qpath('/api/shares/' + encodeURIComponent(a.place) + '/files', { path: a.path, text: '1' }))),
  tool('files_write', 'Write a text file. Existing files stay unless overwrite is true.', {
    place: str('Place id'), path: str('File path'), text: str('The new contents'), overwrite: bool('Replace an existing file'),
  }, ['place', 'path', 'text'], (c, a) => c.call('PUT', qpath('/api/shares/' + encodeURIComponent(a.place) + '/files', { path: a.path, overwrite: a.overwrite ? '1' : '' }), { raw: a.text })),
  tool('files_mkdir', 'Create a folder.', { place: str('Place id'), path: str('New folder path') }, ['place', 'path'],
    (c, a) => c.call('POST', '/api/shares/' + encodeURIComponent(a.place) + '/files', { body: { action: 'mkdir', path: a.path } })),
  tool('files_rename', 'Rename a file or folder.', { place: str('Place id'), path: str('Current path'), name: str('New name') }, ['place', 'path', 'name'],
    (c, a) => c.call('POST', '/api/shares/' + encodeURIComponent(a.place) + '/files', { body: { action: 'rename', path: a.path, name: a.name } })),
  tool('files_copy', 'Copy a file or folder next to itself.', { place: str('Place id'), path: str('Path to copy') }, ['place', 'path'],
    (c, a) => c.call('POST', '/api/shares/' + encodeURIComponent(a.place) + '/files', { body: { action: 'copy', path: a.path } })),
  tool('files_delete', 'Delete a file or folder. A folder with files needs recursive.', {
    place: str('Place id'), path: str('Path'), recursive: bool('Delete everything inside a folder'), confirm: bool('Must be true'),
  }, ['place', 'path', 'confirm'], (c, a) => {
    mustConfirm(a, 'delete this');
    return c.call('DELETE', qpath('/api/shares/' + encodeURIComponent(a.place) + '/files', { path: a.path, recursive: a.recursive ? '1' : '' }));
  }),
  tool('files_eject', 'Unmount and eject a USB disk or SD card.', { id: str('Disk place id'), confirm: bool('Must be true') }, ['id', 'confirm'],
    (c, a) => { mustConfirm(a, 'eject this disk'); return c.call('POST', '/api/files/eject', { body: { id: a.id } }); }),
  tool('shares_list', 'Shared folders, users and groups.', {}, [], (c) => c.call('GET', '/api/shares')),
  tool('share_save', 'Create or change a shared folder (a network folder for PCs, Macs and phones). '
    + 'You need from the user: the name, where it goes (a new folder on a pool with create.parent, or an existing folder with path) and who may use it '
    + '(users or groups with rw = read and write or ro = read only, or guest). Call shares_list first for the pools, users and groups. Ask for what the user did not say. '
    + 'Without confirm it only returns the plan to show the user.', {
    name: str('Folder name, for example films'), path: str('Existing folder on the server, for example /tank/media'), create: obj('{parent: pool name}: a new folder on that pool'),
    comment: str('Short description'), users: obj('User name to "ro" (read only) or "rw" (read and write), for example {"lennert": "rw"}'),
    groups: obj('Group name to "ro" or "rw"'), guest: bool('Everyone in the home network may use it without a password'), timemachine: bool('Use as a Time Machine backup folder for Macs'),
    confirm: confirmProp(),
  }, ['name'], shareSave),
  tool('share_delete', 'Stop sharing a folder. The files stay.', { name: str('Folder name'), confirm: bool('Must be true') }, ['name', 'confirm'],
    (c, a) => { mustConfirm(a, 'stop sharing this folder'); return c.call('DELETE', '/api/shares/' + encodeURIComponent(a.name)); }),
  tool('share_user_create', 'Create a user for shared folders. The user name and the password come from the user: never make up a password. Without confirm it only returns the plan.', {
    name: str('User name, lowercase'), password: str('Password the user gave you'), groups: arr('Group names'), confirm: confirmProp(),
  }, ['name', 'password'], (c, a) => {
    askFor([!String(a.name || '').trim() ? 'What should the user be called?' : '', !String(a.password || '') ? 'What password should ' + (a.name || 'the user') + ' get?' : ''].filter(Boolean));
    planFirst(a, 'Create the user "' + a.name + '" with the password the user gave' + (a.groups && a.groups.length ? ', in the groups ' + a.groups.join(', ') : '') + '.');
    return c.call('POST', '/api/share-users', { body: pick(a, ['name', 'password', 'groups']) });
  }),
  tool('share_user_set', 'Change a user\'s groups and folder rights. access values are ro (read only), rw (read and write) or empty (no access). Without confirm it only returns the plan.', {
    name: str('User name'), groups: arr('Group names'), access: obj('Folder name to ro, rw or empty'), confirm: confirmProp(),
  }, ['name'], (c, a) => {
    const access = Object.entries(a.access || {}).map(([f, v]) => f + ': ' + (v === 'rw' ? 'read and write' : v === 'ro' ? 'read only' : 'no access')).join(', ');
    planFirst(a, 'Change the rights of "' + a.name + '"' + (access ? ' (' + access + ')' : '') + (a.groups ? ', groups: ' + either(a.groups, 'none') : '') + '.');
    return c.call('POST', '/api/share-users/' + encodeURIComponent(a.name), { body: pick(a, ['groups', 'access']) });
  }),
  tool('share_user_password', 'Set a user\'s password. The new password comes from the user: never make one up.', { name: str('User name'), password: str('New password the user gave you') }, ['name', 'password'],
    (c, a) => c.call('POST', '/api/share-users/' + encodeURIComponent(a.name) + '/password', { body: { password: a.password } })),
  tool('share_user_delete', 'Delete a shared-folder user.', { name: str('User name'), confirm: bool('Must be true') }, ['name', 'confirm'],
    (c, a) => { mustConfirm(a, 'delete this user'); return c.call('DELETE', '/api/share-users/' + encodeURIComponent(a.name)); }),
  tool('storage', 'Pools, disks, datasets and drive bays.', {}, [], (c) => c.call('GET', '/api/storage')),
  tool('disk_details', 'SMART details of one disk. A sleeping disk stays asleep unless wake is true.', { name: str('Disk name, for example sda'), wake: bool('Wake a sleeping disk') }, ['name'],
    (c, a) => c.call('GET', qpath('/api/disks/' + encodeURIComponent(a.name), { wake: a.wake ? '1' : '' }))),
  tool('pool_options', 'Free disks and pool layouts, before creating a pool.', {}, [], (c) => c.call('GET', '/api/pools/options')),
  tool('pool_create', 'Create a ZFS pool. THIS ERASES THE CHOSEN DISKS. Call pool_options first, show the user which disks (model and size) will be erased and the layout, '
    + 'and ask them to confirm. Only then set confirm to the pool name.', {
    name: str('Pool name'), layout: { type: 'string', enum: ['stripe', 'mirror', 'raidz1', 'raidz2', 'raidz3', 'mirrors'] },
    disks: arr('Disk names'), compression: str('Compression'), confirm: str('The pool name again'), folders: bool('Create the default folders'),
  }, ['name', 'layout', 'disks', 'confirm'], (c, a) => c.call('POST', '/api/pools', { body: pick(a, ['name', 'layout', 'disks', 'compression', 'confirm', 'folders']) })),
  tool('backups', 'Backup connections, tasks and devices.', {}, [], (c) => c.call('GET', '/api/backup')),
  tool('backup_run', 'Run a backup task. dryRun only shows what would happen.', { id: str('Task id'), dryRun: bool('Do not change anything') }, ['id'],
    (c, a) => c.call('POST', '/api/backup/jobs/' + encodeURIComponent(a.id) + '/run', { body: { dryRun: !!a.dryRun } })),
  tool('backup_stop', 'Stop a running backup task.', { id: str('Task id') }, ['id'],
    (c, a) => c.call('POST', '/api/backup/jobs/' + encodeURIComponent(a.id) + '/stop')),
  tool('sysbackups', 'Backups of apps and VMs.', {}, [], (c) => c.call('GET', '/api/sysbackups')),
  tool('sysbackup_run', 'Run a backup of apps and VMs.', { id: str('Task id') }, ['id'],
    (c, a) => c.call('POST', '/api/sysbackups/' + encodeURIComponent(a.id) + '/run')),
  tool('network', 'Network cards, address and DNS.', {}, [], (c) => c.call('GET', '/api/network')),
  tool('network_set', 'Change the server\'s address. A wrong value can make the server unreachable: call network first and ask the user for every value they did not give (a fixed address needs address with prefix, gateway and DNS). '
    + 'It rolls back after 2 minutes unless network_confirm is called. Without confirm it only returns the plan.', {
    interface: str('Network card'), mode: str('dhcp or static'), address: str('Address with prefix, for example 192.168.1.10/24'), gateway: str('Gateway'), dns: str('DNS servers'), bridge: bool('Bridge br0'),
    confirm: confirmProp(),
  }, ['interface', 'mode'], (c, a) => {
    if (a.mode === 'static') askFor([!a.address ? 'Which fixed address, with prefix (for example 192.168.1.10/24)?' : '', !a.gateway ? 'Which gateway (usually the router, for example 192.168.1.1)?' : '', !a.dns ? 'Which DNS servers (for example the router, or 1.1.1.1)?' : ''].filter(Boolean));
    planFirst(a, 'Set ' + a.interface + ' to ' + (a.mode === 'static' ? 'the fixed address ' + a.address + ' (gateway ' + a.gateway + ', DNS ' + a.dns + ')' : 'DHCP (the router chooses the address)') + (a.bridge ? ' with bridge br0' : '') + '. It goes back by itself after 2 minutes unless it is confirmed.');
    return c.call('POST', '/api/network', { body: pick(a, ['interface', 'mode', 'address', 'gateway', 'dns', 'bridge']) });
  }),
  tool('network_confirm', 'Keep a network change. Only after the user said the server is still reachable.', {}, [], (c) => c.call('POST', '/api/network/confirm')),
  tool('network_revert', 'Undo a network change right away.', {}, [], (c) => c.call('POST', '/api/network/revert')),
  tool('docker_networks', 'Docker networks.', {}, [], (c) => c.call('GET', '/api/docker-networks')),
  tool('settings_get', 'Language, clock, terminal, SSH and update channel.', {}, [], (c) => c.call('GET', '/api/settings')),
  tool('settings_set', 'Change settings. Turning the terminal or SSH on, or no longer asking the terminal password, needs the account password.', {
    language: str('Language code'), clock: { type: 'string', enum: ['auto', '24', '12'] }, updateCheck: bool('Check for MajaOS updates'),
    updateChannel: { type: 'string', enum: ['stable', 'beta', 'dev'] }, terminal: bool('Terminal on'), terminalPassword: bool('Ask the password for the terminal'),
    ssh: bool('SSH on'), password: str('Account password, when making security less strict'),
  }, [], (c, a) => c.call('POST', '/api/settings', { body: pick(a, ['language', 'clock', 'updateCheck', 'updateChannel', 'terminal', 'terminalPassword', 'ssh', 'password']) })),
  tool('datetime', 'Date, time and time zone.', {}, [], (c) => c.call('GET', '/api/datetime')),
  tool('ups', 'The UPS through NUT: mains power or battery, charge, time left, load, when the server shuts down, and the log.', {}, [], (c) => c.call('GET', '/api/ups')),
  tool('ai_status', 'Which AI is connected, and its models.', {}, [], (c) => c.call('GET', '/api/ai')),
  tool('power', 'Restart or shut down the server. This happens immediately.', {
    action: { type: 'string', enum: ['reboot', 'shutdown'] }, confirm: bool('Must be true'),
  }, ['action', 'confirm'], (c, a) => {
    if (!['reboot', 'shutdown'].includes(a.action)) throw new Error('Choose reboot or shutdown.');
    mustConfirm(a, a.action + ' the server');
    return c.call('POST', '/api/system/power', { body: { action: a.action } });
  }),
  tool('shell_run', 'Run one root command on the server, like the terminal. Refused while the terminal is off. Send password when Security asks for it.', {
    command: str('The command'), password: str('Account password, when the terminal asks for it'), timeout: num('Milliseconds, at most 120000'),
  }, ['command'], (c, a) => c.call('POST', '/api/terminal/run', { body: pick(a, ['command', 'password', 'timeout']) })),
  tool('api', 'Any other JSON route the web interface uses. path starts with /api/. method is GET, POST, PUT or DELETE.', {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] }, path: str('Path, for example /api/vm-networks'), body: obj('JSON body'), query: obj('Query parameters'),
  }, ['method', 'path'], (c, a) => {
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(a.method)) throw new Error('Use GET, POST, PUT or DELETE.');
    const hit = safeApiPath(a.path, a.query);
    return c.call(a.method, qpath(hit.path, hit.query), { body: a.body });
  }),
];

function publicTool(t) {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

function textResult(text, isError) {
  const out = { content: [{ type: 'text', text: String(text) }] };
  if (isError) out.isError = true;
  return out;
}

async function dispatch(msg, client) {
  if (!msg || msg.jsonrpc !== '2.0' || msg.id === undefined || msg.id === null) return null;
  const id = msg.id;
  try {
    if (msg.method === 'initialize') {
      const asked = msg.params && msg.params.protocolVersion;
      return ok(id, {
        protocolVersion: asked === '2025-03-26' || asked === '2025-06-18' ? asked : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'majaos', version },
        instructions: INSTRUCTIONS,
      });
    }
    if (msg.method === 'ping') return ok(id, {});
    if (msg.method === 'tools/list') return ok(id, { tools: TOOLS.map(publicTool) });
    if (msg.method === 'tools/call') {
      const found = TOOLS.find((t) => t.name === (msg.params && msg.params.name));
      if (!found) return ok(id, textResult('Unknown tool.', true));
      try {
        const data = await found.fn(client, (msg.params && msg.params.arguments) || {});
        return ok(id, textResult(typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
      } catch (e) {
        return ok(id, textResult(e.message || String(e), true));
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message || String(e) } };
  }
}

function ok(id, result) { return { jsonrpc: '2.0', id, result }; }

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]);
}

function createReader(onMessage) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const head = buf.subarray(0, sep).toString('latin1');
        const m = /content-length:\s*(\d+)/i.exec(head);
        if (!m) { buf = buf.subarray(sep + 4); continue; }
        const len = Number(m[1]);
        if (buf.length < sep + 4 + len) return;
        const raw = buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
        buf = buf.subarray(sep + 4 + len);
        let msg = null;
        try { msg = JSON.parse(raw); } catch { msg = null; }
        if (msg) onMessage(msg);
      }
    },
  };
}

class Client {
  constructor({ url, user, password, token, fetchImpl, via = 'mcp' } = {}) {
    this.via = via; // X-MajaOS-Via: the activity log shows "AI" or "MCP"
    this.base = new URL(url || process.env.MAJAOS_URL || 'http://127.0.0.1');
    this.user = user != null ? user : (process.env.MAJAOS_USER || '');
    this.password = password != null ? password : (process.env.MAJAOS_PASSWORD || '');
    const given = String(token != null ? token : (process.env.MAJAOS_TOKEN || '')).replace(/^tb_session=/, '').split(';')[0].trim();
    this.cookie = given ? 'tb_session=' + given : '';
    this.fetchImpl = fetchImpl || null;
    this.ready = null;
  }

  async call(method, path, opts = {}) {
    if (!opts.skipAuth) await this.ensure();
    if (this.fetchImpl) return this.fetchImpl(method, path, opts);
    return this.http(method, path, opts);
  }

  async ensure() {
    if (this.fetchImpl) return;
    if (!this.ready) this.ready = this.login().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async login() {
    const cfg = await this.http('GET', '/api/config');
    if (!cfg.passwordEnabled) return;
    if (this.cookie) return;
    if (!this.password) throw new Error('Set MAJAOS_PASSWORD, or MAJAOS_TOKEN when two-step verification is on.');
    const res = await this.http('POST', '/api/login', { body: { user: this.user, password: this.password, remember: true } });
    if (res && res.mfa) throw new Error('Two-step verification is on. Sign in in the browser, then set MAJAOS_TOKEN to the tb_session cookie.');
  }

  http(method, path, { body, raw } = {}) {
    const lib = this.base.protocol === 'https:' ? https : http;
    const target = new URL(path, this.base);
    const payload = raw != null ? Buffer.from(String(raw)) : (body != null ? Buffer.from(JSON.stringify(body)) : null);
    const headers = { Accept: 'application/json', 'X-MajaOS-Via': this.via || 'mcp' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (payload) {
      headers['Content-Type'] = raw != null ? 'text/plain; charset=utf-8' : 'application/json';
      headers['Content-Length'] = payload.length;
    }
    return new Promise((resolve, reject) => {
      const req = lib.request(target, { method, headers }, (res) => {
        const cookie = res.headers['set-cookie'];
        if (cookie) {
          const hit = (Array.isArray(cookie) ? cookie : [cookie]).map((c) => c.split(';')[0]).find((c) => c.startsWith('tb_session='));
          if (hit && hit !== 'tb_session=') this.cookie = hit;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 500) }; }
          if (res.statusCode >= 400) reject(new Error(((data && data.error) || ('The server answered ' + res.statusCode)) + (data && data.last ? ' Last message: ' + data.last : '')));
          else resolve(data);
        });
      });
      req.on('error', (e) => reject(new Error('Cannot reach ' + this.base.origin + ': ' + e.message)));
      if (payload) req.write(payload);
      req.end();
    });
  }
}

function writeFrame(output, obj) { output.write(encodeFrame(obj)); }

function serve(input = process.stdin, output = process.stdout, client = new Client()) {
  let pending = 0, ended = false;
  const finish = () => { if (ended && pending === 0) output.end(); };
  const reader = createReader((msg) => {
    pending += 1;
    Promise.resolve(dispatch(msg, client)).then((res) => { if (res) writeFrame(output, res); }).catch((e) => {
      process.stderr.write(String(e && e.message || e) + '\n');
    }).finally(() => { pending -= 1; finish(); });
  });
  input.on('data', (chunk) => reader.push(chunk));
  input.on('end', () => { ended = true; finish(); });
}

async function runTool(name, args, client) {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error('Unknown tool.');
  const data = await found.fn(client, args || {});
  return typeof data === 'string' ? data : JSON.stringify(data);
}

module.exports = { mergeAppForm, TOOLS, INSTRUCTIONS, dispatch, runTool, encodeFrame, createReader, safeApiPath, Client, serve };
