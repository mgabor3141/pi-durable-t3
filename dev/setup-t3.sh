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
# The symlinks go first, every run: a package manager's install may have pruned them.
mkdir -p "$here/node_modules/@t3tools"
ln -sfn ../../vendor/contracts "$here/node_modules/@t3tools/contracts"
ln -sfn ../../vendor/shared "$here/node_modules/@t3tools/shared"
ln -sfn ../../vendor/t3-server "$here/node_modules/@t3tools/t3-server"
if [ "$(cat "$DONE" 2>/dev/null || true)" = "$T3_TAG" ] && [ -f "$here/vendor/contracts/LICENSE" ] && [ -f "$here/vendor/t3-server/advertisedJsonSchema.ts" ] && [ -f "$here/web/index.html" ]; then
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

# 2b. T3's own server code, used as-is so the bridge's thread stream and WS authorization are T3's: the bounded snapshot, history paging,
# the wire projection and body dedupe (apps/server/src/orchestration-v2), the shared helpers they import
# (packages/shared/src, as `@t3tools/shared`), and the client's event reducer (packages/client-runtime), which the
# bridge runs over its own events to check that a client applying them arrives at the projection it would send.
[ -d "$CACHE/packages/shared/src" ] || { echo "setup:t3: packages/shared missing in $CACHE"; exit 1; }
rm -rf "$here/vendor/shared" "$here/vendor/t3-server"
mkdir -p "$here/vendor/shared" "$here/vendor/t3-server"
cp -r "$CACHE/packages/shared/src" "$here/vendor/shared/src"
find "$here/vendor/shared/src" -name '*.test.ts' -delete
cat > "$here/vendor/shared/package.json" <<'JSON'
{ "name": "@t3tools/shared", "private": true, "type": "module", "exports": { "./*": "./src/*.ts" } }
JSON
cp "$here/vendor/contracts/tsconfig.json" "$here/vendor/shared/tsconfig.json"
ln -sfn ../../vendor/shared "$here/node_modules/@t3tools/shared"
for file in threadHistoryPaging.ts ThreadStream.ts WireProjection.ts; do
  [ -f "$CACHE/apps/server/src/orchestration-v2/$file" ] || { echo "setup:t3: apps/server/src/orchestration-v2/$file missing"; exit 1; }
  cp "$CACHE/apps/server/src/orchestration-v2/$file" "$here/vendor/t3-server/$file"
done
# The reducer's one import outside the closure handles pull-request link events, which this host never sends.
reducer="$CACHE/packages/client-runtime/src/state/orchestrationV2Projection.ts"
[ -f "$reducer" ] || { echo "setup:t3: packages/client-runtime/src/state/orchestrationV2Projection.ts missing"; exit 1; }
grep -q '^import { applyThreadPullRequestLinkUpdate } from "../threadPullRequests.ts";$' "$reducer" \
  || { echo "setup:t3: the client reducer's imports changed; update dev/setup-t3.sh"; exit 1; }
sed 's#^import { applyThreadPullRequestLinkUpdate } from "../threadPullRequests.ts";$#import { applyThreadPullRequestLinkUpdate } from "./threadPullRequests.ts";#' "$reducer" > "$here/vendor/t3-server/orchestrationV2Projection.ts"
cat > "$here/vendor/t3-server/threadPullRequests.ts" <<'TS'
// Written by dev/setup-t3.sh: this host never sends a pull-request link event, so the reducer's handler keeps the thread.
export const applyThreadPullRequestLinkUpdate = <T>(thread: T, _link: unknown): T => thread;
TS
# T3's per-method WS authorization, as-is: the scope each RPC needs (apps/server/src/auth).
[ -f "$CACHE/apps/server/src/auth/RpcAuthorization.ts" ] || { echo "setup:t3: apps/server/src/auth/RpcAuthorization.ts missing"; exit 1; }
cp "$CACHE/apps/server/src/auth/RpcAuthorization.ts" "$here/vendor/t3-server/RpcAuthorization.ts"
# The input schema T3 advertises for an MCP tool (compacted JSON Schema), as-is.
[ -f "$CACHE/apps/server/src/mcp/advertisedJsonSchema.ts" ] || { echo "setup:t3: apps/server/src/mcp/advertisedJsonSchema.ts missing"; exit 1; }
cp "$CACHE/apps/server/src/mcp/advertisedJsonSchema.ts" "$here/vendor/t3-server/advertisedJsonSchema.ts"
# The page an MCP OAuth sign-in shows when it cannot continue, as-is.
[ -f "$CACHE/apps/server/src/auth/mcpOAuthHtml.ts" ] || { echo "setup:t3: apps/server/src/auth/mcpOAuthHtml.ts missing"; exit 1; }
cp "$CACHE/apps/server/src/auth/mcpOAuthHtml.ts" "$here/vendor/t3-server/mcpOAuthHtml.ts"
cp "$here/vendor/contracts/tsconfig.json" "$here/vendor/t3-server/tsconfig.json"
cat > "$here/vendor/t3-server/package.json" <<'JSON'
{ "name": "@t3tools/t3-server", "private": true, "type": "module", "exports": { "./*": "./*.ts" } }
JSON
ln -sfn ../../vendor/t3-server "$here/node_modules/@t3tools/t3-server"
echo "vendored T3's server code (shared, orchestration-v2 stream helpers, RPC authorization, the client reducer) into vendor/"

# 3. T3's own web app build (the release's CLI archive, checksum-verified): dev/fetch-web.sh, into web/.
bash "$here/dev/fetch-web.sh" "$here/web"
echo "$T3_TAG" > "$DONE"
