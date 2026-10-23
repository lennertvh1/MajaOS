# HomeBaseOS

Een eenvoudig, overzichtelijk beheersysteem voor je thuisserver, in de stijl van ZimaOS en HexOS.
HomeBaseOS draait op een gewone **Debian 13** en beheert drie dingen voor je: **ZFS** voor opslag, **KVM/libvirt** voor virtuele machines en **Docker** voor apps.

**Wat kan het?**

- **Startscherm** met klok, CPU, RAM, VRAM, vrije opslag, AI-status en je VM's met live CPU en RAM
- **Apps**: al je Docker-containers als pictogrammen. Een oranje pijltje op een app betekent dat er een nieuwe versie is (HomeBaseOS kijkt elke 6 uur, of meteen met *Nu controleren*). **Klik** om de webinterface te openen, **rechtsklik** (of ⋯) voor het menu: starten, stoppen, herstarten, bijwerken, logboek (live), console en instellingen (adres van de webinterface, pictogram, automatisch starten, en de container zelf: image, poorten, mappen, variabelen, apparaten en labels in een formulier zoals in Unraid, of het compose-bestand als tekst)
- **Appstore**: bijna 4000 apps uit de catalogus van Unraid Community Apps. Zoeken, kiezen, een paar velden invullen en installeren. HomeBaseOS maakt er een compose-bestand van
- **VM's** (eigen pagina): aanmaken (Linux, Windows 11 of een bestaande schijf zoals Home Assistant OS), bewerken, verwijderen, live CPU en RAM, en automatisch starten **met uitstel** als de server opstart
- **Startscherm**: apps rangschikken en in mappen zetten zoals op een iPad (*Rangschikken* of lang indrukken; sleep een app op een andere om een map te maken), en de widgets links verbergen of verplaatsen (*Widgets aanpassen*)
- **Gedeelde mappen** (Samba) met gebruikers en rechten per map (lezen of lezen en schrijven), gasten en Time Machine
- **Back-ups**: je toestellen (Mac met Time Machine, Windows, Linux, gsm) naar de NAS, en mappen van de NAS naar Google Drive, OneDrive, Dropbox, S3 of een andere NAS (en terug), op vaste tijden, eventueel versleuteld en met oude versies
- **Opslag**: ZFS-pools met gezondheid en de laatste controle (scrub), alle schijven met temperatuur en SMART, je datasets, een overzicht van je schijfbays en een venster om een pool aan te maken
- **AI**: Ollama-modellen bekijken, laden, ontladen, downloaden en verwijderen, en snel iets vragen aan je eigen model
- **Instellingen** (tandwiel rechtsboven): taal (Nederlands of Engels) en thema, de netwerkinstellingen van de server (IP-adres, DHCP of vast, DNS, hostnaam, bridge voor VM's) met automatisch terugzetten als je niet bevestigt, Docker-netwerken (bridge, macvlan, ipvlan) voor je apps, en alle info over de server, de hardware en de versies
- Licht en donker thema, werkt ook op je gsm

## Installeren met de ISO (aanbevolen)

Bij elke release staat een installatie-ISO: `homebaseos-<versie>-amd64.iso`. Dat is de officiële Debian 13-netinstaller met HomeBaseOS erbij.

1. Zet **Secure Boot uit** in het BIOS (de ZFS- en NVIDIA-modules zijn niet ondertekend). Zet de server op UEFI.
2. Zet de ISO op een USB-stick met [balenaEtcher](https://etcher.balena.io), of: `sudo dd if=homebaseos-….iso of=/dev/sdX bs=4M status=progress conv=fsync`.
3. Start de server van de stick en kies **HomeBaseOS installeren** (of *met NVIDIA-driver* voor een NVIDIA-kaart). De server heeft internet nodig.
4. De installer vraagt maar drie dingen:
   - **de schijf voor het systeem**: kies de SSD voor Debian, *niet* een van je dataschijven;
   - de bevestiging dat die schijf gewist mag worden;
   - een wachtwoord voor de beheerder `homebase` (voor SSH en `sudo`).
5. Na de herstart installeert HomeBaseOS zichzelf (5 à 15 minuten). Daarna staat het adres op het scherm van de server. Open dat adres in je browser: de welkomstwizard maakt je account aan en doet de rest.

Taal en toetsenbord staan op Nederlands (België) en Belgisch AZERTY; de tijdzone op Europe/Brussels (aan te passen in de wizard). Mislukt de installatie bij de eerste opstart, dan staat dat op het scherm; het logboek is `/var/log/homebaseos-firstboot.log` en `sudo systemctl restart homebaseos-firstboot` probeert opnieuw.

**De ISO zelf bouwen.** Dat doet GitHub Actions bij elke release (`.github/workflows/iso.yml`), of met de hand via *Actions > ISO bouwen > Run workflow*. Op een Linux-pc: `sudo apt install xorriso cpio && ./iso/build-iso.sh` (de ISO komt in `dist/`).

## Installeren met de hand

### 1. Debian 13 installeren

Installeer **Debian 13 (trixie)** vanaf de netinst-ISO op de opstartschijf (bv. een kleine SSD, niet op je dataschijven).
Kies bij *Software selection* alleen **SSH server** en **standard system utilities**, geen desktop.

### 2. HomeBaseOS installeren

Kopieer de map `homebaseos` naar de server (bv. met `scp -r homebaseos gebruiker@IP-van-je-server:`) en voer uit:

```bash
cd homebaseos
sudo ./install.sh            # met een NVIDIA-kaart: sudo ./install.sh --nvidia
```

Het script installeert ZFS, KVM/libvirt, Docker en HomeBaseOS, en zet HomeBaseOS aan als systemd-service.
Op het einde toont het het adres. Open dat in je browser en maak in de welkomstwizard je **account** aan (gebruikersnaam en wachtwoord).
Opnieuw uitvoeren werkt HomeBaseOS bij. Je instellingen blijven staan.

### 3. Een ZFS-pool maken

Het makkelijkst gaat het in HomeBaseOS zelf: in de welkomstwizard (stap *Opslag*) of later bij **Opslag > Pool aanmaken**. Vink de schijven aan, kies de indeling (stripe, mirror, RAID-Z1/2/3 of mirror-paren) en je ziet meteen hoeveel opslag je overhoudt, hoeveel schijven mogen uitvallen en wat er ongebruikt blijft bij schijven van verschillende grootte. Schijven waarop het systeem staat of die al in een pool zitten, kan je niet kiezen. HomeBaseOS gebruikt dezelfde opties als hieronder (ashift=12, lz4, /dev/disk/by-id) en maakt meteen de mappen (datasets) `appdata`, `media`, `backups`, `vms` en `isos` op de pool. Wat nog geen plek had (appgegevens, VM-schijven, ISO's en de gedeelde mappen van Unraid-apps), komt op die eerste pool. Verhuizen naar een andere pool kan later bij **Instellingen > Opslag** (zie *Appgegevens verhuizen*). Wil je het liever met de hand doen:

> **Let op:** `zpool create` wist de schijven die je opgeeft. Controleer eerst welke schijven het zijn.

Gebruik altijd de namen uit `/dev/disk/by-id/`, want `sda` en `sdb` kunnen na een herstart van plaats wisselen:

```bash
ls -l /dev/disk/by-id/ | grep -v part

# 4 HDD's als raidz1: één schijf mag uitvallen, ongeveer 6 TB bruikbaar bij 4× 2 TB
sudo zpool create -o ashift=12 -O compression=lz4 -O atime=off -O xattr=sa -O acltype=posixacl \
  tank raidz1 /dev/disk/by-id/ata-SCHIJF1 /dev/disk/by-id/ata-SCHIJF2 /dev/disk/by-id/ata-SCHIJF3 /dev/disk/by-id/ata-SCHIJF4

# 2 SSD's als mirror voor apps en VM-schijven
sudo zpool create -o ashift=12 -O compression=lz4 -O atime=off -O xattr=sa snel mirror /dev/disk/by-id/nvme-SSD1 /dev/disk/by-id/nvme-SSD2

# Datasets
sudo zfs create tank/isos        # ISO's en schijfbestanden
sudo zfs create snel/vms         # VM-schijven (snel op SSD)
sudo zfs create snel/appdata     # gegevens van je Docker-apps
sudo zfs create tank/media
```

HomeBaseOS vindt zulke mappen bij de volgende start zelf (een dataset `<pool>/appdata`, `<pool>/vms` of `<pool>/isos`). Kies anders bij **Instellingen > Opslag** welke pool je voor wat gebruikt.

#### Appgegevens verhuizen

Bij **Instellingen > Opslag** kies je een andere pool voor de appgegevens en klik je op *Verhuizen*. HomeBaseOS stopt de apps die er een map hebben, kopieert alles met `rsync` naar `/<pool>/appdata`, past de paden in hun compose-bestanden aan (met een `.bak`) en start ze opnieuw. De oude map blijft staan: verwijder ze zelf als alles werkt. Apps zonder compose-bestand op de server (gestart met `docker run`, of beheerd door Portainer, dat het bestand in zijn eigen container bewaart) verhuizen niet mee; HomeBaseOS toont welke. Apps uit de appstore en Dockge-stacks verhuizen wel mee. Voor VM-schijven, ISO's en gedeelde mappen kies je daar ook een pool; bestaande bestanden blijven dan waar ze zijn.
Debian voert elke maand automatisch een controle (scrub) uit. In HomeBaseOS zie je onder **Opslag** wanneer dat voor het laatst gebeurde.
Onder **Opslag > Schijfbays** teken je je kast na: kies het aantal bays en hoeveel er op een rij staan, en sleep elke schijf naar de bay waarin ze zit. HomeBaseOS onthoudt de schijf aan haar serienummer. Valt een schijf uit of haal je ze eruit, dan kleurt haar bay rood met het model en serienummer, zodat je meteen weet welke je moet vervangen.

### 4. VM's in je thuisnetwerk (bridge)

Standaard komen nieuwe VM's achter de NAT van libvirt: ze kunnen naar buiten, maar je bereikt ze niet vanuit je netwerk.
Voor **Home Assistant** en de meeste servers wil je ze rechtstreeks in je thuisnetwerk. Maak daarvoor een bridge.
Zoek de naam van je netwerkkaart met `ip -br link` (bv. `enp5s0`) en pas `/etc/network/interfaces` aan:

```text
auto lo
iface lo inet loopback

iface enp5s0 inet manual

auto br0
iface br0 inet dhcp
    bridge_ports enp5s0
    bridge_stp off
    bridge_fd 0
```

Doe dit liefst met een scherm en toetsenbord aan de server: als er een typfout in staat, ben je de verbinding kwijt.
Herstart daarna de server, zet `VM_NETWORK=bridge=br0` in `/etc/homebaseos/homebaseos.env` en herstart HomeBaseOS.
Je kan de bridge ook maken in *Instellingen > Netwerk*. Het netwerk van een VM kies je bij het aanmaken of later bij *Bewerken > Netwerk*.

## VM's

- **Nieuwe VM**: zet eerst een ISO (of een schijfbestand) in `ISO_DIR`. Kies daarna in HomeBaseOS *Nieuwe VM* en het netwerk. De VM start meteen.
- **Console**: de knop *Console* opent het scherm van de VM groot in HomeBaseOS, met toetsenbord en muis (noVNC). Daar installeer je het besturingssysteem.
  Met *Los venster* zet je de console in een eigen browservenster (bv. op een tweede scherm). *Ctrl+Alt+Del* gaat naar de VM en niet naar je Mac.
  **Plakken** (Cmd+V of Ctrl+V in de console) typt de tekst van je klembord in de VM. Dat werkt altijd, ook in een installer of de console van Home Assistant OS.
  **Kopiëren uit de VM** vraagt een agent in de VM: zet bij *Bewerken > Scherm* *Klembord delen* aan, installeer in de VM `spice-vdagent` (Linux) of de SPICE guest tools (Windows) en start de VM opnieuw. Wat je dan in de VM kopieert, komt op je pc (bij http via de knop *Kopiëren naar deze pc*).
  Liever een eigen VNC-programma? Onder *Bewerken > Scherm* staan het adres en het wachtwoord.
- **Bewerken** heeft tabbladen:
  - *CPU en geheugen*, met **vaste kernen** (CPU-pinning zoals in Unraid): kies de kernen waarop de VM altijd draait. Neem beide threads van een kern en laat kern 0 voor de server.
  - *Netwerk*: netwerkkaarten toevoegen of weghalen, het netwerk (bridge `br0` of een VM-netwerk), het soort kaart en het MAC-adres.
  - *Opslag*: schijven toevoegen, groter maken of loskoppelen (het bestand blijft staan), een ISO in de cd-rom steken en kiezen of de VM eerst van de schijf of de cd-rom opstart.
  - *Apparaten*: **USB** (bv. een Zigbee-stick voor Home Assistant) en **PCI** (bv. de GPU) doorgeven. PCI vraagt IOMMU: zet *AMD-Vi/IOMMU* aan in het BIOS. Geef alle apparaten uit dezelfde IOMMU-groep samen door (bv. de GPU en zijn geluid). Een doorgegeven GPU kan Ollama niet gebruiken zolang de VM draait.
- **VM-netwerken** (*Instellingen > VM-netwerken* of de knop *Netwerken* op de VM-pagina): naast de bridge van je thuisnetwerk maak je hier eigen netwerken. *NAT*: de VM's kunnen naar internet, maar je bereikt ze niet vanuit je thuisnetwerk. *Afgeschermd*: alleen de VM's onderling en de server, zonder internet.
- **Home Assistant OS**: download het KVM-bestand (`haos_ova-….qcow2.xz`) van home-assistant.io, pak het uit met `unxz`, zet het in `ISO_DIR` en kies *Bestaande schijf*. HomeBaseOS maakt er een kopie van.
- **Automatisch starten met uitstel**: vink *Automatisch starten* aan en kies een uitstel in seconden. Het uitstel telt vanaf het opstarten van de server.
  Met 60 seconden start de VM dus pas 1 minuut na de server. Zo heeft de server eerst tijd voor ZFS, Docker en je apps.
  HomeBaseOS regelt dit zelf, dus de autostart van libvirt staat voor die VM uit.
- Wijzigingen aan CPU, geheugen, netwerk en apparaten gelden pas nadat je de VM **afsluit en opnieuw start** (een herstart vanuit de VM is niet genoeg). Een ISO wisselen en schijven groter maken gaat meteen.
  De naam wijzig je alleen als de VM uit staat.
- **Verwijderen** kan alleen als de VM uit staat. Vink *Ook de schijfbestanden wissen* aan om ook de schijven te verwijderen.
  HomeBaseOS wist alleen bestanden binnen `VM_DIR`. Alles daarbuiten blijft staan, en dat zie je in de melding.


### Snapshots

In het venster van een VM, tabblad **Snapshots**: leg de VM vast zoals ze nu is (bv. vóór een update) en ga er later naar terug. Draait de VM, dan bewaart de snapshot ook het geheugen; ga je terug, dan loopt de VM verder waar ze was. Een snapshot is geen back-up (hij staat op dezelfde schijf): gebruik daarvoor *Back-ups → Apps en VM's*.

## Appstore

De appstore gebruikt de catalogus van **Unraid Community Apps** (de feed `applicationFeed.json`, niet de Unraid-plugin zelf).
HomeBaseOS haalt hem één keer per dag op. Met *Nu vernieuwen* kan het ook meteen.
Plugins, verouderde apps en apps op de zwarte lijst van Community Apps laat HomeBaseOS weg.

Omdat de templates voor Unraid gemaakt zijn, vertaalt HomeBaseOS ze bij het installeren:

| In het template | Op je server |
|---|---|
| `/mnt/user/appdata/...`, `/mnt/cache/appdata/...` | de map voor appgegevens (*Instellingen > Opslag*, standaard `/<eerste pool>/appdata`) |
| andere `/mnt/user/...`, `/mnt/diskN/...` | de map voor gedeelde mappen (standaard `/<eerste pool>`) |
| een leeg `/config`-pad | `<appgegevens>/<naam>` (zoals Community Apps dat ook doet) |
| `PUID=99`, `PGID=100`, `--user 99:100` | `APP_UID`, `APP_GID` (standaard 1000) |
| `TZ` | de tijdzone van je server |
| `--runtime=nvidia`, `--gpus all` | GPU-reservering in compose |
| netwerk `br0` of eigen netwerken | een Docker-netwerk met dezelfde naam als dat bestaat, anders het standaardnetwerk (met een waarschuwing). Bij het installeren kies je zelf een netwerk en eventueel een vast IP-adres. |
| Unraid-mappen zoals `/usr/local/emhttp` en `/boot` | weggelaten (met een waarschuwing) |

### Eigen app

Staat een app niet in de appstore? Kies in de appstore **Eigen app** en plak de naam van het image (bv. `louislam/uptime-kuma`) of een link naar de pagina ervan (Docker Hub, GitHub-pakketten, Quay). HomeBaseOS leest bij de registry welke poorten en mappen de app gebruikt, zonder het image al te downloaden, en vult het formulier in: een vrije poort, mappen in `<appgegevens>/<naam>`, PUID/PGID en de tijdzone. Je past alles aan in hetzelfde formulier als bij de instellingen van een app en installeert. Een eigen app kan je later verwijderen zoals een app uit de appstore.

Per app komt er een `compose.yaml` in `STACKS_DIR/<naam>` (standaard `/opt/stacks`, dezelfde map die Dockge gebruikt). Je kan het bestand dus ook zelf aanpassen.
Voor privileged apps, apps met toegang tot Docker, apps op het host-netwerk en extra Docker-opties die niet overgenomen worden, toont HomeBaseOS eerst een waarschuwing.
Poorten kan je altijd aanpassen, en met *+ Poort* voeg je er extra toe. Gebruikt een app het host-netwerk (bv. Plex of Home Assistant), dan luistert ze op haar eigen poorten. Pas je toch een poort aan, dan kiest HomeBaseOS het standaardnetwerk (bridge). Sommige apps zoeken toestellen in je netwerk en werken daarom het best met host.
Apps uit de appstore kan je ook weer **verwijderen** (in het detailvenster van de app). Vink aan of hun gegevens mee weg moeten.
HomeBaseOS wist alleen mappen binnen de map voor appgegevens.

> De templates zijn het werk van hun eigen maintainers. Community Apps (van Squid) verzamelt en controleert ze.
> Gebruik de catalogus voor je eigen server. Wil je HomeBaseOS publiceren, vraag het dan eerst na bij de makers van Community Apps.

## Apps

HomeBaseOS toont alle Docker-containers. Je zet apps het best op met **Docker Compose**: dan werkt ook de knop *Bijwerken* (die haalt het nieuwste image op en maakt de container opnieuw).
Heeft een app geen eigen pictogram, dan zoekt HomeBaseOS er een in de catalogus van Community Apps (zelfde image) of in de open verzameling [dashboard-icons](https://github.com/homarr-labs/dashboard-icons). Lukt dat niet, dan zie je een gekleurde letter.
Met twee labels kies je zelf het pictogram en het adres:

```yaml
services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports: ["8096:8096"]
    volumes: ["/snel/appdata/jellyfin:/config", "/tank/media:/media"]
    labels:
      homebaseos.icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/jellyfin.png"
      homebaseos.webui: "http://[IP]:[PORT:8096]/"
```

**Ollama met je NVIDIA-kaart** (na `install.sh --nvidia` en een herstart). Draait Ollama nog niet, dan zegt de AI-widget dat en brengt het AI-venster je naar Ollama in de appstore:

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    ports: ["11434:11434"]
    volumes: ["/snel/appdata/ollama:/root/.ollama"]
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, count: all, capabilities: [gpu] }]
```

## Ontwikkelen in VS Code (op je Mac)

Je hebt alleen **Node.js 18.11 of nieuwer** nodig (geen `npm install`, er zijn geen dependencies).

```bash
npm run demo   # voorbeelddata, werkt zonder server: http://localhost:8080
npm test       # tests voor alle parsers (virsh, zpool, zfs, lsblk, Docker)
```

In **Run and Debug** staan dezelfde opties. `npm run dev` gebruik je op de server zelf, met een `.env` (zie `.env.example`).
Bijwerken op de server: kopieer de map opnieuw en voer `sudo ./install.sh` uit.

## Instellingen

In `/etc/homebaseos/homebaseos.env`, daarna `sudo systemctl restart homebaseos`.

| Variabele | Betekenis |
|---|---|
| `APP_PASSWORD` | Alleen voor installaties van vroeger: geldt zolang er geen eigen account is. Leeg = bij de eerste keer een account aanmaken |
| `SESSION_SECRET` | Vaste sleutel voor aanmeldingen (anders moet je na een herstart opnieuw aanmelden) |
| `PORT` | Poort, standaard `8080` |
| `OLLAMA_URL` | Adres van Ollama, bv. `http://127.0.0.1:11434` |
| `VM_DIR`, `ISO_DIR` | Vroeger: map voor VM-schijven en voor ISO's. Nu bij *Instellingen > Opslag*; de variabele geldt alleen als daar niets gekozen is |
| `VM_NETWORK` | `network=default` (NAT) of `bridge=br0` (thuisnetwerk) |
| `APPDATA_DIR`, `SHARES_DIR` | Vroeger: appgegevens en de map voor Unraid-shares. Nu bij *Instellingen > Opslag* (zelfde voorrang) |
| `STACKS_DIR` | Compose-bestanden van de appstore, standaard `/opt/stacks` |
| `APP_UID`, `APP_GID` | Gebruiker voor apps (in plaats van 99:100 van Unraid), standaard `1000` |
| `STORE_FEED_URL` | Andere bron voor de catalogus (optioneel) |
| `DATA_DIR` | Eigen instellingen en de cache van de catalogus, standaard `/var/lib/homebaseos` |
| `DEMO` | `1` = demo-modus met voorbeelddata |

## Netwerk aanpassen

In *Instellingen > Netwerk* stel je het IP-adres van de server in (DHCP of vast), de gateway, de DNS-servers en de bridge `br0` voor VM's.
Dat werkt als Debian het netwerk beheert met ifupdown (`/etc/network/interfaces`), de standaard voor een server zonder desktop.
Na *Toepassen* heb je **2 minuten om te bevestigen**. Bevestig je niet, bijvoorbeeld omdat de server niet meer bereikbaar is, dan zet HomeBaseOS de oude instellingen vanzelf terug.
Verandert het adres, open dan het nieuwe adres en bevestig daar. De vorige versie van de bestanden staat in `/var/lib/homebaseos/netwerk-vorige`.

## Docker-netwerken

In *Instellingen > Docker-netwerken* maak je netwerken voor je apps:

- **Bridge**: een eigen netwerk tussen apps. Apps in hetzelfde netwerk vinden elkaar op naam (bv. `http://database:5432`). Met *Zonder internet* kunnen ze alleen elkaar bereiken.
- **macvlan**: elke app krijgt een eigen IP- en MAC-adres in je thuisnetwerk, zoals `br0` in Unraid. Handig voor Pi-hole of AdGuard (poort 53) of apps die je router als apart toestel moet zien. Kies een *IP-bereik* dat je router niet via DHCP uitdeelt.
- **ipvlan**: zoals macvlan, maar alle apps delen het MAC-adres van de server. Voor routers of switches die moeilijk doen met veel MAC-adressen.

Let op: met macvlan en ipvlan kan de server zelf de apps niet bereiken via hun eigen adres (andere toestellen in je netwerk wel). Zo werkt Linux.

Een app in een netwerk zetten doe je bij de instellingen van de app (compose-formulier, veld *Netwerk*, eventueel met een vast IP-adres) of bij het installeren uit de appstore. In het compose-bestand komt dat als een `external`-netwerk.

## Gedeelde mappen

Met de knop **Gedeelde mappen** bovenaan deel je mappen met je pc's, Macs en telefoons (Samba):

1. Maak eerst **gebruikers** met een wachtwoord (bv. voor elk gezinslid) bij **Instellingen → Gebruikers**. Ze kunnen alleen aan de gedeelde mappen, niet aanmelden op de server of het dashboard.
2. Maak eventueel **groepen** (bv. *Gezin*, *Ouders*) en zet de gebruikers erin. Een groep geeft al haar leden dezelfde rechten; wie in meerdere groepen zit, krijgt het hoogste recht.
3. Maak een **gedeelde map**: een nieuwe map op een pool (HomeBaseOS maakt er een eigen dataset van, bv. `tank/media`) of een bestaande map.
4. Kies per gebruiker en per groep *Geen toegang*, *Lezen* of *Lezen en schrijven*. Optioneel mogen gasten lezen zonder wachtwoord, of gebruik je de map voor **Time Machine**.

Bij **Instellingen → Gebruikers** zie je per gebruiker wat die mag in elke map, en of dat rechtstreeks is of via een groep.

Verbinden: op een Mac via Finder → Ga → Verbind met server (`smb://freddy.local/media`), op Windows met `\\freddy\media` in de Verkenner.
Bestanden worden geschreven als de app-gebruiker (`APP_UID`), dezelfde als bij je Docker-apps, zodat bv. Jellyfin en je pc dezelfde mappen gebruiken zonder rechtenproblemen.
Een gedeelde map verwijderen stopt alleen het delen; de bestanden blijven staan.

## Back-ups

Met de knop **Back-ups** bovenaan. Er zijn drie tabbladen:

**Apps en VM's**: een kopie van de apps en VM's die je aanvinkt, in een map op de NAS (bv. `/tank/backups/systeem`), met de hand of op een schema; de laatste *n* blijven bewaard. Van een app gaan de compose-bestanden, de mappen in de appgegevens en de Docker-volumes mee (je media niet: die bewaar je met Synchroniseren); de app stopt even zodat databases een consistente kopie geven. Een VM wordt gekopieerd terwijl ze draait (libvirt) of even afgesloten. *Terugzetten…* zet een app of VM terug uit een gekozen back-up; wat er stond, gaat eerst opzij (`.voor-terugzetten-<datum>`). Wil je die map ook buiten de deur, maak er dan een taak voor bij Synchroniseren.

**Toestellen**: back-ups van je pc's, Macs en gsm's op de NAS, op twee manieren.

*Met de back-up-app Kopia* (aanbevolen voor Windows en Linux): zet de back-up-app één keer aan en kies een pool. HomeBaseOS start dan een Kopia-server op de NAS (poort 51515) met een versleuteld archief in `<pool>/backups/kopia`. Het **wachtwoord van het archief** zie je maar één keer: bewaar het goed. Voeg daarna per pc een toestel toe; je krijgt een **koppelcode**. Installeer op de pc de app **HomeBase Back-up** (een versie van KopiaUI in dezelfde stijl als HomeBaseOS, [downloaden](https://github.com/lennertvh1/kopia/releases/latest)), typ het adres van je HomeBaseOS en de code, en kies wat je wil bewaren (Documenten, Bureaublad, Afbeeldingen …). De gewone KopiaUI of de opdrachtregel kan ook: de stappen (adres, vingerafdruk, naam, wachtwoord) staan bij het toestel. Het toestel maakt dan elk uur een back-up zolang KopiaUI draait, en oude versies blijven bewaard (24 per uur, 14 dagen, 8 weken, 12 maanden, 3 jaar). Terugzetten doe je in de app (*Bekijken en terugzetten*). HomeBaseOS toont per toestel wanneer de laatste back-up was.

*Met een eigen gedeelde map*: elk toestel krijgt een eigen dataset (`<pool>/backups/<naam>`) met een maximale grootte, en een gedeelde map waar alleen de gekozen gebruiker aan kan. Bij een Mac staat Time Machine meteen aan. Onder *Zo stel je het in* staan de stappen per soort toestel (Time Machine, Bestandsgeschiedenis van Windows, Déjà Dup op Linux, PhotoSync of FolderSync op je gsm).

**Verbindingen**: plekken buiten de NAS. Google Drive, OneDrive en Dropbox koppel je door aan te melden in je browser:

1. Klik op *Aanmelden bij …*. Er opent een tabblad van Google, Microsoft of Dropbox.
2. Meld je aan en klik op *Toestaan*. Het tabblad komt daarna uit op `http://127.0.0.1:53682/…` en toont een fout. Dat is normaal.
3. Kopieer dat adres uit de adresbalk en plak het in HomeBaseOS.

Lukt dat niet, dan kan je ook `rclone authorize "drive"` (of `onedrive`, `dropbox`) uitvoeren op een pc met rclone en de token plakken.
Een andere NAS gaat via SFTP (SSH: Synology, QNAP, TrueNAS, een andere HomeBaseOS), SMB (een gedeelde map) of WebDAV (Nextcloud). Daarnaast kan S3-opslag (Backblaze B2, Wasabi, Cloudflare R2, Amazon S3, MinIO).

**Synchroniseren**: taken die een map op de NAS naar een verbinding zetten (of omgekeerd), met de hand, elk uur, elke dag of elke week:

- *Kopiëren* zet nieuwe en gewijzigde bestanden over en wist nooit iets aan de andere kant. *Synchroniseren* maakt er een exacte kopie van: wat je op de NAS wist, verdwijnt daar ook.
- *Versleutelen* (rclone crypt): bestanden en mapnamen zijn versleuteld vóór ze de NAS verlaten. Zonder het wachtwoord krijgt niemand ze terug, ook jij niet. Met rclone en hetzelfde wachtwoord haal je ze ook zonder HomeBaseOS terug.
- *Oude versies bewaren*: wat overschreven of gewist wordt, gaat naar een map ernaast (`… (oude versies)/<datum>`) en verdwijnt na het gekozen aantal dagen.
- *Proef* toont in het logboek wat een taak zou doen, zonder iets te veranderen. *Terugzetten* haalt alles terug naar een (nieuwe) map op de NAS.

HomeBaseOS gebruikt [rclone](https://rclone.org) (`install.sh` installeert het). Verbindingen staan in `/var/lib/homebaseos/rclone.conf` (alleen leesbaar voor root). Een synchronisatie start niet als de bronmap leeg is of de pool niet gekoppeld is, zodat er aan de andere kant niets per ongeluk gewist wordt.

## Herstarten en afsluiten

Met de aan/uit-knop bovenaan (naast Instellingen) herstart je de server of sluit je hem af, altijd na een bevestiging. Bij herstarten komt de pagina vanzelf terug zodra de server weer draait.

## Terminal op de server

Rechtsboven opent het terminal-icoon een **root-shell op de server**, met kleuren, `top`, `nano`, tab-aanvulling, kopiëren en plakken (xterm.js). Met *Los venster* zet je ze in een eigen browservenster.
In **Instellingen > Beveiliging** zet je de terminal aan of uit, en kies je of HomeBaseOS je wachtwoord opnieuw vraagt bij het openen (standaard wel). De beveiliging minder streng maken vraagt altijd je wachtwoord. Elke keer dat iemand de terminal opent of sluit, staat in `journalctl -u homebaseos`.

## Software-update

**Instellingen > Software-update** toont of er een nieuwe versie van HomeBaseOS is, met de release-notes van elke nieuwe versie. HomeBaseOS zoekt elke 12 uur (of meteen met *Nu zoeken*) tussen de releases op GitHub. Is er een update, dan krijg je een melding en een rood bolletje op het tandwiel. Kies je *Ook bètaversies*, dan zie je ook testversies.

De repository is privé. Maak daarom op GitHub een **fine-grained token** (Settings > Developer settings > Personal access tokens) met alleen toegang tot `homebaseos` en leesrecht op *Contents*, en zet het in `/etc/homebaseos/homebaseos.env`:

```
UPDATE_TOKEN=github_pat_...
```

Daarna `sudo systemctl restart homebaseos`. Een nieuwe release maak je op GitHub met een tag zoals `v0.3.0` (zelfde nummer als in `package.json`); de tekst van de release zijn de release-notes.

Met **Nu bijwerken** doet HomeBaseOS alles zelf, met een voortgangsbalk: downloaden, controleren, een reservekopie van de huidige versie, installeren, herstarten en testen. Start de nieuwe versie niet binnen 45 seconden, dan zet HomeBaseOS de vorige versie automatisch terug. Je apps en VM's blijven draaien; je instellingen worden niet aangeraakt. Wat er gebeurde, staat in `journalctl -u 'homebaseos-update-*'`.

Een release maken: zet het nieuwe nummer in `package.json`, commit, en maak op GitHub een release met de tag `v<nummer>`.

Werk je vanuit een git-map op de server, dan werk je bij met `git pull` en `sudo ./install.sh`.

## Datum en tijd

In **Instellingen > Algemeen** kies je de **tijdzone** van de server (apps uit de appstore krijgen dezelfde `TZ`), en of de tijd automatisch via internet (NTP) gelijk gezet wordt. Je kan eigen tijdservers opgeven, bv. `be.pool.ntp.org` of je router; leeg = de standaard van Debian. Zet je NTP uit, dan stel je datum en tijd zelf in. Daar kies je ook de **tijdnotatie** (24 of 12 uur) voor iedereen.

## Eerste keer aanmelden

Open na de installatie het adres van de server. Er is nog geen wachtwoord: de **welkomstwizard** opent meteen (zonder dashboard erachter) en vraagt taal en thema, en daarna een **account** (gebruikersnaam en wachtwoord). Daarna volgen de naam van de server en de tijdzone, opslag (je kan meteen in die stap een pool aanmaken) en tweestapsverificatie. Die stappen mag je overslaan; met *Later instellen* sluit je de wizard. Je opent hem opnieuw bij **Instellingen > Algemeen**.

> Tot het account bestaat, kan iedereen in je netwerk het aanmaken. Doe het dus meteen na de installatie.

Wijzigen kan later bij **Instellingen > Beveiliging**. Een installatie van vroeger met `APP_PASSWORD` blijft werken; daar kies je in de wizard een eigen wachtwoord.

**Wachtwoord vergeten?** Voer op de server `sudo rm /var/lib/homebaseos/auth.json && sudo systemctl restart homebaseos` uit. Daarna maak je in de browser opnieuw een account aan (of geldt weer `APP_PASSWORD` als dat in `/etc/homebaseos/homebaseos.env` staat), en staat tweestapsverificatie uit.

## Aanmelden en tweestapsverificatie

HomeBaseOS vraagt je gebruikersnaam en wachtwoord. Met *Aangemeld blijven op dit toestel* blijf je 30 dagen aangemeld; zonder vinkje ben je afgemeld als je de browser sluit.

Voor extra zekerheid zet je in **Instellingen > Beveiliging** de **tweestapsverificatie** aan. Na je wachtwoord vraagt HomeBaseOS dan een code van 6 cijfers uit een authenticator-app (Google Authenticator, Microsoft Authenticator, 1Password, Aegis, …):

1. Klik op *Aanzetten* en typ je wachtwoord.
2. Scan de QR-code met de app (of typ de sleutel over).
3. Typ de code die de app toont. Andere browsers worden dan afgemeld.
4. Bewaar de **10 herstelcodes** (kopiëren of downloaden). Ben je je gsm kwijt, dan meld je je aan met *Gebruik een herstelcode*. Elke code werkt één keer; bij *Nieuwe herstelcodes* maak je een nieuwe reeks.

Na 10 foute pogingen (wachtwoord of code) binnen 10 minuten blokkeert HomeBaseOS dat adres 5 minuten.
De code hangt af van de klok: staat de klok van je gsm of je server verkeerd, dan klopt de code niet. Debian houdt de klok gelijk met `systemd-timesyncd`.

**Alles kwijt (gsm én herstelcodes)?** Meld je aan op de server zelf en voer `sudo rm /var/lib/homebaseos/auth.json && sudo systemctl restart homebaseos` uit. Dan staat tweestapsverificatie uit en maak je opnieuw een account aan.

## Veiligheid

- HomeBaseOS draait als **root**: het kan VM's en schijfbestanden wissen. Daarom kan je niets doen tot er een account is: zonder account geeft de server alleen de welkomstwizard.
- **Stel HomeBaseOS niet open naar het internet.** Gebruik voor toegang van buitenaf een VPN (WireGuard, Tailscale of de VPN van je router).
- Het VNC-scherm van een VM is bereikbaar in je netwerk, beveiligd met een wachtwoord van 8 tekens. Ook dat hoort niet op het internet. De console in de browser loopt via HomeBaseOS en vraagt dus ook je aanmelding.
- Stoppen, afsluiten en verwijderen vragen altijd eerst om bevestiging.

## Problemen oplossen

- **HomeBaseOS start niet**: bekijk `journalctl -u homebaseos -e`.
- **"virsh is niet geïnstalleerd"** of **"Docker is niet bereikbaar"**: voer `sudo ./install.sh` opnieuw uit.
- **"De map voor VM-schijven bestaat niet"** of **"Er is nog geen map voor appgegevens"**: maak een pool aan bij *Opslag*, of kies een pool bij *Instellingen > Opslag*.
- **Geen CPU/RAM bij een VM**: het geheugen komt van de balloon-driver in de VM. Zonder die driver toont HomeBaseOS wat de VM op de server inneemt.
- **"De appcatalogus kon niet geladen worden"**: de server heeft internet nodig om de feed op te halen. Daarna werkt hij 24 uur uit de cache.
- **App uit de appstore start niet**: open `STACKS_DIR/<naam>/compose.yaml` en bekijk het logboek van de app. Sommige templates verwachten nog een database of een andere app (zie *Vereist* in de appstore).
- **Ollama niet bereikbaar**: controleer of de container draait en of `OLLAMA_URL` klopt.
- **Back-up mislukt**: open het *Logboek* van de taak. Met *Testen* bij Verbindingen zie je of de verbinding nog werkt; bij Google, Microsoft en Dropbox kan het aanmelden verlopen zijn (bv. na een nieuw wachtwoord): klik dan op *Opnieuw aanmelden*.

## Licenties

De console gebruikt [noVNC](https://github.com/novnc/noVNC) 1.7.0 (MPL-2.0, met pako onder MIT), ongewijzigd in `public/vendor/novnc`.
De terminal gebruikt [xterm.js](https://xtermjs.org) 6.0.0 met addon-fit (MIT), ongewijzigd in `public/vendor/xterm`.
