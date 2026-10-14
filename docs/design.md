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
conversation that is its head, the applied `requestId`s of undos, and the removal record (one id per removal —
see Invariants). It is the only state we add. The thread list is a read of it.

[`docs/state.md`](state.md) maps every piece of state by owner, lifetime, and the cost of losing it.

## IDs

- **Thread IDs:** minted by the client on create and fork (T3 sends `threadId` / `targetThreadId` and
  navigates to it), honored exactly, so a retried create is a no-op. The host mints one only when it
  promotes a conversation (see Invariants).
- **Conversation IDs:** minted by pi-durable.
- **Project IDs are minted by whoever registers the project.** T3's UI mints a UUID before the project exists
  (it sends `projectId` on `project.create` and navigates to it), and the host honors it exactly — the same rule
  as client-minted thread ids. The honored shape is the contract's, not the UI's habit: `ProjectId` is a branded
  trimmed non-empty string, and T3's server commits the client's id verbatim, so ANY such id is a mint — the host
  trims it, stores it, and answers with it. A blank id is not a mint; an id the instance file cannot store is
  refused with the typed project error. For folders the host registers without a client id — an integrator-written
  entry, a folder discovered from a conversation cwd — the host derives one from the normalized absolute path
  (`p-<the first 16 hex of sha256(path)>`), so it is stable across restarts and nothing has to remember it.
- **An id is assigned once and never re-derived.** At registration it is minted (the client's) or derived (from
  the path); after that it is data the host keeps, never a function of the path again: the first mutation of a
  derived-id entry (a move, a rename) STORES the id in the entry. A root MOVE therefore keeps the id — and the
  project's threads, which reference it (the sidebar re-groups under the moved root; no re-key, no ghost).
  The title is a free label: renaming changes only the label. Both keys are guarded at mutation time: `add`
  refuses a duplicate path (compared normalized) and a minted id another project already owns.
- **A thread's `projectId` is a foreign key.** The sidebar groups by it, and a project's `cwd` is looked up
  through the registry. A thread's work does not depend on the registry: existing conversations keep working
  from the `cwd` their own conversation records, so a lost registry costs names, not work. A thread's project
  comes from its project first, then from the conversation's own recorded `pi.agent.cwd`; a thread whose project
  is not registered is reported with its `projectId` and no invented project. **The path is the uniqueness key**
  (T3 refuses the same folder twice): a duplicate path is refused — compared NORMALIZED, so `…/alpha` and
  `…/alpha/` are one project, not two sharing an id.

## Invariants

The code is the spec for the operations. These are the rules the code cannot show on its own.

- **A write names the conversation the client is showing and carries a `requestId`,** so a retried write
  returns the same result instead of applying twice.
- **A project mutation carries a `commandId`, and the first attempt decides the answer.** A client whose response was
  lost resends the same id; the bridge replays what the first attempt produced — the created project, the deletion it
  made, or the refusal it was refused with — instead of planning it again. Planned again, a retried create answers
  "workspace already belongs to project *X*" for the project the client just created, and a retried delete answers
  "not found". A delete of a project that is already gone is therefore idempotent for the id that deleted it, and a
  not-found for any other id (T3's rule). The receipt store is bounded, and a receipt key is a client-chosen id, so
  the bound is what stops it being memory a client can grow.
- **The instance file has one writer, and a mutation carries only the part it changes.** The host reads the document
  on disk, applies its delta, and writes it back under a cross-process lock — because a data dir shared by two hosts
  is the documented dev setup, and a writer that rewrote the whole file from the copy it read at boot silently
  deleted the peer's title edit, its thinking level, its default model. A document that would not boot (the parser
  that reads it at start says so) is never written over a good one, and every write goes to a unique temp file that
  is `chmod`ed before the rename — a fixed temp name lets a crashed writer's leftover file decide the mode of the
  file that gets published, since `open(2)` applies `mode` only when it creates.
- **Promote is its own commit.** A submit carries nothing else, and commits serialize per Session, so
  racing promotes add one thread.
- **Boot repair:** at start, one commit promotes every conversation with a run or queued input
  (`tx.scanConversations`) that is nobody's head. That covers a crash between a submit and its promote.
- **Undo forks one entry before the message it reverts** — `Threads.rewind` (`src/threads.ts`) owns the entry
  arithmetic, and why: a fork includes its fork entry.
- **A delete aborts first, and wins the run** — `Threads.remove` (`src/threads.ts`) aborts the head so boot repair
  sees nothing owed, and interrupts it again after the commit: a prompt admitted in the abort→commit window (the
  row is still there, so admission succeeds) loses — a thread the document has removed has no live turn. And the
  removal is durable: `Threads.remove` records the removed thread's head conversation in the threads document (one
  id per removal; the doc checkpoints, so the record is cheap). The promote path, the undo fork, and boot repair
  skip tombstoned conversations — a prompt admitted before (or racing) a delete can never resurrect the thread,
  not now and not after a restart. Boot repair reports tombstoned conversations it skipped in ONE summary line.
