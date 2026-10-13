// Test-root helper: every test gets its own temp dir and never touches `~/.pi`. Cleanup is registered on the running
// test, so it runs even when an assertion fails.
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

export async function tempRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-test-"));
	// The rule is never to touch `~/.pi`; a `$TMPDIR` under home is fine, `~/.pi` is not.
	if (dir.startsWith(join(homedir(), ".pi"))) throw new Error("temp root must not be under ~/.pi");
	onTestFinished(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	return dir;
}
