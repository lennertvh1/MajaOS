# MajaOS user guide

Everything MajaOS does, page by page. New here? Start with the [README](../README.md).

## Installing with the ISO (recommended)

Every release has an installation ISO: `majaos-<version>-amd64.iso`. It is the official Debian 13 net installer with MajaOS added.

1. Turn **Secure Boot off** in the BIOS (the ZFS and NVIDIA modules are not signed). Set the server to UEFI.
2. Put the ISO on a USB stick with [balenaEtcher](https://etcher.balena.io), or: `sudo dd if=majaos-….iso of=/dev/sdX bs=4M status=progress conv=fsync`.
3. Boot the server from the stick and choose **Install MajaOS**. The server needs internet.
4. The installer asks for a language, then the disk. It marks the USB stick and will not install on it. *Erase and install* confirms that disk. Tick **Install the NVIDIA driver** if the computer has an NVIDIA card. You create your account later in the browser. The account `maja` exists for the system and is locked.
5. The same screen stays up while Debian is installed (the computer needs internet). Then click *Restart* and remove the USB stick. MajaOS installs itself after the reboot (5 to 15 minutes). The address appears on the server's screen. Open that address in your browser: the welcome wizard creates your account and does the rest.

The language you pick is the language of the welcome wizard. The keyboard stays Belgian AZERTY, and the country and time zone stay Belgium and Europe/Brussels (change them in `iso/preseed.cfg`; the time zone also in the wizard). Building the ISO with the graphical screen needs Linux, root and `./iso/build-iso.sh --live` (debootstrap and squashfs-tools). Without `--live` the stick still boots the Debian installer, which asks for the disk itself. If the installation fails at the first boot, the screen says so; the log is `/var/log/majaos-firstboot.log` and `sudo systemctl restart majaos-firstboot` tries again.

**Building the ISO yourself.** Run **`./build-iso.sh`** from the repo (see **[docs/build-iso.md](build-iso.md)** for WSL2, Docker, and details). Releases: tag `vX.Y.Z` on `main` builds the ISO via `.github/workflows/iso.yml`, or *Actions → Release and ISO → Run workflow*. On `dev`, pushes that change the installer run a smoke build in *Test*; download a test ISO manually from *Actions → Test → Run workflow* when artifact quota allows.

## Installing by hand

### 1. Install Debian 13

Install **Debian 13 (trixie)** from the netinst ISO on the boot disk (e.g. a small SSD, not on your data disks).
Under *Software selection* choose only **SSH server** and **standard system utilities**, no desktop.

### 2. Install MajaOS

Copy the `majaos` folder to the server (e.g. with `scp -r majaos user@IP-of-your-server:`) and run:

```bash
cd majaos
sudo ./install.sh            # with an NVIDIA card: sudo ./install.sh --nvidia
```

The script installs ZFS, KVM/libvirt, Docker and MajaOS, and turns MajaOS on as a systemd service.
At the end it shows the address. Open it in your browser and create your **account** (user name and password) in the welcome wizard.
Running it again updates MajaOS. Your settings stay.

### 3. Create a ZFS pool

The easiest way is in MajaOS itself: in the welcome wizard (step *Storage*) or later under **Storage > Create pool**. Tick the disks, choose the layout (stripe, mirror, RAID-Z1/2/3 or mirror pairs) and you see right away how much storage you keep, how many disks may fail and what stays unused with disks of different sizes. Disks that hold the system or are already in a pool can't be chosen. MajaOS uses the same options as below (ashift=12, lz4, /dev/disk/by-id) and right away creates the folders (datasets) `appdata`, `media`, `backups`, `vms` and `isos` on the pool. Whatever had no place yet (app data, VM disks, ISOs and the shared folders of Unraid apps) goes on that first pool. You can move to another pool later in **Settings > Storage** (see *Moving app data*). Prefer to do it by hand:

> **Careful:** `zpool create` erases the disks you give it. Check first which disks they are.

Always use the names from `/dev/disk/by-id/`, because `sda` and `sdb` can swap after a reboot:

```bash
ls -l /dev/disk/by-id/ | grep -v part

# 4 HDDs as raidz1: one disk may fail, about 6 TB usable with 4× 2 TB
sudo zpool create -o ashift=12 -O compression=lz4 -O atime=off -O xattr=sa -O acltype=posixacl \
  tank raidz1 /dev/disk/by-id/ata-DISK1 /dev/disk/by-id/ata-DISK2 /dev/disk/by-id/ata-DISK3 /dev/disk/by-id/ata-DISK4

# 2 SSDs as a mirror for apps and VM disks
sudo zpool create -o ashift=12 -O compression=lz4 -O atime=off -O xattr=sa fast mirror /dev/disk/by-id/nvme-SSD1 /dev/disk/by-id/nvme-SSD2

# Datasets
sudo zfs create tank/isos        # ISOs and disk files
sudo zfs create fast/vms         # VM disks (fast, on SSD)
sudo zfs create fast/appdata     # data of your Docker apps
sudo zfs create tank/media
```

MajaOS finds such folders by itself at the next start (a dataset `<pool>/appdata`, `<pool>/vms` or `<pool>/isos`). Otherwise choose in **Settings > Storage** which pool you use for what.

#### Moving app data

In **Settings > Storage** you choose another pool for the app data and click *Move*. MajaOS stops the apps that have a folder there, copies everything with `rsync` to `/<pool>/appdata`, changes the paths in their compose files (with a `.bak`) and starts them again. The old folder stays: remove it yourself when everything works. Apps without a compose file on the server (started with `docker run`, or managed by Portainer, which keeps the file in its own container) don't move along; MajaOS shows which ones. Apps from the app store and Dockge stacks do move along. You also choose a pool there for VM disks, ISOs and shared folders; existing files then stay where they are.
Debian runs a check (scrub) automatically every month. In MajaOS you see under **Storage** when that last happened.
Under **Storage > Drive bays** you draw your case: choose the number of bays and how many are on a row, and drag each disk to the bay it is in. MajaOS remembers the disk by its serial number. If a disk fails or you take it out, its bay turns red with the model and serial number, so you know right away which one to replace.

### 4. VMs in your home network (bridge)

By default new VMs go behind libvirt's NAT: they can reach out, but you can't reach them from your network.
For **Home Assistant** and most servers you want them directly in your home network. Create a bridge for that.
Find the name of your network card with `ip -br link` (e.g. `enp5s0`) and change `/etc/network/interfaces`:

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

Preferably do this with a screen and keyboard on the server: if there is a typo, you lose the connection.
Then reboot the server. MajaOS automatically selects `br0` for new VMs when the bridge exists; otherwise it uses libvirt NAT.
You can also create the bridge in *Settings > Network*. You choose a VM's network when creating it or later under *Edit > Network*.

## VMs

- **New VM**: first put an ISO (or a disk file) in `ISO_DIR`. Then choose *New VM* in MajaOS and the network. The VM starts right away.
- **Console**: the *Console* button opens the VM's screen large in MajaOS, with keyboard and mouse (noVNC). That is where you install the operating system.
  With *Pop out* you put the console in a browser window of its own (e.g. on a second screen). *Ctrl+Alt+Del* goes to the VM and not to your Mac.
  **Pasting** (Cmd+V or Ctrl+V in the console) types the text from your clipboard in the VM. That always works, also in an installer or the Home Assistant OS console.
  **Copying out of the VM** needs an agent in the VM: turn on clipboard sharing under *Edit > Screen*, install `spice-vdagent` (Linux) or the SPICE guest tools (Windows) in the VM and restart the VM. What you then copy in the VM ends up on your PC (over http through the *Copy to this PC* button).
  Prefer your own VNC program? The address and the password are under *Edit > Screen*.
- **Edit** has tabs:
  - *CPU and memory*, with **pinned cores** (CPU pinning like in Unraid): choose the cores the VM always runs on. Take both threads of a core and leave core 0 for the server.
  - *Network*: add or remove network cards, the network (bridge `br0` or a VM network), the kind of card and the MAC address.
  - *Storage*: add disks, make them larger or detach them (the file stays), put an ISO in the cd-rom and choose whether the VM boots from the disk or the cd-rom first.
  - *Devices*: pass through **USB** (e.g. a Zigbee stick for Home Assistant) and **PCI** (e.g. the GPU). PCI needs IOMMU: turn on *AMD-Vi/IOMMU* in the BIOS. Pass through all devices of the same IOMMU group together (e.g. the GPU and its audio). Ollama can't use a passed-through GPU while the VM runs.
- **VM networks** (*Settings > VM networks* or the *Networks* button on the VM page): besides the bridge to your home network you create networks of your own here. *NAT*: the VMs can reach the internet, but you can't reach them from your home network. *Isolated*: only the VMs among themselves and the server, without internet.
- **Home Assistant OS**: download the KVM file (`haos_ova-….qcow2.xz`) from home-assistant.io, unpack it with `unxz`, put it in `ISO_DIR` and choose *Existing disk*. MajaOS makes a copy of it.
- **Automatic start with a delay**: tick automatic start and choose a delay in seconds. The delay counts from when the server boots.
  With 60 seconds the VM starts 1 minute after the server. That gives the server time for ZFS, Docker and your apps first.
  MajaOS handles this itself, so libvirt's autostart is off for that VM.
- Changes to CPU, memory, network and devices only apply after you **shut the VM down and start it again** (a restart from inside the VM is not enough). Swapping an ISO and making disks larger work right away.
  You can only change the name while the VM is off.
- **Delete** only works while the VM is off. Tick *Also delete the disk files* to remove the disks too.
  MajaOS only erases files inside `VM_DIR`. Everything outside stays, and the notification tells you.

### Snapshots

In a VM's window, tab **Snapshots**: capture the VM as it is now (e.g. before an update) and go back to it later. If the VM is running, the snapshot also keeps the memory; when you go back, the VM continues where it was. A snapshot is not a backup (it is on the same disk): use *Backups → Apps and VMs* for that.

## App store

The app store uses the catalogue of **Unraid Community Apps** (the `applicationFeed.json` feed, not the Unraid plugin itself).
MajaOS fetches it once a day. *Refresh now* does it right away.
MajaOS leaves out plugins, deprecated apps and apps on the Community Apps blacklist.

Because the templates are made for Unraid, MajaOS translates them when installing:

| In the template | On your server |
|---|---|
| `/mnt/user/appdata/...`, `/mnt/cache/appdata/...` | the folder for app data (*Settings > Storage*, default `/<first pool>/appdata`) |
| other `/mnt/user/...`, `/mnt/diskN/...` | the folder for shared folders (default `/<first pool>`) |
| an empty `/config` path | `<app data>/<name>` (like Community Apps does too) |
| `PUID=99`, `PGID=100`, `--user 99:100` | `APP_UID`, `APP_GID` (default 1000) |
| `TZ` | your server's time zone |
| `--runtime=nvidia`, `--gpus all` | GPU reservation in compose |
| network `br0` or custom networks | a Docker network with the same name if it exists, otherwise the default network (with a warning). When installing you choose a network yourself, and optionally a fixed IP address. |
| Unraid folders like `/usr/local/emhttp` and `/boot` | left out (with a warning) |

### Data folder and Advanced

For every app you choose under **Data folder** where it keeps its settings and data (default `<app data>/<name>`, with your existing datasets as suggestions). All of the app's folders inside it move along; you can also change each folder separately.

Turn on **Advanced** and you get the full container form: image, restart, network, privileged, and adding your own ports, folders, variables, devices and labels. With the **Code** button you see and edit the compose file itself; exactly that file is installed (Docker Compose checks it first). Fields and code stay the same when you switch, and options the form doesn't know (e.g. the GPU) are kept. For an own app *Fields* and *Code* are always there.

While installing you see a progress bar (layers and megabytes downloaded); *Details* shows Docker's output, one line per layer like `docker pull` in a terminal.

### Own app

Is an app not in the app store? Choose **Own app** in the app store and paste the image name (e.g. `louislam/uptime-kuma`) or a link to its page (Docker Hub, GitHub packages, Quay). MajaOS reads from the registry which ports and folders the app uses, without downloading the image, and fills in the form: a free port, folders in `<app data>/<name>`, PUID/PGID and the time zone. You change everything in the same form as in an app's settings and install. You can remove an own app later like an app from the app store.

Each app gets a `compose.yaml` in `STACKS_DIR/<name>` (default `/opt/stacks`, the same folder Dockge uses). So you can also edit the file yourself.
For privileged apps, apps with access to Docker, apps on the host network and extra Docker options that aren't taken over, MajaOS shows a warning first.
You can always change ports, and *+ Port* adds extra ones (that needs the default network, bridge). If an app uses the host network (e.g. Plex or Home Assistant), it listens on its own ports: Docker can't remap them. If you change a port there, MajaOS sets the app's own port setting when the template has one (e.g. `WEBUI_PORT`) and the WebUI follows; otherwise the app keeps its port and you get a warning. Some apps look for devices in your network and therefore work best with host.

**Own address in my home network.** Want the app to be reachable at an address of its own, like a separate device (e.g. `10.10.10.155` next to a server on `10.10.10.154`)? Choose *Own address in my home network* as the network. The first time, MajaOS creates the macvlan network `lan` itself (on the card of your home network, with the router as gateway) and suggests a free address, which you can change. Reserve that address in your router. The server itself can't reach the app at that address (a Linux limitation); your PC, phone and other devices can.

**Fixed IP address.** On the default network (bridge) you can fill in a fixed address: the app then joins the MajaOS network `maja` (172.30.0.0/16, created the first time), where apps also find each other by name. In a network of your own with a subnet, or a macvlan/ipvlan network, the address must be in that network.
You can also **remove** apps from the app store again (in the app's detail window). Tick whether their data should go too.
MajaOS only erases folders inside the app data folder.

> The templates are the work of their own maintainers. Community Apps (by Squid) collects and checks them.
> Use the catalogue for your own server. If you want to publish MajaOS, ask the makers of Community Apps first.

## Apps

MajaOS shows all Docker containers. Preferably set apps up with **Docker Compose**: then the *Update* button works too (it pulls the newest image and recreates the container). While an app updates, a bar on its icon fills up; click the app (or *Update progress* in its menu) to see the progress and Docker's output. The log of the last update stays available for an hour under *Update log*.
If an app has no icon of its own, MajaOS looks for one in the Community Apps catalogue (same image) or in the open [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) collection. If that fails, you see a coloured letter.
With two labels you choose the icon and the address yourself:

```yaml
services:
  jellyfin:
    image: jellyfin/jellyfin:latest
    restart: unless-stopped
    ports: ["8096:8096"]
    volumes: ["/fast/appdata/jellyfin:/config", "/tank/media:/media"]
    labels:
      majaos.icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/jellyfin.png"
      majaos.webui: "http://[IP]:[PORT:8096]/"
```

`[PORT:8096]` becomes the port on the server that is mapped to port 8096 in the app. On the host network it is the app's own port, and with its own address (macvlan/ipvlan) `[IP]` becomes that address.

**Ollama with your NVIDIA card** (after `install.sh --nvidia` and a reboot). If Ollama isn't running yet, the AI widget says so and the AI window takes you to Ollama in the app store:

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    ports: ["11434:11434"]
    volumes: ["/fast/appdata/ollama:/root/.ollama"]
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, count: all, capabilities: [gpu] }]
```

## Developing in VS Code (on your Mac)

You only need **Node.js 18.11 or newer** (no `npm install`, there are no dependencies).

```bash
npm run demo   # sample data, works without a server: http://localhost:8080
npm test       # tests for all parsers (virsh, zpool, zfs, lsblk, Docker) and more
```

**Run and Debug** has the same options. You use `npm run dev` on the server itself, with a `.env` (see `.env.example`).
Updating on the server: copy the folder again and run `sudo ./install.sh`.

### Branches, tests and test versions

- Work happens on the **`dev`** branch. **`main`** only contains official versions. A release (with an ISO) only happens when a tag is pushed: official versions are tags on `main`, pre-releases (`v0.1.0-beta.1`) may also be tags on `dev`.
- Every push to `dev` (and `main`) runs the tests on GitHub (*Actions > Test*). When the installer changes on `dev`, that run also builds a **test ISO** with the graphical installer (`--live`), which you download from the run (kept 14 days). You can also start it by hand: *Actions > Test > Run workflow*.
- A **test server** follows `dev` directly, without releases: *Settings > Software update > Development*. Every new commit on `dev` then shows up as an update (`0.6.0+dev.abc1234`, with the commit messages as notes) and *Update now* installs it, with the same backup copy and rollback as a normal update.
- The first time (an older HomeBaseOS server may not know that channel yet), on the test server:

  ```bash
  curl -fsSL -o install-branch.sh https://raw.githubusercontent.com/lennertvh1/MajaOS/dev/deploy/install-branch.sh
  sudo bash install-branch.sh dev
  ```

  `sudo bash /opt/majaos/deploy/install-branch.sh main` puts the server back on official releases.
- Releasing: bump the version in `package.json` on `dev`. For a pre-release, tag `vX.Y.Z-beta.N` on `dev` and push the tag. For an official version, merge `dev` into `main`, push, and push a tag `vX.Y.Z` on `main` (see *Software update*).

### Translations

The English text in the code is the key (like gettext): `t('Remove {name}?', { name })` in `public/app.js`. Translations are in `public/lang/<code>.js`; `public/lang/languages.js` lists the languages and loads them.
To add a language: copy `public/lang/nl.js` to `public/lang/<code>.js`, translate the values (keep the `{placeholders}`) and add a line to `public/lang/languages.js` with its name and locale. The server accepts every language in that list. Server messages are English too; the browser translates them with the same file (templates with `{placeholders}` also match messages with values in them).

## Settings

In `/etc/majaos/majaos.env`, then `sudo systemctl restart majaos`.

| Variable | Meaning |
|---|---|
| `APP_PASSWORD` | Only for older installs: applies as long as there is no account of your own. Empty = create an account the first time |
| `SESSION_SECRET` | Fixed key for sign-ins (otherwise you have to sign in again after a restart) |
| `PORT` | Web interface port if Settings has none. Unset = `80`. Settings → General overrides this |
| `OLLAMA_URL` | Address of Ollama, e.g. `http://127.0.0.1:11434` |
| `VM_DIR`, `ISO_DIR` | Older installs: folder for VM disks and for ISOs. Now in *Settings > Storage*; the variable only applies if nothing is chosen there |
| `VM_NETWORK` | `network=default` (NAT) or `bridge=br0` (home network) |
| `APPDATA_DIR`, `SHARES_DIR` | Older installs: app data and the folder for Unraid shares. Now in *Settings > Storage* (same precedence) |
| `STACKS_DIR` | Compose files of the app store, default `/opt/stacks` |
| `APP_UID`, `APP_GID` | User for apps (instead of Unraid's 99:100), default `1000` |
| `STORE_FEED_URL` | Another source for the catalogue (optional) |
| `DATA_DIR` | Own settings and the catalogue cache, default `/var/lib/majaos` |
| `DEMO` | `1` = demo mode with sample data |

## Changing the network

In *Settings > Network* you set the server's IP address (DHCP or static), the gateway, the DNS servers and the bridge `br0` for VMs.
That works when Debian manages the network with ifupdown (`/etc/network/interfaces`), the default for a server without a desktop.
After *Apply* you have **2 minutes to confirm**. If you don't confirm, for example because the server is no longer reachable, MajaOS puts the old settings back by itself.
If the address changes, open the new address and confirm there. The previous version of the files is in `/var/lib/majaos/network-previous`.

## Docker networks

In *Settings > Docker networks* you create networks for your apps:

- **Bridge**: a network of its own between apps. Apps in the same network find each other by name (e.g. `http://database:5432`). With *without internet* they can only reach each other.
- **macvlan**: each app gets its own IP and MAC address in your home network, like `br0` in Unraid. Handy for Pi-hole or AdGuard (port 53) or apps your router should see as a separate device. Choose an *IP range* your router doesn't hand out through DHCP.
- **ipvlan**: like macvlan, but all apps share the server's MAC address. For routers or switches that have trouble with many MAC addresses.

Note: with macvlan and ipvlan the server itself can't reach the apps at their own address (other devices in your network can). That's how Linux works.

You put an app in a network in the app's settings (compose form, field *Network*, optionally with a fixed IP address) or when installing from the app store. The *Own address in my home network* option is always available; MajaOS uses the server's home interface, which can be `br0`. In the compose file it becomes an `external` network.

## Shared folders

With the **Shared folders** button at the top you share folders with your PCs, Macs and phones (Samba):

1. First create **users** with a password (e.g. one for each family member) in **Settings → Users**. They can only reach the shared folders, not sign in to the server or the dashboard.
2. Optionally create **groups** (e.g. *Family*, *Parents*) and put the users in them. A group gives all its members the same rights; whoever is in several groups gets the highest right.
3. Create a **shared folder**: a new folder on a pool (MajaOS makes it a dataset of its own, e.g. `tank/media`) or an existing folder.
4. Choose per user and per group *No access*, *Read* or *Read and write*. Optionally guests may read without a password, or you use the folder for **Time Machine**.

In **Settings → Users** you see per user what they may do in each folder, and whether that is direct or through a group.

Connecting: on a Mac through Finder → Go → Connect to Server (`smb://freddy.local/media`), on Windows with `\\freddy\media` in Explorer.
Files are written as the app user (`APP_UID`), the same as for your Docker apps, so e.g. Jellyfin and your PC use the same folders without permission problems.
Deleting a shared folder only stops sharing; the files stay.

## Backups

With the **Backups** button at the top. There are three tabs:

**Apps and VMs**: a copy of the apps and VMs you tick, in a folder on the NAS (e.g. `/tank/backups/system`), by hand or on a schedule; the last *n* are kept. For an app the compose files, the folders in the app data and the Docker volumes go along (not your media: keep those with Sync); the app stops briefly so databases give a consistent copy. A VM is copied while it runs (libvirt) or after a brief shutdown. *Restore…* puts an app or VM back from a chosen backup; what was there moves aside first (`.before-restore-<date>`). Want that folder off-site too? Create a task for it under Sync.

**Devices**: backups of your PCs, Macs and phones on the NAS, in two ways.

*With the Kopia backup app* (recommended for Windows and Linux): turn on the backup app once and choose a pool. MajaOS then starts a Kopia server on the NAS (port 51515) with an encrypted repository in `<pool>/backups/kopia`. You see the **repository password** only once: keep it safe. Then add a device per PC; you get a **pairing code**. Install the **MajaOS Backup** app on the PC (a version of KopiaUI in the same style as MajaOS, [download](https://github.com/lennertvh1/kopia/releases/latest)), type the address of your MajaOS and the code, and choose what you want to keep (Documents, Desktop, Pictures …). The regular KopiaUI or the command line work too: the steps (address, fingerprint, name, password) are listed with the device. The device then makes a backup every hour while KopiaUI runs, and old versions are kept (24 hourly, 14 days, 8 weeks, 12 months, 3 years). You restore in the app. MajaOS shows per device when the last backup was.

*With a shared folder of its own*: each device gets a dataset of its own (`<pool>/backups/<name>`) with a maximum size, and a shared folder only the chosen user can reach. For a Mac, Time Machine is on right away. *How to set it up* lists the steps per kind of device (Time Machine, Windows File History, Déjà Dup on Linux, PhotoSync or FolderSync on your phone).

**Connections**: places outside the NAS. You link Google Drive, OneDrive and Dropbox by signing in in your browser:

1. Click sign in. A Google, Microsoft or Dropbox tab opens.
2. Sign in and click *Allow*. The tab then ends up at `http://127.0.0.1:53682/…` and shows an error. That is normal.
3. Copy that address from the address bar and paste it in MajaOS.

If that doesn't work, you can also run `rclone authorize "drive"` (or `onedrive`, `dropbox`) on a PC with rclone and paste the token.
Another NAS goes through SFTP (SSH: Synology, QNAP, TrueNAS, another MajaOS), SMB (a shared folder) or WebDAV (Nextcloud). S3 storage is possible too (Backblaze B2, Wasabi, Cloudflare R2, Amazon S3, MinIO).

**Sync**: tasks that put a folder on the NAS on a connection (or the other way round), by hand, every hour, every day or every week:

- *Copy* transfers new and changed files and never deletes anything on the other side. *Sync* makes an exact copy: what you delete on the NAS disappears there too.
- *Encrypt* (rclone crypt): files and folder names are encrypted before they leave the NAS. Without the password nobody gets them back, not even you. With rclone and the same password you can get them back without MajaOS too.
- *Keep old versions*: what gets overwritten or deleted goes to a folder next to it (`… (old versions)/<date>`) and disappears after the chosen number of days. Tasks created before version 0.6 keep their Dutch folder names on the destination (`(oude versies)`, and `bestanden`/`versies` when encrypted), so they keep finding their files.
- *Dry run* shows in the log what a task would do, without changing anything. *Restore* brings everything back to a (new) folder on the NAS.

MajaOS uses [rclone](https://rclone.org) (`install.sh` installs it). Connections are in `/var/lib/majaos/rclone.conf` (readable by root only). A sync doesn't start if the source folder is empty or the pool isn't mounted, so nothing gets deleted on the other side by accident.

## Restart and shut down

With the power button at the top (next to Settings) you restart or shut down the server, always after a confirmation. After a restart the page comes back by itself once the server runs again.

## Terminal on the server

At the top right the terminal icon opens a **root shell on the server**, with colours, `top`, `nano`, tab completion, copy and paste (xterm.js). *Pop out* puts it in a browser window of its own.
In **Settings > Security** you turn the terminal on or off, and choose whether MajaOS asks for your password again when opening it (on by default). Making security less strict always asks for your password. Every time someone opens or closes the terminal is logged in `journalctl -u majaos`.

## MCP server

MajaOS speaks the Model Context Protocol at `/mcp`. A program adds that address and signs in, the same way Home Assistant does. It can then do what the interface can: apps, the app store, VMs, files, shares, storage, backups, network, settings and AI. `shell_run` runs one root command, with the same switch and password as the terminal. Tools that delete, shut down or reboot need `confirm: true`.

**Settings → MCP** shows the address. In Claude: Settings → Connectors → Add custom connector, paste the address, choose Connect and sign in. Claude reaches the server from the internet, so that address has to be reachable there (https, without another port). On your own network, Cursor, VS Code and Claude Code use the same address directly (`claude mcp add --transport http majaos <address>`, then `claude mcp login majaos`).

Sign-in is OAuth with PKCE. The program opens MajaOS, you type the account password (and the two-step code, if that is on), and the program gets a session for 30 days. Changing your password signs it out. Turn the terminal on in Settings → Security before using `shell_run`.

## Software update

**Settings > Software update** shows whether there is a new version of MajaOS, with the release notes of each new version. MajaOS checks every 12 hours (or right away with *Check now*) among the releases on GitHub. If there is an update, you get a notification and a red dot on the gear. With *Include beta versions* you also see pre-releases; *Development* follows the `dev` branch (for a test server, see *Branches, tests and test versions*).

The repository is private. So create a **fine-grained token** on GitHub (Settings > Developer settings > Personal access tokens) with access to `majaos` only and read access to *Contents*, and put it in `/etc/majaos/majaos.env`:

```
UPDATE_TOKEN=github_pat_...
```

Then `sudo systemctl restart majaos`.

With **Update now** MajaOS does everything itself, with a progress bar: download, check, a backup copy of the current version, install, restart and test. If the new version doesn't start within 45 seconds, MajaOS puts the previous version back automatically. Your apps and VMs keep running; your settings aren't touched. What happened is in `journalctl -u 'majaos-update-*'`.

Making a release: put the new number in `package.json` on `dev`, merge `dev` into `main`, and push a tag `v<number>` on `main` with the release notes as the tag message (`git tag -a v0.6.0 --cleanup=verbatim -F notes.md`, first line = title). The workflow creates the release and attaches the ISO; tags that aren't on `main` are refused.

If you work from a git folder on the server, you update with `git pull` and `sudo ./install.sh`.

## Updates of Debian

**Settings > Software update** also has a section **Debian (the system)**:

- **Security updates are installed automatically** every day (unattended-upgrades; on by default since 0.6). The server never restarts by itself: a new kernel needs the ZFS module built first.
- You see how many updates are waiting (and how many are security updates), when the automatic updates last ran, and the list of packages. *Check now* fetches the package lists, **Update Debian now** installs everything (also Docker, Kopia and NVIDIA, which are never updated automatically), with the log under *Details*.
- **A restart is needed** appears after a new kernel or library. *Restart now* only shows when ZFS is ready for the new kernel; otherwise MajaOS says to wait.
- Services that use an updated library are restarted automatically (needrestart), but never Docker, so your apps keep running.

## Date and time

In **Settings > General** you choose the server's **time zone** (apps from the app store get the same `TZ`), and whether the time is set automatically over the internet (NTP). You can enter your own time servers, e.g. `be.pool.ntp.org` or your router; empty = Debian's default. If you turn NTP off, you set the date and time yourself. That is also where you choose the **time format** (24 or 12 hour) for everyone.

## Signing in the first time

After the installation, open the server's address. There is no password yet: the **welcome wizard** opens right away (without the dashboard behind it) and asks for the language and theme, and then an **account** (user name and password). Then come the server's name and time zone, storage (you can create a pool right in that step) and two-step verification. You may skip those steps; *Set up later* closes the wizard. You open it again in **Settings > General**.

> Until the account exists, anyone in your network can create it. So do it right after the installation.

You can change it later in **Settings > Security**. An older install with `APP_PASSWORD` keeps working; there you choose your own password in the wizard.

**Forgot your password?** Run `sudo rm /var/lib/majaos/auth.json && sudo systemctl restart majaos` on the server. Then you create an account in the browser again (or `APP_PASSWORD` applies again if it is in `/etc/majaos/majaos.env`), and two-step verification is off.

## Signing in and two-step verification

MajaOS asks for your user name and password. With *Stay signed in on this device* you stay signed in for 30 days; without the tick you are signed out when you close the browser.

For extra safety, turn on **two-step verification** in **Settings > Security**. After your password MajaOS then asks for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Aegis, …):

1. Click *Turn on* and type your password.
2. Scan the QR code with the app (or type the key).
3. Type the code the app shows. Other browsers are then signed out.
4. Keep the **10 recovery codes** (copy or download). If you lose your phone, you sign in with *Use a recovery code*. Each code works once; *New recovery codes* makes a new set.

After 10 wrong attempts (password or code) within 10 minutes MajaOS blocks that address for 5 minutes.
The code depends on the clock: if the clock of your phone or your server is wrong, the code doesn't match. Debian keeps the clock right with `systemd-timesyncd`.

**Lost everything (phone and recovery codes)?** Sign in on the server itself and run `sudo rm /var/lib/majaos/auth.json && sudo systemctl restart majaos`. Then two-step verification is off and you create an account again.

## Security

- MajaOS runs as **root**: it can erase VMs and disk files. That's why you can't do anything until there is an account: without an account the server only offers the welcome wizard.
- **Don't expose MajaOS to the internet.** Use a VPN for access from outside (WireGuard, Tailscale or your router's VPN).
- A VM's VNC screen is reachable in your network, protected with an 8-character password. That doesn't belong on the internet either. The console in the browser goes through MajaOS and so also needs your sign-in.
- Stopping, shutting down and deleting always ask for confirmation first.

## Troubleshooting

- **MajaOS doesn't start**: look at `journalctl -u majaos -e`.
- **"virsh is not installed"** or **"Docker is not reachable"**: run `sudo ./install.sh` again.
- **"The folder for VM disks does not exist"** or **"There is no folder for app data yet"**: create a pool under *Storage*, or choose a pool in *Settings > Storage*.
- **No CPU/RAM for a VM**: the memory comes from the balloon driver in the VM. Without that driver MajaOS shows what the VM takes on the server.
- **"The app catalogue could not be loaded"**: the server needs internet to fetch the feed. After that it works from the cache for 24 hours.
- **An app from the app store doesn't start**: open `STACKS_DIR/<name>/compose.yaml` and look at the app's log. Some templates expect a database or another app (see *Requires* in the app store).
- **The WebUI of an app doesn't open**: check the address in the app's settings. On bridge it must use a port that is published on the server (see `[PORT:n]` under *Apps*).
- **Ollama not reachable**: check that the container runs and that `OLLAMA_URL` is right.
- **Backup failed**: open the task's *Logs*. *Test* under Connections shows whether the connection still works; with Google, Microsoft and Dropbox the sign-in can have expired (e.g. after a new password): then click *Sign in again*.

## Licences

The console uses [noVNC](https://github.com/novnc/noVNC) 1.7.0 (MPL-2.0, with pako under MIT), unchanged in `public/vendor/novnc`.
The terminal uses [xterm.js](https://xtermjs.org) 6.0.0 with addon-fit (MIT), unchanged in `public/vendor/xterm`.
