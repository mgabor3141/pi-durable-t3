# Design

`attachT3(harness, opts)` attaches a T3 Code facet to a pi-durable Harness you own. T3's web app then works as
a view over that Harness's threads.

## The rule

T3's web app is built against T3's backend. For every function that backend owns, the bridge does exactly
one of three things:

1. **Give it to pi-durable,** where it logically lives: conversations, runs, model availability, tools,
   prompts.
2. **Replicate T3's behavior,** faithfully and no more, when the UI depends on it: settings, the project
   registry, pairing. Checked against the pinned T3 source, not guessed.
3. **Refuse it,** with a typed error the UI can show.

Inventing a behavior of our own is the fourth option, and it is the one this rule exists to prevent.

Two consequences:

- **Model selection is T3's.** The client names a model (and a thinking level) on every create, launch and
  prompt. The bridge applies it and computes no defaults.
- **Model availability is the Harness's.** The integrator hands in the catalog. The bridge shows it in T3's
  picker and refuses a model that is not in it.

## The split

`src/` is the bridge. [`examples/coding-agent/`](../examples/coding-agent/) is an agent that uses it:
pi-durable's coding-agent recipe, a base prompt, credentials, an offline model, shutdown. The bridge never
touches any of those, and a test enforces the boundary. The example is a template to copy, not a package.

The repo root is the one published package, `@mgabor3141/pi-durable-t3`: `build/` turns `src/` into `dist/` (T3's
contracts bundled, public types only), and `web/` is T3's built web app for the pinned release, which the bridge serves
by default (`../web` from both `src/` and `dist/`). Neither is in git: `prepare` (`setup:t3`, then the build) makes
them, on a contributor's `pnpm install`, in a consumer's install from git, and before `pnpm publish`.

## Principles

- **Conversations are the truth; the bridge owns pointers.** pi-durable stores the entries. A thread is a
  named pointer to one conversation (its head), and the sidebar is a read of those pointers.
- **Own as little as possible.** The bridge keeps no copy of anything pi-durable can answer. What it does
  keep is listed in [`state.md`](state.md).
- **Conflicts become forks, never errors.** A write names the conversation the client is looking at. If
  that is no longer the head, it becomes a new thread. No locks, no "stale" errors, no lost input.
- **Stock wire.** T3's web app and desktop app run unmodified. The host also serves the web
  app (by default the one in the package; `webApp` points elsewhere) from its own origin, which makes the agent the app's primary environment ("This machine"), signed in
  with T3's browser session cookie. The protocol code lives in `src/t3/`, and Effect never leaves it.
- **Refuse, don't fake.** Git and terminals belong to the agent. T3 is told they are unsupported and
  hides them. Files are shared: the file panel reads, lists and searches any directory in the same `ExecutionEnv` the
  agent uses; writes stay on a project's root or a thread's own folder. The environment is the boundary, and the
  agent may edit the same file at the same time (last write wins). A panel that pretends to work is worse than none. Where the UI cannot proceed without an answer,
  the answer is the truth: an empty session scan, a lifecycle stream that says "ready" and nothing more.
- **Strict files.** A file the host cannot read stops it at boot, naming the file. The host never writes a
  file it could not read back.
- **One host per state dir and per Harness.** No cross-process locking. Threads, projects and scheduled tasks live in
  the Harness's storage, so they back up, move and restore together.

## The model

- **One Harness is one T3 environment.** A different machine is a different Harness, paired separately.
- **A project is a directory.** New threads in it run there. Each conversation records its own `cwd`, so
  losing the registry loses names, not work.
- **A thread is a pointer to a conversation.** Forks and undos share history in the same storage and inherit
  the conversation's agent config (model, tools, `cwd`).

## IDs

- **Thread ids** are minted by the client and honored, so a retried create is a no-op.
- **Project ids** are minted by whoever registers the project. T3's UI sends one and navigates to it, so the
  bridge stores and answers exactly that id. An entry written without an id gets one derived from its path.
- **An id is assigned once.** Moving a project's root keeps its id and its threads. The normalized path is
  the uniqueness key: the same folder cannot be registered twice.
- **A thread's project must exist** when the thread row is written. No row ever names a missing or empty
  project, and a conversation is never assigned to a project by guessing.

## Invariants

The code shows what each operation does. These are the rules it cannot show on its own.

- **A run is one user turn.** A message sent to steer a run is a step of that run when the run placed it (at a tool
  round, or at the end of its answer, where pi goes on with it); a message sent to follow starts a run of its own.
  The entry records how it was sent (`SentAs` in `runs.ts`), and pi-durable's `byTaskId` which run placed it.
