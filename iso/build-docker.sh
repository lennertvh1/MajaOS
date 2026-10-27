#!/usr/bin/env bash
# Build the HomeBaseOS ISO inside Ubuntu 24.04 (Docker). Use on macOS, Windows, or Linux when debootstrap is not on the host.
# See docs/build-iso.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE="${BUILD_WORKTREE:-1}"
LIVE="${BUILD_LIVE:-1}"
if ! command -v docker >/dev/null; then
  echo "Docker is not installed or not on PATH. Install Docker Desktop or use WSL2 + Docker; see docs/build-iso.md."
  exit 1
fi
# The ISO is always amd64. On Apple Silicon Docker defaults to arm64, which breaks linux-image-amd64 in build-live.sh.
echo "==> docker run --platform linux/amd64 (privileged) build-iso.sh --out dist worktree=$WORKTREE live=$LIVE"
docker run --rm --privileged --platform linux/amd64 \
  -e "BUILD_WORKTREE=$WORKTREE" \
  -e "BUILD_LIVE=$LIVE" \
  -v "$ROOT:/work:rw" \
  -w /work \
  ubuntu:24.04 \
  bash -ec '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq xorriso cpio gzip curl git coreutils debootstrap squashfs-tools
    args=(./iso/build-iso.sh --out dist)
    [ "$BUILD_WORKTREE" = 1 ] && args+=(--worktree)
    [ "$BUILD_LIVE" = 1 ] && args+=(--live)
    if [ -n "${BUILD_EXTRA:-}" ]; then
      eval "extra=($BUILD_EXTRA)"
      args+=("${extra[@]}")
    fi
    "${args[@]}"
  '
echo "==> Done: $ROOT/dist/"
