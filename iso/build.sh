#!/usr/bin/env bash
# One command to build the HomeBaseOS installation ISO (live + current files → dist/).
# Picks native Linux/WSL or Docker on macOS. See docs/build-iso.md.
#
#   ./iso/build.sh
#   ./iso/build.sh --help
#
# Environment:
#   FORCE_DOCKER=1     Always use Docker (iso/build-docker.sh)
#   SKIP_APT=1         Do not run apt-get on Debian/Ubuntu when tools are missing
#   BUILD_WORKTREE=0   Use git HEAD instead of the working tree (Docker path only unless you pass flags)
#   BUILD_LIVE=0       Skip the graphical live image
#
# Extra arguments are passed to iso/build-iso.sh (e.g. --iso /path/debian.iso).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERE="$ROOT/iso"
APT_PKGS=(xorriso cpio gzip curl git coreutils debootstrap squashfs-tools)

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  echo ""
  echo "Options:"
  echo "  --docker       Build inside Docker (Ubuntu 24.04)"
  echo "  --no-docker    Build on this machine (Linux/WSL; needs root for --live)"
  echo "  --no-live      Same as BUILD_LIVE=0"
  echo "  --commit       Same as BUILD_WORKTREE=0 (pack last git commit, not open files)"
  echo "  -h, --help     Show this text"
  exit 0
}

WORKTREE=1
LIVE=1
USE_DOCKER=""
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage ;;
    --docker) USE_DOCKER=1; shift ;;
    --no-docker) USE_DOCKER=0; shift ;;
    --no-live) LIVE=0; shift ;;
    --commit) WORKTREE=0; shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

has_gnu_cpio() {
  command -v cpio >/dev/null && cpio --version 2>/dev/null | grep -q 'GNU cpio'
}

has_native_tools() {
  command -v xorriso gzip curl sha256sum git debootstrap mksquashfs >/dev/null \
    && has_gnu_cpio
}

docker_ok() {
  command -v docker >/dev/null && docker info >/dev/null 2>&1
}

install_apt_deps() {
  if [ "${SKIP_APT:-}" = 1 ]; then
    echo "Build tools are missing and SKIP_APT=1. Install: ${APT_PKGS[*]}"
    return 1
  fi
  if [ ! -f /etc/debian_version ]; then
    echo "This script can install dependencies automatically only on Debian/Ubuntu (apt)."
    echo "Install: ${APT_PKGS[*]}"
    return 1
  fi
  echo "==> Installing build packages (sudo apt-get)…"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${APT_PKGS[@]}"
}

pick_docker() {
  [ "${FORCE_DOCKER:-}" = 1 ] && return 0
  [ -n "$USE_DOCKER" ] && [ "$USE_DOCKER" = 1 ] && return 0
  [ -n "$USE_DOCKER" ] && [ "$USE_DOCKER" = 0 ] && return 1
  case "$(uname -s)" in
    Darwin) return 0 ;;
  esac
  if has_native_tools; then
    return 1
  fi
  docker_ok && return 0
  return 1
}

run_docker() {
  if ! docker_ok; then
    echo "Docker is required on macOS (or when native tools are missing)."
    echo "Install Docker Desktop, start it, then run ./iso/build.sh again."
    echo "On Windows, use WSL2 without Docker: ./iso/build.sh --no-docker"
    exit 1
  fi
  export BUILD_WORKTREE="$WORKTREE" BUILD_LIVE="$LIVE"
  if [ ${#EXTRA[@]} -gt 0 ]; then
    BUILD_EXTRA=$(printf '%q ' "${EXTRA[@]}")
    export BUILD_EXTRA
  else
    unset BUILD_EXTRA 2>/dev/null || true
  fi
  exec "$HERE/build-docker.sh"
}

run_native() {
  cd "$ROOT"
  if ! has_native_tools; then
    install_apt_deps || exit 1
    has_native_tools || { echo "Still missing tools after apt install."; exit 1; }
  fi
  args=("$HERE/build-iso.sh" --out dist)
  [ "$WORKTREE" = 1 ] && args+=(--worktree)
  [ "$LIVE" = 1 ] && args+=(--live)
  if [ ${#EXTRA[@]} -gt 0 ]; then
    args+=("${EXTRA[@]}")
  fi
  if [ "$LIVE" = 1 ] && [ "$(id -u)" -ne 0 ]; then
    echo "==> Live build needs root (debootstrap). Running: sudo ${args[*]}"
    exec sudo "${args[@]}"
  fi
  echo "==> Running: ${args[*]}"
  exec "${args[@]}"
}

if pick_docker; then
  run_docker
else
  run_native
fi
