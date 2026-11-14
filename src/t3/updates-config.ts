// The integrator's side of the host's updates (`attachT3`'s `updates`); `host-updates.ts` tells T3. A file of its own:
// the package's public types name nothing of T3's.

/** An integrator's own versions and how it moves between them (`attachT3`'s `updates`). */
export type HostUpdates = {
	/**
	 * The version that runs, and the newest there is (absent: nothing newer can be told, such as a pinned version).
	 * `note` is shown where T3 says an update is available, in place of its "install vX": for what the user should
	 * know before pressing it. Called when the bridge starts, hourly, and from Settings → Providers' Refresh.
	 */
	check(options: { readonly signal: AbortSignal }): Promise<{ readonly current: string; readonly latest?: string; readonly note?: string }>;
	/**
	 * Install the newest version, without restarting: resolves with the version installed (the one that runs, when
	 * there was nothing newer) and optionally what the install printed, which T3 shows.
	 */
	install(): Promise<{ readonly version: string; readonly output?: string }>;
	/** Restart into the installed version. Called once T3 has its answer, so the answer is not lost with the process. */
	restart(): void;
	/** The command a person would run instead; T3 shows it beside its button. */
	readonly command: string;
};
