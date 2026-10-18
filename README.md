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
pnpm setup:t3     # fetch T3 at the pinned version: its contracts and its web app
pnpm start        # an example coding agent on 127.0.0.1:3774, serving T3's web app
pnpm start pair   # a single-use pairing link
```

Open the link in a browser: it signs the browser in and opens T3 with the agent as "This machine". To use T3's
desktop app instead, add a computer there and paste the same link.

The agent is [`examples/coding-agent/`](examples/coding-agent/): pi-durable's coding-agent recipe with the
bridge attached. Its README covers config, files and Tailscale. **It runs `bash` as your user, with no
approvals.**

## Attach it to your own agent

The bridge is a library. You build the pi-durable Harness (storage, tools, extensions, models); the bridge
serves T3's wire over it.

```ts
import { attachT3, mintPairingCode } from "./src/bridge.ts";

const t3 = await attachT3(harness, {
	models,        // the models T3's picker lists
	stateDir,      // the bridge's own files: t3-settings.json, projects.json, auth.json
	webApp,        // optional: a built T3 web app folder to serve at `/`
	scratchDir,    // optional: where "No project" threads run; omit to turn the feature off
	listen,        // optional: { host, port }, default 127.0.0.1:3774
	tailscaleServe, // optional: { port } — publish the host over Tailscale Serve (HTTPS on your tailnet); absent = off
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

The bridge listens on loopback by default and then rejects requests whose `Host` header isn't loopback. Every
call needs a credential from pairing: a bearer token, or, for the web app the host serves, T3's browser
session cookie, which counts only on same-origin requests. Browsers on other origins may call only if listed
in `corsOrigins` (default: T3's desktop app). What the agent may do is the Harness's business, not the bridge's.

With `tailscaleServe` set, the host arms `tailscale serve` for its own port and releases it on shutdown, and the
`Host` rule admits the machine's `*.ts.net` name — Serve forwards to loopback carrying that `Host`, and a
`.ts.net` name resolves only inside your tailnet. No Tailscale, no change: nothing runs, nothing is admitted.

## What works

Threads, "No project" threads, prompts, steering, interrupts, per-thread model and thinking level, undo,
crash resume, T3's settings, adding and removing projects, image attachments, thread search, the Usage page,
and Connections (pairing links, paired devices, revoking), plus reaching the host over Tailscale Serve
(`tailscaleServe`: HTTPS on the tailnet, and the tailnet name in the link `pair` prints). Git, terminals, file panels and previews are
refused on purpose: the agent works in real folders with `bash`. Every call and its status:
[`docs/capabilities.md`](docs/capabilities.md).

Known limitations:
- T3 shows only threads created through T3, not conversations started by other code on the same Harness.
- In T3's desktop app the agent is a second computer: its first-run wizard lists only Codex and Claude, and
  Settings → Connections shows the desktop's own machine. Use the web app the host serves for those, or `pair`.
- T3 shows "Server update available" when the app is newer than the pinned T3 version. Dismissing it is safe.
- Attachments are images only. Deleting a thread leaves its images in `stateDir/attachments/`.
- Usage counts each thread's current history: tokens spent on turns later undone drop out. Cost is what pi
  reports (no rate table), so cache savings show $0.00 and a free model shows "Unpriced".
- Search has no index: each query reads every thread.
- Behind Serve every request arrives from 127.0.0.1, so the pairing rate limiter's buckets are shared across the
  tailnet — it fails closed, and a legitimate user on a busy tailnet can be told to wait a minute.
- `tailscale serve` config lives in Tailscale, not in this host. A host that is SIGKILLed leaves its mapping behind;
  a graceful stop removes it. Clear a stale one with `tailscale serve --https=<port> off`.

## Tests

```sh
pnpm test        # no credentials, no network, never touches ~/.pi
pnpm typecheck
pnpm smoke       # T3's web app in Chromium: pairing, prompts, undo, crash resume, projects, Connections
```

`PI_DURABLE_T3_LIVE_MODEL=<provider>/<model> pnpm test` also runs one real-model turn.

## License

MIT, see `LICENSE`. `pnpm setup:t3` fetches T3 Code's contracts and web app, which are MIT (T3 Tools Inc.).
