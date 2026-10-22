'use strict';
/* Tests voor de installatie-ISO: veiligheid van het preseed-bestand en samenhang van de bestanden. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'iso');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
// preseed: "d-i sleutel type waarde" (opmerkingen en lege regels overslaan)
const preseed = Object.fromEntries(read('preseed.cfg').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => { const [owner, key, type, ...rest] = l.trim().split(/\s+/); return [key, { owner, type, value: rest.join(' ') }]; }));

test('preseed vraagt zelf de schijf, de bevestiging en het wachtwoord', () => {
  // Nooit zelf een schijf kiezen of zonder vragen wissen: er kunnen schijven met data in de server zitten.
  for (const k of ['partman-auto/disk', 'partman/confirm', 'partman/confirm_nooverwrite', 'partman-auto/select_disk']) assert.equal(preseed[k], undefined, k);
  // Geen wachtwoorden in de ISO.
  for (const k of Object.keys(preseed)) assert.ok(!/password/.test(k), k);
  assert.equal(preseed['passwd/root-login'].value, 'false'); // root uit, de gebruiker krijgt sudo
  assert.equal(preseed['passwd/username'].value, 'homebase');
  assert.equal(preseed['debian-installer/locale'].value, 'nl_BE.UTF-8');
  assert.match(preseed['tasksel/first'].value, /ssh-server/);
  assert.equal(preseed['preseed/late_command'].value, 'sh /cdrom/homebaseos/late.sh');
});

test('late.sh, de first-boot-dienst en firstboot.sh passen bij elkaar', () => {
  const late = read('late.sh'), unit = read('homebaseos-firstboot.service'), first = read('firstboot.sh');
  for (const f of ['homebaseos.tar.gz', 'homebaseos-firstboot.service', 'installing.issue']) assert.ok(late.includes(f), f);
  assert.match(late, /homebaseos\.nvidia=1/);
  assert.match(unit, /ExecStart=\/bin\/bash \/opt\/homebaseos-setup\/iso\/firstboot\.sh/);
  assert.match(unit, /ConditionPathExists=\/opt\/homebaseos-setup\/install\.sh/);
  assert.match(first, /install\.sh/);
  assert.match(first, /systemctl disable homebaseos-firstboot\.service/);
  // Het wachtwoord staat apart, zodat server.js het kan weghalen na een eigen wachtwoord.
  assert.match(first, /homebaseos-wachtwoord\.issue/);
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').includes('/etc/issue.d/homebaseos-wachtwoord.issue'));
  // De bouwscript kopieert alles wat late.sh van /cdrom/homebaseos gebruikt.
  const build = read('build-iso.sh');
  for (const f of ['late.sh', 'homebaseos-firstboot.service', 'installing.issue']) assert.ok(build.includes('"$HERE/' + f + '"'), f);
});
