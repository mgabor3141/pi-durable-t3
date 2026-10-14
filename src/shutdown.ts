// Signal-driven shutdown for the reference host. Ctrl-C (SIGINT) and SIGTERM stop the host fast and predictably:
// print one line, time-box the graceful close, then force the process out. A second signal exits immediately.
//
// Why force an exit: a graceful close runs `facet.close()` → `server.close()` → `runtime.close()`, and the last of
// these reaches pi-durable's scheduler `join()`, which aborts every in-flight run's signal and then AWAITS its
// invocation. A turn whose in-flight work ignores that signal — a real model provider's HTTP stream that lingers after
// abort — never settles, so a fully graceful close can hang for tens of seconds. We bound it: race the close against a
// short timeout and force `process.exit(0)` so the event loop (an unref'd handle, a lingering socket, a non-abortable
// invocation) can never keep us alive. Crash-safety is pi-durable's job: commits are durable, and an aborted turn
// resumes on the next start (see test/crash-restart.test.ts). A forced exit is exactly that crash.
const GRACE_MS = 1_500;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Install SIGINT/SIGTERM handlers that stop the host within ~2 s. On the first signal: print "stopping", run `close()`
 * under a short grace, then `process.exit(0)`. A second signal calls `process.exit(0)` at once (uncleanly if `close()`
 * is mid-flight). `close()` is the best-effort graceful teardown (facet server, objects host, storage); it is allowed to
 * reject and is never awaited past the grace.
 */
export function installShutdown(close: () => Promise<void>): void {
	let stopping = false;
	const onSignal = (): void => {
		// Second signal (during the grace): exit now, skipping the in-flight close.
		if (stopping) process.exit(0);
		stopping = true;
		console.log("stopping");
		// Best-effort graceful close, bounded: a close that hangs (an in-flight turn that ignores its abort signal)
		// must not push shutdown past the grace. Force the exit either way.
		void Promise.race([close().catch(() => {}), delay(GRACE_MS)]).finally(() => process.exit(0));
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, onSignal);
}
