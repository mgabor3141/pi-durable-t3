#!/usr/bin/env bash
# Prove the two packages work as an outside consumer would use them: pack, install the tarballs into a fresh temp dir
# (outside the repo), then (1) one Effect copy, under pnpm and npm, (2) an integrator script + browser probe.
# Needs `pnpm setup:t3 && pnpm build`. Registry-less: the packed packages reference each other by override.
#   FACET_PORT=5070 dev/pack-proof.sh      (SHOT=<png> for the screenshot)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${FACET_PORT:-5070}"
SHOT="${SHOT:-$here/.memory/pack-proof.png}"
T="$(mktemp -d "${TMPDIR:-/tmp}/pdt3-proof-XXXXXX")"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$T/tarballs" "$T/consumer"
for p in web bridge; do (cd "$here/packages/$p" && pnpm pack --pack-destination "$T/tarballs" >/dev/null); done
ls -l "$T/tarballs"
W=("$T"/tarballs/*-web-*.tgz); B=("$T"/tarballs/mgabor3141-pi-durable-t3-0*.tgz)

cd "$T/consumer"
cat > package.json <<JSON
{ "name": "consumer", "private": true, "type": "module",
  "pnpm": { "overrides": {
    "@mgabor3141/pi-durable-t3-web": "file:${W[0]}",
    "@mgabor3141/pi-durable-t3": "file:${B[0]}" } } }
JSON
PEERS="$(node -p 'const p=require(process.argv[1]).devDependencies;Object.entries(p).map(([k,v])=>k+"@"+v).join(" ")' "$here/packages/bridge/package.json")"
PW="playwright-core@$(node -p 'require(process.argv[1]).devDependencies["playwright-core"]' "$here/package.json")"
pnpm add "${B[0]}" $PEERS "$PW" >/dev/null

echo "== one Effect copy"
copies="$(find node_modules/.pnpm -maxdepth 1 -name 'effect@*' | wc -l)"
find node_modules/.pnpm -maxdepth 1 -name 'effect@*'
[ "$copies" = 1 ] || { echo "FAIL: $copies effect copies"; exit 1; }
node -e '
const { createRequire } = require("node:module"), fs = require("node:fs");
const bridgeDir = fs.realpathSync("node_modules/@mgabor3141/pi-durable-t3");
const bridgeEffect = fs.realpathSync(createRequire(bridgeDir + "/").resolve("effect/package.json"));
const platformDir = fs.realpathSync(createRequire(bridgeDir + "/").resolve("@effect/platform-node/package.json"));
const platformEffect = fs.realpathSync(createRequire(platformDir).resolve("effect/package.json"));
if (bridgeEffect !== platformEffect) { console.error("FAIL: different effects", bridgeEffect, platformEffect); process.exit(1); }
console.log("the bridge and @effect/platform-node resolve the same effect:", bridgeEffect);'

echo "== one Effect copy under npm (hoisting resolves peers differently from pnpm)"
mkdir -p "$T/npm-consumer"
(cd "$T/npm-consumer"
cat > package.json <<JSON
{ "name": "npm-consumer", "private": true,
  "overrides": { "@mgabor3141/pi-durable-t3-web": "file:${W[0]}" } }
JSON
npm install --no-audit --no-fund --loglevel=error "${B[0]}" $PEERS >/dev/null
npm ls effect --all || true
n="$(npm ls effect --all --parseable | sort -u | wc -l)"
[ "$n" = 1 ] || { echo "FAIL: $n effect copies under npm"; exit 1; })

echo "== integrator script + browser probe"
cp "$here/dev/pack-proof/server.mjs" "$here/dev/pack-proof/probe.mjs" .
node server.mjs "$T/state" "$PORT" > server.log 2>&1 & PIDS+=("$!")
for _ in $(seq 1 60); do grep -q '^READY ' server.log 2>/dev/null && break; sleep 0.5; done
LINK="$(sed -n 's/^READY //p' server.log)"; [ -n "$LINK" ] || { cat server.log; exit 1; }
mkdir -p "$(dirname "$SHOT")"
node probe.mjs "$LINK" "$SHOT"

echo "PACK PROOF OK ($T)"
