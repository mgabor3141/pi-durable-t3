// A thread the host has never seen is a not-found, everywhere (review H2/F3). `Bridge.#state` fabricated state for any
// SESSION_ID-shaped id, so the documented 404 fired only for MALFORMED ids, and `#meta`'s cwd fallback was the literal
// "/", which minted a permanent `(other)` project at `/`, emitted `project.updated`, and injected it into every
// client's shell. Probes:
//   (a) a well-formed, never-seen id — `projection()` and `subscribeThread` answer the typed not-found, no state is
//       fabricated, and no shell item is emitted for it (the same answer the REST routes turn into 404 and the WS
//       handlers into `OrchestrationV2GetThreadProjectionError`);
//   (b) after 20 bogus probes, the shell's project list is BYTE-IDENTICAL to before (no phantom `/ (other)` project).
import { mkdtemp, rm } from "node:fs/promises";
import { ServerSettingsStore } from "../src/settings.ts";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { createServerFacet } from "../src/objects.ts";
import { Bridge, CommandError } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };

async function openBridge(): Promise<{ bridge: Bridge; close: () => Promise<void> }> {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-unknown-"));
	const host = createHost({ name: "server" });
	await host.load([createServerFacet(fixture.threads, fixture.model.models)]);
	await host.ready();
	const bridge = new Bridge(
		{ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: fixture.registry },
		log,
		host,
	);
	bridge.start();
	return {
		bridge,
		close: async () => {
			await bridge.close();
			await host.close();
			await rm(scratch, { recursive: true, force: true });
		},
	};
}

it("a well-formed thread id the host has never seen is a typed not-found on the projection and subscribe paths (H2a)", async () => {
	const { bridge, close } = await openBridge();
	try {
		const seen: string[] = [];
		const stopShell = bridge.onShell((item) => seen.push(item.kind));
		// Ids the host has never seen, in the shapes T3 mints (UUID) and the old code accepted (SESSION_ID).
		const neverSeen = [randomUUID(), "zzz-never-created"];
		for (const threadId of neverSeen) {
			// The projection path: the typed not-found the REST routes render as 404 and the WS handler maps to
			// `OrchestrationV2GetThreadProjectionError` (rpc.ts) — never a fabricated empty thread.
			const failure = await bridge.projection(threadId, 1500).then(() => undefined, (error: unknown) => error);
			expect([threadId, failure]).toEqual([threadId, expect.any(CommandError)]);
			expect((failure as Error).message).toMatch(/Unknown thread/);
			// The subscribe path: refuses synchronously (the WS stream fails with the same typed error), it does not
			// emit an empty snapshot and hang open.
			let subscribeFailure: unknown;
			let unsub: (() => void) | undefined;
			try {
				unsub = bridge.subscribeThread(threadId, () => {}, () => {});
			}
			catch (error) {
				subscribeFailure = error;
			}
			unsub?.();
			expect(subscribeFailure, `subscribeThread(${threadId}) must refuse, not fabricate`).toBeInstanceOf(CommandError);
			expect((subscribeFailure as Error).message).toMatch(/Unknown thread/);
		}
		// No state, no shell: the bogus ids appear in no shell item, and no shell item was emitted at all.
		const snapshot = bridge.shellSnapshot();
		expect(snapshot.threads.map((thread) => thread.id as string)).toEqual([]);
		expect(seen, `no shell items for bogus probes: ${JSON.stringify(seen)}`).toEqual([]);
		stopShell();
	}
	finally {
		await close();
	}
}, 30_000);

it("20 bogus probes leave the shell's project list byte-identical — no phantom `(other)` project at `/` (H2b)", async () => {
	const { bridge, close } = await openBridge();
	try {
		const projectsBefore = JSON.stringify(bridge.shellSnapshot().projects);
		const items: string[] = [];
		const stopShell = bridge.onShell((item) => items.push(`${item.kind}`));
		for (let i = 0; i < 20; i++) {
			await bridge.projection(`bogus-${i}-${randomUUID()}`, 300).catch(() => undefined);
		}
		const projectsAfter = JSON.stringify(bridge.shellSnapshot().projects);
		expect(projectsAfter).toBe(projectsBefore); // byte-identical
		expect(items, `no shell churn from bogus probes: ${JSON.stringify(items)}`).toEqual([]);
		stopShell();
	}
	finally {
		await close();
	}
}, 30_000);
