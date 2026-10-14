# Capabilities

What T3 Code asks this host for, and what it gets. T3's web app sends all of these; a call this host
refuses comes back with a message, and T3 hides the control. Refusing is deliberate — a panel that
pretends to work is worse than an absent one (see [`design.md`](design.md)).

**✅ works · 🔜 soon** (planned, the mechanism exists) **· 🕐 later** (needs real work, or a feature
pi-durable doesn't have) **· ❌ never** (on purpose; the reason is in the row)

The statuses are the code's, not a wish list: a 🔜 call is refused with *"… yet"*, and a 🕐 or ❌ one is
refused flatly.

| Area | Calls | | Why |
|---|---|:-:|---|
| Connection | `server.probe`, `server.getConfig`, `server.getSettings`, `server.reportClientActivity`, pairing and tickets | ✅ | one Harness is one T3 environment |
| Settings writes | `server.updateSettings` | 🔜 | the host-wide defaults go to `settings.json`; `server.getSettings` answers from defaults until then |
| Threads | `thread.create`, `thread.delete`, `message.dispatch`, `run.interrupt`, `thread.stop` | ✅ | create, prompt, steer, queue, restart, interrupt, delete (delete aborts the run first) |
| Model per thread | `thread.model-selection.set`, the model picker | ✅ | the catalog is your pi config; one provider, pi |
| Undo | `checkpoint.rollback` | ✅ | forks just before the reverted message; never rewrites history |
| Sidebar bookkeeping | `thread.visit`, `thread.mark-unread`, `thread.settle`, `thread.unsettle`, `thread.auto-settle`, `thread.pin`, `thread.unpin`, `thread.pin.reorder`, `thread.active.reorder` | ✅ | acknowledged; T3 keeps the ordering and flags client-side |
| Projects | `projects.list`, and each thread's `cwd` | ✅ | every thread runs in its project's directory |
| Project registry | `projects.add`, `projects.remove`, `filesystem.browse` | 🔜 | the folder picker is how a project gets added; browse is read-only for that dialog |
| Thread fork | `thread.fork`, `thread.merge_back` | 🔜 | the undo fork is already the mechanism |
| Thread rename | `thread.metadata.update` | 🔜 | the title is a field on the thread pointer |
| Archive, snooze | `thread.archive`, `thread.unarchive`, `thread.snooze`, `thread.unsnooze` | 🔜 | sidebar plumbing exists; the threads-layer semantics are missing |
| Queued messages | `queued-*`, `queue.resume` | 🔜 | the queue is pi-durable's; editing its entries from the UI is the missing half |
| Instructions | per-thread instructions, `instructions` (config) | ✅ | read at thread create, inherited by forks and undos |
| Project instructions | per-project `AGENTS.md` | 🔜 | loaded like `instructions`: once at thread create, through the env's file API |
| Crash resume | — | ✅ | kill the host mid-turn, restart, the turn finishes; see the clip in the README |
| Attachments, images in prompts | `attachments.*`, `assets.createUrl`, `assets.persistChatAttachments` | 🕐 | the threads layer takes images; the host has no asset store to receive them |
| Search | `projects.searchEntries`, `projects.searchContents` | 🕐 | needs an index over conversations |
| Usage | `server.getUsageSummary`, `server.refreshUsageRates` | 🕐 | pi-durable keeps per-conversation usage; T3's panels expect provider quotas too |
| Scheduled tasks | `scheduledTasks.*` | 🕐 | pi-durable's task tree can host them; the orchestration semantics are the work |
| Host diagnostics | `server.getHostResources`, `server.getProcessDiagnostics`, `server.getProcessResourceHistory`, `server.getTraceDiagnostics`, `server.getResourceTelemetryHistory`, `server.signalProcess` | 🕐 | one process, one machine; nothing to correlate yet |
| File access | `projects.readFile`, `projects.writeFile`, `projects.listEntries`, `projects.mutate` | ❌ | the agent has `bash` and edits files itself; a facet-side file API makes the facet a second owner of the workspace |
| Git, PRs, diffs, worktrees | `git.*`, `pullRequests.*`, `vcs.*`, `sourceControl.*`, `review.*`, `projectClone.*`, `worktreeSetup.*` | ❌ | the agent works in real repos with `git`; mirroring repo state would put the facet in charge of it |
| File restore | `checkpoint.rollback` with `restoreFiles: true` | ❌ | filesystem ownership belongs to the Harness and its extensions, not to a threads layer |
| Terminal | `terminal.*` | ❌ | the host runs no interactive terminal; tools run in the Harness |
| Editor, previews, browser | `shell.openInEditor`, `preview.*`, `mcpApps.*` | ❌ | no editor, no dev-server supervision, no browser automation in a threads layer |
| Devices, relay, cloud | `device.*`, `cloud.*` | ❌ | a remote machine is another Harness, paired separately |
| Providers | `provider.switch`, `provider.consumeResetCredit`, `provider.uploadFeedback`, `server.*AcpRegistry*` | ❌ | one provider: pi. ACP registries and per-provider credits are T3's provider system, not pi's |
| Approvals, plan mode | `runtime-request.respond`, `thread.runtime-mode.set` (not `full-access`), `thread.interaction-mode.set` (plan) | ❌ | pi runs tools without approvals, so there is nothing to answer and no plan-only mode |
| Self-update | `server.updateServer`, `server.updateServerWithProgress`, `server.commitDesktopUpdate`, `server.uninstallAcpRegistryManagedBinary` | ❌ | the host updates with your package manager, or with the container image |
| Imported sessions | `agentSessions.*` | ❌ | a thread is a pi-durable conversation; there is no external agent session to import |
| Secrets | `secrets.answerRequest` | ❌ | tools inherit the host's environment; there is no prompt to answer |

## Not a capability, a consequence

- **Storage only grows.** pi-durable has no delete or GC. Deleting a thread or a project drops pointers;
  the conversations stay in `durable.db`.
- **The agent runs `bash` as the host user, with no approvals,** in the project directory you added.
  Bind address, CORS and the Host check are in `host.toml`; loopback is the default.
- **Shells survive a crash.** pi-durable starts them detached (on non-Windows), so they outlive a killed
  host; run under systemd to clean them up.
- **Reconnect takes a minute.** After a host restart, T3's socket reconnects on its own backoff; press
  Retry to skip the wait.
- **Some panels stay visible.** T3 shows the terminal drawer, the diff view and the folder picker; the
  first two fail with the refusal above, and the picker appears once `filesystem.browse` lands.
