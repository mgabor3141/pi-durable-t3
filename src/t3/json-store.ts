// One writer for the facet's JSON files: read tolerantly, write atomically, and serialize read-modify-write ACROSS
// PROCESSES. Two files go through this — the facet's `auth.json` and the host's instance file (`settings.json`) — and
// both are read-modify-write: a reader takes the document, changes part of it, writes the whole document back. Two
// facts about that shape are the whole reason this file exists:
//
//   - with no serialization the LAST writer wins, and the loser's change is gone without a trace. The peers are
//     processes (two hosts on one data dir is the documented dev setup), so the lock has to be a file, not a mutex.
//   - with a FIXED temp name (`<file>.tmp`), a crashed writer's leftover temp file decides the mode of the file that
//     gets renamed into place, because `open(2)` applies `mode` only when it CREATES — a secret file can land 0644.
//
// So every write goes to a UNIQUE temp name (`wx`: created, never reused), is chmod'ed 0600 before the rename, is
// fsync'ed before the rename, and is unlinked if anything fails. `updateJsonAtomic` holds an exclusive lock across
// read → mutate → write, so the document a writer starts from already carries a peer's committed change; a writer that
// merges the parts it does not own cannot destroy them. A lock older than `STALE_LOCK_MS` is stolen, so a writer killed
// while holding it cannot wedge the file.
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** A lock that outlives this window belongs to a writer that died holding it: steal it. */
const STALE_LOCK_MS = 10_000;
/** How long a writer waits for the lock before giving up. Generous: the critical section is one small file write. */
const LOCK_TIMEOUT_MS = 15_000;

/** A file could not be written because a peer held its lock past the timeout. */
export class JsonStoreLocked extends Error {
	readonly path: string;
	constructor(path: string, timeoutMs: number) {
		super(`Another process is writing ${basename(path)}; it did not finish within ${timeoutMs}ms.`);
		this.name = "JsonStoreLocked";
		this.path = path;
	}
}

/** Read a JSON file, tolerantly: missing or unparseable is the caller's fallback — a store deleted mid-run, or left
 * half-written by a crash, starts from the fallback and the next write replaces it whole. */
export function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** A short synchronous sleep for the lock's retry backoff. The lock loop is synchronous because every writer here is
 * synchronous (the instance file must be durable the instant a mutation returns), so this sleeps the event loop for
 * two milliseconds at a time while a peer's write lands. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `run` as the only writer of `path`, across processes: an exclusive `<path>.lock` created with `wx` (two creators
 * cannot both win), retried with a backoff, stolen when stale. The lock file is removed on the way out, including when
 * `run` throws, so a refusal cannot leave a lock behind.
 */
export function withJsonLock<T>(path: string, run: () => T, options: { readonly timeoutMs?: number; readonly staleMs?: number } = {}): T {
	const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
	const staleMs = options.staleMs ?? STALE_LOCK_MS;
	const lock = `${path}.lock`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let fd: number | undefined;
		try {
			fd = openSync(lock, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
			if (age > staleMs) {
				try {
					unlinkSync(lock);
				} catch {
					/* stolen by another racer first; retry */
				}
				continue;
			}
			if (Date.now() > deadline) throw new JsonStoreLocked(path, timeoutMs);
			sleepSync(2);
			continue;
		}
		try {
			// The owner's pid, for a human inspecting a wedged data dir. Nothing parses it: staleness is mtime.
			writeSync(fd, `${process.pid}\n`);
			return run();
		} finally {
			closeSync(fd);
			try {
				unlinkSync(lock);
			} catch {
				/* already gone (stolen as stale); the write is done */
			}
		}
	}
}

let tempCounter = 0;

/**
 * Write `value` as `path`, atomically and owner-only: a UNIQUE temp file (created `wx`, so a temp file left by a crash
 * can never be the one this write uses), chmod 0600 before the rename, fsync before the rename (a rename is atomic,
 * but a crash after it can publish a zero-length file unless the bytes are already on disk), then the rename. Any
 * failure removes the temp file, leaving the target and the directory as they were.
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

/**
 * Read-modify-write `path` as ONE operation, serialized against every other `updateJsonAtomic` on the same file.
 * `mutate` receives the document exactly as it is on disk RIGHT NOW (so a peer's committed change is in it) and returns
 * what to write; nothing is written when the document is unchanged, so a mutation that decides to refuse leaves the
 * file alone. `validate` runs on the result BEFORE it reaches the disk: a document the host would refuse at boot is
 * never written over a good one. Returns the document that is on disk afterwards.
 *
 * `read` overrides how the base document is read, inside the lock. The default is `readJson` (tolerant: a missing or
 * unparseable file is the fallback) — right for `auth.json`, where starting a credential store over is documented.
 * The instance file passes a STRICT reader: a write must never be based on a document the host could not read, so an
 * unparseable `settings.json` REFUSES the mutation (naming the file) and leaves it untouched, rather than writing
 * "empty + this delta" over the entries the file held (review store M1).
 */
export function updateJsonAtomic<T>(
	path: string,
	fallback: T,
	mutate: (current: T) => T,
	options: { readonly validate?: (value: T) => void; readonly timeoutMs?: number; readonly read?: (path: string, fallback: T) => T } = {},
): T {
	return withJsonLock(
		path,
		() => {
			const current = options.read ? options.read(path, fallback) : readJson<T>(path, fallback);
			const next = mutate(current);
			if (JSON.stringify(next) === JSON.stringify(current)) return next;
			options.validate?.(next);
			writeJsonAtomic(path, next);
			return next;
		},
		{ timeoutMs: options.timeoutMs },
	);
}
