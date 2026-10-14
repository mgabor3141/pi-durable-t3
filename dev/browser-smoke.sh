#!/usr/bin/env bash
# Run the browser smokes end-to-end in a throwaway environment: a fresh root, the host (offline reply model) on the
# facet port, the pinned T3 web app on a static port, then the Playwright flows. Cleans up only the processes it starts.
#
#   dev/browser-smoke.sh
# Env overrides: FACET_PORT (default 4911), WEB_PORT (default 4920), WEB_DIST (default the repo's web-dist, built by
# `pnpm setup:t3`), CHROMIUM (default /usr/bin/chromium). Ports avoid the default listen port so both can run side by side.
#
# Two smokes share one root and one web app:
#   1. pair → prompt → reply → undo (test/e2e/browser-smoke.ts)
#   2. send → kill the host mid-turn → restart → the client shows the held message exactly once
#      (test/e2e/crash-restart-browser.ts; this shell owns the host process, so it does the kill and the restart, and
#       hands off to the browser through files).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"

FACET_PORT="${FACET_PORT:-4911}"
WEB_PORT="${WEB_PORT:-4920}"
WEB_DIST="${WEB_DIST:-$here/web-dist}"
CHROMIUM="${CHROMIUM:-/usr/bin/chromium}"
PAIR_TOKEN="smoke-$$-$RANDOM"
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

mkdir -p "$root/projects/alpha" "$root/projects/beta" "$root/state"
cat > "$root/config.toml" <<TOML
listen = "127.0.0.1:$FACET_PORT"
TOML
# The instance file (the project registry the UI edits) lives in the data dir, NOT config.toml.
cat > "$root/settings.json" <<JSON
{
  "projects": [
    { "path": "$root/projects/alpha", "title": "alpha" },
    { "path": "$root/projects/beta", "title": "beta" }
  ],
  "defaults": {}
}
JSON

echo "root=$root  facet=127.0.0.1:$FACET_PORT  web=127.0.0.1:$WEB_PORT  web-dist=$WEB_DIST"

start_host() {
  PI_DURABLE_T3_FAKE=1 PI_DURABLE_T3_PAIRING_TOKEN="$PAIR_TOKEN" \
    node --experimental-strip-types "$here/src/main.ts" -- --root "$root" >> "$root/host.log" 2>&1 &
  HOST_PID="$!"
  pids+=("$HOST_PID")
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$FACET_PORT/.well-known/t3/environment" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Start the host (offline reply model, fixed pairing token) and wait until it is listening.
start_host || { echo "facet did not start:"; cat "$root/host.log"; exit 1; }

# Serve the pinned web app as an SPA.
node "$here/dev/serve-static.mjs" "$WEB_DIST" "$WEB_PORT" > "$root/web.log" 2>&1 &
pids+=("$!")

set +e
T3_WEB="http://127.0.0.1:$WEB_PORT" BRIDGE="http://127.0.0.1:$FACET_PORT" PAIR="$PAIR_TOKEN" CHROMIUM="$CHROMIUM" \
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
  T3_WEB="http://127.0.0.1:$WEB_PORT" BRIDGE="http://127.0.0.1:$FACET_PORT" PAIR="$PAIR_TOKEN" CHROMIUM="$CHROMIUM" \
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
# confirm the files on disk are untouched. The target directory is NOT in settings.json (the picker adds it), and it
# holds a marker file that must survive the removal.
if [ "$status" -eq 0 ]; then
  mkdir -p "$root/projects/newproj"
  printf 'do not delete me\n' > "$root/projects/newproj/keep.txt"
  set +e
  T3_WEB="http://127.0.0.1:$WEB_PORT" BRIDGE="http://127.0.0.1:$FACET_PORT" PAIR="$PAIR_TOKEN" CHROMIUM="$CHROMIUM" \
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

if [ "$status" -ne 0 ]; then
  echo "--- host.log ---"; cat "$root/host.log"
  echo "--- web.log ---"; cat "$root/web.log"
fi
exit "$status"
