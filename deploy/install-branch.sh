#!/usr/bin/env bash
# Installs the newest commit of a branch (default dev), or a release tag, on this server and switches Software update along.
# For a test server: run it once to get onto the dev channel; after that "Update now" follows the branch by itself.
# Usage:  sudo bash install-branch.sh [branch]        (main = back to official releases)
#         sudo bash install-branch.sh v0.1.0-beta.1   (a release: then the Beta channel, or Stable for vX.Y.Z)
#         From the MajaOS terminal (already root): bash /opt/majaos/deploy/install-branch.sh dev
# Also works on a server from before the rename (HomeBaseOS): install.sh moves it to MajaOS.
# Uses UPDATE_REPO and UPDATE_TOKEN from /etc/majaos/majaos.env.
set -euo pipefail
BRANCH="${1:-dev}"
ENV=/etc/majaos/majaos.env
DATA_DIR=/var/lib/majaos
[ "$(id -u)" = 0 ] || { echo "Run this script with sudo."; exit 1; }

# install.sh restarts MajaOS. Started from its terminal, that restart would stop this script halfway: so run it as a
# unit of its own (like "Update now"). The output stays visible here; the full log: journalctl -u 'majaos-branch-*'
if [ -z "${HB_DETACHED:-}" ] && command -v systemd-run >/dev/null 2>&1; then
  exec systemd-run --quiet --collect --pipe --wait --unit="majaos-branch-$(date +%s)" -E HB_DETACHED=1 \
    /bin/bash "$(readlink -f "$0")" "$BRANCH"
fi
# A HomeBaseOS server still has its settings under the old name until install.sh below renames it.
READ_ENV="$ENV"; [ -f "$READ_ENV" ] || READ_ENV=/etc/homebaseos/homebaseos.env
[ -f "$READ_ENV" ] || { echo "$ENV is missing: install MajaOS first."; exit 1; }
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Invalid branch name: $BRANCH"; exit 1; }
REPO="$(sed -n 's/^UPDATE_REPO=//p' "$READ_ENV" | tail -1)"; REPO="${REPO:-lennertvh1/MajaOS}"
[ "$REPO" = lennertvh1/homebaseos ] && REPO=lennertvh1/MajaOS  # the repository was renamed too
TOKEN="$(sed -n 's/^UPDATE_TOKEN=//p' "$READ_ENV" | tail -1)"
# A tag like v0.1.0 or v0.1.0-beta.1 is a release, not a branch to follow.
RELEASE=0; [[ "$BRANCH" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]] && RELEASE=1
AUTH=(); [ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer $TOKEN")

echo "==> Newest commit of $BRANCH in $REPO"
SHA="$(curl -fsSL "${AUTH[@]}" -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$REPO/commits/$BRANCH")" \
  || { echo "$BRANCH can't be read in $REPO. Is UPDATE_TOKEN set in $READ_ENV (private repository)?"; exit 1; }
echo "    $SHA"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "==> Downloading"
curl -fsSL "${AUTH[@]}" "https://api.github.com/repos/$REPO/tarball/$SHA" | tar -xz -C "$TMP" --strip-components=1

echo "==> Installing (install.sh)"
ARGS=(); command -v nvidia-smi >/dev/null 2>&1 && ARGS+=(--nvidia)
bash "$TMP/install.sh" "${ARGS[@]}"

# Remember which commit this is, and the update channel: dev follows the branch, main = official releases (stable),
# a release tag = beta (pre-release) or stable.
if [ "$RELEASE" = 1 ]; then
  rm -f /opt/majaos/build.json; CHANNEL=stable; [[ "$BRANCH" == *-* ]] && CHANNEL=beta
elif [ "$BRANCH" = main ]; then
  rm -f /opt/majaos/build.json; CHANNEL=stable
else
  printf '{\n  "branch": "%s",\n  "commit": "%s",\n  "date": "%s"\n}\n' "$BRANCH" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /opt/majaos/build.json
  CHANNEL=dev
  grep -q '^DEV_BRANCH=' "$ENV" && sed -i "s#^DEV_BRANCH=.*#DEV_BRANCH=$BRANCH#" "$ENV" || echo "DEV_BRANCH=$BRANCH" >> "$ENV"
fi
mkdir -p "$DATA_DIR"
node -e '
  const fs = require("fs"), f = process.argv[1]; let s = {};
  try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  s.updateChannel = process.argv[2]; fs.writeFileSync(f, JSON.stringify(s, null, 2));
' "$DATA_DIR/settings.json" "$CHANNEL"
rm -f "$DATA_DIR/release.json"
systemctl restart majaos
echo "==> Done: $BRANCH ($SHA), update channel $CHANNEL."
