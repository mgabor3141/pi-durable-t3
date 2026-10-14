# pi-durable-t3

A bridge that allows using T3 Code as a frontend for pi-durable. Experimental.

https://github.com/user-attachments/assets/250218eb-9a15-4f99-aa00-cf3c1e75d38e

A turn survives a crash: the clip sends a message, kills the host mid-turn, restarts it, and the turn
finishes after T3 reconnects — its socket reconnects on a ~75s backoff, so press **Retry** to skip the wait.

Pair [T3 Code](https://github.com/pingdotgg/t3code)'s web app with a [pi-durable](https://github.com/earendil-works/pi) Harness. You set up the Harness: storage, extensions, tools, execution env. This adds a small threads layer and a T3 facet that speaks T3's wire protocol. T3 then shows your Harness in the sidebar, with its projects and threads. Design: [`docs/design.md`](docs/design.md).

## Set up

```sh
pnpm install
pnpm setup:t3     # shallow-fetches t3code at the pin; vendors @t3tools/contracts (+ LICENSE) into gitignored
                  # vendor/ and builds the web app into gitignored web-dist/ (a few minutes, needs network)
```

## Configure

There are **two files**, one per tier — each owns what it owns, and neither duplicates the other.

```
mkdir -p ~/.config/pi-durable-t3 && cp config.example.toml ~/.config/pi-durable-t3/config.toml
```

**`config.toml` — the integrator's tier.** What a UI must not set: the listen address, the `web` origin, the
facet's own settings (`[t3]`), and the `instructions` file. It lives in `$XDG_CONFIG_HOME/pi-durable-t3`
(default `~/.config/…`); the data dir is `$XDG_DATA_HOME/pi-durable-t3` (default `~/.local/share/…`).
`--root <dir>` overrides both, keeping this instance's config (`<dir>/config.toml`) and all its data in one
directory. [`config.example.toml`](config.example.toml) is the commented reference. Unknown keys are rejected,
naming the file, key path, and what was expected; a missing file is an error, an empty one is valid.

**`settings.json` — the instance file, the UI's tier.** The project registry and the new-thread defaults (the
model and thinking level a new thread starts on) live here, **in the data dir** — with `--root <dir>`,
`<dir>/settings.json`. This is the file T3's **Add project** picker and model picker edit: you add a project in
the UI, and the running host writes it (atomically) on your behalf. A project is a directory (paths under the
data dir; `~` and absolute paths expand). Its **id is minted by whoever registers it** — the UI mints a UUID and
the host stores it; an entry you write by hand may carry an `id` (the host honors it) or omit one, and the host
derives a stable id from the path. The title is only a label, and **the path is the uniqueness key**: the same
folder can't be added twice. A missing file is valid (no projects, the first available model). The shape:

```jsonc
{
  // path required; title optional (defaults to the folder); id optional — a UUID the UI minted, honored as-is
  "projects": [ { "path": "projects/alpha", "title": "alpha", "id": "e05053f2-9966-4b92-9886-5092481b9703" } ],
  "defaults": { "model": "pi/…", "thinkingLevel": "off" }          // model optional; thinkingLevel one of off…max
}
```

Writing `[[projects]]` or `default_model` into `config.toml` is refused by name, pointing at `settings.json`.
Defaults keep the facet on loopback, requests with a non-loopback `Host` are rejected, and the fixed reusable
pairing token is env-var-only, for tests. CORS is pinned to `web` when you set it; with `web` and `cors_origins`
both unset the facet answers `Access-Control-Allow-Origin: *` — every call still needs a bearer token, so a
browser can't read the API cross-site, but set `web` to pin it.

## Run

```sh
pnpm start          # reads the XDG config above; add `-- --root <dir>` for a single-directory instance
```

The host opens a Harness with the coding tools (`read`/`write`/`edit`/`bash`), runs each thread in its project's directory, serves the T3 facet, and prints a one-time pairing code and link. Model catalog and credentials come from your pi config in `~/.pi/agent` (override with `PI_CODING_AGENT_DIR`). No credentials? Use the offline reply model: `PI_DURABLE_T3_FAKE=1 pnpm start` (or with `-- --root …`).

New threads start on the instance file's default model, else the first available one, and from a built-in base prompt (coding agent, its working directory, the platform). `instructions` appends a file's text to it, read at thread create: editing the file affects new threads only, and a missing file fails at start.

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
models, undo, and the project registry (add/remove from T3's picker, the model default) work today; forks and
renames are next; git, terminals, file panels and previews are refused on purpose, because the agent has `bash`
and works in real repos itself.

A refused call answers T3 with a message, so the UI shows why, and state is never left half-changed.
Refused *on purpose* says so; refused *for now* says "yet".

The paired agent runs `bash` with **no approvals, as the host user**, in the project directories you
add. Loopback is the default bind; `config.toml` holds the address, CORS and the Host check.

## License

MIT. Vendored T3 contracts stay MIT (T3 Tools); see `LICENSE`.
