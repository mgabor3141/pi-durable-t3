#!/usr/bin/env bash
# Fetch T3's built web app for T3_TAG (dev/t3-pin.sh) into the directory given as $1 (replaced). Used by
# `pnpm setup:t3` (into the web package, packages/web/app).
#   dev/fetch-web.sh <out-dir>
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
. "$here/dev/t3-pin.sh"
OUT="${1:?usage: fetch-web.sh <out-dir>}"
mkdir -p "$here/.t3-cache"
# T3's own web app build, from the release at T3_TAG: the CLI archive (what `npx t3` downloads) carries the built,
# self-hosted client in `client/`. It is the same on every platform; the smallest archive is fetched. Verified
# against the release's SHA256SUMS.
ARCHIVE="t3-${T3_TAG#v}-darwin-arm64.tar.gz"
RELEASE="$T3_URL/releases/download/$T3_TAG"
ARCHIVE_PATH="$here/.t3-cache/$ARCHIVE"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
SUMS="$(curl -fsSL "$RELEASE/SHA256SUMS")" || { echo "setup:t3: cannot fetch $RELEASE/SHA256SUMS (offline, or no release $T3_TAG?)"; exit 1; }
SUM="$(awk -v f="$ARCHIVE" '$2 == f { print $1 }' <<<"$SUMS")"
[ -n "$SUM" ] || { echo "setup:t3: $ARCHIVE is not in the release's SHA256SUMS"; exit 1; }
if ! echo "$SUM  $ARCHIVE_PATH" | sha256sum -c --status 2>/dev/null; then
  curl -fL --progress-bar -o "$staging/$ARCHIVE" "$RELEASE/$ARCHIVE"
  echo "$SUM  $staging/$ARCHIVE" | sha256sum -c --status || { echo "setup:t3: checksum mismatch for $ARCHIVE"; exit 1; }
  # Verified: only now drop archives of other tags, and install the new one.
  find "$here/.t3-cache" -maxdepth 1 -name 't3-*.tar.gz' -delete
  mv "$staging/$ARCHIVE" "$ARCHIVE_PATH"
fi
tar -xzf "$ARCHIVE_PATH" -C "$staging" --strip-components=1 --wildcards '*/client/*'
rm -rf "$OUT"
mv "$staging/client" "$OUT"
echo "fetched T3's web app ($T3_TAG) into $OUT"

