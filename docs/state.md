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
| `settings.json` (the instance file): the project registry and the new-thread model/thinking defaults, in the data dir | until the UI edits it (the running host writes it: a delta on the document on disk, under a cross-process lock, to a unique temp file, `chmod`ed before the rename) | an empty registry and the first available model — a missing file is valid |
| the environment | one run | defaults apply |

`config.toml` is written by nobody at runtime. The instance file is **host-owned state shaped as input**: the
running host rewrites it when the UI adds a project or changes the default model. The write is atomic (a unique temp
file, `chmod`ed and fsynced, then renamed) so a crash never leaves a half-written registry, and it is a
**read-modify-write under a lock file** so a peer process's edit is in the document the writer starts from: two hosts
on one data dir is the documented dev setup, and a writer that rewrote the whole file from the copy it loaded at boot
deleted the peer's title edit, its thinking level, its default model, without a trace. A document that the boot parser
would refuse is never written over a good one — the keys it enforces (the path, the id) are enforced at mutation
time, typed, before the write; and a mutation run against a document the parser fatal-refuses (not JSON, a document-level
shape) is REFUSED naming the file and leaves it byte-identical — over a file the host cannot read it serves an empty
registry and mutates nothing, so the empty registry is never written over the entries the broken file holds. A thread
never reaches it. A project's id is stored when it was assigned: the client
minted it (T3's UI sends a UUID and navigates to it — the host must answer with the same id after a restart), or
the first mutation of a client-less registration pinned the id derived from the registration path (an id is assigned
once and never re-derived, so a move cannot mint a new one). An entry that has never been mutated stores no id and
derives it at read from the normalized path, so nothing has to remember it. The path is the uniqueness key in both
cases, and the id is a guarded key: a mint for an id that is already taken is refused.

## The bridge owns, in memory — all of it correct to lose

| what | lifetime | if it's lost |
|---|---|---|
| the per-thread view cache, its subscribers, and the undo overlay | while a client is watching | clients re-subscribe and get a fresh snapshot |
| the thread list, shells | process | rebuilt at start |
| the live project registry (the instance file's projects; ids stored when client-minted, else derived from each normalized path) | process, kept in sync with `settings.json` by a subscription | reread from the instance file at the next projection: a minted id is stored, a derived id is a function of the folder's path, so T3's selection for it survives |
| command id → the first result, so a retry returns it | process | the retry recomputes; durable dedup still stops the second write |
| project mutation receipts: command id → the project it produced, the deletion it made, or the refusal it was refused with, so a retry after a lost response is not planned again | process, bounded (the same bound as the command-id map: a receipt key is a client-chosen id, and the bound is the only memory a client can make the host spend on ids) | an old retry is treated as a fresh request: a create then answers the duplicate-path refusal, a delete the not-found — the answers a fresh request gets, never a corrupted one |
| the projection sequence clock | process | projections get new sequence numbers |
| pairing tickets and rate-limit buckets (the bucket key is the connection's peer address — a header a client writes cannot buy a fresh bucket) | seconds | the code is redeemed again; the window restarts |

## Gaps

Three review rounds' findings are closed on this tip: the boot is tolerant to every hand-edit shape (a bad entry is
skipped with a warning, a file that is not JSON is served as an empty registry and read-only), a mutation against an
unreadable file is refused and never rewrites it, a catalog-absent default warns and drops at boot, only successful
results become receipts, a
rename/move of a boot-loaded project emits a shell item, and a stored id is normalized on read. Two that were here
(stored design, not defects) are settled:

- **The client's message id** rides in the entry the host places the prompt as (an `app.user` entry's data), and its
  store is deleted.
- **Project identity is settled**: the id is minted by whoever registers the project — any id the contract's
  `ProjectId` accepts is honored (trimmed, and a hand-edited stored id is normalized on read, so the id shown is the
  id that names it: the UI's UUID, or a client-less registration's `p-<first 16 hex of sha256(normalized path)>`)
  — and the normalized path is the uniqueness key. An id is assigned once and never re-derived: the first
  mutation pins a derived id, so a rename is free, a root move keeps the id, and the project's threads follow.

**Open (LOW / documented — none breaks a promise the docs make):**

- **Durable storage is world-readable** (N4): `durable.db`/`-wal`/`-shm` land 0644 (every conversation, prompt, the
  removal record) while `t3-auth/auth.json` is 0600 and its dir 0700; a hand-created `settings.json` keeps 0644 until
  the host's first write (only `writeJsonAtomic` chmods). The fix is a chmod on the SQLite side files at open — the
  SQLite layer owns their creation, so it is not a one-liner here.
- **The cross-process lock's stale-steal** (D-1 / M6 / M7): a writer frozen inside the critical section past the
  staleness window loses its update silently (both writers report success), its `finally` unlinks the stealer's lock,
  and a lock left by a killed writer is reclaimed only after the full 10 s window. The coherent fix (a lock epoch, an
  ownership-checked unlink, a liveness-based immediate reclaim, a fail-loudly write) is safety-critical and >30 lines —
  written up in `.memory/night-log.md`.
- **A host that booted tolerantly over a hand-edited file with a duplicate id/path** is read-only for writes that keep
  the duplicate; a delete of the duplicate group heals it (the recoverable path this tip adds). "Service every write"
  (apply the delta to the tolerantly-resolved document, normalizing the file on write) is >30 lines and changes the
  disk-text form — written up in `.memory/night-log.md`.

What is left is a transcript we do not own, one document of pointers, a credential file, and caches that are correct
to lose.
