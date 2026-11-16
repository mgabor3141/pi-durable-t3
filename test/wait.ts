// Waiting, for tests.

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `test` until it holds; throws naming `what` when `ms` have passed. */
export async function until(what: string, test: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		if (await test()) return;
		if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
		await sleep(20);
	}
}
