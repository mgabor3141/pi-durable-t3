// One writer for the facet's JSON files: read tolerantly, write atomically. There is ONE host per data dir, so the
// writer is a plain in-process read-modify-write — no cross-process lock. What the atomic write guarantees, and
// why each piece is here:
//
//   - every write goes to a UNIQUE temp name (`wx`: created, never reused), because with a FIXED temp name a
//     crashed writer's leftover temp file decides the mode of the file that gets renamed into place — `open(2)`
//     applies `mode` only when it CREATES, so a secret file can land 0644.
//   - the temp file is chmod'ed 0600 before the rename (so the published mode does not depend on the umask), and
//     fsync'ed before the rename (a rename is atomic, but a crash after it can publish a zero-length file unless
//     the bytes are already on disk). Any failure removes the temp file, leaving the target as it was.
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Read a JSON file, tolerantly: missing or unparseable is the caller's fallback — a store deleted mid-run, or left
 * half-written by a crash, starts from the fallback and the next write replaces it whole. This is the rule for the
 * facet's OWN state (`auth.json`, credential data with a documented start-over); the UI's documents (`settings.json`,
 * `projects.json`) are parsed STRICTLY by their own readers — a file the host cannot read is a refusal naming it. */
export function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

let tempCounter = 0;

/**
 * Write `value` as `path`, atomically and owner-only (see the file header for each step's reason).
 */
export function writeJsonAtomic(path: string, value: unknown): void {
	const temporary = join(dirname(path), `${basename(path)}.${process.pid}.${tempCounter++}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		// `open(2)` applied the mode only because this CREATE succeeded; chmod again so the mode the rename publishes
		// does not depend on the process umask, the temp file's history, or an fs that ignores the create mode.
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* the write failed; closing the fd is best effort */
			}
		}
		try {
			unlinkSync(temporary);
		} catch {
			/* nothing to clean up */
		}
		throw error;
	}
}
