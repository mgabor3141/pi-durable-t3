#!/usr/bin/env bash
# One-shot T3 setup:
#   1. shallow-fetch t3code at PIN into the gitignored .t3-cache/;
#   2. copy packages/contracts (and T3's LICENSE) into the gitignored vendor/contracts, so the facet and the
#      contracts share one Effect copy (two Effect instances break the schema brand encode);
#   3. build the T3 web app into the gitignored web-dist/.
# Then link the host against the vendored contracts. Idempotent: re-running skips a cache already at PIN.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"

# The single source of truth for the pinned T3 Code commit (protocol 2). MIT, "Copyright (c) 2026 T3 Tools Inc.".
PIN=70d60e03a7a35c6fa131825bbfa05ec893e69912
# The release tag at PIN: the version the bridge reports as `serverVersion` (src/t3/http.ts; a test keeps them equal).
T3_TAG=v0.1.1-nightly.20261017.3238
T3_URL="https://github.com/pingdotgg/t3code"
# The pnpm the T3 monorepo builds with.
T3_PNPM="pnpm@11.10.0"

CACHE="$here/.t3-cache/t3code"
WEB_PNPM="npx --yes ${T3_PNPM}"

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

# 3. Build the T3 web app into web-dist (needs the whole monorepo).
(
  cd "$CACHE"
  $WEB_PNPM install --filter "@t3tools/web..." --ignore-scripts
  cd "$CACHE/apps/web"
  VITE_HOSTED_APP_CHANNEL=latest $WEB_PNPM run build
)
rm -rf "$here/web-dist"
cp -r "$CACHE/apps/web/dist" "$here/web-dist"
echo "built the T3 web app into web-dist"

pnpm install
