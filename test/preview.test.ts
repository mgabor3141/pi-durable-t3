// The preview manager's state machine, without a browser: T3's `preview.open` is bookkeeping; the page starts only
// when a viewer attaches. These cover URL normalization, the list/close shape, and the event stream that the client
// folds into its preview store.
import { describe, expect, it } from "vitest";
import { PreviewSessionLookupError, PreviewInvalidUrlError } from "@t3tools/contracts";
import { nullLogger } from "../src/t3/logging.ts";
import { PreviewSessions } from "../src/t3/preview.ts";

const config = { cdpUrl: "ws://127.0.0.1:1/chromium" };

describe("preview sessions", () => {
	it("open records a loading snapshot, list returns it, close emits closed", async () => {
		const preview = new PreviewSessions(config, nullLogger);
		const events: string[] = [];
		preview.subscribe((event) => events.push(event.type));
		const snapshot = preview.open({ threadId: "thread", url: "http://workspace:3000/", runtime: "server" });
		expect(snapshot.navStatus).toEqual({ _tag: "Loading", url: "http://workspace:3000/", title: "" });
		expect(snapshot.runtime).toBe("server");
		expect(preview.list("thread").sessions).toHaveLength(1);
		expect(preview.list("other").sessions).toHaveLength(0);
		await preview.close({ threadId: "thread" });
		expect(preview.list("thread").sessions).toHaveLength(0);
		expect(events).toEqual(["opened", "closed"]);
		expect(events.length).toBe(2);
	});

	it("an inert open has no URL and no page", async () => {
		const preview = new PreviewSessions(config, nullLogger);
		const snapshot = preview.open({ threadId: "thread" });
		expect(snapshot.navStatus).toEqual({ _tag: "Idle" });
		expect(snapshot.runtime).toBe("server");
		await preview.closeAll();
	});

	it("refuses non-http URLs with the contract's typed error", () => {
		const preview = new PreviewSessions(config, nullLogger);
		expect(() => preview.open({ threadId: "thread", url: "file:///etc/passwd" })).toThrow(PreviewInvalidUrlError);
	});

	it("an unknown tab is the contract's lookup error", async () => {
		const preview = new PreviewSessions(config, nullLogger);
		await expect(preview.navigate({ threadId: "thread", tabId: "missing", url: "http://workspace:3000/" })).rejects.toBeInstanceOf(PreviewSessionLookupError);
	});
});
