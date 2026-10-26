'use strict';
/*
 * Model Context Protocol (stdio, Content-Length frames) over the HomeBaseOS API.
 * No dependencies: JSON-RPC 2.0, initialize, tools/list and tools/call.
 */
const http = require('node:http');
const https = require('node:https');
const { version } = require('../package.json');

const INSTRUCTIONS = 'You are managing a HomeBaseOS home server through its own API. '
  + 'Use the specific tools for apps, VMs, files, shares, storage, backups, network, settings and AI. '
  + 'The api tool reaches any other /api path the web interface uses. '
  + 'Tools that delete, reboot or shut down need confirm set to true. '
  + 'shell_run is a root command on the server, the same switch and password as the terminal in Settings → Security.';

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
  if (args.confirm !== true) throw new Error('Set confirm to true to ' + what + '.');
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
  tool('app_action', 'Start, stop, restart or update an app.', {
    id: str('Container id or name'),
    action: { type: 'string', enum: ['start', 'stop', 'restart', 'update'], description: 'What to do' },
  }, ['id', 'action'], (c, a) => {
    if (!['start', 'stop', 'restart', 'update'].includes(a.action)) throw new Error('Unknown action.');
    return c.call('POST', '/api/apps/' + encodeURIComponent(a.id) + '/' + a.action);
  }),
  tool('app_remove', 'Remove an app. The files stay unless data is true.', {
    id: str('Container id or name'), data: bool('Also delete its data folder'), confirm: bool('Must be true'),
  }, ['id', 'confirm'], (c, a) => { mustConfirm(a, 'remove this app'); return c.call('DELETE', qpath('/api/apps/' + encodeURIComponent(a.id), { data: a.data ? '1' : '' })); }),
  tool('app_settings_get', 'Settings and compose form of one app.', { id: str('Container id or name') }, ['id'],
    (c, a) => c.call('GET', '/api/apps/' + encodeURIComponent(a.id) + '/settings')),
  tool('app_settings_set', 'Web address, icon and automatic start of an app.', {
    id: str('Container id or name'), webui: str('Web address, with [IP] and [PORT:n]'), icon: str('Icon URL'), autoStart: bool('Start with Docker'),
  }, ['id'], (c, a) => c.call('POST', '/api/apps/' + encodeURIComponent(a.id) + '/settings', { body: pick(a, ['webui', 'icon', 'autoStart']) })),
  tool('app_exec', 'Run one command inside an app container.', {
    id: str('Container id or name'), cmd: str('The command'), cwd: str('Folder inside the container'),
  }, ['id', 'cmd'], (c, a) => c.call('POST', '/api/apps/' + encodeURIComponent(a.id) + '/exec', { body: pick(a, ['cmd', 'cwd']) })),
  tool('app_inspect', 'Read an image (ports, folders, suggested name) before installing your own app.', { image: str('Image name or link') }, ['image'],
    (c, a) => c.call('POST', '/api/apps/custom/inspect', { body: { image: a.image } })),
  tool('app_install', 'Install your own app from an image. Call app_inspect first and reuse its suggestions.', {
    name: str('Lowercase name'), image: str('Image'), restart: str('no, always, on-failure or unless-stopped'),
    privileged: bool('Privileged container'), network: str('bridge, host, none, a network name, or @lan'), ip: str('Fixed address'),
    ports: arr('[{host, container, protocol}]'), volumes: arr('[{host, container}]'), env: obj('Environment variables'),
    devices: arr('Device paths'), webui: str('Web address'), icon: str('Icon URL'),
  }, ['name', 'image'], (c, a) => c.call('POST', '/api/apps/custom', { body: pick(a, ['name', 'image', 'restart', 'privileged', 'network', 'ip', 'ports', 'volumes', 'env', 'devices', 'webui', 'icon']) })),
  tool('app_compose', 'Install exactly this compose file.', { name: str('Lowercase name'), text: str('compose.yaml contents') }, ['name', 'text'],
    (c, a) => c.call('POST', '/api/apps/compose', { body: { name: a.name, text: a.text } })),
  tool('store_list', 'App store catalogue.', { refresh: bool('Fetch the catalogue again') }, [],
    (c, a) => c.call('GET', qpath('/api/store', { refresh: a.refresh ? '1' : '' }))),
  tool('store_app', 'One catalogue app, with its fields.', { id: str('Catalogue id') }, ['id'],
    (c, a) => c.call('GET', '/api/store/apps/' + encodeURIComponent(a.id))),
  tool('store_install', 'Install an app from the catalogue.', {
    id: str('Catalogue id'), name: str('Lowercase name'), values: obj('Field key to value'), network: str('Network'), ip: str('Fixed address'), extraPorts: arr('Extra ports'),
  }, ['id', 'name'], (c, a) => c.call('POST', '/api/store/apps/' + encodeURIComponent(a.id) + '/install', { body: pick(a, ['name', 'values', 'network', 'ip', 'extraPorts']) })),
  tool('job_status', 'Progress of an install or update.', { id: str('Job id') }, ['id'],
    (c, a) => c.call('GET', '/api/store/jobs/' + encodeURIComponent(a.id))),
  tool('vms_list', 'Virtual machines.', {}, [], (c) => c.call('GET', '/api/vms')),
  tool('vm_get', 'One VM: disks, network cards, boot, USB and PCI.', { id: str('VM name') }, ['id'],
    (c, a) => c.call('GET', '/api/vms/' + encodeURIComponent(a.id))),
  tool('vm_options', 'What you can choose when creating a VM: ISOs, networks, USB, PCI, CPU.', {}, [], (c) => c.call('GET', '/api/vm-options')),
  tool('vm_create', 'Create a VM. kind is linux, windows or import.', {
    name: str('VM name'), kind: { type: 'string', enum: ['linux', 'windows', 'import'] }, source: str('ISO or disk image name'),
    vcpus: num('vCPUs'), memoryGb: num('Memory in GB'), diskGb: num('Disk in GB'),
    network: str('network:<name> or bridge:<name>'), description: str('Description'), autostart: bool('Start with the server'), delay: num('Start delay in seconds'),
  }, ['name', 'kind'], (c, a) => c.call('POST', '/api/vms', { body: pick(a, ['name', 'kind', 'source', 'vcpus', 'memoryGb', 'diskGb', 'network', 'description', 'autostart', 'delay']) })),
  tool('vm_action', 'Start, stop, reboot, pause, resume, force-stop or reset a VM.', {
    id: str('VM name'), action: { type: 'string', enum: ['start', 'stop', 'reboot', 'pause', 'resume', 'force-stop', 'reset'] },
  }, ['id', 'action'], (c, a) => {
    if (!['start', 'stop', 'reboot', 'pause', 'resume', 'force-stop', 'reset'].includes(a.action)) throw new Error('Unknown action.');
    return c.call('POST', '/api/vms/' + encodeURIComponent(a.id) + '/' + a.action);
  }),
  tool('vm_settings', 'Change a VM. Only send the fields you want to change.', {
    id: str('VM name'), name: str('New name'), vcpus: num('vCPUs'), memoryGb: num('Memory in GB'), description: str('Description'),
    autostart: bool('Start with the server'), delay: num('Start delay'), clipboard: bool('Clipboard channel'),
    nics: arr('Network cards'), boot: str('disk or cdrom'), hostdevs: arr('usb:vvvv:pppp or pci:0000:0a:00.0'), cpuPins: arr('Pinned cores'),
    addDisks: arr('[{sizeGb, bus}]'), resizeDisks: arr('[{target, sizeGb}]'), removeDisks: arr('Disk targets'), cdrom: str('ISO name, empty to eject'),
  }, ['id'], (c, a) => c.call('POST', '/api/vms/' + encodeURIComponent(a.id) + '/settings', { body: pick(a, ['name', 'vcpus', 'memoryGb', 'description', 'autostart', 'delay', 'clipboard', 'nics', 'boot', 'hostdevs', 'cpuPins', 'addDisks', 'resizeDisks', 'removeDisks', 'cdrom']) })),
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
  tool('share_save', 'Create or change a shared folder. create.parent makes a new dataset.', {
    name: str('Folder name'), path: str('Existing folder'), create: obj('{parent: pool name}'), comment: str('Comment'),
    users: obj('User name to ro or rw'), groups: obj('Group name to ro or rw'), guest: bool('Allow guests'), timemachine: bool('Time Machine'),
  }, ['name'], (c, a) => c.call('POST', '/api/shares', { body: pick(a, ['name', 'path', 'create', 'comment', 'users', 'groups', 'guest', 'timemachine']) })),
  tool('share_delete', 'Stop sharing a folder. The files stay.', { name: str('Folder name'), confirm: bool('Must be true') }, ['name', 'confirm'],
    (c, a) => { mustConfirm(a, 'stop sharing this folder'); return c.call('DELETE', '/api/shares/' + encodeURIComponent(a.name)); }),
  tool('share_user_create', 'Create a user for shared folders.', { name: str('User name'), password: str('Password'), groups: arr('Group names') }, ['name', 'password'],
    (c, a) => c.call('POST', '/api/share-users', { body: pick(a, ['name', 'password', 'groups']) })),
  tool('share_user_set', 'Change a user\'s groups and folder rights. access values are ro, rw or empty.', {
    name: str('User name'), groups: arr('Group names'), access: obj('Folder name to ro, rw or empty'),
  }, ['name'], (c, a) => c.call('POST', '/api/share-users/' + encodeURIComponent(a.name), { body: pick(a, ['groups', 'access']) })),
  tool('share_user_password', 'Set a user\'s password.', { name: str('User name'), password: str('New password') }, ['name', 'password'],
    (c, a) => c.call('POST', '/api/share-users/' + encodeURIComponent(a.name) + '/password', { body: { password: a.password } })),
  tool('share_user_delete', 'Delete a shared-folder user.', { name: str('User name'), confirm: bool('Must be true') }, ['name', 'confirm'],
    (c, a) => { mustConfirm(a, 'delete this user'); return c.call('DELETE', '/api/share-users/' + encodeURIComponent(a.name)); }),
  tool('storage', 'Pools, disks, datasets and drive bays.', {}, [], (c) => c.call('GET', '/api/storage')),
  tool('disk_details', 'SMART details of one disk. A sleeping disk stays asleep unless wake is true.', { name: str('Disk name, for example sda'), wake: bool('Wake a sleeping disk') }, ['name'],
    (c, a) => c.call('GET', qpath('/api/disks/' + encodeURIComponent(a.name), { wake: a.wake ? '1' : '' }))),
  tool('pool_options', 'Free disks and pool layouts, before creating a pool.', {}, [], (c) => c.call('GET', '/api/pools/options')),
  tool('pool_create', 'Create a ZFS pool. confirm must be the pool name.', {
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
  tool('network_set', 'Change the address. It rolls back after 2 minutes unless network_confirm is called.', {
    interface: str('Network card'), mode: str('dhcp or static'), address: str('Address with prefix'), gateway: str('Gateway'), dns: str('DNS servers'), bridge: bool('Bridge br0'),
  }, ['interface', 'mode'], (c, a) => c.call('POST', '/api/network', { body: pick(a, ['interface', 'mode', 'address', 'gateway', 'dns', 'bridge']) })),
  tool('network_confirm', 'Keep a network change.', {}, [], (c) => c.call('POST', '/api/network/confirm')),
  tool('network_revert', 'Undo a network change right away.', {}, [], (c) => c.call('POST', '/api/network/revert')),
  tool('docker_networks', 'Docker networks.', {}, [], (c) => c.call('GET', '/api/docker-networks')),
  tool('settings_get', 'Language, clock, terminal, SSH and update channel.', {}, [], (c) => c.call('GET', '/api/settings')),
  tool('settings_set', 'Change settings. Turning the terminal or SSH on, or no longer asking the terminal password, needs the account password.', {
    language: str('Language code'), clock: { type: 'string', enum: ['auto', '24', '12'] }, updateCheck: bool('Check for HomeBaseOS updates'),
    updateChannel: { type: 'string', enum: ['stable', 'beta', 'dev'] }, terminal: bool('Terminal on'), terminalPassword: bool('Ask the password for the terminal'),
    ssh: bool('SSH on'), password: str('Account password, when making security less strict'),
  }, [], (c, a) => c.call('POST', '/api/settings', { body: pick(a, ['language', 'clock', 'updateCheck', 'updateChannel', 'terminal', 'terminalPassword', 'ssh', 'password']) })),
  tool('datetime', 'Date, time and time zone.', {}, [], (c) => c.call('GET', '/api/datetime')),
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
        serverInfo: { name: 'homebaseos', version },
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
  constructor({ url, user, password, token, fetchImpl } = {}) {
    this.base = new URL(url || process.env.HOMEBASEOS_URL || 'http://127.0.0.1');
    this.user = user != null ? user : (process.env.HOMEBASEOS_USER || '');
    this.password = password != null ? password : (process.env.HOMEBASEOS_PASSWORD || '');
    const given = String(token != null ? token : (process.env.HOMEBASEOS_TOKEN || '')).replace(/^tb_session=/, '').split(';')[0].trim();
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
    if (!this.password) throw new Error('Set HOMEBASEOS_PASSWORD, or HOMEBASEOS_TOKEN when two-step verification is on.');
    const res = await this.http('POST', '/api/login', { body: { user: this.user, password: this.password, remember: true } });
    if (res && res.mfa) throw new Error('Two-step verification is on. Sign in in the browser, then set HOMEBASEOS_TOKEN to the tb_session cookie.');
  }

  http(method, path, { body, raw } = {}) {
    const lib = this.base.protocol === 'https:' ? https : http;
    const target = new URL(path, this.base);
    const payload = raw != null ? Buffer.from(String(raw)) : (body != null ? Buffer.from(JSON.stringify(body)) : null);
    const headers = { Accept: 'application/json' };
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
          if (res.statusCode >= 400) reject(new Error((data && data.error) || ('The server answered ' + res.statusCode)));
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

module.exports = { TOOLS, dispatch, encodeFrame, createReader, safeApiPath, Client, serve };
