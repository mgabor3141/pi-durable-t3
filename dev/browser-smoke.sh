#!/usr/bin/env bash
# Run the browser smokes end-to-end in a throwaway environment: a fresh root and the host (offline reply model) on the
# facet port — which also serves the built web app (the host serves the repo's web-dist). No separate web server: the
# web app's "This machine" (primary environment) IS the facet. Cleans up only the processes it starts.
#
#   dev/browser-smoke.sh
# Env overrides: FACET_PORT (default 4911), WEB_PORT (default 4920, unused: the web app is served from the facet),
# WEB_DIST (default the repo's web-dist, fetched by `pnpm setup:t3`), CHROMIUM (default /usr/bin/chromium). Ports avoid
# the default listen port so both can run side by side.
#
# Four smokes share one root and one web app (the host serves it at the facet origin):
#   1. pair → prompt → reply → undo (test/e2e/browser-smoke.ts)
#   2. send → kill the host mid-turn → restart → the client shows the held message exactly once
#      (test/e2e/crash-restart-browser.ts; this shell owns the host process, so it does the kill and the restart, and
#       hands off to the browser through files).
#   3. add a project from the picker, create a thread in it, remove it; the files on disk are untouched
#      (test/e2e/project-flow.ts).
#   4. the pi host is "This machine"; mint a pairing link in Settings → Connections and see the device list
#      (test/e2e/connections-flow.ts).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"

FACET_PORT="${FACET_PORT:-4911}"
WEB_PORT="${WEB_PORT:-4920}"          # unused: the web app is served from the facet origin, not a separate port.
WEB_DIST="${WEB_DIST:-$here/web-dist}"
CHROMIUM="${CHROMIUM:-/usr/bin/chromium}"
root="$(mktemp -d "${TMPDIR:-/tmp}/pi-durable-t3-smoke-XXXXXX")"
pids=()
HOST_PID=""

