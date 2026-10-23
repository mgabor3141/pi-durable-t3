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
  hides them. Files are shared: the file panel works on the folders the host knows (a project's root, a thread's
  own folder). `workspaceRoot` can confine the picker, project registry and panel to one tree; without it a paired
  client can add any folder, so pairing is the boundary. The agent may edit the same file at the same time (last write wins). A panel that pretends to work is worse than none. Where the UI cannot proceed without an answer,
  the answer is the truth: an empty session scan, a lifecycle stream that says "ready" and nothing more.
- **Strict files.** A file the host cannot read stops it at boot, naming the file. The host never writes a
  file it could not read back.
- **One host per state dir.** No cross-process locking. The state dir pairs with the Harness's storage —
  the Harness's threads point at project ids in the dir's `projects.json` — so back up and move them together.

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

- **A run is one user turn.** A user message that arrives while a run is in progress steers that run.
- **Retries are answered from state.** A prompt's command id becomes pi-durable's request id, so a resent
  prompt runs once, even across a restart. A resent project create finds the entry it already wrote and
  answers with it.
- **Undo forks just before the reverted message.** The thread's head moves to the fork; the old conversation
  keeps every entry. The reverted runs stay in the projection marked rolled back; without that, T3 reads the
  thread as busy.
- **Undo of a head that already moved on adds a child thread** instead of failing.
- **A delete wins.** Deleting a thread aborts its run, and the removal is recorded in the threads document.
  Promotion and undo skip removed threads, so a deleted thread stays deleted across restarts.
- **Removing a project removes its threads** and never touches files on disk.
- **Unknown threads are a typed not-found** on every path, never an empty thread made up on the spot.
- **Storage only grows.** pi-durable has no delete. Removing drops pointers, never data.

## Facet

The facet serves T3's HTTP routes and `/ws` (orchestration protocol 2, Effect RPC over JSON), and talks to
the threads layer through chord objects that any pi client could also call:

| Object | Methods |
|---|---|
| `pi.threads` | `create`, `remove`, `rename`, `search` |
| `pi.transcript` | (state: the head's conversation view) |
| `pi.controller` | `prompt`, `steer`, `followUp`, `abort`, `rewind` |
| `pi.models` | `select`, `selectThinking` |

Rate limiting keys on the socket address, never on a client-supplied header.

**Auth is the boundary; there is no `Host` check, like T3.** Every route that is not public requires a credential, and
the browser-session cookie — the one credential a page can ride — authenticates only a same-origin request (T3's
`EnvironmentAuth.isBrowserOriginAllowed`). A page that rebinds a hostname onto the listener therefore arrives with no
credentials: it reads the public descriptor and spends the pairing rate limit, and nothing else
(`test/auth-boundary.test.ts`).
