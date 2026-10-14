# Design

Bring your own pi-durable Harness: storage, extensions, tools, execution env. Add this, pair T3 Code to
it, and T3's web app becomes a view over your threads.

Upstream citations give the published version, the upstream path and a symbol: the npm tarball ships no
`src/`, so check them against the pi repo at tag `v1.2.0`.

## Principles

- **Conversations are the truth; we own pointers.** pi-durable stores the entries; a thread is a named
  head pointing at one, and the sidebar is a read of those pointers. Nothing we add is needed to read a
  conversation.
- **Configuration outlives threads.** What a machine is — its folders, its defaults — lives in files;
  what a thread is lives in storage. A UI edit never rewrites the integrator's file, and losing history
  never erases a machine.
- **Conflicts become forks, never errors.** A write names the conversation the client is showing. If that
  conversation is no longer a head, it becomes one. No locks, no "stale" errors, no lost input.
- **Stock wire, no fork of T3.** We speak T3's protocol exactly, so its web app runs unmodified. The
  compatibility lives in one directory and Effect never leaves it.
- **Stub, don't fake.** Where a capability belongs to pi and its extensions — files, git, terminals — T3
  is told plainly that it is unsupported and hides it. A panel that pretends to work is worse than an
  absent one.
- **Bring your own Harness.** Storage, model catalog, tools, instructions, execution env, sandboxing: the
  integrator's choice, made once in a few lines of code. This adds threads and a T3 facet.

## The model

- **One Harness = one T3 environment.** Pairing points T3 at one running instance. A different setup
  (local, SSH, sandbox) is a different Harness, paired separately.
- **Project:** a directory the user added to the registry, with a title. New threads in a project get it
  as their conversation's `cwd` (`pi.agent.cwd`). The integrator's env builder must honor `target.cwd` and
  return a fresh env per call (`pi-durable@1.2.0 · packages/durable/src/harness/harness.ts:230-235`, `buildEnv`); never one shared env with a mutated `cwd`.
  The registry is an index over the conversations, each of which records its own `cwd`: a lost registry
  costs names, not work.
- **Thread:** a named pointer (its **head**) to one conversation. One T3 sidebar entry. Forks share
  history in the same storage and inherit model, tools, instructions and `cwd`.
- **The host owns conversations only.** Files, checkpoints, branches, worktrees and terminals belong to
  pi and its extensions. T3's git, diff, VCS, PR and terminal calls are refused.

## Configuration

Where a setting lives is decided by who edits it.

| Tier | File | Edited by |
|---|---|---|
| Host | `config.toml` | the integrator, by hand |
| Instance | `settings.json` | T3's UI, through the host |
| Thread | pi-durable (`pi.agent`) | the agent, and T3's per-thread UI |

**The integrator's file holds what a UI must not set:** the address to bind, the web app to print a
pairing link for, and everything that reaches outside the process — the model catalog and its
credentials, the instructions file, the facet's token lifetimes. **The instance file holds what a user
changes while working:** the projects, the model and thinking level new threads start on, and the
host-wide defaults T3's settings panes expose. **Per-thread state is a chord on purpose:** `pi.agent` is
a conversation-scoped, `history: "rewindable"` doc (`durable/harness/agent.ts:47`), which is why a fork
or an undo inherits model, tools, instructions and `cwd`. Session-scoped docs cannot be rewindable
(`packages/durable/src/types.ts:57`).

