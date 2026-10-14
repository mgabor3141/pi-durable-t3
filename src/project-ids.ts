// A project's id is a function of its normalized absolute path — for a configured project and a folder discovered at
// runtime alike — so the same folder keeps the SAME id across restarts. A per-process random id would strand T3's
// selection for that folder on every restart. The id is minted nowhere: it is derived, so nothing has to remember it,
// and a thread's `projectId` is a foreign key that resolves back to the folder's path. The title is a free label and
// carries no identity.
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** The id a folder maps to: derived from its normalized absolute path, stable across processes. */
export const projectIdForPath = (path: string): string => `p-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;
