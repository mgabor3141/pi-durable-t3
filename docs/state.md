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
| The threads document: one pointer per thread to its head conversation | Empty sidebar; boot repair re-promotes conversations with outstanding work |
| Removed threads, in the same document | A deleted thread could come back |
| Applied undos, so a retried undo doesn't fork twice | A retried undo forks again |

The last two grow by one entry per removal or undo. The document is rewritten whole on every write, so this
costs no extra rows.

Each conversation's agent config (`pi.agent`: model, thinking level, `cwd`) is pi-durable's, set by the
client's choices and the integrator's extensions.

## The bridge, on disk

| File | What | If lost |
|---|---|---|
| `settings.json` | T3's server settings, stored as T3's server stores them | T3's defaults |
| `projects.json` | The project registry: id, path, title | Project names; threads keep their `cwd` |
| `auth.json` (state dir) | Environment id, hashed pairing codes and tokens | Every client re-pairs |

Written atomically, mode 0600. The bridge interprets nothing in `settings.json`. Its one deviation from T3's
defaults: when the file doesn't say otherwise, the `pi` provider is enabled and T3's other providers are off,
because this host serves only pi.

## In memory

All of it is safe to lose:
- Per-thread view caches and the undo overlay.
- The thread list.
- A bounded map of recent prompt command ids.
- Pairing tickets and rate-limit buckets.

## Known gaps

- `durable.db` and its WAL files are created world-readable (0644). They contain every conversation.
