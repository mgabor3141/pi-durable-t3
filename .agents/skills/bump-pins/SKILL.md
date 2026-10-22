---
name: bump-pins
description: Move pi-durable-t3 to a newer T3 Code stable release and/or newer pi packages (@earendil-works/*), then review the bump. Use when asked to upgrade, bump, or update T3 or pi.
---

# Bumping T3 and pi

Two independent bumps. Do each in its own commit stack; do them in parallel only in separate checkouts.

**Isolation first.** A running host serves the checkout's `packages/web/app` and `vendor/contracts`, and `pnpm install` /
`pnpm setup:t3` rewrite them. Work in a separate checkout (a jj workspace) with its OWN `node_modules`, `vendor`,
`packages/web/app` and `.t3-cache` — never symlinks to the main checkout's. Run `pnpm install`, then `pnpm setup:t3`, there.
Agents working in parallel need disjoint `FACET_PORT`s and probe ports.

## T3 pin

1. Find the target: the latest stable release, `gh api repos/pingdotgg/t3code/releases/latest --jq .tag_name`
   (`prerelease: false`; we pin releases, never nightlies or previews).
2. Copy `.t3-cache/t3code` aside first: it is the OLD pin to diff against, and `pnpm setup:t3` replaces it.
   Then set `T3_TAG` in `dev/t3-pin.sh` (the one place; the commit is read from the fetched tag and recorded in
   `.t3-cache/t3code-tag`) and `SERVER_VERSION` in `src/t3/http.ts` (the tag without the `v`; a test keeps them
   equal), and run `pnpm setup:t3`. Note the resolved sha (`.t3-cache/t3code-tag`) in the commit message, so the
   reviewed commit is in history: tags are mutable.
3. Diff the old pin against `.t3-cache/t3code`, for what the bridge serves:
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
- T3 bumps: a browser run against the new web app (`packages/web/app`) (playwright-core): pair, prompt, reply, stop, Settings pages
  (General, Connections, Scheduled Tasks); compare console errors with the old one. Known noise:
  `clerk.t3.codes` 400 and `POST /api/observability/v1/traces` 404.

## Release (npm)

Two packages under `packages/`: `web` (T3's built web app; its `version` IS the T3 version it carries) and `bridge`
(`@mgabor3141/pi-durable-t3`). The example agent is a template in the repo, not published. After a bump:

1. **T3 bump:** set `packages/web/package.json` `version` to the new T3 version (no `v`) and `t3.tag` to the new tag.
   `test/server-version.test.ts` fails until both equal `T3_TAG`. Bump the `bridge` version too (it ships new
   bridge code: a patch/minor by semver of the API).
   **pi bump:** move the exact `devDependencies` in `packages/bridge` together with the root `dependencies`; keep the bridge's `peerDependencies` at `^<major>.<minor>.0` of the lowest version you support.
   Versions are independent otherwise; `workspace:*` becomes the exact version at publish.
2. `pnpm setup:t3 && pnpm build && FACET_PORT=<port> dev/pack-proof.sh`: packs the two, installs the tarballs in a
   temp dir, checks one Effect copy, runs an integrator script plus a browser probe. Read the
   tarball listing it prints (nothing from tests, `.memory`, `.t3-cache`; no source maps are built).
3. Commit, then tag `v<bridge version>` and push the tag. `.github/workflows/release.yml` repeats build, typecheck,
   test, smoke and the pack proof, then `pnpm -r publish --provenance --access public` (web first; versions already
   on the registry are skipped). The tag must equal the bridge's version (the workflow checks).
4. **Auth:** npm trusted publishing (OIDC) cannot publish a package's first version, so the first release needs an
   `NPM_TOKEN` repository secret (granular, read and write on all packages of `@mgabor3141`, since they do not exist
   yet; with "bypass 2FA" if the account enforces 2FA). Then configure a trusted publisher per
   package on npmjs.com (repo `mgabor3141/pi-durable-t3`, workflow `release.yml`) and delete the secret: with no token
   the workflow publishes by OIDC. `effect`, `@effect/platform-node` and `@effect/platform-node-shared` are pinned to the SAME exact version (bridge
   deps and the root `pnpm.overrides`; each has a peer `effect ^<its own version>`). `dev/pack-proof.sh` asserts one copy under npm.

## Review

Have a second agent review each bump adversarially, in its own checkout, without trusting the author's report. What
reviews have caught before: a T3 change the author missed in a replicated service; reference leaks around chord's
`get`/`hold`; a boot-order race hidden by a fast test store. The reviewer reports findings with a reproduction,
severity and smallest fix; the fixes land with a test that fails without them.
