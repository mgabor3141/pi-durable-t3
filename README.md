# pi-durable-t3

A bridge that allows using T3 Code as a frontend for pi-durable. Experimental.

https://github.com/user-attachments/assets/250218eb-9a15-4f99-aa00-cf3c1e75d38e

Pair [T3 Code](https://github.com/pingdotgg/t3code)'s web app with a [pi-durable](https://github.com/earendil-works/pi) Harness. You set up the Harness: storage, extensions, tools, execution env. This adds a small threads layer and a T3 facet that speaks T3's wire protocol. T3 then shows your Harness in the sidebar, with its projects and threads. Design: [`docs/design.md`](docs/design.md).

## Set up

```sh
pnpm install
pnpm setup:t3     # shallow-fetches t3code at the pin; vendors @t3tools/contracts (+ LICENSE) into gitignored
                  # vendor/ and builds the web app into gitignored web-dist/ (a few minutes, needs network)
```

## Configure

```sh
mkdir -p ~/.pi/durable-t3
cp host.example.toml ~/.pi/durable-t3/host.toml
```

[`host.example.toml`](host.example.toml) is a commented reference: the required part is at least one
`[[projects]]` block (a directory under the root, in which its threads run `bash` and the file tools, as
the host user), and every optional key is shown commented with its default (`listen`, `web`,
`default_model`, `instructions`, `[t3]`). Unknown keys are rejected, naming the file, the key path, and
what was expected; an empty file is valid (defaults, no projects), a missing file is an error. Defaults
keep the facet on loopback, requests with a non-loopback `Host` are rejected, and the fixed reusable
pairing token is env-var-only, for tests. CORS is pinned to `web` when you set it; with `web` and
`cors_origins` both unset the facet answers `Access-Control-Allow-Origin: *` — every call still needs a
bearer token, so a browser can't read the API cross-site, but set `web` to pin it.

## Run

```sh
pnpm start -- --root ~/.pi/durable-t3
```

The host opens a Harness with the coding tools (`read`/`write`/`edit`/`bash`), runs each thread in its project's directory, serves the T3 facet, and prints a one-time pairing code and link. Model catalog and credentials come from your pi config in `~/.pi/agent` (override with `PI_CODING_AGENT_DIR`). No credentials? Use the offline reply model: `PI_DURABLE_T3_FAKE=1 pnpm start -- --root …`.

New threads start from a built-in base prompt (coding agent, its working directory, the platform). `instructions` appends a file's text to it, read at thread create: editing the file affects new threads only, and a missing file fails at start.

## Pair

Serve the built web app (static SPA from `web-dist/`, on 5733; override `WEB_DIST`/`WEB_PORT`):

```sh
pnpm web
```

Open the pairing link the host printed at start. With `web` set it is exactly:

```
<web>/pair?host=<facet>#token=<code>      e.g.  http://127.0.0.1:5733/pair?host=http%3A%2F%2F127.0.0.1%3A3774#token=AbCdEf
```

(For the T3 **desktop/mobile** app, choose **Add environment** and paste the facet's `/pair#token=<code>` link the host also prints.) Mint another code with `pnpm start pair --root <root>`.

## Layout

`src/main.ts` is the **reference host**: config, models, shutdown, wiring. `src/host-runtime.ts` opens the Harness (coding tools, base prompt, per-thread cwd); `src/threads.ts` is the threads layer over pi-durable; `src/t3/` is the facet (the only place Effect lives). `dev/` holds the setup and smoke scripts.

## Tests

`pnpm test` and `pnpm typecheck` need no credentials and never touch `~/.pi` or the network. `test/live-model.test.ts` runs one real-model turn end to end, only with `PI_DURABLE_T3_LIVE_MODEL=<provider>/<model>` set; it is skipped otherwise.

`pnpm smoke` drives the real T3 web app in a browser (pair → prompt → reply → undo) against a throwaway root on its own ports. Needs `web-dist/` and Chromium.

## Capabilities

[T3's API calls and what this host answers](docs/capabilities.md), marked ✅ works, 🔜 soon, 🕐 later,
❌ never, each with its reason. The short version: threads, prompts, steering, interrupts, per-thread
models and undo work today; forks, renames and the project registry are next; git, terminals, file panels
and previews are refused on purpose, because the agent has `bash` and works in real repos itself.

A refused call answers T3 with a message, so the UI shows why, and state is never left half-changed.
Refused *on purpose* says so; refused *for now* says "yet".

The paired agent runs `bash` with **no approvals, as the host user**, in the project directories you
add. Loopback is the default bind; `host.toml` holds the address, CORS and the Host check.

## License

MIT. Vendored T3 contracts stay MIT (T3 Tools); see `LICENSE`.
