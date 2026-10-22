#!/usr/bin/env bash
# Prove the package works as an outside consumer would use it, installed two ways, each under pnpm and npm, in fresh
# temp dirs outside the repo: (1) the packed tarball (what `pnpm publish` ships); (2) a git dependency (what
# `pnpm add github:mgabor3141/pi-durable-t3` does), from a throwaway local git repo holding this working copy's files,
# so `prepare` (setup:t3 + build) runs in the consumer's install. Each: one Effect copy; then, with pnpm, an integrator
# script + browser probe. The git installs fetch T3 (network), as a first checkout does.
#   FACET_PORT=5070 dev/pack-proof.sh      (SHOT=<png> for the screenshot; the 2nd shot gets a "-git" suffix)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${FACET_PORT:-5070}"
SHOT="${SHOT:-$here/.memory/pack-proof.png}"
T="$(mktemp -d "${TMPDIR:-/tmp}/pdt3-proof-XXXXXX")"
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT

PEERS="$(node -p 'const p=require(process.argv[1]).devDependencies;["chord","pi-ai","pi-durable"].map((n)=>"@earendil-works/"+n+"@"+p["@earendil-works/"+n]).join(" ")' "$here/package.json")"
PW="playwright-core@$(node -p 'require(process.argv[1]).devDependencies["playwright-core"]' "$here/package.json")"

# The package as a tarball.
mkdir -p "$T/tarball"
(cd "$here" && pnpm pack --pack-destination "$T/tarball" >/dev/null)
ls -l "$T/tarball"
TGZ=("$T"/tarball/*.tgz)

# The package as a git dependency: a bare repo with one commit of the files the VCS tracks (git or jj) in the working copy.
mkdir -p "$T/src-copy" "$T/git"
(cd "$here" && { if [ -e .git ]; then git ls-files; else jj file list; fi; } | tar -cf - -T -) | tar -xf - -C "$T/src-copy"
git -C "$T/src-copy" init -q -b main
git -C "$T/src-copy" add -A
git -C "$T/src-copy" -c user.name=proof -c user.email=proof@example.invalid commit -q -m proof
git clone -q --bare "$T/src-copy" "$T/git/pdt3.git"
GITSPEC="git+file://$T/git/pdt3.git#main"

one_effect_pnpm() { # in the consumer dir
  echo "-- one Effect copy (pnpm)"
  local copies; copies="$(find node_modules/.pnpm -maxdepth 1 -name 'effect@*' | wc -l)"
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
}

one_effect_npm() { # in the consumer dir
  echo "-- one Effect copy (npm: hoisting resolves peers differently from pnpm)"
  npm ls effect --all || true
  local n; n="$(npm ls effect --all --parseable | sort -u | wc -l)"
  [ "$n" = 1 ] || { echo "FAIL: $n effect copies under npm"; exit 1; }
}

integrator() { # in the pnpm consumer dir; $1 = screenshot
  echo "-- integrator script + browser probe"
  cp "$here/dev/pack-proof/server.mjs" "$here/dev/pack-proof/probe.mjs" .
  node server.mjs "$PWD/state" "$PORT" > server.log 2>&1 & local pid=$!; PIDS+=("$pid")
  for _ in $(seq 1 60); do grep -q '^READY ' server.log 2>/dev/null && break; sleep 0.5; done
  local link; link="$(sed -n 's/^READY //p' server.log)"; [ -n "$link" ] || { cat server.log; exit 1; }
  mkdir -p "$(dirname "$1")"
  node probe.mjs "$link" "$1"
  kill "$pid"; wait "$pid" 2>/dev/null || true
}

consumer() { # $1 = name, $2 = spec to install; the pnpm consumer's pnpm-workspace.yaml is $PNPM_WORKSPACE
  local name="$1" spec="$2" shot="$3"
  echo "== $name: pnpm"
  mkdir -p "$T/$name-pnpm" && cd "$T/$name-pnpm"
  echo '{ "name": "consumer", "private": true, "type": "module" }' > package.json
  printf '%s' "${PNPM_WORKSPACE:-}" > pnpm-workspace.yaml
  pnpm add "$spec" $PEERS "$PW" 2>&1 | tail -15
  one_effect_pnpm
  integrator "$shot"
  echo "== $name: npm"
  mkdir -p "$T/$name-npm" && cd "$T/$name-npm"
  echo '{ "name": "npm-consumer", "private": true }' > package.json
  npm install --no-audit --no-fund --loglevel=error ${NPM_FLAGS:-} "$spec" $PEERS 2>&1 | tail -15
  one_effect_npm
  cd "$here"
}

consumer tarball "${TGZ[0]}" "$SHOT"
# pnpm 10 blocks a git dependency's `prepare` unless the consumer allowlists it (npm runs it by default, but npm 12 refuses git dependencies unless `--allow-git=root`).
NPM_FLAGS=--allow-git=root PNPM_WORKSPACE=$'onlyBuiltDependencies:\n  - "@mgabor3141/pi-durable-t3"\n' consumer git "$GITSPEC" "${SHOT%.png}-git.png"

echo "PACK PROOF OK ($T)"
