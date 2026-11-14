// The picker's model list is pi's, and pi's lists are brought up to date as pi brings them: a download (pi.dev's
// catalog) checked when the bridge starts and hourly after, and forced by Settings → Providers' Refresh. A model
// released after this pi then reaches the picker without an update. A failed download keeps the lists the source had.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CatalogModel, MODEL_LIST_CHECK_MS, MODEL_LIST_FRESH_MS, ModelCatalog, type ModelListUpdate } from "../src/t3/models.ts";

const model = (modelId: string): CatalogModel => ({ provider: "anthropic", modelId, name: modelId, thinkingLevels: ["off"], contextWindow: 200_000 });
const slugs = (catalog: ModelCatalog) => catalog.providers()[0]!.models.map((entry) => entry.slug);

/** A source whose list grows by one model per download, as pi's does when pi.dev lists a new one. */
function lists(failWith?: Error) {
	const downloaded: CatalogModel[] = [];
	const calls: boolean[] = [];
	const update: ModelListUpdate = async ({ force }) => {
		calls.push(force);
		if (failWith !== undefined) return { errors: new Map([["anthropic", failWith]]) };
		downloaded.push(model(`claude-new-${calls.length}`));
		return { errors: new Map() };
	};
	const source = async () => [model("claude-fable-5-1"), ...downloaded];
	return { update, source, calls };
}

describe("model lists", () => {
	afterEach(() => vi.useRealTimers());

	it("watch() downloads at once and every MODEL_LIST_CHECK_MS, unforced; each download reaches the picker and is announced", async () => {
		vi.useFakeTimers();
		const { update, source, calls } = lists();
		const catalog = new ModelCatalog(source, update);
		await catalog.refresh();
		expect(slugs(catalog)).toEqual(["anthropic/claude-fable-5-1"]);
		let announced = 0;
		catalog.onChange(() => announced++);

		const stop = catalog.watch();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toEqual([false]);
		expect(slugs(catalog)).toEqual(["anthropic/claude-fable-5-1", "anthropic/claude-new-1"]);
		expect(announced).toBe(1);

		await vi.advanceTimersByTimeAsync(MODEL_LIST_CHECK_MS);
		expect(calls).toEqual([false, false]);
		expect(slugs(catalog)).toContain("anthropic/claude-new-2");

		stop();
		await vi.advanceTimersByTimeAsync(3 * MODEL_LIST_CHECK_MS);
		expect(calls).toHaveLength(2);
	});

	it("update(true) forces the download; updates run one at a time, in the order asked", async () => {
		const order: string[] = [];
		let release: () => void = () => {};
		const update: ModelListUpdate = async ({ force }) => {
			order.push(`start ${force}`);
			if (!force) await new Promise<void>((resolve) => (release = resolve));
			order.push(`end ${force}`);
			return { errors: new Map() };
		};
		const catalog = new ModelCatalog(async () => [], update);
		const first = catalog.update();
		const second = catalog.update(true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(order).toEqual(["start false"]);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["start false", "end false", "start true", "end true"]);
	});

	it("a failed download is logged by provider and keeps the list the source has", async () => {
		const warned: { message: string; fields?: Record<string, unknown> }[] = [];
		const log = { info: () => {}, warn: (message: string, fields?: Record<string, unknown>) => void warned.push({ message, ...(fields === undefined ? {} : { fields }) }) };
		const { update, source } = lists(new Error("Model catalog request failed for anthropic: 503"));
		const catalog = new ModelCatalog(source, update, log);
		await catalog.update(true);
		expect(slugs(catalog)).toEqual(["anthropic/claude-fable-5-1"]);
		expect(warned).toEqual([{ message: "model list update failed", fields: { provider: "anthropic", error: "Model catalog request failed for anthropic: 503" } }]);

		const throwing = new ModelCatalog(source, async () => { throw new Error("offline"); }, log);
		await throwing.update();
		expect(slugs(throwing)).toEqual(["anthropic/claude-fable-5-1"]);
		expect(warned.at(-1)).toEqual({ message: "model list update failed", fields: { error: "offline" } });
	});

	it("a picker that opens downloads the lists, unless they were downloaded in the last few minutes", async () => {
		vi.useFakeTimers();
		const { update, source, calls } = lists();
		const catalog = new ModelCatalog(source, update);
		await catalog.updateForPicker();
		expect(calls, "forced: pi alone would wait four hours").toEqual([true]);
		expect(slugs(catalog)).toContain("anthropic/claude-new-1");
		await catalog.updateForPicker();
		await vi.advanceTimersByTimeAsync(MODEL_LIST_FRESH_MS - 1);
		await catalog.updateForPicker();
		expect(calls, "the same few minutes: nothing more").toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await catalog.updateForPicker();
		expect(calls).toEqual([true, true]);
		// Settings' Refresh counts as a download too.
		await vi.advanceTimersByTimeAsync(MODEL_LIST_FRESH_MS);
		await catalog.update(true);
		await catalog.updateForPicker();
		expect(calls).toHaveLength(3);
	});

	it("without an update the catalog reads its source: update() is a refresh", async () => {
		let listed = [model("a")];
		const catalog = new ModelCatalog(async () => listed);
		await catalog.update(true);
		listed = [model("a"), model("b")];
		await catalog.update();
		expect(slugs(catalog)).toEqual(["anthropic/a", "anthropic/b"]);
	});
});
