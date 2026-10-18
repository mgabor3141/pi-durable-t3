# pi-durable-t3

Use [T3 Code](https://github.com/pingdotgg/t3code) as the frontend for a
[pi-durable](https://github.com/earendil-works/pi) agent. Your agent shows up in T3's desktop or web app as
one more computer, with its projects, threads and models. Experimental. Unofficial; not affiliated with T3
Tools or Earendil.

https://github.com/user-attachments/assets/250218eb-9a15-4f99-aa00-cf3c1e75d38e

Turns are durable: kill the host mid-turn, start it again, and the turn finishes.

## Try it

```sh
pnpm install
pnpm setup:t3     # fetch T3 at the pinned commit, vendor its contracts, download its web app
pnpm start        # an example coding agent; it serves T3's web app on 127.0.0.1:3774
pnpm start pair   # a pairing link — open it in a browser to pair this machine
```

Open the pairing link the last command prints (`http://127.0.0.1:3774/pair#token=…`) in a browser: the page
pairs the browser and lands you in the app, where this machine (the agent) is the primary environment. You
can also paste the same link into T3's desktop app to add this machine as a second computer there. The agent
is [`examples/coding-agent/`](examples/coding-agent/): pi-durable's coding-agent recipe with the bridge
attached. Its README covers the web app, config, files and Tailscale. **It runs `bash` as your user, with no
approvals.**

## Attach it to your own agent

The bridge is a library. You build the pi-durable Harness (storage, tools, extensions, models); the bridge
serves T3's wire over it.

```ts
import { attachT3, mintPairingCode } from "./src/bridge.ts";

const t3 = await attachT3(harness, {
	models,        // the models T3's picker lists
	stateDir,      // the bridge's own files: t3-settings.json, projects.json, auth.json
	webApp,        // optional: a built T3 web app to serve at `/`; omit to serve none (desktop + API only)
	scratchDir,    // optional: where "No project" threads run; omit to turn the feature off
	listen,        // optional: { host, port }, default 127.0.0.1:3774
	// optional: label, corsOrigins, tokenTtlSeconds, log
});
harness.resume();                            // yours to call, after attaching
const { code } = mintPairingCode(stateDir);  // from anywhere, e.g. a CLI; the running host accepts it
await t3.closed;                             // the server stopped on its own
await t3.close();
```

- `attachT3` resolves once it is listening and rejects if it can't bind.
- It throws `ConfigError`, naming the file, if a file in `stateDir` doesn't parse.
- The bridge reads no config file of its own; the example maps its `config.toml` onto these options.
- `stateDir` belongs to the bridge, one host per directory. It pairs with the Harness's storage (threads
  point at its project ids), so back up and move the two together.
- The bridge decides nothing about the agent: T3 picks the model and thinking level, the Harness says which
  models exist. Why, and the rest of the design: [`docs/design.md`](docs/design.md). Who owns which state:
  [`docs/state.md`](docs/state.md).

## Security

The bridge listens on loopback by default and then rejects requests whose `Host` header isn't loopback.
Every API/WS call needs a bearer token from pairing. When `webApp` is set, the host also serves the web app,
and a browser on the host's own origin authenticates entirely by a same-origin session cookie (set by the
`/pair` page, exchanged from a pairing code; the cookie is bound to the pairing scope, and a same-origin
guard blocks cross-site request forgery). Browsers may call the API cross-origin only from T3's desktop app
and any origins in `corsOrigins`. What the agent may do is the Harness's business, not the bridge's.

## What works

Threads, "No project" threads, prompts, steering, interrupts, per-thread model and thinking level, undo,
crash resume, T3's settings, adding and removing projects, image attachments, thread search, the Usage page, and
T3's Connections settings (pairing links, paired devices, revoking). The host can serve T3's web app from its
own origin, so the agent is the app's **primary environment** ("This machine") and Connections works in the
browser. Git, terminals, file panels and previews are refused on purpose: the agent works in real folders with
`bash`. Every call and its status: [`docs/capabilities.md`](docs/capabilities.md).

Known limitations:
- T3 shows only threads created through T3, not conversations started by other code on the same Harness.
- T3's first-run wizard lists only Codex and Claude as agents; pi appears once the computer is added.
- T3 shows "Server update available" when the app is newer than the pinned T3 version. Dismissing it is safe.
- Attachments are images only. Deleting a thread leaves its images in `stateDir/attachments/`.
- Usage counts each thread's current history: tokens spent on turns later undone drop out. Cost is what pi
  reports (no rate table), so cache savings show $0.00 and a free model shows "Unpriced".
- Search has no index: each query reads every thread.

## Tests

```sh
pnpm test        # no credentials, no network, never touches ~/.pi
pnpm typecheck
pnpm smoke       # the real web app, served by the host, in Chromium: pairing, prompts, undo, crash resume, projects, Connections
```

`PI_DURABLE_T3_LIVE_MODEL=<provider>/<model> pnpm test` also runs one real-model turn.

## License

MIT. The vendored T3 contracts are MIT (T3 Tools); see `LICENSE`.
