# Design

Bring your own pi-durable Harness: storage, extensions, tools, execution env. Add this, pair T3 Code to
it, and T3's web app becomes a view over your threads.

## The model

- **One Harness = one T3 environment.** Pairing points T3 at one running instance. A different setup
  (local, SSH, sandbox) is a different Harness, paired separately.
- **Project:** a subdirectory under the env root, configured by the integrator. New threads in a project
  get it as their conversation's `cwd` (`pi.agent.cwd`). The integrator's env builder must honor
  `target.cwd` and return a fresh env per call (`harness.ts:230-235`); never one shared env with a
  mutated `cwd`.
- **Thread:** a named pointer (its **head**) to one conversation. One T3 sidebar entry. Forks share
  history in the same storage and inherit model, tools, instructions and `cwd`.
- **The host owns conversations only.** Files, checkpoints, branches, worktrees and terminals belong to
  pi and its extensions. T3's git, diff, VCS, PR and terminal calls are refused.

## State

One document in the Harness's storage, `pi-durable-t3.threads`:
`{ threadId, projectId, head, title, createdAt, parent?: { threadId, entryId } }[]`, plus the applied
`requestId`s of undos. It is the only state we add. The thread list is a read of it.

## IDs

- **Thread IDs:** minted by the client on create and fork (T3 sends `threadId` / `targetThreadId` and
  navigates to it), honored exactly, so a retried create is a no-op. The host mints one only when it
  promotes a conversation (below).
- **Conversation IDs:** minted by pi-durable.

## Writes

Every write names the conversation the client is showing and carries a `requestId`. **A write applies to
the conversation it names. If that conversation is no thread's head, it becomes one:** a new child
thread. No locks and no "stale" errors: conflicts become forks.

- **`create({ threadId, projectId, title? })`**, one commit: if the thread exists, return it; else create
  a conversation with the project's `cwd` and add the thread.
- **`prompt` / `steer` / `followUp({ threadId, conversationId, requestId, message, images })`:** submit to
  the conversation (pi-durable dedupes by `requestId`), then **promote** it.
- **Promote**, one commit: if no thread's head is this conversation, add a thread for it. It can't share
  pi-durable's submit commit (submit takes no extra writes, `types.ts:834`, `submissions.ts:64-69`), but
  commits on one storage are serialized (`session.ts:854-860`), so concurrent promotions add one thread.
- **`abort({ threadId, conversationId })`:** aborts that conversation; never promotes.
- **`rewind({ threadId, expectedHead, entryId, requestId })`**, T3's undo, one commit:
  1. a `requestId` already applied returns its earlier result;
  2. the entry must start a user turn in `expectedHead`'s active context, else `not_rewindable`;
  3. fork `expectedHead` at the entry just before it (a fork includes its fork entry, durable `README.md:526`), so the reverted user message is gone, not left unanswered;
  4. head still `expectedHead`: refuse `turn_running` if it has a run or a queued input (`pi.live.run`,
     `pi.inbox`), else move the head to the fork;
  5. head moved on: leave it, add the fork as a child thread.
- **`remove({ threadId })`:** first aborts the head's turn (pi-durable's abort withdraws queued inputs, interrupts the
  running generation, and waits for idle), then drops the pointer — so boot repair sees nothing owed and does not
  resurrect a deleted thread. Conversations stay; pi-durable has no delete.
- **Fork** (not built yet): one commit, fork the source head at the entry, add the thread.

A prompt racing an undo converges either way: prompt first, the undo sees the run and refuses; undo
first, the prompt's promote makes its conversation a thread.

**Boot repair:** at start, one commit promotes every conversation with a run or queued input
(`tx.scanConversations`) that is nobody's head. That covers a crash between a submit and its promote.

## chord2 objects

What the T3 facet calls, and what any other pi client could call. Per-thread objects are keyed by
`{ threadId }`.

