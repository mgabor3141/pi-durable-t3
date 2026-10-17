// The id for a project registered WITHOUT a client-minted id: a function of its normalized absolute path, so nothing
// has to remember it (design.md, IDs — T3's own minted ids are honored and stored; see `registry.ts`).
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** The id a folder maps to: derived from its normalized absolute path, stable across processes. */
export const projectIdForPath = (path: string): string => `p-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;
