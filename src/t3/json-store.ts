// One writer for the facet's JSON files: read tolerantly, write atomically and owner-only, one host per state dir.
// The unique temp name, the `wx` create and the 0600 chmod are design.md's invariant (the files the host writes
// always parse); a rename is atomic, but a crash after it publishes a zero-length file unless the bytes are fsynced first.
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Read a JSON file, tolerantly: missing or unparseable is the caller's fallback — the rule for the facet's OWN
 * credential state. The UI's documents are parsed STRICTLY by their readers (design.md, state.md). */
export function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

let tempCounter = 0;

/** Write `value` as `path`, atomically and owner-only: unique temp file, `wx`, chmod 0600, fsync, rename (design.md). */
export function writeJsonAtomic(path: string, value: unknown): void {
	const temporary = join(dirname(path), `${basename(path)}.${process.pid}.${tempCounter++}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		// chmod so the mode the rename publishes does not depend on the umask (`open(2)` applies `mode` only on create).
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
