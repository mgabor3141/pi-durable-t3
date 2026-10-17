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
| The threads document: one pointer per thread to its head conversation | Empty sidebar. T3 lists only threads created through T3; conversations started by other code on the same Harness are not listed |
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
| `auth.json` (the state dir) | Environment id, hashed pairing links and hashed bearer tokens (client sessions), each with its id, grant, scopes and client metadata; and the HMAC key that signs attachment-upload/asset-access URLs | Every client re-pairs; minted links are lost; previously minted asset URLs stop verifying (re-minted on demand) |
| `attachments/` (the state dir) | Persisted image-attachment bytes, keyed by the deterministic attachment id (the display copy the `/api/assets/*` route serves) | A past thread's images no longer render (the message's attachment record — and the copy the model received — survive in pi-durable); new attachments are unaffected |
| The scratch dir (the integrator's `scratchDir`, if set) | T3's "No project" folder: one subfolder per thread launched without a project | Nothing — the folder is re-made by the next `projects.ensureScratch`, and every thread keeps the `cwd` its conversation recorded |

The JSON files are written atomically, mode 0600; the scratch dir is a plain directory, created on demand
— it is agent work output, not bridge state. The `attachments/` dir holds bytes the client uploaded (images),
mode 0600, written by `assets.persistChatAttachments`; the bridge keeps no index of them — an attachment id
decodes to its own filename, and the message's attachment record (in pi-durable) names the id. The bridge
interprets nothing in `t3-settings.json`. Its one deviation
from T3's defaults: when the file doesn't say otherwise, the `pi` provider is enabled and T3's other providers
are off, because this host serves only pi.

## In memory

All of it is safe to lose:
- Per-thread view caches and the undo overlay.
- The thread list.
- A bounded map of recent prompt command ids.
- Pairing tickets, rate-limit buckets, and the live-socket count per client session (which drives a device's `connected` badge).

## Known gaps

- `durable.db` and its WAL files are created world-readable (0644). They contain every conversation.
