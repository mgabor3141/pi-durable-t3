// The fallback id for a project that was registered WITHOUT a client-minted id (an integrator-written entry, a folder
// discovered from a conversation cwd): a function of its normalized absolute path, so the same folder keeps the SAME
// id across restarts and nothing has to remember it. T3's UI mints its own project id (a UUID) and navigates to it —
// that id is honored and stored (see `registry.ts`); the PATH remains the uniqueness key in both cases. A thread's
// `projectId` is a foreign key resolving through the registry; the title is a free label and carries no identity.
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** The id a folder maps to: derived from its normalized absolute path, stable across processes. */
export const projectIdForPath = (path: string): string => `p-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;
