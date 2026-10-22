# State

Everything the host knows, by owner. The rule is in [design.md](design.md): the bridge keeps no copy of
anything pi-durable can answer.

## T3's client

Thread, message and command ids are minted in the browser. The bridge stores none of them separately: a
message id rides inside the entry the prompt is stored as.

## pi-durable

Conversations: entries, submissions, runs, queued input. This is the truth, and the bridge keeps no copy.
Projections are rebuilt from it on every change.

## The bridge, inside pi-durable

| What | If lost |
|---|---|
| The threads document: one pointer per thread to its head conversation, and its title | Empty sidebar. T3 lists only threads created through T3; conversations started by other code on the same Harness are not listed |
| Removed threads, in the same document | A deleted thread could come back |
| Applied undos, so a retried undo doesn't fork twice | A retried undo forks again |

The last two grow by one entry per removal or undo. The document is rewritten whole on every write, so this
costs no extra rows.

Each conversation's agent config (`pi.agent`: model, thinking level, `cwd`) is pi-durable's, set by the
client's choices and the integrator's extensions.

## The bridge, on disk

The bridge owns one directory — `attachT3`'s `stateDir` — and creates it if missing. It PAIRS with pi-durable's
storage: the Harness's threads point at project ids in this directory's `projects.json`. Back up and move
the two together; a mismatched pair shows an empty sidebar, and nothing repairs the combination.

| File | What | If lost |
|---|---|---|
| `t3-settings.json` (the state dir) | T3's server settings, stored as T3's server stores them | T3's defaults |
| `projects.json` (the state dir) | The project registry: id, path, title | Project names; threads keep their `cwd` |
| `auth.json` (the state dir) | Environment id; hashed pairing links and device sessions (bearer or browser cookie), each with its scopes and client metadata; the key that signs attachment URLs | Every device re-pairs |
| `scheduled-tasks.json` (the state dir) | Scheduled tasks as T3 stores them: trigger, prompt, project/thread, model, run state (`nextRunAt`, last run, count) | The tasks; the threads they made stay |
| `attachments/` (the state dir) | Image attachments, one file per attachment id | Past images stop rendering; the model's copy in pi-durable survives |
| The scratch dir (`scratchDir`, if set) | "No project" threads: one folder per thread | Nothing the bridge needs; threads keep their recorded `cwd` |

The JSON files are written atomically, mode 0600, and so are attachments. `scheduled-tasks.json` is read strictly: one the host cannot read stops it at boot, naming the file. The scratch dir is agent work
output, not bridge state. The bridge interprets nothing in `t3-settings.json`. Its one deviation from T3's
defaults: when the file doesn't say otherwise, the `pi` provider is enabled and T3's other providers are off,
because this host serves only pi.

## Not the bridge's: Tailscale Serve

With `tailscaleServe`, the mapping (`--https=<port>` → `http://127.0.0.1:<bound port>`) is Tailscale's config, not
this host's: it survives a crash, and the bridge owns no file for it. The host arms it after the listener is up and
releases it on a graceful stop, so a SIGKILLed host leaves a mapping pointing at a dead port
(`tailscale serve --https=<port> off` clears it).

## In memory

All of it is safe to lose:
- Per-thread view caches and the undo overlay.
- The subagent list: rediscovered from conversation ownership (a child thread's id is derived from its parent thread and
  child conversation), so nothing about subagents is stored.
- The thread list.
- A bounded map of recent prompt command ids.
- The pending title request per thread (T3's `titleRegeneration`): after a restart no thread shows one, and a reply
  from the integrator's `titleThread` hook that was in flight is never asked for again.
- Which scheduled tasks are running right now (a crash leaves them `running` on disk; the next boot records them failed).
- Pairing tickets, rate-limit buckets, and the live-socket count per client session (which drives a device's `connected` badge).

## Known gaps

- `durable.db` and its WAL files are created world-readable (0644). They contain every conversation.