cleanup() {
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT

[ -d "$WEB_DIST" ] || { echo "web-dist not found at $WEB_DIST (set WEB_DIST to the built T3 web app)"; exit 2; }

mkdir -p "$root/projects/alpha" "$root/projects/beta" "$root/t3"
cat > "$root/config.toml" <<TOML
listen = "127.0.0.1:$FACET_PORT"
TOML
# The host serves the web app from its own origin (the repo's web-dist), so there is no web origin to trust in CORS:
# the desktop app (t3code://app) is allowed by default; the served SPA is same-origin. The project registry lives in
# the bridge dir (the data dir's t3/), NOT config.toml. `t3-settings.json` (T3's server settings) is absent: the host
# answers the contract's defaults, with the pi provider instance enabled.
cat > "$root/t3/projects.json" <<JSON
{
  "projects": [
    { "path": "$root/projects/alpha", "title": "alpha" },
    { "path": "$root/projects/beta", "title": "beta" }
  ]
}
JSON

# A single-use pairing code, minted the way a user adds a device (the host's `pair` command against the state dir).
mint_code() {
  node --experimental-strip-types "$here/examples/coding-agent/src/host.ts" pair --root "$root" 2>/dev/null \
    | sed -n 's/^Pairing code (single use): //p' | head -1
}

echo "root=$root  facet=127.0.0.1:$FACET_PORT (serves the web app from the facet origin)  web-dist=$WEB_DIST"

start_host() {
  PI_DURABLE_T3_FAKE=1 \
    node --experimental-strip-types "$here/examples/coding-agent/src/host.ts" -- --root "$root" >> "$root/host.log" 2>&1 &
  HOST_PID="$!"
  pids+=("$HOST_PID")
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$FACET_PORT/.well-known/t3/environment" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Start the host (offline reply model) and wait until it is listening.
start_host || { echo "facet did not start:"; cat "$root/host.log"; exit 1; }

# The web app is served from the facet origin; the smoke opens it there (WEB == the facet).
FACET="http://127.0.0.1:$FACET_PORT"
# Codes are single-use: mint one per browser flow, against the running host's state dir.
PAIR_TOKEN="$(mint_code)"
[ -n "$PAIR_TOKEN" ] || { echo "could not mint a pairing code"; cat "$root/host.log"; exit 1; }

set +e
T3_WEB="$FACET" BRIDGE="$FACET" PAIR="$PAIR_TOKEN" PAIR2="$(mint_code)" CHROMIUM="$CHROMIUM" \
  node --experimental-strip-types "$here/test/e2e/browser-smoke.ts"
status=$?
set -e

# Smoke 2: the crash-restart browser case. The browser script sends a message and waits; this shell kills the host the
# moment the message is durably placed (SENT_FILE), restarts it, and signals the browser (RESTARTED). The browser keeps
# its page open, so the kill/restart happens under a live client that is still holding the message.
if [ "$status" -eq 0 ]; then
  CRASH_TEXT="smoke crash $(date +%s)-$RANDOM"
  SENT_FILE="$root/crash-sent"; RESTARTED_FILE="$root/crash-restarted"; CRASH_FILE="$root/crash-thread"
  set +e
  T3_WEB="$FACET" BRIDGE="$FACET" PAIR="$(mint_code)" PAIR2="$(mint_code)" CHROMIUM="$CHROMIUM" \
    CRASH_TEXT="$CRASH_TEXT" CRASH_FILE="$CRASH_FILE" SENT_FILE="$SENT_FILE" RESTARTED_FILE="$RESTARTED_FILE" \
    node --experimental-strip-types "$here/test/e2e/crash-restart-browser.ts" &
  crash_pid="$!"
  pids+=("$crash_pid")

  # Wait for the message to be placed (the browser signals), then kill the host. If the browser ends first, stop waiting.
  killed=0
  for _ in $(seq 1 240); do
    if [ -e "$SENT_FILE" ]; then kill "$HOST_PID" 2>/dev/null || true; killed=1; break; fi
    kill -0 "$crash_pid" 2>/dev/null || break
    sleep 0.5
  done

  if [ "$killed" -eq 1 ]; then
    # The host must be gone before the browser's check runs. A guard SIGKILL bounds a shutdown that hangs on a turn.
    ( sleep 3; kill -9 "$HOST_PID" 2>/dev/null || true ) &
    guard=$!; wait "$HOST_PID" 2>/dev/null || true; kill "$guard" 2>/dev/null || true; wait "$guard" 2>/dev/null || true
    if ! start_host; then echo "crash-smoke: the host did not restart:"; cat "$root/host.log"; fi
    touch "$RESTARTED_FILE"
  else
    echo "crash-smoke: the browser ended before reporting a placed message"
  fi

  wait "$crash_pid"; crash_status=$?
  set -e
  [ "$crash_status" -ne 0 ] && status="$crash_status"
fi

# Smoke 3: the project-management flow — add a project from the directory picker, create a thread in it, remove it, and
# confirm the files on disk are untouched. The target directory is NOT in projects.json (the picker adds it), and it
# holds a marker file that must survive the removal.
if [ "$status" -eq 0 ]; then
  mkdir -p "$root/projects/newproj"
  printf 'do not delete me\n' > "$root/projects/newproj/keep.txt"
  set +e
  T3_WEB="$FACET" BRIDGE="$FACET" PAIR="$(mint_code)" PAIR2="$(mint_code)" CHROMIUM="$CHROMIUM" \
    PICK_TARGET="$root/projects/newproj" PICK_MARKER="$root/projects/newproj/keep.txt" \
    node --experimental-strip-types "$here/test/e2e/project-flow.ts"
  flow_status=$?
  set -e
  # Belt and braces: the marker file must still be on disk after the whole flow.
  if [ "$flow_status" -eq 0 ] && [ ! -f "$root/projects/newproj/keep.txt" ]; then
    echo "project-flow: the marker file was deleted from disk"; flow_status=1
  fi
  [ "$flow_status" -ne 0 ] && status="$flow_status"
fi

# Smoke 4: Settings → Connections over the same-origin web app — the pi host is the primary environment, the browser
# mints a pairing link in the UI, and the device list shows its own session.
if [ "$status" -eq 0 ]; then
  set +e
  T3_WEB="$FACET" BRIDGE="$FACET" PAIR="$(mint_code)" PAIR2="$(mint_code)" CHROMIUM="$CHROMIUM" \
    node --experimental-strip-types "$here/test/e2e/connections-flow.ts"
  conn_status=$?
  set -e
  [ "$conn_status" -ne 0 ] && status="$conn_status"
fi

if [ "$status" -ne 0 ]; then
  echo "--- host.log ---"; cat "$root/host.log"
fi
exit "$status"
