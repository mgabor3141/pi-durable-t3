// One JSON file on disk, read tolerantly and written atomically. The facet's two stores (auth.json, threads.json)
// share this: a read never throws — a missing or unparseable file yields the caller's fallback — and a write lands
// through a temp file that is 0600 before the rename, so a secret file is never readable by the group or other
// (`open(2)` applies `mode` only when it creates, so a pre-existing temp's mode is set explicitly with chmod).
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function writeJsonAtomic(path: string, value: unknown): void {
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}
