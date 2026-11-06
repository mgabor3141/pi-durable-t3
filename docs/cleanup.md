# Cleanup: state and wire

Status: steps 1–7 done on branch `cleanup` (see Plan); the claw fixes below are next.

## Goal

A foundation the next features (subagents, threads that read and drive each other, `/mcp`, peer links) can build on
without reworking it. The bar is **parity with T3 v0.1.6** (the pin) on every operation we support: the same
parameters, the same wire items, the same bounds and the same cost profile. An operation we do not support is a
typed refusal that is logged through `rpcLog.onStubbed`, never a guess.

## Baseline

- CI: red since 24 Oct. Cause: `pi.transcript`'s placeholder head (`conversationId: 0`) was taken as a real head, so a
  message sent before the view loaded was submitted to conversation 0. Fixed in `26de333`; the full suite passes
  (314 passed, 2 skipped). The Tailscale tests also need an exec-able `TMPDIR`; that is a property of the machine, not
  the code.
- Wire cost, measured by `bench/thread-stream.bench.test.ts` (faux model, one streamed reply of about 4 s on a thread
  of N earlier turns; bytes are the JSON of the compact projection, i.e. what a compact-capable client receives):

  | earlier turns | turn items | snapshots during the reply | bytes per snapshot | bytes for the one reply |
  |---:|---:|---:|---:|---:|
  | 50 | 102 | 38 | 257 KB | 9.8 MB |
  | 200 | 402 | 40 | 965 KB | 38.6 MB |
  | 500 | 1003 | 13 | 2.4 MB | 31.2 MB |

  Cost grows with the thread, not with the reply. T3 sends one bounded snapshot (at most 75 rows, or 10 user turns /
  500 turn items, and 1 MiB) and then `event` items for the records that changed, coalesced in 50 ms windows
  (`ThreadLiveEventCoalescer.ts`), so the same reply costs roughly the size of the reply.

## What T3 does, and where we differ

| Concern | T3 v0.1.6 | Bridge today |
|---|---|---|
| Domain boundary | `ThreadManagementService`: every mutation is an `OrchestrationV2Command` through `dispatch` with a command receipt; reads are snapshot/window/page/shell queries; WS and MCP are thin adapters | `Bridge` (1,476 lines) mixes wire shapes, caches and domain rules; chord objects (`pi.threads`, `pi.transcript`, `pi.controller`, `pi.models`) are a second internal boundary |
| Thread record | `OrchestrationV2AppThread`: provenance (`createdBy`, `creationSource`), `lineage` (`parentThreadId`, `relationshipToParent: fork \| subagent`, `rootThreadId`), `forkedFrom`, `linkOrigin`, `delegatedFrom`, settle/snooze/pin fields | `{ threadId, projectId, head, title, createdAt, parent?, summary?, settled* }` in one session document with every other thread |
| Durable state | One SQLite (`statev2.sqlite`): events, projections, projects, scheduled tasks, auth, command receipts. `settings.json` and `keybindings.json` are files | pi-durable SQLite (threads document) plus `projects.json`, `scheduled-tasks.json`, `auth.json`, `t3-settings.json`, attachments; links between them are checked by hand |
| Idempotency | Durable command receipts (`CommandReceiptStore`) | Prompts: durable request ids. Other commands: an in-memory map of 2,000 |
| Thread stream | Bounded snapshot window, `historyCursor` + `getThreadHistoryPage`, live `event` items with a durable sequence, `afterSequence` resume (replay if cheap, else snapshot), deduped bodies, compact ids | A full projection on every view change, throttled to 60 ms (250 ms above 500 items); a clock-based sequence; no history paging |
| Readiness | Effects and streams | Placeholder values and polling (`#awaitHead` 25 ms, `projection()` 50 ms) |
| Wire typing | Handlers typed by the RPC group | 56 `as Any` in `rpc.ts`, 19 in `projection.ts`: contract drift fails at runtime, not at build |

## Your questions

### Settings: in the store or not?

