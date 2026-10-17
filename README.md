# pi-durable-t3

Use [T3 Code](https://github.com/pingdotgg/t3code)'s web app as a frontend for a
[pi-durable](https://github.com/earendil-works/pi) Harness. Experimental. Unofficial; not affiliated with T3
Tools or Earendil.

https://github.com/user-attachments/assets/250218eb-9a15-4f99-aa00-cf3c1e75d38e

A turn survives a crash: send a message, kill the host mid-turn, restart it, and the turn finishes. T3's
socket reconnects on a ~75s backoff; press **Retry** to skip the wait.

## What it is

You build the Harness (storage, tools, extensions, models). The bridge attaches to it, adds a threads layer,
and serves T3's wire protocol, so T3's unmodified web app shows your Harness's projects and threads.

```ts
import { attachT3 } from "./src/bridge.ts";

const t3 = await attachT3(harness, {
	models,     // your catalog; T3's model picker lists it
	projects,   // the project registry
	dataDir,    // settings.json and projects.json live here
	stateDir,   // pairing credentials
	listen,     // { host, port }
	// optional: label, webAppUrl, corsOrigins, tokenTtlSeconds, log
});
await t3.ready;
console.log(t3.pairingUrls(t3.pairingCode()));
```

The bridge decides nothing about the agent. T3 picks the model and thinking level; the Harness says which
models exist. See [`docs/design.md`](docs/design.md).

## Run the example

[`examples/coding-agent/`](examples/coding-agent/) is the agent we test with: pi-durable's own coding-agent
recipe (`read`/`write`/`edit`/`bash`, a base prompt, models from your pi config) plus the bridge.

```sh
pnpm install
pnpm setup:t3   # fetch T3 at the pinned commit, vendor its contracts, build the web app (needs network)
mkdir -p ~/.config/pi-durable-t3 && cp config.example.toml ~/.config/pi-durable-t3/config.toml
pnpm start      # prints a pairing code and link
pnpm web        # serves the web app on 5733
```

Open the printed link. With `web` set in `config.toml` it is ready to click. For T3's desktop app, use
**Add environment** with the `/pair#token=…` link. Mint another code with `pnpm start pair`.

- Credentials come from `~/.pi/agent` (override with `PI_CODING_AGENT_DIR`). No credentials:
  `PI_DURABLE_T3_FAKE=1 pnpm start` uses an offline reply model.
- `--root <dir>` keeps config and data in one directory instead of the XDG locations.

## Files

| File | Where | Edited by |
|---|---|---|
| `config.toml` | `~/.config/pi-durable-t3/` | you. [`config.example.toml`](config.example.toml) lists every key |
| `settings.json` | `~/.local/share/pi-durable-t3/` | T3's settings panes (T3's own settings document) |
| `projects.json` | same | T3's Add project picker |

A missing file is valid. A file that doesn't parse stops the host with a message naming it. One host per
data dir.

## Security

The agent runs `bash` **as the host user, with no approvals**, in the project directories you add.

The bridge binds to loopback by default and rejects requests whose `Host` header is not loopback. Every call
needs a bearer token from pairing. Browsers may call only from T3's desktop app (`t3code://app`) and your
`web` origin.

**Over Tailscale:** set `listen` to the machine's tailnet IP (there is no TLS; the tailnet is the network
boundary). If you also serve the web app over the tailnet, point `web` at that URL. The desktop app works
without either.

## What works

Threads, prompts, steering, interrupts, per-thread model and thinking level, undo, crash resume, T3's
settings, and adding/removing projects. Forks and renames are next. Git, terminals, file panels and previews
are refused on purpose: the agent works in real repos with `bash`. Every call and its status:
[`docs/capabilities.md`](docs/capabilities.md).

## Tests

```sh
pnpm test        # no credentials, no network, never touches ~/.pi
pnpm typecheck
pnpm smoke       # the real web app in Chromium: pair/prompt/undo/thinking, crash resume, project add/remove
```

`PI_DURABLE_T3_LIVE_MODEL=<provider>/<model> pnpm test` also runs one real-model turn.

## License

MIT. The vendored T3 contracts are MIT (T3 Tools); see `LICENSE`.
