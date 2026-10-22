# Thuisbasis

Een eenvoudig, overzichtelijk beheersysteem voor je thuisserver, in de stijl van ZimaOS en HexOS.
Thuisbasis draait op een gewone **Debian 13** en beheert drie dingen voor je: **ZFS** voor opslag, **KVM/libvirt** voor virtuele machines en **Docker** voor apps.

**Wat kan het?**

- **Startscherm** met klok, CPU, RAM, VRAM, vrije opslag, AI-status en je VM's met live CPU en RAM
- **Apps**: al je Docker-containers als pictogrammen. Een oranje pijltje op een app betekent dat er een nieuwe versie is (Thuisbasis kijkt elke 6 uur, of meteen met *Nu controleren*). **Klik** om de webinterface te openen, **rechtsklik** (of ⋯) voor het menu: starten, stoppen, herstarten, bijwerken, logboek (live), console en instellingen (adres van de webinterface, pictogram, automatisch starten, en de container zelf: image, poorten, mappen, variabelen, apparaten en labels in een formulier zoals in Unraid, of het compose-bestand als tekst)
- **Appstore**: bijna 4000 apps uit de catalogus van Unraid Community Apps. Zoeken, kiezen, een paar velden invullen en installeren. Thuisbasis maakt er een compose-bestand van
- **VM's** (eigen pagina): aanmaken (Linux, Windows 11 of een bestaande schijf zoals Home Assistant OS), bewerken, verwijderen, live CPU en RAM, en automatisch starten **met uitstel** als de server opstart
- **Opslag**: ZFS-pools met gezondheid en de laatste controle (scrub), alle schijven met temperatuur en SMART, je datasets, een overzicht van je schijfbays en een venster om een pool aan te maken
- **AI**: Ollama-modellen bekijken, laden, ontladen, downloaden en verwijderen, en snel iets vragen aan je eigen model
- **Instellingen** (tandwiel rechtsboven): taal (Nederlands of Engels) en thema, de netwerkinstellingen van de server (IP-adres, DHCP of vast, DNS, hostnaam, bridge voor VM's) met automatisch terugzetten als je niet bevestigt, Docker-netwerken (bridge, macvlan, ipvlan) voor je apps, en alle info over de server, de hardware en de versies
- Licht en donker thema, werkt ook op je gsm

## Installeren

### 1. Debian 13 installeren

Installeer **Debian 13 (trixie)** vanaf de netinst-ISO op de opstartschijf (bv. een kleine SSD, niet op je dataschijven).
Kies bij *Software selection* alleen **SSH server** en **standard system utilities**, geen desktop.

### 2. Thuisbasis installeren

Kopieer de map `thuisbasis` naar de server (bv. met `scp -r thuisbasis gebruiker@IP-van-je-server:`) en voer uit:

```bash
cd thuisbasis
sudo ./install.sh            # met een NVIDIA-kaart: sudo ./install.sh --nvidia
```

Het script installeert ZFS, KVM/libvirt, Docker en Thuisbasis, en zet Thuisbasis aan als systemd-service.
Op het einde toont het het adres en je **wachtwoord**. Dat staat ook in `/etc/thuisbasis/thuisbasis.env`.
Opnieuw uitvoeren werkt Thuisbasis bij. Je instellingen blijven staan.

### 3. Een ZFS-pool maken

Het makkelijkst gaat het in Thuisbasis zelf: **Opslag > Pool aanmaken**. Vink de schijven aan, kies de indeling (stripe, mirror, RAID-Z1/2/3 of mirror-paren) en je ziet meteen hoeveel opslag je overhoudt, hoeveel schijven mogen uitvallen en wat er ongebruikt blijft bij schijven van verschillende grootte. Schijven waarop het systeem staat of die al in een pool zitten, kan je niet kiezen. Thuisbasis gebruikt dezelfde opties als hieronder (ashift=12, lz4, /dev/disk/by-id). Wil je het liever met de hand doen:

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

Zet daarna in `/etc/thuisbasis/thuisbasis.env` de juiste mappen, bv. `VM_DIR=/snel/vms` en `ISO_DIR=/tank/isos`, en voer `sudo systemctl restart thuisbasis` uit.
Debian voert elke maand automatisch een controle (scrub) uit. In Thuisbasis zie je onder **Opslag** wanneer dat voor het laatst gebeurde.
Onder **Opslag > Schijfbays** teken je je kast na: kies het aantal bays en hoeveel er op een rij staan, en sleep elke schijf naar de bay waarin ze zit. Thuisbasis onthoudt de schijf aan haar serienummer. Valt een schijf uit of haal je ze eruit, dan kleurt haar bay rood met het model en serienummer, zodat je meteen weet welke je moet vervangen.

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
Herstart daarna de server, zet `VM_NETWORK=bridge=br0` in `/etc/thuisbasis/thuisbasis.env` en herstart Thuisbasis.
Je kan de bridge ook maken in *Instellingen > Netwerk*. Het netwerk van een VM kies je bij het aanmaken of later bij *Bewerken > Netwerk*.

## VM's

- **Nieuwe VM**: zet eerst een ISO (of een schijfbestand) in `ISO_DIR`. Kies daarna in Thuisbasis *Nieuwe VM* en het netwerk. De VM start meteen.
- **Console**: de knop *Console* opent het scherm van de VM groot in Thuisbasis, met toetsenbord en muis (noVNC). Daar installeer je het besturingssysteem.
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
- **Home Assistant OS**: download het KVM-bestand (`haos_ova-….qcow2.xz`) van home-assistant.io, pak het uit met `unxz`, zet het in `ISO_DIR` en kies *Bestaande schijf*. Thuisbasis maakt er een kopie van.
- **Automatisch starten met uitstel**: vink *Automatisch starten* aan en kies een uitstel in seconden. Het uitstel telt vanaf het opstarten van de server.
  Met 60 seconden start de VM dus pas 1 minuut na de server. Zo heeft de server eerst tijd voor ZFS, Docker en je apps.
  Thuisbasis regelt dit zelf, dus de autostart van libvirt staat voor die VM uit.
- Wijzigingen aan CPU, geheugen, netwerk en apparaten gelden pas nadat je de VM **afsluit en opnieuw start** (een herstart vanuit de VM is niet genoeg). Een ISO wisselen en schijven groter maken gaat meteen.
  De naam wijzig je alleen als de VM uit staat.
- **Verwijderen** kan alleen als de VM uit staat. Vink *Ook de schijfbestanden wissen* aan om ook de schijven te verwijderen.
  Thuisbasis wist alleen bestanden binnen `VM_DIR`. Alles daarbuiten blijft staan, en dat zie je in de melding.

## Appstore

De appstore gebruikt de catalogus van **Unraid Community Apps** (de feed `applicationFeed.json`, niet de Unraid-plugin zelf).
Thuisbasis haalt hem één keer per dag op. Met *Nu vernieuwen* kan het ook meteen.
Plugins, verouderde apps en apps op de zwarte lijst van Community Apps laat Thuisbasis weg.

Omdat de templates voor Unraid gemaakt zijn, vertaalt Thuisbasis ze bij het installeren:

| In het template | Op je server |
|---|---|
| `/mnt/user/appdata/...`, `/mnt/cache/appdata/...` | `APPDATA_DIR/...` (standaard `/snel/appdata`) |
| andere `/mnt/user/...`, `/mnt/diskN/...` | `SHARES_DIR/...` (standaard `/tank`) |
| een leeg `/config`-pad | `APPDATA_DIR/<naam>` (zoals Community Apps dat ook doet) |
| `PUID=99`, `PGID=100`, `--user 99:100` | `APP_UID`, `APP_GID` (standaard 1000) |
| `TZ` | de tijdzone van je server |
| `--runtime=nvidia`, `--gpus all` | GPU-reservering in compose |
| netwerk `br0` of eigen netwerken | een Docker-netwerk met dezelfde naam als dat bestaat, anders het standaardnetwerk (met een waarschuwing). Bij het installeren kies je zelf een netwerk en eventueel een vast IP-adres. |
| Unraid-mappen zoals `/usr/local/emhttp` en `/boot` | weggelaten (met een waarschuwing) |

Per app komt er een `compose.yaml` in `STACKS_DIR/<naam>` (standaard `/opt/stacks`, dezelfde map die Dockge gebruikt). Je kan het bestand dus ook zelf aanpassen.
Voor privileged apps, apps met toegang tot Docker, apps op het host-netwerk en extra Docker-opties die niet overgenomen worden, toont Thuisbasis eerst een waarschuwing.
Poorten kan je altijd aanpassen, en met *+ Poort* voeg je er extra toe. Gebruikt een app het host-netwerk (bv. Plex of Home Assistant), dan luistert ze op haar eigen poorten. Pas je toch een poort aan, dan kiest Thuisbasis het standaardnetwerk (bridge). Sommige apps zoeken toestellen in je netwerk en werken daarom het best met host.
Apps uit de appstore kan je ook weer **verwijderen** (in het detailvenster van de app). Vink aan of hun gegevens mee weg moeten.
Thuisbasis wist alleen mappen binnen `APPDATA_DIR`.

> De templates zijn het werk van hun eigen maintainers. Community Apps (van Squid) verzamelt en controleert ze.
> Gebruik de catalogus voor je eigen server. Wil je Thuisbasis publiceren, vraag het dan eerst na bij de makers van Community Apps.

## Apps

Thuisbasis toont alle Docker-containers. Je zet apps het best op met **Docker Compose**: dan werkt ook de knop *Bijwerken* (die haalt het nieuwste image op en maakt de container opnieuw).
Heeft een app geen eigen pictogram, dan zoekt Thuisbasis er een in de catalogus van Community Apps (zelfde image) of in de open verzameling [dashboard-icons](https://github.com/homarr-labs/dashboard-icons). Lukt dat niet, dan zie je een gekleurde letter.
Met twee labels kies je zelf het pictogram en het adres:

```yaml
services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports: ["8096:8096"]
    volumes: ["/snel/appdata/jellyfin:/config", "/tank/media:/media"]
    labels:
      thuisbasis.icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/jellyfin.png"
      thuisbasis.webui: "http://[IP]:[PORT:8096]/"
```

**Ollama met je NVIDIA-kaart** (na `install.sh --nvidia` en een herstart):

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

In `/etc/thuisbasis/thuisbasis.env`, daarna `sudo systemctl restart thuisbasis`.

| Variabele | Betekenis |
|---|---|
| `APP_PASSWORD` | Wachtwoord voor de webinterface (verplicht) |
| `SESSION_SECRET` | Vaste sleutel voor aanmeldingen (anders moet je na een herstart opnieuw aanmelden) |
| `PORT` | Poort, standaard `8080` |
| `OLLAMA_URL` | Adres van Ollama, bv. `http://127.0.0.1:11434` |
| `VM_DIR` | Map voor VM-schijven, standaard `/tank/vms` |
| `ISO_DIR` | Map met ISO's en schijfbestanden, standaard `/tank/isos` |
| `VM_NETWORK` | `network=default` (NAT) of `bridge=br0` (thuisnetwerk) |
| `APPDATA_DIR` | Gegevens van apps uit de appstore, standaard `/snel/appdata` |
| `SHARES_DIR` | Waar Unraid-shares uit templates naartoe gaan, standaard `/tank` |
| `STACKS_DIR` | Compose-bestanden van de appstore, standaard `/opt/stacks` |
| `APP_UID`, `APP_GID` | Gebruiker voor apps (in plaats van 99:100 van Unraid), standaard `1000` |
| `STORE_FEED_URL` | Andere bron voor de catalogus (optioneel) |
| `DATA_DIR` | Eigen instellingen en de cache van de catalogus, standaard `/var/lib/thuisbasis` |
| `DEMO` | `1` = demo-modus met voorbeelddata |

## Netwerk aanpassen

In *Instellingen > Netwerk* stel je het IP-adres van de server in (DHCP of vast), de gateway, de DNS-servers en de bridge `br0` voor VM's.
Dat werkt als Debian het netwerk beheert met ifupdown (`/etc/network/interfaces`), de standaard voor een server zonder desktop.
Na *Toepassen* heb je **2 minuten om te bevestigen**. Bevestig je niet, bijvoorbeeld omdat de server niet meer bereikbaar is, dan zet Thuisbasis de oude instellingen vanzelf terug.
Verandert het adres, open dan het nieuwe adres en bevestig daar. De vorige versie van de bestanden staat in `/var/lib/thuisbasis/netwerk-vorige`.

## Docker-netwerken

In *Instellingen > Docker-netwerken* maak je netwerken voor je apps:

- **Bridge**: een eigen netwerk tussen apps. Apps in hetzelfde netwerk vinden elkaar op naam (bv. `http://database:5432`). Met *Zonder internet* kunnen ze alleen elkaar bereiken.
- **macvlan**: elke app krijgt een eigen IP- en MAC-adres in je thuisnetwerk, zoals `br0` in Unraid. Handig voor Pi-hole of AdGuard (poort 53) of apps die je router als apart toestel moet zien. Kies een *IP-bereik* dat je router niet via DHCP uitdeelt.
- **ipvlan**: zoals macvlan, maar alle apps delen het MAC-adres van de server. Voor routers of switches die moeilijk doen met veel MAC-adressen.

Let op: met macvlan en ipvlan kan de server zelf de apps niet bereiken via hun eigen adres (andere toestellen in je netwerk wel). Zo werkt Linux.

Een app in een netwerk zetten doe je bij de instellingen van de app (compose-formulier, veld *Netwerk*, eventueel met een vast IP-adres) of bij het installeren uit de appstore. In het compose-bestand komt dat als een `external`-netwerk.

## Veiligheid

- Thuisbasis draait als **root**: het kan VM's en schijfbestanden wissen. Daarom start het niet zonder wachtwoord.
- **Stel Thuisbasis niet open naar het internet.** Gebruik voor toegang van buitenaf een VPN (WireGuard, Tailscale of de VPN van je router).
- Het VNC-scherm van een VM is bereikbaar in je netwerk, beveiligd met een wachtwoord van 8 tekens. Ook dat hoort niet op het internet. De console in de browser loopt via Thuisbasis en vraagt dus ook je aanmelding.
- Stoppen, afsluiten en verwijderen vragen altijd eerst om bevestiging.

## Problemen oplossen

- **Thuisbasis start niet**: bekijk `journalctl -u thuisbasis -e`. Vaak ontbreekt `APP_PASSWORD`.
- **"virsh is niet geïnstalleerd"** of **"Docker is niet bereikbaar"**: voer `sudo ./install.sh` opnieuw uit.
- **"De map voor VM-schijven bestaat niet"**: maak de dataset (`zfs create snel/vms`) of pas `VM_DIR` aan.
- **Geen CPU/RAM bij een VM**: het geheugen komt van de balloon-driver in de VM. Zonder die driver toont Thuisbasis wat de VM op de server inneemt.
- **"De appcatalogus kon niet geladen worden"**: de server heeft internet nodig om de feed op te halen. Daarna werkt hij 24 uur uit de cache.
- **App uit de appstore start niet**: open `STACKS_DIR/<naam>/compose.yaml` en bekijk het logboek van de app. Sommige templates verwachten nog een database of een andere app (zie *Vereist* in de appstore).
- **Ollama niet bereikbaar**: controleer of de container draait en of `OLLAMA_URL` klopt.

## Licenties

De console gebruikt [noVNC](https://github.com/novnc/noVNC) 1.7.0 (MPL-2.0, met pako onder MIT), ongewijzigd in `public/vendor/novnc`.
