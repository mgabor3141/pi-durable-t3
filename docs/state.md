# State

What this host knows, grouped by who owns it. Every piece is one of four kinds, and they serve one rule,
stated in [design.md](design.md): the bridge duplicates no state and owns as little as it can.

- **truth** — the record of what happened. Everything else is rebuilt from it.
- **derived** — a cache. Correct to lose, wasteful to keep.
- **credential** — a secret only this host may hold.
- **duplicative** — a second copy of a fact durable storage could answer. Every one is a bug report.

## The T3 client owns

| what | lifetime | if it's lost |
|---|---|---|
| thread, message, command and request ids, minted in the browser | one send, one retry | nothing: they arrive in requests we answer, and we mint nothing in T3's space |

Every client fact reaches durable storage. The id the client chose for a user message rides in the entry the host
places the prompt as (an `app.user` entry carrying it), so the projection reads the id back from the entry it is already
reading — no side store.

## pi-durable owns

| what | lifetime | if it's lost |
|---|---|---|
| the conversation: entries, submissions and their dedup keys, runs, documents | forever | nothing recovers it |
| queued sends | settle with the run | an accepted message is not shown until it starts |
| leases, checkpoints, cursors | internal | pi-durable's concern, not ours |

We read all of it and keep no copy. The projection is rebuilt from the view on every emit.

## The bridge owns, inside pi-durable

| what | lifetime | if it's lost |
|---|---|---|
| the threads document: one row per thread, pointing at the conversation that is its head | forever | an empty sidebar; conversations are intact and boot repair promotes the heads |
| the removal record in that document: one id (the removed thread's head conversation) per removal — truth, not a cache: it is what makes "a deleted thread stays deleted" survive a restart; the promote path, the undo fork, and boot repair all read it | forever, append-only (one number per removal) | a prompt admitted before a delete could resurrect the thread at the next promote, undo, or boot repair |
| applied undos, remembered so a retry does not fork twice | forever, append-only | a retried undo forks again |
| `pi.agent` per thread: model, thinking level, working directory, instructions | with the thread; forks and undos inherit it | a new thread starts at its project's `cwd`; the client names the model and level, the integrator's extensions carry the rest |

Applied undos and the removal record are the fields we write that grow with use (one entry per undo / per removal).
The document checkpoints on every write, so growth costs rows in one base write, never a delta per mutation.

## The bridge owns, on disk

| what | lifetime | if it's lost | kind |
|---|---|---|---|
| `auth.json` (in the facet's state dir): the environment id, and hashes of pairing codes and tokens | forever | every client re-pairs; no conversation is affected | credential |
| `projects.json` (in the data dir): the project registry — id, path, title per project | until the UI edits it | an empty registry; conversations keep the `cwd` their own records — names, not work | input, host-written |
| `models-store.json`: the model catalog, owned by ModelRuntime (the example's file) | rewritten at will | re-fetched from the providers | derived |

## The UI owns, through the host

`settings.json`, in the data dir, is **T3's server settings document** — the contracts' `ServerSettings`,
stored the way T3's server stores it: a SPARSE JSON document that decodes over the schema's defaults (what
the defaults would not produce is what the file holds). `server.updateSettings` applies T3's patch merge
(nested keys merge, `undefined` keys skipped, everything else replaced), validates the merged document with
the same decode the next boot performs, persists atomically, answers the FULL settings, and emits
`settingsUpdated` on the config stream. `providerInstanceMutation` mutates the instance map (upsert/create
set, delete removes). The bridge interprets nothing in it — a value the UI wrote is answered back as written.
The deviation from the contract's defaults is one sentence about this host: **it serves one provider, pi.** A
document that does not name its `providerInstances` serves the `pi` instance enabled (the picker follows the
instance map: without it the web app shows "no provider" and sends no `launchThread` — probe-verified), and a
document that does not name a driver's legacy `providers.<driver>.enabled` is answered `false` for every driver
except `pi` (the contract enables them all, and T3's provider pane lists its driver catalogue from that map, so
an untouched document shows Codex and Claude as live providers with an editor for a CLI this host does not run;
answered `false`, the rows read `Disabled`). Both answers vanish the moment the document names the key — a UI
write owns it.

Missing is valid (the contract defaults); unparseable is a fatal `ConfigError` naming the file — the host
does not boot over the UI's document, and does not write over a document it cannot read (a mutation against a
document the parser refuses is refused, byte-identical). Every write goes to a unique temp file (`wx`),
`chmod`ed 0600 and fsynced, then renamed.

The same rules read/write apply to `projects.json` (strict parser, the parser is the definition of writable:
uniqueness of normalized paths and ids is enforced at mutation time, typed, before the write). A project's id
is stored when it was assigned: the client minted it, or the first mutation of a client-less registration
pinned the id derived from the normalized path — an id is assigned once and never re-derived, so a move
cannot mint a new one. The path is the uniqueness key.

Both files live in the data dir beside `durable.db`. **One host per data dir:** there is no cross-process
lock and no merge-on-write protocol; the writer is a plain in-process read-modify-write. Two hosts on one
data dir is not a supported setup.

`config.toml` (the integrator's tier: listen, web origin, `[t3]`, the instructions file — the example's) is
written by nobody at runtime.

## The bridge owns, in memory — all of it correct to lose

| what | lifetime | if it's lost |
|---|---|---|
| the per-thread view cache, its subscribers, and the undo overlay | while a client is watching | clients re-subscribe and get a fresh snapshot |
| the thread list, shells | process | rebuilt at start |
| the live project registry (the file's projects; ids stored when client-minted, else derived from each normalized path) | process, kept in sync with `projects.json` by subscription | reread at the next boot: a minted id is stored, a derived id is a function of the folder's path |
| command id → the first result, so a retried prompt command is not run twice | process, bounded (a command id is a client-chosen id, and the bound is the only memory a client can make the host spend on ids) | an old retry is treated as a fresh request; durable dedup still stops the second write |
| the projection sequence clock | process | projections get new sequence numbers |
| pairing tickets and rate-limit buckets (the bucket key is the connection's peer address — a header a client writes cannot buy a fresh bucket) | seconds | the code is redeemed again; the window restarts |

Project mutations have NO receipt store: a retried `projects.mutate` re-plans against current state and gets
the honest answer (the duplicate-path refusal, the not-found) — see [design.md](design.md), Invariants.

## Gaps

- **Durable storage is world-readable** (N4): `durable.db`/`-wal`/`-shm` land 0644 (every conversation,
  prompt, the removal record) while `auth.json` is 0600 in a 0700 dir, and the host's own writes to
  `settings.json`/`projects.json` are 0600. The fix is a chmod on the SQLite side files at open — the SQLite
  layer owns their creation, so it is not a one-liner here.
- **Provider instance defaults** are one deviation from T3's contract defaults (the `pi` entry, documented
  above); the browser smoke exercises the picker with it.

What is left is a transcript we do not own, one document of pointers, two small files, a credential file, and
caches that are correct to lose.
