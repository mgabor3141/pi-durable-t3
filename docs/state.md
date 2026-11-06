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
| One record per thread (`pi-durable-t3.thread`): its head conversation, title, T3's creation fields (`createdBy`, `creationSource`), `lineage`, `forkedFrom`, `linkOrigin`, `delegatedFrom`, settlement, its last 50 applied undos, and its last 100 command receipts (T3's: a retried `commandId` gets the answer the command first got, across restarts) | The thread. T3 lists only threads created through T3; conversations started by other code on the same Harness are not listed |
| A deleted thread's record, with `deletedAt` | A deleted thread could come back: the record is the tombstone that keeps a late prompt to its head from promoting it |
| One sidebar summary per thread (`pi-durable-t3.thread-summary`) | An unopened thread previews and sorts as new until it is opened |
| The directory (`pi-durable-t3.threads`): live thread ids in creation order, and every head ever by conversation id | Empty sidebar |
| The project registry (`pi-durable-t3.projects`): id, path, title per project. A thread's project is checked in the commit that writes the thread | Project names; threads keep their `cwd` |
| Scheduled tasks (`pi-durable-t3.scheduled-tasks`), as T3's schema encodes them: trigger, prompt, project/thread, model, provenance, run state (`nextRunAt`, last run, count). Read strictly at boot: a task this version cannot decode stops the host | The tasks; the threads they made stay |

Every document is checkpointed on every write, so each is one stored row. The hot write — a summary, at each prompt and
run boundary — touches only its thread's summary. The threads layer is the only writer of these documents and keeps them
in memory: one threads layer per Harness.

Each conversation's agent config (`pi.agent`: model, thinking level, `cwd`) is pi-durable's, set by the
client's choices and the integrator's extensions.

## The bridge, on disk

The bridge owns one directory — `attachT3`'s `stateDir` — and creates it if missing. Nothing in it is pointed at by
the Harness's storage: settings, pairings and attachment bytes.

| File | What | If lost |
|---|---|---|
| `t3-settings.json` (the state dir) | T3's server settings, stored as T3's server stores them | T3's defaults |
| `auth.json` (the state dir) | Environment id; hashed pairing links and device sessions (bearer or browser cookie), each with its scopes and client metadata; the key that signs attachment URLs | Every device re-pairs |
| `attachments/` (the state dir) | Image and file attachments, one file per attachment id | Past attachments stop rendering; the model's copy in pi-durable survives |
| The scratch dir (`scratchDir`, if set) | "No project" threads: one folder per thread | Nothing the bridge needs; threads keep their recorded `cwd` |

The JSON files are written atomically, mode 0600, and so are attachments. The scratch dir is agent work
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
  child conversation), so nothing about subagents is stored. The full scan runs at boot; afterwards one thread is scanned when its view names
  a child not yet discovered (a failed scan is retried on the next update), and a deleted thread's children are dropped at once.
- The thread list.
- The commands in flight, so a duplicate that arrives meanwhile joins the first.
- The pending title request per thread (T3's `titleRegeneration`): after a restart no thread shows one, and a reply
  from the integrator's `titleThread` hook that was in flight is never asked for again.
- Which scheduled tasks are running right now (a crash leaves them `running` on disk; the next boot records them failed).
- Pairing tickets, rate-limit buckets, and the live-socket count per client session (which drives a device's `connected` badge).

## Known gaps

- `durable.db` and its WAL files are created world-readable (0644). They contain every conversation.
