# Building the MajaOS installation ISO

The ISO is the official **Debian 13 amd64 netinst** image with MajaOS added. A **release** build uses the graphical installer (`--live`): language, disk choice and confirmation in the browser-style UI, then Debian installs in the background.

You need **Linux** (bare metal, VM, WSL2, or Docker). **macOS** cannot run `--live` natively (no GNU `cpio`, no `debootstrap` in the same way). Use WSL2 on Windows, a Linux machine, or Docker.

## Easiest: one script

From the repo root (graphical live ISO, current files, output in `dist/`):

```bash
./build-iso.sh
```

Same as `./iso/build.sh` or `npm run build:iso`.

| Where | What it does |
|-------|----------------|
| **macOS** | Uses **Docker** (install and start Docker Desktop first) |
| **WSL2 / Linux** | Installs missing **apt** packages, then runs `build-iso.sh --live --worktree` with **sudo** |
| **Linux + Docker only** | Falls back to Docker if `debootstrap` is not installed |

```bash
./build-iso.sh --help          # options
./build-iso.sh --no-docker     # force native (WSL/Linux)
./build-iso.sh --docker        # force Docker
./build-iso.sh --no-live       # netinst remaster only (faster)
./build-iso.sh --commit        # pack git HEAD, not uncommitted changes
./build-iso.sh --iso /path/to/debian-13-netinst.iso
```

## What you get

| Command | Result | Run as root? | Time (typical) |
|--------|--------|--------------|----------------|
| `sudo ./iso/build-iso.sh --live` | Graphical installer + recovery Debian install entry | **Yes** for `--live` | 45–90 minutes |
| `./iso/build-iso.sh` | Text-based Debian installer only (no live kiosk) | No | 10–20 minutes |

Output (default): `dist/majaos-<version>-amd64.iso` and `.sha256` (`<version>` from `package.json`).

### Useful flags

```text
./iso/build-iso.sh --live --worktree --out dist
```

- **`--live`** — build the small Debian live system (`iso/build-live.sh`: debootstrap, squashfs, kiosk).
- **`--worktree`** — pack **current files** into the ISO instead of the last git commit (for local changes).
- **`--out <dir>`** — write the ISO to another folder (default: `dist/`).
- **`--iso path/to/debian-netinst.iso`** — skip download; use your own Debian 13 amd64 netinst.

First run downloads the netinst into `.iso-cache/` (~800 MB) and verifies SHA256 from debian.org.

---

## Linux (Debian / Ubuntu)

```bash
sudo apt update
sudo apt install -y xorriso cpio gzip curl git coreutils debootstrap squashfs-tools
git clone -b dev https://github.com/lennertvh1/MajaOS.git   # or -b main for the released version
cd MajaOS

sudo ./iso/build-iso.sh --live --worktree --out dist
ls -lh dist/
```

`cpio` must be **GNU** cpio (`cpio --version` should mention GNU).

---

## Windows with WSL2

WSL2 is supported and is a good option. Use **WSL2** (not WSL1). Keep the repo on the **Linux filesystem** (`~/MajaOS`), not under `/mnt/c/...` (slower, permission quirks).

### 1. Install WSL2

PowerShell (admin):

```powershell
wsl --install -d Ubuntu-24.04
```

Restart, open **Ubuntu**. Check version (must be **2**):

```powershell
wsl -l -v
```

If needed: `wsl --set-version Ubuntu-24.04 2`

### 2. Clone and build

In the Ubuntu WSL shell:

```bash
sudo apt update
sudo apt install -y git xorriso cpio gzip curl coreutils debootstrap squashfs-tools
cd ~
git clone -b dev https://github.com/lennertvh1/MajaOS.git
cd MajaOS

sudo ./iso/build-iso.sh --live --worktree --out dist
```

### 3. Copy the ISO to Windows

```bash
cp dist/majaos-*.iso /mnt/c/Users/YOURNAME/Downloads/
```

Use **balenaEtcher** or **Rufus** on Windows to write the USB stick. Writing with `dd` to a USB device from WSL often fails (the stick is not exposed as `/dev/sdX`).

### WSL troubleshooting

| Issue | Fix |
|-------|-----|
| `build-live.sh needs root` | Run the whole command with **`sudo`** |
| `Missing: debootstrap` / `xorriso` | Install packages with `apt` (see above) |
| `GNU cpio is needed` | Use Debian/Ubuntu inside WSL, not macOS `cpio` |
| Slow or odd errors | Clone under `~/`, not `/mnt/c` |
| `debootstrap` / `chroot` fails | WSL2 + updated distro: `sudo apt full-upgrade` |

**Disk space:** allow **~15–25 GB** free for cache, live chroot, and output.

---

## Docker (Linux, macOS with Docker Desktop, WSL2 with Docker)

If Docker is installed and the daemon is running:

```bash
cd MajaOS
./iso/build-docker.sh
```

On **Apple Silicon**, Docker runs an **amd64** container (emulation). The build works but is slower than on an x86 machine.

Optional environment variables:

- `BUILD_WORKTREE=0` — use git `HEAD` instead of the working tree.
- `BUILD_LIVE=0` — skip `--live` (faster smoke build).

The script runs `ubuntu:24.04` with `--privileged` (needed for `debootstrap` and bind mounts). The ISO appears in `dist/` on your host.

---

## GitHub Actions

| Workflow | When | ISO download |
|----------|------|----------------|
| **Test** | Push to `dev` that touches `iso/`, `deploy/`, `install.sh`, or `public/install.*` | **Build only** (smoke test, no upload) |
| **Test** → *Run workflow* on `dev`, *Also build a test ISO* | Manual | Artifact **7 days** (needs free Actions artifact quota) |
| **Release and ISO** | Tag `v*` on `main` or manual release workflow | Attached to the GitHub **release** |

Test servers on the **dev** channel use *Settings → Software update → Development*, not the test ISO artifact.

---

## Boot the ISO in a VM

- **UEFI** enabled (matches the release ISO).
- **Secure Boot** off (same as on real hardware for ZFS/NVIDIA later).
- Enough RAM (e.g. 4 GB+ for the live installer).
- First menu entry: **Install MajaOS** (live). **Recovery** uses the classic Debian installer.

If the screen stays black after the house logo: disable **3D/GPU acceleration** in the VM. If the mouse or keyboard does nothing: use a USB tablet as the VM's pointer. On the live system, **Ctrl+Alt+F2** opens a root shell: check `/tmp/majaos-installer.log` and `journalctl -u majaos-kiosk`. **Ctrl+Alt+F1** goes back to the installer. If the screen takes no keys at all, the serial port has the same shell: on Unraid or another libvirt host, run `virsh console <vm name>` (leave with Ctrl+]).

---

## Quick reference

```bash
# Full live ISO with local changes
sudo ./iso/build-iso.sh --live --worktree --out dist

# Or via Docker
./iso/build-docker.sh
```

For installing the finished ISO on hardware, see [the user guide](guide.md#installing-with-the-iso-recommended).
