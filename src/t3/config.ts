// The T3 facet's configuration: the integrator-owned static fields from `attachT3`, the live project registry
// (`../registry.ts`), and the live settings store over the state dir (`../settings.ts`). The facet reads them live.
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { ProjectRegistry } from "../registry.ts";
import type { ServerSettingsStore } from "../settings.ts";

/** What the bridge asks of `attachT3`'s `titleThread` hook (T3's `ThreadTitleRegenerationService` input, on pi's terms). */
export type TitleThreadRequest = {
	readonly threadId: string;
	/** The thread's head conversation. */
	readonly conversationId: ConversationId;
	/** "first-message": the first user entry; "regenerate": the head's latest entry. */
	readonly at: EntryId;
	readonly reason: "first-message" | "regenerate";
	/** The title being replaced; "regenerate" only. */
	readonly previousTitle?: string;
	/** Aborted when a rename or a newer request supersedes this one. */
	readonly signal: AbortSignal;
};

/** The integrator's title generator: a title, or `undefined` / "New thread" (/ the same title on regenerate) for no change. */
export type TitleThread = (request: TitleThreadRequest) => Promise<string | undefined>;

/** The facet's integrator-owned fields, assembled once from `attachT3`'s options. */
export interface FacetConfig {
	readonly host: string;
	readonly port: number;
	readonly label: string;
	/** The bridge's dir (T3's `baseDir`): `t3-settings.json`, `projects.json`, `auth.json` live here. */
	readonly stateDir: string;
	/** The Scratch project's root, when the feature is on; `undefined` refuses `projects.ensureScratch`. */
	readonly scratchDir: string | undefined;
	readonly tokenTtlSeconds: number;
	readonly corsOrigins: readonly string[];
	/** A built T3 web app's directory, served at `/` with the SPA fallback (T3's static route). `undefined`: none, as before. */
	readonly staticDir: string | undefined;
	/** Tailscale Serve: publish this host on the tailnet HTTPS name. Absent (the default) is off: the host runs no
	 * `tailscale` command and advertises no tailnet endpoint. Optional, like `attachT3`'s option. */
	readonly tailscaleServe?: { readonly port: number };
	/** Title generation, delegated to the integrator. Absent: seeds and renames work, "Regenerate title" is refused. */
	readonly titleThread?: TitleThread;
}

/** The fully-assembled facet config: the integrator's static fields plus the two live sources of truth. */
export interface BridgeConfig extends FacetConfig {
	/** The live project registry: the shell's `projects`, and what `projects.mutate` writes. */
	readonly registry: ProjectRegistry;
	/** T3's server settings: what `server.getSettings`/`server.updateSettings` answer, and what emits `settingsUpdated`. */
	readonly settings: ServerSettingsStore;
}

/** The single server-level `cwd` T3's ServerConfig shows: the first project's path, else the state dir — a display
 * field, because this host has no working directory of its own (design.md, The model). */
export function serverCwd(config: BridgeConfig): string {
	return config.registry.list()[0]?.cwd ?? config.stateDir;
}
