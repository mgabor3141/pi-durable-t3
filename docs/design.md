# Design

A bridge library: `attachT3(harness, opts)` attaches a T3 Code facet to a pi-durable Harness you own.
Pair T3's web app to it, and T3 becomes a view over your threads. The test agent in
[`examples/coding-agent/`](../examples/coding-agent/) is one integrator — the upstream pi-durable coding-agent
recipe plus this library.

## The north star

T3's web app is built against T3's backend. For every function that backend owns, this host makes exactly one of
three choices — there is no fourth:

1. **Give it to pi-durable.** The function is a conversation, a run, a pointer: durable storage answers it.
2. **Replicate T3's behavior faithfully in the bridge.** The UI will not tolerate a different answer, so the
   bridge answers the way T3's server answers — the same document, the same patch semantics, the same typed
   errors, verified against the pinned T3 checkout, not invented.
3. **Not supported.** Say so, typed, on the wire, with a reason. The UI hides what it is refused.

A fourth choice — inventing a behavior of our own — is the defect this document exists to prevent. Two
ownership rules follow from it:

- **Model SELECTION is T3's.** The client names the model on every create/launch/prompt (`thread.create` and
  `launchThread` require `modelSelection` in the contract — verified in the vendored schemas); the bridge
  applies the named model. It computes no defaults, adopts nothing, and second-guesses nothing. The thinking
  level travels with it: T3's pi driver declares a `thinking` model option whose values are pi's own levels, and
  the bridge applies the one the client names (see [`capabilities.md`](capabilities.md)).
- **Model AVAILABILITY is the Harness's.** The caller hands in a `Models` catalog; the bridge projects it to
  T3's picker list and refuses a model the catalog does not have, naming it. Which models exist, and their
  credentials, are the integrator's, made once in code.

## The split

`src/` is the bridge library. One entry point:

```ts
const t3 = await attachT3(harness, {
        models, projects, dataDir, listen, stateDir,       // required
        label, webAppUrl, corsOrigins, tokenTtlSeconds,    // optional
        pairingToken, log,                                 // optional
      });
      // → { ready, pairingCode(), pairingUrls(code), close() }
```

The boundary is checked by a test (`test/boundary.test.ts`): `src/` never mentions `pi-coding-agent`, the
agent dir, instructions files, reply models, coding tools, or the execution env. Those are the test agent's
(`examples/coding-agent/`): its config file, its base prompt, its model runtime, its shutdown. The bridge
decides nothing about the agent: a fresh thread's `pi.agent` carries its project's `cwd` and nothing else, and
everything a thread has beyond that — model, thinking level, instructions — arrives from the client or the
integrator's extensions.

## Principles

- **Conversations are the truth; we own pointers.** pi-durable stores the entries; a thread is a named head
  pointing at one, and the sidebar is a read of those pointers.
- **Configuration outlives threads.** What a machine is lives in files; what a thread is lives in storage. A
  UI edit never rewrites the integrator's file, and losing history never erases a machine.
- **Conflicts become forks, never errors.** A write names the conversation the client is showing. If that
  conversation is no longer a head, it becomes one. No locks, no "stale" errors, no lost input.
- **Stock wire, no fork of T3.** We speak T3's protocol exactly, so its web app runs unmodified. The
  compatibility lives in `src/t3/` and Effect never leaves it.
- **Stub, don't fake.** Where a capability belongs to pi and its extensions — files, git, terminals — T3 is
  told plainly that it is unsupported and hides it. A panel that pretends to work is worse than an absent one.
- **The bridge is stateless by choice.** It duplicates no state, and owns as little as it can. A fact belongs
  to the conversation, to one document of pointers, to the UI's files, to a credential only this host may
  hold, or to a cache that is correct to lose. The inventory is [`docs/state.md`](state.md).
- **One host per data dir.** No cross-process lock, no merge-on-write protocol: the files are read at boot,
  mutated in process, written atomically. Two hosts sharing a data dir is not a supported setup.
- **Files are strict; the wire is typed.** A document the host cannot read is a refusal naming the file — the
  host does not boot over damage, and does not write over it. On the wire, refusals are the contract's typed
  errors, so the UI can show them.

## The model

- **One Harness = one T3 environment.** Pairing points T3 at one running instance. A different setup (local,
  SSH, sandbox) is a different Harness, paired separately.
- **Project:** a directory in the registry, with a title. New threads in a project get it as their
  conversation's `cwd`. The registry is an index over conversations, each of which records its own `cwd`: a
  lost registry costs names, not work.
- **Thread:** a named pointer (its **head**) to one conversation. One T3 sidebar entry. Forks share history
  in the same storage and inherit model, tools, instructions and `cwd` — `pi.agent` is a conversation-scoped,
  rewindable doc, which is why forks and undos carry it.
