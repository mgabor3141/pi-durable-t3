// The T3 facet's configuration: the integrator-owned static fields from `attachT3`, the live project registry
// (`../registry.ts`), and the live settings store over the state dir (`../settings.ts`). The facet reads them live.
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ProjectRegistry } from "../registry.ts";
import type { ServerSettingsStore } from "../settings.ts";
import type { TitleThread } from "./title-thread.ts";
import type { PreviewBrowserConfig } from "./preview-config.ts";

export type { TitleThread, TitleThreadRequest } from "./title-thread.ts";

/** The facet's integrator-owned fields, assembled once from `attachT3`'s options. */
export interface FacetConfig {
	readonly host: string;
	readonly port: number;
	readonly label: string;
	/** The bridge's dir (T3's `baseDir`): `t3-settings.json`, `projects.json`, `auth.json` live here. */
	readonly stateDir: string;
	/** The environment T3 works in: its `cwd` is the root of every absolute path in the protocol. Required by
	 * `attachT3`; optional here only so tests and older direct `Bridge` callers keep a local fallback. */
	readonly env?: ExecutionEnv;
	/** Invocation context for the environment. */
	readonly context?: Context;
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
	/** A Chromium CDP endpoint for T3's server preview panel. Absent: `preview.*` stays unsupported. */
	readonly preview?: PreviewBrowserConfig;
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
