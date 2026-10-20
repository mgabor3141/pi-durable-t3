---
name: bump-pins
description: Move pi-durable-t3 to a newer T3 Code nightly and/or newer pi packages (@earendil-works/*), then review the bump. Use when asked to upgrade, bump, or update T3 or pi.
---

# Bumping T3 and pi

Two independent bumps. Do each in its own commit stack; do them in parallel only in separate checkouts.

**Isolation first.** A running host serves the checkout's `web-dist/` and `vendor/contracts`, and `pnpm install` /
`pnpm setup:t3` rewrite them. Work in a separate checkout (a jj workspace) with its OWN `node_modules`, `vendor`,
`web-dist` and `.t3-cache` — never symlinks to the main checkout's. Run `pnpm install`, then `pnpm setup:t3`, there.
Agents working in parallel need disjoint `FACET_PORT`s and probe ports.

## T3 pin

1. Find the target: `gh api 'repos/pingdotgg/t3code/releases?per_page=10' --jq '.[].tag_name'` (nightlies are
   `v<ver>-nightly.<date>.<n>`); its commit: `gh api repos/pingdotgg/t3code/commits/<tag> --jq .sha`.
2. Set `PIN` and `T3_TAG` in `dev/setup-t3.sh` and `SERVER_VERSION` in `src/t3/http.ts` (a test keeps them equal). Run
   `pnpm setup:t3`.
3. Fetch the OLD pin into a temp dir and diff, for what the bridge serves:
   - `packages/contracts/src`: new or changed RPCs, new REQUIRED fields (optional ones decode from absence), settings
     keys, descriptor capabilities (`environment.ts`), projection/shell fields.
   - The client's RPC call sites (`apps/web/src`, `packages/client-runtime/src`): collect every `*_METHODS.x` reference
     old vs new. A new method called at boot or in a common flow that the bridge does not answer can hang the UI:
     that is a blocker. Also look for fields the client now reads without a fallback.
   - The T3 server code the bridge replicates. `grep -rn 'T3' src/t3` names the sources; at least
     `scheduledTasks/{ScheduledTaskService,Schedule}.ts`, `orchestration-v2/{ThreadLaunchService,Orchestrator,ProjectionStore}.ts`,
     and the sidebar status logic. An upstream behaviour change there is ours to follow.
4. For each delta: replicate faithfully, or refuse with a clear message (`docs/design.md`), and record it in
   `docs/capabilities.md`.

## pi packages

1. `pnpm view @earendil-works/pi-durable versions`. The packages pin each other EXACTLY: move
   `chord`, `pi-ai`, `pi-coding-agent` and `pi-durable` together.
2. Read every changelog between the versions (`node_modules/@earendil-works/*/CHANGELOG.md` after install). chord's
   breaking changes hit `src/objects.ts`, `src/bridge.ts`, `src/t3/bridge.ts` and the tests that build a host.
3. Port minimally: adapt to the new API, do not adopt new features.
4. **Stored data.** Copy a real data dir (`~/.local/share/pi-durable-t3`; read only, never in place) and start the new
   host on the copy: threads list, transcripts open, a thread takes a new message, and survive a restart.

## Checks (both bumps)

- `pnpm typecheck`, `pnpm test`, `FACET_PORT=<port> pnpm smoke`.
- pi bumps: `PI_DURABLE_T3_LIVE_MODEL=<provider>/<model> pnpm vitest run examples/coding-agent/test/live-model.test.ts`.
- T3 bumps: a browser run against the new `web-dist` (playwright-core): pair, prompt, reply, stop, Settings pages
  (General, Connections, Scheduled Tasks); compare console errors with the old `web-dist`. Known noise:
  `clerk.t3.codes` 400 and `POST /api/observability/v1/traces` 404.

## Review

Have a second agent review each bump adversarially, in its own checkout, without trusting the author's report. What
reviews have caught before: a T3 change the author missed in a replicated service; reference leaks around chord's
`get`/`hold`; a boot-order race hidden by a fast test store. The reviewer reports findings with a reproduction,
severity and smallest fix; the fixes land with a test that fails without them.