- **The host owns conversations only.** Files, checkpoints, branches, worktrees and terminals belong to pi
  and its extensions. T3's git, diff, VCS, PR and terminal calls are refused.

## Configuration tiers

Where a setting lives is decided by who edits it.

| Tier | File | Edited by |
|---|---|---|
| Host | `config.toml` | the integrator, by hand |
| Server settings | `settings.json`, in the data dir | T3's UI, through the host — **T3's own document** |
| Projects | `projects.json`, in the data dir | T3's UI, through the host — the bridge's own file |
| Thread | pi-durable (`pi.agent`) | the client (model and thinking pickers), and the integrator's extensions |

`settings.json` is the contracts' `ServerSettings` **stored the way T3's server stores it, bytes included**: a
sparse JSON document that decodes over the schema's defaults; `server.updateSettings` applies T3's PATCH merge to
the MATERIALIZED settings (nested keys merge, `undefined` keys skipped, everything else replaced); the merged
document is validated by the same decode the next boot performs; a write answers the FULL settings and the change
signal emits `settingsUpdated` on the config stream. What lands in the file is the materialized document with the
contract's defaults stripped (T3's `stripDefaultServerSettings`, its atomic keys compared whole, and the three
drivers whose `enabled` flag provider history cannot recover) — so a key written back at its default costs no
bytes. `providerInstanceMutation` applies T3's instance-map operations, including its refusal of a `create` for an
id the document already has. The bridge interprets none of it — it answers what the client wrote, and the host's
own provider facts fill only keys the file leaves silent. (Deliberately not replicated at this scale: the patch's
per-key special cases, secret redaction, provider-history folding — see [`docs/capabilities.md`](capabilities.md).)

The bridge's own state lives in `projects.json`: the project registry, strict-parsed, one writer, atomic
writes. Paths follow XDG (`$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`), with `--root <dir>` overriding both so an
instance is one directory. Nothing is discovered: `--root`, or these. No project ever defaults into
`~/.local/share` — a project is a path the user chose.

## IDs

- **Thread IDs:** minted by the client on create and fork, honored exactly, so a retried create is a no-op.
  The host mints one only when it promotes a conversation.
- **Project IDs are minted by whoever registers the project.** T3's UI sends a `projectId` on
  `project.create` and navigates to it; the contract's `ProjectId` is a branded trimmed non-empty string and
  T3's server commits it verbatim, so the host honors ANY such id (trimmed), and answers with it after a
  restart. A blank id is not a mint; an id the file cannot store is refused with the typed project error.
  Client-less registrations derive a stable id from the normalized path (`p-<first 16 hex of sha256>`).
- **An id is assigned once and never re-derived.** The first mutation of a derived-id entry stores the id: a
  root MOVE keeps the id — and the project's threads, which reference it. The title is a free label. Both
  keys are guarded at mutation time: `add` refuses a duplicate path (compared NORMALIZED, so `…/alpha` and
  `…/alpha/` are one project) and a minted id another project already owns.
- **A thread's `projectId` is a foreign key,** enforced where rows are written: at COMMIT time (the registry
  lives in the other store; a removal landing mid-call is invisible to any pre-commit check). A row that
  names a project the registry does not answer is reported with its `projectId` and no invented project —
  the shell lists registered projects and nothing else.

## Invariants

The code is the spec for the operations. These are the rules the code cannot show on its own.

- **A write names the conversation the client is showing and carries a `requestId`,** so a retried write
  returns the same result instead of applying twice.
- **A retried project mutation is re-planned against current state and gets the honest answer** — a retried
  create meets the duplicate-path refusal for the project it created, a retried delete the not-found. (T3's
  ProjectService replays accepted receipts from its database; this host keeps no per-command durable state,
  and an honest error beats the machinery. Dispatch commands are the exception: a retried prompt command must
  not run twice, so command ids are answered from a bounded in-memory map.)
- **The files the host writes always parse.** The boot parser is the definition of writable: every rule it
  enforces — normalized path uniqueness, id shape, entry shape — is enforced at mutation time, typed, before
  the write, and the merged settings document is validated by the boot decode. A mutation run against a
  document the parser refuses is refused naming the file, and leaves it byte-identical. Every write goes to a
  unique temp file (`wx`), `chmod`ed 0600 and fsynced before the rename: a fixed temp name lets a crashed
  writer's leftover decide the published mode, since `open(2)` applies `mode` only when it creates.
- **The instance answers emptiness, not damage.** A missing `projects.json` / `settings.json` is valid — an
  empty registry, the contract defaults, with this host's ONE provider fact answered: the `pi` provider instance
  enabled (T3's picker follows the instance map, so without it the app shows no provider at all and will not
  launch a thread), and every driver this host does not serve answered `enabled: false` in the legacy map T3's
  provider pane reads (the contract's default enables them all, and the pane would offer a CLI this host does not
  run). Both facts disappear the moment the document names the key — the UI's own write owns it. An unparseable
  file is a fatal `ConfigError` naming it.