Keep `t3-settings.json` a file. T3 does the same (`settings.json` and `keybindings.json` beside its database), it has no
links into other state, and the bridge interprets nothing in it. Projects and scheduled tasks move into pi-durable,
as T3 keeps them in its database: they are the two files with foreign keys into threads. `auth.json` stays a file for
now: `pair` writes it from another process, and its secrets are better kept out of the conversation store's backups.
T3 keeps auth in SQLite and its CLI opens the same database; we can follow later if a reason appears.

### Cross-instance: how T3 does it

Peer links (`apps/server/src/peer/`, `docs/internals/remote.md`, gated by the Linked environments beta):

- **The link is an MCP client session.** The linking environment signs in to the other environment's `/mcp` as an
  ordinary outside OAuth client, approved with a pairing code from the other side, and keeps that token in its secret
  store. The other side needs nothing new: it sees one more client under Sharing & access and can revoke it there.
  Unlinking only forgets the token.
- **Tools route by parameter.** A tool whose input takes `environmentId` (`OrchestratorMcpEnvironmentTarget`) runs in
  the linked environment once the local caller has passed its access checks; the thread it names is checked where it
  lives. Tools that act as the calling thread itself cannot be forwarded.
- **Limits travel with the call.** Each forwarded call carries the caller's modes in `T3-Mode-Limit`, which the
  receiver only ever narrows with.
- **Identity is checked before the token leaves.** The token goes only to an address whose public descriptor reports
  the linked environment id.
- **One session, many callers.** Idempotency keys are hashed with the caller's namespace before they leave, so two
  agents reusing a key do not collide on the far side.
- **Long waits are chunked** into calls of at most 50 s: the receiving `/mcp` sends nothing while a wait is open and
  T3 Connect's edge drops idle requests after about 100 s.
- **Fencing by origin.** Work a link starts carries an immutable `linkOrigin` (stamped by the receiver from the signed
  session, never by a client), and so does everything derived from it. Below full access, linked work may change only
  threads with the same origin, cannot touch projects, settings or scheduled tasks, and cannot use the receiver's own
  links. Reads are not fenced. A full-access link is routing, not isolation.
- **Remote delegation.** `delegate_task` can target a linked environment: the child is an ordinary thread there, the
  parent records `remoteChild` instead of `childThreadId`, and a follower (`RemoteDelegation.ts`) waits on it and
  completes the task with `delegated_task.remote.complete`. Open remote tasks are followed again at startup.

Consequence for us: a T3-compatible `/mcp` (tool surface, `structuredContent`, protocol version `2025-06-18`) plus
OAuth with pairing-code approval is the whole server side of peer links, and it would also let a real T3 instance
link to a claw instance and the reverse. The client side is `PeerLinks` + `PeerMcpClient` + `PeerForwarding`. The
thread record needs `linkOrigin` and `delegatedFrom` from the start, which is one more reason to redesign it now.

## Target architecture

```
 T3 WS RPC adapter      /mcp adapter (later)      T3Attachment API (integrator)
          \                    |                       /
           ThreadService: T3's ThreadManagementService, the subset we support
             dispatch(command, provenance) → receipt     reads: shell, snapshot window, history page, timeline
             waitForThread · interruptThread · sendToThread · listProjectThreads · subscribe(thread | shell)
          /                    |                       \
 Store (pi-durable)        Projector                  Conversations (pi-durable, unchanged)
 thread records, projects,  per-thread, incremental;
 scheduled tasks, receipts  emits record-level events
```

1. **ThreadService** owns the domain rules that live in `Bridge` and `Threads` today, with T3's input and result
   shapes (`ThreadManagementSendInput`, `ThreadManagementWaitInput`, the interrupt result union, typed not-found).
   Mutations take T3's `OrchestrationV2Command` subset we support plus provenance, so the WS adapter forwards
   `orchestration.dispatchCommand` unchanged and the MCP handlers can be ported from `OrchestratorMcpService` almost
   line for line.