- **Retries are answered from state.** A prompt's command id becomes pi-durable's request id, so a resent
  prompt runs once, even across a restart. A resent project create finds the entry it already wrote and
  answers with it.
- **Undo forks just before the reverted message**, in transcript order: a compaction written before the message
  stays, so the fork's context still starts from its summary. The thread's head moves to the fork; the old
  conversation keeps every entry. The reverted runs stay in the projection marked rolled back; without that, T3 reads
  the thread as busy. Nothing about them is stored but the undo itself (the head it moved to and the head it left):
  they are the left heads' runs the current head no longer has, read back from those conversations, each projected
  from its whole transcript as the live view projects a head, so a run keeps its id and ordinal.
- **Undo of a head that already moved on adds a child thread** instead of failing.
- **A delete wins.** Deleting a thread aborts its run, and the removal is recorded in the threads document.
  Promotion and undo skip removed threads, so a deleted thread stays deleted across restarts.
- **Removing a project removes its threads** and never touches files on disk.
- **Unknown threads are a typed not-found** on every path, never an empty thread made up on the spot.
- **Storage only grows.** pi-durable has no delete. Removing drops pointers, never data.

## Migrations

None in the host. There are no users to carry along, so a store of an older shape is refused at boot, not converted,
and existing instances are migrated by hand.

## Facet

The facet serves T3's HTTP routes and `/ws` (orchestration protocol 2, Effect RPC over JSON). Its handlers are typed by
T3's RPC group (`t3/ws-types.ts`) and run behind T3's own per-method scope check (`RpcAuthorization`, vendored), and the HTTP routes are T3's `EnvironmentHttpApi` implemented with `HttpApiBuilder`
(`t3/http-api.ts`), so a contract change at a pin bump fails the build and no body is shaped by hand. Only what T3 also
serves outside its HttpApi stays a plain route: assets, uploads, the preview stream, `/ws` and the web app. Behind them, the bridge writes
through the threads layer (`threads.ts`) and reads with one watch on the threads document plus, per open thread, a
`ThreadView` (`t3/thread-view.ts`) that watches its head conversation, projects each view and streams the changes; a
write that needs the head waits for that thread's load, never by polling. A thread is open while something holds it (a
command, a read, a subscriber) and for 30 s after, and **for as long as it runs**: one watch on the Harness's task graph
opens a thread whose head gains a task, wherever the work came from, and its projection holds it until the run ends.
Closed, a thread's shell comes from its record and summary, which keeps the latest settled run, so the sidebar sorts it
and shows its state exactly as when it is open.

Rate limiting keys on the socket address, never on a client-supplied header.

**Auth is the boundary; there is no `Host` check, like T3.** Every route that is not public requires a credential, and
the browser-session cookie — the one credential a page can ride — authenticates only a same-origin request (T3's
`EnvironmentAuth.isBrowserOriginAllowed`). A page that rebinds a hostname onto the listener therefore arrives with no
credentials: it reads the public descriptor and spends the pairing rate limit, and nothing else
(`test/auth-boundary.test.ts`).

## Open threads in memory

