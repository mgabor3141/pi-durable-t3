#!/usr/bin/env bash
# One-shot T3 setup:
#   1. shallow-fetch t3code at PIN into the gitignored .t3-cache/;
#   2. copy packages/contracts (and T3's LICENSE) into the gitignored vendor/contracts, so the facet and the
#      contracts share one Effect copy (two Effect instances break the schema brand encode);
#   3. fetch T3's own built web app (the `client/` of the release's CLI archive) into the gitignored web-dist/.
# Then link the host against the vendored contracts. Idempotent: re-running skips a cache already at PIN.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"

# The single source of truth for the pinned T3 Code commit (protocol 2). MIT, "Copyright (c) 2026 T3 Tools Inc.".
PIN=70d60e03a7a35c6fa131825bbfa05ec893e69912
# The release tag at PIN: the version the bridge reports as `serverVersion` (src/t3/http.ts; a test keeps them equal).
T3_TAG=v0.1.1-nightly.20261017.3238
T3_URL="https://github.com/pingdotgg/t3code"
CACHE="$here/.t3-cache/t3code"

# 1. Fetch t3code at PIN (shallow, single commit) unless the cache is already there.
if [ "$(git -C "$CACHE" rev-parse HEAD 2>/dev/null || true)" != "$PIN" ]; then
  rm -rf "$CACHE"
  mkdir -p "$CACHE"
  git -C "$CACHE" init -q
  git -C "$CACHE" remote add origin "$T3_URL"
  git -C "$CACHE" fetch -q --depth 1 origin "$PIN"
  git -C "$CACHE" checkout -q FETCH_HEAD
fi
[ "$(git -C "$CACHE" rev-parse HEAD)" = "$PIN" ] || { echo "setup:t3: cache not at $PIN"; exit 1; }

# 2. Vendor packages/contracts + the LICENSE that covers it.
[ -d "$CACHE/packages/contracts/src" ] || { echo "setup:t3: packages/contracts missing in $CACHE"; exit 1; }
mkdir -p "$here/vendor/contracts"
rm -rf "$here/vendor/contracts/src"
cp -r "$CACHE/packages/contracts/src" "$here/vendor/contracts/src"
cp "$CACHE/packages/contracts/package.json" "$here/vendor/contracts/"
cp "$CACHE/LICENSE" "$here/vendor/contracts/LICENSE"
# T3's contracts tsconfig extends the monorepo root's `tsconfig.base.json`, which is NOT part of the vendored copy:
# a bundler that resolves the per-file tsconfig (vitest) then fails on a dangling `extends`. Write a self-contained
# one, matching this repo's own compiler options so the vendored sources transform the same way as the host's.
cat > "$here/vendor/contracts/tsconfig.json" <<'TS'
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2024", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
TS
echo "vendored @t3tools/contracts at $PIN (+ LICENSE) into vendor/contracts"

# 3. T3's own web app build, from the release at T3_TAG: the CLI archive (what `npx t3` downloads) carries the built,
# self-hosted client in `client/`. It is the same on every platform; the smallest archive is fetched. Verified
# against the release's SHA256SUMS.
ARCHIVE="t3-${T3_TAG#v}-darwin-arm64.tar.gz"
RELEASE="$T3_URL/releases/download/$T3_TAG"
ARCHIVE_PATH="$here/.t3-cache/$ARCHIVE"
SUM="$(curl -fsSL "$RELEASE/SHA256SUMS" | awk -v f="$ARCHIVE" '$2 == f { print $1 }')"
[ -n "$SUM" ] || { echo "setup:t3: $ARCHIVE is not in the release's SHA256SUMS"; exit 1; }
if ! echo "$SUM  $ARCHIVE_PATH" | sha256sum -c --status 2>/dev/null; then
  curl -fL --progress-bar -o "$ARCHIVE_PATH" "$RELEASE/$ARCHIVE"
  echo "$SUM  $ARCHIVE_PATH" | sha256sum -c --status || { echo "setup:t3: checksum mismatch for $ARCHIVE"; exit 1; }
fi
staging="$(mktemp -d)"
tar -xzf "$ARCHIVE_PATH" -C "$staging" --strip-components=1 --wildcards '*/client/*'
rm -rf "$here/web-dist"
mv "$staging/client" "$here/web-dist"
rm -rf "$staging"
echo "fetched T3's web app ($T3_TAG) into web-dist"

pnpm install