2. **The chord objects layer goes.** It is a second service boundary with no caller outside the bridge, and its
   per-object watches on the threads document are where the write fan-out comes from. ThreadService holds one
   directory watch and one conversation watch per open thread. (Decision for you; see below.)
3. **Thread record**: a pi-durable session document family keyed by thread id, shaped after `OrchestrationV2AppThread`:
   the fields we can honour (provenance, lineage, `forkedFrom`, `linkOrigin`, `delegatedFrom`, title, settle, pin,
   snooze, `archivedAt`, `deletedAt`, `titleRegeneration`) plus our `head` conversation. Sidebar summaries become their
   own family, so a summary write touches one small document and wakes nobody else. Tombstones and applied undos get
   bounds. Subagent threads become records too (`lineage.relationshipToParent: "subagent"`) instead of derived ids.
4. **Projects, scheduled tasks and command receipts** move into pi-durable documents, so the links between them and
   threads are checked in the commit that writes them. Receipts replace the in-memory command map for every command;
   their retention follows T3's maintenance pass (`ProjectionMaintenance.ts`, to read before step 5).
5. **Projector**: per thread (per-run memoization was measured unnecessary in step 6). Its output is
   T3's projection records (run, attempt, node, message, turn item, subagent, provider turn); the difference
   between two outputs is the list of `*.updated` / `*.created` events, which is exactly T3's event vocabulary.