| Object | State | Methods |
|---|---|---|
| `pi.threads` | `{ revision, projects, threads }` | `create`, `remove` |
| `pi.transcript` | the head's `ConversationView` plus `conversationId` | |
| `pi.controller` | | `prompt`, `steer`, `followUp`, `abort`, `rewind` |
| `pi.models` | `{ catalog, configuration }` | `select`, `selectThinking` |

Errors: `unknown_project`, `unknown_thread`, `turn_running`, `not_rewindable`, `unknown_model`,
`unknown_thinking_level` (the last two from `pi.models`' `select` / `selectThinking`).

## T3 facet

The T3-facing bridge is a local client of the chord objects; it owns no socket. The facet (`t3/facet.ts`, over
`t3/http.ts`) owns the HTTP port, speaks T3's orchestration v2 wire protocol over HTTP plus `/ws`, and drives the bridge
in-process.

- **Wire surface** matches stock T3, so its web app needs no changes: the 10 HTTP routes, `/ws` with
  `orchestrationProtocol=2` and a one-shot ticket, Effect RPC over JSON, `serverVersion` equal to the
  vendored contracts version (`0.0.45`).
- **Modules:** `projection.ts` (a pure Harness view → T3 projection), `auth.ts` (pairing and tokens),
  `http.ts` (the routes and `/ws`), `rpc.ts` (the Effect RPC handler table), `bridge.ts` (reads the thread
  objects and writes through the threads layer), `models.ts` (the model catalog), `config.ts` (facet settings).
- **Effect stays inside the facet;** the boundary is the RPC handler table.
- T3 sends a thread ID; the facet supplies the `conversationId` from the snapshot it last sent for that
  thread, and `expectedHead` for undo.
- `appCanCheckpointFilesystem: false`; `restoreFiles: true` is refused by the facet.
- Promoted and forked threads carry `lineage.parentThreadId` and `relationshipToParent: "fork"`.

## Limitations

- **The storage only grows.** pi-durable has no delete or GC.
- **Shells survive a crash.** pi-durable runs shells detached, so they outlive a killed process. This is
  pi-durable behavior, not ours; running under systemd cleans them up.
- **Visible but unusable in T3:** the terminal drawer, the diff view, the folder picker.
- **The rolled-back-runs overlay is in-memory.** A reverted run is shown as "rolled back" from the facet's per-thread
  memory (`<stateDir>/threads.json`), which is lost on restart. After a restart the thread's head simply has fewer runs
  (a clean revert) with no rolled-back markers.
- **Undo can surface a new thread.** An undo of the current head moves that thread's head (a clean in-place revert).
  An undo of a head that already moved on — a stale or concurrent undo — becomes a promoted child thread in the
  sidebar (lineage `relationshipToParent: "fork"`); clutter is the price of conflicts-never-error.
- **AGENTS.md** is not loaded yet. When it is: once at thread create, through the env's file API.
- **Shutdown is graceful.** Ctrl-C (SIGINT) and SIGTERM close the facet server (interrupting its fiber, which releases
  the port), then the objects host and storage, and the process exits 0. A bind failure (port already in use) exits 1
  with the address and `EADDRINUSE` *before* printing "ready". (A shell a turn started is detached and finishes on its
  own after a crash — see "Shells survive a crash" above — and the model is told the call may have partially run.)
- **Delete stops the run.** Deleting a thread aborts its running turn, so it stops spending and touching files, and boot
  repair does not re-add it.
- **Cold-thread writes await the head.** A freshly created thread's transcript resolves a few awaits after it is opened
  (its head is `undefined`/`0` until the pump rebinds), so every write waits for the real head — the first message is
  never dropped, and no write depends on some earlier call having warmed the transcript.
- **Reconnect after a restart.** T3's client socket reconnects on its own cadence; after a host restart it can take up
  to a minute (or more) to reconnect.
- **T3 panels are stubbed.** The git, terminal, diff, VCS and PR surfaces are refused; the paired agent runs `bash` and
  writes files with no approvals, as the host user. See the README limitations.
