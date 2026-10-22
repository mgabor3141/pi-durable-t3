#!/usr/bin/env bash
# One-shot T3 setup:
#   1. shallow-fetch t3code at T3_TAG into the gitignored .t3-cache/;
#   2. copy packages/contracts (and T3's LICENSE) into the gitignored vendor/contracts, so the facet and the
#      contracts share one Effect copy (two Effect instances break the schema brand encode);
#   3. fetch T3's own built web app (the `client/` of the release's CLI archive) into web/ (gitignored). The bridge
#      serves it by default, from a checkout and from the installed package.
# This is the package's `prepare` step, so it runs on every `pnpm install` in a checkout: once done for a tag it is a
# no-op (`.t3-cache/setup-done`), with no network. Delete `.t3-cache` to force it. It must not run `pnpm install`
# (that would re-enter `prepare`). `@t3tools/contracts` is not a package.json dependency (npm has no `link:`, and
# vendor/ does not exist at install time): this script symlinks node_modules/@t3tools/contracts to vendor/contracts.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"

. "$here/dev/t3-pin.sh"
CACHE="$here/.t3-cache/t3code"
DONE="$here/.t3-cache/setup-done"
# The symlink goes first, every run: a package manager's install may have pruned it.
mkdir -p "$here/node_modules/@t3tools"
ln -sfn ../../vendor/contracts "$here/node_modules/@t3tools/contracts"
if [ "$(cat "$DONE" 2>/dev/null || true)" = "$T3_TAG" ] && [ -f "$here/vendor/contracts/LICENSE" ] && [ -f "$here/web/index.html" ]; then
  echo "setup:t3: already at $T3_TAG"
  exit 0
fi
rm -f "$DONE"

# 1. Fetch t3code at the tag (shallow). `.t3-cache/t3code-tag` holds "<tag> <sha>", written only after a successful
# checkout; the fetch is skipped only when the cache's HEAD is that sha, so a half-done or switched cache heals itself.
# The pin is the tag: tags (and these releases) are mutable, so the recorded sha is for diagnosis, and SHA256SUMS below
# detects a corrupt download, not tampering.
TAGFILE="$here/.t3-cache/t3code-tag"
read -r have_tag have_sha < <(cat "$TAGFILE" 2>/dev/null || true) || true
if [ "${have_tag:-}" != "$T3_TAG" ] || [ -z "${have_sha:-}" ] \
   || [ "$(git -C "$CACHE" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$have_sha" ]; then
  rm -f "$TAGFILE"
  rm -rf "$CACHE"
  mkdir -p "$CACHE"
  git -C "$CACHE" init -q
  git -C "$CACHE" remote add origin "$T3_URL"
  git -C "$CACHE" fetch -q --depth 1 origin "refs/tags/$T3_TAG:refs/tags/$T3_TAG"
  git -C "$CACHE" checkout -q "$T3_TAG"
  echo "$T3_TAG $(git -C "$CACHE" rev-parse HEAD)" > "$TAGFILE"
fi
PIN="$(git -C "$CACHE" rev-parse HEAD)"

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

# 3. T3's own web app build (the release's CLI archive, checksum-verified): dev/fetch-web.sh, into web/.
bash "$here/dev/fetch-web.sh" "$here/web"
echo "$T3_TAG" > "$DONE"
