---
name: bump-pins
description: Move pi-durable-t3 to a newer T3 Code stable release and/or newer pi packages (@earendil-works/*), then review the bump. Use when asked to upgrade, bump, or update T3 or pi.
---

# Bumping T3 and pi

Two independent bumps. Do each in its own commit stack; do them in parallel only in separate checkouts.

**Isolation first.** A running host serves the checkout's `web/` and `vendor/contracts`, and `pnpm install` /
`pnpm setup:t3` rewrite them. Work in a separate checkout (a jj workspace) with its OWN `node_modules`, `vendor`,
`web` and `.t3-cache` — never symlinks to the main checkout's. Run `pnpm install` there (its `prepare` runs
`setup:t3` and the build; after changing `T3_TAG` it refetches).
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
- T3 bumps: a browser run against the new web app (`web/`) (playwright-core): pair, prompt, reply, stop, Settings pages
  (General, Connections, Scheduled Tasks); compare console errors with the old one. Known noise:
  `clerk.t3.codes` 400 and `POST /api/observability/v1/traces` 404.

## Release (npm)

One package, the repo root: `@mgabor3141/pi-durable-t3` (the bridge bundle, its types, and T3's web app in `web/`). The
example agent is a template in the repo, not published. After a bump:

1. **T3 bump:** set `T3_TAG` in `dev/t3-pin.sh`; `test/server-version.test.ts` fails until `SERVER_VERSION` equals it.
   Bump the package `version` too (it ships new code: a patch/minor by semver of the API).
   **pi bump:** move the exact `devDependencies` of the pi packages; keep the `peerDependencies` at
   `^<major>.<minor>.0` of the lowest version you support.
2. `FACET_PORT=<port> dev/pack-proof.sh`: packs the package and installs the tarball in a temp dir, then installs a
   git dependency from a local repo of the working copy (pnpm with the `onlyBuiltDependencies` allowlist, and npm), each
   checking one Effect copy and, under pnpm, running an integrator script plus a browser probe. Also
   `pnpm publish --dry-run --no-git-checks` and read the file list (nothing from tests, `.memory`, `.t3-cache`; no
   source maps).
3. Commit, then tag `v<version>` and push the tag. `.github/workflows/release.yml` repeats typecheck, test, smoke and
   the pack proof, then `pnpm publish --provenance --access public` (a version already on the registry is skipped).
   The tag must equal the package's version (the workflow checks). The README's install line
   (`github:mgabor3141/pi-durable-t3#v<version>`, also in the example's README) names the tag: update it.
4. **Auth:** npm trusted publishing (OIDC) cannot publish a package's first version, so the first release needs an
   `NPM_TOKEN` repository secret (granular, read and write on `@mgabor3141`; with "bypass 2FA" if the account
   enforces 2FA). Then configure a trusted publisher on npmjs.com (repo `mgabor3141/pi-durable-t3`, workflow
   `release.yml`) and delete the secret: with no token the workflow publishes by OIDC. `effect`,
   `@effect/platform-node` and `@effect/platform-node-shared` are pinned to the SAME exact version (the dependencies
   and `pnpm.overrides`; each has a peer `effect ^<its own version>`). `dev/pack-proof.sh` asserts one copy under npm.

## Review

Have a second agent review each bump adversarially, in its own checkout, without trusting the author's report. What
reviews have caught before: a T3 change the author missed in a replicated service; reference leaks around chord's
`get`/`hold`; a boot-order race hidden by a fast test store. The reviewer reports findings with a reproduction,
severity and smallest fix; the fixes land with a test that fails without them.
