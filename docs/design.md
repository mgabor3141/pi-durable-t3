# Design

Bring your own pi-durable Harness: storage, extensions, tools, execution env. Add this, pair T3 Code to
it, and T3's web app becomes a view over your threads.

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
- **The bridge is stateless by choice.** It duplicates no state, and owns as little as it can. A fact
  belongs to the conversation, to one document of pointers, to a credential only this host may hold, or to
  a cache that is correct to lose. A second copy of a fact pi-durable can answer is a defect. The
  inventory is [`docs/state.md`](state.md); new state goes in it, under the owner that made it.
- **Bring your own Harness.** Storage, model catalog, tools, instructions, execution env, sandboxing: the
  integrator's choice, made once in a few lines of code. This adds threads and a T3 facet.

## The model

- **One Harness = one T3 environment.** Pairing points T3 at one running instance. A different setup
  (local, SSH, sandbox) is a different Harness, paired separately.
- **Project:** a directory the user added to the registry, with a title. New threads in a project get it
  as their conversation's `cwd` (`pi.agent.cwd`). The integrator's env builder must honor `target.cwd` and
  return a fresh env per call; never one shared env with a mutated `cwd`.
  The registry is an index over the conversations, each of which records its own `cwd`: a lost registry
  costs names, not work.
- **Thread:** a named pointer (its **head**) to one conversation. One T3 sidebar entry. Forks share
  history in the same storage and inherit model, tools, instructions and `cwd`.
- **The host owns conversations only.** Files, checkpoints, branches, worktrees and terminals belong to
  pi and its extensions. T3's git, diff, VCS, PR and terminal calls are refused.

## Configuration

Where a setting lives is decided by who edits it. The split below is in place: a host file (`config.toml`)
and an instance file (`settings.json`, in the data dir) cover the two file tiers; the thread tier is pi-durable's
`pi.agent`.

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
a conversation-scoped, `history: "rewindable"` doc, which is why a fork
or an undo inherits model, tools, instructions and `cwd`. Session-scoped docs cannot be rewindable.

