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
| the removal record in that document: one id (the removed thread's head conversation) per removal — truth, not a cache: it is what makes "a deleted thread stays deleted" survive a restart | forever, append-only (one number per removal) | a prompt admitted before a delete could resurrect the thread at the next promote or boot repair |
| applied undos, remembered so a retry does not fork twice | forever, append-only | a retried undo forks again |
| `pi.agent` per thread: model, thinking level, working directory, instructions | with the thread; forks and undos inherit it | the thread falls back to the configured defaults |

Applied undos and the removal record are the fields we write that grow with use (one entry per undo / per removal).
The document checkpoints on every write, so growth costs rows in one base write, never a delta per mutation.

## The bridge owns, on disk

| what | lifetime | if it's lost | kind |
|---|---|---|---|
| `auth.json`: the environment id, and hashes of pairing codes and tokens | forever | every client re-pairs; no conversation is affected | credential |
| `models-store.json`: the model catalog, owned by ModelRuntime | rewritten at will | re-fetched from the providers; without a path under the root it lands in the working directory | derived |

## Configuration, input only

Two files, two tiers. `config.toml` is the integrator's (a UI must not set it); `settings.json` — the
instance file, in the data dir — is the UI's, and the running host writes it on the UI's behalf. Both are
*input*, never the record of what happened.

| what | lifetime | if it's lost |
|---|---|---|
| `config.toml`: listen address, web origin, the facet's `[t3]` settings, per-thread `instructions` | until the integrator edits it | the host refuses to start |
| `settings.json` (the instance file): the project registry and the new-thread model/thinking defaults, in the data dir | until the UI edits it (the running host writes it atomically) | an empty registry and the first available model — a missing file is valid |
| the environment | one run | defaults apply |

`config.toml` is written by nobody at runtime. The instance file is **host-owned state shaped as input**: the
running host rewrites it when the UI adds a project or changes the default model, atomically (temp → rename),
so a crash never leaves a half-written registry. A thread never reaches it. A project's id is stored only when
the client minted it (T3's UI sends a UUID and navigates to it — the host must answer with the same id after a
restart); an entry without one derives its id from the normalized path, so nothing is stored and nothing has to
remember it. The path is the uniqueness key in both cases.

## The bridge owns, in memory — all of it correct to lose

| what | lifetime | if it's lost |
|---|---|---|
| the per-thread view cache, its subscribers, and the undo overlay | while a client is watching | clients re-subscribe and get a fresh snapshot |
| the thread list, shells | process | rebuilt at start |
| the live project registry (the instance file's projects; ids stored when client-minted, else derived from each normalized path) | process, kept in sync with `settings.json` by a subscription | reread from the instance file at the next projection: a minted id is stored, a derived id is a function of the folder's path, so T3's selection for it survives |
| command id → the first result, so a retry returns it | process | the retry recomputes; durable dedup still stops the second write |
| the projection sequence clock | process | projections get new sequence numbers |
| pairing tickets and rate-limit buckets | seconds | the code is redeemed again; the window restarts |

## Gaps

None. The two that were here are closed.

- **The client's message id** rides in the entry the host places the prompt as (an `app.user` entry's data), and its
  store is deleted.
- **Project identity is settled**: the id is minted by whoever registers the project (the UI's UUID is honored
  and stored; a client-less registration derives `p-<sha256(normalized path)>`), and the normalized path is the
  uniqueness key. A rename is free; a root move keeps the id, and the project's threads follow.

What is left is a transcript we do not own, one document of pointers, a credential file, and caches that are correct
to lose.
