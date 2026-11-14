// The host's own updates, shown the way T3 shows a provider's: on this host the provider "pi" is the integrator's
// agent, so its version is the host's. T3 keeps a version advisory on each provider (what runs, the newest there is,
// the command that updates it) and offers Update where one is behind: in Settings → Providers, in the sidebar, and in
// "Update everything", in the web app and the desktop app alike. `server.updateProvider` is that button. The
// integrator says what runs and what is newest, installs, and restarts itself; the bridge only tells T3.
//
// T3's other update, of the server itself (`server.updateServer`), is not this: it brings a T3 server to the T3
// version of the client that asks, and is offered only where the server's T3 version is behind the client's.
import type { ServerProvider } from "@t3tools/contracts";
import type { Logger } from "./logging.ts";
import type { HostUpdates } from "./updates-config.ts";

/** How often the newest version is looked for. */
export const HOST_UPDATE_CHECK_MS = 3_600_000;
const CHECK_TIMEOUT_MS = 30_000;
/** How long T3 has to receive the answer before the host restarts. */
export const RESTART_AFTER_MS = 1_000;
/** T3's limit on the output it keeps of an update. */
const OUTPUT_LIMIT = 10_000;

type Advisory = NonNullable<ServerProvider["versionAdvisory"]>;
type UpdateState = NonNullable<ServerProvider["updateState"]>;
export type ProviderVersion = { readonly version: string; readonly versionAdvisory: Advisory; readonly updateState?: UpdateState };

const text = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim() || "It failed without saying why.";

export class HostUpdateWatch {
	readonly #updates: HostUpdates;
	readonly #changed: () => void;
	readonly #log: Logger | undefined;
	#current: string | undefined;
	#latest: string | undefined;
	#checkedAt: string | null = null;
	#checkError: string | null = null;
	#note: string | null = null;
	#state: UpdateState | undefined;
	#checking: Promise<void> | undefined;
	#updating: Promise<void> | undefined;

	constructor(updates: HostUpdates, changed: () => void, log?: Logger) {
		this.#updates = updates;
		this.#changed = changed;
		this.#log = log;
	}

	/** What the provider's snapshot says of the version; nothing before the first check has answered. */
	snapshot(): ProviderVersion | undefined {
		if (this.#current === undefined) return undefined;
		const behind = this.#latest !== undefined && this.#latest !== this.#current;
		return {
			version: this.#current,
			versionAdvisory: {
				status: behind ? "behind_latest" : this.#checkError === null ? "current" : "unknown",
				currentVersion: this.#current,
				latestVersion: this.#latest ?? null,
				updateCommand: this.#updates.command,
				canUpdate: true,
				checkedAt: this.#checkedAt,
				message: this.#checkError ?? this.#note,
			} as Advisory,
			...(this.#state === undefined ? {} : { updateState: this.#state }),
		};
	}

	/** Ask the integrator what runs and what is newest. A failure is logged and said in the advisory. One at a time. */
	check(): Promise<void> {
		this.#checking ??= (async () => {
			try {
				const answer = await this.#updates.check({ signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
				this.#current = answer.current;
				this.#latest = answer.latest;
				this.#note = answer.note?.trim() || null;
				this.#checkError = null;
			} catch (error) {
				this.#checkError = `Could not look for a newer version: ${text(error)}`;
				this.#log?.warn("host update check failed", { error: text(error) });
			}
			this.#checkedAt = new Date().toISOString();
			this.#checking = undefined;
			this.#changed();
		})();
		return this.#checking;
	}

	/**
	 * T3's Update button: install, say how it went in the provider's update state, and, when a newer version was
	 * installed, restart into it once T3 has had time to receive the answer. A second press while one runs joins it.
	 */
	update(): Promise<void> {
		this.#updating ??= (async () => {
			const startedAt = new Date().toISOString();
			const end = (status: UpdateState["status"], message: string, output?: string) => {
				this.#state = { status, startedAt, finishedAt: new Date().toISOString(), message, output: output === undefined ? null : output.slice(-OUTPUT_LIMIT) } as UpdateState;
				this.#updating = undefined;
				this.#changed();
			};
			this.#state = { status: "running", startedAt, finishedAt: null, message: null, output: null } as UpdateState;
			this.#changed();
			try {
				const installed = await this.#updates.install();
				if (installed.version === this.#current) return end("unchanged", `Version ${installed.version} is the newest.`, installed.output);
				this.#log?.info("host update installed; restarting", { from: this.#current, to: installed.version });
				end("succeeded", `Version ${installed.version} is installed. Restarting into it.`, installed.output);
				setTimeout(() => this.#updates.restart(), RESTART_AFTER_MS);
			} catch (error) {
				this.#log?.warn("host update failed", { error: text(error) });
				end("failed", text(error).slice(0, 2_000));
			}
		})();
		return this.#updating;
	}

	/** Check now and every `HOST_UPDATE_CHECK_MS`, in the background; the returned function stops it. */
	watch(): () => void {
		void this.check();
		const timer = setInterval(() => void this.check(), HOST_UPDATE_CHECK_MS);
		timer.unref();
		return () => clearInterval(timer);
	}
}
