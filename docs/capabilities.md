# Capabilities

Every call T3's web app makes, and what this host answers. ✅ works · 🔜 next (refused with "… yet") ·
🕐 later · ❌ never (refused on purpose). A refused call returns a message the UI shows. A refused stream
ends with that message rather than hanging open.

| Area | Calls | | Notes |
|---|---|:-:|---|
| Connection & config | `server.probe`, `server.getConfig`, `server.getSettings`, `server.refreshProviders`, `server.reportClientActivity`, `subscribeServerConfig`, pairing, tickets | ✅ | `getSettings` answers T3's settings document; the config stream pushes `settingsUpdated` |
| Shell & thread reads | `orchestration.subscribeShell`, `orchestration.subscribeThread`, `orchestration.getThreadProjection`, `orchestration.launchThread` | ✅ | projects ride the shell snapshot |
| Threads | `orchestration.dispatchCommand`: `thread.create`, `thread.delete`, `message.dispatch`, `run.interrupt`, `thread.model-selection.set` | ✅ | create, prompt, steer, queue, interrupt, delete |
| Undo | `checkpoint.rollback` | ✅ | forks before the reverted message; history is never rewritten |
| Model & thinking | `modelSelection` on create/launch/prompt, `thread.model-selection.set` | ✅ | passed through. Thinking is T3's `thinking` option, offered only for models that reason. A run's model is read from the message pi recorded |
| Crash resume | `message.dispatch` and the resumed run | ✅ | see the clip in the README |
| Sidebar bookkeeping | `thread.visit`, `thread.mark-unread`, `thread.settle`, `thread.unsettle`, `thread.auto-settle`, `thread.auto-settle.set`, `thread.pin`, `thread.unpin`, `thread.pin.reorder`, `thread.active.reorder`, `notification.delivery.accept` | ✅ | acknowledged; T3 keeps these client-side |
| Projects | `projects.mutate` (`project.create`/`update`/`delete`), `/api/projects/mutate` | ✅ | ids honored, the same folder can't be added twice, removing a project removes its threads but not its files |
| Settings | `server.updateSettings` | ✅ | T3's merge and validation, replicated. Not replicated: per-key special cases, secret redaction, provider history |
| Folder picker | `filesystem.browse` | ✅ | directories only, for Add project |
| Thread fork | `thread.fork`, `thread.merge_back` | 🔜 | undo already forks |
| Thread rename | `thread.metadata.update` | 🔜 | |
| Archive, snooze | `thread.archive`, `thread.unarchive`, `thread.snooze`, `thread.unsnooze`, archived-shell snapshot/subscribe | 🔜 | |
| Queued messages | `queued-*`, `queue.resume` | 🔜 | pi-durable has the queue; editing it from the UI is missing |
| Attachments | `attachments.*`, `assets.*` | 🕐 | prompts are text; no asset store |
| Search | `projects.searchEntries`, `projects.searchContents`, `orchestration.searchThreads` | 🕐 | needs an index |
| Usage | `server.getUsageSummary`, `server.refreshUsageRates` | 🕐 | |
| Scheduled tasks | `scheduledTasks.*` | 🕐 | |
| Host diagnostics | `server.getHostResources`, `server.getProcessDiagnostics`, `server.getProcessResourceHistory`, `server.getTraceDiagnostics`, `server.getResourceTelemetryHistory`, `server.retryResourceTelemetry`, `subscribeResourceTelemetry`, `server.signalProcess`, `server.getBackgroundPolicy`, `server.reportHostPowerState`, `subscribeBackgroundPolicy`, `server.getDatabaseStorage` | 🕐 | `server.getDatabaseStorage` (SQLite file accounting for T3's state DB, new in 0.1) is gated by the `databaseStorage` descriptor capability, which this host does not advertise, so the client never sends it; the RPC layer refuses it if it arrives |
| Workflow scripts, turn items | `orchestration.getWorkflowScript`, `orchestration.getTurnItem` | 🕐 | |
| File access | `projects.readFile`, `projects.writeFile`, `projects.listEntries`, `projects.createNew`, `projects.ensureScratch` | ❌ | the agent edits files itself |
| Git, PRs, diffs, worktrees | `git.*`, `pullRequests.*`, `vcs.*`, `sourceControl.*`, `review.*`, `projectClone.*`, `worktreeSetup.*`, `subscribeVcsStatus`, `subscribeWorktreeSetup`, `subscribeProjectClones`, `orchestration.getTurnDiff`, `orchestration.getFullThreadDiff`, `thread.pull-request*`, `server.discoverSourceControl` | ❌ | the agent uses `git` itself |
| File restore on undo | `checkpoint.rollback` with `restoreFiles: true` | ❌ | files belong to the agent |
| Terminal | `terminal.*`, `subscribeTerminalEvents`, `subscribeTerminalMetadata`, `orchestration.subscribeCommandOutput` | ❌ | tools run in the Harness. `orchestration.subscribeCommandOutput` (live command-row output, new in 0.1) is gated by the `commandOutputStreaming` descriptor capability, which this host does not advertise, so the client never opens the stream; the RPC layer refuses it if it arrives |
| Editor, previews, browser | `shell.openInEditor`, `preview.*`, `mcpApps.*`, `subscribePreviewEvents`, `subscribeDiscoveredLocalServers` | ❌ | |
| Devices, relay, cloud | `device.*`, `cloud.*`, `subscribeDeviceState` | ❌ | another machine is another Harness |
| Providers | `provider.*`, `provider.switch`, `subscribeAuthAccess`, `server.updateProvider`, `server.*AcpRegistry*` | ❌ | one provider, pi. T3's other providers show as Disabled |
| Approvals, plan mode | `runtime-request.respond`, `thread.user-input.dismiss`, `thread.runtime-mode.set` (other than `full-access`), `thread.interaction-mode.set` (plan) | ❌ | pi runs tools without approvals |
| Orchestrator-internal | `delegated_task.*`, `prepared-run.*`, `provider-session.detach`, `thread.created.record`, `thread.title.regeneration.complete` | ❌ | no such objects in pi-durable |
| Self-update, keybindings | `server.updateServer`, `server.updateServerWithProgress`, `subscribeServerLifecycle`, `server.commitDesktopUpdate`, `server.uninstallAcpRegistryManagedBinary`, `server.upsertKeybinding`, `server.removeKeybinding` | ❌ | refused honestly; the descriptor advertises no `serverSelfUpdate`, so the client offers a manual relaunch command and never sends an update RPC. `serverVersion` is the pinned T3 release, never the client's, so the update banner shows how far the pin is behind |
| Imported sessions | `agentSessions.import`, `agentSessions.*` (rest) | ❌ | nothing is importable on this host: the agent's conversations live in pi-durable, not a Codex/Claude home dir |
| Session scan | `agentSessions.scan` | ✅ | answered truthfully with an empty scan, so onboarding step 3 shows "nothing to import" instead of hanging on a refusal |
| Secrets | `secrets.answerRequest` | ❌ | tools inherit the host's environment |
