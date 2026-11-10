// The T3 facet's configuration: the integrator-owned static fields from `attachT3`, the live project registry
// (`../registry.ts`), and the live settings store over the state dir (`../settings.ts`). The facet reads them live.
import type { Context } from "@earendil-works/chord/context";
import type { RemoteAccess } from "./remote-access.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ProjectRegistry } from "../registry.ts";
import type { ServerSettingsStore } from "../settings.ts";
import type { TitleThread } from "./title-thread.ts";
import type { MessageContext } from "./message-context.ts";
import type { PreviewBrowserConfig } from "./preview-config.ts";
import type { RpcLog } from "./logging.ts";
import type { HostRoute } from "./host-route.ts";

export type { TitleThread, TitleThreadRequest } from "./title-thread.ts";

/** The facet's integrator-owned fields, assembled once from `attachT3`'s options. */
export interface FacetConfig {
	readonly host: string;
	readonly port: number;
	readonly label: string;
	/** The bridge's dir (T3's `baseDir`): `t3-settings.json`, `auth.json` and `uploads/` (attachments not yet sent). */
	readonly stateDir: string;
	/** The environment T3 works in: its `cwd` is the root of every absolute path in the protocol. Required by
	 * `attachT3`; optional here only so tests and older direct `Bridge` callers keep a local fallback. */
	readonly env?: ExecutionEnv;
	/** Invocation context for the environment. */
	readonly context?: Context;
	/** Where sent attachments live in `env`, each named to the model by path; `undefined` takes no attachments. */
	readonly attachmentsDir?: string;
	/** The Scratch project's root, when the feature is on; `undefined` refuses `projects.ensureScratch`. */
	readonly scratchDir: string | undefined;
	readonly tokenTtlSeconds: number;
	readonly corsOrigins: readonly string[];
	/** A built T3 web app's directory, served at `/` with the SPA fallback (T3's static route). `undefined`: none, as before. */
	readonly staticDir: string | undefined;
	/** A route the integrator runs (its own tailnet node, an SSH relay), advertised to T3. Absent: none. */
	readonly remoteAccess?: RemoteAccess;
	/** Title generation, delegated to the integrator. Absent: seeds and renames work, "Regenerate title" is refused. */
	readonly titleThread?: TitleThread;
	/** Context for the model about each message that starts or steers a turn (memories). Absent: none. */
	readonly messageContext?: MessageContext;
	/** A Chromium CDP endpoint for T3's server preview panel. Absent: `preview.*` stays unsupported. */
	readonly preview?: PreviewBrowserConfig;
	readonly routes?: readonly HostRoute[];
	/** Optional per-call RPC observation for debugging the wire. Absent: nothing is called. */
	readonly rpcLog?: RpcLog;
}

/** The fully-assembled facet config: the integrator's static fields plus the two live sources of truth. */
export interface BridgeConfig extends FacetConfig {
	/** The live project registry: the shell's `projects`, and what `projects.mutate` writes. */
	readonly registry: ProjectRegistry;
	/** T3's server settings: what `server.getConfig`/`server.updateSettings` answer, and what emits `settingsUpdated`. */
	readonly settings: ServerSettingsStore;
}

/** The single server-level `cwd` T3's ServerConfig shows: the first project's path, else the state dir — a display
 * field, because this host has no working directory of its own (design.md, The model). */
export function serverCwd(config: BridgeConfig): string {
	return config.registry.list()[0]?.cwd ?? config.stateDir;
}

