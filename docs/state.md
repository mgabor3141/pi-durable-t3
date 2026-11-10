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
| One record per thread (`pi-durable-t3.thread`): its head conversation, title, T3's creation fields (`createdBy`, `creationSource`), `lineage`, `forkedFrom`, `linkOrigin`, `delegatedFrom`, settlement, T3's sidebar state (pin and its place, dragged place, read watermark, opens, auto-settle switched off, archive, snooze), its last 50 applied undos (each the head it moved to and the head it left, from which the rolled-back runs are read), and the last rollback's outcome | The thread. T3 lists only threads created through T3; conversations started by other code on the same Harness are not listed |
| A deleted thread's record, with `deletedAt` | A deleted thread could come back: the record is the tombstone that keeps a late prompt to its head from promoting it |
| One sidebar summary per thread (`pi-durable-t3.thread-summary`): its latest visible message, latest user message and latest settled run, so a closed thread shows as an open one does | An unopened thread previews and sorts as new until it is opened. A summary written before runs were kept has none until the thread next runs or is opened |
| Command receipts (`pi-durable-t3.command-receipts`): the last 1,000 commands the host accepted and the sequence each was answered with (T3's `CommandReceiptStore`: a retried `commandId` gets the first answer, across restarts). A prompt's command id is also its pi-durable request id, so a resent prompt is sent once whatever path it comes by | A retried command runs again |
| The directory (`pi-durable-t3.threads`): live thread ids in creation order, and every head ever by conversation id | Empty sidebar |
| The project registry (`pi-durable-t3.projects`): id, path, title per project. A thread's project is checked in the commit that writes the thread | Project names; threads keep their `cwd` |
| Scheduled tasks (`pi-durable-t3.scheduled-tasks`), as T3's schema encodes them: trigger, prompt, project/thread, model, provenance, run state (`nextRunAt`, last run, count). Read strictly at boot: a task this version cannot decode stops the host | The tasks; the threads they made stay |

Every document is checkpointed on every write, so each is one stored row. The hot write — a summary, at each prompt, run boundary
and change of the latest run — touches only its thread's summary. The threads layer is the only writer of these documents and keeps them
in memory: one threads layer per Harness.

Each conversation's agent config (`pi.agent`: model, thinking level, `cwd`) is pi-durable's, set by the
client's choices and the integrator's extensions.

## The bridge, on disk

The bridge owns one directory — `attachT3`'s `stateDir` — and creates it if missing. Nothing in it is pointed at by
the Harness's storage: settings, pairings and uploads not yet sent.

| File | What | If lost |
|---|---|---|
| `t3-settings.json` (the state dir) | T3's server settings, stored as T3's server stores them | T3's defaults |
| `auth.json` (the state dir) | Environment id; hashed pairing links and device sessions (bearer or browser cookie), each with its scopes and client metadata; the key that signs attachment URLs | Every device re-pairs |
| `uploads/` (the state dir) | Attachments uploaded and not yet sent, one file per upload id; moved into `attachmentsDir` when their message is sent, removed after a week otherwise | Uploads in a composer must be added again |
| The scratch dir (`scratchDir`, if set) | "No project" threads: one folder per thread | Nothing the bridge needs; threads keep their recorded `cwd` |

The JSON files are written atomically, mode 0600, and so are uploads; a symlinked file is written through its
link, which stays. The scratch dir is agent work output, not bridge state. Like T3, a settings save merges into the
file as it is on disk, so a hand edit made while the host runs is kept, and a file that no longer parses is refused
(`read-file`) and left alone. Unlike T3, the file is not watched: clients see a hand edit at the next save or restart. The bridge interprets nothing in `t3-settings.json`. Its one deviation from T3's
defaults: when the file doesn't say otherwise, the `pi` provider is enabled and T3's other providers are off,
because this host serves only pi.

## The bridge, in the environment

| Path | What | If lost |
|---|---|---|
| `attachmentsDir` (`attachT3`'s option) | Every image and file sent in a thread, as `<id>.<ext>`: the agent reads them by the path its prompt names, and T3 shows them from here | Their messages show them as missing; an image the model took inline stays in its entry |

Sent attachments live where the agent works, since that is where it can open them (T3 keeps its store on the agent's
machine for the same reason). Nothing deletes them: the agent may tidy the folder, and T3 then shows those as missing.

## In memory

All of it is safe to lose:
- Per-thread view caches, including the rolled-back runs read from the heads the thread's undos left.
- Per open thread, the stream: the projection its subscribers were last brought to, its sequence, and the last 128
  events (what a resuming subscriber is replayed). The sequence is a clock-floored counter of this process, so after a
  restart every resume is answered with a snapshot.
- The thread list.
- The commands in flight, so a duplicate that arrives meanwhile joins the first.
- The pending title request per thread (T3's `titleRegeneration`): after a restart no thread shows one, and a reply
  from the integrator's `titleThread` hook that was in flight is never asked for again.
- Which scheduled tasks are running right now (a crash leaves them `running` on disk; the next boot records them failed).
- Pairing tickets, rate-limit buckets, and the live-socket count per client session (which drives a device's `connected` badge).

## Known gaps

- `durable.db` and its WAL files are created world-readable (0644). They contain every conversation.