6. **Stream parity**: `subscribeThread` sends a bounded snapshot window (T3's `THREAD_HISTORY_PAGE_POLICY`, including
   `historyCursor` and `hasMoreHistory`), then coalesced events (T3's coalescing keys, 50 ms window), with deduped
   bodies and compact ids when the client accepts them. `getThreadHistoryPage` serves older rows. `afterSequence`
   resume answers with a snapshot when replay is not possible, which the contract allows; a durable sequence comes
   from pi-durable's commit sequence (to verify), so a resume can never go backwards. `subscribeShell` gets the same
   treatment.
7. **Typed boundary**: handlers implemented against the contract's RPC group types, so a T3 bump that changes a shape
   fails `tsc`. Unsupported methods stay explicit stubs.
8. **No polling for readiness**: a thread load is a promise that resolves or rejects; writes await it.

## Plan

Each step is a reviewable commit or PR with the suite green and the benchmark rerun.

1. Done: CI green (`26de333`), benchmark.
2. Done (`abc23b3`): typed RPC boundary. It found two handlers for methods the pinned contract does not have
   (`server.getSettings`, `scheduledTasks.list`), config reads failing with an undeclared error, and asset errors
   outside the contract. The auth HTTP routes still parse bodies by hand; they move to the contract's schemas with
   the auth work.
3. Done (`a7e950a`): the chord objects layer is removed; one directory watch, one head watch per open thread, a
   directory change re-projects only the rows that changed, and readiness is signalled, not polled. Moving the
   command switch from `rpc.ts` into a T3-shaped `dispatch(command, provenance)` goes with step 4, where the thread
   record gets provenance.
4. Done: one record per thread (T3's creation fields, `lineage`, `forkedFrom`, `linkOrigin`, `delegatedFrom`), one summary
   per thread, a directory of ids and heads; a deleted thread keeps its record as the tombstone; undos bounded per
   thread. Messages carry their sender. Commands go through `dispatchCommand(bridge, command, provenance)`
   (`t3/dispatch.ts`). A version-1 store is refused at boot.
5. Done: projects (`pi-durable-t3.projects`, the thread's project checked in the thread's commit) and scheduled tasks
   (`pi-durable-t3.scheduled-tasks`) live in the Harness; command receipts are kept on the thread they act on (the
   last 100), so a retried command is answered from state across restarts. `t3-settings.json`, `auth.json` and the
   attachment bytes stay in the state dir, as T3 keeps settings and keybindings in files.
6. Done: the thread stream (`t3/thread-stream.ts`, with T3's own paging, wire projection, body deduper and client
   reducer vendored by `dev/setup-t3.sh` into `vendor/shared` and `vendor/t3-server`). Changes are flushed in 50 ms
   windows as `*.updated`/`*.created` events derived by diffing two projections; every batch is checked by applying
   it with T3's client reducer, and a change no event can say (a record that went away) is a snapshot. The first
   snapshot is T3's bounded one over T3's windowed read (the window's turn items and their cohort only), with
   `historyCursor`; `/history` serves older pages. `afterSequence` resumes replay the last 128 events (T3's
   `decideThreadResume`), else a snapshot; a subscriber more than 512 items behind gets a snapshot. Assistant items
   keep one id from first token to commit, and turn items are numbered in the order they enter the thread, as T3's
   `nextTurnItemOrdinal` does. `compact.ts` is gone (T3's `WireProjection` does it).

   | earlier turns | bounded open | full projection | items during the reply | snapshots | bytes for the one reply | CPU |
   |---:|---:|---:|---:|---:|---:|---:|
   | 50 | 47 KB | 254 KB | 96 | 0 | 355 KB | 0.28 s |
   | 200 | 47 KB | 1.0 MB | 96 | 0 | 355 KB | 0.26 s |
   | 500 | 47 KB | 2.5 MB | 96 | 0 | 350 KB | 0.48 s |

   The reply now costs the same on every thread (before: 9.8 / 38.6 / 31.2 MB). Not done, by measurement: per-run
   memoization of the projector. Re-projecting the thread on a change is cheap once dates are shared and records are
   compared structurally instead of as JSON, so it would add state without a visible gain. The sequence is still the
   process's clock-floored counter, not a durable one: across a restart a resume is answered with a snapshot, which
   the contract allows.
7. Done: parity tests. Every item the bridge emits is encoded and decoded with the contract's schema in tests;
   supported commands are checked against T3's behaviour (ported test cases where T3 has them). The browser smoke is
   in CI (`ci.yml`) but cannot run on the authoring machine (no Chromium), so it is still unverified there.
   - Done: the HTTP surface is T3's `EnvironmentHttpApi` through `HttpApiBuilder` (`t3/http-api.ts`), with the auth
     middleware, scope checks and error mapping of T3's handlers. That changed what clients saw: errors now carry
     `code`/`traceId` and no invented `message`; thread and project reads need `orchestration:read` and mutations
     their scopes; a malformed token exchange or mutation is the contract's decode 400; a duplicate project path
     is `invalid_command` (was 409); `GET /api/auth/pairing-links` and `/api/auth/clients` are gone (T3 lists
     through `subscribeAuthAccess`); `/transcript` is served. `test/http-api-client.test.ts` drives every
     supported endpoint with Effect's `HttpApiClient`, the client the web app uses.
   - Done: `/ws` runs behind T3's own per-method authorization (`auth/RpcAuthorization.ts`, vendored into
     `vendor/t3-server` with the stream code). Before, only the file calls were checked; a token narrowed to
     `orchestration:read` could dispatch commands. Every method, unsupported ones included, now needs its scope.
   - Done: the test client fails any test whose host answered something that does not encode with the contract
     (the RPC server's "Failed to encode response" defect), so every host-process test checks the wire.
   - Done: T3's settings-file cases are ported (`test/settings-file.test.ts`); a save now merges into the file on
     disk (a hand edit is kept, an unparseable file refused and left alone) and writes through a symlink.
   - Done: T3's provenance case is pinned (`test/command-receipts.test.ts`): over `/ws` a creator is always the user,
     the surface is the client's, and `linkOrigin`/`delegatedFrom` cannot be claimed. Most other T3 command tests
     exercise provider sessions, delegated tasks or pull requests, which this host does not have.

Claw (separate, small): codemode `memoryLimitBytes`; MCP servers connected after the bridge is attached, and a failed
server retried; the restart drain treats a tool task whose owned work is all paused as paused.

## Decisions

1. Chord objects layer: removed.
2. Migration: none. There are no users; existing instances are migrated by hand, and no migration code is kept.
3. Order: typed boundary first (step 2), then the extraction.
