#!/usr/bin/env bash
# Run the one browser smoke end-to-end in a throwaway environment: a fresh root, the host (offline reply model) on the
# facet port, the pinned T3 web app on a static port, then the Playwright flow. Cleans up only the processes it starts.
#
#   dev/browser-smoke.sh
# Env overrides: FACET_PORT (default 4911), WEB_PORT (default 4920), WEB_DIST (default the repo's web-dist, built by
# `pnpm setup:t3`), CHROMIUM (default /usr/bin/chromium). Ports avoid the default listen port so both can run side by side.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"

FACET_PORT="${FACET_PORT:-4911}"
WEB_PORT="${WEB_PORT:-4920}"
WEB_DIST="${WEB_DIST:-$here/web-dist}"
CHROMIUM="${CHROMIUM:-/usr/bin/chromium}"
PAIR_TOKEN="smoke-$$-$RANDOM"
root="$(mktemp -d "${TMPDIR:-/tmp}/pi-durable-t3-smoke-XXXXXX")"
pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT

[ -d "$WEB_DIST" ] || { echo "web-dist not found at $WEB_DIST (set WEB_DIST to the built T3 web app)"; exit 2; }

mkdir -p "$root/projects/alpha" "$root/projects/beta" "$root/state"
cat > "$root/config.toml" <<TOML
listen = "127.0.0.1:$FACET_PORT"

[[projects]]
name = "alpha"
path = "$root/projects/alpha"

[[projects]]
name = "beta"
path = "$root/projects/beta"
TOML

echo "root=$root  facet=127.0.0.1:$FACET_PORT  web=127.0.0.1:$WEB_PORT  web-dist=$WEB_DIST"

# Start the host (offline reply model, fixed pairing token) and wait until it is listening.
PI_DURABLE_T3_FAKE=1 PI_DURABLE_T3_PAIRING_TOKEN="$PAIR_TOKEN" \
  node --experimental-strip-types "$here/src/main.ts" -- --root "$root" > "$root/host.log" 2>&1 &
pids+=("$!")
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$FACET_PORT/.well-known/t3/environment" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$FACET_PORT/.well-known/t3/environment" >/dev/null || { echo "facet did not start:"; cat "$root/host.log"; exit 1; }

# Serve the pinned web app as an SPA.
node "$here/dev/serve-static.mjs" "$WEB_DIST" "$WEB_PORT" > "$root/web.log" 2>&1 &
pids+=("$!")

set +e
T3_WEB="http://127.0.0.1:$WEB_PORT" BRIDGE="http://127.0.0.1:$FACET_PORT" PAIR="$PAIR_TOKEN" CHROMIUM="$CHROMIUM" \
  node --experimental-strip-types "$here/test/e2e/browser-smoke.ts"
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "--- host.log ---"; cat "$root/host.log"
  echo "--- web.log ---"; cat "$root/web.log"
fi
exit "$status"