Paths follow XDG (`$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, defaulting to `~/.config` and `~/.local/share`),
with `--root <dir>` overriding both so that an instance is one directory. Nothing is discovered: `--root`,
or these. `~/.local/share` is application data, so **no project ever defaults into it** — a project is a
path the user chose. Both neighbours already use these names: pi's `~/.pi/agent/settings.json`, T3's
`<stateDir>/settings.json`.

## State

One document in the Harness's storage, `pi-durable-t3.threads`:
`{ threadId, projectId, head, title, createdAt, parent?: { threadId, entryId } }[]`, plus the applied
`requestId`s of undos. It is the only state we add. The thread list is a read of it.

## IDs

- **Thread IDs:** minted by the client on create and fork (T3 sends `threadId` / `targetThreadId` and
  navigates to it), honored exactly, so a retried create is a no-op. The host mints one only when it
  promotes a conversation (see Invariants).
- **Conversation IDs:** minted by pi-durable.
- **Project IDs:** derived from the normalized absolute path, so renaming a project is free and the same
  directory can't be registered twice (T3 refuses it too, `ProjectService.ts:66-73`). Threads reference
  `projectId`, so an id minted from anything the user can type would strand them.

## Invariants

The code is the spec for the operations. These are the rules the code cannot show on its own.

- **A write names the conversation the client is showing and carries a `requestId`,** so a retried write
  returns the same result instead of applying twice.
- **Promote is its own commit.** A submit carries nothing else (`submit(submission, context)` takes a
  `SubmissionDraft` and no extra writes — `harness/types.ts:654` and `:61-77`; the commit itself is
  `commitWith(admitSubmission)`, `session/submissions.ts:64-69`), and `Session#enqueue` serializes
  commits per Session (`session/session.ts:854-860`), so racing promotes add one thread.
- **Boot repair:** at start, one commit promotes every conversation with a run or queued input
  (`tx.scanConversations`) that is nobody's head. That covers a crash between a submit and its promote.
- **Undo forks one entry before the message it reverts.** A fork includes its fork entry
  (`packages/durable/README.md:532`), so forking at the message leaves the user's message standing there with no
  reply.
- **A delete aborts first,** so boot repair sees nothing owed and does not resurrect the thread.
- **A prompt racing an undo converges either way:** prompt first and the undo sees the run and refuses;
  undo first and the prompt's promote makes its conversation a thread.
- **Removing a project takes its threads with it** and never touches files on disk. T3's UI always sends
  `force: true`, over a dialog promising exactly those two things
  (`LegacySidebar.tsx:1556,1615-1637`); leaving the threads visible would contradict it. pi-durable has
  no delete, so the conversations stay in storage, unreachable.

## chord2 objects

What the T3 facet calls, and what any other pi client could call. Per-thread objects are keyed by
`{ threadId }`.

| Object | State | Methods |
|---|---|---|
| `pi.threads` | `{ revision, projects, threads }` (the doc also keeps applied undo `requestId`s) | `create`, `remove` |
| `pi.transcript` | the head's `ConversationView` plus `conversationId` | |
| `pi.controller` | | `prompt`, `steer`, `followUp`, `abort`, `rewind` |
| `pi.models` | `{ catalog, configuration }` | `select`, `selectThinking` |

The threads layer also serves the registry (`projectsList`, `addProject`, `removeProject`) from
`settings.json`, writing the file rather than a chord.

Errors: `unknown_project`, `project_conflict`, `project_not_empty`, `unknown_thread`, `turn_running`, `not_rewindable`, `unknown_model`,
`unknown_thinking_level` (the last two from `pi.models`' `select` / `selectThinking`).

## T3 facet

The T3-facing bridge is a local client of the chord objects; it owns no socket. The facet (`t3/facet.ts`, over
`t3/http.ts`) owns the HTTP port, speaks T3's orchestration v2 wire protocol over HTTP plus `/ws`, and drives the bridge
in-process.

- **Wire surface** matches stock T3, so its web app needs no changes: the 9 HTTP routes and `/ws`, with
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
- **Storage only grows.** pi-durable has no delete or GC, so removing things drops pointers, never data.
  A doc write also appends a delta row to `document_revisions` until the doc checkpoints
  (`packages/durable/src/storage/sqlite/storage.ts:899-911`); `ThreadsDoc` sets no policy yet, so it grows one small row per
  create, remove and undo.
- **Undo of a head that already moved on becomes a thread.** A stale or concurrent undo can't move that
  head, so its fork is added as a child thread. Clutter is the price of conflicts-never-error.
- **The rolled-back-runs overlay is in-memory.** `threads.json` persists message ids and pending
  messages, not `rolledBack`, so after a restart a reverted thread's head simply has fewer runs.
- **Cold-thread writes await the head.** A new thread's transcript resolves a few awaits after it opens,
  so every write waits for the real head: the first message is never dropped, and no write depends on
  some earlier call having warmed the transcript.
- **Shutdown is bounded, not fully graceful.** Ctrl-C and SIGTERM run the close under a short grace, then
  exit; a second signal exits at once. A provider's HTTP stream can ignore abort and pi-durable's close
  awaits it, so a fully graceful close can hang for tens of seconds. Crash-resume is what makes bounding
  it safe (a forced exit is that crash). A bind failure exits 1 with `EADDRINUSE` before "ready".