- **Promote is its own commit.** A submit carries nothing else, and commits serialize per Session, so racing
  promotes add one thread.
- **Boot repair:** at start, one commit promotes every conversation with a run or queued input that is
  nobody's head — the crash-between-submit-and-promote gap.
- **Undo forks one entry before the message it reverts** — a fork includes its fork entry, so the reverted
  user message is dropped too; baseline creates a fresh conversation.
- **A delete aborts first, and wins the run.** `Threads.remove` aborts the head so boot repair sees nothing
  owed, then interrupts it again after the commit: a prompt admitted in the abort→commit window loses — a
  thread the document has removed has no live turn. The removal is durable: the removed head is tombstoned in
  the threads document, and the promote path, the undo fork, and boot repair skip tombstones — a thread
  deleted stays deleted, across restarts.
- **A prompt racing an undo converges either way:** prompt first and the undo sees the run and refuses; undo
  first and the prompt's promote makes its conversation a thread.
- **No thread row without a registered project** (the FK rule above), at commit time.
- **Removing a project takes its threads with it** and never touches files on disk. T3's UI always sends
  `force: true` over a dialog promising exactly those two things. The cascade snapshots its targets, deletes
  them, drops the entry, then drains the thread CELL until it shows no rows under the id — rows that landed
  inside the snapshot window; rows racing from `registry.remove` onward are refused by the FK check. The drain
  is bounded; the FK check makes it terminate.
- **Storage only grows.** pi-durable has no delete or GC; removing drops pointers, never data. The threads
  document checkpoints on every write, so the threads list is a current read.
- **Shutdown is bounded, not fully graceful** (the example's `shutdown.ts`): Ctrl-C and SIGTERM run the close
  under a short grace, then exit; a second signal exits at once.

## chord objects

What the T3 facet calls, and what any other pi client could call. Per-thread objects are keyed by
`{ threadId }`.

| Object | State | Methods |
|---|---|---|
| `pi.threads` | `{ revision, projects, threads }` (the doc also keeps applied undo `requestId`s and removal tombstones) | `create`, `remove` |
| `pi.transcript` | the head's `ConversationView` plus `conversationId` | |
| `pi.controller` | | `prompt`, `steer`, `followUp`, `abort`, `rewind` |
| `pi.models` | `{ catalog, configuration }` | `select`, `selectThinking` |

The threads layer also owns the project registry (list / add / update / remove) in `projects.json`, writing
the file rather than a chord. T3 reads projects from the shell snapshot's `projects` field and edits them
through the sendable `projects.mutate` (`project.create` / `project.update` / `project.delete`) — not a
`projects.list`/`add`/`remove` call, which is not on the reachable surface.

Errors, by tier. The chord objects answer with **codes**: `unknown_project`, `unknown_thread`,
`turn_running`, `not_rewindable`, `unknown_model`, `unknown_thinking_level`. Project mutations are answered
as the contract's `ProjectMutationError` with a message a client shows as it is. Settings writes answer the
contract's `ServerSettingsError` (naming the file and the operation). A model the catalog does not have is
refused by name at selection time — availability is the Harness's; the client owns the choice.

## T3 facet

The T3-facing bridge (`src/t3/`) is a local client of the chord objects. The facet owns the HTTP port,
speaks T3's orchestration v2 wire protocol over HTTP plus `/ws`, and drives the bridge in-process.

- **Wire surface** matches stock T3: the 10 HTTP routes (discovery, pairing, tickets, the shell and thread
  snapshots, and the `/api/projects` + `/api/projects/mutate` parity pair) plus `/ws`, with
  `orchestrationProtocol=2`, a one-shot ticket, Effect RPC over JSON, and a `serverVersion` equal to the
  vendored contracts version.
- **A parity route validates like the RPC it parallels.** `/api/projects/mutate` decodes its body with the
  contract's `ProjectMutation` — parity is the validation, not just the URL.
- **A rate limiter keys on the socket, not on a header.** `x-forwarded-for` is client-supplied; trusting it
  on a loopback bind lets a caller mint a fresh bucket per attempt.
- **Effect stays inside the facet;** the boundary is the RPC handler table.
- T3 sends a thread ID; the facet supplies the `conversationId` from the snapshot it last sent for that
  thread, and `expectedHead` for undo. Cold-thread writes await the head, so the first message is never
  dropped.
- `appCanCheckpointFilesystem: false`; `restoreFiles: true` is refused.
- Promoted and forked threads carry `lineage.parentThreadId` and `relationshipToParent: "fork"`.
- **Undo of a head that already moved on becomes a thread.** Clutter is the price of conflicts-never-error.
- **A restart shows a reverted thread with fewer runs.** The rolled-back-runs overlay is in memory on
  purpose: the runs it lists no longer exist in the conversation.