Paths follow XDG (`$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, defaulting to `~/.config` and `~/.local/share`),
with `--root <dir>` overriding both so that an instance is one directory. Nothing is discovered: `--root`,
or these. `~/.local/share` is application data, so **no project ever defaults into it** — a project is a
path the user chose. Both neighbours already use these names: pi's `~/.pi/agent/settings.json`, T3's
`<stateDir>/settings.json`.

## State

One document in the Harness's storage, `pi-durable-t3.threads`: one row per thread, pointing at the
conversation that is its head, plus the applied `requestId`s of undos. It is the only state we add. The
thread list is a read of it.

[`docs/state.md`](state.md) maps every piece of state by owner, lifetime, and the cost of losing it.

## IDs

- **Thread IDs:** minted by the client on create and fork (T3 sends `threadId` / `targetThreadId` and
  navigates to it), honored exactly, so a retried create is a no-op. The host mints one only when it
  promotes a conversation (see Invariants).
- **Conversation IDs:** minted by pi-durable.
- **Project IDs are derived from the path, always.** Every project — one the UI added, one the integrator
  once configured, a folder discovered at runtime — has an id that is a function of its normalized absolute
  path (`p-<sha256(path)>`). A per-process random id would strand T3's selection for that folder on every
  restart. Nothing mints an id, so nothing has to remember it, and it survives a restart unchanged. The
  title is a free label: renaming a project changes only the label, never the id.
- **A thread's `projectId` is a foreign key.** The sidebar groups by it, and a project's `cwd` is looked up
  through the registry. A thread's work does not depend on the registry: existing conversations keep working
  from the `cwd` their own conversation records, so a lost registry costs names, not work. A duplicate path
  is refused (T3 refuses the same folder twice): a project IS a path; two entries for one path would make
  the id collide and the grouping ambiguous.

## Invariants

The code is the spec for the operations. These are the rules the code cannot show on its own.

- **A write names the conversation the client is showing and carries a `requestId`,** so a retried write
  returns the same result instead of applying twice.
- **Promote is its own commit.** A submit carries nothing else, and commits serialize per Session, so
  racing promotes add one thread.
- **Boot repair:** at start, one commit promotes every conversation with a run or queued input
  (`tx.scanConversations`) that is nobody's head. That covers a crash between a submit and its promote.
- **Undo forks one entry before the message it reverts** — `Threads.rewind` (`src/threads.ts`) owns the entry
  arithmetic, and why: a fork includes its fork entry.
- **A delete aborts first** — `Threads.remove` (`src/threads.ts`) — so boot repair sees nothing owed.
- **A prompt racing an undo converges either way:** prompt first and the undo sees the run and refuses;
  undo first and the prompt's promote makes its conversation a thread.
- **Removing a project takes its threads with it** and never touches files on disk. T3's UI always sends
  `force: true`, over a dialog promising exactly those two things; leaving the threads visible would
  contradict it.

## chord2 objects

What the T3 facet calls, and what any other pi client could call. Per-thread objects are keyed by
`{ threadId }`.

| Object | State | Methods |
|---|---|---|
| `pi.threads` | `{ revision, projects, threads }` (the doc also keeps applied undo `requestId`s) | `create`, `remove` |
| `pi.transcript` | the head's `ConversationView` plus `conversationId` | |
| `pi.controller` | | `prompt`, `steer`, `followUp`, `abort`, `rewind` |
| `pi.models` | `{ catalog, configuration }` | `select`, `selectThinking` |

The threads layer also owns the project registry (list / add / update / remove) in `settings.json`, writing the
file rather than a chord. T3 reads it from the shell snapshot's `projects` field and edits it through the sendable
`projects.mutate` (`project.create` / `project.update` / `project.delete`) — not a `projects.list`/`add`/`remove`
call, which is not on the reachable surface.

Errors: `unknown_project`, `project_conflict`, `project_not_empty`, `unknown_thread`, `turn_running`, `not_rewindable`, `unknown_model`,
`unknown_thinking_level` (the last two from `pi.models`' `select` / `selectThinking`).

## T3 facet

The T3-facing bridge is a local client of the chord objects; it owns no socket. The facet (`t3/facet.ts`, over
`t3/http.ts`) owns the HTTP port, speaks T3's orchestration v2 wire protocol over HTTP plus `/ws`, and drives the bridge
in-process.

- **Wire surface** matches stock T3, so its web app needs no changes: the 9 HTTP routes and `/ws`, with
  `orchestrationProtocol=2` and a one-shot ticket, Effect RPC over JSON, and a `serverVersion` equal to the
  vendored contracts version.
- **Effect stays inside the facet;** the boundary is the RPC handler table.
- T3 sends a thread ID; the facet supplies the `conversationId` from the snapshot it last sent for that
  thread, and `expectedHead` for undo.
- `appCanCheckpointFilesystem: false`; `restoreFiles: true` is refused by the facet.
- Promoted and forked threads carry `lineage.parentThreadId` and `relationshipToParent: "fork"`.
- **Storage only grows.** pi-durable has no delete or GC, so removing things drops pointers, never data.
  A doc write also appends a delta row until the doc checkpoints, so `ThreadsDoc` checkpoints on every
  write: the threads list is a current read, and nothing ever asks it for a past version.
- **Undo of a head that already moved on becomes a thread.** A stale or concurrent undo can't move that
  head, so its fork is added as a child thread. Clutter is the price of conflicts-never-error.
- **A restart shows a reverted thread with fewer runs.** The rolled-back-runs overlay is in memory on
  purpose: the runs it lists no longer exist in the conversation, and a reverted thread is not a bug.
- **Cold-thread writes await the head.** A new thread's transcript resolves a few awaits after it opens,
  so every write waits for the real head: the first message is never dropped, and no write depends on
  some earlier call having warmed the transcript.
- **Shutdown is bounded, not fully graceful.** Ctrl-C and SIGTERM run the close under a short grace, then
  exit; a second signal exits at once. `src/shutdown.ts` says why a graceful close cannot be awaited, and
  `src/main.ts` what a failed bind does.
