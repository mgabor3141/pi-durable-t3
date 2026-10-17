# pi-durable-t3

A bridge that allows using T3 Code as a frontend for pi-durable. Experimental.

https://github.com/user-attachments/assets/250218eb-9a15-4f99-aa00-cf3c1e75d38e

A turn survives a crash: the clip sends a message, kills the host mid-turn, restarts it, and the turn
finishes after T3 reconnects — its socket reconnects on a ~75s backoff, so press **Retry** to skip the wait.

Pair [T3 Code](https://github.com/pingdotgg/t3code)'s web app with a [pi-durable](https://github.com/earendil-works/pi) Harness. You set up the Harness — storage, extensions, tools, execution env — and call
**`attachT3(harness, opts)`**, one entry point that adds a threads layer and a T3 facet speaking T3's wire
protocol. T3 then shows your Harness in the sidebar, with its projects and threads. Design:
[`docs/design.md`](docs/design.md) (its first section is the rule every feature is checked against).

## The library

```ts
import { attachT3 } from "pi-durable-t3/bridge";

const t3 = await attachT3(harness, {
        models,            // the catalog: T3's picker list (the bridge selects nothing)
        projects,          // the project registry (FileProjectRegistry is the shipped store)
        dataDir,           // T3's settings.json + the registry file live here
        listen,            // { host, port }
        stateDir,          // facet credential state
        label, webAppUrl, corsOrigins, tokenTtlSeconds, pairingToken, newThread, log,   // optional
      });
await t3.ready;                       // listening (rejects with the bind error)
console.log(t3.pairingUrls(t3.pairingCode()));
```

`src/` is the bridge; it decides nothing about the agent — the client names the model on every create and
prompt, the catalog is what you hand in, and a new thread's configuration comes from your `newThread` hook.
A test enforces the boundary (`test/boundary.test.ts`).

## The example host

[`examples/coding-agent/`](examples/coding-agent/) is the integrator's recipe: a pi-durable Harness with the
coding tools (`read`/`write`/`edit`/`bash`), a base prompt (+ optional instructions file), a model runtime
from your pi config, config-file parsing, and bounded shutdown. It is what `pnpm start` runs.

```sh
pnpm install
pnpm setup:t3     # shallow-fetches t3code at the pin; vendors @t3tools/contracts (+ LICENSE) into gitignored
                  # vendor/ and builds the web app into gitignored web-dist/ (a few minutes, needs network)
pnpm start        # XDG config/data dirs; add `-- --root <dir>` for a single-directory instance
```

The host opens the Harness, serves the facet, and prints a one-time pairing code and link. Model catalog and
credentials come from your pi config in `~/.pi/agent` (override with `PI_CODING_AGENT_DIR`). No credentials?
Use the offline reply model: `PI_DURABLE_T3_FAKE=1 pnpm start` (or with `-- --root …`).

## Configure

Three files, three tiers (see [`docs/state.md`](docs/state.md) for the full map):

- **`config.toml` — the integrator's**, in `$XDG_CONFIG_HOME/pi-durable-t3` (default `~/.config/…`). What a
  UI must not set: the listen address, the `web` origin, the facet's `[t3]` settings, the `instructions`
  file. `--root <dir>` overrides config and data locations so an instance is one directory. Unknown keys are
  rejected, naming the file, key path, and expectation; a missing file is an error, an empty one is valid.
  [`config.example.toml`](config.example.toml) is the commented reference.
- **`settings.json` — T3's server settings**, in the data dir. T3's own document (the contracts'
  `ServerSettings`), stored and patched exactly as T3's server stores and patches it. The UI's settings
  panes edit it through the host; the bridge interprets nothing in it.
- **`projects.json` — the project registry**, in the data dir. The UI's Add-project picker edits it through
  the host. A project is a directory; its **id is minted by whoever registers it** — the UI mints a UUID and
  the host stores and answers it; a hand-written entry may carry an `id` or omit one (derived from the
  normalized path, pinned on first mutation — an id is assigned once, never re-derived, so a root move keeps
  its threads). The title is a label; **the path is the uniqueness key**. Missing files are valid (empty
  registry, contract defaults); unparseable ones are a refusal naming the file — the host does not boot over
  damage, and does not write over it. One host per data dir.

Defaults keep the facet on loopback, requests with a non-loopback `Host` are rejected, and the fixed reusable
pairing token is env-var-only, for tests. CORS is pinned to `web` when you set it; with `web` and
`cors_origins` both unset the facet answers `Access-Control-Allow-Origin: *` — every call still needs a
bearer token, so set `web` to pin it.

## Pair

Serve the built web app (static SPA from `web-dist/`, on 5733; override `WEB_DIST`/`WEB_PORT`):

```sh
pnpm web
```

Open the pairing link the host printed at start. With `web` set it is exactly:

```
<web>/pair?host=<facet>#token=<code>      e.g.  http://127.0.0.1:5733/pair?host=http%3A%2F%2F127.0.0.1%3A3774#token=AbCdEf
```

(For the T3 **desktop/mobile** app, choose **Add environment** and paste the facet's `/pair#token=<code>`
link the host also prints.) Mint another code with `pnpm start -- pair --root <root>`.

New threads take the model the client names (the picker lists your catalog); prompts run in the project's
directory.

## Layout

`src/bridge.ts` is the one entry point; `src/threads.ts` the threads layer over pi-durable; `src/registry.ts`
and `src/settings.ts` the two data-dir files; `src/t3/` the facet (the only place Effect lives).
`examples/coding-agent/` is the example host (config, models, prompt, shutdown). `dev/` holds the setup and
smoke scripts.

## Tests

`pnpm test` and `pnpm typecheck` need no credentials and never touch `~/.pi` or the network.
`examples/coding-agent/live-model.test.ts` runs one real-model turn end to end, only with
`PI_DURABLE_T3_LIVE_MODEL=<provider>/<model>` set; it is skipped otherwise.

`pnpm smoke` drives the real T3 web app in a browser (pair → prompt → reply → undo) against a throwaway root
on its own ports (facet 4911, web 4920; override `FACET_PORT`/`WEB_PORT`). Needs `web-dist/` and Chromium.

## Capabilities

[T3's API calls and what this host answers](docs/capabilities.md), marked ✅ works, 🔜 soon, 🕐 later,
❌ never, each with its reason. The short version: threads, prompts, steering, interrupts, per-thread
models, undo, T3's server settings, and the project registry work today; forks and renames are next; git,
terminals, file panels and previews are refused on purpose, because the agent has `bash` and works in real
repos itself.

A refused call answers T3 with a message, so the UI shows why, and state is never left half-changed.
Refused *on purpose* says so; refused *for now* says "yet".

The paired agent runs `bash` with **no approvals, as the host user**, in the project directories you
add. Loopback is the default bind; `config.toml` holds the address, CORS and the Host check.

## License

MIT. Vendored T3 contracts stay MIT (T3 Tools); see `LICENSE`.
