#!/usr/bin/env bash
# Build the package: the JS bundle (tsdown), the public declarations (tsc, pruned to what `bridge.d.ts` reaches), and
# THIRD_PARTY_LICENSES. Needs `pnpm setup:t3` first (T3's contracts and LICENSE come from vendor/).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f vendor/contracts/LICENSE ] || { echo "build: run 'pnpm setup:t3' first"; exit 1; }

tsdown -c build/tsdown.config.ts
# Declarations: tsc over src/, then keep only the files reachable from bridge.d.ts, with `.ts` specifiers rewritten
# to `.js`. (tsc 7 does not rewrite them.) Any type error fails the build.
tsc -p build/tsconfig.build.json
node build/prune-types.mjs
{
  echo "This package contains code from and derived from T3 Code (https://github.com/pingdotgg/t3code), tag $(. dev/t3-pin.sh; echo "$T3_TAG"):"
  echo "it bundles @t3tools/contracts, its protocol code (src/t3) replicates T3's server logic, and web/ is T3's built web app."
  echo "T3 Code is used under the following license:"
  echo
  cat vendor/contracts/LICENSE
} > THIRD_PARTY_LICENSES