An open thread keeps its whole transcript for the projection, without image data: each image block says where its
data is stored, and T3's `tool-output-image` asset reads it from there when a client shows the image
(`src/t3/image-data.ts`). pi-durable's view holds its window as stored, so the watch's window is the newest 20 to 40
entries; the view joins each window to the transcript it keeps (pi-durable's `ConversationTranscript`), reading its
start on open and any gap a stall left. A long thread of screenshots held hundreds of megabytes when the window was
the whole transcript. A `memory` line in the log (when a client disconnects, and every 30 minutes) gives the sizes.

## Thread stream

`subscribeThread` is T3's: a bounded first snapshot (T3's `THREAD_HISTORY_PAGE_POLICY` over T3's windowed read, with
`historyCursor` and `hasMoreHistory`; `/history` serves older pages), then changes in 50 ms windows as `*.updated` /
`*.created` events. The events are derived by diffing two projections of the thread, and every batch is checked by
applying it with T3's own client reducer; a change no event can say (a record that went away) is sent as a snapshot.
A queued message that is placed or removed is not such a change: its queued run stays in the stream, cancelled, as
T3's own server keeps it (`ThreadView.#withPlaced`), and T3's client leaves a cancelled run out of the queue.
T3's paging, wire projection, body deduper and client reducer are vendored by `dev/setup-t3.sh` into `vendor/shared`
and `vendor/t3-server`. Assistant items keep one id from first token to commit, and turn items are numbered in the
order they enter the thread, as T3's `nextTurnItemOrdinal` does. A row keeps its ordinal for as long as the thread is open, and a
new row is numbered above every ordinal given before (`TurnItemOrdinals`): T3's client, holding the newest rows of a
long thread, drops a new row whose ordinal is not above the highest it has seen, taking it for history it has not
loaded. Numbering by place alone reused the ordinals of rows an undo took away, and the answer to the next command
did not appear until the thread was opened again. An `afterSequence` resume replays the last 128 events
(T3's `decideThreadResume`), else sends a snapshot; a subscriber more than 512 items behind gets a snapshot. The
sequence is a clock-floored counter of this process, so after a restart every resume is a snapshot, which the contract
allows.

Cost of one streamed reply of about 4 s (measured before compression, by a bench that `bench/transfer.bench.test.ts`
has since replaced; faux model):

| earlier turns | bounded open | full projection | items during the reply | snapshots | bytes for the reply | CPU |
|---:|---:|---:|---:|---:|---:|---:|
| 50 | 47 KB | 254 KB | 96 | 0 | 355 KB | 0.28 s |
| 200 | 47 KB | 1.0 MB | 96 | 0 | 355 KB | 0.26 s |
| 500 | 47 KB | 2.5 MB | 96 | 0 | 350 KB | 0.48 s |

The reply costs the same on every thread. Before this design (a full projection on every change) the same reply cost
9.8, 38.6 and 31.2 MB. Re-projecting the whole thread on a change is cheap once dates are shared and records compared
structurally, so per-run memoization was measured and left out.

**On the wire.** T3 replaces whole records in its events, so an answer that streams is sent again with every update,
and a sidebar row is sent whole when one field of it changes. T3's server makes that cheap with compression, and so
does this host: HTTP answers are gzipped for a client that accepts it (`HttpMiddleware.compression`), and `/ws`
negotiates permessage-deflate with one compression window for the connection, so an update that repeats most of the
last one costs little more than what is new in it.

What a client is sent and how long it waits is measured on the real transports and held to ceilings
(`test/transfer-budget.test.ts`, after T3's `transferBudgetV2.integration.test.ts`): the sidebar and a long thread
opened cold, a turn with tool results and a streamed answer as a thread subscriber, the sidebar and a second client
see it, a reconnect, a steer and a queued message, and the sidebar's own commands. The same scenario at the size of
a long day's work (`bench/transfer.bench.test.ts`; 201 turns, 2,000 tool calls, 171 threads in the sidebar):

| | JSON | on the wire |
|---|--:|--:|
| sidebar, opened cold | 296 KB | 12.8 KB |
| the thread, opened cold (bounded) | 96 KB | 8.9 KB |
| a turn: two 8 KB tool results, an answer of 3,000 words | 234 KB | 5.6 KB |

On loopback a command is answered in 20 to 35 ms and its message is in the thread's stream 50 ms later (the batch
window), while that thread streams or not. A `messageContext` hook is not on the path of that answer: the run that
answers the message asks it before its next request (`src/t3/message-contexts.ts`), so a recall that takes a second
is a second before the model's answer starts, with the message shown and the thread working (`BENCH_CONTEXT_MS`
measures that the sender does not wait).

## Peer links (not built yet)

How T3 links environments (`apps/server/src/peer/`, `docs/internals/remote.md`, behind the Linked environments beta),
for when we build it:

- **The link is an MCP client session.** The linking environment signs in to the other one's `/mcp` as an ordinary
  outside OAuth client, approved with a pairing code from the other side, and keeps the token in its secret store. The
  other side needs nothing new: it sees one more client under Sharing & access and can revoke it there.
- **Tools route by parameter.** A tool whose input takes `environmentId` runs in the linked environment once the local
  caller has passed its access checks; the thread it names is checked where it lives. Tools that act as the calling
  thread cannot be forwarded.
- **Limits travel with the call** (`T3-Mode-Limit`), and the receiver only ever narrows with them.
- **Identity is checked before the token leaves:** only to an address whose public descriptor reports the linked
  environment id.
- **One session, many callers:** idempotency keys are hashed with the caller's namespace before they leave.
- **Long waits are chunked** into calls of at most 50 s, since T3 Connect's edge drops idle requests after about 100 s.
- **Fencing by origin.** Work a link starts carries an immutable `linkOrigin`, stamped by the receiver from the signed
  session, and so does everything derived from it. Below full access, linked work may change only threads with the
  same origin and cannot touch projects, settings, scheduled tasks or the receiver's own links. Reads are not fenced.
- **Remote delegation:** `delegate_task` can target a linked environment; the parent records `remoteChild`, and a
  follower completes the task when the remote child settles.

Our side already has the server half: `/mcp` with T3's tool surface and OAuth with pairing-code approval. What is
missing is the client half (T3's `PeerLinks`, `PeerMcpClient`, `PeerForwarding`).
