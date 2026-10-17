# Capabilities

What T3 Code asks this host for, and what it gets. T3's web app sends all of these; a call this host
refuses comes back with a message, and T3 hides the control. Refusing is deliberate — a panel that
pretends to work is worse than an absent one (see [`design.md`](design.md)).

**✅ works · 🔜 soon** (planned, the mechanism exists) **· 🕐 later** (needs real work, or a feature
pi-durable doesn't have) **· ❌ never** (on purpose; the reason is in the row)

The statuses are the code's, not a wish list: a 🔜 call is refused with *"… yet"*, and a 🕐 or ❌ one
is refused flatly. A refused **stream** dies with that same message — the panel closes, it does not
hang open waiting.

| Area | Calls | | Why |
|---|---|:-:|---|
| Connection & config | `server.probe`, `server.getConfig`, `server.getSettings`, `server.refreshProviders`, `server.reportClientActivity`, `subscribeServerConfig` (stream), pairing and tickets | ✅ | pairing points T3 at one Harness ([the model](design.md)); `getSettings` answers T3's own `ServerSettings` document (the data dir's `settings.json`, stored as T3's server stores it); the config stream pushes `settingsUpdated` on every settings write and registry change, so an edit lands in the pane that made it |
| Shell & thread reads | `orchestration.subscribeShell`, `orchestration.subscribeThread`, `orchestration.subscribeArchivedShell` (streams), `orchestration.getThreadProjection`, `orchestration.getArchivedShellSnapshot`, `orchestration.launchThread` | ✅ | the thread list and the projects ride the shell snapshot's `projects` field, not a `projects.list` call; the transcript streams as a thread projection; a launch refusal answers the contract's typed launch error, naming the project the client asked about |
| Threads | `orchestration.dispatchCommand` and its `thread.create`, `thread.delete`, `message.dispatch`, `run.interrupt`, `thread.model-selection.set` commands | ✅ | create, prompt, steer, queue, restart, interrupt, delete (delete aborts the run first and wins it: a prompt admitted mid-delete is interrupted, and the tombstone holds across restarts) |
| Undo | `checkpoint.rollback` | ✅ | forks just before the reverted message; never rewrites history |
| Sidebar bookkeeping | `thread.visit`, `thread.mark-unread`, `thread.settle`, `thread.unsettle`, `thread.auto-settle`, `thread.auto-settle.set`, `thread.pin`, `thread.unpin`, `thread.pin.reorder`, `thread.active.reorder`, `notification.delivery.accept` | ✅ | acknowledged; T3 keeps the ordering and flags client-side |
| Model per thread | `thread.model-selection.set`, the model picker, `modelSelection` on create/launch/prompt | ✅ | model SELECTION is T3's — the client names the model on every thread create and launch (the contract requires it), the bridge applies it and computes no defaults; model AVAILABILITY is the Harness's — the catalog is what the integrator handed in, and a model it does not have is refused by name at selection time |
| Instructions | per-thread instructions | ✅ | the integrator's tier: the example host reads its `instructions` file at thread create (the `newThread` hook); forks and undos inherit it |
| Crash resume | `message.dispatch` + the resumed run | ✅ | kill the host mid-turn, restart, the turn finishes; see the clip in the README |
| Project registry | `projects.mutate` (`project.create` / `project.update` / `project.delete`), and the `/api/projects/mutate` parity route | ✅ | the UI adds/edits/removes projects in the registry file (`projects.json`, in the data dir); the id is minted by whoever registers it — any id the contract's `ProjectId` accepts is honored (trimmed, and a hand-edited stored id is normalized on read, so the id shown is the id that names the project); a client-less registration derives one from the normalized path, and the first mutation pins it (an id is assigned once and never re-derived) — the path is the uniqueness key so a duplicate workspace is refused, a minted id that is already taken is refused, a title rename is free, a root move keeps the id and its threads, and a delete cascades threads and drains late arrivals by foreign key (files on disk untouched, `force` for a non-empty removal; a removed thread stays removed across restarts). Both transports validate the command against the contract's `ProjectMutation`, so one JSON means one thing on `/ws` and over REST. A retried command is re-planned against current state and gets the honest answer — a retried create meets the duplicate-path refusal for the project it created, a retried delete the not-found (T3's ProjectService replays receipts from its database; this host keeps no per-command durable state, and the honest error beats the machinery). See [the invariant](design.md). `projects.list`/`projects.add`/`projects.remove` are **not on the sendable surface** — projects ride the shell snapshot, and edits go through `projects.mutate` |
| Settings writes | `server.updateSettings` | ✅ | T3's semantics, replicated: the patch merges into the stored document (nested keys merge, `undefined` skipped, everything else replaces), the result is validated by the decode the next boot performs, the write answers the FULL settings, and the stream emits `settingsUpdated`. A write that cannot persist answers the contract's `ServerSettingsError` (naming the file and the operation), not a defect. The bridge interprets nothing: the UI owns the document. Not replicated at this scale (documented deviations): the patch's per-key special cases (project-override maps, background-activity profiles), secret redaction, provider-history folding — writes of those keys answer what was written; nothing reads them |
| Folder picker | `filesystem.browse` | ✅ | read-only, feeds the "Add project" picker (directories only, prefix filter, `~` expansion) |
| Thread fork | `thread.fork`, `thread.merge_back` | 🔜 | the undo fork is already the mechanism |
| Thread rename | `thread.metadata.update` | 🔜 | the title is a field on the thread pointer |
| Archive, snooze | `thread.archive`, `thread.unarchive`, `thread.snooze`, `thread.unsnooze` | 🔜 | sidebar plumbing exists; the threads-layer semantics are missing |
| Queued messages | `queued-*`, `queue.resume` | 🔜 | the queue is pi-durable's; editing its entries from the UI is the missing half |
| Attachments, images in prompts | `attachments.*`, `assets.*` | 🕐 | the threads layer takes images; the host has no asset store to receive them |
| Search | `projects.searchEntries`, `projects.searchContents`, `orchestration.searchThreads` | 🕐 | needs an index over conversations |
| Usage | `server.getUsageSummary`, `server.refreshUsageRates` | 🕐 | pi-durable keeps per-conversation usage; T3's panels expect provider quotas too |
| Scheduled tasks | `scheduledTasks.*` (incl. the `subscribe` stream) | 🕐 | pi-durable's task tree can host them; the orchestration semantics are the work |
| Host diagnostics | `server.getHostResources`, `server.getProcessDiagnostics`, `server.getProcessResourceHistory`, `server.getTraceDiagnostics`, `server.getResourceTelemetryHistory`, `server.retryResourceTelemetry`, `subscribeResourceTelemetry`, `server.signalProcess`, `server.getBackgroundPolicy`, `server.reportHostPowerState`, `subscribeBackgroundPolicy` | 🕐 | one process, one machine; nothing to correlate, and no mobile/background policy to serve |
| Workflow scripts, turn items | `orchestration.getWorkflowScript`, `orchestration.getTurnItem` | 🕐 | reads for the workflow/timeline surfaces the threads layer does not project |
| File access | `projects.readFile`, `projects.writeFile`, `projects.listEntries`, `projects.createNew`, `projects.ensureScratch` | ❌ | the agent has `bash` and edits files itself; a facet-side file API makes the facet a second owner of the workspace. `projects.mutate` carries **only** the project operations (create/update/delete) — see the project registry row — there are no file/dir operations to refuse inside it |
| Git, PRs, diffs, worktrees | `git.*`, `pullRequests.*`, `vcs.*`, `sourceControl.*`, `review.*`, `projectClone.*`, `worktreeSetup.*`, `subscribeVcsStatus`, `subscribeWorktreeSetup`, `subscribeProjectClones`, `orchestration.getTurnDiff`, `orchestration.getFullThreadDiff`, `thread.pull-request*`, `server.discoverSourceControl` | ❌ | the agent works in real repos with `git`; mirroring repo state would put the facet in charge of it |
| File restore | `checkpoint.rollback` with `restoreFiles: true` | ❌ | filesystem ownership belongs to the Harness and its extensions, not to a threads layer |
| Terminal | `terminal.*`, `subscribeTerminalEvents`, `subscribeTerminalMetadata` | ❌ | the host runs no interactive terminal; tools run in the Harness |
| Editor, previews, browser | `shell.openInEditor`, `preview.*`, `mcpApps.*`, `subscribePreviewEvents`, `subscribeDiscoveredLocalServers` | ❌ | no editor, no dev-server supervision, no browser automation in a threads layer |
| Devices, relay, cloud | `device.*`, `cloud.*`, `subscribeDeviceState` | ❌ | a remote machine is another Harness ([the model](design.md)) |
| Providers | `provider.*` (auth, install, credits, feedback), `provider.switch`, `subscribeAuthAccess`, `server.updateProvider`, `server.*AcpRegistry*` | ❌ | one provider: pi. ACP registries and per-provider auth/credits are T3's provider system, not pi's |
| Approvals, plan mode | `runtime-request.respond`, `thread.user-input.dismiss`, `thread.runtime-mode.set` (not `full-access`), `thread.interaction-mode.set` (plan) | ❌ | pi runs tools without approvals, so there is nothing to answer and no plan-only mode |
| Orchestrator-internal | `delegated_task.*`, `prepared-run.*`, `provider-session.detach`, `thread.created.record`, `thread.title.regeneration.complete` | ❌ | subagent tasks, workspace-prepared runs, provider-session detach: pi-durable threads are none of these objects |
| Self-update & server mgmt | `server.updateServer`, `server.updateServerWithProgress`, `subscribeServerLifecycle`, `server.commitDesktopUpdate`, `server.uninstallAcpRegistryManagedBinary`, `server.upsertKeybinding`, `server.removeKeybinding` | ❌ | the host updates with your package manager, or with the container image; keybindings are a host file, not a T3 setting |
| Imported sessions | `agentSessions.*` | ❌ | a thread is a pi-durable conversation; there is no external agent session to import |
| Secrets | `secrets.answerRequest` | ❌ | tools inherit the host's environment; there is no prompt to answer |

## Not a capability, a consequence

- **Storage only grows:** deleting drops pointers, never data ([the T3 facet](design.md)).
- **The agent runs `bash` as the host user, with no approvals** — the warning, and the bind/`Host`/
  CORS story, is in [`README.md`](../README.md).
- **Reconnect takes ~75s.** After a host restart, T3's socket reconnects on its own backoff; press
  Retry to skip the wait.
