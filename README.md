# pi-durable-t3

Use [T3 Code](https://github.com/pingdotgg/t3code) as the frontend for a
[pi-durable](https://github.com/earendil-works/pi) agent. Your agent shows up in T3's desktop or web app as
one more computer, with its projects, threads and models. Experimental. Unofficial; not affiliated with T3
Tools or Earendil.

https://github.com/user-attachments/assets/250218eb-9a15-4f99-aa00-cf3c1e75d38e

Turns are durable: kill the host mid-turn, start it again, and the turn finishes.

## Install

Installing from git builds the package on your machine (it fetches T3's web app, then bundles), so pnpm 10 needs
it allowlisted first, in your `pnpm-workspace.yaml` (or `package.json`'s `pnpm` field):

```yaml
onlyBuiltDependencies:
  - "@mgabor3141/pi-durable-t3"
```

```sh
pnpm add github:mgabor3141/pi-durable-t3 @earendil-works/chord @earendil-works/pi-ai @earendil-works/pi-durable
```

Append `#v<version>` to pin a release tag. npm builds git dependencies by default; npm 12 also needs
`--allow-git=root` (supported since npm 11.10).

The build on install needs the package's own devDependencies, so `pnpm install --prod` fails on a fresh git install
(`tsdown: command not found`). For a production image, install once without `--prod`, then run `pnpm install --prod`.
That reuses the built package from the store and drops the dev tools. Once published, `pnpm add
@mgabor3141/pi-durable-t3` needs neither.

The pi packages are `^1.4.0` peers. T3's web app (release **v0.1.1**) ships in the package, and the bridge serves
it. Node `>=22.19.0`. The public API is [listed below](#public-api); how to use it is
[here](#attach-it-to-your-own-agent). For a
whole agent to start from, copy the [example agent](examples/coding-agent/#use-it-as-a-template).

## Try it (contributors: from a checkout)

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
import { attachT3, mintPairingCode } from "@mgabor3141/pi-durable-t3";

const t3 = await attachT3(harness, {
	models,        // the models T3's picker lists
	stateDir,      // the bridge's own files: t3-settings.json, projects.json, auth.json
	webApp,        // optional: another built T3 web app folder to serve at `/` (default: the one in the package)
	scratchDir,    // optional: where "No project" threads run; omit to turn the feature off
	listen,        // optional: { host, port }, default 127.0.0.1:3774
	tailscaleServe, // optional: { port } — publish the host over Tailscale Serve (HTTPS on your tailnet); absent = off
	titleThread,   // optional: generate thread titles (below); absent = the first message seeds the title, no regenerate
	// optional: label, corsOrigins, tokenTtlSeconds, log
});
await t3.setTitle(threadId, "Release notes");   // a user rename: durable, cancels a pending generation
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
- Upgrading from pi 1.3: back up first. pi 1.4 migrates `durable.db` to schema v2 on first open, and 1.3 then
  refuses it (`Durable SQLite schema version 2 is newer than supported version 1`).
- Thread titles follow T3: the first message seeds the title, then the bridge asks your `titleThread` hook for a
  better one (once that message is committed, not after the reply) and again on "Regenerate title". You get the
  thread's head, the entry to title from, and a signal that aborts when a rename or newer request supersedes you (or the host closes); a
  late answer is ignored. Return `undefined` (or "New thread") to keep the title. The hook owns its timeout: until it
  settles, the thread shows "Regenerating…". The example's hook is
  [`examples/coding-agent/src/title.ts`](examples/coding-agent/src/title.ts): one tool-less completion on the
  thread's model, over the conversation's text trimmed to T3's budget.

  ```ts
  titleThread: async ({ conversationId, at, reason, previousTitle, signal }) => {
  	const conversation = await harness.conversation(conversationId, ctx);
  	const { messages } = await conversation!.context(ctx, { at });   // not a fork: no tools, nothing runs
  	// Text only (tool calls and results would need tools declared), within a budget, as one user message.
  	const prompt = `${titleContext(messages)}\n\n${ask(reason, previousTitle)}`;
  	const reply = await models.completeSimple(model, { systemPrompt: "Title only, at most 6 words.", messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { signal });
  	return textOf(reply);
  },
  ```
- The bridge decides nothing about the agent: T3 picks the model and thinking level, the Harness says which
  models exist. Why, and the rest of the design: [`docs/design.md`](docs/design.md). Who owns which state:
  [`docs/state.md`](docs/state.md).

## Security

The bridge listens on loopback by default. Like T3, it checks no `Host` header: every call except the public
descriptor and pairing needs a credential from pairing — a bearer token, or the web app's same-origin session
cookie. Browsers on other origins may call only if listed in `corsOrigins` (default: T3's desktop app). What the agent may do is the Harness's business, not the bridge's.

With `tailscaleServe` set, the host first reads `tailscale serve status` and arms its HTTPS port only when it is
free (or already points at this host's own port): a port that maps elsewhere is refused with a warning, so the host
never replaces — and never removes — a mapping it did not create (deliberately stricter than T3, which arms
unconditionally). An armed port is released on shutdown.

## What works

Threads, "No project" threads, thread titles (rename, generated titles, "Regenerate title"), prompts, steering, interrupts, per-thread model and thinking level, undo,
crash resume, T3's settings (star, hide and reorder models in the picker), adding and removing projects, image attachments, thread search, the Usage page, scheduled tasks (interval and fixed time), subagents (a pi tool whose call owns a child
conversation shows as T3's subagent card with a read-only child thread; the example agent has one),
and Connections (pairing links, paired devices, revoking), plus reaching the host over Tailscale Serve
(`tailscaleServe`: HTTPS on the tailnet, the tailnet URL advertised to paired clients as the one `directEndpoint`,
and the tailnet name in the link `pair` prints). Git, terminals, file panels and previews are
refused on purpose: the agent works in real folders with `bash`. Every call and its status:
[`docs/capabilities.md`](docs/capabilities.md).

Known limitations:
- T3 shows only threads created through T3, not conversations started by other code on the same Harness.
- In T3's desktop app the agent is a second computer: its first-run wizard lists only Codex and Claude, and
  Settings → Connections shows the desktop's own machine. Use the web app the host serves for those, or `pair`.
- T3 shows "Server update available" when the app is newer than the pinned T3 version. Dismissing it is safe.
- A page left open across a host restart can land on the browser's "site can't be reached" screen: T3's app reloads
  itself once when a lazily loaded chunk fails to fetch, and during the restart there is nothing to reload into. Reload
  the page — the thread and its messages come back exactly as they were, including one holding a message the host was
  sent just before it died.
- Attachments are images only. Deleting a thread leaves its images in `stateDir/attachments/`.
- Usage counts each thread's current history: tokens spent on turns later undone drop out. Cost is what pi
  reports (no rate table), so cache savings show $0.00 and a free model shows "Unpriced".
- A task parked by pi's crash-loop guard (after 5 crashes without progress) keeps its thread "running"; Stop clears it.
- Settings `compactIdleThreads` ("Compact idle Claude threads"), `autoResumeLimitedThreads`,
  `snoozeLimitedThreads` and `easDeviceHosts` are stored but act on nothing here.
- Search has no index: each query reads every thread.
- Subagents: a child thread is read-only and cannot be stopped on its own (interrupt the parent, which stops it). Undoing past
  the call hides its card but leaves the child thread reachable, and a child's tokens are not in the Usage page. A fork that keeps the call lists the child under both threads, a subagent of a
  subagent is not discovered, and a failed subagent's reason is only the tool's error text.
- Scheduled tasks: webhook triggers are refused (the form still offers them). Worktree workspaces are refused
  (T3's form defaults to one; pick "Use the project checkout").
- Behind Serve every request arrives from 127.0.0.1, so the pairing rate limiter's buckets are shared across the
  tailnet — it fails closed: a legitimate user on a busy tailnet can be told to wait a minute, and one tailnet peer
  can lock out local pairing for that minute.
- A page that rebinds a hostname to the port gets no credentials, but can read the public descriptor and spend the
  pairing rate limit.
- `tailscale serve` config lives in Tailscale, not in this host. A host that is SIGKILLed leaves its mapping behind;
  a graceful stop removes it. Clear a stale one with `tailscale serve --https=<port> off`.

## Tests

```sh
pnpm test        # no credentials, no network, never touches ~/.pi
pnpm typecheck
pnpm smoke       # T3's web app in Chromium: pairing, prompts, undo, crash resume, projects, Connections
FACET_PORT=5070 dev/pack-proof.sh   # the packed tarball and a git install, each outside the repo, in a browser
```

`PI_DURABLE_T3_LIVE_MODEL=<provider>/<model> pnpm test` also runs one real-model turn.

Releasing (bumping T3 or pi, versions, the npm release on a `v*` tag): [`.agents/skills/bump-pins`](.agents/skills/bump-pins/SKILL.md).

## Public API

`"."` is the only entry point.

- `attachT3(harness, options): Promise<T3Attachment>` and the `AttachT3Options` type (options are documented in the
  type's comments).
- `T3Attachment`: `closed`, `close()`, `setTitle(threadId, title)`.
- `mintPairingCode(stateDir): { code }`: a single-use pairing code, no server needed.
- `ConfigError`, `Logger`, `TitleThread`, `TitleThreadRequest`, `DESKTOP_APP_ORIGIN`.

T3's `@t3tools/contracts` (not on npm) is bundled into `dist/`. `effect` and `@effect/platform-node` stay external,
exact dependencies, so the bridge and the bundled contracts share one Effect: do not override `effect`.

## License

MIT, see `LICENSE`. T3 Code is MIT (T3 Tools Inc.): the package bundles T3's contracts, replicates parts of its
server, and ships T3's built web app unmodified (`web/`); the notice is `THIRD_PARTY_LICENSES`. `pnpm setup:t3`
fetches both (it is part of `prepare`, so `pnpm install` in a checkout does it).
