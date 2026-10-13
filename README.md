# pi-durable-t3

Pair [T3 Code](https://github.com/pingdotgg/t3code)'s web app with a [pi-durable](https://github.com/earendil-works/pi) Harness — T3 Code as a frontend for pi-durable.

Unofficial; not affiliated with T3 Tools or Earendil. Experimental. Built against pi `1.2.0`. Design: [`docs/design.md`](docs/design.md).

You set up the Harness: storage, extensions, tools, execution env. This adds a small threads layer and a
T3 facet that speaks T3's wire protocol. T3 then shows your Harness as one environment, its projects and
threads in the sidebar.

## Set up

pi's packages install from npm (`@earendil-works/*` at `1.2.0`); no local pi clone is needed. Then one script
fetches the pinned T3 Code and builds the pieces the host needs:

```sh
pnpm install
pnpm setup:t3     # shallow-fetches t3code at the pin (dev/setup-t3.sh); vendors @t3tools/contracts (+ LICENSE)
                  # into gitignored vendor/ and builds the web app into gitignored web-dist/
```

The contracts are vendored locally (not linked into the T3 tree) so the facet and the contracts share one Effect
copy — two Effect instances break the schema brand encode. `web-dist/` is the built SPA you serve in **Open T3**.

## Configure

Write `<root>/host.toml` (parsed with `smol-toml` and validated against one schema). Every key's type and default is
annotated below; **unknown keys are rejected** (a typo fails fast, naming the file, key path, and what was expected).

```toml
listen        = "127.0.0.1:3774"            # str  "host:port" — the facet address        (default "127.0.0.1:3774"; the T3 app uses 3773)
web           = "http://127.0.0.1:5733"     # str? your T3 web app URL; set → print a pairing link   (unset)
default_model = "anthropic/claude-sonnet-4-5"  # str? "provider/model" new threads start on        (unset → first available)
instructions  = "AGENTS.md"     # str? file whose text becomes new threads' instructions   (unset; `~`/relative to root)

[t3]                                        # the facet's own settings — every key optional
label          = "pi"           # str    environment name shown in T3               (default "pi")
state_dir      = "t3-auth"      # str?   auth/threads dir, under the root           (default "t3-auth")
token_ttl_days = 90             # int    bearer-token lifetime in days              (default 90)
cors_origins   = ["http://127.0.0.1:5733"]  # [str] allowed CORS origins   (default: the `web` origin, or none)

[[projects]]                    # one per project; at least one to make threads
name = "alpha"                  # str    unique id; also the default path
path = "projects/alpha"         # str?   directory, relative to the root            (default: name)
```

Checks beyond the types, run after validation: each project `path` must resolve **under the root** (`../x`, an
absolute path outside it, and `a/../../b` are refused; an absolute path that stays under the root is fine), project
names must be unique, `listen` must be a `host:port` with an **explicit** port `1-65535` (no leading zeros — a bare
`host:` or `:0` is rejected), and `default_model` must be `provider/model`. An empty
`host.toml` is valid (defaults, no projects); a missing file is an error. There is no `pairing_token` key: a fixed,
reusable pairing token is set only with the `PI_DURABLE_T3_PAIRING_TOKEN` env var (for tests); it is not meant to live
in `host.toml` and that key is rejected. By default a host has no CORS origins beyond the `web` origin, and when bound
to loopback it rejects requests whose `Host` header is not a loopback name (DNS-rebinding guard).

Every new thread starts from a built-in **base prompt** (the model is a coding agent; its own working directory and the
platform). `instructions` adds a file's text on top: it is read when a thread is **created** and
stored on that thread's conversation (so forks/undo copies keep it); editing the file affects **new threads only**, and
a missing/unreadable file fails at start. Explicit only — nothing is auto-discovered.

## Run

```sh
pnpm start -- --root ~/.pi/durable-t3
```

This opens a local Harness with the coding tools (`read`/`write`/`edit`/`bash`) running each thread in its
project's directory, serves the T3 facet, and prints a one-time pairing code and a full pairing link.

For a real model, the model catalog and their credentials come from your pi config in `~/.pi/agent` (override the
directory with `PI_CODING_AGENT_DIR`); `default_model` is a `provider/model` you have access to there. To run without
any credentials, use the offline reply model instead:

```sh
PI_DURABLE_T3_FAKE=1 pnpm start -- --root ~/.pi/durable-t3
```

## Open T3

Serve the built web app (a static SPA; `web` serves `web-dist/` on 5733 by default, override `WEB_DIST`/`WEB_PORT`):

```sh
pnpm web
```

Then open the pairing link the host printed at start. With `web` set it is exactly:

```
<web>/pair?host=<facet>#token=<code>      e.g.  http://127.0.0.1:5733/pair?host=http%3A%2F%2F127.0.0.1%3A3774#token=AbCdEf
```

(For the T3 **desktop/mobile** app, choose **Add environment** and paste the facet's own `/pair#token=<code>`
link the host also prints.) Mint another code with `pnpm start pair --root <root>`.

`src/main.ts` is the **reference host** (wires everything below); `src/host-runtime.ts` is the Harness wiring (installs
the coding tools and the base prompt, and reads `instructions` per new thread); `src/t3/` is the facet.

## Tests

`pnpm test` and `pnpm typecheck` need no credentials and never touch `~/.pi` or the network. One test,
`test/live-model.test.ts`, runs a single real-model turn end to end, but only when `PI_DURABLE_T3_LIVE_MODEL=<provider>/<model>`
is set (it uses your `~/.pi/agent` credentials then); it is skipped otherwise.

## Browser smoke

One Playwright smoke drives the real T3 web app: pair, prompt, see the offline reply, then undo.
It brings up a throwaway root and both servers on its own ports (4911 / 4920), then tears them down.
It needs the pinned web app and Chromium:

```sh
# WEB_DIST defaults to ./web-dist (built by setup:t3); CHROMIUM defaults to /usr/bin/chromium.
pnpm smoke
```

## Known limitations

Short version of [the design's limitations](docs/design.md#limitations):

- **No forking.** Fork / merge-back and archived threads are refused (thread copy on undo/promotion is internal).
- **No per-project `AGENTS.md`.** Only the explicit `instructions` file is read (at thread create); nothing is
  auto-discovered from a project directory.
- **Storage only grows.** pi-durable has no delete/GC; deleting a thread drops its pointer, not the conversation.
- **T3 panels are stubbed.** The git, terminal, diff and VCS/PR views are refused — the paired agent runs `bash` and
  writes files with no approvals, as the host user.
- **A shell running at a crash finishes on its own.** pi-durable runs shells detached; after a crash the command keeps
  going and the model is told the call may have partially run.
- **Reconnect after a restart is not instant.** T3's socket reconnects on its own cadence — after a host restart it can
  take a minute (or more) to come back.

## License

MIT — see [LICENSE](LICENSE). The pinned T3 contracts are vendored under their own MIT license
(`vendor/contracts/LICENSE`, Copyright (c) 2026 T3 Tools Inc.); pi is used from npm. Unofficial; not affiliated
with T3 Tools or Earendil.
