// T3's Scratch project ("No project") — the folders its server makes for the user under its scratch root, replicated
// from `apps/server/src/project/ManagedProjectFolders.ts` (pinned T3): the title, the icon, the find-or-create rule
// behind `projects.ensureScratch`, and the per-thread folder a Scratch launch claims. The rules these enforce are
// T3's; the storage is our project registry (`registry.ts`) and the root is the integrator's `scratchDir` option.
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ProjectConflict, type ProjectRegistry } from "./registry.ts";

/** What T3 titles the project (`title: "No project"` in `ensureScratchProject`). */
const SCRATCH_TITLE = "No project";

/** The dashed chat bubble T3 gives the Scratch project, set once at create. */
export const SCRATCH_PROJECT_ICON = { kind: "lucide", name: "message-square-dashed", color: "gray" } as const;

/** T3's `ScratchFolderError` / `ScratchProjectError`: the message the UI shows verbatim, the cause kept for the log. */
class ScratchFolderError extends Error {
	readonly cause: unknown;
	constructor(cause: unknown) {
		super("Failed to create the folder for threads without a project.");
		this.name = "ScratchFolderError";
		this.cause = cause;
	}
}

class ScratchProjectError extends Error {
	readonly cause: unknown;
	constructor(cause: unknown) {
		super("Failed to create the project for threads without a project.");
		this.name = "ScratchProjectError";
		this.cause = cause;
	}
}

/** T3's `makeScratchFolder`: recursive, and called on EVERY ensure — a deleted Scratch folder must still run threads. */
async function makeScratchFolder(folder: string): Promise<void> {
	try {
		await mkdir(folder, { recursive: true });
	} catch (cause) {
		throw new ScratchFolderError(cause);
	}
}

/**
 * T3's `ensureScratchProject`: the folder is re-made, then the project is FOUND (one at this root) or CREATED with a
 * fresh id. A create that loses the race is the `ProjectConflictError` T3 maps to the winner's id, so the answer is
 * always the one project rooted at `root` — idempotent by state, not by a receipt store (design.md, Invariants).
 */
export async function ensureScratchProject(registry: ProjectRegistry, root: string): Promise<{ readonly projectId: string }> {
	await makeScratchFolder(root);
	const existing = registry.list().find((project) => project.cwd === root);
	if (existing !== undefined) return { projectId: existing.id };
	const minted = randomUUID();
	try {
		registry.add(SCRATCH_TITLE, root, { clientId: minted });
	} catch (cause) {
		if (cause instanceof ProjectConflict) return { projectId: cause.conflictingProjectId };
		throw new ScratchProjectError(cause);
	}
	return { projectId: minted };
}

/** T3's `folderWords`: only `[a-z0-9]` reaches a folder name, so it stays one path segment, capped so a pasted blob
 * cannot outgrow a file name. */
function folderWords(text: string): string {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.slice(0, 5)
		.join("-")
		.slice(0, 48)
		.replace(/-+$/, "");
}

/**
 * Claim `<root>/<date>-<words>-<id>` for one thread (T3's `folderForThread` + `claimFreeFolder`): the first name uses
 * the id's tail, a taken short name falls back to the full id, later attempts add a fresh random suffix. Each folder
 * is created WITHOUT `recursive`, so creating it IS the claim — of two racers for one name, one gets `EEXIST` and moves on.
 */
export async function claimScratchThreadFolder(root: string, threadId: string, text: string): Promise<string> {
	// The root first, recursively (T3's `makeScratchFolder(root)` before the claim): a deleted Scratch folder must still
	// run threads, and the claim below is non-recursive.
	await makeScratchFolder(root);
	const date = new Date().toISOString().slice(0, 10);
	const words = folderWords(text);
	const id = threadId.toLowerCase().replace(/[^a-z0-9]/g, "");
	const folderFor = (idPart: string) => join(root, [date, words, idPart].filter(Boolean).join("-"));
	const full = folderFor(id);
	for (let attempt = 1; ; attempt++) {
		const folder = attempt === 1 ? folderFor(id.slice(-8)) : attempt === 2 ? full : `${full}-${randomUUID().slice(0, 8)}`;
		try {
			await mkdir(folder);
			return folder;
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw new ScratchFolderError(cause);
		}
	}
}

/** Whether a registered path IS the Scratch root (T3 compares roots, `isScratchProject`). */
export function isScratchRoot(cwd: string, root: string): boolean {
	return cwd === root;
}
