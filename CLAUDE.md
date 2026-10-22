# Thuisbasis

Een eenvoudig beheersysteem voor een thuisserver in de stijl van ZimaOS/HexOS. Het draait als root (systemd-service) op **Debian 13** en beheert **ZFS**, **KVM/libvirt** en **Docker** rechtstreeks, plus optioneel **Ollama**. Unraid wordt niet meer gebruikt.

## De situatie van de eigenaar

- Nieuwe thuisserver "Freddy": Ryzen 7 5700X + B550/X570 met ECC, 32 GB DDR4 ECC UDIMM, RTX 3060 Ti (8 GB), 2.5G-netwerk (later 10G).
- Schijven: 4× 2 TB HDD en 2× 512 GB SSD (bedoeld als raidz1-pool `tank` en mirror `snel`).
- Ongeveer 20 Docker-containers (Compose) en één VM met **Home Assistant OS**. Ollama draait als container met de GPU.
- De eigenaar ontwikkelt op **macOS** in VS Code en spreekt **Nederlands (Vlaams)**.

## Architectuur

- `server.js`: Node 18.11+, **geen dependencies** (alleen ingebouwde modules). Serveert `public/`, een JSON-API onder `/api/*`, auth en de Ollama-proxy. Start niet zonder `APP_PASSWORD` (behalve in de demo). Start na het opstarten `vms.bootAutostart()`.
- `lib/system.js`: `run()` (execFile zonder shell, `LC_ALL=C`, foutmelding uit stderr), CPU/RAM uit `/proc` (ZFS-ARC telt niet als gebruikt), uptime, OS-naam, `nvidia-smi`.
- `lib/docker.js`: Docker-API via `/var/run/docker.sock`. Eigen instellingen per app (WebUI-adres met `[IP]`/`[PORT:n]`, pictogram) in `DATA_DIR/apps.json` op containernaam, zodat ze een herstart of update overleven. De console draait elk commando apart via `docker exec … sh -c EXEC_SCRIPT` en geeft de map terug achter `\n\x01`. Logs worden gedemultiplext. *Bijwerken* = `docker compose pull` + `up -d` op basis van de compose-labels. Eigen labels: `thuisbasis.icon`, `thuisbasis.webui`. Updates: `checkUpdates` vergelijkt de digests van het lokale image (`RepoDigests`) met de digest van de tag in de registry (`lib/registry.js`, HEAD op `/v2/<repo>/manifests/<tag>`, anoniem token via WWW-Authenticate). Resultaat per image-ref in `DATA_DIR/updates.json`; 2 min na de start en elke 6 uur, of meteen via `/api/apps/check-updates`. Na Bijwerken wordt dat image opnieuw gecontroleerd.
- `lib/xml.js`: kleine XML-lezer/-schrijver voor libvirt-XML. Behoudt volgorde, witruimte en opmerkingen (ongewijzigd lezen en schrijven = exact hetzelfde); `append` springt nieuwe elementen netjes in.
- `lib/vmhw.js`: hardware van een VM in de domein-XML. `parseHardware` (nics, disks, cdroms, boot, hostdevs als `usb:vvvv:pppp`/`pci:0000:0a:00.0`, cpuPins), `applyHardware` (alleen wat in `change` staat: netwerkkaarten op MAC, schijven toevoegen/loskoppelen, cd-rom met eventueel een nieuw SATA-station, opstarten via `<boot order>` per apparaat, hostdevs, `cputune/vcpupin`, klembordkanaal `qemu-vdagent`), `validateHardware` tegen de opties van de server. Kaarten van een ander type (bv. `direct`) krijgen `locked`. Apparaten van de server: `lsusb` (zonder hubs), `/sys/bus/pci` + `lspci -Dmm` (IOMMU-groep, driver), CPU-topologie uit `/sys/devices/system/cpu`.
- `lib/vmnet.js`: VM-netwerken. libvirt-netwerken (`net-list/net-dumpxml/net-info`, aanmaken als NAT of afgeschermd met DHCP in de tweede helft van het subnet, `net-define` + `net-autostart` + `net-start`) en de bridges van de server. Verwijderen alleen als geen VM het gebruikt; subnet moet privé zijn en mag niet overlappen met de server (ook docker0/virbr).
- `lib/websocket.js`: minimale WebSocket-server (RFC 6455) die de console (noVNC) doorgeeft aan het VNC-scherm van QEMU op 127.0.0.1. `server.js` doet de upgrade op `/api/vms/:id/vnc` met dezelfde aanmelding en oorsprongcontrole.
- `public/console.html` + `public/console.js`: console (`console.html#<naam>`) met noVNC uit `public/vendor/novnc` (1.7.0, ongewijzigd, MPL-2.0; alleen `core/` en `vendor/pako`). Opent in Thuisbasis als iframe in `#conWin` (`openConsole`); *Los venster* opent hetzelfde adres met `window.open` als popup en roept `TB_closeConsole` van de ouder op. Ctrl+Alt+Del, tekst typen, passend/ware grootte, volledig scherm. **Plakken**: Cmd/Ctrl+V wordt in de capture-fase tegengehouden voor noVNC, de focus gaat even naar een onzichtbaar tekstvak (`#cPasteSink`) zodat het paste-event in elke browser komt, en de tekst wordt letter per letter als keysyms getypt (+ `clipboardPasteFrom`). **Kopiëren uit de VM**: het `clipboard`-event van noVNC (vraagt `qemu-vdagent` + spice-vdagent in de gast) → `navigator.clipboard` als dat mag (https), anders een knop met `execCommand('copy')`. In de demo een nagebootst scherm.
- `lib/vms.js`: libvirt via `virsh -c qemu:///system`. Lijst uit `virsh domstats` (CPU% = delta `cpu.time` t.o.v. de eigen vCPU's, RAM uit balloon-statistieken). Bewerken = domein-XML aanpassen (`editDomainXml` + `vmhw.applyHardware`) + `virsh define` (met `--security-info`, anders verdwijnt het VNC-wachtwoord). Nieuwe schijven met `qemu-img create` in `VM_DIR/<naam>/`, groter maken met `qemu-img resize` (uit) of `virsh blockresize` (aan); een ISO wisselen gaat bij een draaiende VM ook live (`change-media`). Met vaste kernen volgt het aantal vCPU's uit de kernen. Aanmaken met `virt-install` (UEFI, host-passthrough, VNC met wachtwoord). Verwijderen = `undefine --nvram`; schijven alleen wissen binnen `VM_DIR`. Automatisch starten + uitstel staat in `DATA_DIR/vms.json`; de libvirt-autostart wordt dan uitgezet. Merkteken in `/run/thuisbasis` voorkomt dubbel starten.
- `lib/appstore.js`: catalogus uit de feed van Unraid Community Apps (`applicationFeed.json`, cache 24 u in `DATA_DIR/appstore.json`). `normalizeFeed` haalt plugins/deprecated/blacklist weg, ruimt BBCode op en berekent populariteit (één template per image, naam moet bij het image passen) en `featured`. `prepareFields` vertaalt Unraid-paden (`PATH_MAP`), 99:100 → `APP_UID:APP_GID`, `TZ`, en vult een leeg `/config` met `APPDATA_DIR/<naam>` (`auto: true`). `buildCompose` maakt `compose.yaml` (eigen YAML-schrijver: strings als JSON) met labels `thuisbasis.store`, `thuisbasis.data`, `thuisbasis.icon`, `thuisbasis.webui`. `iconFor` geeft apps zonder label `thuisbasis.icon` een pictogram: eerst uit de catalogus (zelfde image), anders uit dashboard-icons op naam (één keer gecontroleerd, onthouden in `DATA_DIR/icons.json`). Installeren = taak (`jobs`) die `docker compose pull` + `up -d` draait in `STACKS_DIR/<naam>`, en bij een fout opruimt. Netwerk: `templateNetwork` (bv. `br0`) wordt voorgesteld als zo'n Docker-netwerk bestaat; de gebruiker kiest bij installeren `network` + `ip`, en kan `extraPorts` toevoegen. Poortvelden zijn altijd bewerkbaar: wie bij host of een eigen adres een poort aanpast, krijgt in de browser automatisch het standaardnetwerk (bridge). Bij macvlan/ipvlan (eigen adres) komen er geen poorten op de server en vult `webui()` in `lib/docker.js` het eigen adres in voor `[IP]` en de poort van de app voor `[PORT:n]`.
- `lib/composeform.js`: compose-bestand als formulier (zoals het containerformulier van Unraid). `docker compose config --no-interpolate --no-normalize --no-path-resolution --format json` leest het bestand, `serviceForm` maakt er velden van (image, restart, netwerk, privileged, ports, volumes, env, devices, labels), `applyServiceForm` schrijft ze terug in alleen die dienst. Netwerk: `network` is `''` (standaard), `host`, `none`, de naam van één eigen netwerk (met optioneel `ip` → `ipv4_address`) of `*` (meerdere netwerken: blijven ongewijzigd). Een netwerk dat niet in het bestand staat, komt erbij als `external: true`; externe netwerken die geen dienst meer gebruikt, verdwijnen. `appSettings` geeft de keuzes mee in `compose.dockerNetworks`. Ingewikkelde koppelingen (tmpfs, propagation, poorten met onbekende sleutels) krijgen `locked` en blijven ongewijzigd. Poorten met `mode: host` zijn wel bewerkbaar en worden in de lange schrijfwijze teruggeschreven. Alles wat het formulier niet kent, blijft staan. Het bestand wordt opnieuw geschreven met `lib/yaml.js` (opmerkingen verdwijnen, `.bak` blijft).
- `lib/yaml.js`: kleine YAML-schrijver (strings als JSON; null, `{}` en `[]` blijven behouden).
- `lib/settings.js`: algemene instellingen in `DATA_DIR/settings.json` (nu de taal; geldt voor iedereen, staat ook in `/api/config`). Het thema bewaart de browser zelf (`localStorage`).
- `lib/about.js`: Over-pagina: DMI (`/sys/class/dmi/id`), ECC (`/sys/devices/system/edac`), GPU, versies van Docker, Compose, ZFS, libvirt en QEMU.
- `lib/dockernet.js`: Docker-netwerken via de Docker-API (`docker()` uit `lib/docker.js`, dat nu ook een JSON-body meestuurt). Bridge, macvlan en ipvlan (`ipvlan_mode: l2`). `validateNetwork` controleert naam, subnet/gateway/IP-bereik (CIDR-rekenwerk zonder dependency), de ouderkaart (uit `ip -j -d addr`) en overlap met bestaande netwerken en, voor een bridge, met het thuisnetwerk. Eigen netwerken krijgen label `thuisbasis=1`. Verwijderen alleen als er geen containers in zitten; de ingebouwde (bridge/host/none) nooit. `resolveNetwork` en `checkIp` gebruikt de appstore voor de netwerkkeuze bij installeren.
- `lib/network.js`: netwerk bekijken (`ip -j -d addr`, `ip -j route`) en aanpassen via ifupdown (`/etc/network/interfaces`): kaart, DHCP of vast adres, gateway, DNS, bridge `br0`. Toepassen maakt een reservekopie in `DATA_DIR/netwerk-vorige`, herlaadt (`ifdown`/`ifup`) en zet na 2 minuten zonder bevestiging alles terug. Andere `iface`-blokken blijven ongewijzigd. Hostnaam via `hostnamectl` (meteen, zonder bevestiging).
- `lib/bays.js`: schijfbays (welke schijf in welke bay van de kast zit) in `DATA_DIR/bays.json`: {count, columns, m2, ssd, slots {"<bay>", "m<sleuf>" of "s<sleuf>": {key, label}}}; `m2` = aantal M.2-sleuven voor NVMe en `ssd` = aantal 2,5"-sleuven, in dezelfde `slots` met sleutels m1…/s1…. Standaard staan alle bays op één rij (columns = aantal bays, max 12). Het opslagvenster krijgt de klasse `win-wide` (12 bays naast elkaar, de kast in het midden); `openWindow` haalt die weer weg. Een schijf heet `s:<serienummer>` (anders `n:<naam>`), zodat de indeling klopt als sda/sdb wisselt; `label` bewaart model + serienummer voor als de schijf weg is. In de browser: `mountBays` in het opslagvenster, getekend als NAS-kast (lades met ventilatie, greep, statuslampje en labels voor pool en temperatuur; kleuren via de tokens `--nas-*`, `--led-off` en `--pool-1..5`). Slepen, of tikken op een schijf en dan op een bay; op een volle bay wisselen ze. Nog eens op de gekozen bay klikken sluit het paneel.
- `lib/zpool.js`: pool aanmaken. `poolOptions` (lsblk met partities, `zpool status -LP`, `/proc/swaps`, `/dev/disk/by-id`) markeert per schijf `available`/`reason` (in pool, systeemschijf, gekoppeld, swap) en `warn` (oude partities of ZFS-label: worden gewist). `capacity(layout, sizes)` (bruikbaar, bescherming, ongebruikt door de kleinste schijf, ~3% slop, aantal schijven dat mag uitvallen) staat ook als `poolCapacity` in `app.js`: hou ze gelijk. `buildCreate` controleert alles (ook `confirm` = naam) en maakt `zpool create -f -o ashift=12 [-o autotrim=on] -O compression=… -O atime=off -O xattr=sa -O acltype=posixacl -m /<naam>` met by-id-paden; mirror-paren worden groot bij groot gekoppeld.
- `lib/disks.js`: details van één schijf (`smartctl -a -j`, met `-n standby` tenzij `wake`): model, serienummer, firmware, aan-uren, keer aangezet, temperatuur, toerental, aansluiting, belangrijke sectortellers (5, 197, 198, 187, 199, 188), NVMe-slijtage/reserve/geschreven, zelftesten (ook een lopende) en alle attributen. Zelftest starten met `smartctl -t short|long`. Alleen schijven die lsblk kent. In de browser: klik op een bay → paneel naast de kast (`renderPanel` in `mountBays`), ververst elke 10 s zolang een test loopt.
- `lib/storage.js`: `zpool list/status -LP`, `zfs list -Hp`, `lsblk -J`, `smartctl -n standby -j` (slapende HDD's niet wekken).
- `public/index.html`, `public/style.css`, `public/app.js`: vanilla HTML/CSS/JS, geen build-stap. Apps: linksklik opent de WebUI (`openAppUrl`), rechtsklik of ⋯ opent het menu (`openAppMenu`, toetsenbord: pijltjes/Home/End/Escape) met acties, logboek, console en instellingen. De VM-pagina staat op `#vms` en de appstore op `#store` (hash-routing via `route()`), de rest zijn vensters (`openWindow`). Instellingen is een eigen venster met zijbalk (`#setWin`, zoals Systeeminstellingen op macOS): `#settings`, `#settings/network`, `#settings/docker` (Docker-netwerken), `#settings/vmnet` (VM-netwerken) en `#settings/about` openen het boven de pagina die in `pageHash` onthouden wordt. Sluiten gaat altijd via `closeSettings()`, dat het adres meteen herstelt.
- `public/demo.js`: een **demo-adapter in de browser** die exact dezelfde endpoints en antwoordvormen nabootst als `server.js`. **Pas bij elke wijziging aan een endpoint ook `demo.js` aan**, anders breekt de demo.
- `install.sh` + `deploy/thuisbasis.service` + `deploy/thuisbasis.env`: installatie op een kale Debian 13 (contrib/non-free aan, ZFS-DKMS, libvirt, Docker uit de officiële bron, optioneel `--nvidia`). App in `/opt/thuisbasis`, config in `/etc/thuisbasis/thuisbasis.env`.
- `test/parsers.test.js`: tests (`node:test`) voor alle parsers met voorbeelduitvoer van de echte tools.

### Endpoints

| Methode | Pad | Doel |
|---|---|---|
| GET | `/api/config` | demo, passwordEnabled, needsLogin, ollama, language |
| POST | `/api/login`, `/api/logout` | aanmelden/afmelden |
| GET/POST | `/api/settings` | {language: nl\|en} |
| GET | `/api/about` | hostname, os, kernel, arch, uptime, timezone, cpu, memory, ecc, board, gpus, addresses, versions |
| GET | `/api/network` | hostname, manager, editable, links, physical, config {interface, mode, address, gateway, dns, bridge}, dns, pending |
| POST | `/api/network` | toepassen {interface, mode, address, gateway, dns, bridge} → {pending: {until}, address} |
| POST | `/api/network/confirm`, `/api/network/revert` | bevestigen of meteen terugzetten |
| POST | `/api/network/hostname` | {hostname} |
| GET | `/api/docker-networks` | networks (id, name, driver, builtin, internal, subnet, gateway, ipRange, parent, compose, ours, containers [{name, ip}]), parents (name, kind, address, subnet, gateway) |
| POST | `/api/docker-networks` | aanmaken {name, driver: bridge\|macvlan\|ipvlan, subnet, gateway, ipRange, parent, internal} → {id, name} |
| DELETE | `/api/docker-networks/:name` | verwijderen (alleen als geen app het gebruikt) → {removed} |
| GET | `/api/overview` | hostname, uptime, version (OS), cpu, memory, storage (health/total/used/free/pools), gpu |
| GET | `/api/apps` | containers (id, name, image, state, status, autoStart, icon, webui, ports, compose, canUpdate, update: true/false/null, updateChecked, updateError, storeId, dataDirs) |
| GET | `/api/apps/:id/logs?tail=` | logregels |
| POST | `/api/apps/:id/(start\|stop\|restart\|update)` | containeracties |
| POST | `/api/apps/check-updates` | alle images nu controleren → {checked, updates, errors} |
| GET | `/api/apps/:id/settings` | name, image, ports, autoStart, restartPolicy, webui/webuiDefault/webuiAuto, icon/iconDefault, compose {project, service, files, file, workingDir, editable, text, form (zie `serviceForm`) of formError} |
| POST | `/api/apps/:id/settings` | {webui, icon, autoStart}: eigen adres en pictogram (in `DATA_DIR/apps.json`, op containernaam) + `docker update --restart` |
| POST | `/api/apps/:id/compose` | {text}: eerst `docker compose config -q`, dan `.bak` en `up -d` → {ok, backup} |
| POST | `/api/apps/:id/compose-form` | {form}: de dienst van deze app aanpassen via het formulier (`applyServiceForm`), daarna hetzelfde als `/compose` |
| POST | `/api/apps/:id/exec` | {cmd, cwd} → {output, cwd, exitCode}: één commando met sh in de container (`EXEC_SCRIPT`, geen TTY) |
| DELETE | `/api/apps/:id?data=1` | app uit de appstore verwijderen (compose down + map), optioneel met gegevens → {removed, kept} |
| GET | `/api/store?refresh=1` | catalogus: updated, fetched, error, source, count, categories, apps (id, name, image, icon, summary, categories, maintainer, popularity, featured, official, beta, installed) |
| GET | `/api/store/apps/:id` | details + networks, networkDefault, templateNetwork, fields (key, type, name, target, value, mode, description, required, mask, advanced, options, auto), warnings, suggestedName, appdataDir, sharesDir, stacksDir, installed, appdataMissing |
| POST | `/api/store/apps/:id/install` | {name, values: {key: waarde}, network, ip, extraPorts [{host, container, protocol}]} → {job, name, file, warnings} |
| GET | `/api/store/jobs/:id` | {done, ok, error, name, webui, lines} |
| GET | `/api/vms` | VM's (id = naam, state, vcpus, memory, memUsed, cpu, autostart, delay, startsAt, description) |
| POST | `/api/vms` | VM aanmaken {name, kind: linux\|windows\|import, source, vcpus, memoryGb, diskGb, network: network:<naam>\|bridge:<naam>, description, autostart, delay} |
| GET | `/api/vms/:id` | details: + firmware, vnc {port, password}, disks, cdroms, cdromDrive, nics, boot, hostdevs, cpuPins, clipboard |
| POST | `/api/vms/:id/settings` | bewerken {name, vcpus, memoryGb, description, autostart, delay, clipboard, nics [{id, type, source, model, mac} of {id, locked}], cdrom (ISO-naam, '' of '='), boot: disk\|cdrom, hostdevs, cpuPins, addDisks [{sizeGb, bus}], resizeDisks [{target, sizeGb}], removeDisks [target]} → {name, restartNeeded} |
| WS | `/api/vms/:id/vnc` | WebSocket naar het VNC-scherm (console) |
| GET | `/api/vm-networks` | networks (name, mode, bridge, address, subnet, dhcp, active, autostart, builtin, vms), bridges (name, address, up, vms) |
| POST | `/api/vm-networks` | aanmaken {name, mode: nat\|isolated, subnet, dhcp} → {name} |
| POST | `/api/vm-networks/:name/start` | starten (en automatisch starten aanzetten) |
| DELETE | `/api/vm-networks/:name` | verwijderen (alleen als geen VM het gebruikt) |
| DELETE | `/api/vms/:id?disks=1` | verwijderen (alleen als hij uit staat) → {removed, kept} |
| POST | `/api/vms/:id/(start\|stop\|reboot\|pause\|resume\|force-stop\|reset)` | VM-acties |
| GET | `/api/vm-options` | isos, images, isoDir, vmDir, *Missing, network (standaard, bv. `bridge:br0`), maxVcpus, maxMemory, networks, bridges, usb, pci, iommu, cpus |
| GET | `/api/storage` | health, total/used/free, pools (layout, scrub), disks (key, pool, role, temp, smartOk, sectors {reallocated, pending, uncorrectable}), datasets, zfsError, bays |
| GET | `/api/disks/:name?wake=1` | details uit smartctl (sleeping: true als de schijf slaapt en wake ontbreekt) |
| POST | `/api/disks/:name/test` | {type: short\|long} → {started, minutes} |
| GET | `/api/pools/options` | disks (name, size, model, serial, rotational, transport, byId, available, reason, warn), pools, layouts, compression |
| POST | `/api/pools` | {name, layout: stripe\|mirror\|raidz1\|raidz2\|raidz3\|mirrors, disks [namen], compression, confirm: naam} → {name} |
| POST | `/api/bays` | {count, columns, m2, ssd, slots {"<bay>"\|"m<sleuf>"\|"s<sleuf>": {key, label}}} → opgeslagen indeling |
| GET | `/api/ai` | Ollama-versie, GPU, modellen |
| POST | `/api/ai/pull`, `/api/ai/chat` | NDJSON-stream |
| POST | `/api/ai/models/:name/(load\|unload)` | model laden/ontladen |
| DELETE | `/api/ai/models/:name` | model verwijderen |

## Werkafspraken

- **Alle tekst in de interface is Nederlands (Vlaams)**: korte, gewone zinnen, actieve werkwoorden, foutmeldingen die zeggen wat er mis is en wat je kan doen.
- **Meertalig (nl + en)**: de Nederlandse tekst is de sleutel. Zet elke nieuwe tekst in `app.js` in `t('…')`, met waarden als `t('Verwijderd: {name}', { name })` (nooit tekst aan elkaar plakken), en voeg de Engelse vertaling toe aan `public/lang/en.js`. Vaste tekst in `index.html` (ook `placeholder`, `aria-label`, `title`) vertaalt `collectStatic()` vanzelf, maar heeft ook een vertaling nodig. Servermeldingen blijven Nederlands: de browser vertaalt ze met `tr()`, dus voeg een nieuwe melding ook als sjabloon toe aan `en.js` (bv. `'Poort {port} is al in gebruik door {app}. Kies een andere poort.'`). Data van de server die tekst is (waarschuwingen, categorieën, regels van een taak) gaat bij het tonen door `tr()`. Gebruik `t` nooit als naam van een variabele of parameter.
- Geen npm-dependencies toevoegen zonder het eerst te vragen. Geen build-stap. Systeempakketten gaan via `install.sh`.
- Externe commando's altijd via `run()` met een argumentenlijst, nooit via een shell. Valideer namen en paden van de gebruiker (zie `NAME` en de `ISO_DIR`-lijst in `lib/vms.js`).
- Kleuren altijd via de CSS-tokens op `:root`. Beide thema's (licht = ochtendnevel, donker = avond) moeten blijven werken.
- Alles wat van de server komt, door `esc()` halen voordat het in `innerHTML` gaat.
- Gebruik geen `confirm()`/`alert()`. Gebruik de eigen `ask()`-dialoog in `app.js` (met een derde argument krijg je een vinkje en geeft `ask()` `{ checked }` terug).
- Destructieve acties (stoppen, afsluiten, verwijderen) vragen altijd eerst om bevestiging.

## Starten en testen

```bash
npm run demo   # demo-modus met voorbeelddata, http://localhost:8080
npm test       # parsertests
npm run dev    # op de server zelf, instellingen uit .env (zie .env.example)
```

Er zijn ook configuraties in `.vscode/launch.json`.
Controleer na een wijziging minstens: `node --check server.js lib/*.js public/*.js`, `npm test`, en klik de demo door (apps, appstore met installeren/verwijderen, opslag, VM-pagina met aanmaken/bewerken (alle tabbladen)/verwijderen, console, AI).

## Bekende onzekerheden

- **Nog niet getest op een echte Debian 13-server.** De parsers zijn getest met voorbeelduitvoer, de commando's zelf nog niet.
- `virsh domstats` voor uitgeschakelde VM's: vCPU en geheugen komen dan uit de domein-XML (`configInfo`, 60 s cache).
- `virt-install --osinfo linux2022` / `win11`: hangt af van de osinfo-db in Debian 13.
- `undefine --nvram` laat de TPM-status van Windows-VM's staan (in `/var/lib/libvirt/swtpm`).
- De appstore zet templates om die voor Unraid gemaakt zijn. Alle 3956 Docker-templates uit de feed geven geldige YAML (getest), maar niet elke app zal zonder aanpassing werken (eigen netwerken, ontbrekende databases, Unraid-specifieke paden).
- Het compose-formulier vertrouwt op de JSON-vorm van `docker compose config` (getest met voorbeelduitvoer, nog niet met een echte compose-versie). Lukt het lezen niet (oude compose, `${VARIABELEN}` in poorten), dan valt het terug op de tekstmodus.
- VM-hardware, VM-netwerken en de console zijn getest met voorbeeld-XML en een nagebootste VNC-server (noVNC → `lib/websocket.js` → RFB 3.8 met VNC-wachtwoord), nog niet met echte libvirt/QEMU. PCI doorgeven vraagt IOMMU (AMD-Vi aan in het BIOS); libvirt koppelt het apparaat zelf aan vfio-pci (`managed='yes'`). Geef je de GPU door, dan heeft Ollama hem niet zolang de VM draait.
- Docker-netwerken zijn getest met voorbeelduitvoer van de Docker-API, nog niet tegen een echte Docker. Met macvlan/ipvlan kan de server zelf de apps niet bereiken (beperking van Linux); een tweede macvlan op dezelfde kaart met hetzelfde subnet weigert Docker.
- Netwerk aanpassen is getest met voorbeeldbestanden, nog niet op een echte server. Bevestigen werkt alleen zolang Thuisbasis draait (het terugzetten is een timer in het proces).
- De feed van Community Apps heeft geen expliciete licentie. Prima voor eigen gebruik; navragen voor publicatie.
- `smartctl -n standby` geeft voor slapende schijven geen temperatuur. De interface toont dan "In rust".
- ZFS-pakketten (`zfs-dkms`) bouwen een kernelmodule: na een kernelupdate moet DKMS opnieuw bouwen.

## Mogelijke volgende stappen

- Volwaardige terminal in de console van apps (xterm.js; de WebSocket uit `lib/websocket.js` kan hergebruikt worden)
- Snapshots van VM's
- Datasets aanmaken en snapshots beheren vanuit de interface; een pool uitbreiden, een schijf vervangen of een pool verwijderen
- Een tweede bron in de appstore, bv. de CasaOS-AppStore (Apache 2.0, al in compose-formaat)
- Aanmelden bij privé-registries (nu worden privé-images overgeslagen)
- Samba-shares beheren
- Meldingen (schijf faalt, pool aangetast, scrub met fouten)