- **A prompt racing an undo converges either way:** prompt first and the undo sees the run and refuses;
  undo first and the prompt's promote makes its conversation a thread.
- **Removing a project takes its threads with it** and never touches files on disk. T3's UI always sends
  `force: true`, over a dialog promising exactly those two things; leaving the threads visible would
  contradict it. The cascade drains by foreign key after the entry is dropped: a thread create racing the
  cascade writes its row against the registry at commit time, finds the project gone, and loses.
- **No thread row without a registered project.** A thread row names a project as a foreign key, and the key is
  enforced where rows are written: AT COMMIT TIME, because the registry lives in the other store and a removal
  that lands mid-call is invisible to any pre-commit check. A create whose commit arrives after the project's
  removal is refused; the undo fork of a removed thread adds no row (the removal record gates that door); and a
  row that names a project the registry does not answer is reported with its `projectId` and no invented project,
  never published as one.
- **The instance file the host writes always parses.** The boot parser is the definition of writable: every key
  it enforces — the project path, the project id — is enforced at mutation time, typed, before the write. A
  hand-written entry can still carry damage the UI cannot pre-validate (a duplicate id, an unparseable shape);
  boot degrades it the way a missing path degrades: the entry that cannot be honored is skipped and named in a
  warning that names the file, and the host binds — a host that dies before its listener binds cannot be told
  to fix the file.

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
call, which is not on the reachable surface. Every mutation of that file goes through one writer: a delta on the
document as it is on disk, serialized by a lock file, validated by the parser that reads the file at boot (see
Invariants).

Errors, by tier. The chord objects answer with **codes**: `unknown_project`, `unknown_thread`, `turn_running`,
`not_rewindable`, `unknown_model`, `unknown_thinking_level` (the last two from `pi.models`' `select` /
`selectThinking`). Project mutations are answered at the facet as the contract's `ProjectMutationError` with a
message a client shows as it is — a duplicate workspace path ("workspace … already belongs to project …"), a
project that is not empty, a project that was not found, a command id already used by another command. A settings
write answers the contract's `ServerSettingsError` (it names the instance file and the operation), and a model the
catalog does not have is refused by name, with a bounded list of the models that are available (enough to spot the
right one, so a typo is fixable from the refusal alone): a default the host cannot call would make every new thread
an interrupted turn, so the two new-thread paths treat it the way each one can. The start-time check reads the
new-thread default from the INSTANCE file (`settings.json` — the tier the UI edits; `config.toml` refuses
`default_model` outright), and it is TOLERANT, like that file's other fields: a default the catalog lacks at boot
(the catalog is a function of credentials, so a value valid when the UI set it can be absent at the next start) warns
naming the model and what IS available, is dropped, new threads start on the first catalog model, and the host binds
— a host that exits before its listener binds cannot be told to fix the file, and the UI is that file's only editor.
On the wire, from the UI, the check is strict: a default the catalog cannot call is refused with the typed
`ServerSettingsError`, because there the editor is reachable and can fix the typo from the refusal alone.

## T3 facet

The T3-facing bridge is a local client of the chord objects; it owns no socket. The facet (`t3/facet.ts`, over
`t3/http.ts`) owns the HTTP port, speaks T3's orchestration v2 wire protocol over HTTP plus `/ws`, and drives the bridge
in-process.

- **Wire surface** matches stock T3, so its web app needs no changes: the 10 HTTP routes (discovery, pairing,
  tickets, the shell and thread snapshots, and the `/api/projects` + `/api/projects/mutate` parity pair) plus `/ws`,
  with
  `orchestrationProtocol=2` and a one-shot ticket, Effect RPC over JSON, and a `serverVersion` equal to the
  vendored contracts version.
- **A parity route validates like the RPC it parallels.** `/api/projects/mutate` decodes its body with the contract's
  `ProjectMutation`, the schema the `projects.mutate` payload is decoded with. Passed through, a body the RPC refuses
  reaches the handler: `{}` matched no case, and the route answered `200` with an empty body — a create that did
  nothing, reported as a success. Parity is the validation, not just the URL.
- **A rate limiter keys on the socket, not on a header.** Pairing attempts are counted against the peer address of the
  connection. `x-forwarded-for` is client-supplied: trusting it on a loopback bind — every request, on the default
  bind — lets a caller mint a fresh bucket per attempt and never be limited. Behind a local proxy the clients of that
  proxy share one bucket, which fails closed; per-client accounting behind a proxy needs a setting that says "this
  deployment is behind a proxy", so the operator decides which header to believe.
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
